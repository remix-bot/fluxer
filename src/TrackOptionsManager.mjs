import mysql from "mysql2";
import { logger } from "./constants/Logger.mjs";

export class TrackOptionsManager {
  db = null;
  botId = null;
  _hasTable = false;
  _ready = false;
  _readyPromise = null;
  _cache = new Map();
  _cacheMaxSize = 2000;

  constructor(mysqlConfig) {
    this.db = mysql.createPool({ connectionLimit: 10, ...mysqlConfig });
    this.db.on("error", (err) => {
      logger.error("[TrackOptions] MySQL pool error:", err.code ?? err.message);
    });
    this._readyPromise = this._ensureTable();
  }

  async ready() {
    await this._readyPromise;
  }

  async _ensureTable() {
    try {
      await this._query(
        `CREATE TABLE IF NOT EXISTS track_options (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id VARCHAR(32) NOT NULL,
          track_identifier VARCHAR(512) NOT NULL,
          track_title VARCHAR(512) NOT NULL DEFAULT '',
          start_ms INT UNSIGNED NOT NULL DEFAULT 0,
          end_ms INT UNSIGNED NOT NULL DEFAULT 0,
          bot_id VARCHAR(32) NOT NULL DEFAULT '',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uq_user_track_bot (user_id, track_identifier, bot_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
      );
      this._hasTable = true;
      this._ready = true;
      logger.player("[TrackOptions] Table ready.");
    } catch (err) {
      logger.error("[TrackOptions] Failed to create table:", err.message);
    }
  }

  async setBotId(id) {
    this.botId = id;
  }

  _query(q) {
    return new Promise((resolve, reject) => {
      this.db.query(q, (error, results) => {
        if (error) return reject(error);
        resolve(results);
      });
    });
  }

  _botIdWhere() {
    if (!this.botId) return "";
    return ` AND bot_id = ${mysql.escape(String(this.botId))}`;
  }

  _botIdInsert() {
    if (!this.botId) return { col: "", val: "" };
    return { col: ", bot_id", val: `, ${mysql.escape(String(this.botId))}` };
  }

  static makeTrackIdentifier(track) {
    if (!track) return null;
    if (track.url) {
      try {
        const u = new URL(track.url);
        return `${u.hostname}${u.pathname}`.replace(/\/+$/, "").toLowerCase().trim();
      } catch {
        return track.url.toLowerCase().trim();
      }
    }
    const artist = track.artist || track.author?.name || "";
    const title = track.title || "";
    if (artist && title) return `${artist} - ${title}`.toLowerCase().trim();
    if (title) return title.toLowerCase().trim();
    return null;
  }

  async set(userId, track, startMs, endMs) {
    await this.ready();
    const identifier = TrackOptionsManager.makeTrackIdentifier(track);
    if (!identifier) return null;

    const title = (track.title || "").slice(0, 512);
    const bi = this._botIdInsert();

    try {
      await this._query(
        `INSERT INTO track_options (user_id, track_identifier, track_title, start_ms, end_ms${bi.col})
         VALUES (${mysql.escape(userId)}, ${mysql.escape(identifier)}, ${mysql.escape(title)}, ${startMs}, ${endMs}${bi.val})
         ON DUPLICATE KEY UPDATE start_ms = ${startMs}, end_ms = ${endMs}, track_title = ${mysql.escape(title)}`
      );
      this._cache.delete(`${userId}:${identifier}`);
      return { identifier, startMs, endMs };
    } catch (err) {
      logger.error("[TrackOptions] set error:", err.message);
      return null;
    }
  }

  async get(userId, track) {
    await this.ready();
    const identifier = TrackOptionsManager.makeTrackIdentifier(track);
    if (!identifier) return null;

    const cacheKey = `${userId}:${identifier}`;
    if (this._cache.has(cacheKey)) return this._cache.get(cacheKey);

    try {
      const rows = await this._query(
        `SELECT start_ms, end_ms, track_title FROM track_options WHERE user_id = ${mysql.escape(userId)} AND track_identifier = ${mysql.escape(identifier)}${this._botIdWhere()}`
      );
      if (!rows || rows.length === 0) return null;
      const result = { startMs: rows[0].start_ms, endMs: rows[0].end_ms, title: rows[0].track_title };
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

  async remove(userId, track) {
    await this.ready();
    const identifier = TrackOptionsManager.makeTrackIdentifier(track);
    if (!identifier) return false;

    try {
      const result = await this._query(
        `DELETE FROM track_options WHERE user_id = ${mysql.escape(userId)} AND track_identifier = ${mysql.escape(identifier)}${this._botIdWhere()}`
      );
      this._cache.delete(`${userId}:${identifier}`);
      return result.affectedRows > 0;
    } catch (err) {
      logger.error("[TrackOptions] remove error:", err.message);
      return false;
    }
  }

  async list(userId, limit = 25) {
    await this.ready();
    try {
      const rows = await this._query(
        `SELECT track_identifier, track_title, start_ms, end_ms FROM track_options WHERE user_id = ${mysql.escape(userId)}${this._botIdWhere()} ORDER BY updated_at DESC LIMIT ${Math.min(limit, 100)}`
      );
      return rows || [];
    } catch (err) {
      logger.error("[TrackOptions] list error:", err.message);
      return [];
    }
  }

  async getBestMatchForChannel(userIds, track) {
    await this.ready();
    const identifier = TrackOptionsManager.makeTrackIdentifier(track);
    if (!identifier || !userIds || userIds.length === 0) return null;

    for (const uid of userIds) {
      const result = await this.get(uid, track);
      if (result) return { ...result, userId: uid };
    }
    return null;
  }
}
