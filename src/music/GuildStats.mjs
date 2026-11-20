/**
 * @module src/music/GuildStats
 * @description In-memory and persisted per-guild music analytics tracker.
 * Tracks track playback history, listening hours, user engagement, and leaderboards.
 */

import fs from "node:fs";
import path from "node:path";
import { logger } from "../core/Logger.mjs";

const STATS_DIR = path.join(process.cwd(), "storage", "guild_stats");

/**
 * Format 24-hour index into standard 12-hour display.
 * @param {number} hour
 * @returns {string}
 */
function formatHour(hour) {
  const h = hour % 24;
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
   * Record a track playback event for a specific guild.
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
  }

  /**
   * Get top tracks for a guild with timeframe filtering.
   * @param {string} guildId
   * @param {string} [timeframe="month"] - "week" | "month" | "all"
   * @param {number} [limit=10]
   * @returns {{tracks: Array, topArtist: {name: string, count: number}|null}}
   */
  getTopTracks(guildId, timeframe = "month", limit = 10) {
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

    const tracks = Object.values(trackMap)
      .sort((a, b) => b.count - a.count)
      .slice(0, Math.max(1, Math.min(25, limit)));

    let topArtist = null;
    const sortedArtists = Object.entries(artistMap).sort((a, b) => b[1] - a[1]);
    if (sortedArtists.length > 0 && sortedArtists[0][0] !== "Unknown Artist") {
      topArtist = { name: sortedArtists[0][0], count: sortedArtists[0][1] };
    }

    return { tracks, topArtist };
  }

  /**
   * Get community monthly wrapped summary statistics.
   * @param {string} guildId
   * @returns {object|null}
   */
  getWrapped(guildId) {
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
   * Get global top tracks across all servers.
   * @param {number} [limit=10]
   * @returns {{tracks: Array, topArtist: {name: string, count: number}|null}}
   */
  getGlobalTopTracks(limit = 10) {
    const globalData = this._getGuildData("global");
    if (!globalData || globalData.totalPlays === 0) {
      return { tracks: [], topArtist: null };
    }
    const tracks = Object.values(globalData.songs || {})
      .sort((a, b) => b.count - a.count)
      .slice(0, Math.max(1, Math.min(25, limit)));

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
   * Get global wrapped recap across all servers.
   * @param {number} [fallbackServerCount=0]
   * @returns {object|null}
   */
  getGlobalWrapped(fallbackServerCount = 0) {
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
}

export const GuildStats = new GuildStatsManager();
