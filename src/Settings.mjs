/**
 * @module src/Settings
 * @description MySQL-backed settings system for per-guild bot configuration.
 * Supports debounced writes (80ms), multi-bot via bot_id column, and
 * automatic schema migration for legacy tables.
 */

import fs from "node:fs";
import mysql from "mysql2";
import { EventEmitter } from "node:events";
import { logger } from "./constants/Logger.mjs";

/**
 * Base settings manager providing defaults, descriptions, and key utilities.
 * Subclassed by RemoteSettingsManager for MySQL-backed persistence.
 * @extends {EventEmitter}
 */
export class SettingsManager extends EventEmitter {
  /** @type {object} Default setting values keyed by setting name. */
  defaults;

  /** @type {object} Setting descriptions keyed by setting name. */
  descriptions;

  /** @type {Set<string>} Internal keys hidden from getPublicKeys(). */
  internalKeys;

  /**
   * Mark setting keys as internal (hidden from getPublicKeys).
   * @param {...string} keys - Setting key names to mark internal.
   */
  markInternal(...keys) {
    if (!this.internalKeys) this.internalKeys = new Set();
    for (const k of keys) this.internalKeys.add(k);
  }

  /**
   * Check whether a setting key is internal.
   * @param {string} key - The setting key to check.
   * @returns {boolean} True if the key is marked internal.
   */
  isInternal(key) {
    return this.internalKeys?.has(key) ?? false;
  }

  /**
   * Check whether a setting key exists in defaults.
   * @param {string} key - The setting key.
   * @returns {boolean} True if the key is a known setting.
   */
  isOption(key) { return key in this.defaults; }

  /**
   * Get all non-internal setting keys.
   * @returns {string[]} Array of public-facing setting key names.
   */
  getPublicKeys() {
    return Object.keys(this.defaults).filter(k => !this.isInternal(k));
  }
}

/**
 * Per-guild settings container. Delegates persistence to a RemoteSettingsManager.
 * All mutations call manager.update() which triggers a debounced DB write.
 */
export class ServerSettings {
  /** @type {string} The guild ID. */
  id;

  /** @type {RemoteSettingsManager} The parent settings manager. */
  manager;

  /** @type {object} Key-value store of current setting values. */
  data = {};

  /**
   * Create a new ServerSettings instance for a guild.
   * @param {string} id - The guild ID.
   * @param {RemoteSettingsManager} mgr - The parent settings manager.
   */
  constructor(id, mgr) {
    this.id = id;
    this.manager = mgr;
    this.loadDefaults();
  }

  /**
   * Set a setting value and trigger a debounced database write.
   * @param {string} key - The setting key.
   * @param {*} value - The new value.
   */
  set(key, value) { this.data[key] = value; this.manager.update(this, key); }

  /**
   * Get a setting value.
   * @param {string} key - The setting key.
   * @returns {*} The current value, or undefined if not set.
   */
  get(key) { return this.data[key]; }

  /**
   * Reset a setting to its default value and persist the change.
   * @param {string} key - The setting key to reset.
   * @returns {*} The default value.
   */
  reset(key) { return this.set(key, this.manager.defaults[key]); }

  /**
   * Get a shallow copy of all current setting values.
   * @returns {object} Plain object with all key-value pairs.
   */
  getAll() { return { ...this.data }; }

  /**
   * Load all default values from the manager into this.data.
   */
  loadDefaults() { for (const key in this.manager.defaults) this.data[key] = this.manager.defaults[key]; }

  /**
   * Fill in any missing keys from a defaults object without overwriting existing values.
   * @param {object} d - Defaults object to check against.
   */
  checkDefaults(d) { for (const key in d) { if (this.data[key] === undefined) this.data[key] = d[key]; } }

  /**
   * Restore settings from a parsed JSON object (skips the 'id' field).
   * @param {object} json - Key-value pairs to restore.
   */
  deserialize(json) { for (const k in json) { if (k === 'id') continue; this.data[k] = json[k]; } }

  /**
   * Get a serializable copy of settings data including the guild ID.
   * @returns {object} Plain object suitable for JSON.stringify.
   */
  get serializationData() { return { ...this.data, id: this.id }; }

  /** @returns {object} Alias for serializationData. */
  serialize() { return this.serializationData; }

