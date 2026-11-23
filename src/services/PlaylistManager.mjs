/**
 * @module src/services/PlaylistManager
 * @description Manages personal saved playlists and track bookmarks (favorites) in MySQL.
 * All playlist and bookmark records are keyed per-user, making them accessible across all servers.
 */

import { logger } from "../core/Logger.mjs";

export const MAX_PLAYLISTS_PER_USER = 50;
export const MAX_TRACKS_PER_PLAYLIST = 250;
export const MAX_FAVORITES_PER_USER = 250;
export const MAX_NAME_LENGTH = 32;

/**
 * Sanitize user-provided playlist name.
 * @param {string} raw
 * @returns {string}
 */
export function sanitizePlaylistName(raw) {
  if (!raw || typeof raw !== "string") return "";
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\/\\]/g, "")
    .slice(0, MAX_NAME_LENGTH);
}

/**
 * @class PlaylistManager
 * @description Provides CRUD operations for user favorites and personal playlists stored in MySQL.
 */
export class PlaylistManager {
  /**
   * @param {import('mysql2/promise').Pool} pool - Shared promise-based MySQL pool.
   */
  constructor(pool) {
    this._pool = pool;
    this._ready = false;
    this._readyPromise = this._ensureTables();
  }

  /**
   * Ensure database tables exist.
   * @private
   * @returns {Promise<void>}
   */
  async _ensureTables() {
    if (!this._pool) return;
    try {
      await this._pool.execute(`
        CREATE TABLE IF NOT EXISTS \`user_favorites\` (
          \`id\` INT AUTO_INCREMENT PRIMARY KEY,
          \`user_id\` VARCHAR(32) NOT NULL,
          \`title\` VARCHAR(512) NOT NULL,
          \`author\` VARCHAR(255) NOT NULL DEFAULT '',
          \`uri\` VARCHAR(1024) NOT NULL,
          \`duration_ms\` BIGINT NOT NULL DEFAULT 0,
          \`source_name\` VARCHAR(64) NOT NULL DEFAULT '',
          \`thumbnail\` VARCHAR(1024) NOT NULL DEFAULT '',
          \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY \`uniq_user_uri\` (\`user_id\`, \`uri\`(255)),
          INDEX \`idx_user_fav_created\` (\`user_id\`, \`created_at\` DESC)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      await this._pool.execute(`
        CREATE TABLE IF NOT EXISTS \`user_playlists\` (
          \`id\` INT AUTO_INCREMENT PRIMARY KEY,
          \`user_id\` VARCHAR(32) NOT NULL,
          \`name\` VARCHAR(64) NOT NULL,
          \`tracks\` JSON NOT NULL,
          \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY \`uniq_user_pl_name\` (\`user_id\`, \`name\`),
          INDEX \`idx_user_pl_updated\` (\`user_id\`, \`updated_at\` DESC)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      this._ready = true;
      logger.info("[PlaylistManager] Database tables initialized successfully.");
    } catch (err) {
      logger.error("[PlaylistManager] Failed to initialize database tables:", err?.message);
    }
  }

  /**
   * Wait for table initialization.
   * @returns {Promise<void>}
   */
  async ready() {
    if (this._ready) return;
    await this._readyPromise;
  }

  /* =========================================================================
     FAVORITES / BOOKMARKS API
     ========================================================================= */

  /**
   * Add a track to the user's personal favorites.
   * @param {string} userId
   * @param {object} track
   * @returns {Promise<{added: boolean, alreadySaved: boolean, limitReached: boolean, count: number}>}
   */
  async addFavorite(userId, track) {
    await this.ready();
    if (!this._pool || !userId || !track) {
      return { added: false, alreadySaved: false, limitReached: false, count: 0 };
    }

    const count = await this.getFavoriteCount(userId);
    if (count >= MAX_FAVORITES_PER_USER) {
      return { added: false, alreadySaved: false, limitReached: true, count };
    }

    const title = String(track.title || "Unknown").slice(0, 512);
    const author = String(track.author?.name || track.author || "").slice(0, 255);
    const uri = String(track.url || track.uri || "").slice(0, 1024);
    const durationMs = Number(track._durationMs || track.duration?.seconds * 1000 || 0) || 0;
    const sourceName = String(track.sourceName || "unknown").slice(0, 64);
    const thumbnail = String(track.thumbnail || "").slice(0, 1024);

    if (!uri) {
      return { added: false, alreadySaved: false, limitReached: false, count };
    }

    try {
      const [result] = await this._pool.execute(`
        INSERT INTO \`user_favorites\`
          (\`user_id\`, \`title\`, \`author\`, \`uri\`, \`duration_ms\`, \`source_name\`, \`thumbnail\`)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          \`title\` = VALUES(\`title\`),
          \`author\` = VALUES(\`author\`),
          \`duration_ms\` = VALUES(\`duration_ms\`),
          \`thumbnail\` = VALUES(\`thumbnail\`);
      `, [userId, title, author, uri, durationMs, sourceName, thumbnail]);

      /* affectedRows = 1 on insert, 2 on duplicate update, 0 if identical */
      const isNew = result.affectedRows === 1;
      const newCount = isNew ? count + 1 : count;
      return { added: isNew, alreadySaved: !isNew, limitReached: false, count: newCount };
    } catch (err) {
      logger.error("[PlaylistManager] Error adding favorite:", err?.message);
      return { added: false, alreadySaved: false, limitReached: false, count };
    }
  }

