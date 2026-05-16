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

function normalizeTrackText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[^\w\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

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

    /** @type {string|null} Bot user ID — used to isolate rows per-bot in shared databases */
    this.botId = null;
    /** @type {boolean} Whether the bot_id column exists in the lastfm tables */
    this._hasBotIdColumn = false;

    // In-memory user cache: Map<userId, { sessionKey, username, scrobbleEnabled }>
    this._userCache = new Map();

    // Cache for total synced scrobbles (sum of all users' lifetime scrobble counts)
    this._totalScrobblesCache = null;
    this._totalScrobblesCacheExpiry = 0;
    this._totalScrobblesInflight = null;

    if (!this.enabled) {
      logger.settings("[LastFm] Disabled — apiKey or apiSecret missing in config.");
    }
  }

  // ── Bot ID isolation ─────────────────────────────────────────────────────

  /**
   * Set the bot ID for multi-bot database isolation.
   * Ensures bot_id column exists in lastfm tables, then clears caches.
   * @param {string} id - The bot's Discord user ID
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
   */
  async _ensureBotIdColumn() {
    if (this._hasBotIdColumn) return;
    const pool = await this._getPool();

    // Check lastfm_users
    const [cols] = await pool.execute(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'lastfm_users' AND COLUMN_NAME = 'bot_id'`
    );
    if (cols.length === 0) {
      logger.settings("[LastFm] Auto-migrating: adding bot_id column to lastfm_users...");
      await pool.execute("ALTER TABLE `lastfm_users` ADD COLUMN `bot_id` VARCHAR(32) DEFAULT NULL");
      await pool.execute("ALTER TABLE `lastfm_users` DROP PRIMARY KEY, ADD PRIMARY KEY (user_id, bot_id)");
      logger.settings("[LastFm] Auto-migration complete: lastfm_users.bot_id added.");
    }

    // Check lastfm_stats
    const [statsCols] = await pool.execute(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'lastfm_stats' AND COLUMN_NAME = 'bot_id'`
    );
    if (statsCols.length === 0) {
      logger.settings("[LastFm] Auto-migrating: adding bot_id column to lastfm_stats...");
      await pool.execute("ALTER TABLE `lastfm_stats` ADD COLUMN `bot_id` VARCHAR(32) DEFAULT NULL");
      await pool.execute("ALTER TABLE `lastfm_stats` DROP PRIMARY KEY, ADD PRIMARY KEY (id, bot_id)");
      logger.settings("[LastFm] Auto-migration complete: lastfm_stats.bot_id added.");
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
        \`user_id\`       VARCHAR(30)  NOT NULL PRIMARY KEY,
        \`session_key\`   VARCHAR(64)  NOT NULL,
        \`username\`      VARCHAR(64)  NOT NULL DEFAULT '',
        \`scrobble\`      TINYINT(1)   NOT NULL DEFAULT 1,
        \`scrobble_count\` BIGINT       NOT NULL DEFAULT 0,
        \`linked_at\`     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // Auto-migrate: add scrobble_count column if it doesn't exist (existing tables)
    try {
      await pool.execute("ALTER TABLE \`lastfm_users\` ADD COLUMN \`scrobble_count\` BIGINT NOT NULL DEFAULT 0 AFTER \`scrobble\`");
    } catch {
      // Column already exists — ignore
    }

    // Stats table — single row tracking global scrobble counts
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS \`lastfm_stats\` (
        \`id\`              TINYINT(1)  NOT NULL PRIMARY KEY DEFAULT 1,
        \`stored_scrobbles\` BIGINT     NOT NULL DEFAULT 0,
        \`linked_users\`    INT         NOT NULL DEFAULT 0
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    // Ensure the single row exists
    await pool.execute(`
      INSERT IGNORE INTO \`lastfm_stats\` (id, stored_scrobbles, linked_users) VALUES (1, 0, 0)
    `);
  }

  // ── User persistence ───────────────────────────────────────────────────────

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

    // Increment linked_users counter (only on new links, not re-links)
    try {
      await pool.execute(
        `UPDATE lastfm_stats SET linked_users = linked_users + 1 WHERE id = 1${f.where} AND NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM lastfm_users WHERE user_id = ?${f.where} AND linked_at < NOW()) AS tmp)`,
        [...f.params, String(userId), ...f.params]
      );
    } catch {
      // Non-critical — don't fail the save
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

      // Increment stored scrobbles counter (non-blocking)
      this._incrementScrobbleCount(userId);
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

  // ── Playlists & Albums ────────────────────────────────────────────────────────

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

    // Parse playlist links from the HTML
    // Last.fm playlist links look like: /user/USERNAME/playlists/123456
    // Each playlist item has a .playlist-item or similar container
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

    // Try to extract track counts (e.g. "12 tracks" or "1 track")
    const countRegex = /(\d+)\s+track/gi;
    const counts = [];
    let cMatch;
    while ((cMatch = countRegex.exec(html)) !== null) {
      counts.push(+cMatch[1]);
    }
    // Pair counts with playlists (order should match)
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

    // If playlistId is a number, look up the playlist URL from the user's playlists
    if (/^\d+$/.test(String(playlistId))) {
      const playlists = await this.getPlaylists(userId);
      const idx = +playlistId - 1; // 1-based to 0-based
      if (idx < 0 || idx >= playlists.length) {
        throw new Error(`Playlist #${playlistId} not found. You have ${playlists.length} playlist(s). Use \`%lastfm playlists\` to see them.`);
      }
      playlistUrl = playlists[idx].url;
    } else if (String(playlistId).startsWith("http")) {
      playlistUrl = String(playlistId);
    } else {
      // Assume it's a playlist ID slug — build the URL
      playlistUrl = `https://www.last.fm/user/${user.username}/playlists/${playlistId}`;
    }

    // Scrape the playlist page for track info
    const res = await fetch(playlistUrl, {
      headers: { "User-Agent": "RemixBot/1.0 (Last.fm Integration)" },
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch playlist page (HTTP ${res.status})`);
    }

    const html = await res.text();
    const tracks = [];

    // Last.fm playlist pages contain track items with:
    // <a href="/music/Artist/Track" class="...">Track Name</a>
    // We extract artist and track from the URL pattern /music/Artist+Name/Track+Name
    const trackLinkRegex = /href="\/music\/([^"]+?)"[^>]*class="[^"]*(?:link-block-target|chartlist-name)[^"]*"[^>]*>([^<]+)<\/a>/gi;
    let tMatch;
    while ((tMatch = trackLinkRegex.exec(html)) !== null && tracks.length < limit) {
      const urlPath = decodeURIComponent(tMatch[1]);
      const name = tMatch[2].trim();
      // URL format: /music/Artist+Name/Track+Name or /music/Artist+Name/_/Track+Name
      const parts = urlPath.split("/");
      let artist = "Unknown";
      if (parts.length >= 1) {
        artist = parts[0].replace(/\+/g, " ");
      }
      if (parts.length >= 3 && parts[1] === "_") {
        // /music/Artist/_/Track format
      } else if (parts.length >= 2) {
        // /music/Artist/Track format — the track name from URL
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

    // Fallback: try a broader regex if the first one didn't find anything
    if (!tracks.length) {
      const broadRegex = /href="\/music\/([^"]+)"[^>]*>([^<]{2,80})<\/a>/gi;
      const seen = new Set();
      let bMatch;
      while ((bMatch = broadRegex.exec(html)) !== null && tracks.length < limit) {
        const urlPath = decodeURIComponent(bMatch[1]);
        const name = bMatch[2].trim();
        // Only include actual track links (Artist/Track or Artist/_/Track)
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

  // ── Play helper (for %lastfm play and %play lastfm:loved etc.) ─────────────

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
        // Filter out "now playing" entries (they have no finished timestamp)
        tracks = tracks.filter(t => !t.now);
        break;
      case "playlist":
        if (!options.playlistId) throw new Error("Playlist ID required. Use `%lastfm playlists` to see your playlists, then `%lastfm play playlist <number>`.");
        tracks = await this.getPlaylistTracks(userId, options.playlistId, limit);
        break;
      case "albums":
        // Top albums — we fetch albums, then for each album we use the album name + artist as search query
        const albums = await this.getTopAlbums(userId, options.period ?? "overall", limit);
        tracks = albums.map(a => ({
          artist: a.artist,
          name:   a.name,
          url:    a.url,
          // For albums, search the album name + artist to get the full album
          query:  `${a.artist} ${a.name} album`,
          image:  a.image ?? "",
        }));
        return {
          username: user.username,
          tracks,
        };
      default:
        throw new Error(`Unknown Last.fm category: ${category}. Use loved, top, recent, playlist, or albums.`);
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

  // ── Global stats ────────────────────────────────────────────────────────────

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

    // Return cached value if still fresh
    if (this._totalScrobblesCache !== null && Date.now() < this._totalScrobblesCacheExpiry) {
      return this._totalScrobblesCache;
    }

    // Deduplicate concurrent calls
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

      // Get all linked user IDs
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

      // Sync each user's scrobble count from the Last.fm API (with concurrency limit)
      const userIds = rows.map(r => r.user_id);

      // Batch the sync calls to avoid overloading the Last.fm API
      for (let i = 0; i < userIds.length; i += concurrency) {
        const batch = userIds.slice(i, i + concurrency);
        await Promise.allSettled(batch.map(uid => this.syncUserScrobbleCount(uid)));
      }

      // Now sum up all scrobble_count values from the DB
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
      // Return stale cache if available, otherwise 0
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
    } catch {
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

    // Get total count
    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS total FROM lastfm_users WHERE scrobble_count > 0${f.where}`,
      [...f.params]
    );
    const totalUsers = Number(countRows[0]?.total ?? 0);
    const totalPages = Math.max(1, Math.ceil(totalUsers / perPage));

    // Clamp page
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
    } catch {
      return 0;
    }
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

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

    const normalizedTitle = normalizeTrackText(this._extractTitle(track));
    const normalizedArtist = normalizeTrackText(this._extractArtist(track));
    if (!normalizedTitle || !normalizedArtist) return false;

    const thresholdMs = Math.min(durationMs * this.scrobbleThreshold, this.scrobbleMinMs);
    return playedMs >= thresholdMs;
  }
}