  /** @returns {object} Alias for serializationData. */
  serializeObject() { return this.serializationData; }
}

/**
 * MySQL-backed settings manager. Loads all guild settings at startup,
 * persists changes with an 80ms debounce per guild, and supports multi-bot
 * operation via a `bot_id` column.
 *
 * @extends {SettingsManager}
 * @fires SettingsManager#ready - Emitted after the initial DB load completes.
 */
export class RemoteSettingsManager extends SettingsManager {
  /** @type {Map<string, ServerSettings>} Cached guild settings keyed by guild ID. */
  guilds = new Map();

  /** @type {import('mysql2').Pool} MySQL connection pool. */
  db = null;

  /** @type {string|null} Current bot user ID for multi-bot support. */
  botId = null;

  /** @private @type {boolean} Whether the bot_id column has been verified. */
  _hasBotIdColumn = false;

  /** @private */
  _loadAttempts = 0;

  /** @private @type {Promise|null} Pending initial load promise. */
  _loadPromise = null;

  /** @private @type {Map<string, setTimeout>} Debounce timers keyed by guild ID. */
  _debounceTimers = new Map();

  /** @private @type {boolean} True after shutdown() is called. */
  _shuttingDown = false;

  /**
   * Create a new RemoteSettingsManager backed by a MySQL pool.
   * @param {object} config - mysql2 pool configuration (host, user, password, database).
   * @param {string} defaultsPath - Path to a JSON file with default values and descriptions.
   * @param {string|null} [botId=null] - The bot user ID for multi-bot support.
   */
  constructor(config, defaultsPath, botId = null) {
    super();
    this.botId = botId;
    this.db = mysql.createPool({ connectionLimit: 15, ...config });
    this.db.on('error', (err) => {
      logger.error('[DB] MySQL pool error:', err.code ?? err.message);
    });
    if (defaultsPath) this.loadDefaultsSync(defaultsPath);
    this._loadPromise = this.load().catch(err =>
      logger.error('[Settings] Initial load failed:', err?.message ?? err)
    );
  }

  /**
   * Stop all pending debounced writes. Call before process exit.
   * @returns {Promise<void>}
   */
  async shutdown() {
    this._shuttingDown = true;
    for (const [, timer] of this._debounceTimers) clearTimeout(timer);
    this._debounceTimers.clear();
  }

  /**
   * Execute a raw MySQL query and wrap the callback in a promise.
   * @param {string} q - SQL query string.
   * @returns {Promise<{error: Error|null, results: any[], fields: any}>}
   */
  query(q) {
    return new Promise(res => {
      this.db.query(q, (error, results, fields) => { res({ error, results, fields }); });
    });
  }

  /**
   * Ensure the `bot_id` column exists in the settings table and is part of the primary key.
   * Auto-migrates legacy tables that lack the column.
   * @returns {Promise<void>}
   * @private
   */
  async _ensureBotIdColumn() {
    if (this._hasBotIdColumn) return;
    const res = await this.query(
      `SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_KEY FROM information_schema.COLUMNS `
      + `WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'settings' AND COLUMN_NAME = 'bot_id'`
    );
    if (res.error) {
      logger.error('[Settings] Failed to check bot_id column:', res.error);
      return;
    }
    if (res.results.length === 0) {
      logger.settings('[Settings] Auto-migrating: adding bot_id column to settings table...');
      const alterRes = await this.query(`ALTER TABLE settings ADD COLUMN bot_id VARCHAR(32) NOT NULL DEFAULT ''`);
      if (alterRes.error) {
        logger.error('[Settings] Failed to add bot_id column:', alterRes.error);
        return;
      }
      if (this.botId) {
        await this.query(`UPDATE settings SET bot_id = ${mysql.escape(String(this.botId))} WHERE bot_id = ''`);
      }
      const pkRes = await this.query(`ALTER TABLE settings DROP PRIMARY KEY, ADD PRIMARY KEY (id, bot_id)`);
      if (pkRes.error) {
        logger.error('[Settings] Failed to update primary key:', pkRes.error);
        return;
      }
      this._hasBotIdColumn = true;
      logger.settings('[Settings] Auto-migration complete: bot_id column added.');
      return;
    }
    const colInfo = res.results[0];
    if (colInfo.COLUMN_KEY === 'PRI') {
      this._hasBotIdColumn = true;
      return;
    }
    logger.settings('[Settings] Fixing bot_id column: adding to primary key...');
    if (colInfo.IS_NULLABLE === 'YES') {
      await this.query(`UPDATE settings SET bot_id = '' WHERE bot_id IS NULL`);
      await this.query(`ALTER TABLE settings MODIFY COLUMN bot_id VARCHAR(32) NOT NULL DEFAULT ''`);
    }
    if (this.botId) {
      await this.query(`UPDATE settings SET bot_id = ${mysql.escape(String(this.botId))} WHERE bot_id = ''`);
    }
    const pkRes = await this.query(`ALTER TABLE settings DROP PRIMARY KEY, ADD PRIMARY KEY (id, bot_id)`);
    if (pkRes.error) {
      logger.error('[Settings] Failed to update primary key:', pkRes.error);
      return;
    }
    this._hasBotIdColumn = true;
    logger.settings('[Settings] Fix complete: bot_id column added to primary key.');
  }

