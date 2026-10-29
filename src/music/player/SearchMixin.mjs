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
import { bilibiliEnabled, isBilibiliUrl, resolveBilibiliVideo } from "../bilibili/index.mjs";
import { isFluxerAttachmentUrl, extractMediaTitle } from "../../utils/AttachmentUtils.mjs";

/**
 * Broad music genres are ambiguous when used by themselves: searching for
 * `pop`, for example, often returns a song literally named "Pop" instead of
 * pop music.  Keep this deliberately conservative so artist and song names
 * continue to be searched exactly as the user entered them.
 */
const GENRE_TERMS = new Set([
  "pop", "rock", "rap", "hip hop", "hip-hop", "rnb", "r&b", "jazz", "blues",
  "country", "metal", "classical", "edm", "electronic", "dance", "house",
  "techno", "trance", "reggae", "latin", "kpop", "k-pop", "indie", "folk",
  "punk", "soul", "funk", "disco", "gospel", "ambient", "lofi", "lo-fi",
]);

/**
 * Return the provider queries to try, ordered by the most useful intent.
 * A one-genre query becomes e.g. `pop music`, which asks providers for the
 * topic/genre rather than an exact track title.  The untouched input remains
 * a fallback for providers whose catalogues do better with the short term.
 *
 * @param {string} query
 * @param {string} source Lavalink search prefix.
 * @returns {string[]}
 */
function searchQueryVariants(query, source) {
  const original = String(query ?? "").trim().replace(/\s+/g, " ");
  if (!original) return [];

  if (source === "gtts" || source === "ftts") return [original];

  const normalized = original.toLowerCase().replace(/[.!?,]+$/g, "");
  if (!GENRE_TERMS.has(normalized)) return [original];

  return [`${original} music`, `${original} songs`, original];
}

