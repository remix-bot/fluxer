/** @module src/TrackOptionsManager @description Per-user track options (start/end timestamps) stored in MySQL. Provides caching, matching, and CRUD for track segments. */
import mysql from "mysql2";
import { logger } from "./constants/Logger.mjs";

const DEFAULT_ALIAS = "default";
const MAX_ALIAS_LEN = 32;

/** @class TrackOptionsManager @description Manages per-user track options (start/end timestamps, aliases) stored in MySQL. Provides caching, best-match lookup, and CRUD operations. */
export class TrackOptionsManager {
  /** @type {import('mysql2').Pool} */
  db = null;
  /** @type {string|null} */
  botId = null;
  /** @private */
  _hasTable = false;
  /** @private */
  _ready = false;
  /** @private */
  _readyPromise = null;
  /** @private @type {Map<string, object>} */
  _cache = new Map();
  /** @private @type {number} */
  _cacheMaxSize = 2000;

  /** @param {object} mysqlConfig - MySQL connection config. */
  constructor(mysqlConfig) {
    this.db = mysql.createPool({ connectionLimit: 10, ...mysqlConfig });
    this.db.on("error", (err) => {
      logger.error("[TrackOptions] MySQL pool error:", err.code ?? err.message);
    });
    this._readyPromise = this._ensureTable();
  }

  /** @async Wait for the table to be ready. @returns {Promise<void>} */
  async ready() {
    await this._readyPromise;
  }