  /**
   * Set the bot ID and claim any orphaned settings rows (bot_id = '').
   * @param {string} id - The bot user ID.
   * @returns {Promise<void>}
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

  /**
   * Build a SQL WHERE fragment filtering by the current bot_id.
   * @returns {string} SQL fragment (empty string if bot_id not set or column unverified).
   * @private
   */
  _botIdWhere() {
    if (!this.botId || !this._hasBotIdColumn) return '';
    return ` AND bot_id = ${mysql.escape(String(this.botId))}`;
  }

  /**
   * Build SQL column/value fragments for bot_id in INSERT statements.
   * @returns {{col: string, val: string}} SQL fragments (empty strings if bot_id not applicable).
   * @private
   */
  _botIdInsert() {
    if (!this.botId || !this._hasBotIdColumn) return { col: '', val: '' };
    return { col: ', bot_id', val: `, ${mysql.escape(String(this.botId))}` };
  }

  /**
   * Fetch the settings row for a single guild.
   * @param {string} guildId - The guild ID.
   * @returns {Promise<{error: Error|null, results: any[], fields: any}>}
   */
  async selectGuild(guildId) {
    const escapedId = mysql.escape(String(guildId));
    return this.query(`SELECT * FROM settings WHERE id=${escapedId}${this._botIdWhere()}`);
  }

  /**
   * Load all guild settings from the database. Retries with exponential backoff on failure.
   * Emits 'ready' when complete.
   * @returns {Promise<void>}
   */
  async load() {
    const res = await this.query(`SELECT * FROM settings WHERE 1=1${this._botIdWhere()}`);
    if (res.error) {
      this._loadAttempts++;
      const delay = Math.min(1000 * Math.pow(2, this._loadAttempts - 1), 30_000);
      logger.error('[Settings] Init error (attempt', this._loadAttempts, 'retrying in', delay + 'ms):', res.error);
      return new Promise((resolve) => { setTimeout(() => { this.load().then(resolve).catch(resolve); }, delay); });
    }
    this._loadAttempts = 0;
    res.results.forEach((r) => {
      try {
        const server = new ServerSettings(r.id, this);
        const parsed = (typeof r.data === 'string') ? JSON.parse(r.data) : r.data;
        server.deserialize(parsed);
        server.checkDefaults(this.defaults);
        this.guilds.set(server.id, server);
      } catch (e) {
        logger.error('[Settings] Failed to parse settings for server', r.id, ':', e.message);
      }
    });
    this.emit('ready');
  }

  /**
   * Persist a single key change via MySQL JSON_SET. Falls back to a full blob save for arrays/objects.
   * @param {ServerSettings} server - The guild settings instance.
   * @param {string} key - The changed key.
   * @returns {Promise<void>}
   */
  async remoteUpdate(server, key) {
    if (this._shuttingDown) return;
    const val = server.data[key];
    if (Array.isArray(val) || (typeof val === 'object' && val !== null)) {
      return this.remoteSave(server);
    }
    const escapedPath = mysql.escape(`$.${key}`);
    const jsonVal = JSON.stringify(val);
    const escapedVal = mysql.escape(jsonVal);
    const escapedId = mysql.escape(server.id);
    const r = await this.query(`UPDATE settings SET data = JSON_SET(data, ${escapedPath}, CAST(${escapedVal} AS JSON)) WHERE id=${escapedId}${this._botIdWhere()}`);
    if (r.error) logger.error('[Settings] remoteUpdate error:', r.error);
  }

