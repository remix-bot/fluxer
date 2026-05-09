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

const BASE_URL = "https://ws.audioscrobbler.com/2.0/";

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Build the API signature required by Last.fm for authenticated calls.
 * See: https://www.last.fm/api/authspec#_8-signing-calls
 */
function buildSignature(params, apiSecret) {
  // 1. Sort all parameter keys alphabetically
  const sorted = Object.keys(params).sort();
  // 2. Concatenate key+value pairs
  const str = sorted.map(k => k + params[k]).join("");
  // 3. Append secret
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
  // Per Last.fm spec: format must NOT be included in the signature.
  // See: https://www.last.fm/api/authspec#_8-signing-calls
  const allParams = { ...params };
  allParams.api_sig = buildSignature(allParams, apiSecret);
  allParams.format  = "json";   // add AFTER signature

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

// ── LastFmManager ──────────────────────────────────────────────────────────────

export class LastFmManager {
  /**
   * @param {object} config - The `lastfm` section from config.json
   * @param {object} mysqlConfig - MySQL connection info for creating the users table
   */
  constructor(config, mysqlConfig) {
    this.apiKey    = config?.apiKey ?? "";
    this.apiSecret = config?.apiSecret ?? "";
    this.enabled   = !!(this.apiKey && this.apiSecret);
    this.scrobbleThreshold = config?.scrobbleThreshold ?? 0.5;  // fraction of track duration
    this.scrobbleMinMs     = config?.scrobbleMinMs ?? 240_000;  // 4 min fallback

    // MySQL pool (lazy-created on first query)
    this._mysqlConfig = mysqlConfig;
    this._pool = null;

    // In-memory user cache: Map<userId, { sessionKey, username, scrobbleEnabled }>
    this._userCache = new Map();

    if (!this.enabled) {
      logger.settings("[LastFm] Disabled — apiKey or apiSecret missing in config.");
    }
  }

  // ── MySQL ──────────────────────────────────────────────────────────────────

  async _getPool() {
    if (this._pool) return this._pool;
    // Dynamic import so we don't crash if mysql2 isn't needed
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
        \`user_id\`     VARCHAR(30)  NOT NULL PRIMARY KEY,
        \`session_key\` VARCHAR(64)  NOT NULL,
        \`username\`    VARCHAR(64)  NOT NULL DEFAULT '',
        \`scrobble\`    TINYINT(1)   NOT NULL DEFAULT 1,
        \`linked_at\`   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
  }

  // ── User persistence ───────────────────────────────────────────────────────

  async getUser(userId) {
    const cached = this._userCache.get(userId);
    if (cached) return cached;

    const pool = await this._getPool();
    const [rows] = await pool.execute(
      "SELECT session_key, username, scrobble FROM lastfm_users WHERE user_id = ?",
      [String(userId)]
    );

    if (!rows.length) return null;

    const row = rows[0];
    const data = {
      sessionKey:     row.session_key,
      username:       row.username,
      scrobbleEnabled: !!row.scrobble,
    };
    this._userCache.set(userId, data);
    return data;
  }

  async saveUser(userId, sessionKey, username) {
    const pool = await this._getPool();
    await pool.execute(
      `INSERT INTO lastfm_users (user_id, session_key, username, scrobble)
       VALUES (?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE session_key = VALUES(session_key), username = VALUES(username)`,
      [String(userId), sessionKey, username ?? ""]
    );
    const data = { sessionKey, username: username ?? "", scrobbleEnabled: true };
    this._userCache.set(userId, data);
    return data;
  }

  async removeUser(userId) {
    const pool = await this._getPool();
    await pool.execute("DELETE FROM lastfm_users WHERE user_id = ?", [String(userId)]);
    this._userCache.delete(userId);
  }

  async setScrobble(userId, enabled) {
    const pool = await this._getPool();
    await pool.execute(
      "UPDATE lastfm_users SET scrobble = ? WHERE user_id = ?",
      [enabled ? 1 : 0, String(userId)]
    );
    const cached = this._userCache.get(userId);
    if (cached) cached.scrobbleEnabled = enabled;
  }

  // ── Auth flow ──────────────────────────────────────────────────────────────

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
    return data.session; // { key, name }
  }

  // ── Scrobbling ─────────────────────────────────────────────────────────────

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
        true // POST
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
        true // POST
      );
      logger.settings(`[LastFm] Scrobbled "${track.title}" for ${userId}`);
    } catch (err) {
      logger.warn(`[LastFm] Scrobble failed for ${userId}: ${err.message}`);
    }
  }

  // ── User data (for play command) ──────────────────────────────────────────

  /**
   * Get the user's loved tracks.
   * @param {string} userId - Discord/Fluxer user ID
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

    // If user is linked, include their username for personal playcount
    if (userId) {
      const user = await this.getUser(userId);
      if (user) params.username = user.username;
    }

    try {
      const data = await apiCall(params, this.apiSecret);
      return data.track;
    } catch {
      return null;
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

  // ── Internal helpers ───────────────────────────────────────────────────────

  _assertEnabled() {
    if (!this.enabled) throw new Error("Last.fm integration is not configured (missing apiKey/apiSecret).");
  }

  _extractArtist(track) {
    return track.artists?.[0]?.name
      ?? track.author?.name
      ?? track.artist
      ?? "Unknown Artist";
  }

  _extractTitle(track) {
    return track.title ?? track.name ?? "Unknown Track";
  }

  _extractDurationSec(track) {
    if (!track.duration) return "";
    // Duration can be: { seconds: N }, "PT3M0S", or milliseconds number
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

    if (!durationMs || durationMs < 30_000) return false; // too short

    const thresholdMs = Math.min(durationMs * this.scrobbleThreshold, this.scrobbleMinMs);
    return playedMs >= thresholdMs;
  }
}
