/**
 * @module src/music/TrackStats
 * @description Persistent playback counter tracking total and per-user songs and tracks played in MySQL.
 * Backed by MySQL (user_tracks and bot_stats tables), Redis with atomic INCR, and debounced local storage in storage/stats.json.
 */

import fs from "node:fs";
import path from "node:path";
import { logger } from "../core/Logger.mjs";

const STATS_FILE = path.join(process.cwd(), "storage", "stats.json");
const REDIS_KEY = "fluxer:stats:tracks_played";
const REDIS_USER_PREFIX = "fluxer:stats:user_tracks:";
const BASELINE_SONGS = 4814;

class TrackStatsManager {
  constructor() {
    this._tracksPlayed = BASELINE_SONGS;
    this._extraData = {};
    this._pool = null;
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
          this._tracksPlayed = Math.max(BASELINE_SONGS, count);
        }
      }
    } catch (e) {
      logger.warn("[TrackStats] Failed to read stats.json:", e?.message);
    }
  }

  setPool(pool) {
    this._pool = pool;
    this._initDatabase().catch((e) => {
      logger.warn("[TrackStats] Database init error:", e?.message);
    });
  }

  async _initDatabase() {
    if (!this._pool) return;
    try {
      await this._pool.execute(`
        CREATE TABLE IF NOT EXISTS \`user_tracks\` (
          \`user_id\` VARCHAR(32) NOT NULL PRIMARY KEY,
          \`tracks_played\` BIGINT NOT NULL DEFAULT 0,
          \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      await this._pool.execute(`
        CREATE TABLE IF NOT EXISTS \`bot_stats\` (
          \`id\` VARCHAR(32) NOT NULL PRIMARY KEY DEFAULT 'global',
          \`tracks_played\` BIGINT NOT NULL DEFAULT 0,
          \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      await this._pool.execute(`
        INSERT IGNORE INTO \`bot_stats\` (\`id\`, \`tracks_played\`) VALUES ('global', ?);
      `, [this._tracksPlayed]);

      const [rows] = await this._pool.execute(`
        SELECT \`tracks_played\` FROM \`bot_stats\` WHERE \`id\` = 'global' LIMIT 1;
      `);

      if (rows && rows.length > 0 && typeof rows[0].tracks_played === "number") {
        const dbCount = rows[0].tracks_played;
        if (dbCount < this._tracksPlayed) {
          await this._pool.execute(`
            UPDATE \`bot_stats\` SET \`tracks_played\` = ? WHERE \`id\` = 'global';
          `, [this._tracksPlayed]);
        } else {
          this._tracksPlayed = dbCount;
          this.save();
        }
      }

      await this._syncRedis();
    } catch (e) {
      logger.warn("[TrackStats] Failed to initialize MySQL tables:", e?.message);
    }
  }

  setRedis(redisHandler) {
    this._redis = redisHandler;
    const client = this._redis?.client;
    if (client) {
      if (client.isOpen) {
        this._syncRedis();
      } else {
        client.on("ready", () => this._syncRedis());
      }
    }
  }

  async _syncRedis() {
    const client = this._redis?.client;
    if (!client || !client.isOpen) return;

    try {
      const val = await client.get(REDIS_KEY);
      if (val != null) {
        const parsed = parseInt(val, 10);
        if (Number.isFinite(parsed)) {
          if (parsed > this._tracksPlayed) {
            this._tracksPlayed = parsed;
            this.save();
            if (this._pool) {
              await this._pool.execute(`
                UPDATE \`bot_stats\` SET \`tracks_played\` = ? WHERE \`id\` = 'global';
              `, [parsed]).catch(() => {});
            }
          } else if (this._tracksPlayed > parsed) {
            await client.set(REDIS_KEY, String(this._tracksPlayed));
          }
        }
      } else {
        await client.set(REDIS_KEY, String(this._tracksPlayed));
      }
    } catch (e) {
      logger.warn("[TrackStats] Redis sync error:", e?.message);
    }
  }

  async increment(userId = null, delta = 1) {
    this._tracksPlayed += delta;

    const client = this._redis?.client;
    if (client && client.isOpen) {
      client.incrBy(REDIS_KEY, delta).catch((e) => {
        logger.warn("[TrackStats] Redis incr error:", e?.message);
      });
      if (userId && typeof userId === "string" && userId !== "system") {
        client.incrBy(`${REDIS_USER_PREFIX}${userId}`, delta).catch(() => {});
      }
    }

    if (this._pool) {
      try {
        await this._pool.execute(`
          INSERT INTO \`bot_stats\` (\`id\`, \`tracks_played\`) VALUES ('global', ?)
          ON DUPLICATE KEY UPDATE \`tracks_played\` = \`tracks_played\` + ?;
        `, [this._tracksPlayed, delta]);

        if (userId && typeof userId === "string" && userId !== "system") {
          await this._pool.execute(`
            INSERT INTO \`user_tracks\` (\`user_id\`, \`tracks_played\`) VALUES (?, ?)
            ON DUPLICATE KEY UPDATE \`tracks_played\` = \`tracks_played\` + ?;
          `, [userId, delta, delta]);
        }
      } catch (err) {
        logger.warn("[TrackStats] MySQL increment error:", err?.message);
      }
    }

    this._scheduleSave();
  }

  async getUserTracksPlayed(userId) {
    if (!userId) return 0;
    const cleanUid = String(userId);

    const client = this._redis?.client;
    if (client && client.isOpen) {
      try {
        const val = await client.get(`${REDIS_USER_PREFIX}${cleanUid}`);
        if (val != null) {
          const parsed = parseInt(val, 10);
          if (Number.isFinite(parsed)) return parsed;
        }
      } catch (_) {}
    }

    if (this._pool) {
      try {
        const [rows] = await this._pool.execute(`
          SELECT \`tracks_played\` FROM \`user_tracks\` WHERE \`user_id\` = ? LIMIT 1;
        `, [cleanUid]);
        const count = rows?.[0]?.tracks_played ?? 0;
        if (client && client.isOpen && count > 0) {
          client.set(`${REDIS_USER_PREFIX}${cleanUid}`, String(count)).catch(() => {});
        }
        return count;
      } catch (err) {
        logger.warn("[TrackStats] MySQL getUserTracksPlayed error:", err?.message);
      }
    }
    return 0;
  }

  async getTopUsers(limit = 10) {
    if (!this._pool) return [];
    try {
      const [rows] = await this._pool.execute(`
        SELECT \`user_id\`, \`tracks_played\` FROM \`user_tracks\` ORDER BY \`tracks_played\` DESC LIMIT ?;
      `, [Math.max(1, Math.min(50, Number(limit) || 10))]);
      return rows ?? [];
    } catch (err) {
      logger.warn("[TrackStats] MySQL getTopUsers error:", err?.message);
      return [];
    }
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
            if (parsed > this._tracksPlayed) {
              this._tracksPlayed = parsed;
              this._scheduleSave();
            }
            return this._tracksPlayed;
          }
        } else {
          await client.set(REDIS_KEY, String(this._tracksPlayed));
        }
      } catch (_) {}
    }

    if (this._pool) {
      try {
        const [rows] = await this._pool.execute(`
          SELECT \`tracks_played\` FROM \`bot_stats\` WHERE \`id\` = 'global' LIMIT 1;
        `);
        if (rows && rows.length > 0 && typeof rows[0].tracks_played === "number") {
          this._tracksPlayed = Math.max(this._tracksPlayed, rows[0].tracks_played);
          return this._tracksPlayed;
        }
      } catch (_) {}
    }

    return this._tracksPlayed;
  }
}

export const TrackStats = new TrackStatsManager();
