/**
 * @module src/music/GuildStats
 * @description Persistent per-guild and global music analytics engine.
 * Backed by MySQL relational tables, Redis atomic counters/sorted sets, and
 * debounced local JSON storage as a zero-downtime fallback.
 */

import fs from "node:fs";
import path from "node:path";
import { logger } from "../core/Logger.mjs";

const STATS_DIR = path.join(process.cwd(), "storage", "guild_stats");
const REDIS_GUILD_PREFIX = "fluxer:stats:guild:";
const REDIS_GLOBAL_PLAYS = "fluxer:stats:global:plays";
const REDIS_GLOBAL_SONGS = "fluxer:stats:global:songs";

/**
 * Format 24-hour index into standard 12-hour display.
 * @param {number} hour
 * @returns {string}
 */
function formatHour(hour) {
  const h = Number(hour) % 24;
  const period = h >= 12 ? "PM" : "AM";
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}:00 ${period}`;
}

class GuildStatsManager {
  constructor() {
    /** @type {Map<string, object>} */
    this._cache = new Map();
    /** @type {Map<string, NodeJS.Timeout>} */
    this._saveTimers = new Map();
    this._pool = null;
    this._redis = null;
  }

  /**
   * Set centralized MySQL connection pool and initialize tables.
   * @param {object} pool
   */
  setPool(pool) {
    this._pool = pool;
    this._initDatabase().catch((e) => {
      logger.warn("[GuildStats] Database init error:", e?.message);
    });
  }

  /**
   * Set Redis manager instance for fast caching and atomic score increments.
   * @param {object} redisHandler
   */
  setRedis(redisHandler) {
    this._redis = redisHandler;
  }

  /**
   * Initialize MySQL schema for guild track records and aggregated song counters.
   * @private
   */
  async _initDatabase() {
    if (!this._pool) return;
    try {
      await this._pool.execute(`
        CREATE TABLE IF NOT EXISTS \`guild_track_stats\` (
          \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
          \`guild_id\` VARCHAR(32) NOT NULL,
          \`title\` VARCHAR(255) NOT NULL,
          \`artist\` VARCHAR(255) NOT NULL,
          \`duration_ms\` BIGINT NOT NULL DEFAULT 0,
          \`user_id\` VARCHAR(32) NULL,
          \`hour_played\` TINYINT NOT NULL DEFAULT 0,
          \`played_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX \`idx_guild_time\` (\`guild_id\`, \`played_at\`),
          INDEX \`idx_global_time\` (\`played_at\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      await this._pool.execute(`
        CREATE TABLE IF NOT EXISTS \`guild_song_counts\` (
          \`guild_id\` VARCHAR(32) NOT NULL,
          \`song_key\` VARCHAR(255) NOT NULL,
          \`title\` VARCHAR(255) NOT NULL,
          \`artist\` VARCHAR(255) NOT NULL,
          \`play_count\` BIGINT NOT NULL DEFAULT 1,
          \`duration_ms\` BIGINT NOT NULL DEFAULT 0,
          \`last_played\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (\`guild_id\`, \`song_key\`),
          INDEX \`idx_guild_plays\` (\`guild_id\`, \`play_count\` DESC)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);
    } catch (e) {
      logger.warn("[GuildStats] Failed to initialize MySQL tables:", e?.message);
    }
  }

  /**
   * Get or load guild stats object from cache or disk.
   * @param {string} guildId
   * @returns {object}
   */
  _getGuildData(guildId) {
    if (!guildId) return null;
    if (this._cache.has(guildId)) {
      return this._cache.get(guildId);
    }

    const data = {
      guildId,
      totalPlays: 0,
      totalDurationMs: 0,
      hourly: new Array(24).fill(0),
      users: {},
      songs: {},
      recent: [],
    };

    try {
      const filePath = path.join(STATS_DIR, `${guildId}.json`);
      if (fs.existsSync(filePath)) {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (parsed && typeof parsed === "object") {
          data.totalPlays = Number(parsed.totalPlays) || 0;
          data.totalDurationMs = Number(parsed.totalDurationMs) || 0;
          if (Array.isArray(parsed.hourly) && parsed.hourly.length === 24) {
            data.hourly = parsed.hourly;
          }
          if (parsed.users && typeof parsed.users === "object") {
            data.users = parsed.users;
          }
          if (parsed.songs && typeof parsed.songs === "object") {
            data.songs = parsed.songs;
          }
          if (Array.isArray(parsed.recent)) {
            data.recent = parsed.recent;
          }
        }
      }
    } catch (e) {
      logger.warn(`[GuildStats] Failed to load stats for ${guildId}:`, e?.message);
    }

    this._cache.set(guildId, data);
    return data;
  }

  /**
   * Record a track playback event for a specific guild into SQL, Redis, and file cache.
   * @param {object} param0
   * @param {string} param0.guildId
   * @param {object} param0.track
   * @param {string|null} [param0.userId]
   */
  recordPlay({ guildId, track, userId = null }) {
    if (!guildId || !track) return;
    const data = this._getGuildData(guildId);
    if (!data) return;

    const title = track.title || "Unknown Track";
    const artist = track.artist || (typeof track.author === "object" ? track.author?.name : track.author) || "Unknown Artist";
    const durationMs = (() => {
      const d = track.duration;
      if (!d) return 0;
      if (typeof d === "object" && d?.seconds) return d.seconds * 1000;
      if (typeof d === "number") return d;
      return 0;
    })();

    data.totalPlays += 1;
    data.totalDurationMs += durationMs;

    const currentHour = new Date().getHours();
    data.hourly[currentHour] = (data.hourly[currentHour] || 0) + 1;

    if (userId && typeof userId === "string" && userId !== "system") {
      data.users[userId] = (data.users[userId] || 0) + 1;
    }

    const songKey = `${title}:::${artist}`;
    if (!data.songs[songKey]) {
      data.songs[songKey] = { title, artist, count: 0, durationMs };
    }
    data.songs[songKey].count += 1;

    data.recent.unshift({
      title,
      artist,
      durationMs,
      userId: userId || null,
      ts: Date.now(),
    });

    if (data.recent.length > 1000) {
      data.recent.length = 1000;
    }

    this._scheduleSave(guildId);

    if (guildId !== "global") {
      const globalData = this._getGuildData("global");
      if (globalData) {
        globalData.totalPlays += 1;
        globalData.totalDurationMs += durationMs;
        globalData.hourly[currentHour] = (globalData.hourly[currentHour] || 0) + 1;
        if (!globalData.guilds) globalData.guilds = {};
        globalData.guilds[guildId] = (globalData.guilds[guildId] || 0) + 1;
        if (!globalData.songs[songKey]) {
          globalData.songs[songKey] = { title, artist, count: 0, durationMs };
        }
        globalData.songs[songKey].count += 1;
        this._scheduleSave("global");
      }
    }

    /* Asynchronous MySQL persistence */
    if (this._pool) {
      this._pool.execute(`
        INSERT INTO \`guild_track_stats\` (\`guild_id\`, \`title\`, \`artist\`, \`duration_ms\`, \`user_id\`, \`hour_played\`)
        VALUES (?, ?, ?, ?, ?, ?);
      `, [guildId, title.slice(0, 255), artist.slice(0, 255), durationMs, userId || null, currentHour]).catch((err) => {
        logger.warn("[GuildStats] MySQL insert error:", err?.message);
      });

      this._pool.execute(`
        INSERT INTO \`guild_song_counts\` (\`guild_id\`, \`song_key\`, \`title\`, \`artist\`, \`play_count\`, \`duration_ms\`)
        VALUES (?, ?, ?, ?, 1, ?)
        ON DUPLICATE KEY UPDATE \`play_count\` = \`play_count\` + 1, \`last_played\` = CURRENT_TIMESTAMP;
      `, [guildId, songKey.slice(0, 255), title.slice(0, 255), artist.slice(0, 255), durationMs]).catch(() => {});

      if (guildId !== "global") {
        this._pool.execute(`
          INSERT INTO \`guild_song_counts\` (\`guild_id\`, \`song_key\`, \`title\`, \`artist\`, \`play_count\`, \`duration_ms\`)
          VALUES ('global', ?, ?, ?, 1, ?)
          ON DUPLICATE KEY UPDATE \`play_count\` = \`play_count\` + 1, \`last_played\` = CURRENT_TIMESTAMP;
        `, [songKey.slice(0, 255), title.slice(0, 255), artist.slice(0, 255), durationMs]).catch(() => {});
      }
    }

    /* Asynchronous Redis atomic increments */
    const client = this._redis?.client;
    if (client && client.isOpen) {
      client.incrBy(`${REDIS_GUILD_PREFIX}${guildId}:plays`, 1).catch(() => {});
      client.incrBy(REDIS_GLOBAL_PLAYS, 1).catch(() => {});
      client.zIncrBy(`${REDIS_GUILD_PREFIX}${guildId}:songs`, 1, songKey).catch(() => {});
      client.zIncrBy(REDIS_GLOBAL_SONGS, 1, songKey).catch(() => {});
    }
  }

  /**
   * Get top tracks for a guild with timeframe filtering.
   * @param {string} guildId
   * @param {string} [timeframe="month"] - "week" | "month" | "all"
   * @param {number} [limit=10]
   * @returns {Promise<{tracks: Array, topArtist: {name: string, count: number}|null}>}
   */
  async getTopTracks(guildId, timeframe = "month", limit = 10) {
    const lim = Math.max(1, Math.min(100, Number(limit) || 10));

    if (this._pool) {
      try {
        let sql = "";
        let params = [];
        if (timeframe === "week") {
          sql = `
            SELECT \`title\`, \`artist\`, COUNT(*) as count, MAX(\`duration_ms\`) as durationMs
            FROM \`guild_track_stats\`
            WHERE \`guild_id\` = ? AND \`played_at\` >= DATE_SUB(NOW(), INTERVAL 7 DAY)
            GROUP BY \`title\`, \`artist\`
            ORDER BY count DESC
            LIMIT ?;
          `;
          params = [guildId, lim];
        } else if (timeframe === "month") {
          sql = `
            SELECT \`title\`, \`artist\`, COUNT(*) as count, MAX(\`duration_ms\`) as durationMs
            FROM \`guild_track_stats\`
            WHERE \`guild_id\` = ? AND \`played_at\` >= DATE_SUB(NOW(), INTERVAL 30 DAY)
            GROUP BY \`title\`, \`artist\`
            ORDER BY count DESC
            LIMIT ?;
          `;
          params = [guildId, lim];
        } else {
          sql = `
            SELECT \`title\`, \`artist\`, \`play_count\` as count, \`duration_ms\` as durationMs
            FROM \`guild_song_counts\`
            WHERE \`guild_id\` = ?
            ORDER BY count DESC
            LIMIT ?;
          `;
          params = [guildId, lim];
        }

        let [rows] = await this._pool.execute(sql, params);
        if ((!rows || rows.length === 0) && (timeframe === "month" || timeframe === "week")) {
          const [allRows] = await this._pool.execute(`
            SELECT \`title\`, \`artist\`, \`play_count\` as count, \`duration_ms\` as durationMs
            FROM \`guild_song_counts\`
            WHERE \`guild_id\` = ?
            ORDER BY count DESC
            LIMIT ?;
          `, [guildId, lim]);
          if (allRows && allRows.length > 0) {
            rows = allRows;
          }
        }
        if (rows && rows.length > 0) {
          const artistMap = {};
          const tracks = rows.map((r) => {
            const c = Number(r.count) || 0;
            if (r.artist && r.artist !== "Unknown Artist") {
              artistMap[r.artist] = (artistMap[r.artist] || 0) + c;
            }
            return {
              title: r.title,
              artist: r.artist,
              count: c,
              durationMs: Number(r.durationMs) || 0,
            };
          });

          const sortedArtists = Object.entries(artistMap).sort((a, b) => b[1] - a[1]);
          const topArtist = sortedArtists.length > 0 ? { name: sortedArtists[0][0], count: sortedArtists[0][1] } : null;

          return { tracks, topArtist };
        }
      } catch (err) {
        logger.warn("[GuildStats] MySQL getTopTracks error:", err?.message);
      }
    }

    /* Fallback to local memory/file cache */
    const data = this._getGuildData(guildId);
    if (!data || data.totalPlays === 0) {
      return { tracks: [], topArtist: null };
    }

    let trackMap = {};
    const artistMap = {};

    if (timeframe === "all") {
      trackMap = data.songs;
      for (const item of Object.values(trackMap)) {
        artistMap[item.artist] = (artistMap[item.artist] || 0) + item.count;
      }
    } else {
      const now = Date.now();
      const cutoff = timeframe === "week" ? now - 7 * 86_400_000 : now - 30 * 86_400_000;
      for (const p of data.recent) {
        if (p.ts >= cutoff) {
          const k = `${p.title}:::${p.artist}`;
          if (!trackMap[k]) {
            trackMap[k] = { title: p.title, artist: p.artist, count: 0, durationMs: p.durationMs };
          }
          trackMap[k].count += 1;
          artistMap[p.artist] = (artistMap[p.artist] || 0) + 1;
        }
      }
    }

    let tracks = Object.values(trackMap)
      .sort((a, b) => b.count - a.count)
      .slice(0, lim);

    if (tracks.length === 0 && Object.keys(data.songs || {}).length > 0) {
      trackMap = data.songs;
      for (const item of Object.values(trackMap)) {
        artistMap[item.artist] = (artistMap[item.artist] || 0) + item.count;
      }
      tracks = Object.values(trackMap)
        .sort((a, b) => b.count - a.count)
        .slice(0, lim);
    }

    let topArtist = null;
    const sortedArtists = Object.entries(artistMap).sort((a, b) => b[1] - a[1]);
    if (sortedArtists.length > 0 && sortedArtists[0][0] !== "Unknown Artist") {
      topArtist = { name: sortedArtists[0][0], count: sortedArtists[0][1] };
    }

    return { tracks, topArtist };
  }

  /**
   * Get global top tracks across all servers.
   * @param {number} [limit=10]
   * @returns {Promise<{tracks: Array, topArtist: {name: string, count: number}|null}>}
   */
  async getGlobalTopTracks(limit = 10) {
    const lim = Math.max(1, Math.min(100, Number(limit) || 10));

    if (this._pool) {
      try {
        const [rows] = await this._pool.execute(`
          SELECT \`title\`, \`artist\`, \`play_count\` as count, \`duration_ms\` as durationMs
          FROM \`guild_song_counts\`
          WHERE \`guild_id\` = 'global'
          ORDER BY count DESC
          LIMIT ?;
        `, [lim]);

        if (rows && rows.length > 0) {
          const artistMap = {};
          const tracks = rows.map((r) => {
            const c = Number(r.count) || 0;
            if (r.artist && r.artist !== "Unknown Artist") {
              artistMap[r.artist] = (artistMap[r.artist] || 0) + c;
            }
            return {
              title: r.title,
              artist: r.artist,
              count: c,
              durationMs: Number(r.durationMs) || 0,
            };
          });

          const sortedArtists = Object.entries(artistMap).sort((a, b) => b[1] - a[1]);
          const topArtist = sortedArtists.length > 0 ? { name: sortedArtists[0][0], count: sortedArtists[0][1] } : null;

          return { tracks, topArtist };
        }
      } catch (err) {
        logger.warn("[GuildStats] MySQL getGlobalTopTracks error:", err?.message);
      }
    }

    /* Fallback to local global cache */
    const globalData = this._getGuildData("global");
    if (!globalData || globalData.totalPlays === 0) {
      return { tracks: [], topArtist: null };
    }
    const tracks = Object.values(globalData.songs || {})
      .sort((a, b) => b.count - a.count)
      .slice(0, lim);

    const artistMap = {};
    for (const item of Object.values(globalData.songs || {})) {
      if (item.artist && item.artist !== "Unknown Artist") {
        artistMap[item.artist] = (artistMap[item.artist] || 0) + item.count;
      }
    }
    const sortedArtists = Object.entries(artistMap).sort((a, b) => b[1] - a[1]);
    const topArtist = sortedArtists.length > 0 ? { name: sortedArtists[0][0], count: sortedArtists[0][1] } : null;

    return { tracks, topArtist };
  }

  /**
   * Get community monthly wrapped summary statistics.
   * @param {string} guildId
   * @returns {Promise<object|null>}
   */
  async getWrapped(guildId) {
    if (this._pool) {
      try {
        const [sumRows] = await this._pool.execute(`
          SELECT COUNT(*) as totalTracks, COALESCE(SUM(\`duration_ms\`), 0) as totalDurationMs
          FROM \`guild_track_stats\`
          WHERE \`guild_id\` = ?;
        `, [guildId]);

        const totalTracks = Number(sumRows?.[0]?.totalTracks) || 0;
        if (totalTracks > 0) {
          const totalDurationMs = Number(sumRows?.[0]?.totalDurationMs) || 0;
          const totalHours = Math.round((totalDurationMs / 3_600_000) * 10) / 10;

          const [hourRows] = await this._pool.execute(`
            SELECT \`hour_played\`, COUNT(*) as count
            FROM \`guild_track_stats\`
            WHERE \`guild_id\` = ?
            GROUP BY \`hour_played\`
            ORDER BY count DESC
            LIMIT 1;
          `, [guildId]);
          const peakHour = hourRows?.[0] ? formatHour(hourRows[0].hour_played) : "12:00 PM";

          const [userRows] = await this._pool.execute(`
            SELECT \`user_id\`, COUNT(*) as count
            FROM \`guild_track_stats\`
            WHERE \`guild_id\` = ? AND \`user_id\` IS NOT NULL AND \`user_id\` != 'system'
            GROUP BY \`user_id\`
            ORDER BY count DESC
            LIMIT 1;
          `, [guildId]);
          const topUserId = userRows?.[0]?.user_id || null;
          const topUserPlays = Number(userRows?.[0]?.count) || 0;

          const [trackRows] = await this._pool.execute(`
            SELECT \`title\`, \`artist\`, \`play_count\` as count, \`duration_ms\` as durationMs
            FROM \`guild_song_counts\`
            WHERE \`guild_id\` = ?
            ORDER BY count DESC
            LIMIT 5;
          `, [guildId]);

          const topTracks = (trackRows || []).map((r) => ({
            title: r.title,
            artist: r.artist,
            count: Number(r.count) || 0,
            durationMs: Number(r.durationMs) || 0,
          }));

          return {
            totalHours,
            totalTracks,
            peakHour,
            topUserId,
            topUserPlays,
            topTracks,
          };
        }
      } catch (err) {
        logger.warn("[GuildStats] MySQL getWrapped error:", err?.message);
      }
    }

    /* Fallback to local memory/file cache */
    const data = this._getGuildData(guildId);
    if (!data || data.totalPlays === 0) {
      return null;
    }

    const totalHours = Math.round((data.totalDurationMs / 3_600_000) * 10) / 10;

    let peakHourIndex = 0;
    let peakHourCount = 0;
    for (let i = 0; i < 24; i++) {
      if ((data.hourly[i] || 0) > peakHourCount) {
        peakHourCount = data.hourly[i];
        peakHourIndex = i;
      }
    }

    let topUserId = null;
    let topUserPlays = 0;
    for (const [uid, count] of Object.entries(data.users || {})) {
      if (count > topUserPlays) {
        topUserPlays = count;
        topUserId = uid;
      }
    }

    const topTracks = Object.values(data.songs || {})
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return {
      totalHours,
      totalTracks: data.totalPlays,
      peakHour: formatHour(peakHourIndex),
      topUserId,
      topUserPlays,
      topTracks,
    };
  }

  /**
   * Get global wrapped recap across all servers.
   * @param {number} [fallbackServerCount=0]
   * @returns {Promise<object|null>}
   */
  async getGlobalWrapped(fallbackServerCount = 0) {
    if (this._pool) {
      try {
        const [sumRows] = await this._pool.execute(`
          SELECT COUNT(*) as totalTracks, COALESCE(SUM(\`duration_ms\`), 0) as totalDurationMs, COUNT(DISTINCT \`guild_id\`) as totalGuilds
          FROM \`guild_track_stats\`
          WHERE \`guild_id\` != 'global';
        `);

        const totalTracks = Number(sumRows?.[0]?.totalTracks) || 0;
        if (totalTracks > 0) {
          const totalDurationMs = Number(sumRows?.[0]?.totalDurationMs) || 0;
          const totalHours = Math.round((totalDurationMs / 3_600_000) * 10) / 10;
          const totalGuilds = Math.max(fallbackServerCount, Number(sumRows?.[0]?.totalGuilds) || 1);

          const [hourRows] = await this._pool.execute(`
            SELECT \`hour_played\`, COUNT(*) as count
            FROM \`guild_track_stats\`
            GROUP BY \`hour_played\`
            ORDER BY count DESC
            LIMIT 1;
          `);
          const peakHour = hourRows?.[0] ? formatHour(hourRows[0].hour_played) : "12:00 PM";

          const [trackRows] = await this._pool.execute(`
            SELECT \`title\`, \`artist\`, \`play_count\` as count, \`duration_ms\` as durationMs
            FROM \`guild_song_counts\`
            WHERE \`guild_id\` = 'global'
            ORDER BY count DESC
            LIMIT 5;
          `);

          const topTracks = (trackRows || []).map((r) => ({
            title: r.title,
            artist: r.artist,
            count: Number(r.count) || 0,
            durationMs: Number(r.durationMs) || 0,
          }));

          return {
            totalHours,
            totalTracks,
            peakHour,
            totalGuilds,
            topTracks,
          };
        }
      } catch (err) {
        logger.warn("[GuildStats] MySQL getGlobalWrapped error:", err?.message);
      }
    }

    /* Fallback to local memory/file cache */
    const globalData = this._getGuildData("global");
    if (!globalData || globalData.totalPlays === 0) {
      return null;
    }

    const totalHours = Math.round((globalData.totalDurationMs / 3_600_000) * 10) / 10;

    let peakHourIndex = 0;
    let peakHourCount = 0;
    for (let i = 0; i < 24; i++) {
      if ((globalData.hourly[i] || 0) > peakHourCount) {
        peakHourCount = globalData.hourly[i];
        peakHourIndex = i;
      }
    }

    const totalGuilds = Math.max(
      fallbackServerCount,
      Object.keys(globalData.guilds || {}).length,
      1
    );

    const topTracks = Object.values(globalData.songs || {})
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return {
      totalHours,
      totalTracks: globalData.totalPlays,
      peakHour: formatHour(peakHourIndex),
      totalGuilds,
      topTracks,
    };
  }

  /**
   * Get personal listening statistics for a specific user in a guild (or global network).
   * @param {string} guildId
   * @param {string} userId
   * @returns {Promise<object|null>}
   */
  async getUserStats(guildId, userId) {
    if (!userId) return null;

    if (this._pool) {
      try {
        const isGlobalScope = guildId === "global";
        const sumSql = isGlobalScope
          ? "SELECT COUNT(*) as totalTracks, COALESCE(SUM(`duration_ms`), 0) as totalDurationMs FROM `guild_track_stats` WHERE `user_id` = ?;"
          : "SELECT COUNT(*) as totalTracks, COALESCE(SUM(`duration_ms`), 0) as totalDurationMs FROM `guild_track_stats` WHERE `guild_id` = ? AND `user_id` = ?;";
        const sumParams = isGlobalScope ? [userId] : [guildId, userId];

        const [sumRows] = await this._pool.execute(sumSql, sumParams);
        const totalTracks = Number(sumRows?.[0]?.totalTracks) || 0;

        if (totalTracks > 0) {
          const totalDurationMs = Number(sumRows?.[0]?.totalDurationMs) || 0;
          const totalHours = Math.round((totalDurationMs / 3_600_000) * 10) / 10;

          const hourSql = isGlobalScope
            ? "SELECT `hour_played`, COUNT(*) as count FROM `guild_track_stats` WHERE `user_id` = ? GROUP BY `hour_played` ORDER BY count DESC LIMIT 1;"
            : "SELECT `hour_played`, COUNT(*) as count FROM `guild_track_stats` WHERE `guild_id` = ? AND `user_id` = ? GROUP BY `hour_played` ORDER BY count DESC LIMIT 1;";
          const hourParams = isGlobalScope ? [userId] : [guildId, userId];

          const [hourRows] = await this._pool.execute(hourSql, hourParams);
          const peakHour = hourRows?.[0] ? formatHour(hourRows[0].hour_played) : "12:00 PM";

          const trackSql = isGlobalScope
            ? "SELECT `title`, `artist`, COUNT(*) as count, MAX(`duration_ms`) as durationMs FROM `guild_track_stats` WHERE `user_id` = ? GROUP BY `title`, `artist` ORDER BY count DESC LIMIT 5;"
            : "SELECT `title`, `artist`, COUNT(*) as count, MAX(`duration_ms`) as durationMs FROM `guild_track_stats` WHERE `guild_id` = ? AND `user_id` = ? GROUP BY `title`, `artist` ORDER BY count DESC LIMIT 5;";
          const trackParams = isGlobalScope ? [userId] : [guildId, userId];

          const [trackRows] = await this._pool.execute(trackSql, trackParams);
          const topTracks = (trackRows || []).map((r) => ({
            title: r.title,
            artist: r.artist,
            count: Number(r.count) || 0,
            durationMs: Number(r.durationMs) || 0,
          }));

          const artistMap = {};
          for (const t of topTracks) {
            if (t.artist && t.artist !== "Unknown Artist") {
              artistMap[t.artist] = (artistMap[t.artist] || 0) + t.count;
            }
          }
          const sortedArtists = Object.entries(artistMap).sort((a, b) => b[1] - a[1]);
          const topArtist = sortedArtists.length > 0 ? { name: sortedArtists[0][0], count: sortedArtists[0][1] } : null;

          const lbSql = isGlobalScope
            ? "SELECT `user_id`, COUNT(*) as plays FROM `guild_track_stats` WHERE `user_id` IS NOT NULL AND `user_id` != 'system' GROUP BY `user_id` ORDER BY plays DESC;"
            : "SELECT `user_id`, COUNT(*) as plays FROM `guild_track_stats` WHERE `guild_id` = ? AND `user_id` IS NOT NULL AND `user_id` != 'system' GROUP BY `user_id` ORDER BY plays DESC;";
          const lbParams = isGlobalScope ? [] : [guildId];

          const [leaderboardRows] = await this._pool.execute(lbSql, lbParams);
          let djRank = 1;
          let totalDjs = 1;
          if (leaderboardRows && leaderboardRows.length > 0) {
            totalDjs = leaderboardRows.length;
            const idx = leaderboardRows.findIndex((r) => String(r.user_id) === String(userId));
            if (idx !== -1) {
              djRank = idx + 1;
            }
          }

          return {
            totalTracks,
            totalHours,
            peakHour,
            topTracks,
            topArtist,
            djRank,
            totalDjs,
          };
        }
      } catch (err) {
        logger.warn("[GuildStats] MySQL getUserStats error:", err?.message);
      }
    }

    /* Fallback to local memory/file cache */
    const data = this._getGuildData(guildId);
    if (!data) return null;

    const totalTracks = Number(data.users?.[userId]) || 0;
    if (totalTracks === 0) return null;

    const userTracks = (data.recent || []).filter((r) => String(r.userId) === String(userId));
    let totalDurationMs = 0;
    const songMap = {};
    const artistMap = {};
    const hourMap = {};

    for (const item of userTracks) {
      totalDurationMs += Number(item.durationMs) || 0;
      const k = `${item.title}:::${item.artist}`;
      if (!songMap[k]) {
        songMap[k] = { title: item.title, artist: item.artist, count: 0 };
      }
      songMap[k].count += 1;
      if (item.artist && item.artist !== "Unknown Artist") {
        artistMap[item.artist] = (artistMap[item.artist] || 0) + 1;
      }
      const hr = new Date(item.ts || Date.now()).getHours();
      hourMap[hr] = (hourMap[hr] || 0) + 1;
    }

    const totalHours = Math.round((totalDurationMs / 3_600_000) * 10) / 10;
    const topTracks = Object.values(songMap)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const sortedArtists = Object.entries(artistMap).sort((a, b) => b[1] - a[1]);
    const topArtist = sortedArtists.length > 0 ? { name: sortedArtists[0][0], count: sortedArtists[0][1] } : null;

    let peakHourIndex = 12;
    let peakHourCount = 0;
    for (const [hr, cnt] of Object.entries(hourMap)) {
      if (cnt > peakHourCount) {
        peakHourCount = cnt;
        peakHourIndex = Number(hr);
      }
    }
    const peakHour = formatHour(peakHourIndex);

    const sortedUsers = Object.entries(data.users || {}).sort((a, b) => b[1] - a[1]);
    const totalDjs = Math.max(1, sortedUsers.length);
    const userIndex = sortedUsers.findIndex((u) => String(u[0]) === String(userId));
    const djRank = userIndex !== -1 ? userIndex + 1 : 1;

    return {
      totalTracks,
      totalHours,
      peakHour,
      topTracks,
      topArtist,
      djRank,
      totalDjs,
    };
  }

  /**
   * Schedule a debounced file save for a guild.
   * @param {string} guildId
   * @private
   */
  _scheduleSave(guildId) {
    if (this._saveTimers.has(guildId)) return;
    const timer = setTimeout(() => {
      this._saveTimers.delete(guildId);
      this.save(guildId);
    }, 5000);
    timer.unref?.();
    this._saveTimers.set(guildId, timer);
  }

  /**
   * Flush guild data to disk.
   * @param {string} guildId
   */
  save(guildId) {
    const data = this._cache.get(guildId);
    if (!data) return;
    try {
      if (!fs.existsSync(STATS_DIR)) {
        fs.mkdirSync(STATS_DIR, { recursive: true });
      }
      const filePath = path.join(STATS_DIR, `${guildId}.json`);
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
    } catch (e) {
      logger.warn(`[GuildStats] Failed to save stats for ${guildId}:`, e?.message);
    }
  }

  /**
   * Flush all active guild caches to disk immediately.
   */
  flushAll() {
    for (const [guildId, timer] of this._saveTimers) {
      clearTimeout(timer);
    }
    this._saveTimers.clear();
    for (const guildId of this._cache.keys()) {
      this.save(guildId);
    }
  }
}

export const GuildStats = new GuildStatsManager();
