import fs from "node:fs";
import { logger } from "./constants/Logger.mjs";
import mysql from "mysql";
import { EventEmitter } from "node:events";

export class ServerSettings {
  id;
  manager;
  data = {};

  constructor(id, mgr) {
    this.id = id;
    this.manager = mgr;
    this.loadDefaults();
  }
  set(key, value) { this.data[key] = value; this.manager.update(this, key); }
  get(key) { return this.data[key]; }
  reset(key) { return this.set(key, this.manager.defaults[key]); }
  getAll() { return this.data; }
  loadDefaults() { for (let key in this.manager.defaults) { this.data[key] = this.manager.defaults[key]; } }
  deserialize(json) { for (let k in json) { if (k === "id") continue; this.data[k] = json[k]; } }

  // was `if (!this.data[key])` which clobbered valid falsy values like 0, false, ""
  checkDefaults(d) { for (let key in d) { if (this.data[key] === undefined) this.data[key] = d[key]; } }

  get serializationData() { return { ...this.data, id: this.id }; }
  serialize() { return this.serializationData; }
  serializeObject() { return this.serializationData; }
}

/** @deprecated Use RemoteSettingsManager instead */
export class SettingsManager {
  guilds = new Map();
  storagePath = "./storage/settings.json";
  defaults = {};
  descriptions = {};

  constructor(storagePath = null) {
    if (storagePath) this.storagePath = storagePath;
    this.load();
  }
  loadDefaultsSync(filePath) {
    const d = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(d);
    this.descriptions = parsed.descriptions;
    this.defaults = parsed.values;
  }
  load() {
    if (!fs.existsSync(this.storagePath)) {
      fs.writeFileSync(this.storagePath, JSON.stringify({ guilds: [] }));
    }
    const json = JSON.parse(fs.readFileSync(this.storagePath, "utf8"));
    const entries = json.guilds || json.servers || [];
    entries.forEach((s) => {
      const server = new ServerSettings(s.id, this);
      server.deserialize(s);
      server.checkDefaults(this.defaults);
      this.guilds.set(s.id, server);
    });
  }
  save() {
    const s = [];
    this.guilds.forEach((val) => { s.push(val.serialize()); });
    fs.writeFileSync(this.storagePath, JSON.stringify({ guilds: s }));
  }
  saveAsync() {
    return new Promise((res) => {
      const s = [];
      this.guilds.forEach((val) => { s.push(val.serializeObject()); });
      fs.writeFile(this.storagePath, JSON.stringify({ guilds: s }), () => { res(); });
    });
  }
  update(server, key) {
    if (!this.guilds.has(server.id)) this.guilds.set(server.id, server);
    const s = this.guilds.get(server.id);
    s.data[key] = server.data[key];
  }
  isOption(key) { return key in this.defaults; }
  hasServer(id) { return this.guilds.has(id); }
  getServer(id) {
    if (this.guilds.has(id)) return this.guilds.get(id);
    // Create AND store so any .set() calls on the returned object are persisted.
    // Previously this returned a detached instance, causing settings writes to silently disappear.
    const server = new ServerSettings(id, this);
    server.checkDefaults(this.defaults);
    this.guilds.set(id, server);
    return server;
  }
}

export class RemoteSettingsManager extends EventEmitter {
  guilds = new Map();
  descriptions = {};
  defaults = {};
  db = null;

  // track retry count and apply exponential backoff on load failures
  _loadAttempts = 0;
  // Per-server debounce timers: serverId → NodeJS.Timeout
  // Batches rapid set() calls (e.g. 24/7 mode changes that write stay_247 + stay_247_mode)
  // into a single remoteSave() 80ms after the last write, rather than firing one UPDATE
  // per key.
  _debounceTimers = new Map();

  constructor(config, defaultsPath) {
    super();
    this.db = mysql.createPool({ connectionLimit: 15, ...config });
    if (defaultsPath) this.loadDefaultsSync(defaultsPath);
    this.load();
  }

  query(q) {
    return new Promise(res => {
      this.db.query(q, (error, results, fields) => { res({ error, results, fields }); });
    });
  }

