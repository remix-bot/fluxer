/** @module src/services/TrackOptionsManager @description Per-user track options (start/end timestamps) stored in MySQL. Provides caching, matching, and CRUD for track segments. */
import mysql from "mysql2";
import { logger } from "../core/Logger.mjs";
import { MYSQL_POOL_DEFAULTS, attachMysqlPoolGuard } from "../db/MysqlGuard.mjs";

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
    this.db = mysql.createPool({ ...MYSQL_POOL_DEFAULTS, connectionLimit: 10, ...mysqlConfig });
    attachMysqlPoolGuard(this.db, "TrackOptions");
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
            alias VARCHAR(32) NOT NULL DEFAULT 'default',
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
      await this._query(`ALTER TABLE track_options ADD COLUMN alias VARCHAR(32) NOT NULL DEFAULT 'default' AFTER track_title`);
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

  /** @private Execute a raw SQL query. @param {string} q @param {Array} [params] @returns {Promise<Array>} */
  _query(q, params = []) {
    return new Promise((resolve, reject) => {
      this.db.query(q, params, (error, results) => {
        if (error) return reject(error);
        resolve(results);
      });
    });
  }

  /** @private @returns {string|null} The current bot_id value, or null if unset (matches any row via IS NULL check). */
  _botIdVal() {
    return this.botId ? String(this.botId) : null;
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
    const params = [userId, identifier, title, safeAlias, safeStartMs, safeEndMs, this._botIdVal() ?? "", safeStartMs, safeEndMs, title];

    try {
      await this._query(
          `INSERT INTO track_options (user_id, track_identifier, track_title, alias, start_ms, end_ms, bot_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE start_ms = ?, end_ms = ?, track_title = ?`,
          params
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
      const botIdVal = this._botIdVal();
      const rows = await this._query(
          `SELECT start_ms, end_ms, track_title, alias FROM track_options WHERE user_id = ? AND track_identifier = ? AND alias = ? AND (? IS NULL OR bot_id = ?)`,
          [userId, identifier, safeAlias, botIdVal, botIdVal]
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
      const botIdVal = this._botIdVal();
      const rows = await this._query(
          `SELECT start_ms, end_ms, track_title, alias FROM track_options WHERE user_id = ? AND track_identifier = ? AND (? IS NULL OR bot_id = ?) ORDER BY alias`,
          [userId, identifier, botIdVal, botIdVal]
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
      const botIdVal = this._botIdVal();
      let result;
      if (alias) {
        const safeAlias = TrackOptionsManager.sanitizeAlias(alias);
        this._cache.delete(`${userId}:${identifier}:${safeAlias}`);
        result = await this._query(
            `DELETE FROM track_options WHERE user_id = ? AND track_identifier = ? AND alias = ? AND (? IS NULL OR bot_id = ?)`,
            [userId, identifier, safeAlias, botIdVal, botIdVal]
        );
      } else {
        const keysToDelete = [];
        for (const key of this._cache.keys()) {
          if (key.startsWith(`${userId}:${identifier}:`)) keysToDelete.push(key);
        }
        for (const key of keysToDelete) this._cache.delete(key);
        result = await this._query(
            `DELETE FROM track_options WHERE user_id = ? AND track_identifier = ? AND (? IS NULL OR bot_id = ?)`,
            [userId, identifier, botIdVal, botIdVal]
        );
      }
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
      const botIdVal = this._botIdVal();
      const rows = await this._query(
          `SELECT track_identifier, track_title, alias, start_ms, end_ms FROM track_options WHERE user_id = ? AND (? IS NULL OR bot_id = ?) ORDER BY track_title, alias LIMIT ?`,
          [userId, botIdVal, botIdVal, Math.min(limit, 100)]
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
