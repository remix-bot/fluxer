import { EventEmitter } from "node:events";
import { logger } from "../src/constants/Logger.mjs";
import * as fs from "node:fs";
import * as mysql from "mysql";

export class ServerSettings {
  /** @type {string} */
  id;
  /** @type {SettingsManager} */
  manager;
  data = {};

  constructor(id, mgr) {
    this.id = id; this.manager = mgr;
    this.loadDefaults();
  }
  set(key, value) { this.data[key] = value; this.manager.update(this, key); }
  get(key) { return this.data[key]; }
  reset(key) { return this.set(key, this.manager.defaults[key]); }
  getAll() { return this.data; }
  loadDefaults() { for (let key in this.manager.defaults) { this.data[key] = this.manager.defaults[key]; } }
  checkDefaults(d) { for (let key in d) { if (this.data[key] === undefined) this.data[key] = d[key]; } }
  deserialize(json) { for (let k in json) { if (k === "id") continue; this.data[k] = json[k]; } }
  get serializationData() { return { ...this.data, id: this.id }; }
  serialize() { return this.serializationData; }
  serializeObject() { return this.serializationData; }
}

export class SettingsManager extends EventEmitter {
  /** @abstract @type {Object} */
  defaults;
  /** @abstract */
  update(server, key) { }
  /** @abstract @returns {ServerSettings} */
  getServer(id) { }
  /** @abstract @returns {boolean} */
  hasServer(id) { }
  /** @abstract @returns {boolean} */
  isOption(key) { }
}

export class MySqlSettingsManager extends SettingsManager {
  guilds = new Map();
  descriptions = {};
  defaults = {};
  db = null;

  constructor(config, defaultsPath) {
    super();
    this.db = mysql.createPool({ connectionLimit: 15, ...config });
    if (defaultsPath) this.loadDefaultsSync(defaultsPath);
    this.load();
  }
  query(query) {
    return new Promise(res => {
      this.db.query(query, (error, results, fields) => { res({ error, results, fields }); });
    });
  }
  async load() {
    const res = await this.query("SELECT * FROM settings");
    if (res.error) {
      this._loadAttempts = (this._loadAttempts || 0) + 1;
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
    const escapedKey  = mysql.escape(`$.${key}`);
    // Preserve native boolean/number types so MySQL stores them as JSON
    // booleans/numbers, not as strings. String(true) would store "true"
    // which then reads back as a string — breaking strict equality checks.
    const escapedVal  = (typeof val === "boolean" || typeof val === "number")
        ? mysql.escape(val)
        : mysql.escape(String(val));
    const escapedId   = mysql.escape(server.id);
    const r = await this.query(
        `UPDATE settings SET data = JSON_SET(data, ${escapedKey}, ${escapedVal}) WHERE id=${escapedId}`
    );
    if (r.error) logger.error("[Settings] remoteUpdate error:", r.error);
  }
  async remoteSave(server) {
    const escapedData = mysql.escape(JSON.stringify(server.data));
    const escapedId   = mysql.escape(server.id);
    const r = await this.query(
        `UPDATE settings SET data = ${escapedData} WHERE id=${escapedId}`
    );
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
    const r = await this.query(
        `INSERT INTO settings (id, data) VALUES (${escapedId}, ${escapedData})`
    );
    if (r.error) logger.error("[Settings] create error:", r.error);
  }
  update(server, key) {
    if (!this.guilds.has(server.id)) { this.guilds.set(server.id, server); this.create(server.id, server); }
    const s = this.guilds.get(server.id);
    s.data[key] = server.data[key];
    this.remoteUpdate(server, key);
  }
  isOption(key) { return key in this.defaults; }
  hasServer(id) { return this.guilds.has(id); }
  getServer(id) { return (!this.guilds.has(id)) ? new ServerSettings(id, this) : this.guilds.get(id); }
}