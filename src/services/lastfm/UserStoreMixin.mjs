/**
 * @module src/services/lastfm/UserStoreMixin
 * @description User-session storage concern for LastFmManager: MySQL persistence of linked Last.fm accounts, the scrobble toggle and the auth token / URL / session exchange.
 *
 * These methods are applied onto the LastFmManager class prototype via
 * {@link applyMixins} — `this` is a LastFmManager instance.
 */

import { logger } from "../../core/Logger.mjs";
import { apiCall } from "./constants.mjs";

/**
 * @type {object}
 * @description User-store mixin — applied to LastFmManager.
 */
const UserStoreMixin = {
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
  },

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
  },

  /** @async Remove a user's Last.fm session from cache and DB. @param {string} userId */
  async removeUser(userId) {
    const pool = await this._getPool();
    const f = this._botIdFilter();
    await pool.execute(`DELETE FROM lastfm_users WHERE user_id = ?${f.where}`, [String(userId), ...f.params]);
    this._userCache.delete(userId);
  },

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
  },

  /** @async Request a Last.fm auth token. @returns {Promise<string>} The auth token. @throws {Error} If Last.fm is not enabled. */
  async getAuthToken() {
    this._assertEnabled();
    const data = await apiCall(
      { method: "auth.gettoken", api_key: this.apiKey },
      this.apiSecret
    );
    return data.token;
  },

  /** Build the Last.fm auth URL for user authorization. @param {string} token @returns {string} */
  getAuthUrl(token) {
    return `https://www.last.fm/api/auth/?api_key=${this.apiKey}&token=${token}`;
  },

  /** @async Exchange an auth token for a session. @param {string} token @returns {Promise<object>} The session object with key and name. @throws {Error} If Last.fm is not enabled. */
  async getSession(token) {
    this._assertEnabled();
    const data = await apiCall(
      { method: "auth.getsession", api_key: this.apiKey, token },
      this.apiSecret
    );
    return data.session;
  }
};

export default UserStoreMixin;
export { UserStoreMixin };