  /**
   * Remove a track from user favorites by URI or index.
   * @param {string} userId
   * @param {string|number} identifier
   * @returns {Promise<{removed: boolean, track: object|null}>}
   */
  async removeFavorite(userId, identifier) {
    await this.ready();
    if (!this._pool || !userId) return { removed: false, track: null };

    try {
      /* If numeric index, resolve track at that position */
      if (typeof identifier === "number" || (/^\d+$/.test(String(identifier).trim()) && !String(identifier).includes("http"))) {
        const idx = Math.max(0, parseInt(identifier, 10) - 1);
        const favs = await this.getFavorites(userId, 1, idx);
        if (favs.length === 0) return { removed: false, track: null };

        const target = favs[0];
        await this._pool.execute(
          "DELETE FROM `user_favorites` WHERE `id` = ? AND `user_id` = ?",
          [target.id, userId]
        );
        return { removed: true, track: target };
      }

      /* Otherwise match by URI or partial title */
      const query = String(identifier).trim();
      const [rows] = await this._pool.execute(`
        SELECT * FROM \`user_favorites\`
        WHERE \`user_id\` = ? AND (\`uri\` = ? OR \`title\` LIKE ?)
        LIMIT 1
      `, [userId, query, `%${query}%`]);

      if (!rows || rows.length === 0) return { removed: false, track: null };

      const target = rows[0];
      await this._pool.execute(
        "DELETE FROM `user_favorites` WHERE `id` = ? AND `user_id` = ?",
        [target.id, userId]
      );
      return { removed: true, track: target };
    } catch (err) {
      logger.error("[PlaylistManager] Error removing favorite:", err?.message);
      return { removed: false, track: null };
    }
  }

  /**
   * Toggle a track in user favorites (heart/bookmark shortcut).
   * @param {string} userId
   * @param {object} track
   * @returns {Promise<{action: "added"|"removed"|"limit", track: object, count: number}>}
   */
  async toggleFavorite(userId, track) {
    await this.ready();
    const uri = String(track?.url || track?.uri || "").trim();
    if (!uri) return { action: "removed", track: null, count: 0 };

    const favs = await this.getFavorites(userId, 500, 0);
    const existing = favs.find(f => f.uri === uri);

    if (existing) {
      await this.removeFavorite(userId, existing.uri);
      return { action: "removed", track: existing, count: Math.max(0, favs.length - 1) };
    }

    const res = await this.addFavorite(userId, track);
    if (res.limitReached) {
      return { action: "limit", track, count: favs.length };
    }
    return { action: "added", track, count: res.count };
  }

  /**
   * Get total count of favorites for a user.
   * @param {string} userId
   * @returns {Promise<number>}
   */
  async getFavoriteCount(userId) {
    await this.ready();
    if (!this._pool || !userId) return 0;
    try {
      const [rows] = await this._pool.execute(
        "SELECT COUNT(*) AS total FROM `user_favorites` WHERE `user_id` = ?",
        [userId]
      );
      return Number(rows?.[0]?.total || 0);
    } catch (err) {
      logger.error("[PlaylistManager] Error counting favorites:", err?.message);
      return 0;
    }
  }