  /**
   * Persist the entire guild settings blob to the database.
   * @param {ServerSettings} server - The guild settings instance.
   * @returns {Promise<void>}
   */
  async remoteSave(server) {
    if (this._shuttingDown) return;
    const escapedData = mysql.escape(JSON.stringify(server.data));
    const escapedId = mysql.escape(server.id);
    const r = await this.query(`UPDATE settings SET data = ${escapedData} WHERE id=${escapedId}${this._botIdWhere()}`);
    if (r.error) logger.error('[Settings] remoteSave error:', r.error);
  }

  /**
   * Synchronously load default values and descriptions from a JSON file.
   * @param {string} filePath - Path to the JSON file.
   */
  loadDefaultsSync(filePath) {
    try {
      const d = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(d);
      this.descriptions = parsed.descriptions ?? {};
      this.defaults = parsed.values ?? {};
      if (parsed.internal) this.markInternal(...parsed.internal);
    } catch (e) {
      logger.error('[Settings] Failed to load defaults from', filePath, ':', e.message);
      this.descriptions = {};
      this.defaults = {};
    }
  }

  /**
   * Save all guild settings to the database in parallel.
   * @returns {Promise<void>}
   */
  async saveAsync() {
    await Promise.allSettled([...this.guilds.values()].map(v => this.remoteSave(v)));
  }

  /**
   * Insert a new settings row for a guild. Uses INSERT IGNORE to avoid duplicate-key errors.
   * @param {string} id - The guild ID.
   * @param {ServerSettings} server - The settings instance.
   * @returns {Promise<void>}
   */
  async create(id, server) {
    if (this._shuttingDown) return;
    const escapedId = mysql.escape(id);
    const escapedData = mysql.escape(JSON.stringify(server.data));
    const bi = this._botIdInsert();
    const r = await this.query(
      `INSERT IGNORE INTO settings (id, data${bi.col}) VALUES (${escapedId}, ${escapedData}${bi.val})`
    );
    if (r.error) logger.error('[Settings] create error:', r.error);
  }

  /**
   * Queue a debounced database write for a single key change (80ms delay per guild).
   * If the guild is not yet cached, it is added and a CREATE is issued.
   * @param {ServerSettings} server - The guild settings instance.
   * @param {string} key - The changed key.
   */
  update(server, key) {
    if (this._shuttingDown) return;
    if (!this.guilds.has(server.id)) {
      this.guilds.set(server.id, server);
      this.create(server.id, server).catch(e => logger.error('[Settings] create error in update:', e.message));
    }
    const s = this.guilds.get(server.id);
    s.data[key] = server.data[key];
    const existing = this._debounceTimers.get(server.id);
    if (existing) clearTimeout(existing);
    this._debounceTimers.set(server.id, setTimeout(() => {
      this._debounceTimers.delete(server.id);
      const target = this.guilds.get(server.id);
      if (target) this.remoteUpdate(target, key);
    }, 80));
  }

  /**
   * Check whether a setting key exists in defaults.
   * @param {string} key - The setting key.
   * @returns {boolean}
   */
  isOption(key) { return key in this.defaults; }

  /**
   * Check whether a guild has cached settings.
   * @param {string} id - The guild ID.
   * @returns {boolean}
   */
  hasServer(id) { return this.guilds.has(id); }

  /**
   * Get settings for a guild. Returns a fresh ServerSettings (with defaults) if not cached.
   * @param {string} id - The guild ID.
   * @returns {ServerSettings}
   */
  getServer(id) {
    if (!this.guilds.has(id)) return new ServerSettings(id, this);
    return this.guilds.get(id);
  }

  /**
   * Remove a guild from the cache and cancel any pending debounced writes.
   * @param {string} id - The guild ID.
   */
  removeServer(id) {
    const timer = this._debounceTimers.get(id);
    if (timer) { clearTimeout(timer); this._debounceTimers.delete(id); }
    this.guilds.delete(id);
  }
}
