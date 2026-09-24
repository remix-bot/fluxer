/**
 * @module src/services/lastfm/ScrobblingMixin
 * @description Scrobbling concern for LastFmManager: now-playing updates, scrobble submissions and per-user scrobble-count syncing.
 *
 * These methods are applied onto the LastFmManager class prototype via
 * {@link applyMixins} — `this` is a LastFmManager instance.
 */

import { logger } from "../../core/Logger.mjs";
import { apiCall, isLastFmFatalLinkError, isLastFmUserNotFound, noteStaleUser } from "./constants.mjs";

/**
 * @type {object}
 * @description Scrobbling mixin — applied to LastFmManager.
 */
const ScrobblingMixin = {
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
      if (isLastFmUserNotFound(err)) {
        if (noteStaleUser(this, userId)) {
          logger.warn(`[LastFm] Now-playing updates paused for ${userId}: Last.fm user not found (account renamed or deleted? attempting auto-recovery)`);
        }
        return;
      }
      if (isLastFmFatalLinkError(err)) {
        if (noteStaleUser(this, userId)) {
          logger.warn(`[LastFm] Now-playing updates paused for ${userId}: ${err.message} (session revoked — attempting auto-recovery, will auto-unlink if unrecoverable)`);
        }
        return;
      }
      logger.warn(`[LastFm] updateNowPlaying failed for ${userId}: ${err.message}`);
    }
  },

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
      if (isLastFmUserNotFound(err)) {
        if (noteStaleUser(this, userId)) {
          logger.warn(`[LastFm] Scrobbling paused for ${userId}: Last.fm user not found (account renamed or deleted? attempting auto-recovery)`);
        }
        return;
      }
      if (isLastFmFatalLinkError(err)) {
        if (noteStaleUser(this, userId)) {
          logger.warn(`[LastFm] Scrobbling paused for ${userId}: ${err.message} (session revoked — attempting auto-recovery, will auto-unlink if unrecoverable)`);
        }
        return;
      }
      logger.warn(`[LastFm] Scrobble failed for ${userId}: ${err.message}`);
    }
  },

  /**
   * Sync a user's scrobble count from Last.fm to the local database.
   * @async
   * @param {string} userId - The user ID.
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
      if (isLastFmUserNotFound(e)) {
        if (noteStaleUser(this, userId)) {
          logger.warn(`[LastFm] Scrobble count sync skipped for ${userId}: Last.fm user not found (account renamed or deleted? attempting auto-recovery)`);
        }
        return 0;
      }
      if (isLastFmFatalLinkError(e)) {
        if (noteStaleUser(this, userId)) {
          logger.warn(`[LastFm] Scrobble count sync skipped for ${userId}: ${e.message} (session revoked — attempting auto-recovery, will auto-unlink if unrecoverable)`);
        }
        return 0;
      }
      logger.warn("[LastFm] Error:", e?.message);
      return 0;
    }
  }
};

export default ScrobblingMixin;
export { ScrobblingMixin };