  /** @private @async Ensure the track_options table exists with proper schema. */
  async _ensureTable() {
    try {
      await this._query(
        `CREATE TABLE IF NOT EXISTS track_options (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id VARCHAR(32) NOT NULL,
          track_identifier VARCHAR(512) NOT NULL,
          track_title VARCHAR(512) NOT NULL DEFAULT '',
          alias VARCHAR(${MAX_ALIAS_LEN}) NOT NULL DEFAULT '${DEFAULT_ALIAS}',
          start_ms INT UNSIGNED NOT NULL DEFAULT 0,
          end_ms INT UNSIGNED NOT NULL DEFAULT 0,
          bot_id VARCHAR(32) NOT NULL DEFAULT '',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uq_user_track_alias_bot (user_id, track_identifier, alias, bot_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
      );
      await this._migrateOldTable();
      this._hasTable = true;
      this._ready = true;
      logger.player("[TrackOptions] Table ready.");
    } catch (err) {
      logger.error("[TrackOptions] Failed to create table:", err.message);
    }
  }

  /** @private @async Migrate from old schema (single unique key) to new (with alias column). */
  async _migrateOldTable() {
    try {
      const cols = await this._query(`SHOW COLUMNS FROM track_options LIKE 'alias'`);
      if (cols && cols.length > 0) return;
      await this._query(`ALTER TABLE track_options ADD COLUMN alias VARCHAR(${MAX_ALIAS_LEN}) NOT NULL DEFAULT '${DEFAULT_ALIAS}' AFTER track_title`);
      await this._query(`ALTER TABLE track_options DROP INDEX uq_user_track_bot`);
      await this._query(`ALTER TABLE track_options ADD UNIQUE KEY uq_user_track_alias_bot (user_id, track_identifier, alias, bot_id)`);
      logger.player("[TrackOptions] Migrated table — added alias column.");
    } catch (err) {
      logger.warn("[TrackOptions] Migration check:", err.message);
    }
  }

  /** @async Set the bot ID for multi-bot isolation. @param {string} id */
  async setBotId(id) {
    this.botId = id;
  }

  /** @private Execute a raw SQL query. @param {string} q @returns {Promise<Array>} */
  _query(q) {
    return new Promise((resolve, reject) => {
      this.db.query(q, (error, results) => {
        if (error) return reject(error);
        resolve(results);
      });
    });
  }

  /** @private @returns {string} SQL WHERE clause fragment for bot_id. */
  _botIdWhere() {
    if (!this.botId) return "";
    return ` AND bot_id = ${mysql.escape(String(this.botId))}`;
  }

  /** @private @returns {{col: string, val: string}} SQL column and value fragments for bot_id INSERT. */
  _botIdInsert() {
    if (!this.botId) return { col: "", val: "" };
    return { col: ", bot_id", val: `, ${mysql.escape(String(this.botId))}` };
  }

  /** Sanitize an alias to alphanumeric, lowercase, max MAX_ALIAS_LEN chars. @param {*} raw @returns {string} */
  static sanitizeAlias(raw) {
    if (!raw || typeof raw !== "string") return DEFAULT_ALIAS;
    const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "").toLowerCase().slice(0, MAX_ALIAS_LEN);
    return cleaned || DEFAULT_ALIAS;
  }

  /** Build a unique identifier for a track from its URL or artist-title combination. @param {object} track @returns {string|null} */
  static makeTrackIdentifier(track) {
    if (!track) return null;
    if (track.url) {
      try {
        const u = new URL(track.url);
        return `${u.hostname}${u.pathname}`.replace(/\/+$/, "").toLowerCase().trim();
      } catch (e) {
          logger.warn("[TrackOptions] Error:", e?.message);
          return track.url.toLowerCase().trim();
      }
    }
    const artist = track.artist || track.author?.name || "";
    const title = track.title || "";
    if (artist && title) return `${artist} - ${title}`.toLowerCase().trim();
    if (title) return title.toLowerCase().trim();
    return null;
  }

  /** @async Save or update a track option. @param {string} userId @param {object} track @param {number} startMs @param {number} endMs @param {string} [alias] @returns {Promise<{identifier: string, startMs: number, endMs: number, alias: string}|null>} */
  async set(userId, track, startMs, endMs, alias = DEFAULT_ALIAS) {
    await this.ready();
    const identifier = TrackOptionsManager.makeTrackIdentifier(track);
    if (!identifier) return null;

    const safeStartMs = Number.isFinite(startMs) ? Math.max(0, Math.trunc(startMs)) : 0;
    const safeEndMs = Number.isFinite(endMs) ? Math.max(0, Math.trunc(endMs)) : 0;

    const safeAlias = TrackOptionsManager.sanitizeAlias(alias);
    const title = (track.title || "").slice(0, 512);
    const bi = this._botIdInsert();

    try {
      await this._query(
        `INSERT INTO track_options (user_id, track_identifier, track_title, alias, start_ms, end_ms${bi.col})
         VALUES (${mysql.escape(userId)}, ${mysql.escape(identifier)}, ${mysql.escape(title)}, ${mysql.escape(safeAlias)}, ${safeStartMs}, ${safeEndMs}${bi.val})
         ON DUPLICATE KEY UPDATE start_ms = ${safeStartMs}, end_ms = ${safeEndMs}, track_title = ${mysql.escape(title)}`
      );
      this._cache.delete(`${userId}:${identifier}:${safeAlias}`);
      return { identifier, startMs: safeStartMs, endMs: safeEndMs, alias: safeAlias };
    } catch (err) {
      logger.error("[TrackOptions] set error:", err.message);
      return null;
    }
  }

  /** @async Get a user's track option for a track. @param {string} userId @param {object} track @param {string} [alias] @returns {Promise<{startMs: number, endMs: number, title: string, alias: string}|null>} */
  async get(userId, track, alias = DEFAULT_ALIAS) {
    await this.ready();
    const identifier = TrackOptionsManager.makeTrackIdentifier(track);
    if (!identifier) return null;

    const safeAlias = TrackOptionsManager.sanitizeAlias(alias);
    const cacheKey = `${userId}:${identifier}:${safeAlias}`;
    if (this._cache.has(cacheKey)) {
      const cached = this._cache.get(cacheKey);
      this._cache.delete(cacheKey);
      this._cache.set(cacheKey, cached);
      return cached;
    }

    try {
      const rows = await this._query(
        `SELECT start_ms, end_ms, track_title, alias FROM track_options WHERE user_id = ${mysql.escape(userId)} AND track_identifier = ${mysql.escape(identifier)} AND alias = ${mysql.escape(safeAlias)}${this._botIdWhere()}`
      );
      if (!rows || rows.length === 0) return null;
      const result = { startMs: rows[0].start_ms, endMs: rows[0].end_ms, title: rows[0].track_title, alias: rows[0].alias };
      if (this._cache.size >= this._cacheMaxSize) {
        const firstKey = this._cache.keys().next().value;
        this._cache.delete(firstKey);
      }
      this._cache.set(cacheKey, result);
      return result;
    } catch (err) {
      logger.error("[TrackOptions] get error:", err.message);
      return null;
    }
  }

  /** @async Get all track options for a track for a user. @param {string} userId @param {object} track @returns {Promise<Array>} */
  async getAllForTrack(userId, track) {
    await this.ready();
    const identifier = TrackOptionsManager.makeTrackIdentifier(track);
    if (!identifier) return [];

    try {
      const rows = await this._query(
        `SELECT start_ms, end_ms, track_title, alias FROM track_options WHERE user_id = ${mysql.escape(userId)} AND track_identifier = ${mysql.escape(identifier)}${this._botIdWhere()} ORDER BY alias`
      );
      return rows || [];
    } catch (err) {
      logger.error("[TrackOptions] getAllForTrack error:", err.message);
      return [];
    }
  }

  /** @async Remove track option(s) for a user. @param {string} userId @param {object} track @param {string|null} [alias] @returns {Promise<boolean>} Whether a row was deleted. */
  async remove(userId, track, alias = null) {
    await this.ready();
    const identifier = TrackOptionsManager.makeTrackIdentifier(track);
    if (!identifier) return false;

    try {
      let sql;
      if (alias) {
        const safeAlias = TrackOptionsManager.sanitizeAlias(alias);
        sql = `DELETE FROM track_options WHERE user_id = ${mysql.escape(userId)} AND track_identifier = ${mysql.escape(identifier)} AND alias = ${mysql.escape(safeAlias)}${this._botIdWhere()}`;
        this._cache.delete(`${userId}:${identifier}:${safeAlias}`);
      } else {
        sql = `DELETE FROM track_options WHERE user_id = ${mysql.escape(userId)} AND track_identifier = ${mysql.escape(identifier)}${this._botIdWhere()}`;
        const keysToDelete = [];
        for (const key of this._cache.keys()) {
          if (key.startsWith(`${userId}:${identifier}:`)) keysToDelete.push(key);
        }
        for (const key of keysToDelete) this._cache.delete(key);
      }
      const result = await this._query(sql);
      return result.affectedRows > 0;
    } catch (err) {
      logger.error("[TrackOptions] remove error:", err.message);
      return false;
    }
  }

  /** @async List all track options for a user. @param {string} userId @param {number} [limit=25] @returns {Promise<Array>} */
  async list(userId, limit = 25) {
    await this.ready();
    try {
      const rows = await this._query(
        `SELECT track_identifier, track_title, alias, start_ms, end_ms FROM track_options WHERE user_id = ${mysql.escape(userId)}${this._botIdWhere()} ORDER BY track_title, alias LIMIT ${Math.min(limit, 100)}`
      );
      return rows || [];
    } catch (err) {
      logger.error("[TrackOptions] list error:", err.message);
      return [];
    }
  }

  /** @async Find the first matching track option among a set of users. @param {string[]} userIds @param {object} track @param {string} [alias] @returns {Promise<{startMs: number, endMs: number, title: string, alias: string, userId: string}|null>} */
  async getBestMatchForChannel(userIds, track, alias = DEFAULT_ALIAS) {
    await this.ready();
    const identifier = TrackOptionsManager.makeTrackIdentifier(track);
    if (!identifier || !userIds || userIds.length === 0) return null;

    for (const uid of userIds) {
      const result = await this.get(uid, track, alias);
      if (result) return { ...result, userId: uid };
    }
    return null;
  }
}