  /**
   * Get all favorite tracks for a user with pagination.
   * @param {string} userId
   * @param {number} [limit=100]
   * @param {number} [offset=0]
   * @returns {Promise<Array<object>>}
   */
  async getFavorites(userId, limit = 100, offset = 0) {
    await this.ready();
    if (!this._pool || !userId) return [];
    try {
      const safeLimit = Math.max(1, Math.min(limit, 500));
      const safeOffset = Math.max(0, offset);
      const [rows] = await this._pool.execute(`
        SELECT \`id\`, \`title\`, \`author\`, \`uri\`, \`duration_ms\`, \`source_name\`, \`thumbnail\`, \`created_at\`
        FROM \`user_favorites\`
        WHERE \`user_id\` = ?
        ORDER BY \`created_at\` DESC
        LIMIT ${safeLimit} OFFSET ${safeOffset}
      `, [userId]);
      return Array.isArray(rows) ? rows : [];
    } catch (err) {
      logger.error("[PlaylistManager] Error fetching favorites:", err?.message);
      return [];
    }
  }

  /**
   * Clear all favorites for a user.
   * @param {string} userId
   * @returns {Promise<number>} Number of cleared favorites.
   */
  async clearFavorites(userId) {
    await this.ready();
    if (!this._pool || !userId) return 0;
    try {
      const [result] = await this._pool.execute(
        "DELETE FROM `user_favorites` WHERE `user_id` = ?",
        [userId]
      );
      return Number(result.affectedRows || 0);
    } catch (err) {
      logger.error("[PlaylistManager] Error clearing favorites:", err?.message);
      return 0;
    }
  }

  /* =========================================================================
     PLAYLISTS API
     ========================================================================= */

  /**
   * Save a list of tracks as a personal playlist.
   * Overwrites if the playlist already exists.
   * @param {string} userId
   * @param {string} rawName
   * @param {Array<object>} rawTracks
   * @returns {Promise<{success: boolean, name: string, count: number, isNew: boolean, error?: string}>}
   */
  async savePlaylist(userId, rawName, rawTracks) {
    await this.ready();
    const name = sanitizePlaylistName(rawName);
    if (!name) {
      return { success: false, name: "", count: 0, isNew: false, error: "INVALID_NAME" };
    }

    if (!Array.isArray(rawTracks) || rawTracks.length === 0) {
      return { success: false, name, count: 0, isNew: false, error: "EMPTY_TRACKS" };
    }

    /* Check playlist count limit if creating new */
    const existing = await this.getPlaylist(userId, name);
    if (!existing) {
      const allPlaylists = await this.listPlaylists(userId);
      if (allPlaylists.length >= MAX_PLAYLISTS_PER_USER) {
        return { success: false, name, count: 0, isNew: false, error: "LIMIT_REACHED" };
      }
    }

    /* Serialize tracks up to cap */
    const tracksToSave = rawTracks.slice(0, MAX_TRACKS_PER_PLAYLIST).map(t => ({
      title: String(t.title || "Unknown").slice(0, 512),
      author: String(t.author?.name || t.author || "").slice(0, 255),
      uri: String(t.url || t.uri || ""),
      durationMs: Number(t._durationMs || t.duration?.seconds * 1000 || 0) || 0,
      sourceName: String(t.sourceName || "unknown").slice(0, 64),
      thumbnail: String(t.thumbnail || "").slice(0, 1024),
    })).filter(t => t.uri.length > 0);

    if (tracksToSave.length === 0) {
      return { success: false, name, count: 0, isNew: false, error: "EMPTY_TRACKS" };
    }

    try {
      const jsonStr = JSON.stringify(tracksToSave);
      const [res] = await this._pool.execute(`
        INSERT INTO \`user_playlists\` (\`user_id\`, \`name\`, \`tracks\`)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE \`tracks\` = VALUES(\`tracks\`), \`updated_at\` = CURRENT_TIMESTAMP;
      `, [userId, name, jsonStr]);

      const isNew = res.affectedRows === 1;
      return { success: true, name, count: tracksToSave.length, isNew };
    } catch (err) {
      logger.error("[PlaylistManager] Error saving playlist:", err?.message);
      return { success: false, name, count: 0, isNew: false, error: "DB_ERROR" };
    }
  }

