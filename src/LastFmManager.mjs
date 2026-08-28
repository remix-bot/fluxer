/** @module src/LastFmManager @description Last.fm API integration for scrobbling, now-playing updates, loved tracks, and user session management with MySQL persistence. */

import crypto from "node:crypto";
import { logger } from "./constants/Logger.mjs";
import { Utils } from "./Utils.mjs";

const BASE_URL = "https://ws.audioscrobbler.com/2.0/";

/** @private @param {string} value @returns {string} */
function normalizeTrackText(value) {
  return Utils.normalizeText(value);
}

/** @private Build an API signature per Last.fm auth spec. @param {object} params @param {string} apiSecret @returns {string} MD5 hex digest. */
function buildSignature(params, apiSecret) {
  const sorted = Object.keys(params).sort();
  const str = sorted.map(k => k + params[k]).join("");
  return crypto.createHash("md5").update(str + apiSecret).digest("hex");
}

/** @private Make an authenticated Last.fm API call. @async @param {object} params @param {string} apiSecret @param {boolean} [post=false] @returns {Promise<object>} @throws {Error} On HTTP or Last.fm API error. */
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

/** @class LastFmManager @description Manages Last.fm user sessions, scrobbling, loved tracks, and top/recent track queries with MySQL persistence. */
export class LastFmManager {
  /** @param {object} config @param {string} config.apiKey @param {string} config.apiSecret @param {boolean} [config.enabled] @param {number} [config.scrobbleThreshold] @param {number} [config.scrobbleMinMs] @param {object} mysqlConfig */
  constructor(config, mysqlConfig) {
    this.apiKey    = config?.apiKey ?? "";
    this.apiSecret = config?.apiSecret ?? "";
    this.enabled   = config?.enabled !== false && !!(this.apiKey && this.apiSecret);
    this.scrobbleThreshold = config?.scrobbleThreshold ?? 0.5;
    this.scrobbleMinMs     = config?.scrobbleMinMs ?? 240_000;

    this._mysqlConfig = mysqlConfig;
    this._pool = null;

    this.botId = null;
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

  /** @async Set the bot ID for multi-bot isolation. @param {string} id */
  async setBotId(id) {
    const changed = this.botId !== id;
    this.botId = id;
    if (changed) {
      await this._ensureBotIdColumn();
      this._userCache.clear();
    }
  }

  /** @private @async Ensure the bot_id column exists and is part of the primary key. */
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

  /** @private @returns {{where: string, params: Array}} SQL filter fragment for bot_id. */
  _botIdFilter() {
    if (!this.botId || !this._hasBotIdColumn) return { where: "", params: [] };
    return { where: " AND bot_id = ?", params: [String(this.botId)] };
  }

  /** @private @async Get or create the MySQL connection pool. @returns {Promise<object>} */
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

  /** @private @async Create the lastfm_users and lastfm_stats tables if they don't exist. */
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

  /** @async Get a user's Last.fm session from cache or DB. @param {string} userId @returns {Promise<{sessionKey: string, username: string, scrobbleEnabled: boolean}|null>} */
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

  /** @async Save or update a user's Last.fm session. @param {string} userId @param {string} sessionKey @param {string} username @returns {Promise<{sessionKey: string, username: string, scrobbleEnabled: boolean}>} */
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
      logger.warn("[LastFm] Stats update warning:", e?.message);
    }

