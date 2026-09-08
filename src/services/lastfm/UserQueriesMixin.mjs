/**
 * @module src/services/lastfm/UserQueriesMixin
 * @description Per-user Last.fm queries: loved / top / recent tracks, profile info, playlists (scraped), top albums & artists, playback category resolution and weekly charts.
 *
 * These methods are applied onto the LastFmManager class prototype via
 * {@link applyMixins} — `this` is a LastFmManager instance.
 */

import { logger } from "../../core/Logger.mjs";
import { apiCall } from "./constants.mjs";

/**
 * @type {object}
 * @description User-queries mixin — applied to LastFmManager.
 */
const UserQueriesMixin = {
  /** @async Get a user's loved tracks. @param {string} userId @param {number} [limit=20] @returns {Promise<Array<{artist: string, name: string, url: string, image: string}>>} @throws {Error} If user not linked. */
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
  },

  /** @async Get a user's top tracks. @param {string} userId @param {string} [period="overall"] @param {number} [limit=20] @returns {Promise<Array<{artist: string, name: string, url: string, playcount: number, image: string}>>} @throws {Error} If user not linked. */
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
  },

  /** @async Get a user's recent tracks. @param {string} userId @param {number} [limit=20] @returns {Promise<Array<{artist: string, name: string, url: string, now: boolean, image: string}>>} @throws {Error} If user not linked. */
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
  },

  /**
   * Get a user's top tags from Last.fm.
   * @async
   * @param {string} userId - The user ID.
   * @param {number} [limit=20] - Maximum number of results.
   * @returns {Promise<Array<{name: string, url: string, count: number}>>} Top tags.
   */
  async getUserTopTags(userId, limit = 20) {
    if (!this.enabled) return [];

    const user = await this.getUser(userId);
    if (!user) return [];

    try {
      const data = await apiCall(
        {
          method:   "user.gettoptags",
          api_key:  this.apiKey,
          user:     user.username,
          limit,
        },
        this.apiSecret
      );

      return (data.toptags?.tag ?? []).map(t => ({
        name:  t.name ?? "",
        url:   t.url ?? "",
        count: Number(t.count ?? 0),
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  },

  /**
   * Get the list of weekly chart periods for a user.
   * @async
   * @param {string} userId - The user ID.
   * @returns {Promise<Array<{from: number, to: number}>>} Weekly chart periods with Unix timestamps.
   */
  async getUserWeeklyChartList(userId) {
    if (!this.enabled) return [];

    const user = await this.getUser(userId);
    if (!user) return [];

    try {
      const data = await apiCall(
        {
          method:  "user.getweeklychartlist",
          api_key: this.apiKey,
          user:    user.username,
        },
        this.apiSecret
      );

      return (data.weeklychartlist?.chart ?? []).map(c => ({
        from: Number(c.from ?? 0),
        to:   Number(c.to ?? 0),
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  },

  /**
   * Get a user's Last.fm profile info.
   * @async
   * @param {string} userId - The user ID.
   * @returns {Promise<object>} The Last.fm user object.
   * @throws {Error} If user is not linked.
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
  },

  /**
   * Get a user's Last.fm playlists by scraping their profile page.
   * @async
   * @param {string} userId - The user ID.
   * @returns {Promise<Array<{id: string, title: string, url: string, trackCount: number}>>} User's playlists.
   * @throws {Error} If user is not linked or fetch fails.
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

    const countRegex = /(\d+)\s+track/gi;
    const counts = [];
    let cMatch;
    while ((cMatch = countRegex.exec(html)) !== null) {
      counts.push(+cMatch[1]);
    }
    playlists.forEach((pl, i) => {
      pl.trackCount = counts[i] ?? 0;
    });

    return playlists;
  },

  /**
   * Get tracks from a user's Last.fm playlist by scraping the playlist page.
   * @async
   * @param {string} userId - The user ID.
   * @param {string|number} playlistId - Playlist number (1-based index) or URL.
   * @param {number} [limit=50] - Maximum number of tracks.
   * @returns {Promise<Array<{artist: string, name: string, url: string, image: string}>>} Playlist tracks.
   * @throws {Error} If user is not linked or playlist not found.
   */
  async getPlaylistTracks(userId, playlistId, limit = 50) {
    const user = await this.getUser(userId);
    if (!user) throw new Error("NOT_LINKED");

    let playlistUrl;

    if (/^\d+$/.test(String(playlistId))) {
      const playlists = await this.getPlaylists(userId);
      const idx = +playlistId - 1;
      if (idx < 0 || idx >= playlists.length) {
        throw new Error(`Playlist #${playlistId} not found. You have ${playlists.length} playlist(s). Use the lastfm playlists command to see them.`);
      }
      playlistUrl = playlists[idx].url;
    } else if (String(playlistId).startsWith("http")) {
      playlistUrl = String(playlistId);
    } else {
      playlistUrl = `https://www.last.fm/user/${user.username}/playlists/${playlistId}`;
    }

    const res = await fetch(playlistUrl, {
      headers: { "User-Agent": "RemixBot/1.0 (Last.fm Integration)" },
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch playlist page (HTTP ${res.status})`);
    }

    const html = await res.text();
    const tracks = [];

    const trackLinkRegex = /href="\/music\/([^"]+?)"[^>]*class="[^"]*(?:link-block-target|chartlist-name)[^"]*"[^>]*>([^<]+)<\/a>/gi;
    let tMatch;
    while ((tMatch = trackLinkRegex.exec(html)) !== null && tracks.length < limit) {
      const urlPath = decodeURIComponent(tMatch[1]);
      const name = tMatch[2].trim();
      const parts = urlPath.split("/");
      let artist = "Unknown";
      if (parts.length >= 1) {
        artist = parts[0].replace(/\+/g, " ");
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

    if (!tracks.length) {
      const broadRegex = /href="\/music\/([^"]+)"[^>]*>([^<]{2,80})<\/a>/gi;
      const seen = new Set();
      let bMatch;
      while ((bMatch = broadRegex.exec(html)) !== null && tracks.length < limit) {
        const urlPath = decodeURIComponent(bMatch[1]);
        const name = bMatch[2].trim();
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
  },

  /**
   * Get a user's top albums from Last.fm.
   * @async
   * @param {string} userId - The user ID.
   * @param {string} [period="overall"] - Time period (7day, 1month, 3month, 6month, 12month, overall).
   * @param {number} [limit=20] - Maximum number of results.
   * @returns {Promise<Array<{artist: string, name: string, url: string, playcount: number, image: string}>>} Top albums.
   * @throws {Error} If user is not linked.
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
  },

  /**
   * Get a user's top artists from Last.fm.
   * @async
   * @param {string} userId - The user ID.
   * @param {string} [period="overall"] - Time period (7day, 1month, 3month, 6month, 12month, overall).
   * @param {number} [limit=15] - Maximum number of results.
   * @returns {Promise<Array<{name: string, url: string, playcount: number, image: string}>>} Top artists.
   * @throws {Error} If user is not linked.
   */
  async getTopArtists(userId, period = "overall", limit = 15) {
    const user = await this.getUser(userId);
    if (!user) throw new Error("NOT_LINKED");

    const data = await apiCall(
      {
        method:   "user.gettopartists",
        api_key:  this.apiKey,
        user:     user.username,
        period,
        limit,
      },
      this.apiSecret
    );

    return (data.topartists?.artist ?? []).map(a => ({
      name:      a.name,
      url:       a.url ?? "",
      playcount: a.playcount ?? 0,
      image:     a.image?.[2]?.["#text"] ?? a.image?.[1]?.["#text"] ?? "",
    }));
  },

  /**
   * Get tracks from a user's Last.fm data for playback based on category.
   * @async
   * @param {string} userId - The user ID.
   * @param {string} category - One of: loved, top, recent, playlist, albums, artists.
   * @param {object} [options={}] - Additional options.
   * @param {number} [options.limit] - Maximum number of tracks.
   * @param {string} [options.period] - Time period for top/albums/artists categories.
   * @param {string|number} [options.playlistId] - Playlist ID (required for playlist category).
   * @returns {Promise<{username: string, tracks: Array<{query: string, artist: string, name: string, url: string, image?: string}>}>} Tracks ready for playback.
   * @throws {Error} If user is not linked or category is unknown.
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
        tracks = tracks.filter(t => !t.now);
        break;
      case "playlist":
        if (!options.playlistId) throw new Error("Playlist ID required. Use the lastfm playlists command to see your playlists, then use the lastfm play playlist command with a number.");
        tracks = await this.getPlaylistTracks(userId, options.playlistId, limit);
        break;
      case "albums":
        const albums = await this.getTopAlbums(userId, options.period ?? "overall", limit);
        tracks = albums.map(a => ({
          artist: a.artist,
          name:   a.name,
          url:    a.url,
          query:  `${a.artist} ${a.name} album`,
          image:  a.image ?? "",
        }));
        return {
          username: user.username,
          tracks,
        };
      case "artists":
        const topArtistsList = await this.getTopArtists(userId, options.period ?? "overall", limit);
        const artistTrackResults = [];
        const artistConcurrency = 3;
        for (let ai = 0; ai < topArtistsList.length; ai += artistConcurrency) {
          const artistBatch = topArtistsList.slice(ai, ai + artistConcurrency);
          const artistResults = await Promise.allSettled(
            artistBatch.map(async (ar) => {
              try {
                const topTracks = await this.getArtistTopTracks(ar.name, 3);
                return topTracks.map(t => ({
                  artist: t.artist ?? ar.name,
                  name: t.name,
                  url: t.url,
                  query: `${t.name} ${t.artist ?? ar.name}`,
                  image: t.image ?? ar.image ?? "",
                }));
              } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
            })
          );
          for (const r of artistResults) {
            if (r.status === "fulfilled" && r.value) {
              artistTrackResults.push(...r.value);
            }
          }
        }
        return {
          username: user.username,
          tracks: artistTrackResults.slice(0, limit * 3),
        };
      default:
        throw new Error(`Unknown Last.fm category: ${category}. Use loved, top, recent, playlist, albums, or artists.`);
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
  },

  /**
   * Get a user's Last.fm friends list.
   * @async
   * @param {string} userId - The user ID.
   * @param {number} [limit=20] - Maximum number of results.
   * @returns {Promise<Array<{name: string, url: string, image: string, realname: string, country: string}>>} Friends list.
   */
  async getUserFriends(userId, limit = 20) {
    if (!this.enabled) return [];
    const user = await this.getUser(userId);
    if (!user) return [];
    try {
      const data = await apiCall({
        method: "user.getfriends",
        api_key: this.apiKey,
        user: user.username,
        limit,
      }, this.apiSecret);
      return (data.friends?.user ?? []).map(f => ({
        name: f.name ?? "",
        url: f.url ?? "",
        image: f.image?.[2]?.["#text"] ?? f.image?.[1]?.["#text"] ?? "",
        realname: f.realname ?? "",
        country: f.country ?? "",
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  },

  /**
   * Get a user's weekly artist chart for a specific time range.
   * @async
   * @param {string} userId - The user ID.
   * @param {number|null} [from] - Start Unix timestamp.
   * @param {number|null} [to] - End Unix timestamp.
   * @returns {Promise<Array<{name: string, url: string, playcount: number, image: string}>>} Weekly artist chart.
   */
  async getUserWeeklyArtistChart(userId, from = null, to = null) {
    if (!this.enabled) return [];
    const user = await this.getUser(userId);
    if (!user) return [];
    try {
      const params = {
        method: "user.getweeklyartistchart",
        api_key: this.apiKey,
        user: user.username,
      };
      if (from) params.from = from;
      if (to) params.to = to;
      const data = await apiCall(params, this.apiSecret);
      return (data.weeklyartistchart?.artist ?? []).map(a => ({
        name: a.name ?? "",
        url: a.url ?? "",
        playcount: Number(a.playcount ?? 0),
        image: a.image?.[2]?.["#text"] ?? a.image?.[1]?.["#text"] ?? "",
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  },

  /**
   * Get a user's weekly track chart for a specific time range.
   * @async
   * @param {string} userId - The user ID.
   * @param {number|null} [from] - Start Unix timestamp.
   * @param {number|null} [to] - End Unix timestamp.
   * @returns {Promise<Array<{name: string, artist: string, url: string, playcount: number, image: string}>>} Weekly track chart.
   */
  async getUserWeeklyTrackChart(userId, from = null, to = null) {
    if (!this.enabled) return [];
    const user = await this.getUser(userId);
    if (!user) return [];
    try {
      const params = {
        method: "user.getweeklytrackchart",
        api_key: this.apiKey,
        user: user.username,
      };
      if (from) params.from = from;
      if (to) params.to = to;
      const data = await apiCall(params, this.apiSecret);
      return (data.weeklytrackchart?.track ?? []).map(t => ({
        name: t.name ?? "",
        artist: t.artist?.["#text"] ?? t.artist ?? "",
        url: t.url ?? "",
        playcount: Number(t.playcount ?? 0),
        image: t.image?.[2]?.["#text"] ?? t.image?.[1]?.["#text"] ?? "",
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  },

  /**
   * Get a user's weekly album chart for a specific time range.
   * @async
   * @param {string} userId - The user ID.
   * @param {number|null} [from] - Start Unix timestamp.
   * @param {number|null} [to] - End Unix timestamp.
   * @returns {Promise<Array<{name: string, artist: string, url: string, playcount: number, image: string}>>} Weekly album chart.
   */
  async getUserWeeklyAlbumChart(userId, from = null, to = null) {
    if (!this.enabled) return [];
    const user = await this.getUser(userId);
    if (!user) return [];
    try {
      const params = {
        method: "user.getweeklyalbumchart",
        api_key: this.apiKey,
        user: user.username,
      };
      if (from) params.from = from;
      if (to) params.to = to;
      const data = await apiCall(params, this.apiSecret);
      return (data.weeklyalbumchart?.album ?? []).map(a => ({
        name: a.name ?? "",
        artist: a.artist?.["#text"] ?? a.artist ?? "",
        url: a.url ?? "",
        playcount: Number(a.playcount ?? 0),
        image: a.image?.[2]?.["#text"] ?? a.image?.[1]?.["#text"] ?? "",
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  }
};

export default UserQueriesMixin;
export { UserQueriesMixin };