  /**
   * Get a saved playlist by name.
   * @param {string} userId
   * @param {string} rawName
   * @returns {Promise<{id: number, name: string, tracks: Array<object>, created_at: Date, updated_at: Date}|null>}
   */
  async getPlaylist(userId, rawName) {
    await this.ready();
    const name = sanitizePlaylistName(rawName);
    if (!this._pool || !userId || !name) return null;

    try {
      const [rows] = await this._pool.execute(
        "SELECT * FROM `user_playlists` WHERE `user_id` = ? AND `name` = ? LIMIT 1",
        [userId, name]
      );
      if (!rows || rows.length === 0) return null;

      const record = rows[0];
      let tracks = [];
      try {
        tracks = typeof record.tracks === "string" ? JSON.parse(record.tracks) : (record.tracks || []);
      } catch (_) {
        tracks = [];
      }
      return {
        id: record.id,
        name: record.name,
        tracks: Array.isArray(tracks) ? tracks : [],
        created_at: record.created_at,
        updated_at: record.updated_at,
      };
    } catch (err) {
      logger.error("[PlaylistManager] Error getting playlist:", err?.message);
      return null;
    }
  }

  /**
   * List all saved playlists for a user.
   * @param {string} userId
   * @returns {Promise<Array<{name: string, trackCount: number, updated_at: Date, created_at: Date}>>}
   */
  async listPlaylists(userId) {
    await this.ready();
    if (!this._pool || !userId) return [];

    try {
      const [rows] = await this._pool.execute(`
        SELECT \`name\`, \`tracks\`, \`created_at\`, \`updated_at\`
        FROM \`user_playlists\`
        WHERE \`user_id\` = ?
        ORDER BY \`updated_at\` DESC
      `, [userId]);

      if (!Array.isArray(rows)) return [];

      return rows.map(r => {
        let count = 0;
        try {
          const parsed = typeof r.tracks === "string" ? JSON.parse(r.tracks) : r.tracks;
          count = Array.isArray(parsed) ? parsed.length : 0;
        } catch (_) {
          count = 0;
        }
        return {
          name: r.name,
          trackCount: count,
          created_at: r.created_at,
          updated_at: r.updated_at,
        };
      });
    } catch (err) {
      logger.error("[PlaylistManager] Error listing playlists:", err?.message);
      return [];
    }
  }

  /**
   * Delete a saved playlist by name.
   * @param {string} userId
   * @param {string} rawName
   * @returns {Promise<boolean>}
   */
  async deletePlaylist(userId, rawName) {
    await this.ready();
    const name = sanitizePlaylistName(rawName);
    if (!this._pool || !userId || !name) return false;

    try {
      const [res] = await this._pool.execute(
        "DELETE FROM `user_playlists` WHERE `user_id` = ? AND `name` = ?",
        [userId, name]
      );
      return Number(res.affectedRows || 0) > 0;
    } catch (err) {
      logger.error("[PlaylistManager] Error deleting playlist:", err?.message);
      return false;
    }
  }

  /**
   * Add a single track to an existing playlist.
   * @param {string} userId
   * @param {string} rawName
   * @param {object} track
   * @returns {Promise<{success: boolean, name: string, count: number, error?: string}>}
   */
  async addToPlaylist(userId, rawName, track) {
    await this.ready();
    const name = sanitizePlaylistName(rawName);
    if (!name || !track) {
      return { success: false, name, count: 0, error: "INVALID_ARG" };
    }

    const playlist = await this.getPlaylist(userId, name);
    if (!playlist) {
      return { success: false, name, count: 0, error: "NOT_FOUND" };
    }

    if (playlist.tracks.length >= MAX_TRACKS_PER_PLAYLIST) {
      return { success: false, name, count: playlist.tracks.length, error: "PLAYLIST_FULL" };
    }

    const uri = String(track.url || track.uri || "");
    if (!uri) return { success: false, name, count: playlist.tracks.length, error: "NO_URI" };

    playlist.tracks.push({
      title: String(track.title || "Unknown").slice(0, 512),
      author: String(track.author?.name || track.author || "").slice(0, 255),
      uri,
      durationMs: Number(track._durationMs || track.duration?.seconds * 1000 || 0) || 0,
      sourceName: String(track.sourceName || "unknown").slice(0, 64),
      thumbnail: String(track.thumbnail || "").slice(0, 1024),
    });

    try {
      await this._pool.execute(
        "UPDATE `user_playlists` SET `tracks` = ?, `updated_at` = CURRENT_TIMESTAMP WHERE `user_id` = ? AND `name` = ?",
        [JSON.stringify(playlist.tracks), userId, name]
      );
      return { success: true, name, count: playlist.tracks.length };
    } catch (err) {
      logger.error("[PlaylistManager] Error adding to playlist:", err?.message);
      return { success: false, name, count: playlist.tracks.length, error: "DB_ERROR" };
    }
  }

