/**
 * @file Settings.mjs — Settings — abstract base class and RemoteSettingsManager for per-server configuration backed by SQLite
 * @module src.Settings
 */

import fs from "node:fs";
import { logger } from "./constants/Logger.mjs";
import mysql from "mysql2";
import { EventEmitter } from "node:events";

/**
 * Abstract base class for settings managers.
 * Provides the interface that all concrete settings managers must implement.
 */
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

/**
 * ServerSettings class.
 */
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

  checkDefaults(d) { for (let key in d) { if (this.data[key] === undefined) this.data[key] = d[key]; } }

  deserialize(json) { for (let k in json) { if (k === "id") continue; this.data[k] = json[k]; } }

  get serializationData() { return { ...this.data, id: this.id }; }
  serialize() { return this.serializationData; }
  serializeObject() { return this.serializationData; }
}

/**
 * RemoteSettingsManager class.
 */
export class RemoteSettingsManager extends SettingsManager {
  guilds = new Map();
  descriptions = {};
  defaults = {};
  db = null;
  /** @type {string|null} Bot user ID — used to isolate rows per-bot in shared databases */
  botId = null;
  /** @type {boolean} Whether the bot_id column exists in the settings table */
  _hasBotIdColumn = false;

  _loadAttempts = 0;
  /** @type {Promise|null} Tracks the in-flight load() so setBotId() can wait for it */
  _loadPromise = null;
  _debounceTimers = new Map();

  constructor(config, defaultsPath, botId = null) {
    super();
    this.botId = botId;
    this.db = mysql.createPool({ connectionLimit: 15, ...config });
    this.db.on("error", (err) => {
      logger.error("[DB] MySQL pool error:", err.code ?? err.message);
    });
    if (defaultsPath) this.loadDefaultsSync(defaultsPath);
    this._loadPromise = this.load().catch(err => logger.error("[Settings] Initial load failed:", err?.message ?? err));
  }

  /**
   * Check whether the `bot_id` column exists in the settings table AND is
   * part of the primary key.  If the column is missing, auto-migrate by
   * adding it (NOT NULL DEFAULT '') and updating the primary key to (id, bot_id).
   * If the column exists but isn't in the PK (previous failed migration),
   * fix the NULL values and retry the PK update.
   */
  async _ensureBotIdColumn() {
    if (this._hasBotIdColumn) return;

    const res = await this.query(
      `SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_KEY FROM information_schema.COLUMNS `
      + `WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'settings' AND COLUMN_NAME = 'bot_id'`
    );

    if (res.error) {
      logger.error("[Settings] Failed to check bot_id column:", res.error);
      return;
    }

    if (res.results.length === 0) {
      logger.settings("[Settings] Auto-migrating: adding bot_id column to settings table...");

      const alterRes = await this.query(
        `ALTER TABLE settings ADD COLUMN bot_id VARCHAR(32) NOT NULL DEFAULT ''`
      );
      if (alterRes.error) {
        logger.error("[Settings] Failed to add bot_id column:", alterRes.error);
        return;
      }

      if (this.botId) {
        await this.query(
          `UPDATE settings SET bot_id = ${mysql.escape(String(this.botId))} WHERE bot_id = ''`
        );
      }

      const pkRes = await this.query(
        `ALTER TABLE settings DROP PRIMARY KEY, ADD PRIMARY KEY (id, bot_id)`
      );
      if (pkRes.error) {
        logger.error("[Settings] Failed to update primary key:", pkRes.error);
        return;
      }

      this._hasBotIdColumn = true;
      logger.settings("[Settings] Auto-migration complete: bot_id column added.");
      return;
    }

    const colInfo = res.results[0];
    const isNullable = colInfo.IS_NULLABLE === 'YES';
    const isPrimaryKey = colInfo.COLUMN_KEY === 'PRI';

    if (isPrimaryKey) {
      this._hasBotIdColumn = true;
      return;
    }

    logger.settings("[Settings] Fixing bot_id column: adding to primary key...");

    if (isNullable) {
      await this.query(`UPDATE settings SET bot_id = '' WHERE bot_id IS NULL`);
      await this.query(`ALTER TABLE settings MODIFY COLUMN bot_id VARCHAR(32) NOT NULL DEFAULT ''`);
    }

    if (this.botId) {
      await this.query(
        `UPDATE settings SET bot_id = ${mysql.escape(String(this.botId))} WHERE bot_id = ''`
      );
    }

    const pkRes = await this.query(
      `ALTER TABLE settings DROP PRIMARY KEY, ADD PRIMARY KEY (id, bot_id)`
    );
    if (pkRes.error) {
      logger.error("[Settings] Failed to update primary key:", pkRes.error);
      return;
    }

    this._hasBotIdColumn = true;
    logger.settings("[Settings] Fix complete: bot_id column added to primary key.");
  }