  async load() {
    const res = await this.query("SELECT * FROM settings");
    if (res.error) {
      this._loadAttempts++;
      // exponential backoff with a cap of 30s instead of forever-at-2s
      const delay = Math.min(1000 * Math.pow(2, this._loadAttempts - 1), 30_000);
      logger.error("[Settings] Init error (attempt", this._loadAttempts, "retrying in", delay + "ms):", res.error);
      return setTimeout(() => { this.load(); }, delay);
    }
    this._loadAttempts = 0;
    res.results.forEach((r) => {
      const server = new ServerSettings(r.id, this);
      server.deserialize(JSON.parse(r.data));
      server.checkDefaults(this.defaults);
      this.guilds.set(server.id, server);
    });
    this.emit("ready");
  }

  async remoteUpdate(server, key) {
    const val = server.data[key];
    // Arrays/objects must go through remoteSave — JSON_SET with scalar
    // interpolation corrupts arrays by merging IDs into one number on read-back.
    if (Array.isArray(val) || (typeof val === "object" && val !== null)) {
      return this.remoteSave(server);
    }
    // Use mysql.escape() for every user-supplied value to prevent SQL injection.
    // Preserve native boolean/number types — mysql.escape(String(false)) stores "false"
    // (a truthy string) which breaks strict equality checks like songAnnouncements === false.
    const escapedPath = mysql.escape(`$.${key}`);
    const escapedVal  = (typeof val === "boolean" || typeof val === "number")
        ? mysql.escape(val)
        : mysql.escape(String(val));
    const escapedId   = mysql.escape(server.id);
    const r = await this.query(`UPDATE settings SET data = JSON_SET(data, ${escapedPath}, ${escapedVal}) WHERE id=${escapedId}`);
    if (r.error) logger.error("[Settings] remoteUpdate error:", r.error);
  }

  async remoteSave(server) {
    const escapedData = mysql.escape(JSON.stringify(server.data));
    const escapedId   = mysql.escape(server.id);
    const r = await this.query(`UPDATE settings SET data = ${escapedData} WHERE id=${escapedId}`);
    if (r.error) logger.error("[Settings] remoteSave error:", r.error);
  }

  loadDefaultsSync(filePath) {
    const d = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(d);
    this.descriptions = parsed.descriptions;
    this.defaults = parsed.values;
  }

  async saveAsync() {
    await Promise.allSettled([...this.guilds.values()].map(v => this.remoteSave(v)));
  }

  async create(id, server) {
    const escapedId   = mysql.escape(id);
    const escapedData = mysql.escape(JSON.stringify(server.data));
    const r = await this.query(`INSERT INTO settings (id, data) VALUES (${escapedId}, ${escapedData})`);
    if (r.error) logger.error("[Settings] create error:", r.error);
  }

  update(server, key) {
    if (!this.guilds.has(server.id)) { this.guilds.set(server.id, server); this.create(server.id, server); }
    const s = this.guilds.get(server.id);
    s.data[key] = server.data[key];
    // Debounce: collapse rapid successive set() calls (e.g. stay_247 + stay_247_mode written
    // together) into a single remoteSave() 80ms after the last write for this server.
    // This prevents N parallel UPDATE queries when multiple keys change in one command handler.
    const existing = this._debounceTimers.get(server.id);
    if (existing) clearTimeout(existing);
    this._debounceTimers.set(server.id, setTimeout(() => {
      this._debounceTimers.delete(server.id);
      this.remoteSave(s);
    }, 80));
  }

  isOption(key) { return key in this.defaults; }
  hasServer(id) { return this.guilds.has(id); }

  getServer(id) {
    if (!this.guilds.has(id)) {
      // Return a fresh object but don't register it yet;
      // update() will call create() on the first real write.
      return new ServerSettings(id, this);
    }
    return this.guilds.get(id);
  }

  /**
   * Drop a server from the in-memory cache without touching the DB row.
   * This lets settings be restored automatically if the bot is re-invited.
   * @param {string} id - Guild / server ID
   */
  removeServer(id) {
    this.guilds.delete(id);
  }
}