  /**
   * Add multiple tracks to an existing playlist up to MAX_TRACKS_PER_PLAYLIST.
   * @param {string} userId
   * @param {string} rawName
   * @param {Array<object>} newTracks
   * @returns {Promise<{success: boolean, name: string, addedCount: number, count: number, error?: string}>}
   */
  async addTracksToPlaylist(userId, rawName, newTracks) {
    await this.ready();
    const name = sanitizePlaylistName(rawName);
    if (!name || !Array.isArray(newTracks) || newTracks.length === 0) {
      return { success: false, name, addedCount: 0, count: 0, error: "INVALID_ARG" };
    }

    const playlist = await this.getPlaylist(userId, name);
    if (!playlist) {
      return { success: false, name, addedCount: 0, count: 0, error: "NOT_FOUND" };
    }

    const availableSlots = MAX_TRACKS_PER_PLAYLIST - playlist.tracks.length;
    if (availableSlots <= 0) {
      return { success: false, name, addedCount: 0, count: playlist.tracks.length, error: "PLAYLIST_FULL" };
    }

    const sanitized = newTracks.slice(0, availableSlots).map(t => ({
      title: String(t.title || "Unknown").slice(0, 512),
      author: String(t.author?.name || t.author || "").slice(0, 255),
      uri: String(t.url || t.uri || ""),
      durationMs: Number(t._durationMs || t.durationMs || t.duration?.seconds * 1000 || 0) || 0,
      sourceName: String(t.sourceName || "unknown").slice(0, 64),
      thumbnail: String(t.thumbnail || "").slice(0, 1024),
    })).filter(t => t.uri.length > 0);

    if (sanitized.length === 0) {
      return { success: false, name, addedCount: 0, count: playlist.tracks.length, error: "NO_VALID_TRACKS" };
    }

    playlist.tracks.push(...sanitized);

    try {
      await this._pool.execute(
        "UPDATE `user_playlists` SET `tracks` = ?, `updated_at` = CURRENT_TIMESTAMP WHERE `user_id` = ? AND `name` = ?",
        [JSON.stringify(playlist.tracks), userId, name]
      );
      return { success: true, name, addedCount: sanitized.length, count: playlist.tracks.length };
    } catch (err) {
      logger.error("[PlaylistManager] Error adding tracks to playlist:", err?.message);
      return { success: false, name, addedCount: 0, count: playlist.tracks.length, error: "DB_ERROR" };
    }
  }

  /**
   * Remove a track at 1-based index from a playlist.
   * @param {string} userId
   * @param {string} rawName
   * @param {number} oneBasedIndex
   * @returns {Promise<{success: boolean, name: string, removedTrack: object|null, count: number, error?: string}>}
   */
  async removeFromPlaylist(userId, rawName, oneBasedIndex) {
    await this.ready();
    const name = sanitizePlaylistName(rawName);
    const playlist = await this.getPlaylist(userId, name);
    if (!playlist) {
      return { success: false, name, removedTrack: null, count: 0, error: "NOT_FOUND" };
    }

    const idx = parseInt(oneBasedIndex, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= playlist.tracks.length) {
      return { success: false, name, removedTrack: null, count: playlist.tracks.length, error: "INVALID_INDEX" };
    }

    const removedTrack = playlist.tracks.splice(idx, 1)[0];
    try {
      await this._pool.execute(
        "UPDATE `user_playlists` SET `tracks` = ?, `updated_at` = CURRENT_TIMESTAMP WHERE `user_id` = ? AND `name` = ?",
        [JSON.stringify(playlist.tracks), userId, name]
      );
      return { success: true, name, removedTrack, count: playlist.tracks.length };
    } catch (err) {
      logger.error("[PlaylistManager] Error removing track from playlist:", err?.message);
      return { success: false, name, removedTrack: null, count: playlist.tracks.length, error: "DB_ERROR" };
    }
  }
}
