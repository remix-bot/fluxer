/**
 * @file LastFmManager.mjs — LastFmManager — Last.fm API integration for scrobbling, now-playing, loved tracks, top tracks, and track recommendations
 * @module src.LastFmManager
 */

/**
 * LastFmManager.mjs — Last.fm API client for scrobbling, auth, and user data.
 *
 * Features:
 *   - Auth flow (desktop API: get token → user authorizes → get session)
 *   - Now-playing notification (track.scrobble with timestamp=0)
 *   - Full scrobble after threshold (50% of track or 4 min, whichever is less)
 *   - Fetch loved / top / recent tracks for %play lastfm loved/top/recent
 *   - Per-user session key storage in MySQL table `lastfm_users`
 *
 * Last.fm API docs: https://www.last.fm/api
 */

import crypto from "node:crypto";
import { logger } from "./constants/Logger.mjs";
import { Utils } from "./Utils.mjs";

const BASE_URL = "https://ws.audioscrobbler.com/2.0/";

function normalizeTrackText(value) {
  return Utils.normalizeText(value);
}

/**
 * Build the API signature required by Last.fm for authenticated calls.
 * See: https://www.last.fm/api/authentication
 */
function buildSignature(params, apiSecret) {
  const sorted = Object.keys(params).sort();
  const str = sorted.map(k => k + params[k]).join("");
  return crypto.createHash("md5").update(str + apiSecret).digest("hex");
}

/**
 * Make a signed Last.fm API call.
 * @param {object} params  - API parameters (method, api_key, etc.)
 * @param {string} apiSecret
 * @param {boolean} [post=false] - Use POST instead of GET
 * @returns {Promise<object>} Parsed JSON response
 */
async function apiCall(params, apiSecret, post = false) {
  const allParams = { ...params };
  allParams.api_sig = buildSignature(allParams, apiSecret);
  allParams.format  = "json";

  const url = post ? BASE_URL : `${BASE_URL}?${new URLSearchParams(allParams)}`;

  const opts = post
    ? {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(allParams).toString(),
      }
    : {};

  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Last.fm HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  if (data.error) {
    throw new Error(`Last.fm ${data.error}: ${data.message}`);
  }
  return data;
}

/**
 * LastFmManager class.
 */
export class LastFmManager {
  /**
   * @param {object} config - The `lastfm` section from config.json
   * @param {object} mysqlConfig - MySQL connection info for creating the users table
   */
  constructor(config, mysqlConfig) {
    this.apiKey    = config?.apiKey ?? "";
    this.apiSecret = config?.apiSecret ?? "";
    this.enabled   = config?.enabled !== false && !!(this.apiKey && this.apiSecret);
    this.scrobbleThreshold = config?.scrobbleThreshold ?? 0.5;
    this.scrobbleMinMs     = config?.scrobbleMinMs ?? 240_000;

    this._mysqlConfig = mysqlConfig;
    this._pool = null;

    /** @type {string|null} Bot user ID — used to isolate rows per-bot in shared databases */
    this.botId = null;
    /** @type {boolean} Whether the bot_id column exists in the lastfm tables */
    this._hasBotIdColumn = false;

    this._userCache = new Map();
    this._userCacheMax = 5000;

    this._totalScrobblesCache = null;
    this._totalScrobblesCacheExpiry = 0;
    this._totalScrobblesInflight = null;

    if (!this.enabled) {
      if (config?.enabled === false) {
        logger.settings("[LastFm] Disabled — \"enabled\" is set to false in config.");
      } else {
        logger.settings("[LastFm] Disabled — apiKey or apiSecret missing in config.");
      }
    }
  }

  /**
   * Set the bot ID for multi-bot database isolation.
   * Ensures bot_id column exists in lastfm tables, then clears caches.
   */
  async setBotId(id) {
    const changed = this.botId !== id;
    this.botId = id;
    if (changed) {
      await this._ensureBotIdColumn();
      this._userCache.clear();
    }
  }

  /**
   * Auto-migrate: add bot_id column to lastfm_users and lastfm_stats if missing.
   * Uses NOT NULL DEFAULT '' because MySQL primary key columns cannot be NULL.
   * If the column exists but isn't in the PK (previous failed migration with
   * DEFAULT NULL), fix the NULL values and retry the PK update.
   */
  async _ensureBotIdColumn() {
    if (this._hasBotIdColumn) return;
    const pool = await this._getPool();

    const [cols] = await pool.execute(
      `SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_KEY FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'lastfm_users' AND COLUMN_NAME = 'bot_id'`
    );
    if (cols.length === 0) {
      logger.settings("[LastFm] Auto-migrating: adding bot_id column to lastfm_users...");
      await pool.execute("ALTER TABLE `lastfm_users` ADD COLUMN `bot_id` VARCHAR(32) NOT NULL DEFAULT ''");
      if (this.botId) {
        await pool.execute("UPDATE `lastfm_users` SET `bot_id` = ? WHERE `bot_id` = ''", [String(this.botId)]);
      }
      await pool.execute("ALTER TABLE `lastfm_users` DROP PRIMARY KEY, ADD PRIMARY KEY (user_id, bot_id)");
      logger.settings("[LastFm] Auto-migration complete: lastfm_users.bot_id added.");
    } else {
      const colInfo = cols[0];
      const isNullable = colInfo.IS_NULLABLE === 'YES';
      const isPK = colInfo.COLUMN_KEY === 'PRI';
      if (!isPK) {
        logger.settings("[LastFm] Fixing lastfm_users.bot_id: adding to primary key...");
        if (isNullable) {
          await pool.execute("UPDATE `lastfm_users` SET `bot_id` = '' WHERE `bot_id` IS NULL");
          await pool.execute("ALTER TABLE `lastfm_users` MODIFY COLUMN `bot_id` VARCHAR(32) NOT NULL DEFAULT ''");
        }
        if (this.botId) {
          await pool.execute("UPDATE `lastfm_users` SET `bot_id` = ? WHERE `bot_id` = ''", [String(this.botId)]);
        }
        await pool.execute("ALTER TABLE `lastfm_users` DROP PRIMARY KEY, ADD PRIMARY KEY (user_id, bot_id)");
        logger.settings("[LastFm] Fix complete: lastfm_users.bot_id added to primary key.");
      }
    }

    const [statsCols] = await pool.execute(
      `SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_KEY FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'lastfm_stats' AND COLUMN_NAME = 'bot_id'`
    );
    if (statsCols.length === 0) {
      logger.settings("[LastFm] Auto-migrating: adding bot_id column to lastfm_stats...");
      await pool.execute("ALTER TABLE `lastfm_stats` ADD COLUMN `bot_id` VARCHAR(32) NOT NULL DEFAULT ''");
      if (this.botId) {
        await pool.execute("UPDATE `lastfm_stats` SET `bot_id` = ? WHERE `bot_id` = ''", [String(this.botId)]);
      }
      await pool.execute("ALTER TABLE `lastfm_stats` DROP PRIMARY KEY, ADD PRIMARY KEY (id, bot_id)");
      logger.settings("[LastFm] Auto-migration complete: lastfm_stats.bot_id added.");
    } else {
      const colInfo = statsCols[0];
      const isNullable = colInfo.IS_NULLABLE === 'YES';
      const isPK = colInfo.COLUMN_KEY === 'PRI';
      if (!isPK) {
        logger.settings("[LastFm] Fixing lastfm_stats.bot_id: adding to primary key...");
        if (isNullable) {
          await pool.execute("UPDATE `lastfm_stats` SET `bot_id` = '' WHERE `bot_id` IS NULL");
          await pool.execute("ALTER TABLE `lastfm_stats` MODIFY COLUMN `bot_id` VARCHAR(32) NOT NULL DEFAULT ''");
        }
        if (this.botId) {
          await pool.execute("UPDATE `lastfm_stats` SET `bot_id` = ? WHERE `bot_id` = ''", [String(this.botId)]);
        }
        await pool.execute("ALTER TABLE `lastfm_stats` DROP PRIMARY KEY, ADD PRIMARY KEY (id, bot_id)");
        logger.settings("[LastFm] Fix complete: lastfm_stats.bot_id added to primary key.");
      }
    }

    this._hasBotIdColumn = true;
  }

  /**
   * Returns SQL WHERE fragment for bot_id filtering.
   * Uses prepared statement placeholder (?) for safety.
   * @returns {{ where: string, params: string[] }}
   */
  _botIdFilter() {
    if (!this.botId || !this._hasBotIdColumn) return { where: "", params: [] };
    return { where: " AND bot_id = ?", params: [String(this.botId)] };
  }

  async _getPool() {
    if (this._pool) return this._pool;
    const mysql = await import("mysql2/promise");
    this._pool = mysql.createPool({
      host:     this._mysqlConfig.host,
      port:     this._mysqlConfig.port ?? 3306,
      user:     this._mysqlConfig.user,
      password: this._mysqlConfig.password,
      database: this._mysqlConfig.database,
    });
    await this._initTable();
    return this._pool;
  }