  /**
   * Set or update the bot ID used for database row isolation.
   * Called after login when the bot user ID becomes available.
   * @param {string} id
   */
  async setBotId(id) {
    const changed = this.botId !== id;
    this.botId = id;
    if (changed) {
      if (this._loadPromise) await this._loadPromise;
      await this._ensureBotIdColumn();

      if (this._hasBotIdColumn && this.botId) {
        const claimRes = await this.query(
          `UPDATE settings SET bot_id = ${mysql.escape(String(this.botId))} WHERE bot_id = ''`
        );
        if (claimRes.results?.affectedRows > 0) {
          logger.settings(`[Settings] Claimed ${claimRes.results.affectedRows} legacy row(s) for bot ${this.botId}`);
        }
      }

      this.guilds.clear();
      this._loadPromise = this.load();
      await this._loadPromise;
    }
  }

  _botIdWhere() {
    if (!this.botId || !this._hasBotIdColumn) return "";
    return ` AND bot_id = ${mysql.escape(String(this.botId))}`;
  }

  _botIdInsert() {
    if (!this.botId || !this._hasBotIdColumn) return { col: "", val: "" };
    return { col: ", bot_id", val: `, ${mysql.escape(String(this.botId))}` };
  }

  selectGuild(guildId) {
    const escapedId = mysql.escape(String(guildId));
    return this.query(`SELECT * FROM settings WHERE id=${escapedId}${this._botIdWhere()}`);
  }

  query(q) {
    return new Promise(res => {
      this.db.query(q, (error, results, fields) => { res({ error, results, fields }); });
    });
  }

  async load() {
    const res = await this.query(`SELECT * FROM settings WHERE 1=1${this._botIdWhere()}`);
    if (res.error) {
      this._loadAttempts++;
      const delay = Math.min(1000 * Math.pow(2, this._loadAttempts - 1), 30_000);
      logger.error("[Settings] Init error (attempt", this._loadAttempts, "retrying in", delay + "ms):", res.error);
      return new Promise((resolve) => { setTimeout(() => { this.load().then(resolve).catch(resolve); }, delay); });
    }
    this._loadAttempts = 0;
    res.results.forEach((r) => {
      try {
        const server = new ServerSettings(r.id, this);
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
    if (Array.isArray(val) || (typeof val === "object" && val !== null)) {
      return this.remoteSave(server);
    }
    const escapedPath = mysql.escape(`$.${key}`);
    const escapedVal  = (typeof val === "boolean" || typeof val === "number")
        ? mysql.escape(val)
        : mysql.escape(String(val));
    const escapedId   = mysql.escape(server.id);
    const r = await this.query(`UPDATE settings SET data = JSON_SET(data, ${escapedPath}, ${escapedVal}) WHERE id=${escapedId}${this._botIdWhere()}`);
    if (r.error) logger.error("[Settings] remoteUpdate error:", r.error);
  }

  async remoteSave(server) {
    const escapedData = mysql.escape(JSON.stringify(server.data));
    const escapedId   = mysql.escape(server.id);
    const r = await this.query(`UPDATE settings SET data = ${escapedData} WHERE id=${escapedId}${this._botIdWhere()}`);
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
    const bi = this._botIdInsert();
    const r = await this.query(
      `INSERT IGNORE INTO settings (id, data${bi.col}) VALUES (${escapedId}, ${escapedData}${bi.val})`
    );
    if (r.error) logger.error("[Settings] create error:", r.error);
  }

  update(server, key) {
    if (!this.guilds.has(server.id)) { this.guilds.set(server.id, server); this.create(server.id, server).catch(e => logger.error("[Settings] create error in update:", e.message)); }
    const s = this.guilds.get(server.id);
    s.data[key] = server.data[key];
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
      return new ServerSettings(id, this);
    }
    return this.guilds.get(id);
  }

  removeServer(id) {
    const timer = this._debounceTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this._debounceTimers.delete(id);
    }
    this.guilds.delete(id);
  }
}
