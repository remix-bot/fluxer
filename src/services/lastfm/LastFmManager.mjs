/**
 * @module src/services/lastfm/LastFmManager
 * @description Last.fm API integration for scrobbling, now-playing updates,
 * loved tracks, and user session management with MySQL persistence.
 *
 * Base class of the split Last.fm manager: configuration, constructor, MySQL
 * pool + schema setup, multi-bot isolation (bot_id) and the small helpers
 * shared by every concern. User-session storage, scrobbling, track/artist/
 * album/tag queries, user chart queries and server statistics live in the
 * mixin modules applied to this class at the bottom of the file.
 */

import { logger } from "../../core/Logger.mjs";
import { normalizeTrackText } from "./constants.mjs";
import { applyMixins } from "../../utils/mixins.mjs";
import { parseLastFmUrl, isLastFmUrl } from "./urlUtils.mjs";
import UserStoreMixin from "./UserStoreMixin.mjs";
import ScrobblingMixin from "./ScrobblingMixin.mjs";
import TrackQueriesMixin from "./TrackQueriesMixin.mjs";
import UserQueriesMixin from "./UserQueriesMixin.mjs";
import ServerStatsMixin from "./ServerStatsMixin.mjs";

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

  /** @private Throw if Last.fm integration is not enabled/configured. @throws {Error} If apiKey or apiSecret is missing. */
  _assertEnabled() {
    if (!this.enabled) throw new Error("Last.fm integration is not configured (missing apiKey/apiSecret).");
  }

  /** @private Increment a user's scrobble_count in the database by 1 (fire-and-forget). @param {string} userId - The user ID. */
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

applyMixins(LastFmManager, UserStoreMixin, ScrobblingMixin, TrackQueriesMixin, UserQueriesMixin, ServerStatsMixin);

export { parseLastFmUrl, isLastFmUrl } from "./urlUtils.mjs";
