/**
 * @module src/services/lastfm/TrackQueriesMixin
 * @description Read-only track / artist / album / tag / geo / chart Last.fm API queries (plus track search and love/unlove) for LastFmManager.
 *
 * These methods are applied onto the LastFmManager class prototype via
 * {@link applyMixins} — `this` is a LastFmManager instance.
 */

import { logger } from "../../core/Logger.mjs";
import { apiCall, normalizeTrackText } from "./constants.mjs";

/**
 * @type {object}
 * @description Track-queries mixin — applied to LastFmManager.
 */
const TrackQueriesMixin = {
  /** @async Get track info from Last.fm. @param {string} artist @param {string} track @param {string} [userId] @returns {Promise<object|null>} Track info object or null. */
  async getTrackInfo(artist, track, userId = null) {
    if (!this.enabled) return null;

    const params = {
      method:    "track.getinfo",
      api_key:   this.apiKey,
      artist,
      track,
    };

    if (userId) {
      const user = await this.getUser(userId);
      if (user) params.username = user.username;
    }

    try {
      const data = await apiCall(params, this.apiSecret);
      return data.track;
    } catch (e) {
        logger.warn("[LastFm] Error:", e?.message);
        return null;
    }
  },

  /** @async Love a track on Last.fm. @param {string} userId @param {string} artist @param {string} track @throws {Error} If user not linked. */
  async loveTrack(userId, artist, track) {
    if (!this.enabled) return;
    const user = await this.getUser(userId);
    if (!user) throw new Error("NOT_LINKED");

    await apiCall(
      {
        method:     "track.love",
        api_key:    this.apiKey,
        sk:         user.sessionKey,
        artist,
        track,
      },
      this.apiSecret,
      true
    );
  },

  /** @async Unlove a track on Last.fm. @param {string} userId @param {string} artist @param {string} track @throws {Error} If user not linked. */
  async unloveTrack(userId, artist, track) {
    if (!this.enabled) return;
    const user = await this.getUser(userId);
    if (!user) throw new Error("NOT_LINKED");

    await apiCall(
      {
        method:     "track.unlove",
        api_key:    this.apiKey,
        sk:         user.sessionKey,
        artist,
        track,
      },
      this.apiSecret,
      true
    );
  },

  /** @async Search for tracks on Last.fm and score results by relevance. @param {string} query @param {number} [limit=10] @returns {Promise<Array<{artist: string, name: string, url: string, image: string}>|null>} */
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

      const nameLower = name.toLowerCase();
      const artistLower = artist.toLowerCase();
      const urlLower = String(track.url ?? "").toLowerCase();
      const fullText = `${nameLower} ${artistLower} ${urlLower}`;

      const negativePatterns = [
        /\bofficial (?:lyric|lyrics)\s*video\b/,
        /\bofficial video\b/,
        /\bofficial music video\b/,
        /\blyric video\b/,
        /\blyrics video\b/,
        /\bmusic video\b/,
        /\bofficial audio\b/,
        /\bvisuali[sz]er\b/,
        /\bkaraoke\b/,
        /\bcover\b/,
        /\bremix\b/,
        /\bacoustic\b/,
        /\blive\b/,
        /\bsped up\b/,
        /\bslowed\b/,
        /\breverb\b/,
        /\bnightcore\b/,
        /\b8d\b/,
        /\bclip officiel\b/,
        /\bvideo oficial\b/,
        /\bperformance\b/,
      ];

      for (const re of negativePatterns) {
        if (re.test(fullText)) {
          score -= 30;
          break;
        }
      }

      const labelKeywords = [
        /\bpictures\b/i,
        /\banimation\b/i,
        /\brecords?\b/i,
        /\bstudios?\b/i,
        /\bentertainment\b/i,
        /\bproductions?\b/i,
        /\bmusic\s+(group|corp|inc|llc)\b/i,
        /\brecordings?\b/i,
        /\blabel\b/i,
      ];
      for (const re of labelKeywords) {
        if (re.test(artist)) {
          score -= 20;
          break;
        }
      }

      if (/^["""].*["""]$/.test(name) || /["""]/.test(name)) {
        score -= 15;
      }

      if (urlLower.includes("/_/")) {
        score += 5;
      }

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
  },

  /**
   * Get similar tracks for a given artist and track from Last.fm.
   * @async
   * @param {string} artist - The artist name.
   * @param {string} track - The track name.
   * @param {number} [limit=5] - Maximum number of results.
   * @returns {Promise<Array<{artist: string, name: string, url: string, match: number}>>} Filtered similar tracks (match > 0.1).
   */
  async getSimilarTracks(artist, track, limit = 5) {
    if (!this.enabled) return [];

    try {
      const data = await apiCall(
        {
          method:   "track.getsimilar",
          api_key:  this.apiKey,
          artist,
          track,
          limit,
        },
        this.apiSecret
      );

      return (data.similartracks?.track ?? []).map(t => ({
        artist: t.artist?.name ?? "Unknown",
        name:   t.name,
        url:    t.url ?? "",
        match:  parseFloat(t.match ?? 0),
      })).filter(t => t.match > 0.1);
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  },

  /**
   * Get detailed artist info from Last.fm.
   * @async
   * @param {string} artist - The artist name.
   * @param {string|null} [userId] - Optional user ID to include user playcount.
   * @returns {Promise<object|null>} Artist info object with name, url, image, tags, bio, stats, similar, and userplaycount, or null.
   */
  async getArtistInfo(artist, userId = null) {
    if (!this.enabled) return null;

    const params = {
      method:   "artist.getinfo",
      api_key:  this.apiKey,
      artist,
    };

    if (userId) {
      const user = await this.getUser(userId);
      if (user) params.username = user.username;
    }

    try {
      const data = await apiCall(params, this.apiSecret);
      const a = data.artist;
      if (!a) return null;

      return {
        name:          a.name ?? "",
        url:           a.url ?? "",
        image:         a.image?.[2]?.["#text"] ?? a.image?.[1]?.["#text"] ?? "",
        tags:          (a.tags?.tag ?? []).map(t => t.name ?? t),
        bio:           a.bio?.summary ?? a.bio?.content ?? "",
        stats: {
          listeners:  Number(a.stats?.listeners ?? 0),
          playcount:  Number(a.stats?.playcount ?? 0),
        },
        similar:       (a.similar?.artist ?? []).map(s => ({
          name:  s.name ?? "",
          url:   s.url ?? "",
          image: s.image?.[2]?.["#text"] ?? s.image?.[1]?.["#text"] ?? "",
        })),
        userplaycount: a.stats?.userplaycount ? Number(a.stats.userplaycount) : null,
      };
    } catch (e) {
        logger.warn("[LastFm] Error:", e?.message);
        return null;
    }
  },

  /**
   * Get detailed album info from Last.fm.
   * @async
   * @param {string} artist - The artist name.
   * @param {string} album - The album name.
   * @param {string|null} [userId] - Optional user ID to include user playcount.
   * @returns {Promise<object|null>} Album info object with name, artist, url, image, tags, tracks, and userplaycount, or null.
   */
  async getAlbumInfo(artist, album, userId = null) {
    if (!this.enabled) return null;

    const params = {
      method:   "album.getinfo",
      api_key:  this.apiKey,
      artist,
      album,
    };

    if (userId) {
      const user = await this.getUser(userId);
      if (user) params.username = user.username;
    }

    try {
      const data = await apiCall(params, this.apiSecret);
      const a = data.album;
      if (!a) return null;

      return {
        name:          a.name ?? "",
        artist:        a.artist ?? "",
        url:           a.url ?? "",
        image:         a.image?.[2]?.["#text"] ?? a.image?.[1]?.["#text"] ?? "",
        tags:          (a.tags?.tag ?? []).map(t => t.name ?? t),
        tracks:        (a.tracks?.track ?? []).map(t => ({
          name:      t.name ?? "",
          url:       t.url ?? "",
          duration:  Number(t.duration ?? 0),
          playcount: Number(t.playcount ?? 0),
        })),
        userplaycount: a.userplaycount ? Number(a.userplaycount) : null,
      };
    } catch (e) {
        logger.warn("[LastFm] Error:", e?.message);
        return null;
    }
  },

  /**
   * Get top tracks for an artist from Last.fm.
   * @async
   * @param {string} artist - The artist name.
   * @param {number} [limit=10] - Maximum number of results.
   * @returns {Promise<Array<{artist: string, name: string, url: string, playcount: number, image: string}>>} Top tracks.
   */
  async getArtistTopTracks(artist, limit = 10) {
    if (!this.enabled) return [];

    try {
      const data = await apiCall(
        {
          method:   "artist.gettoptracks",
          api_key:  this.apiKey,
          artist,
          limit,
        },
        this.apiSecret
      );

      return (data.toptracks?.track ?? []).map(t => ({
        artist:     t.artist?.name ?? artist,
        name:       t.name ?? "",
        url:        t.url ?? "",
        playcount:  Number(t.playcount ?? 0),
        image:      t.image?.[2]?.["#text"] ?? t.image?.[1]?.["#text"] ?? "",
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  },

  /**
   * Get top albums for an artist from Last.fm.
   * @async
   * @param {string} artist - The artist name.
   * @param {number} [limit=10] - Maximum number of results.
   * @returns {Promise<Array<{name: string, artist: string, url: string, playcount: number, image: string}>>} Top albums.
   */
  async getArtistTopAlbums(artist, limit = 10) {
    if (!this.enabled) return [];

    try {
      const data = await apiCall(
        {
          method:   "artist.gettopalbums",
          api_key:  this.apiKey,
          artist,
          limit,
        },
        this.apiSecret
      );

      return (data.topalbums?.album ?? []).map(a => ({
        name:      a.name ?? "",
        artist:    a.artist?.name ?? artist,
        url:       a.url ?? "",
        playcount: Number(a.playcount ?? 0),
        image:     a.image?.[2]?.["#text"] ?? a.image?.[1]?.["#text"] ?? "",
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  },

  /**
   * Get similar artists for a given artist from Last.fm.
   * @async
   * @param {string} artist - The artist name.
   * @param {number} [limit=10] - Maximum number of results.
   * @returns {Promise<Array<{name: string, url: string, image: string, match: number}>>} Similar artists.
   */
  async getSimilarArtists(artist, limit = 10) {
    if (!this.enabled) return [];

    try {
      const data = await apiCall(
        {
          method:   "artist.getsimilar",
          api_key:  this.apiKey,
          artist,
          limit,
        },
        this.apiSecret
      );

      return (data.similarartists?.artist ?? []).map(a => ({
        name:    a.name ?? "",
        url:     a.url ?? "",
        image:   a.image?.[2]?.["#text"] ?? a.image?.[1]?.["#text"] ?? "",
        match:   parseFloat(a.match ?? 0),
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  },

  /**
   * Get information about a specific tag from Last.fm.
   * @async
   * @param {string} tag - The tag name.
   * @returns {Promise<object|null>} Tag info with name, url, reach, count, and summary, or null.
   */
  async getTagInfo(tag) {
    if (!this.enabled) return null;

    try {
      const data = await apiCall(
        {
          method:  "tag.getinfo",
          api_key: this.apiKey,
          tag,
        },
        this.apiSecret
      );

      const t = data.tag;
      if (!t) return null;

      return {
        name:    t.name ?? "",
        url:     t.url ?? "",
        reach:   Number(t.reach ?? 0),
        count:   Number(t.taggings?.total ?? t.total ?? 0),
        summary: t.wiki?.summary ?? "",
      };
    } catch (e) {
        logger.warn("[LastFm] Error:", e?.message);
        return null;
    }
  },

  /**
   * Get top tracks for a tag from Last.fm.
   * @async
   * @param {string} tag - The tag name.
   * @param {number} [limit=10] - Maximum number of results.
   * @returns {Promise<Array<{artist: string, name: string, url: string, playcount: number, image: string}>>} Tag's top tracks.
   */
  async getTagTopTracks(tag, limit = 10) {
    if (!this.enabled) return [];

    try {
      const data = await apiCall(
        {
          method:   "tag.gettoptracks",
          api_key:  this.apiKey,
          tag,
          limit,
        },
        this.apiSecret
      );

      return (data.tracks?.track ?? []).map(t => ({
        artist:     t.artist?.name ?? "Unknown",
        name:       t.name ?? "",
        url:        t.url ?? "",
        playcount:  Number(t.playcount ?? 0),
        image:      t.image?.[2]?.["#text"] ?? t.image?.[1]?.["#text"] ?? "",
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  },

  /**
   * Get top artists for a tag from Last.fm.
   * @async
   * @param {string} tag - The tag name.
   * @param {number} [limit=10] - Maximum number of results.
   * @returns {Promise<Array<{name: string, url: string, playcount: number, image: string}>>} Tag's top artists.
   */
  async getTagTopArtists(tag, limit = 10) {
    if (!this.enabled) return [];

    try {
      const data = await apiCall(
        {
          method:   "tag.gettopartists",
          api_key:  this.apiKey,
          tag,
          limit,
        },
        this.apiSecret
      );

      return (data.topartists?.artist ?? []).map(a => ({
        name:      a.name ?? "",
        url:       a.url ?? "",
        playcount: Number(a.playcount ?? 0),
        image:     a.image?.[2]?.["#text"] ?? a.image?.[1]?.["#text"] ?? "",
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  },

  /**
   * Search for artists on Last.fm.
   * @async
   * @param {string} query - The search query.
   * @param {number} [limit=10] - Maximum number of results.
   * @returns {Promise<Array<{name: string, url: string, image: string, listeners: number}>>} Matching artists.
   */
  async searchArtist(query, limit = 10) {
    if (!this.enabled) return [];

    try {
      const data = await apiCall(
        {
          method:  "artist.search",
          api_key: this.apiKey,
          artist:  query,
          limit,
        },
        this.apiSecret
      );

      const matches = data?.results?.artistmatches?.artist;
      const artists = Array.isArray(matches)
        ? matches
        : matches
          ? [matches]
          : [];

      return artists.map(a => ({
        name:    a.name ?? "",
        url:     a.url ?? "",
        image:   a.image?.[2]?.["#text"] ?? a.image?.[1]?.["#text"] ?? "",
        listeners: Number(a.listeners ?? 0),
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  },

  /**
   * Search for albums on Last.fm.
   * @async
   * @param {string} query - The search query.
   * @param {number} [limit=10] - Maximum number of results.
   * @returns {Promise<Array<{name: string, artist: string, url: string, image: string}>>} Matching albums.
   */
  async searchAlbum(query, limit = 10) {
    if (!this.enabled) return [];

    try {
      const data = await apiCall(
        {
          method:  "album.search",
          api_key: this.apiKey,
          album:   query,
          limit,
        },
        this.apiSecret
      );

      const matches = data?.results?.albummatches?.album;
      const albums = Array.isArray(matches)
        ? matches
        : matches
          ? [matches]
          : [];

      return albums.map(a => ({
        name:      a.name ?? "",
        artist:    a.artist ?? "",
        url:       a.url ?? "",
        image:     a.image?.[2]?.["#text"] ?? a.image?.[1]?.["#text"] ?? "",
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  },

  /**
   * Get top tags for an artist from Last.fm.
   * @async
   * @param {string} artist - The artist name.
   * @param {number} [limit=10] - Maximum number of results.
   * @returns {Promise<Array<{name: string, url: string, count: number}>>} Artist's top tags.
   */
  async getArtistTopTags(artist, limit = 10) {
    if (!this.enabled) return [];
    try {
      const data = await apiCall({
        method: "artist.gettoptags",
        api_key: this.apiKey,
        artist,
        limit,
      }, this.apiSecret);
      return (data.toptags?.tag ?? []).map(t => ({
        name: t.name ?? "",
        url: t.url ?? "",
        count: Number(t.count ?? 0),
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  },

  /**
   * Get top tags for an album from Last.fm.
   * @async
   * @param {string} artist - The artist name.
   * @param {string} album - The album name.
   * @param {number} [limit=10] - Maximum number of results.
   * @returns {Promise<Array<{name: string, url: string, count: number}>>} Album's top tags.
   */
  async getAlbumTopTags(artist, album, limit = 10) {
    if (!this.enabled) return [];
    try {
      const data = await apiCall({
        method: "album.gettoptags",
        api_key: this.apiKey,
        artist,
        album,
        limit,
      }, this.apiSecret);
      return (data.toptags?.tag ?? []).map(t => ({
        name: t.name ?? "",
        url: t.url ?? "",
        count: Number(t.count ?? 0),
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  },

  /**
   * Get top tags for a track from Last.fm.
   * @async
   * @param {string} artist - The artist name.
   * @param {string} track - The track name.
   * @param {number} [limit=10] - Maximum number of results.
   * @returns {Promise<Array<{name: string, url: string, count: number}>>} Track's top tags.
   */
  async getTrackTopTags(artist, track, limit = 10) {
    if (!this.enabled) return [];
    try {
      const data = await apiCall({
        method: "track.gettoptags",
        api_key: this.apiKey,
        artist,
        track,
        limit,
      }, this.apiSecret);
      return (data.toptags?.tag ?? []).map(t => ({
        name: t.name ?? "",
        url: t.url ?? "",
        count: Number(t.count ?? 0),
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  },

  /**
   * Get top albums for a tag from Last.fm.
   * @async
   * @param {string} tag - The tag name.
   * @param {number} [limit=10] - Maximum number of results.
   * @returns {Promise<Array<{name: string, artist: string, url: string, playcount: number, image: string}>>} Tag's top albums.
   */
  async getTagTopAlbums(tag, limit = 10) {
    if (!this.enabled) return [];
    try {
      const data = await apiCall({
        method: "tag.gettopalbums",
        api_key: this.apiKey,
        tag,
        limit,
      }, this.apiSecret);
      return (data.albums?.album ?? []).map(a => ({
        name: a.name ?? "",
        artist: a.artist?.name ?? "Unknown",
        url: a.url ?? "",
        playcount: Number(a.playcount ?? 0),
        image: a.image?.[2]?.["#text"] ?? a.image?.[1]?.["#text"] ?? "",
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  },

  /**
   * Get top artists for a country from Last.fm.
   * @async
   * @param {string} country - The country name.
   * @param {number} [limit=10] - Maximum number of results.
   * @returns {Promise<Array<{name: string, url: string, listeners: number, image: string}>>} Country's top artists.
   */
  async getGeoTopArtists(country, limit = 10) {
    if (!this.enabled) return [];
    try {
      const data = await apiCall({
        method: "geo.gettopartists",
        api_key: this.apiKey,
        country,
        limit,
      }, this.apiSecret);
      return (data.topartists?.artist ?? []).map(a => ({
        name: a.name ?? "",
        url: a.url ?? "",
        listeners: Number(a.listeners ?? 0),
        image: a.image?.[2]?.["#text"] ?? a.image?.[1]?.["#text"] ?? "",
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  },

  /**
   * Get top tracks for a country from Last.fm.
   * @async
   * @param {string} country - The country name.
   * @param {number} [limit=10] - Maximum number of results.
   * @returns {Promise<Array<{name: string, artist: string, url: string, listeners: number, image: string}>>} Country's top tracks.
   */
  async getGeoTopTracks(country, limit = 10) {
    if (!this.enabled) return [];
    try {
      const data = await apiCall({
        method: "geo.gettoptracks",
        api_key: this.apiKey,
        country,
        limit,
      }, this.apiSecret);
      return (data.tracks?.track ?? []).map(t => ({
        name: t.name ?? "",
        artist: t.artist?.name ?? "Unknown",
        url: t.url ?? "",
        listeners: Number(t.listeners ?? 0),
        image: t.image?.[2]?.["#text"] ?? t.image?.[1]?.["#text"] ?? "",
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  },

  /**
   * Get the global top tracks chart from Last.fm.
   * @async
   * @param {number} [limit=10] - Maximum number of results.
   * @returns {Promise<Array<{name: string, artist: string, url: string, listeners: number, playcount: number, image: string}>>} Global top tracks.
   */
  async getChartTopTracks(limit = 10) {
    if (!this.enabled) return [];
    try {
      const data = await apiCall({
        method: "chart.gettoptracks",
        api_key: this.apiKey,
        limit,
      }, this.apiSecret);
      return (data.tracks?.track ?? []).map(t => ({
        name: t.name ?? "",
        artist: t.artist?.name ?? "Unknown",
        url: t.url ?? "",
        listeners: Number(t.listeners ?? 0),
        playcount: Number(t.playcount ?? 0),
        image: t.image?.[2]?.["#text"] ?? t.image?.[1]?.["#text"] ?? "",
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  },

  /**
   * Get the global top artists chart from Last.fm.
   * @async
   * @param {number} [limit=10] - Maximum number of results.
   * @returns {Promise<Array<{name: string, url: string, listeners: number, playcount: number, image: string}>>} Global top artists.
   */
  async getChartTopArtists(limit = 10) {
    if (!this.enabled) return [];
    try {
      const data = await apiCall({
        method: "chart.gettopartists",
        api_key: this.apiKey,
        limit,
      }, this.apiSecret);
      return (data.artists?.artist ?? []).map(a => ({
        name: a.name ?? "",
        url: a.url ?? "",
        listeners: Number(a.listeners ?? 0),
        playcount: Number(a.playcount ?? 0),
        image: a.image?.[2]?.["#text"] ?? a.image?.[1]?.["#text"] ?? "",
      }));
    } catch (e) { logger.warn("[LastFm] Error:", e?.message); return []; }
  }
};

export default TrackQueriesMixin;
export { TrackQueriesMixin };