/** @param {unknown} value @returns {string} */
function normalizeSearchText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9&]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Small bounded edit-distance helper used only for ranking already-returned
 * tracks. It never invents a new query or makes an extra network request.
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function editDistance(left, right) {
  if (left === right) return 0;
  if (!left) return right.length;
  if (!right) return left.length;

  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

/**
 * Return the best spelling similarity of a user term against words in a
 * result. A conservative threshold prevents loosely-related tracks from
 * jumping ahead merely because they share a couple of letters.
 * @param {string} term
 * @param {string} haystack
 * @returns {number}
 */
function bestTokenSimilarity(term, haystack) {
  if (term.length < 4) return 0;
  let best = 0;
  for (const candidate of haystack.split(" ")) {
    if (candidate.length < 4) continue;
    const maxLength = Math.max(term.length, candidate.length);
    const similarity = 1 - editDistance(term, candidate) / maxLength;
    if (similarity > best) best = similarity;
  }
  return best;
}

/** @param {string} haystack @param {string} term @returns {boolean} */
function hasExactToken(haystack, term) {
  return haystack.split(" ").includes(term);
}

/**
 * Assign a relevance score without relying on provider-specific ordering.
 * Lavalink providers do not all sort results the same way, so title/artist
 * matching gives users predictable results across YouTube Music, YouTube,
 * SoundCloud, and the optional catalog providers.
 *
 * @param {object} track
 * @param {string} query
 * @returns {number}
 */
function scoreSearchTrack(track, query) {
  const info = track?.info ?? track ?? {};
  const needle = normalizeSearchText(query);
  const terms = needle.split(" ").filter(Boolean);
  const title = normalizeSearchText(info.title);
  const author = normalizeSearchText(info.author);
  const album = normalizeSearchText(info.albumName ?? info.album?.name);
  const isGenreQuery = GENRE_TERMS.has(needle);
  let score = 0;

  if (title === needle) score += isGenreQuery ? 8 : 100;
  else if (title.includes(needle)) score += isGenreQuery ? 12 : 50;
  if (author === needle) score += 55;
  else if (author.includes(needle)) score += 25;

  for (const term of terms) {
    const titleHasTerm = hasExactToken(title, term);
    const authorHasTerm = hasExactToken(author, term);
    const albumHasTerm = hasExactToken(album, term);
    const titlePartial = term.length >= 4 && title.includes(term);
    const authorPartial = term.length >= 4 && author.includes(term);
    const albumPartial = term.length >= 4 && album.includes(term);

    if (titleHasTerm) score += 14;
    else if (titlePartial) score += 3;
    if (authorHasTerm) score += 10;
    else if (authorPartial) score += 2;
    if (albumHasTerm) score += 4;
    else if (albumPartial) score += 1;

    if (!titleHasTerm && !authorHasTerm && !albumHasTerm && !titlePartial && !authorPartial && !albumPartial) {
      const similarity = Math.max(
        bestTokenSimilarity(term, title),
        bestTokenSimilarity(term, author),
        bestTokenSimilarity(term, album),
      );
      if (similarity >= 0.84) score += 8 + Math.round((similarity - 0.84) * 50);
    }
  }

  if (author.includes("topic")) score += isGenreQuery ? 45 : 8;
  if (info.isStream) score -= 8;
  if (info.isSeekable === false) score -= 3;

  for (const qualifier of ["cover", "tribute", "karaoke", "instrumental", "nightcore", "slowed", "reverb", "remix", "mashup"]) {
    if (title.includes(qualifier) && !needle.includes(qualifier)) score -= 60;
  }
  if (title.includes("live") && !needle.includes("live")) score -= 15;

  const length = Number(info.length ?? info.durationMs ?? 0);
  if (length >= 30_000 && length <= 30 * 60_000) score += 3;
  return score;
}

/** @param {object} track @returns {string} */
function searchTrackKey(track) {
  const info = track?.info ?? track ?? {};
  return String(track?.encoded ?? info.identifier ?? info.uri ?? "") ||
    `${normalizeSearchText(info.title)}|${normalizeSearchText(info.author)}`;
}

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
      const source = this._getSource(provider);
      const result = isUrl
        ? await this._lavalink.search(query)
        : await this._searchFreeText(query, source);
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
      const result = await this._searchFreeText(query, source);
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
      } else if (typeof info.duration === "object" && info.duration?.seconds != null) {
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
      isLive:     info.isLive === true,
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
      requester: trackMeta?.requester ?? trackMeta?.userId ?? null,
      requesterName: trackMeta?.requesterName ?? null,
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
   * Search free text with a topic-aware first pass.  This is shared by
   * `%play`, `%search`, and internal queries so they all interpret broad
   * genre requests consistently.
   *
   * @private
   * @this {import('./Player.mjs').Player}
   * @param {string} query
   * @param {string} source Lavalink search prefix.
   * @returns {Promise<object|null>}
   */
  async _searchFreeText(query, source) {
    const variants = searchQueryVariants(query, source);
    const attempts = await Promise.allSettled(
      variants.map(candidate => this._lavalink.search(candidate, { source }))
    );
    const successful = attempts
      .filter(attempt => attempt.status === "fulfilled")
      .map(attempt => attempt.value)
      .filter(Boolean);

    if (successful.length === 0) {
      const failed = attempts.find(attempt => attempt.status === "rejected");
      if (failed) throw failed.reason;
      return null;
    }

    const unique = new Map();
    for (const result of successful) {
      for (const track of result?.tracks ?? []) {
        const key = searchTrackKey(track);
        if (!unique.has(key)) unique.set(key, track);
      }
    }

    const tracks = [...unique.values()]
      .map((track, index) => ({ track, index, score: scoreSearchTrack(track, query) }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map(({ track }) => track);

    if (variants.length > 1) {
      logger.player(`[Player] Topic-aware search for "${query}": ${tracks.length} unique results ranked from ${variants.length} queries.`);
    }

    return { ...successful[0], tracks };
  },

  /**
   * Search for a track and add it to the queue. Handles URL loading with
   * YouTube normalization + oEmbed title fallback and playlist expansion;
   * Bilibili links are routed to {@link _playBilibili} before Lavalink.
   * @this {import('./Player.mjs').Player}
   * @param {string} query
   * @param {boolean} [top=false]
   * @param {string} [provider]
   * @param {object} [trackMeta=null]
   * @returns {EventEmitter} Emits "message" events with status strings.
   */
  play(query, top = false, provider, trackMeta = null) {
    if (isBilibiliUrl(query)) return this._playBilibili(query, top);

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

        let playlistQuery = null;
        if (isUrl && ytId && canonicalYtUrl) {
          try {
            const listId = new URL(query.trim()).searchParams.get("list");
            if (listId) playlistQuery = canonicalYtUrl + "&list=" + listId;
          } catch (_) { /* ignore malformed URLs */ }
        }

        let result = null;
        let usedPlaylistQuery = false;
        if (isUrl && playlistQuery) {
          try {
            result = await this._lavalink.search(playlistQuery);
            usedPlaylistQuery = true;
          } catch (searchErr) {
            logger.warn("[Player] Playlist load failed:", searchErr?.message);
            result = null;
          }
          if ((result?.tracks?.length ?? 0) === 0) {
            usedPlaylistQuery = false;
            result = null;
          }
        }
        if (!usedPlaylistQuery) {
          try {
            if (isUrl) {
              result = await this._lavalink.search(searchQuery);
            } else {
              result = await this._searchFreeText(searchQuery, source);
            }
          } catch (searchErr) {
            logger.warn("[Player] URL/primary search failed:", searchErr?.message);
            result = null;
            if (!isUrl) throw searchErr;
          }
        }
        let lcTracks = result?.tracks ?? [];
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
          if (!isUrl) {
            const FALLBACKS = [
              { source: "ytmsearch", label: "YouTube Music" },
              { source: "ytsearch",  label: "YouTube" },
              { source: "scsearch",  label: "SoundCloud" },
            ].filter(f => f.source !== source);

            for (const fb of FALLBACKS) {
              events.emit("message", "No results yet — trying **" + fb.label + "**...");
              let fbResult = null;
              try {
                fbResult = await this._searchFreeText(searchQuery, fb.source);
              } catch (_) { fbResult = null; }
              if (fbResult?.tracks?.length > 0) {
                const video = this._lcTrackToVideo(fbResult.tracks[0], trackMeta);
                if (video) {
                  this.addToQueue(video, top);
                  events.emit("message", this.buildAddedToQueueEmbed(video, top, trackMeta));
                  if (!this.queue.getCurrent()) {
                    this.playNext().catch(e => logger.error("[Player] playNext error:", e.message));
                  }
                  return;
                }
              }
            }
          } else {
            const lavasrcHost = /(?:open\.spotify\.com|spotify\.link|music\.apple\.com|tidal\.com|deezer\.com|deezer\.page\.link|music\.youtube\.com\/playlist)/i;
            try { if (lavasrcHost.test(new URL(query.trim()).hostname)) {
              events.emit("message", "⚠️ This link needs the **LavaSrc plugin** on the audio node, which isn't available. Try the song/playlist **name** instead — e.g. `%play <name>`.");
            } } catch (_) {}
          }
          events.emit("message", "**No results found for '" + query + "'.**");
          return;
        }

        let firstTrack = lcTracks[0];
        if (fromTitleFallback && ytId) {
          firstTrack = lcTracks.find(t => (t?.info?.identifier ?? t?.identifier) === ytId) ?? lcTracks[0];
          if (firstTrack !== lcTracks[0]) {
            logger.player(`[Player] Search fallback: exact video match found for ${ytId}`);
          }
        }

        if (isUrl && !fromTitleFallback && lcTracks.length > 1) {
          const playlistName = result?.playlistInfo?.name ?? result?.info?.name ?? "playlist";
          const allRawTracks = [...lcTracks];

          // Check if there are additional pages from NodeLink / LavaSrc pagination (Issue #17)
          let nextPageToken = result?.pluginInfo?.nextPageToken ?? result?.playlistInfo?.nextPageToken;
          let page = 1;
          const maxPages = 10;
          while (nextPageToken && page < maxPages) {
            try {
              page++;
              events.emit("message", `Fetching next page of **${playlistName}** (page ${page})...`);
              const nextResult = await this._lavalink.search(query, {
                page,
                pageToken: nextPageToken,
              });
              const nextTracks = nextResult?.tracks ?? [];
              if (nextTracks.length === 0) break;
              allRawTracks.push(...nextTracks);
              nextPageToken = nextResult?.pluginInfo?.nextPageToken ?? nextResult?.playlistInfo?.nextPageToken;
            } catch (pageErr) {
              logger.warn(`[Player] Playlist pagination page ${page} error:`, pageErr?.message);
              break;
            }
          }

          const BATCH_SIZE = 50;
          if (allRawTracks.length <= BATCH_SIZE) {
            const videos = allRawTracks.map(t => this._lcTrackToVideo(t, trackMeta)).filter(Boolean);
            this.addManyToQueue(videos, top);
            events.emit("message", `Successfully added **${videos.length}** songs to the queue.`);
          } else {
            // Paginated background queue ingestion (Issue #17)
            const initialRaw = allRawTracks.slice(0, BATCH_SIZE);
            const initialVideos = initialRaw.map(t => this._lcTrackToVideo(t, trackMeta)).filter(Boolean);
            this.addManyToQueue(initialVideos, top);

            // Start playing immediately if idle so user hears music right away!
            if (!this.queue.getCurrent()) {
              this.playNext().catch(e => logger.error("[Player] playNext error:", e.message));
            }

            events.emit("message", `Queued first **${initialVideos.length}** songs and started playback! Ingesting **${allRawTracks.length - initialVideos.length}** more tracks in the background...`);

            // Ingest remaining tracks in the background without blocking the event loop
            (async () => {
              let loaded = initialVideos.length;
              let lastStatusTime = Date.now();
              const remainingRaw = allRawTracks.slice(BATCH_SIZE);

              for (let i = 0; i < remainingRaw.length; i += BATCH_SIZE) {
                await new Promise(r => setTimeout(r, 150));
                if (this._destroyed || this.leaving) break;

                const chunk = remainingRaw.slice(i, i + BATCH_SIZE)
                    .map(t => this._lcTrackToVideo(t, trackMeta))
                    .filter(Boolean);
                this.addManyToQueue(chunk, false);
                loaded += chunk.length;

                const now = Date.now();
                if (now - lastStatusTime >= 2000 && loaded < allRawTracks.length) {
                  lastStatusTime = now;
                  events.emit("message", `Importing playlist: **${loaded}/${allRawTracks.length}** tracks queued...`);
                }
              }

              events.emit("message", `Successfully added all **${loaded}** songs to the queue from **${playlistName}**.`);
            })().catch(ingestErr => {
              logger.warn("[Player] Background playlist ingestion error:", ingestErr?.message);
            });
            return;
          }
        } else {
          const video = this._lcTrackToVideo(firstTrack, trackMeta);
          if (video) {
            this.addToQueue(video, top);
            events.emit("message", this.buildAddedToQueueEmbed(video, top, trackMeta));
            if (playlistQuery) {
              events.emit("message", "⚠️ Couldn't load the full playlist — added just this video.");
            }
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
      const result = await this._searchFreeText(query, source);
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
    const isAttachment = isFluxerAttachmentUrl(url);
    const resolvedType = isAttachment ? "attachment" : trackType;
    const displayTitle = title || (isAttachment ? extractMediaTitle(url) : this._extractFilenameFromUrl(url));
    const displayArtist = artist || (isAttachment ? "Fluxer Attachment" : null);
    return {
      type:      resolvedType,
      title:     displayTitle,
      url:       url,
      artist:    displayArtist,
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
   * Resolve a Bilibili video link into queueable track(s) — reached from
   * {@link play} for any bilibili.com / b23.tv URL. Multi-part videos queue
   * every part (like a YouTube playlist); `?p=N` queues exactly that part.
   * Metadata and duration come from the view API, so queue display works
   * before any stream is fetched; the audio stream itself is resolved at
   * playback time by {@link module:src/music/player/PlaybackMixin}.
   * @this {import('./Player.mjs').Player}
   * @param {string} query - The raw Bilibili URL.
   * @param {boolean} [top=false] - Insert at the top of the queue.
   * @returns {EventEmitter} Emits "message" events with status strings.
   */
  _playBilibili(query, top = false) {
    const events = new EventEmitter();

    (async () => {
      try {
        /* let the caller attach its "message" listener before the first emit
           (play() relies on the same await-before-emit property) */
        await Promise.resolve();

        if (!bilibiliEnabled()) {
          events.emit("message", this._t("responses.play.bilibiliDisabled"));
          return;
        }

        events.emit("message", this._t("responses.play.bilibiliResolving"));

        const { tracks } = await resolveBilibiliVideo(query);
        if (!tracks.length) {
          events.emit("message", this._t("responses.play.bilibiliNoAudio", { title: "?" }));
          return;
        }

        if (tracks.length === 1) {
          this.addToQueue(tracks[0], top);
          events.emit("message", this.buildAddedToQueueEmbed(tracks[0], top, trackMeta));
        } else {
          this.addManyToQueue(tracks, top);
          events.emit("message", this._t("responses.play.addedPlaylist", { count: tracks.length }));
        }

        if (!this.queue.getCurrent()) {
          this.playNext().catch(e => logger.error("[Player] playNext error:", e.message));
        }
      } catch (err) {
        logger.warn("[Player] Bilibili resolve failed:", err?.message);
        events.emit("message", this._t("responses.play.bilibiliError", {
          message: err?.message || String(err),
        }));
      }
    })();

    return events;
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
        events.emit("message", this.buildAddedToQueueEmbed(track, top));

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
