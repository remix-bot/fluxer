/**
 * @module src/music/TrackStats
 * @description Persistent playback counter tracking total songs and tracks played across shards.
 * Backed by Redis with atomic INCR and debounced local storage in storage/stats.json.
 */

import fs from "node:fs";
import path from "node:path";
import { logger } from "../core/Logger.mjs";

const STATS_FILE = path.join(process.cwd(), "storage", "stats.json");
const REDIS_KEY = "fluxer:stats:tracks_played";

class TrackStatsManager {
  constructor() {
    this._tracksPlayed = 0;
    this._extraData = {};
    this._redis = null;
    this._saveTimer = null;
    this._loadFromFile();
  }

  _loadFromFile() {
    try {
      if (fs.existsSync(STATS_FILE)) {
        const raw = JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
        if (raw && typeof raw === "object") {
          this._extraData = { ...raw };
          const count = typeof raw.songs === "number"
            ? raw.songs
            : (typeof raw.tracksPlayed === "number" ? raw.tracksPlayed : 0);
          this._tracksPlayed = Math.max(0, count);
        }
      }
    } catch (e) {
      logger.warn("[TrackStats] Failed to read stats.json:", e?.message);
    }
  }

  setRedis(redisHandler) {
    this._redis = redisHandler;
    this._syncRedis();
  }

  async _syncRedis() {
    const client = this._redis?.client;
    if (!client || !client.isOpen) return;

    try {
      await client.set(REDIS_KEY, String(this._tracksPlayed), { NX: true });
      const val = await client.get(REDIS_KEY);
      if (val != null) {
        const parsed = parseInt(val, 10);
        if (Number.isFinite(parsed)) {
          this._tracksPlayed = Math.max(this._tracksPlayed, parsed);
        }
      }
    } catch (e) {
      logger.warn("[TrackStats] Redis sync error:", e?.message);
    }
  }

  increment(delta = 1) {
    this._tracksPlayed += delta;

    const client = this._redis?.client;
    if (client && client.isOpen) {
      client.incrBy(REDIS_KEY, delta).catch((e) => {
        logger.warn("[TrackStats] Redis incr error:", e?.message);
      });
    }

    this._scheduleSave();
  }

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.save();
    }, 5000);
    this._saveTimer.unref?.();
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
      const payload = {
        ...this._extraData,
        songs: this._tracksPlayed,
      };
      fs.writeFileSync(STATS_FILE, JSON.stringify(payload, null, 2));
    } catch (e) {
      logger.warn("[TrackStats] Failed to save stats.json:", e?.message);
    }
  }

  async getTracksPlayed() {
    const client = this._redis?.client;
    if (client && client.isOpen) {
      try {
        const val = await client.get(REDIS_KEY);
        if (val != null) {
          const parsed = parseInt(val, 10);
          if (Number.isFinite(parsed)) {
            this._tracksPlayed = Math.max(this._tracksPlayed, parsed);
            return this._tracksPlayed;
          }
        }
      } catch (_) {}
    }
    return this._tracksPlayed;
  }
}

export const TrackStats = new TrackStatsManager();
