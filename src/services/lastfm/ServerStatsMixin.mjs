/**
 * @module src/services/lastfm/ServerStatsMixin
 * @description Server/guild statistics concern for LastFmManager: who-knows lookups, user comparison, affinity and crowns, the scrobble leaderboard and global scrobble / linked-user totals.
 *
 * These methods are applied onto the LastFmManager class prototype via
 * {@link applyMixins} — `this` is a LastFmManager instance.
 */

import { logger } from "../../core/Logger.mjs";

/**
 * @type {object}
 * @description Server-stats mixin — applied to LastFmManager.
 */
const ServerStatsMixin = {
  /**
   * Get who knows an artist among a list of users, ranked by playcount.
   * @async
   * @param {string} artist - The artist name.
   * @param {Array<string>} userIds - Array of user IDs.
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
  },

  /**
   * Get who knows a specific track among a list of users, ranked by playcount.
   * @async
   * @param {string} artist - The artist name.
   * @param {string} track - The track name.
   * @param {Array<string>} userIds - Array of user IDs.
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
  },

  /**
   * Get who knows a specific album among a list of users, ranked by playcount.
   * @async
   * @param {string} artist - The artist name.
   * @param {string} album - The album name.
   * @param {Array<string>} userIds - Array of user IDs.
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
  },

  /**
   * Compare two users' top artists and compute a match percentage.
   * @async
   * @param {string} userId1 - First user ID.
   * @param {string} userId2 - Second user ID.
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
  },

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
  },

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
  },

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
  },

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
  },

  /**
   * Compute affinity (common artists) between multiple users.
   * @async
   * @param {Array<string>} userIds - Array of user IDs (minimum 2).
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
  },

  /**
   * Get a user's "crowns" — artists where they have the highest playcount among the given users.
   * @async
   * @param {string} userId - The user ID to check crowns for.
   * @param {Array<string>} userIds - Array of all user IDs to compare against.
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
};

export default ServerStatsMixin;
export { ServerStatsMixin };
