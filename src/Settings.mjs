import fs from "node:fs";
import { logger } from "./constants/Logger.mjs";
import mysql from "mysql2";
import { EventEmitter } from "node:events";

// Re-export the abstract SettingsManager base class so JSDoc type hints and
// the migrate script can import it from a single canonical path.
export { SettingsManager } from "../settings/Settings.mjs";

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
    // Without this listener, any pool-level error (connection drop, timeout, protocol error)
    // fires an unhandled 'error' event which crashes the entire process with no log output.
    this.db.on("error", (err) => {
      logger.error("[DB] MySQL pool error:", err.code ?? err.message);
    });
    if (defaultsPath) this.loadDefaultsSync(defaultsPath);
    this.load().catch(err => logger.error("[Settings] Initial load failed:", err?.message ?? err));
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
      return setTimeout(() => { this.load().catch(err => logger.error("[Settings] Retry load error:", err?.message ?? err)); }, delay);
    }
    this._loadAttempts = 0;
    res.results.forEach((r) => {
      try {
        const server = new ServerSettings(r.id, this);
        // mysql2 may return JSON columns as already-parsed objects;
        // only JSON.parse when the value is still a string.
        const parsed = (typeof r.data === "string") ? JSON.parse(r.data) : r.data;
        server.deserialize(parsed);
        server.checkDefaults(this.defaults);
        this.guilds.set(server.id, server);
      } catch (e) {
        logger.error("[Settings] Failed to parse settings for server", r.id, ":", e.message);
      }
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
    try {
      const d = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(d);
      this.descriptions = parsed.descriptions;
      this.defaults = parsed.values;
    } catch (e) {
      logger.error("[Settings] Failed to load defaults from", filePath, ":", e.message);
      this.descriptions = {};
      this.defaults = {};
    }
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
    // Clear any pending debounce timer so it doesn't fire after the guild is gone
    // and attempt a DB write for a server that no longer belongs to us.
    const timer = this._debounceTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this._debounceTimers.delete(id);
    }
    this.guilds.delete(id);
  }
}