    return data;
  }

  /** @async Remove a user's Last.fm session from cache and DB. @param {string} userId */
  async removeUser(userId) {
    const pool = await this._getPool();
    const f = this._botIdFilter();
    await pool.execute(`DELETE FROM lastfm_users WHERE user_id = ?${f.where}`, [String(userId), ...f.params]);
    this._userCache.delete(userId);
  }

  /** @async Toggle scrobbling for a user. @param {string} userId @param {boolean} enabled */
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

  /** @async Request a Last.fm auth token. @returns {Promise<string>} The auth token. @throws {Error} If Last.fm is not enabled. */
  async getAuthToken() {
    this._assertEnabled();
    const data = await apiCall(
      { method: "auth.gettoken", api_key: this.apiKey },
      this.apiSecret
    );
    return data.token;
  }

  /** Build the Last.fm auth URL for user authorization. @param {string} token @returns {string} */
  getAuthUrl(token) {
    return `https://www.last.fm/api/auth/?api_key=${this.apiKey}&token=${token}`;
  }

  /** @async Exchange an auth token for a session. @param {string} token @returns {Promise<object>} The session object with key and name. @throws {Error} If Last.fm is not enabled. */
  async getSession(token) {
    this._assertEnabled();
    const data = await apiCall(
      { method: "auth.getsession", api_key: this.apiKey, token },
      this.apiSecret
    );
    return data.session;
  }

  /** @async Send a now-playing update to Last.fm for a user. @param {string} userId @param {object} track @param {string} track.title @param {string} [track.album] @param {number} [track.trackNumber] */
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

  /** @async Scrobble a track for a user. @param {string} userId @param {object} track @param {number} startedAtMs @param {string} track.title @param {string} [track.album] @param {number} [track.trackNumber] */
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

  /** @async Get a user's loved tracks. @param {string} userId @param {number} [limit=20] @returns {Promise<Array<{artist: string, name: string, url: string, image: string}>>} @throws {Error} If user not linked. */
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

  /** @async Get a user's top tracks. @param {string} userId @param {string} [period="overall"] @param {number} [limit=20] @returns {Promise<Array<{artist: string, name: string, url: string, playcount: number, image: string}>>} @throws {Error} If user not linked. */
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

  /** @async Get a user's recent tracks. @param {string} userId @param {number} [limit=20] @returns {Promise<Array<{artist: string, name: string, url: string, now: boolean, image: string}>>} @throws {Error} If user not linked. */
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

  /** @async Get track info from Last.fm. @param {string} artist @param {string} track @param {string} [userId] @returns {Promise<object|null>} Track info object or null. */
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

  /** @async Love a track on Last.fm. @param {string} userId @param {string} artist @param {string} track @throws {Error} If user not linked. */
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

  /** @async Unlove a track on Last.fm. @param {string} userId @param {string} artist @param {string} track @throws {Error} If user not linked. */
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

  /** @async Search for tracks on Last.fm and score results by relevance. @param {string} query @param {number} [limit=10] @returns {Promise<Array<{artist: string, name: string, url: string, image: string}>|null>} */
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
   * Get similar tracks for a given artist and track from Last.fm.
   * @async
   * @param {string} artist - The artist name.
   * @param {string} track - The track name.
   * @param {number} [limit=5] - Maximum number of results.
   * @returns {Promise<Array<{artist: string, name: string, url: string, match: number}>>} Filtered similar tracks (match > 0.1).
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
   * @async
   * @param {string} artist - The artist name.
   * @param {string|null} [userId] - Optional user ID to include user playcount.
   * @returns {Promise<object|null>} Artist info object with name, url, image, tags, bio, stats, similar, and userplaycount, or null.
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
   * @async
   * @param {string} artist - The artist name.
   * @param {string} album - The album name.
   * @param {string|null} [userId] - Optional user ID to include user playcount.
   * @returns {Promise<object|null>} Album info object with name, artist, url, image, tags, tracks, and userplaycount, or null.
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
   * Get top tracks for an artist from Last.fm.
   * @async
   * @param {string} artist - The artist name.
   * @param {number} [limit=10] - Maximum number of results.
   * @returns {Promise<Array<{artist: string, name: string, url: string, playcount: number, image: string}>>} Top tracks.
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
   * Get top albums for an artist from Last.fm.
   * @async
   * @param {string} artist - The artist name.
   * @param {number} [limit=10] - Maximum number of results.
   * @returns {Promise<Array<{name: string, artist: string, url: string, playcount: number, image: string}>>} Top albums.
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
   * Get similar artists for a given artist from Last.fm.
   * @async
   * @param {string} artist - The artist name.
   * @param {number} [limit=10] - Maximum number of results.
   * @returns {Promise<Array<{name: string, url: string, image: string, match: number}>>} Similar artists.
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
   * @async
   * @param {string} userId - The Discord user ID.
   * @param {number} [limit=20] - Maximum number of results.
   * @returns {Promise<Array<{name: string, url: string, count: number}>>} Top tags.
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
   * Get information about a specific tag from Last.fm.
   * @async
   * @param {string} tag - The tag name.
   * @returns {Promise<object|null>} Tag info with name, url, reach, count, and summary, or null.
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
   * @async
   * @param {string} tag - The tag name.
   * @param {number} [limit=10] - Maximum number of results.
   * @returns {Promise<Array<{artist: string, name: string, url: string, playcount: number, image: string}>>} Tag's top tracks.
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
   * @async
   * @param {string} tag - The tag name.
   * @param {number} [limit=10] - Maximum number of results.
   * @returns {Promise<Array<{name: string, url: string, playcount: number, image: string}>>} Tag's top artists.
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
   * Get who knows an artist among a list of users, ranked by playcount.
   * @async
   * @param {string} artist - The artist name.
   * @param {Array<string>} userIds - Array of Discord user IDs.
   * @returns {Promise<Array<{userId: string, username: string, playcount: number}>>} Users who know the artist, sorted by playcount descending.
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
   * Compare two users' top artists and compute a match percentage.
   * @async
   * @param {string} userId1 - First Discord user ID.
   * @param {string} userId2 - Second Discord user ID.
   * @returns {Promise<object|null>} Comparison result with user1, user2, commonArtists, and matchPercentage, or null.
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
   * Get the list of weekly chart periods for a user.
   * @async
   * @param {string} userId - The Discord user ID.
   * @returns {Promise<Array<{from: number, to: number}>>} Weekly chart periods with Unix timestamps.
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
   * Search for artists on Last.fm.
   * @async
   * @param {string} query - The search query.
   * @param {number} [limit=10] - Maximum number of results.
   * @returns {Promise<Array<{name: string, url: string, image: string, listeners: number}>>} Matching artists.
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
   * Search for albums on Last.fm.
   * @async
   * @param {string} query - The search query.
   * @param {number} [limit=10] - Maximum number of results.
   * @returns {Promise<Array<{name: string, artist: string, url: string, image: string}>>} Matching albums.
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
   * Parse a Last.fm music URL into artist, track, and album components.
   * @param {string} url - The Last.fm URL to parse.
   * @returns {object|null} Parsed components { artist, track, album, url } or null if invalid.
   */
  parseLastFmUrl(url) {
    return parseLastFmUrl(url);
  }

  /**
   * Check whether a string is a valid Last.fm music URL.
   * @param {string} str - String to check.
   * @returns {boolean} True if the string is a Last.fm music URL.
   */
  isLastFmUrl(str) {
    return isLastFmUrl(str);
  }

  /**
   * Get a user's Last.fm profile info.
   * @async
   * @param {string} userId - The Discord user ID.
   * @returns {Promise<object>} The Last.fm user object.
   * @throws {Error} If user is not linked.
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
   * Get a user's Last.fm playlists by scraping their profile page.
   * @async
   * @param {string} userId - The Discord user ID.
   * @returns {Promise<Array<{id: string, title: string, url: string, trackCount: number}>>} User's playlists.
   * @throws {Error} If user is not linked or fetch fails.
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
   * Get tracks from a user's Last.fm playlist by scraping the playlist page.
   * @async
   * @param {string} userId - The Discord user ID.
   * @param {string|number} playlistId - Playlist number (1-based index) or URL.
   * @param {number} [limit=50] - Maximum number of tracks.
   * @returns {Promise<Array<{artist: string, name: string, url: string, image: string}>>} Playlist tracks.
   * @throws {Error} If user is not linked or playlist not found.
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
   * Get a user's top albums from Last.fm.
   * @async
   * @param {string} userId - The Discord user ID.
   * @param {string} [period="overall"] - Time period (7day, 1month, 3month, 6month, 12month, overall).
   * @param {number} [limit=20] - Maximum number of results.
   * @returns {Promise<Array<{artist: string, name: string, url: string, playcount: number, image: string}>>} Top albums.
   * @throws {Error} If user is not linked.
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
   * Get a user's top artists from Last.fm.
   * @async
   * @param {string} userId - The Discord user ID.
   * @param {string} [period="overall"] - Time period (7day, 1month, 3month, 6month, 12month, overall).
   * @param {number} [limit=15] - Maximum number of results.
   * @returns {Promise<Array<{name: string, url: string, playcount: number, image: string}>>} Top artists.
   * @throws {Error} If user is not linked.
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
   * Get tracks from a user's Last.fm data for playback based on category.
   * @async
   * @param {string} userId - The Discord user ID.
   * @param {string} category - One of: loved, top, recent, playlist, albums, artists.
   * @param {object} [options={}] - Additional options.
   * @param {number} [options.limit] - Maximum number of tracks.
   * @param {string} [options.period] - Time period for top/albums/artists categories.
   * @param {string|number} [options.playlistId] - Playlist ID (required for playlist category).
   * @returns {Promise<{username: string, tracks: Array<{query: string, artist: string, name: string, url: string, image?: string}>}>} Tracks ready for playback.
   * @throws {Error} If user is not linked or category is unknown.
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
   * Get total scrobble count across all linked users (cached for 10 minutes).
   * @async
   * @param {number} [concurrency=3] - Number of concurrent user syncs.
   * @returns {Promise<number>} Total scrobble count.
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

  /** @private @async Sync all users' scrobble counts from Last.fm and cache the total. @param {number} concurrency - Concurrent sync batch size. @returns {Promise<number>} Fresh total scrobble count. */
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
   * Get the number of linked Last.fm users from the stats table.
   * @async
   * @returns {Promise<number>} Linked user count.
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
   * Get the scrobble leaderboard with pagination.
   * @async
   * @param {number} [page=0] - Zero-based page index.
   * @param {number} [perPage=10] - Number of entries per page.
   * @returns {Promise<{entries: Array<{userId: string, username: string, scrobbleCount: number}>, totalUsers: number, page: number, perPage: number, totalPages: number}>} Leaderboard data.
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
   * Sync a user's scrobble count from Last.fm to the local database.
   * @async
   * @param {string} userId - The Discord user ID.
   * @returns {Promise<number>} The synced scrobble count.
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
   * @async
   * @param {string} userId - The Discord user ID.
   * @param {number} [limit=20] - Maximum number of results.
   * @returns {Promise<Array<{name: string, url: string, image: string, realname: string, country: string}>>} Friends list.
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
   * Get a user's weekly artist chart for a specific time range.
   * @async
   * @param {string} userId - The Discord user ID.
   * @param {number|null} [from] - Start Unix timestamp.
   * @param {number|null} [to] - End Unix timestamp.
   * @returns {Promise<Array<{name: string, url: string, playcount: number, image: string}>>} Weekly artist chart.
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
   * Get a user's weekly track chart for a specific time range.
   * @async
   * @param {string} userId - The Discord user ID.
   * @param {number|null} [from] - Start Unix timestamp.
   * @param {number|null} [to] - End Unix timestamp.
   * @returns {Promise<Array<{name: string, artist: string, url: string, playcount: number, image: string}>>} Weekly track chart.
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
   * Get a user's weekly album chart for a specific time range.
   * @async
   * @param {string} userId - The Discord user ID.
   * @param {number|null} [from] - Start Unix timestamp.
   * @param {number|null} [to] - End Unix timestamp.
   * @returns {Promise<Array<{name: string, artist: string, url: string, playcount: number, image: string}>>} Weekly album chart.
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
   * Get top tags for an artist from Last.fm.
   * @async
   * @param {string} artist - The artist name.
   * @param {number} [limit=10] - Maximum number of results.
   * @returns {Promise<Array<{name: string, url: string, count: number}>>} Artist's top tags.
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
   * Get top tags for an album from Last.fm.
   * @async
   * @param {string} artist - The artist name.
   * @param {string} album - The album name.
   * @param {number} [limit=10] - Maximum number of results.
   * @returns {Promise<Array<{name: string, url: string, count: number}>>} Album's top tags.
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
   * Get top tags for a track from Last.fm.
   * @async
   * @param {string} artist - The artist name.
   * @param {string} track - The track name.
   * @param {number} [limit=10] - Maximum number of results.
   * @returns {Promise<Array<{name: string, url: string, count: number}>>} Track's top tags.
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
   * Get top albums for a tag from Last.fm.
   * @async
   * @param {string} tag - The tag name.
   * @param {number} [limit=10] - Maximum number of results.
   * @returns {Promise<Array<{name: string, artist: string, url: string, playcount: number, image: string}>>} Tag's top albums.
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
   * Get top artists for a country from Last.fm.
   * @async
   * @param {string} country - The country name.
   * @param {number} [limit=10] - Maximum number of results.
   * @returns {Promise<Array<{name: string, url: string, listeners: number, image: string}>>} Country's top artists.
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
   * Get top tracks for a country from Last.fm.
   * @async
   * @param {string} country - The country name.
   * @param {number} [limit=10] - Maximum number of results.
   * @returns {Promise<Array<{name: string, artist: string, url: string, listeners: number, image: string}>>} Country's top tracks.
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
   * Get the global top tracks chart from Last.fm.
   * @async
   * @param {number} [limit=10] - Maximum number of results.
   * @returns {Promise<Array<{name: string, artist: string, url: string, listeners: number, playcount: number, image: string}>>} Global top tracks.
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
   * Get the global top artists chart from Last.fm.
   * @async
   * @param {number} [limit=10] - Maximum number of results.
   * @returns {Promise<Array<{name: string, url: string, listeners: number, playcount: number, image: string}>>} Global top artists.
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
   * Get who knows a specific track among a list of users, ranked by playcount.
   * @async
   * @param {string} artist - The artist name.
   * @param {string} track - The track name.
   * @param {Array<string>} userIds - Array of Discord user IDs.
   * @returns {Promise<Array<{userId: string, username: string, playcount: number}>>} Users who know the track, sorted by playcount descending.
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
   * Get who knows a specific album among a list of users, ranked by playcount.
   * @async
   * @param {string} artist - The artist name.
   * @param {string} album - The album name.
   * @param {Array<string>} userIds - Array of Discord user IDs.
   * @returns {Promise<Array<{userId: string, username: string, playcount: number}>>} Users who know the album, sorted by playcount descending.
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
   * Compute affinity (common artists) between multiple users.
   * @async
   * @param {Array<string>} userIds - Array of Discord user IDs (minimum 2).
   * @param {number} [limit=10] - Maximum number of affinity pairs to return.
   * @returns {Promise<Array<{users: string[], userIds: string[], matchCount: number, commonArtists: Array<{name: string, url: string, playcount: number}>}>>} Affinity pairs sorted by match count descending.
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
   * Get a user's "crowns" — artists where they have the highest playcount among the given users.
   * @async
   * @param {string} userId - The Discord user ID to check crowns for.
   * @param {Array<string>} userIds - Array of all Discord user IDs to compare against.
   * @returns {Promise<Array<{artist: string, artistUrl: string, userPlaycount: number, nextBest: object|null, image: string}>>} Crown entries sorted by user playcount descending.
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

  /** @private Throw if Last.fm integration is not enabled/configured. @throws {Error} If apiKey or apiSecret is missing. */
  _assertEnabled() {
    if (!this.enabled) throw new Error("Last.fm integration is not configured (missing apiKey/apiSecret).");
  }

  /** @private Increment a user's scrobble_count in the database by 1 (fire-and-forget). @param {string} userId - The Discord user ID. */
  _incrementScrobbleCount(userId) {
    if (!userId) return;
    const f = this._botIdFilter();
    this._getPool().then(pool => {
      pool.execute(
        `UPDATE lastfm_users SET scrobble_count = scrobble_count + 1 WHERE user_id = ?${f.where}`,
        [String(userId), ...f.params]
      ).catch(e => { logger.warn("[LastFm] scrobble_count increment failed:", e?.message); });
    }).catch(e => { logger.warn("[LastFm] scrobble_count pool acquire failed:", e?.message); });
  }

  /** @private Build a search query string from artist and title for playback. @param {string} artist - The artist name. @param {string} title - The track title. @returns {string} Combined search query. */
  _buildPlayQuery(artist, title) {
    const cleanArtist = String(artist ?? "").trim();
    const cleanTitle = String(title ?? "").trim();
    return [cleanTitle, cleanArtist].filter(Boolean).join(" ");
  }

  /** @private Extract the best artist name from a track object, checking multiple possible fields. @param {object} track - Track object. @returns {string} The artist name. */
  _extractArtist(track) {
    const preservedArtist = track?.lastfm?.artist
      ?? track?.requestedArtist
      ?? track?.artist;
    if (preservedArtist) return preservedArtist;

    return track.artists?.[0]?.name
      ?? track.author?.name
      ?? "Unknown Artist";
  }

  /** @private Extract the best track title from a track object, checking multiple possible fields. @param {object} track - Track object. @returns {string} The track title. */
  _extractTitle(track) {
    return track?.lastfm?.name
      ?? track?.requestedTitle
      ?? track.title
      ?? track.name
      ?? "Unknown Track";
  }

  /** @private Extract the duration in seconds from a track object, supporting number (ms), object with .seconds, ISO 8601, or plain seconds. @param {object} track - Track object. @returns {string|number} Duration in seconds, or empty string if unavailable. */
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
   * Determine whether a track should be scrobbled based on playback time and duration.
   * @param {object} track - Track object with duration and title/artist info.
   * @param {number} playedMs - How many milliseconds the track has been playing.
   * @returns {boolean} True if the track meets the scrobble threshold.
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

/**
 * Parse a Last.fm music URL into its components.
 * @param {string} url - The Last.fm URL to parse.
 * @returns {{artist: string, track: string|null, album: string|null, url: string}|null} Parsed components, or null if not a valid Last.fm music URL.
 */
export function parseLastFmUrl(url) {
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
    logger.warn("[LastFm] parseLastFmUrl error:", e?.message);
    return null;
  }
}

/**
 * Check whether a string is a valid Last.fm music URL.
 * @param {string} str - String to check.
 * @returns {boolean} True if the string is a Last.fm URL with a /music/ path.
 */
export function isLastFmUrl(str) {
  if (!str || typeof str !== "string") return false;
  try {
    const u = new URL(str);
    return /^(?:www\.)?last\.fm$/i.test(u.hostname) && /^\/music\//i.test(u.pathname);
  } catch (e) {
    return false;
  }
}