  async _initTable() {
    const pool = this._pool;
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS \`lastfm_users\` (
        \`user_id\`       VARCHAR(30)  NOT NULL PRIMARY KEY,
        \`session_key\`   VARCHAR(64)  NOT NULL,
        \`username\`      VARCHAR(64)  NOT NULL DEFAULT '',
        \`scrobble\`      TINYINT(1)   NOT NULL DEFAULT 1,
        \`scrobble_count\` BIGINT       NOT NULL DEFAULT 0,
        \`linked_at\`     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    try {
      await pool.execute("ALTER TABLE \`lastfm_users\` ADD COLUMN \`scrobble_count\` BIGINT NOT NULL DEFAULT 0 AFTER \`scrobble\`");
    } catch (e) {
      logger.warn("[LastFm] Migration warning:", e?.message);
    }

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS \`lastfm_stats\` (
        \`id\`              TINYINT(1)  NOT NULL PRIMARY KEY DEFAULT 1,
        \`stored_scrobbles\` BIGINT     NOT NULL DEFAULT 0,
        \`linked_users\`    INT         NOT NULL DEFAULT 0
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    await pool.execute(`
      INSERT IGNORE INTO \`lastfm_stats\` (id, stored_scrobbles, linked_users) VALUES (1, 0, 0)
    `);
  }

  async getUser(userId) {
    const cached = this._userCache.get(userId);
    if (cached) return cached;

    const pool = await this._getPool();
    const f = this._botIdFilter();
    const [rows] = await pool.execute(
      `SELECT session_key, username, scrobble FROM lastfm_users WHERE user_id = ?${f.where}`,
      [String(userId), ...f.params]
    );

    if (!rows.length) return null;

    const row = rows[0];
    const data = {
      sessionKey:     row.session_key,
      username:       row.username,
      scrobbleEnabled: !!row.scrobble,
    };
    this._userCache.set(userId, data);
    while (this._userCache.size > this._userCacheMax) {
      const oldestKey = this._userCache.keys().next().value;
      this._userCache.delete(oldestKey);
    }
    return data;
  }

  async saveUser(userId, sessionKey, username) {
    const pool = await this._getPool();
    const f = this._botIdFilter();
    await pool.execute(
      `INSERT INTO lastfm_users (user_id, session_key, username, scrobble${f.where ? ', bot_id' : ''})
       VALUES (?, ?, ?, 1${f.where ? ', ?' : ''})
       ON DUPLICATE KEY UPDATE session_key = VALUES(session_key), username = VALUES(username)`,
      [String(userId), sessionKey, username ?? "", ...f.params]
    );
    const data = { sessionKey, username: username ?? "", scrobbleEnabled: true };
    this._userCache.set(userId, data);
    while (this._userCache.size > this._userCacheMax) {
      const oldestKey = this._userCache.keys().next().value;
      this._userCache.delete(oldestKey);
    }

    try {
      await pool.execute(
        `UPDATE lastfm_stats SET linked_users = linked_users + 1 WHERE id = 1${f.where} AND NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM lastfm_users WHERE user_id = ?${f.where} AND linked_at < NOW()) AS tmp)`,
        [...f.params, String(userId), ...f.params]
      );
    } catch (e) {
      logger.warn("[LastFm] Migration warning:", e?.message);
    }

    return data;
  }

  async removeUser(userId) {
    const pool = await this._getPool();
    const f = this._botIdFilter();
    await pool.execute(`DELETE FROM lastfm_users WHERE user_id = ?${f.where}`, [String(userId), ...f.params]);
    this._userCache.delete(userId);
  }

  async setScrobble(userId, enabled) {
    const pool = await this._getPool();
    const f = this._botIdFilter();
    await pool.execute(
      `UPDATE lastfm_users SET scrobble = ? WHERE user_id = ?${f.where}`,
      [enabled ? 1 : 0, String(userId), ...f.params]
    );
    const cached = this._userCache.get(userId);
    if (cached) cached.scrobbleEnabled = enabled;
  }

  /**
   * Step 1: Get an auth token. The user must visit the Last.fm auth URL to approve it.
   * @returns {Promise<string>} The auth token
   */
  async getAuthToken() {
    this._assertEnabled();
    const data = await apiCall(
      { method: "auth.gettoken", api_key: this.apiKey },
      this.apiSecret
    );
    return data.token;
  }

  /**
   * Get the URL the user should visit to authorize the token.
   */
  getAuthUrl(token) {
    return `https://www.last.fm/api/auth/?api_key=${this.apiKey}&token=${token}`;
  }

  /**
   * Step 2: After the user authorizes the token, exchange it for a session key.
   * @returns {Promise<{ key: string, name: string }>}
   */
  async getSession(token) {
    this._assertEnabled();
    const data = await apiCall(
      { method: "auth.getsession", api_key: this.apiKey, token },
      this.apiSecret
    );
    return data.session;
  }

  /**
   * Send a "now playing" notification to Last.fm (does NOT count as a scrobble).
   * Called immediately when a track starts.
   */
  async updateNowPlaying(userId, track) {
    if (!this.enabled) return;
    const user = await this.getUser(userId);
    if (!user || !user.scrobbleEnabled) return;

    try {
      await apiCall(
        {
          method:           "track.updatenowplaying",
          api_key:          this.apiKey,
          sk:               user.sessionKey,
          artist:           this._extractArtist(track),
          track:            this._extractTitle(track),
          album:            track.album ?? "",
          duration:         this._extractDurationSec(track),
          trackNumber:      track.trackNumber ?? "",
        },
        this.apiSecret,
        true
      );
    } catch (err) {
      logger.warn(`[LastFm] updateNowPlaying failed for ${userId}: ${err.message}`);
    }
  }

  /**
   * Scrobble a track (counts toward the user's Last.fm play counts).
   * Called after the track has played for >= 50% of its duration (or 4 minutes).
   */
  async scrobble(userId, track, startedAtMs) {
    if (!this.enabled) return;
    const user = await this.getUser(userId);
    if (!user || !user.scrobbleEnabled) return;

    try {
      await apiCall(
        {
          method:           "track.scrobble",
          api_key:          this.apiKey,
          sk:               user.sessionKey,
          "artist[0]":      this._extractArtist(track),
          "track[0]":       this._extractTitle(track),
          "album[0]":       track.album ?? "",
          "timestamp[0]":   Math.floor(startedAtMs / 1000),
          "duration[0]":    this._extractDurationSec(track),
        },
        this.apiSecret,
        true
      );
      logger.settings(`[LastFm] Scrobbled "${track.title}" for ${userId}`);

      this._incrementScrobbleCount(userId);
    } catch (err) {
      logger.warn(`[LastFm] Scrobble failed for ${userId}: ${err.message}`);
    }
  }

  /**
   * Get the user's loved tracks.
   * @param {number} [limit=20] - Max tracks to return
   * @returns {Promise<Array<{ artist, name, url, image }>>}
   */
  async getLovedTracks(userId, limit = 20) {
    const user = await this.getUser(userId);
    if (!user) throw new Error("NOT_LINKED");

    const data = await apiCall(
      {
        method:   "user.getlovedtracks",
        api_key:  this.apiKey,
        user:     user.username,
        limit,
      },
      this.apiSecret
    );

    return (data.lovedtracks?.track ?? []).map(t => ({
      artist: t.artist?.name ?? t.artist?.["#text"] ?? "Unknown",
      name:   t.name,
      url:    t.url,
      image:  t.image?.[2]?.["#text"] ?? t.image?.[1]?.["#text"] ?? "",
    }));
  }

  /**
   * Get the user's top tracks.
   * @param {string} userId
   * @param {string} [period="overall"] - overall | 7day | 1month | 3month | 6month | 12month
   * @param {number} [limit=20]
   */
  async getTopTracks(userId, period = "overall", limit = 20) {
    const user = await this.getUser(userId);
    if (!user) throw new Error("NOT_LINKED");

    const data = await apiCall(
      {
        method:   "user.gettoptracks",
        api_key:  this.apiKey,
        user:     user.username,
        period,
        limit,
      },
      this.apiSecret
    );

    return (data.toptracks?.track ?? []).map(t => ({
      artist:   t.artist?.name ?? "Unknown",
      name:     t.name,
      url:      t.url,
      playcount: t.playcount ?? 0,
      image:    t.image?.[2]?.["#text"] ?? t.image?.[1]?.["#text"] ?? "",
    }));
  }

  /**
   * Get the user's recent tracks.
   * @param {string} userId
   * @param {number} [limit=20]
   */
  async getRecentTracks(userId, limit = 20) {
    const user = await this.getUser(userId);
    if (!user) throw new Error("NOT_LINKED");

    const data = await apiCall(
      {
        method:   "user.getrecenttracks",
        api_key:  this.apiKey,
        user:     user.username,
        limit,
      },
      this.apiSecret
    );

    return (data.recenttracks?.track ?? []).map(t => ({
      artist: t.artist?.["#text"] ?? t.artist?.name ?? "Unknown",
      name:   t.name,
      url:    t.url,
      now:    t["@attr"]?.nowplaying === "true",
      image:  t.image?.[2]?.["#text"] ?? t.image?.[1]?.["#text"] ?? "",
    }));
  }

  /**
   * Get track info (play count, tags, etc.) for the %np embed.
   */
  async getTrackInfo(artist, track, userId = null) {
    if (!this.enabled) return null;

    const params = {
      method:    "track.getinfo",
      api_key:   this.apiKey,
      artist,
      track,
    };

    if (userId) {
      const user = await this.getUser(userId);
      if (user) params.username = user.username;
    }

    try {
      const data = await apiCall(params, this.apiSecret);
      return data.track;
    } catch (e) {
        logger.warn("[LastFm] Error:", e?.message);
        return null;
    }
  }

  /**
   * Love a track on Last.fm for the given user.
   * @param {string} userId - The Fluxer user ID
   * @param {string} artist - Track artist
   * @param {string} track - Track name
   */
  async loveTrack(userId, artist, track) {
    if (!this.enabled) return;
    const user = await this.getUser(userId);
    if (!user) throw new Error("NOT_LINKED");

    await apiCall(
      {
        method:     "track.love",
        api_key:    this.apiKey,
        sk:         user.sessionKey,
        artist,
        track,
      },
      this.apiSecret,
      true
    );
  }

  /**
   * Unlove a track on Last.fm for the given user.
   * @param {string} userId - The Fluxer user ID
   * @param {string} artist - Track artist
   * @param {string} track - Track name
   */
  async unloveTrack(userId, artist, track) {
    if (!this.enabled) return;
    const user = await this.getUser(userId);
    if (!user) throw new Error("NOT_LINKED");

    await apiCall(
      {
        method:     "track.unlove",
        api_key:    this.apiKey,
        sk:         user.sessionKey,
        artist,
        track,
      },
      this.apiSecret,
      true
    );
  }

  /**
   * Search Last.fm for a freeform track query and return the best match.
   * Useful for `%play lastfm: kendrick lamar luther` where artist/title
   * boundaries are ambiguous.
   *
   * @param {string} query
   * @param {number} [limit=10]
   * @returns {Promise<{ artist: string, name: string, url: string } | null>}
   */
  async searchTrack(query, limit = 10) {
    if (!this.enabled) return null;

    const data = await apiCall(
      {
        method: "track.search",
        api_key: this.apiKey,
        track: query,
        limit,
      },
      this.apiSecret
    );

    const matches = data?.results?.trackmatches?.track;
    const tracks = Array.isArray(matches)
      ? matches
      : matches
        ? [matches]
        : [];

    if (!tracks.length) return null;

    const normalizedQuery = normalizeTrackText(query);
    const queryTokens = normalizedQuery.split(" ").filter(Boolean);

    const scored = tracks.map((track, index) => {
      const artist = String(track.artist ?? "").trim();
      const name = String(track.name ?? "").trim();
      const artistNorm = normalizeTrackText(artist);
      const nameNorm = normalizeTrackText(name);
      const combined = `${artistNorm} ${nameNorm}`.trim();

      let score = 0;

      if (combined === normalizedQuery) score += 50;
      if (combined.includes(normalizedQuery) && normalizedQuery) score += 25;
      if (normalizedQuery.includes(nameNorm) && nameNorm) score += 15;
      if (normalizedQuery.includes(artistNorm) && artistNorm) score += 12;

      const overlap = queryTokens.filter(token => combined.includes(token)).length;
      score += overlap * 4;

      const nameLower = name.toLowerCase();
      const artistLower = artist.toLowerCase();
      const urlLower = String(track.url ?? "").toLowerCase();
      const fullText = `${nameLower} ${artistLower} ${urlLower}`;

      const negativePatterns = [
        /\bofficial (?:lyric|lyrics)\s*video\b/,
        /\bofficial video\b/,
        /\bofficial music video\b/,
        /\blyric video\b/,
        /\blyrics video\b/,
        /\bmusic video\b/,
        /\bofficial audio\b/,
        /\bvisuali[sz]er\b/,
        /\bkaraoke\b/,
        /\bcover\b/,
        /\bremix\b/,
        /\bacoustic\b/,
        /\blive\b/,
        /\bsped up\b/,
        /\bslowed\b/,
        /\breverb\b/,
        /\bnightcore\b/,
        /\b8d\b/,
        /\bclip officiel\b/,
        /\bvideo oficial\b/,
        /\bperformance\b/,
      ];

      for (const re of negativePatterns) {
        if (re.test(fullText)) {
          score -= 30;
          break;
        }
      }

      const labelKeywords = [
        /\bpictures\b/i,
        /\banimation\b/i,
        /\brecords?\b/i,
        /\bstudios?\b/i,
        /\bentertainment\b/i,
        /\bproductions?\b/i,
        /\bmusic\s+(group|corp|inc|llc)\b/i,
        /\brecordings?\b/i,
        /\blabel\b/i,
      ];
      for (const re of labelKeywords) {
        if (re.test(artist)) {
          score -= 20;
          break;
        }
      }

      if (/^["""].*["""]$/.test(name) || /["""]/.test(name)) {
        score -= 15;
      }

      if (urlLower.includes("/_/")) {
        score += 5;
      }

      return {
        index,
        score,
        track: {
          artist,
          name,
          url: track.url ?? "",
        },
      };
    });

    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    return scored[0]?.track ?? null;
  }

  /**
   * Get similar tracks from Last.fm for a given track.
   * @param {string} artist
   * @param {string} track
   * @param {number} [limit=5]
   * @returns {Promise<Array<{ artist: string, name: string, url: string, match: number }>>}
   */
  async getSimilarTracks(artist, track, limit = 5) {
    if (!this.enabled) return [];

    try {
      const data = await apiCall(
        {
          method:   "track.getsimilar",
          api_key:  this.apiKey,
          artist,
          track,
          limit,
        },
        this.apiSecret
      );

      return (data.similartracks?.track ?? []).map(t => ({
        artist: t.artist?.name ?? "Unknown",
        name:   t.name,
        url:    t.url ?? "",
        match:  parseFloat(t.match ?? 0),
      })).filter(t => t.match > 0.1);
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  }

  /**
   * Get detailed artist info from Last.fm.
   * @param {string} artist - Artist name
   * @param {string} [userId=null] - Optional user ID for user-specific playcount
   * @returns {Promise<object|null>} Parsed artist object or null on error
   */
  async getArtistInfo(artist, userId = null) {
    if (!this.enabled) return null;

    const params = {
      method:   "artist.getinfo",
      api_key:  this.apiKey,
      artist,
    };

    if (userId) {
      const user = await this.getUser(userId);
      if (user) params.username = user.username;
    }

    try {
      const data = await apiCall(params, this.apiSecret);
      const a = data.artist;
      if (!a) return null;

      return {
        name:          a.name ?? "",
        url:           a.url ?? "",
        image:         a.image?.[2]?.["#text"] ?? a.image?.[1]?.["#text"] ?? "",
        tags:          (a.tags?.tag ?? []).map(t => t.name ?? t),
        bio:           a.bio?.summary ?? a.bio?.content ?? "",
        stats: {
          listeners:  Number(a.stats?.listeners ?? 0),
          playcount:  Number(a.stats?.playcount ?? 0),
        },
        similar:       (a.similar?.artist ?? []).map(s => ({
          name:  s.name ?? "",
          url:   s.url ?? "",
          image: s.image?.[2]?.["#text"] ?? s.image?.[1]?.["#text"] ?? "",
        })),
        userplaycount: a.stats?.userplaycount ? Number(a.stats.userplaycount) : null,
      };
    } catch (e) {
        logger.warn("[LastFm] Error:", e?.message);
        return null;
    }
  }

  /**
   * Get detailed album info from Last.fm.
   * @param {string} artist - Artist name
   * @param {string} album - Album name
   * @param {string} [userId=null] - Optional user ID for user-specific playcount
   * @returns {Promise<object|null>} Parsed album object or null on error
   */
  async getAlbumInfo(artist, album, userId = null) {
    if (!this.enabled) return null;

    const params = {
      method:   "album.getinfo",
      api_key:  this.apiKey,
      artist,
      album,
    };

    if (userId) {
      const user = await this.getUser(userId);
      if (user) params.username = user.username;
    }

    try {
      const data = await apiCall(params, this.apiSecret);
      const a = data.album;
      if (!a) return null;

      return {
        name:          a.name ?? "",
        artist:        a.artist ?? "",
        url:           a.url ?? "",
        image:         a.image?.[2]?.["#text"] ?? a.image?.[1]?.["#text"] ?? "",
        tags:          (a.tags?.tag ?? []).map(t => t.name ?? t),
        tracks:        (a.tracks?.track ?? []).map(t => ({
          name:      t.name ?? "",
          url:       t.url ?? "",
          duration:  Number(t.duration ?? 0),
          playcount: Number(t.playcount ?? 0),
        })),
        userplaycount: a.userplaycount ? Number(a.userplaycount) : null,
      };
    } catch (e) {
        logger.warn("[LastFm] Error:", e?.message);
        return null;
    }
  }

  /**
   * Get an artist's top tracks from Last.fm.
   * @param {string} artist - Artist name
   * @param {number} [limit=10] - Max tracks to return
   * @returns {Promise<Array<object>>} Array of top tracks
   */
  async getArtistTopTracks(artist, limit = 10) {
    if (!this.enabled) return [];

    try {
      const data = await apiCall(
        {
          method:   "artist.gettoptracks",
          api_key:  this.apiKey,
          artist,
          limit,
        },
        this.apiSecret
      );

      return (data.toptracks?.track ?? []).map(t => ({
        artist:     t.artist?.name ?? artist,
        name:       t.name ?? "",
        url:        t.url ?? "",
        playcount:  Number(t.playcount ?? 0),
        image:      t.image?.[2]?.["#text"] ?? t.image?.[1]?.["#text"] ?? "",
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  }

  /**
   * Get an artist's top albums from Last.fm.
   * @param {string} artist - Artist name
   * @param {number} [limit=10] - Max albums to return
   * @returns {Promise<Array<object>>} Array of top albums
   */
  async getArtistTopAlbums(artist, limit = 10) {
    if (!this.enabled) return [];

    try {
      const data = await apiCall(
        {
          method:   "artist.gettopalbums",
          api_key:  this.apiKey,
          artist,
          limit,
        },
        this.apiSecret
      );

      return (data.topalbums?.album ?? []).map(a => ({
        name:      a.name ?? "",
        artist:    a.artist?.name ?? artist,
        url:       a.url ?? "",
        playcount: Number(a.playcount ?? 0),
        image:     a.image?.[2]?.["#text"] ?? a.image?.[1]?.["#text"] ?? "",
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  }

  /**
   * Get similar artists from Last.fm.
   * @param {string} artist - Artist name
   * @param {number} [limit=10] - Max similar artists to return
   * @returns {Promise<Array<object>>} Array of similar artists with match percentage
   */
  async getSimilarArtists(artist, limit = 10) {
    if (!this.enabled) return [];

    try {
      const data = await apiCall(
        {
          method:   "artist.getsimilar",
          api_key:  this.apiKey,
          artist,
          limit,
        },
        this.apiSecret
      );

      return (data.similarartists?.artist ?? []).map(a => ({
        name:    a.name ?? "",
        url:     a.url ?? "",
        image:   a.image?.[2]?.["#text"] ?? a.image?.[1]?.["#text"] ?? "",
        match:   parseFloat(a.match ?? 0),
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  }

  /**
   * Get a user's top tags from Last.fm.
   * @param {string} userId - The Fluxer user ID
   * @param {number} [limit=20] - Max tags to return
   * @returns {Promise<Array<object>>} Array of top tags with count
   */
  async getUserTopTags(userId, limit = 20) {
    if (!this.enabled) return [];

    const user = await this.getUser(userId);
    if (!user) return [];

    try {
      const data = await apiCall(
        {
          method:   "user.gettoptags",
          api_key:  this.apiKey,
          user:     user.username,
          limit,
        },
        this.apiSecret
      );

      return (data.toptags?.tag ?? []).map(t => ({
        name:  t.name ?? "",
        url:   t.url ?? "",
        count: Number(t.count ?? 0),
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  }

  /**
   * Get detailed tag info from Last.fm.
   * @param {string} tag - Tag name
   * @returns {Promise<object|null>} Tag info or null on error
   */
  async getTagInfo(tag) {
    if (!this.enabled) return null;

    try {
      const data = await apiCall(
        {
          method:  "tag.getinfo",
          api_key: this.apiKey,
          tag,
        },
        this.apiSecret
      );

      const t = data.tag;
      if (!t) return null;

      return {
        name:    t.name ?? "",
        url:     t.url ?? "",
        reach:   Number(t.reach ?? 0),
        count:   Number(t.taggings?.total ?? t.total ?? 0),
        summary: t.wiki?.summary ?? "",
      };
    } catch (e) {
        logger.warn("[LastFm] Error:", e?.message);
        return null;
    }
  }

  /**
   * Get top tracks for a tag from Last.fm.
   * @param {string} tag - Tag name
   * @param {number} [limit=10] - Max tracks to return
   * @returns {Promise<Array<object>>} Array of tracks
   */
  async getTagTopTracks(tag, limit = 10) {
    if (!this.enabled) return [];

    try {
      const data = await apiCall(
        {
          method:   "tag.gettoptracks",
          api_key:  this.apiKey,
          tag,
          limit,
        },
        this.apiSecret
      );

      return (data.tracks?.track ?? []).map(t => ({
        artist:     t.artist?.name ?? "Unknown",
        name:       t.name ?? "",
        url:        t.url ?? "",
        playcount:  Number(t.playcount ?? 0),
        image:      t.image?.[2]?.["#text"] ?? t.image?.[1]?.["#text"] ?? "",
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  }

  /**
   * Get top artists for a tag from Last.fm.
   * @param {string} tag - Tag name
   * @param {number} [limit=10] - Max artists to return
   * @returns {Promise<Array<object>>} Array of artists
   */
  async getTagTopArtists(tag, limit = 10) {
    if (!this.enabled) return [];

    try {
      const data = await apiCall(
        {
          method:   "tag.gettopartists",
          api_key:  this.apiKey,
          tag,
          limit,
        },
        this.apiSecret
      );

      return (data.topartists?.artist ?? []).map(a => ({
        name:      a.name ?? "",
        url:       a.url ?? "",
        playcount: Number(a.playcount ?? 0),
        image:     a.image?.[2]?.["#text"] ?? a.image?.[1]?.["#text"] ?? "",
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  }

  /**
   * Get play counts for an artist across multiple users ("who knows").
   * Processes users in batches of 5 for concurrency control.
   * @param {string} artist - Artist name
   * @param {Array<string>} userIds - Array of Fluxer user IDs to check
   * @returns {Promise<Array<{ userId: string, username: string, playcount: number }>>}
   *   Sorted by playcount descending, only includes users with playcount > 0
   */
  async getWhoKnows(artist, userIds) {
    if (!this.enabled) return [];
    if (!Array.isArray(userIds) || !userIds.length) return [];

    const concurrency = 5;
    const results = [];

    for (let i = 0; i < userIds.length; i += concurrency) {
      const batch = userIds.slice(i, i + concurrency);

      const batchResults = await Promise.allSettled(
        batch.map(async (uid) => {
          const user = await this.getUser(uid);
          if (!user) return null;

          try {
            const info = await this.getArtistInfo(artist, uid);
            const playcount = info?.userplaycount ?? 0;
            return {
              userId:    uid,
              username:  user.username,
              playcount,
            };
          } catch (e) {
              logger.warn("[LastFm] Error:", e?.message);
              return {
              userId:    uid,
              username:  user.username,
              playcount: 0,
            };
          }
        })
      );

      for (const r of batchResults) {
        if (r.status === "fulfilled" && r.value && r.value.playcount > 0) {
          results.push(r.value);
        }
      }
    }

    results.sort((a, b) => b.playcount - a.playcount);
    return results;
  }

  /**
   * Compare two Last.fm users by their top artists overlap.
   * @param {string} userId1 - First Fluxer user ID
   * @param {string} userId2 - Second Fluxer user ID
   * @returns {Promise<object|null>} Comparison result or null on error
   */
  async compareUsers(userId1, userId2) {
    if (!this.enabled) return null;

    try {
      const user1Data = await this.getUser(userId1);
      const user2Data = await this.getUser(userId2);
      if (!user1Data || !user2Data) return null;

      const [artists1, artists2] = await Promise.all([
        this.getTopArtists(userId1, "overall", 50),
        this.getTopArtists(userId2, "overall", 50),
      ]);

      const names1 = new Set(artists1.map(a => a.name.toLowerCase()));
      const names2 = new Set(artists2.map(a => a.name.toLowerCase()));

      const commonNames = [...names1].filter(n => names2.has(n));
      const commonArtists = artists1
        .filter(a => names2.has(a.name.toLowerCase()))
        .map(a => ({
          name:      a.name,
          url:       a.url,
          playcount: a.playcount,
        }));

      const totalUnique = new Set([...names1, ...names2]).size;
      const matchPercentage = totalUnique > 0
        ? Math.round((commonNames.length / totalUnique) * 100)
        : 0;

      return {
        user1: {
          username:     user1Data.username,
          totalArtists: names1.size,
        },
        user2: {
          username:     user2Data.username,
          totalArtists: names2.size,
        },
        commonArtists,
        matchPercentage,
      };
    } catch (e) {
        logger.warn("[LastFm] Error:", e?.message);
        return null;
    }
  }

  /**
   * Get a user's weekly chart list from Last.fm.
   * @param {string} userId - The Fluxer user ID
   * @returns {Promise<Array<object>>} Array of chart periods
   */
  async getUserWeeklyChartList(userId) {
    if (!this.enabled) return [];

    const user = await this.getUser(userId);
    if (!user) return [];

    try {
      const data = await apiCall(
        {
          method:  "user.getweeklychartlist",
          api_key: this.apiKey,
          user:    user.username,
        },
        this.apiSecret
      );

      return (data.weeklychartlist?.chart ?? []).map(c => ({
        from: Number(c.from ?? 0),
        to:   Number(c.to ?? 0),
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  }

  /**
   * Search Last.fm for artists matching a query.
   * @param {string} query - Search query
   * @param {number} [limit=10] - Max results to return
   * @returns {Promise<Array<object>>} Array of matching artists
   */
  async searchArtist(query, limit = 10) {
    if (!this.enabled) return [];

    try {
      const data = await apiCall(
        {
          method:  "artist.search",
          api_key: this.apiKey,
          artist:  query,
          limit,
        },
        this.apiSecret
      );

      const matches = data?.results?.artistmatches?.artist;
      const artists = Array.isArray(matches)
        ? matches
        : matches
          ? [matches]
          : [];

      return artists.map(a => ({
        name:    a.name ?? "",
        url:     a.url ?? "",
        image:   a.image?.[2]?.["#text"] ?? a.image?.[1]?.["#text"] ?? "",
        listeners: Number(a.listeners ?? 0),
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  }

  /**
   * Search Last.fm for albums matching a query.
   * @param {string} query - Search query
   * @param {number} [limit=10] - Max results to return
   * @returns {Promise<Array<object>>} Array of matching albums
   */
  async searchAlbum(query, limit = 10) {
    if (!this.enabled) return [];

    try {
      const data = await apiCall(
        {
          method:  "album.search",
          api_key: this.apiKey,
          album:   query,
          limit,
        },
        this.apiSecret
      );

      const matches = data?.results?.albummatches?.album;
      const albums = Array.isArray(matches)
        ? matches
        : matches
          ? [matches]
          : [];

      return albums.map(a => ({
        name:      a.name ?? "",
        artist:    a.artist ?? "",
        url:       a.url ?? "",
        image:     a.image?.[2]?.["#text"] ?? a.image?.[1]?.["#text"] ?? "",
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  }

  /**
   * Parse a Last.fm music URL and extract artist and track info.
   * Supports:
   *   https://www.last.fm/music/Artist
   *   https://www.last.fm/music/Artist/Track
   *   https://www.last.fm/music/Artist/Album/Track
   *   https://www.last.fm/music/Artist/_/Track
   *
   * @param {string} url
   * @returns {{ artist: string, track: string|null, album: string|null, url: string } | null}
   */
  parseLastFmUrl(url) {
    try {
      const u = new URL(url);
      if (!/^(?:www\.)?last\.fm$/i.test(u.hostname)) return null;

      const match = u.pathname.match(/^\/music\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?/);
      if (!match) return null;

      const artist = decodeURIComponent(match[1].replace(/\+/g, " "));
      const segment2 = match[2] ? decodeURIComponent(match[2].replace(/\+/g, " ")) : null;
      const segment3 = match[3] ? decodeURIComponent(match[3].replace(/\+/g, " ")) : null;

      let track = null;
      let album = null;

      if (segment3) {
        album = segment2 === "_" ? null : segment2;
        track = segment3;
      } else if (segment2 && segment2 !== "_") {
        track = segment2;
      }

      return { artist, track, album, url };
    } catch (e) {
        logger.warn("[LastFm] Error:", e?.message);
        return null;
    }
  }

  /**
   * Check if a string is a Last.fm music URL.
   * @param {string} str
   * @returns {boolean}
   */
  isLastFmUrl(str) {
    if (!str || typeof str !== "string") return false;
    try {
      const u = new URL(str);
      return /^(?:www\.)?last\.fm$/i.test(u.hostname) && /^\/music\//.test(u.pathname);
    } catch (e) {
        logger.warn("[LastFm] Error:", e?.message);
        return false;
    }
  }

  /**
   * Get the user's Last.fm profile info.
   */
  async getUserInfo(userId) {
    const user = await this.getUser(userId);
    if (!user) throw new Error("NOT_LINKED");

    const data = await apiCall(
      {
        method:   "user.getinfo",
        api_key:  this.apiKey,
        user:     user.username,
      },
      this.apiSecret
    );

    return data.user;
  }

  /**
   * Get a list of the user's Last.fm playlists by scraping their profile page.
   * The Last.fm API removed user.getplaylists, so we fetch the HTML page.
   *
   * @param {string} userId
   * @returns {Promise<Array<{ title: string, trackCount: number, url: string }>>}
   */
  async getPlaylists(userId) {
    const user = await this.getUser(userId);
    if (!user) throw new Error("NOT_LINKED");

    const profileUrl = `https://www.last.fm/user/${encodeURIComponent(user.username)}/playlists`;
    const res = await fetch(profileUrl, {
      headers: { "User-Agent": "RemixBot/1.0 (Last.fm Integration)" },
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch profile page (HTTP ${res.status})`);
    }

    const html = await res.text();
    const playlists = [];

    const playlistRegex = /href="\/user\/[^/]+\/playlists\/(\d+)"[^>]*>([^<]+)<\/a>/gi;
    let match;
    while ((match = playlistRegex.exec(html)) !== null) {
      const id = match[1];
      const title = match[2].trim();
      if (title && id) {
        playlists.push({
          id,
          title,
          url: `https://www.last.fm/user/${user.username}/playlists/${id}`,
        });
      }
    }

    const countRegex = /(\d+)\s+track/gi;
    const counts = [];
    let cMatch;
    while ((cMatch = countRegex.exec(html)) !== null) {
      counts.push(+cMatch[1]);
    }
    playlists.forEach((pl, i) => {
      pl.trackCount = counts[i] ?? 0;
    });

    return playlists;
  }

  /**
   * Fetch tracks from a specific Last.fm playlist.
   * Since the API removed playlist.fetch, we scrape the playlist page.
   *
   * @param {string} userId
   * @param {number|string} playlistId - Playlist number (1-based from getPlaylists) or full Last.fm playlist URL
   * @param {number} [limit=50] - Max tracks to return
   * @returns {Promise<Array<{ artist, name, url, image }>>}
   */
  async getPlaylistTracks(userId, playlistId, limit = 50) {
    const user = await this.getUser(userId);
    if (!user) throw new Error("NOT_LINKED");

    let playlistUrl;

    if (/^\d+$/.test(String(playlistId))) {
      const playlists = await this.getPlaylists(userId);
      const idx = +playlistId - 1;
      if (idx < 0 || idx >= playlists.length) {
        throw new Error(`Playlist #${playlistId} not found. You have ${playlists.length} playlist(s). Use the lastfm playlists command to see them.`);
      }
      playlistUrl = playlists[idx].url;
    } else if (String(playlistId).startsWith("http")) {
      playlistUrl = String(playlistId);
    } else {
      playlistUrl = `https://www.last.fm/user/${user.username}/playlists/${playlistId}`;
    }

    const res = await fetch(playlistUrl, {
      headers: { "User-Agent": "RemixBot/1.0 (Last.fm Integration)" },
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch playlist page (HTTP ${res.status})`);
    }

    const html = await res.text();
    const tracks = [];

    const trackLinkRegex = /href="\/music\/([^"]+?)"[^>]*class="[^"]*(?:link-block-target|chartlist-name)[^"]*"[^>]*>([^<]+)<\/a>/gi;
    let tMatch;
    while ((tMatch = trackLinkRegex.exec(html)) !== null && tracks.length < limit) {
      const urlPath = decodeURIComponent(tMatch[1]);
      const name = tMatch[2].trim();
      const parts = urlPath.split("/");
      let artist = "Unknown";
      if (parts.length >= 1) {
        artist = parts[0].replace(/\+/g, " ");
      }
      if (parts.length >= 3 && parts[1] === "_") {
      } else if (parts.length >= 2) {
      }

      if (name && name !== "Unknown") {
        tracks.push({
          artist,
          name,
          url: `https://www.last.fm/music/${urlPath}`,
          image: "",
        });
      }
    }

    if (!tracks.length) {
      const broadRegex = /href="\/music\/([^"]+)"[^>]*>([^<]{2,80})<\/a>/gi;
      const seen = new Set();
      let bMatch;
      while ((bMatch = broadRegex.exec(html)) !== null && tracks.length < limit) {
        const urlPath = decodeURIComponent(bMatch[1]);
        const name = bMatch[2].trim();
        const parts = urlPath.split("/");
        if (parts.length < 2) continue;
        if (seen.has(urlPath)) continue;
        seen.add(urlPath);

        const artist = parts[0].replace(/\+/g, " ");
        const trackName = parts.length >= 3 && parts[1] === "_"
          ? parts[2].replace(/\+/g, " ")
          : parts[1].replace(/\+/g, " ");

        if (trackName && artist) {
          tracks.push({
            artist,
            name: trackName,
            url: `https://www.last.fm/music/${urlPath}`,
            image: "",
          });
        }
      }
    }

    return tracks;
  }

  /**
   * Get the user's top albums (for %lastfm play albums).
   * @param {string} userId
   * @param {string} [period="overall"] - overall | 7day | 1month | 3month | 6month | 12month
   * @param {number} [limit=20]
   * @returns {Promise<Array<{ artist, name, url, playcount, image }>>}
   */
  async getTopAlbums(userId, period = "overall", limit = 20) {
    const user = await this.getUser(userId);
    if (!user) throw new Error("NOT_LINKED");

    const data = await apiCall(
      {
        method:   "user.gettopalbums",
        api_key:  this.apiKey,
        user:     user.username,
        period,
        limit,
      },
      this.apiSecret
    );

    return (data.topalbums?.album ?? []).map(a => ({
      artist:    a.artist?.name ?? "Unknown",
      name:      a.name,
      url:       a.url ?? "",
      playcount: a.playcount ?? 0,
      image:     a.image?.[2]?.["#text"] ?? a.image?.[1]?.["#text"] ?? "",
    }));
  }

  /**
   * Get the user's top artists.
   * @param {string} userId
   * @param {string} [period="overall"] - overall | 7day | 1month | 3month | 6month | 12month
   * @param {number} [limit=15]
   * @returns {Promise<Array<{ name: string, url: string, playcount: number, image: string }>>}
   */
  async getTopArtists(userId, period = "overall", limit = 15) {
    const user = await this.getUser(userId);
    if (!user) throw new Error("NOT_LINKED");

    const data = await apiCall(
      {
        method:   "user.gettopartists",
        api_key:  this.apiKey,
        user:     user.username,
        period,
        limit,
      },
      this.apiSecret
    );

    return (data.topartists?.artist ?? []).map(a => ({
      name:      a.name,
      url:       a.url ?? "",
      playcount: a.playcount ?? 0,
      image:     a.image?.[2]?.["#text"] ?? a.image?.[1]?.["#text"] ?? "",
    }));
  }

  /**
   * Fetch tracks from Last.fm by category and return search queries
   * that can be resolved by the player's worker (YouTube Music search).
   *
   * @param {string} userId
   * @param {"loved"|"top"|"recent"|"playlist"|"albums"} category
   * @param {object}  [options]
   * @param {string}  [options.period="overall"] - Period for top tracks (overall|7day|1month|3month|6month|12month)
   * @param {number}  [options.limit=20]         - Max tracks to return
   * @param {string|number} [options.playlistId] - Playlist ID or index (required when category="playlist")
   * @returns {Promise<{ username: string, tracks: Array<{ query: string, artist: string, name: string, url: string }> }>}
   */
  async getTracksForPlay(userId, category, options = {}) {
    const user = await this.getUser(userId);
    if (!user) throw new Error("NOT_LINKED");

    const limit = options.limit ?? 20;
    let tracks;

    switch (category) {
      case "loved":
        tracks = await this.getLovedTracks(userId, limit);
        break;
      case "top":
        tracks = await this.getTopTracks(userId, options.period ?? "overall", limit);
        break;
      case "recent":
        tracks = await this.getRecentTracks(userId, limit);
        tracks = tracks.filter(t => !t.now);
        break;
      case "playlist":
        if (!options.playlistId) throw new Error("Playlist ID required. Use the lastfm playlists command to see your playlists, then use the lastfm play playlist command with a number.");
        tracks = await this.getPlaylistTracks(userId, options.playlistId, limit);
        break;
      case "albums":
        const albums = await this.getTopAlbums(userId, options.period ?? "overall", limit);
        tracks = albums.map(a => ({
          artist: a.artist,
          name:   a.name,
          url:    a.url,
          query:  `${a.artist} ${a.name} album`,
          image:  a.image ?? "",
        }));
        return {
          username: user.username,
          tracks,
        };
      case "artists":
        const topArtistsList = await this.getTopArtists(userId, options.period ?? "overall", limit);
        const artistTrackResults = [];
        const artistConcurrency = 3;
        for (let ai = 0; ai < topArtistsList.length; ai += artistConcurrency) {
          const artistBatch = topArtistsList.slice(ai, ai + artistConcurrency);
          const artistResults = await Promise.allSettled(
            artistBatch.map(async (ar) => {
              try {
                const topTracks = await this.getArtistTopTracks(ar.name, 3);
                return topTracks.map(t => ({
                  artist: t.artist ?? ar.name,
                  name: t.name,
                  url: t.url,
                  query: `${t.name} ${t.artist ?? ar.name}`,
                  image: t.image ?? ar.image ?? "",
                }));
              } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
            })
          );
          for (const r of artistResults) {
            if (r.status === "fulfilled" && r.value) {
              artistTrackResults.push(...r.value);
            }
          }
        }
        return {
          username: user.username,
          tracks: artistTrackResults.slice(0, limit * 3),
        };
      default:
        throw new Error(`Unknown Last.fm category: ${category}. Use loved, top, recent, playlist, albums, or artists.`);
    }

    return {
      username: user.username,
      tracks: tracks.map(t => ({
        query:  this._buildPlayQuery(t.artist, t.name),
        artist: t.artist,
        name:   t.name,
        url:    t.url ?? "",
      })),
    };
  }

  /**
   * Get the total lifetime scrobbles across ALL linked Last.fm users.
   * Syncs each user's scrobble count from the Last.fm API, then sums them up.
   * Results are cached for 10 minutes to avoid hammering the API.
   *
   * @param {number} [concurrency=3] - How many users to sync in parallel
   * @returns {Promise<number>} Total scrobbles across all linked users
   */
  async getTotalScrobbles(concurrency = 3) {
    if (!this.enabled) return 0;

    if (this._totalScrobblesCache !== null && Date.now() < this._totalScrobblesCacheExpiry) {
      return this._totalScrobblesCache;
    }

    if (this._totalScrobblesInflight) return this._totalScrobblesInflight;

    this._totalScrobblesInflight = this._refreshTotalScrobbles(concurrency);
    try {
      return await this._totalScrobblesInflight;
    } finally {
      this._totalScrobblesInflight = null;
    }
  }

  /**
   * Internal: sync all users' scrobble counts from Last.fm and return the sum.
   */
  async _refreshTotalScrobbles(concurrency) {
    try {
      const pool = await this._getPool();

      const f = this._botIdFilter();
      const [rows] = await pool.execute(
        `SELECT user_id FROM lastfm_users WHERE 1=1${f.where}`,
        [...f.params]
      );

      if (!rows.length) {
        this._totalScrobblesCache = 0;
        this._totalScrobblesCacheExpiry = Date.now() + 10 * 60 * 1000;
        return 0;
      }

      const userIds = rows.map(r => r.user_id);

      for (let i = 0; i < userIds.length; i += concurrency) {
        const batch = userIds.slice(i, i + concurrency);
        await Promise.allSettled(batch.map(uid => this.syncUserScrobbleCount(uid)));
      }

      const [sumRows] = await pool.execute(
        `SELECT COALESCE(SUM(scrobble_count), 0) AS total FROM lastfm_users WHERE 1=1${f.where}`,
        [...f.params]
      );

      const total = Number(sumRows[0]?.total ?? 0);
      this._totalScrobblesCache = total;
      this._totalScrobblesCacheExpiry = Date.now() + 10 * 60 * 1000;

      logger.settings(`[LastFm] Total synced scrobbles across ${userIds.length} users: ${total}`);
      return total;
    } catch (err) {
      logger.warn(`[LastFm] _refreshTotalScrobbles failed: ${err.message}`);
      return this._totalScrobblesCache ?? 0;
    }
  }

  /**
   * Get the total number of linked Last.fm users.
   * @returns {Promise<number>}
   */
  async getLinkedUsersCount() {
    if (!this.enabled) return 0;
    try {
      const pool = await this._getPool();
      const f = this._botIdFilter();
      const [rows] = await pool.execute(
        `SELECT linked_users FROM lastfm_stats WHERE id = 1${f.where}`,
        [...f.params]
      );
      return Number(rows[0]?.linked_users ?? 0);
    } catch (e) {
        logger.warn("[LastFm] Error:", e?.message);
        return 0;
    }
  }

  /**
   * Get the scrobble leaderboard — top users by scrobble_count.
   * @param {number} [page=0] - 0-based page index
   * @param {number} [perPage=10] - Users per page
   * @returns {Promise<{ entries: Array<{ userId, username, scrobbleCount }>, totalUsers: number, page, perPage, totalPages: number }>}
   */
  async getLeaderboard(page = 0, perPage = 10) {
    if (!this.enabled) return { entries: [], totalUsers: 0, page: 0, perPage: 10, totalPages: 0 };

    const pool = await this._getPool();
    const f = this._botIdFilter();

    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS total FROM lastfm_users WHERE scrobble_count > 0${f.where}`,
      [...f.params]
    );
    const totalUsers = Number(countRows[0]?.total ?? 0);
    const totalPages = Math.max(1, Math.ceil(totalUsers / perPage));

    page = Math.max(0, Math.min(page, totalPages - 1));

    const offset = page * perPage;
    const [rows] = await pool.execute(
      `SELECT user_id, username, scrobble_count FROM lastfm_users WHERE scrobble_count > 0${f.where} ORDER BY scrobble_count DESC LIMIT ? OFFSET ?`,
      [...f.params, String(perPage), String(offset)]
    );

    const entries = rows.map(r => ({
      userId:       r.user_id,
      username:     r.username || r.user_id,
      scrobbleCount: Number(r.scrobble_count),
    }));

    return { entries, totalUsers, page, perPage, totalPages };
  }

  /**
   * Update a user's scrobble_count from their Last.fm profile (user.getinfo).
   * This syncs the local counter with Last.fm's actual count.
   * Called lazily when the leaderboard is viewed or the user checks their profile.
   * @param {string} userId
   * @returns {Promise<number>} The updated scrobble count
   */
  async syncUserScrobbleCount(userId) {
    if (!this.enabled) return 0;
    try {
      const info = await this.getUserInfo(userId);
      const playcount = Number(info.playcount ?? 0);
      const pool = await this._getPool();
      const f = this._botIdFilter();
      await pool.execute(
        `UPDATE lastfm_users SET scrobble_count = ? WHERE user_id = ?${f.where}`,
        [String(playcount), String(userId), ...f.params]
      );
      return playcount;
    } catch (e) {
        logger.warn("[LastFm] Error:", e?.message);
        return 0;
    }
  }

  /**
   * Get a user's Last.fm friends list.
   * @param {string} userId - The Fluxer user ID
   * @param {number} [limit=20] - Max friends to return
   * @returns {Promise<Array<object>>} Array of friend objects
   */
  async getUserFriends(userId, limit = 20) {
    if (!this.enabled) return [];
    const user = await this.getUser(userId);
    if (!user) return [];
    try {
      const data = await apiCall({
        method: "user.getfriends",
        api_key: this.apiKey,
        user: user.username,
        limit,
      }, this.apiSecret);
      return (data.friends?.user ?? []).map(f => ({
        name: f.name ?? "",
        url: f.url ?? "",
        image: f.image?.[2]?.["#text"] ?? f.image?.[1]?.["#text"] ?? "",
        realname: f.realname ?? "",
        country: f.country ?? "",
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  }

  /**
   * Get a user's weekly artist chart.
   * @param {string} userId - The Fluxer user ID
   * @param {number|null} [from=null] - Start timestamp
   * @param {number|null} [to=null] - End timestamp
   * @returns {Promise<Array<object>>} Array of artist objects
   */
  async getUserWeeklyArtistChart(userId, from = null, to = null) {
    if (!this.enabled) return [];
    const user = await this.getUser(userId);
    if (!user) return [];
    try {
      const params = {
        method: "user.getweeklyartistchart",
        api_key: this.apiKey,
        user: user.username,
      };
      if (from) params.from = from;
      if (to) params.to = to;
      const data = await apiCall(params, this.apiSecret);
      return (data.weeklyartistchart?.artist ?? []).map(a => ({
        name: a.name ?? "",
        url: a.url ?? "",
        playcount: Number(a.playcount ?? 0),
        image: a.image?.[2]?.["#text"] ?? a.image?.[1]?.["#text"] ?? "",
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  }

  /**
   * Get a user's weekly track chart.
   * @param {string} userId - The Fluxer user ID
   * @param {number|null} [from=null] - Start timestamp
   * @param {number|null} [to=null] - End timestamp
   * @returns {Promise<Array<object>>} Array of track objects
   */
  async getUserWeeklyTrackChart(userId, from = null, to = null) {
    if (!this.enabled) return [];
    const user = await this.getUser(userId);
    if (!user) return [];
    try {
      const params = {
        method: "user.getweeklytrackchart",
        api_key: this.apiKey,
        user: user.username,
      };
      if (from) params.from = from;
      if (to) params.to = to;
      const data = await apiCall(params, this.apiSecret);
      return (data.weeklytrackchart?.track ?? []).map(t => ({
        name: t.name ?? "",
        artist: t.artist?.["#text"] ?? t.artist ?? "",
        url: t.url ?? "",
        playcount: Number(t.playcount ?? 0),
        image: t.image?.[2]?.["#text"] ?? t.image?.[1]?.["#text"] ?? "",
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  }

  /**
   * Get a user's weekly album chart.
   * @param {string} userId - The Fluxer user ID
   * @param {number|null} [from=null] - Start timestamp
   * @param {number|null} [to=null] - End timestamp
   * @returns {Promise<Array<object>>} Array of album objects
   */
  async getUserWeeklyAlbumChart(userId, from = null, to = null) {
    if (!this.enabled) return [];
    const user = await this.getUser(userId);
    if (!user) return [];
    try {
      const params = {
        method: "user.getweeklyalbumchart",
        api_key: this.apiKey,
        user: user.username,
      };
      if (from) params.from = from;
      if (to) params.to = to;
      const data = await apiCall(params, this.apiSecret);
      return (data.weeklyalbumchart?.album ?? []).map(a => ({
        name: a.name ?? "",
        artist: a.artist?.["#text"] ?? a.artist ?? "",
        url: a.url ?? "",
        playcount: Number(a.playcount ?? 0),
        image: a.image?.[2]?.["#text"] ?? a.image?.[1]?.["#text"] ?? "",
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  }

  /**
   * Get top tags for an artist.
   * @param {string} artist - Artist name
   * @param {number} [limit=10] - Max tags to return
   * @returns {Promise<Array<object>>} Array of tag objects
   */
  async getArtistTopTags(artist, limit = 10) {
    if (!this.enabled) return [];
    try {
      const data = await apiCall({
        method: "artist.gettoptags",
        api_key: this.apiKey,
        artist,
        limit,
      }, this.apiSecret);
      return (data.toptags?.tag ?? []).map(t => ({
        name: t.name ?? "",
        url: t.url ?? "",
        count: Number(t.count ?? 0),
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  }

  /**
   * Get top tags for an album.
   * @param {string} artist - Artist name
   * @param {string} album - Album name
   * @param {number} [limit=10] - Max tags to return
   * @returns {Promise<Array<object>>} Array of tag objects
   */
  async getAlbumTopTags(artist, album, limit = 10) {
    if (!this.enabled) return [];
    try {
      const data = await apiCall({
        method: "album.gettoptags",
        api_key: this.apiKey,
        artist,
        album,
        limit,
      }, this.apiSecret);
      return (data.toptags?.tag ?? []).map(t => ({
        name: t.name ?? "",
        url: t.url ?? "",
        count: Number(t.count ?? 0),
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  }

  /**
   * Get top tags for a track.
   * @param {string} artist - Artist name
   * @param {string} track - Track name
   * @param {number} [limit=10] - Max tags to return
   * @returns {Promise<Array<object>>} Array of tag objects
   */
  async getTrackTopTags(artist, track, limit = 10) {
    if (!this.enabled) return [];
    try {
      const data = await apiCall({
        method: "track.gettoptags",
        api_key: this.apiKey,
        artist,
        track,
        limit,
      }, this.apiSecret);
      return (data.toptags?.tag ?? []).map(t => ({
        name: t.name ?? "",
        url: t.url ?? "",
        count: Number(t.count ?? 0),
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  }

  /**
   * Get top albums for a tag.
   * @param {string} tag - Tag name
   * @param {number} [limit=10] - Max albums to return
   * @returns {Promise<Array<object>>} Array of album objects
   */
  async getTagTopAlbums(tag, limit = 10) {
    if (!this.enabled) return [];
    try {
      const data = await apiCall({
        method: "tag.gettopalbums",
        api_key: this.apiKey,
        tag,
        limit,
      }, this.apiSecret);
      return (data.albums?.album ?? []).map(a => ({
        name: a.name ?? "",
        artist: a.artist?.name ?? "Unknown",
        url: a.url ?? "",
        playcount: Number(a.playcount ?? 0),
        image: a.image?.[2]?.["#text"] ?? a.image?.[1]?.["#text"] ?? "",
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  }

  /**
   * Get top artists by country.
   * @param {string} country - Country name
   * @param {number} [limit=10] - Max artists to return
   * @returns {Promise<Array<object>>} Array of artist objects
   */
  async getGeoTopArtists(country, limit = 10) {
    if (!this.enabled) return [];
    try {
      const data = await apiCall({
        method: "geo.gettopartists",
        api_key: this.apiKey,
        country,
        limit,
      }, this.apiSecret);
      return (data.topartists?.artist ?? []).map(a => ({
        name: a.name ?? "",
        url: a.url ?? "",
        listeners: Number(a.listeners ?? 0),
        image: a.image?.[2]?.["#text"] ?? a.image?.[1]?.["#text"] ?? "",
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  }

  /**
   * Get top tracks by country.
   * @param {string} country - Country name
   * @param {number} [limit=10] - Max tracks to return
   * @returns {Promise<Array<object>>} Array of track objects
   */
  async getGeoTopTracks(country, limit = 10) {
    if (!this.enabled) return [];
    try {
      const data = await apiCall({
        method: "geo.gettoptracks",
        api_key: this.apiKey,
        country,
        limit,
      }, this.apiSecret);
      return (data.tracks?.track ?? []).map(t => ({
        name: t.name ?? "",
        artist: t.artist?.name ?? "Unknown",
        url: t.url ?? "",
        listeners: Number(t.listeners ?? 0),
        image: t.image?.[2]?.["#text"] ?? t.image?.[1]?.["#text"] ?? "",
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  }

  /**
   * Get global trending tracks from Last.fm charts.
   * @param {number} [limit=10] - Max tracks to return
   * @returns {Promise<Array<object>>} Array of trending track objects
   */
  async getChartTopTracks(limit = 10) {
    if (!this.enabled) return [];
    try {
      const data = await apiCall({
        method: "chart.gettoptracks",
        api_key: this.apiKey,
        limit,
      }, this.apiSecret);
      return (data.tracks?.track ?? []).map(t => ({
        name: t.name ?? "",
        artist: t.artist?.name ?? "Unknown",
        url: t.url ?? "",
        listeners: Number(t.listeners ?? 0),
        playcount: Number(t.playcount ?? 0),
        image: t.image?.[2]?.["#text"] ?? t.image?.[1]?.["#text"] ?? "",
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  }

  /**
   * Get global trending artists from Last.fm charts.
   * @param {number} [limit=10] - Max artists to return
   * @returns {Promise<Array<object>>} Array of trending artist objects
   */
  async getChartTopArtists(limit = 10) {
    if (!this.enabled) return [];
    try {
      const data = await apiCall({
        method: "chart.gettopartists",
        api_key: this.apiKey,
        limit,
      }, this.apiSecret);
      return (data.artists?.artist ?? []).map(a => ({
        name: a.name ?? "",
        url: a.url ?? "",
        listeners: Number(a.listeners ?? 0),
        playcount: Number(a.playcount ?? 0),
        image: a.image?.[2]?.["#text"] ?? a.image?.[1]?.["#text"] ?? "",
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  }

  /**
   * Get play counts for a specific track across multiple users ("who knows track").
   * @param {string} artist - Artist name
   * @param {string} track - Track name
   * @param {Array<string>} userIds - Array of Fluxer user IDs to check
   * @returns {Promise<Array<{ userId: string, username: string, playcount: number }>>}
   */
  async getWhoKnowsTrack(artist, track, userIds) {
    if (!this.enabled) return [];
    if (!Array.isArray(userIds) || !userIds.length) return [];

    const concurrency = 5;
    const results = [];

    for (let i = 0; i < userIds.length; i += concurrency) {
      const batch = userIds.slice(i, i + concurrency);

      const batchResults = await Promise.allSettled(
        batch.map(async (uid) => {
          const user = await this.getUser(uid);
          if (!user) return null;

          try {
            const info = await this.getTrackInfo(artist, track, uid);
            const playcount = Number(info?.userplaycount ?? 0);
            return {
              userId: uid,
              username: user.username,
              playcount,
            };
          } catch (e) {
              logger.warn("[LastFm] Error:", e?.message);
              return {
              userId: uid,
              username: user.username,
              playcount: 0,
            };
          }
        })
      );

      for (const r of batchResults) {
        if (r.status === "fulfilled" && r.value && r.value.playcount > 0) {
          results.push(r.value);
        }
      }
    }

    results.sort((a, b) => b.playcount - a.playcount);
    return results;
  }

  /**
   * Get play counts for a specific album across multiple users ("who knows album").
   * @param {string} artist - Artist name
   * @param {string} album - Album name
   * @param {Array<string>} userIds - Array of Fluxer user IDs to check
   * @returns {Promise<Array<{ userId: string, username: string, playcount: number }>>}
   */
  async getWhoKnowsAlbum(artist, album, userIds) {
    if (!this.enabled) return [];
    if (!Array.isArray(userIds) || !userIds.length) return [];

    const concurrency = 5;
    const results = [];

    for (let i = 0; i < userIds.length; i += concurrency) {
      const batch = userIds.slice(i, i + concurrency);

      const batchResults = await Promise.allSettled(
        batch.map(async (uid) => {
          const user = await this.getUser(uid);
          if (!user) return null;

          try {
            const info = await this.getAlbumInfo(artist, album, uid);
            const playcount = Number(info?.userplaycount ?? 0);
            return {
              userId: uid,
              username: user.username,
              playcount,
            };
          } catch (e) {
              logger.warn("[LastFm] Error:", e?.message);
              return {
              userId: uid,
              username: user.username,
              playcount: 0,
            };
          }
        })
      );

      for (const r of batchResults) {
        if (r.status === "fulfilled" && r.value && r.value.playcount > 0) {
          results.push(r.value);
        }
      }
    }

    results.sort((a, b) => b.playcount - a.playcount);
    return results;
  }

  /**
   * Find users with similar top artists (affinity).
   * For each pair of users, compute overlap of their top artists.
   * @param {Array<string>} userIds - Array of Fluxer user IDs
   * @param {number} [limit=10] - Max results to return
   * @returns {Promise<Array<object>>} Array of affinity results
   */
  async getAffinity(userIds, limit = 10) {
    if (!this.enabled) return [];
    if (!Array.isArray(userIds) || userIds.length < 2) return [];

    const userArtistsMap = new Map();
    const concurrency = 5;

    for (let i = 0; i < userIds.length; i += concurrency) {
      const batch = userIds.slice(i, i + concurrency);
      const results = await Promise.allSettled(
        batch.map(async (uid) => {
          const user = await this.getUser(uid);
          if (!user) return null;
          try {
            const artists = await this.getTopArtists(uid, "overall", 50);
            return { uid, username: user.username, artists };
          } catch (e) {
              logger.warn("[LastFm] Error:", e?.message);
              return null;
          }
        })
      );
      for (const r of results) {
        if (r.status === "fulfilled" && r.value) {
          userArtistsMap.set(r.value.uid, r.value);
        }
      }
    }

    const entries = [...userArtistsMap.values()];
    const affinityResults = [];

    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i];
        const b = entries[j];
        const namesA = new Set(a.artists.map(ar => ar.name.toLowerCase()));
        const namesB = new Set(b.artists.map(ar => ar.name.toLowerCase()));
        const common = [...namesA].filter(n => namesB.has(n));
        if (common.length > 0) {
          const commonArtists = a.artists
            .filter(ar => namesB.has(ar.name.toLowerCase()))
            .map(ar => ({ name: ar.name, url: ar.url, playcount: ar.playcount }));
          affinityResults.push({
            users: [a.username, b.username],
            userIds: [a.uid, b.uid],
            matchCount: common.length,
            commonArtists,
          });
        }
      }
    }

    affinityResults.sort((a, b) => b.matchCount - a.matchCount);
    return affinityResults.slice(0, limit);
  }

  /**
   * Get artist crowns for a user — artists where they are the #1 listener in the server.
   * @param {string} userId - The Fluxer user ID
   * @param {Array<string>} userIds - Array of Fluxer user IDs in the server
   * @returns {Promise<Array<object>>} Array of crown objects
   */
  async getCrowns(userId, userIds) {
    if (!this.enabled) return [];
    const user = await this.getUser(userId);
    if (!user) return [];
    try {
      const topArtists = await this.getTopArtists(userId, "overall", 50);
      const crowns = [];
      const concurrency = 3;

      for (let i = 0; i < topArtists.length; i += concurrency) {
        const batch = topArtists.slice(i, i + concurrency);
        const results = await Promise.allSettled(
          batch.map(async (artist) => {
            const listeners = await this.getWhoKnows(artist.name, userIds);
            if (listeners.length > 0 && listeners[0].userId === String(userId)) {
              return {
                artist: artist.name,
                artistUrl: artist.url,
                userPlaycount: artist.playcount,
                nextBest: listeners.length > 1 ? listeners[1] : null,
                image: artist.image ?? "",
              };
            }
            return null;
          })
        );
        for (const r of results) {
          if (r.status === "fulfilled" && r.value) crowns.push(r.value);
        }
      }

      crowns.sort((a, b) => b.userPlaycount - a.userPlaycount);
      return crowns;
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  }

  _assertEnabled() {
    if (!this.enabled) throw new Error("Last.fm integration is not configured (missing apiKey/apiSecret).");
  }

  /**
   * Increment per-user scrobble_count after a successful scrobble.
   * Non-blocking — fire-and-forget.
   */
  _incrementScrobbleCount(userId) {
    if (!userId) return;
    const f = this._botIdFilter();
    this._getPool().then(pool => {
      pool.execute(
        `UPDATE lastfm_users SET scrobble_count = scrobble_count + 1 WHERE user_id = ?${f.where}`,
        [String(userId), ...f.params]
      ).catch(() => {});
    }).catch(() => {});
  }

  _buildPlayQuery(artist, title) {
    const cleanArtist = String(artist ?? "").trim();
    const cleanTitle = String(title ?? "").trim();
    return [cleanTitle, cleanArtist].filter(Boolean).join(" ");
  }

  _extractArtist(track) {
    const preservedArtist = track?.lastfm?.artist
      ?? track?.requestedArtist
      ?? track?.artist;
    if (preservedArtist) return preservedArtist;

    return track.artists?.[0]?.name
      ?? track.author?.name
      ?? "Unknown Artist";
  }

  _extractTitle(track) {
    return track?.lastfm?.name
      ?? track?.requestedTitle
      ?? track.title
      ?? track.name
      ?? "Unknown Track";
  }

  _extractDurationSec(track) {
    if (!track.duration) return "";
    if (typeof track.duration === "object" && track.duration.seconds) return track.duration.seconds;
    if (typeof track.duration === "number") return Math.round(track.duration / 1000);
    if (typeof track.duration === "string") {
      const m = track.duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
      if (m) return ((+m[1] || 0) * 3600) + ((+m[2] || 0) * 60) + (+m[3] || 0);
    }
    return "";
  }

  /**
   * Should this track be scrobbled based on play duration?
   * Last.fm rule: scrobble if played for >= 50% of track duration OR >= 4 minutes,
   * and the track must be >= 30 seconds long.
   */
  shouldScrobble(track, playedMs) {
    const durationMs = typeof track.duration === "object" && track.duration.seconds
      ? track.duration.seconds * 1000
      : typeof track.duration === "number"
        ? track.duration
        : null;

    if (!durationMs || durationMs < 30_000) return false;

    const normalizedTitle = normalizeTrackText(this._extractTitle(track));
    const normalizedArtist = normalizeTrackText(this._extractArtist(track));
    if (!normalizedTitle || !normalizedArtist) return false;

    const thresholdMs = Math.min(durationMs * this.scrobbleThreshold, this.scrobbleMinMs);
    return playedMs >= thresholdMs;
  }
}
