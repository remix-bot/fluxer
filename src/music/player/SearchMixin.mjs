/**
 * @module src/music/player/SearchMixin
 * @description Search & queue-filling concern for {@link Player}: Lavalink
 * queries, search sessions with interactive selection, YouTube fallbacks,
 * radio/external track builders.
 *
 * These methods are applied onto the Player class prototype via
 * {@link applyMixins} — `this` is a Player instance.
 */

import { EventEmitter } from "node:events";
import { Utils } from "../../utils/Utils.mjs";
import { logger } from "../../core/Logger.mjs";
import { PROVIDERS, PROVIDER_NAMES } from "../providers.mjs";

/**
 * @type {object}
 * @description Search mixin — applied to Player.
 */
const SearchMixin = {
  /**
   * @async Resolve a free-text query or URL to track data via Lavalink for
   * internal consumers (autoplay, Last.fm). URL queries are loaded directly
   * (like play()) so playlist/mix URLs resolve to their full track lists.
   * @this {import('./Player.mjs').Player}
   * @param {{query: string, provider?: string, trackMeta?: object}} opts
   * @returns {Promise<{type: "video"|"list"|"error", data?: object}|null>}
   */
  async generalQuery({ query, provider = "yt", trackMeta = null }) {
    try {
      if (!this._lavalink) return { type: "error", data: "Audio node not ready." };
      await this._lavalink.waitForNode({ timeoutMs: 15_000 });
      const isUrl = typeof query === "string" && Utils.isValidUrl(query);
      const result = isUrl
        ? await this._lavalink.search(query)
        : await this._lavalink.search(query, { source: this._getSource(provider) });
      const tracks = (result?.tracks ?? []).map(t => this._lcTrackToVideo(t, trackMeta)).filter(Boolean);
      if (!tracks.length) return null;
      return tracks.length === 1 ? { type: "video", data: tracks[0] } : { type: "list", data: tracks };
    } catch (err) {
      logger.warn("[Player] generalQuery failed:", err?.message);
      return { type: "error", data: err?.message ?? String(err) };
    }
  },

  /**
   * @async Search for tracks via Lavalink and store results for interactive
   * selection.
   * @this {import('./Player.mjs').Player}
   * @param {string} query - The search query string.
   * @param {string} id - A unique key to identify this search session (e.g. message ID).
   * @param {string} [provider="ytm"] - The search provider key.
   * @returns {Promise<{m: string, count: number}>} Formatted result list message and track count.
   */
  async fetchResults(query, id, provider = "ytm") {
    try {
      if (!this._lavalink) return { m: "Audio node not ready.", count: 0 };

      await this._lavalink.waitForNode({ timeoutMs: 15_000 });

      const source = this._getSource(provider);
      const result = await this._lavalink.search(query, { source });
      const lcTracks = result?.tracks ?? [];

      const results = lcTracks.slice(0, this.resultLimit).map(t => this._lcTrackToVideo(t)).filter(Boolean);

      let list = "Search results using **" + (PROVIDER_NAMES[provider] || "YouTube Music") + "**:\n\n";
      results.forEach((v, i) => {
        const url   = v.url || "";
        const title = v.title || Utils.formatTrackInfo(v, false);
        const dur   = v.duration ? this.getDuration(v.duration) : "?:??";
        list += (i + 1) + ". [" + title + "](" + url + ") - " + dur + "\n";
      });
      list += "\nSend the number of the result. Example: `2`\nSend 'x' to cancel.";

      if (this.searches.size >= this._searchMaxSize) {
        const oldestKey = this.searches.keys().next().value;
        if (oldestKey !== undefined) this.searches.delete(oldestKey);
      }
      this.searches.set(id, results);

      return { m: list, count: results.length };
    } catch (err) {
      return { m: "Error searching: " + err.message, count: 0 };
    }
  },

  /**
   * Select a search result and add it to the queue.
   * @this {import('./Player.mjs').Player}
   * @param {string} id
   * @param {number} [result=0]
   * @param {boolean} [next=false]
   * @returns {object|null}
   */
  playResult(id, result = 0, next = false) {
    if (!this.searches.has(id)) return null;
    const searchResults = this.searches.get(id);
    if (!searchResults || !searchResults[result]) return null;

    const res = searchResults[result];
    this.addToQueue(res, next);

    this.searches.delete(id);

    if (!this.queue.getCurrent()) {
      this.playNext().catch(e => logger.error("[Player] playNext error:", e.message));
    }
    return res;
  },

  /**
   * Search and add a track to the top of the queue.
   * @this {import('./Player.mjs').Player}
   * @param {string} query
   * @param {string} provider
   * @param {object} trackMeta
   * @returns {EventEmitter}
   */
  playFirst(query, provider, trackMeta) { return this.play(query, true, provider, trackMeta); },

  /**
   * @private Convert a Lavalink track to the internal track format.
   * @this {import('./Player.mjs').Player}
   * @param {object} track
   * @param {object|null} [trackMeta=null]
   * @returns {object|null}
   */
  _lcTrackToVideo(track, trackMeta = null) {
    if (!track || typeof track !== "object") return null;
    const info = track.info ?? track ?? {};

    let ms = info.length ?? track.length ?? info.durationMs ?? 0;
    if (ms === 0 && info.duration != null) {
      if (typeof info.duration === "number") {
        ms = info.duration;
      } else if (typeof info.duration === "object" && info.duration.seconds != null) {
        ms = info.duration.seconds * 1000;
      }
    }

    let trackUri = info.uri ?? ("https://www.youtube.com/watch?v=" + (info.identifier || ""));
    if (typeof trackUri === 'string' && trackUri.includes('music.youtube.com')) {
      trackUri = trackUri.replace('music.youtube.com', 'www.youtube.com');
    }
    const video = {
      videoId:    info.identifier ?? "",
      encoded:    track.encoded ?? info.encoded ?? "",
      sourceName: info.sourceName ?? "unknown",
      title:      Utils.cleanTitle(info.title ?? "Unknown"),
      url:        trackUri,
      thumbnail:  info.artworkUrl ?? null,
      spotifyUrl: null,
      _durationMs: ms,
      duration: {
        timestamp: Utils.prettifyMS(ms),
        seconds:   Math.floor(ms / 1000),
      },
      author: {
        name: info.author ?? "Unknown",
        url:  info.uri    ?? null,
      },
      artists: null,
    };
    if (trackMeta) {
      video.artist          = trackMeta.artist ?? null;
      video.requestedArtist = trackMeta.artist ?? null;
      video.requestedTitle  = trackMeta.name ?? trackMeta.title ?? null;
      video.lastfm = {
        source: trackMeta.source ?? "lastfm",
        artist: trackMeta.artist ?? null,
        name:   trackMeta.name ?? trackMeta.title ?? null,
        url:    trackMeta.url ?? "",
      };
    }
    return video;
  },

  /**
   * @private Resolve a provider key to a Lavalink search prefix.
   * @this {import('./Player.mjs').Player}
   * @param {string} provider
   * @returns {string}
   */
  _getSource(provider) {
    return PROVIDERS[provider]?.prefix ?? (provider + "search");
  },

  /**
   * Search for a track and add it to the queue. Handles URL loading with
   * YouTube normalization + oEmbed title fallback and playlist expansion.
   * @this {import('./Player.mjs').Player}
   * @param {string} query
   * @param {boolean} [top=false]
   * @param {string} [provider]
   * @param {object} [trackMeta=null]
   * @returns {EventEmitter} Emits "message" events with status strings.
   */
  play(query, top = false, provider, trackMeta = null) {
    const events = new EventEmitter();
    const source = this._getSource(provider || "ytm");
    const isUrl  = Utils.isValidUrl(query);

    (async () => {
      try {
        if (!this._lavalink) {
          events.emit("message", "Audio node not ready yet.");
          return;
        }

        await this._lavalink.waitForNode({ timeoutMs: 15_000 });

        events.emit("message", "Searching...");

        const ytId = Utils.extractYouTubeId(query);
        const canonicalYtUrl = ytId ? Utils.normalizeYouTubeUrl(query) : null;
        const searchQuery = (isUrl && canonicalYtUrl) ? canonicalYtUrl : query;

        let result;
        try {
          if (isUrl) {
            result = await this._lavalink.search(searchQuery);
          } else {
            result = await this._lavalink.search(searchQuery, { source });
          }
        } catch (searchErr) {
          logger.warn("[Player] URL/primary search failed:", searchErr?.message);
          result = null;
          if (!isUrl) throw searchErr;
        }
        let lcTracks = result?.tracks ?? [];
        // Set when the only results we have came from the oEmbed title-search
        // fallback. That path resolves a SINGLE video (direct URL load was
        // bot-blocked), so its result list is a search page — NOT a playlist.
        // Bulk-queueing it would queue a bunch of "related" songs instead of
        // the one requested video (original fluxer bug reported by users).
        let fromTitleFallback = false;

        if (isUrl && lcTracks.length === 0 && ytId) {
          const directBlocked = "YouTube blocked direct loading for this video (`Sign in to confirm you're not a bot`) — trying search fallback...";

          if (searchQuery !== query) {
            events.emit("message", "Retrying with original URL...");
            try {
              const retry = await this._lavalink.search(query);
              lcTracks = retry?.tracks ?? [];
            } catch (_) { lcTracks = []; }
          }

          if (lcTracks.length === 0) {
            events.emit("message", directBlocked);
            const title = await Utils.fetchYouTubeOEmbedTitle(ytId);
            if (title) {
              logger.player(`[Player] oEmbed fallback: resolved title "${title}" for ${ytId}`);
              for (const fallbackSource of ["ytsearch", "ytmsearch"]) {
                try {
                  const fb = await this._lavalink.search(title, { source: fallbackSource });
                  if (fb?.tracks?.length > 0) {
                    lcTracks = fb.tracks;
                    fromTitleFallback = true;
                    break;
                  }
                } catch (_) { /* try next source */ }
              }
            } else {
              logger.warn("[Player] oEmbed fallback: could not resolve title for " + ytId);
            }
          }
        }

        if (lcTracks.length === 0) {
          if (!isUrl && source !== "ytmsearch") {
            events.emit("message", "No results from primary source, trying YouTube Music...");
            const fallback = await this._lavalink.search(searchQuery, { source: "ytmsearch" });
            if (fallback?.tracks?.length > 0) {
              const video = this._lcTrackToVideo(fallback.tracks[0], trackMeta);
              if (video) {
                this.addToQueue(video, top);
                events.emit("message", "Successfully added [" + video.title + "](" + video.url + ") to the queue.");
                if (!this.queue.getCurrent()) {
                  this.playNext().catch(e => logger.error("[Player] playNext error:", e.message));
                }
                return;
              }
            }
          }
          events.emit("message", "**No results found for '" + query + "'.**");
          return;
        }

        // Pick the track to queue. For a title-search fallback, prefer the
        // result that is the exact video the user requested (search may rank
        // covers/remixes first); otherwise take the first result.
        let firstTrack = lcTracks[0];
        if (fromTitleFallback && ytId) {
          firstTrack = lcTracks.find(t => (t?.info?.identifier ?? t?.identifier) === ytId) ?? lcTracks[0];
          if (firstTrack !== lcTracks[0]) {
            logger.player(`[Player] Search fallback: exact video match found for ${ytId}`);
          }
        }

        // Only a genuine playlist/mix URL load may bulk-queue. A title-search
        // fallback for a single video must queue exactly one track.
        if (isUrl && !fromTitleFallback && lcTracks.length > 1) {
          const videos = lcTracks.map(t => this._lcTrackToVideo(t, trackMeta)).filter(Boolean);
          this.addManyToQueue(videos, top);
          events.emit("message", "Successfully added **" + videos.length + "** songs to the queue.");
        } else {
          const video = this._lcTrackToVideo(firstTrack, trackMeta);
          if (video) {
            this.addToQueue(video, top);
            events.emit("message", "Successfully added [" + video.title + "](" + video.url + ") to the queue.");
          } else {
            events.emit("message", "**Failed to parse track data.**");
            return;
          }
        }

        if (!this.queue.getCurrent()) {
          this.playNext().catch(e => logger.error("[Player] playNext error:", e.message));
        }
      } catch (err) {
        logger.error("[Player] play() search error:", err?.message);
        events.emit("message", err?.message || "An error occurred while loading the track.");
      }
    })();

    return events;
  },

  /**
   * @async Search for tracks via Lavalink and return raw track results.
   * @this {import('./Player.mjs').Player}
   * @param {string} query
   * @param {string} [provider="ytm"]
   * @returns {Promise<Array<object>>}
   */
  async search(query, provider = 'ytm') {
    if (!this._lavalink) return [];
    try {
      const source = this._getSource(provider);
      const result = await this._lavalink.search(query, { source });
      return result.tracks || [];
    } catch (e) {
      logger.error(`[Player] lavalink search error:`, e?.message);
      return [];
    }
  },

  /**
   * @private Build a radio-type track object.
   * @this {import('./Player.mjs').Player}
   * @param {object} radio
   * @returns {object}
   */
  _buildRadioTrack(radio) {
    return {
      type:        "radio",
      title:       radio.detailedName || radio.title || "Unknown Radio",
      description: Utils.truncate(radio.description || "", 200),
      url:         radio.url,
      author: {
        name: radio.author?.name || "Unknown",
        url:  radio.author?.url  || radio.url,
      },
      thumbnail: radio.thumbnail ?? null,
    };
  },

  /**
   * Add a radio stream to the queue.
   * @this {import('./Player.mjs').Player}
   * @param {object} radio
   * @param {boolean} [top=false]
   */
  playRadio(radio, top = false) {
    if (!radio?.url) { logger.error("[Player] Invalid radio data"); return; }
    this.addToQueue(this._buildRadioTrack(radio), top);
    if (!this.queue.getCurrent()) this.playNext().catch(e => logger.error("[Player] playNext error:", e.message));
  },

  /**
   * @async Switch to a different radio stream, replacing any current radio tracks.
   * @this {import('./Player.mjs').Player}
   * @param {object} radio - Radio object with url, title, author, thumbnail.
   * @returns {Promise<void>}
   */
  async switchRadio(radio) {
    if (!radio?.url) { logger.error("[Player] switchRadio: invalid radio data"); return; }

    const newTrack = this._buildRadioTrack(radio);
    this.queue.data = this.queue.data.filter(t => t.type !== "radio");

    if (!this.queue.getCurrent()) {
      this.queue.add(newTrack);
      this.playNext().catch(e => logger.error("[Player] playNext error:", e.message));
      return;
    }

    this.queue.data.unshift(newTrack);
    this._skipping       = true;
    this._radioAnnounced = false;
    this.queue.current   = null;
    this._bridgeStop();
    this._playingNext = false;
    this._skipping    = false;
    if (!this.leaving) this.playNext().catch(e => logger.error("[Player] playNext error:", e.message));
  },

  /**
   * @private Build a direct-URL track object.
   * @this {import('./Player.mjs').Player}
   * @param {string} url
   * @param {string} [title]
   * @param {string} [artist]
   * @param {string} [trackType="external"]
   * @returns {object}
   */
  _buildExternalTrack(url, title = null, artist = null, trackType = "external") {
    const displayTitle = title || this._extractFilenameFromUrl(url);
    return {
      type:      trackType,
      title:     displayTitle,
      url:       url,
      artist:    artist || null,
      thumbnail: null,
    };
  },

  /**
   * @private Extract a display filename from a URL.
   * @this {import('./Player.mjs').Player}
   * @param {string} url
   * @returns {string}
   */
  _extractFilenameFromUrl(url) {
    try {
      const pathname = new URL(url).pathname;
      const filename = pathname.split("/").pop();
      if (filename && filename.includes(".")) {
        return decodeURIComponent(filename.replace(/\.[^.]+$/, "")) || "Stream";
      }
    } catch (_) {}
    return "External Stream";
  },

  /**
   * Play a direct audio URL (MP3, OGG, AAC, stream, etc.) without Lavalink
   * search. The bridge handles decoding via Lavalink if needed.
   * @this {import('./Player.mjs').Player}
   * @param {string} url - Direct HTTP(S) audio URL.
   * @param {string} [title] - Optional display title.
   * @param {string} [artist] - Optional artist name.
   * @param {boolean} [top=false] - Insert at top of queue.
   * @param {string} [trackType="external"] - "external" or "stream".
   * @returns {EventEmitter} Emits "message" events with status strings.
   */
  playExternal(url, title = null, artist = null, top = false, trackType = "external") {
    const events = new EventEmitter();

    (async () => {
      try {
        const track = this._buildExternalTrack(url, title, artist, trackType);
        this.addToQueue(track, top);
        events.emit("message", "Added **[" + track.title + "](" + url + ")** to the queue.");

        if (!this.queue.getCurrent()) {
          this.playNext().catch(e => {
            logger.error("[Player] playExternal playNext error:", e.message);
            events.emit("message", "Error playing stream: " + e.message);
          });
        }
      } catch (err) {
        logger.error("[Player] playExternal error:", err?.message);
        events.emit("message", "Error: " + (err?.message || "Failed to add external stream."));
      }
    })();

    return events;
  },
};

export default SearchMixin;
export { SearchMixin };
