/**
 * @file worker.mjs — Worker thread module — handles track search jobs via NodeLink REST API with provider fallback chains
 * @module src.worker
 */

/**
 * worker.mjs — NodeLink REST edition (moonlink.js session-aware)
 */

import { workerData, parentPort } from "worker_threads";
import { EventEmitter } from "events";
import http  from "http";
import https from "https";
import { Utils, cleanId } from "./Utils.mjs";
import { PROVIDERS } from "./constants/providers.mjs";
import { logger } from "./constants/Logger.mjs";

const NL_DEFAULT_PASSWORD = "youshallnotpass";

const nl           = workerData?.data?.nodelink ?? {};
const NL_HOST      = nl.host      ?? "localhost";
const NL_PORT      = nl.port      ?? 3000;

const NL_PASSWORD  = nl.password  ?? NL_DEFAULT_PASSWORD;
const NL_SESSION_ID = nl.sessionId ?? null;
const NL_GUILD_ID  = workerData?.data?.guildId ?? null;

const _sanitizeRegexes = (() => {
  const r = [];
  if (NL_HOST && NL_HOST !== "localhost") {
    const eh = NL_HOST.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    r.push({ re: new RegExp(`https?://${eh}(:\\d+)?[^\\s"']*`, "gi"), sub: "[internal]" });
    r.push({ re: new RegExp(`${eh}:${NL_PORT}`, "g"),                  sub: "[internal]" });
  }
  r.push({ re: new RegExp(`https?://localhost:${NL_PORT}[^\\s"']*`, "gi"), sub: "[internal]" });
  if (NL_PASSWORD && NL_PASSWORD !== NL_DEFAULT_PASSWORD) {
    const ep = NL_PASSWORD.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    r.push({ re: new RegExp(ep, "g"), sub: "[redacted]" });
  }
  return r;
})();

function sanitizeError(msg) {
  if (!msg) return msg;
  let s = String(msg);
  for (const { re, sub } of _sanitizeRegexes) {
    re.lastIndex = 0;
    s = s.replace(re, sub);
  }
  return s;
}

/**
 * HTTP GET to NodeLink. Rejects on non-2xx so callers never mistake
 * an auth/server error for a legitimate empty-result response.
 * @param {string} path
 * @param {string} password
 * @param {string|null} sessionId
 * @param {string|null} guildId
 * @returns {Promise<object>}
 */
function nlRequest(path, password, sessionId, guildId) {
  return new Promise((resolve, reject) => {
    const isHttps  = NL_PORT === 443;
    const mod      = isHttps ? https : http;
    const protocol = isHttps ? "https" : "http";

    const req = mod.get(
      `${protocol}://${NL_HOST}:${NL_PORT}${path}`,
      {
        headers: {
          Authorization: password,
          ...(sessionId ? { "Session-Id": sessionId } : {}),
          ...(guildId  ? { "Guild-Id":   guildId  } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", d => chunks.push(d));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString();

          if (res.statusCode < 200 || res.statusCode >= 300) {
            let detail = "";
            try {
              const parsed = JSON.parse(body);
              detail = parsed.error ?? parsed.message ?? "";
            } catch (_) {
              detail = body.slice(0, 200);
            }
            return reject(new Error(`NodeLink HTTP ${res.statusCode}${detail ? ": " + detail : ""}`));
          }

          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`NodeLink JSON parse error: ${e.message}`));
          }
        });
      },
    );

    req.on("error", reject);
    req.setTimeout(30_000, () => {
      req.destroy();
      reject(new Error("NodeLink request timeout"));
    });
  });
}

/** Worker-thread-level NodeLink GET (uses global credentials). */
function nlGet(path) {
  return nlRequest(path, NL_PASSWORD, NL_SESSION_ID, NL_GUILD_ID);
}

/**
 * Call NodeLink /v4/loadtracks.
 * @param {string} identifier
 * @param {function} getFn
 * @returns {Promise<object>}
 */
async function loadTracks(identifier, getFn = nlGet) {
  return getFn(`/v4/loadtracks?identifier=${encodeURIComponent(identifier)}`);
}

/**
 * Convert a NodeLink track object to the internal video format.
 * @param {object} track
 * @returns {object|null}
 */
function trackToVideo(track) {
  if (!track || typeof track !== "object") return null;

  const info = track.info ?? {};
  const ms   = info.length ?? 0;

  return {
    videoId:    info.identifier ?? "",
    encoded:    track.encoded   ?? "",
    sourceName: info.sourceName ?? "unknown",
    title:      Utils.cleanTitle(info.title ?? "Unknown"),
    url:        info.uri ?? `https://www.youtube.com/watch?v=${info.identifier}`,
    thumbnail:  info.artworkUrl ?? null,
    spotifyUrl: null,
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
}

function normalizeMatchText(value) {
  return Utils.normalizeText(value, true);
}

function tokenizeMatchText(value) {
  return normalizeMatchText(value).split(" ").filter(Boolean);
}

/**
 * Extract an array of track objects from any NodeLink loadTracks response,
 * regardless of loadType. Returns [] for empty/error/unknown responses.
 * @param {object} data - NodeLink /v4/loadtracks response
 * @returns {object[]}
 */
function extractTracks(data) {
  if (!data || !data.loadType) return [];

  switch (data.loadType) {
    case "track":
      return data.data ? [data.data] : [];
    case "search":
      return Array.isArray(data.data) ? data.data : [];
    case "playlist":
      return data.data?.tracks ?? [];
    case "empty":
    case "error":
      return [];
    default:
      return [];
  }
}

const TYPE_MODIFIERS = ["track", "playlist", "album", "artist", "channel", "user"];

class YTUtils extends EventEmitter {
  constructor() {
    super();
  }

  isValidUrl(str)                   { return Utils.isValidUrl(str); }
  _prefix(p)                        { return PROVIDERS[p]?.prefix  ?? "ytmsearch"; }
  _providerLabel(p)                 { return PROVIDERS[p]?.label   ?? "YouTube Music"; }
  _isAudioPreferredProvider(p)      { return p === "ytm"; }

  /**
   * Build all identifier variants to try for a given provider + query.
   * Different NodeLink source plugins accept different identifier formats.
   * Some handle `<prefix>:<query>`, others only handle `<prefix>:track:<query>`.
   * We return both variants so the caller can try each in order.
   * @param {string} provider
   * @param {string} query
   * @returns {string[]}
   */
  _buildIdentifiers(provider, query) {
    const prefix = this._prefix(provider);

    const colonIdx = query.indexOf(":");
    if (colonIdx !== -1) {
      const maybeType = query.slice(0, colonIdx).toLowerCase();
      if (TYPE_MODIFIERS.includes(maybeType)) {
        return [`${prefix}:${query}`];
      }
    }

    return [
      `${prefix}:${query}`,
      `${prefix}:track:${query}`,
    ];
  }

  _buildRequestContext(query, trackMeta = null) {
    const requestedTitle  = trackMeta?.name ?? trackMeta?.title ?? query;
    const requestedArtist = trackMeta?.artist ?? "";

    return {
      normalizedTitle:  normalizeMatchText(requestedTitle),
      normalizedArtist: normalizeMatchText(requestedArtist),
      queryTokens:      tokenizeMatchText(query),
      titleTokens:      tokenizeMatchText(requestedTitle),
      artistTokens:     tokenizeMatchText(requestedArtist),
    };
  }

  /**
   * Clean YouTube Radio/Mix URLs to extract just the video ID.
   * YouTube Radio URLs (list=RD...) often cause metadata mismatches.
   * @param {string} url
   * @returns {string}
   */
  _cleanYouTubeUrl(url) {
    try {
      const urlObj = new URL(url);

      const list = urlObj.searchParams.get("list");
      if (list && list.startsWith("RD")) {
        const videoId = urlObj.searchParams.get("v");
        if (videoId) {
          logger.worker(`[Worker] Cleaned YouTube Radio URL, extracted video: ${videoId}`);
          return `https://www.youtube.com/watch?v=${videoId}`;
        }
      }

      if (urlObj.searchParams.has("start_radio")) {
        urlObj.searchParams.delete("start_radio");
        return urlObj.toString();
      }

      return url;
    } catch (_) {
      return url;
    }
  }

  _isPlayableTrack(track) {
    const info = track?.info ?? {};
    const uri  = info.uri || "";
    if (uri.includes("/channel/"))                       return false;
    if (uri.includes("/c/") && !uri.includes("/watch")) return false;
    if (uri.includes("/playlist?"))                      return false;
    if (uri.includes("/user/"))                          return false;
    if (!info.length || info.length === 0)               return false;
    return true;
  }

  _scoreTrackForAudio(track, provider = "ytm", request = null) {
    if (!this._isPlayableTrack(track)) return Number.NEGATIVE_INFINITY;

    const info   = track?.info ?? {};
    const title  = String(info.title ?? "").toLowerCase();
    const author = String(info.author ?? "").toLowerCase();
    const uri    = String(info.uri ?? "").toLowerCase();
    const source = String(info.sourceName ?? "").toLowerCase();
    const text   = `${title} ${author} ${uri} ${source}`;

    let score = 0;

    const positiveHints = [
      /\bofficial audio\b/,
      /\baudio\b/,
      /\bsong\b/,
      /\bprovided to youtube by\b/,
      /\btopic\b/,
      /\bart track\b/,
      /\blyrics?\b/,
    ];

    const negativeHints = [
      /\bofficial music video\b/,
      /\bmusic video\b/,
      /\bofficial video\b/,
      /\bvideo\b/,
      /\bmv\b/,
      /\bvisuali[sz]er\b/,
      /\blive\b/,
      /\bperformance\b/,
      /\bconcert\b/,
      /\bkaraoke\b/,
      /\bsped up\b/,
      /\bslowed\b/,
      /\breverb\b/,
      /\bnightcore\b/,
      /\b8d\b/,
      /\bremix\b/,
      /\bcover\b/,
      /\bfan cam\b/,
    ];

    if (this._isAudioPreferredProvider(provider)) {
      for (const re of positiveHints) {
        if (re.test(text)) score += 3;
      }
      for (const re of negativeHints) {
        if (re.test(text)) score -= 4;
      }

      if (author.endsWith(" - topic") || author.includes("topic")) score += 4;
      if (uri.includes("music.youtube.com")) score += 3;
      if (source === "youtube music") score += 3;
    }

    if (request) {
      const normalizedTitle  = normalizeMatchText(info.title);
      const normalizedAuthor = normalizeMatchText(info.author);
      const fullText = `${normalizedTitle} ${normalizedAuthor} ${normalizeMatchText(info.uri)} ${normalizeMatchText(info.sourceName)}`.trim();

      if (request.normalizedTitle) {
        if (normalizedTitle === request.normalizedTitle) score += 30;
        else if (normalizedTitle.includes(request.normalizedTitle)) score += 18;
        else score -= 6;
      }

      if (request.normalizedArtist) {
        if (normalizedAuthor === request.normalizedArtist) score += 20;
        else if (normalizedAuthor.includes(request.normalizedArtist)) score += 12;
        else score -= 8;
      }

      if (request.queryTokens.length) {
        const overlap = request.queryTokens.filter(token => fullText.includes(token)).length;
        score += overlap * 2;
      }

      if (request.titleTokens.length) {
        const titleOverlap = request.titleTokens.filter(token => normalizedTitle.includes(token)).length;
        score += titleOverlap * 4;
      }

      if (request.artistTokens.length) {
        const artistOverlap = request.artistTokens.filter(token => normalizedAuthor.includes(token)).length;
        score += artistOverlap * 5;
      }
    }

    return score;
  }

  _pickBestTrack(tracks, provider = "ytm", request = null) {
    const playable   = tracks.filter(track => this._isPlayableTrack(track));
    const candidates = playable.length > 0 ? playable : tracks;
    if (!candidates.length) return null;

    return candidates
      .map((track, index) => ({ track, index, score: this._scoreTrackForAudio(track, provider, request) }))
      .sort((a, b) => b.score - a.score || a.index - b.index)[0]
      ?.track ?? null;
  }

  _rankTracks(tracks, provider = "ytm", request = null) {
    const playable   = tracks.filter(track => this._isPlayableTrack(track));
    const candidates = playable.length > 0 ? playable : tracks;

    return candidates
      .map((track, index) => ({ track, index, score: this._scoreTrackForAudio(track, provider, request) }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map(item => item.track);
  }

  _applyTrackMeta(video, trackMeta = null) {
    if (!video || !trackMeta) return video;

    return {
      ...video,
      artist:           trackMeta.artist ?? video.artist ?? null,
      requestedArtist:  trackMeta.artist ?? video.requestedArtist ?? null,
      requestedTitle:   trackMeta.name ?? trackMeta.title ?? video.requestedTitle ?? null,
      lastfm: {
        source: trackMeta.source ?? "lastfm",
        artist: trackMeta.artist ?? null,
        name:   trackMeta.name ?? trackMeta.title ?? null,
        url:    trackMeta.url ?? "",
      },
    };
  }

  /**
   * Return an ordered list of providers to try when searching.
   * The requested provider is first; if it returns no results we fall
   * back to YouTube Music, then YouTube.
   * @param {string} provider
   * @returns {string[]}
   */
  _getFallbackChain(provider) {
    const chain = [provider];
    if (provider !== "ytm") chain.push("ytm");
    if (provider !== "yt")  chain.push("yt");
    return chain;
  }

  /**
   * Search a single provider using multiple identifier formats.
   * Different NodeLink source plugins accept different identifier formats,
   * so we try each variant until one returns results.
   * @param {string} provider
   * @param {string} query
   * @returns {Promise<object[]|null>} Array of tracks, or null if this provider has no results at all.
   */
  async _searchProvider(provider, query) {
    const identifiers = this._buildIdentifiers(provider, query);

    for (const id of identifiers) {
      let data;
      try {
        data = await loadTracks(id, this._nlGet ?? nlGet);
      } catch (e) {
        logger.worker(`[Worker] _searchProvider: loadTracks failed for ${provider} (${id}): ${e.message}`);
        continue;
      }

      const tracks = extractTracks(data);
      if (tracks.length > 0) {
        return tracks;
      }
    }

    return null;
  }

  /**
   * Search for multiple results (used by search command).
   * @param {string} query
   * @param {number} limit
   * @param {string} provider
   * @param {object|null} trackMeta
   * @returns {Promise<{data: object[]}>}
   */
  async getResults(query, limit = 5, provider = "ytm", trackMeta = null) {
    const request   = this._buildRequestContext(query, trackMeta);
    const providers = this._getFallbackChain(provider);

    for (const prov of providers) {
      const id = this.isValidUrl(query) ? query : null;

      let tracks;
      if (id) {
        let data;
        try {
          data = await loadTracks(id, this._nlGet ?? nlGet);
        } catch (_) {
          continue;
        }
        tracks = extractTracks(data);
      } else {
        tracks = await this._searchProvider(prov, query);
      }

      if (tracks && tracks.length > 0) {
        const resultTracks = this._rankTracks(tracks, prov, request);
        return { data: resultTracks.slice(0, limit).map(track => this._applyTrackMeta(trackToVideo(track), trackMeta)) };
      }

      logger.worker(`[Worker] getResults: no results from ${prov}, trying fallback...`);
    }

    return { data: [] };
  }

  /**
   * Search for a single track (used by play command).
   * Tries multiple identifier formats per provider, then falls back
   * through the provider chain until a result is found.
   * @param {string} query
   * @param {string} provider
   * @param {object|null} trackMeta
   * @returns {Promise<{type: string, data: *, error?: string}>}
   */
  async getVideoData(query, provider = "ytm", trackMeta = null) {
    const request = this._buildRequestContext(query, trackMeta);

    if (this.isValidUrl(query)) {
      return this._loadUrl(query, provider, request, trackMeta);
    }

    return this._searchByQuery(query, provider, request, trackMeta);
  }

  /**
   * Handle URL-based track loading.
   * @private
   */
  async _loadUrl(query, provider, request, trackMeta) {
    this.emit("message", "Loading...");

    const cleanedUrl = this._cleanYouTubeUrl(query);
    if (cleanedUrl !== query) {
      logger.worker(`[Worker] URL cleaned: ${query} -> ${cleanedUrl}`);
    }

    let data;
    try {
      data = await loadTracks(cleanedUrl, this._nlGet ?? nlGet);
    } catch (e) {
      this.emit("message", `**Failed to load that track.**`);
      return { type: "error", data: null, error: sanitizeError(e.message) };
    }

    if (data.loadType === "empty") {
      this.emit("message", `**No results found for that URL.**`);
      return { type: "error", data: null, error: "No results found (empty)" };
    }

    if (data.loadType === "track" && data.data) {
      const video = this._applyTrackMeta(trackToVideo(data.data), trackMeta);
      if (!video) return { type: "error", data: "Failed to parse track data." };
      this.emit("message", `Successfully added [${video.title}](${video.url}) to the queue.`);
      return { type: "video", data: video };
    }

    if (data.loadType === "playlist") {
      const tracks = (data.data?.tracks ?? []).map(track => this._applyTrackMeta(trackToVideo(track), trackMeta));
      tracks.forEach(t => { t.playlistName = data.data?.info?.name ?? null; });
      if (tracks.length > 0) {
        this.emit("message", `Successfully added **${tracks.length}** songs to the queue.`);
        return { type: "list", data: tracks };
      }
      this.emit("message", `**Playlist was empty.**`);
      return { type: "error", data: null, error: "Playlist was empty" };
    }

    if (data.loadType === "search") {
      if (data.data?.length) {
        const bestTrack = this._pickBestTrack(data.data, provider, request) ?? data.data[0];
        const video = this._applyTrackMeta(trackToVideo(bestTrack), trackMeta);
        this.emit("message", `Successfully added [${video.title}](${video.url}) to the queue.`);
        return { type: "video", data: video };
      }
      this.emit("message", `**Search returned no results for that URL.**`);
      return { type: "error", data: null, error: "Search returned 0 results for URL" };
    }

    this.emit("message", `**Could not load that URL.** (loadType: ${data.loadType || "unknown"})`);
    return { type: "error", data: null, error: "Unknown loadType: " + (data.loadType || "none") };
  }

  /**
   * Handle text-based search across provider fallback chain.
   * For each provider, tries all identifier variants before giving up.
   * @private
   */
  async _searchByQuery(query, provider, request, trackMeta) {
    const providers = this._getFallbackChain(provider);
    let lastError = null;

    for (const prov of providers) {
      this.emit("message", `Searching ${this._providerLabel(prov)}...`);

      const tracks = await this._searchProvider(prov, query);

      if (tracks && tracks.length > 0) {
        const trackToUse = this._pickBestTrack(tracks, prov, request) ?? tracks[0];
        const video = this._applyTrackMeta(trackToVideo(trackToUse), trackMeta);
        if (video) {
          this.emit("message", `Successfully added [${video.title}](${video.url}) to the queue.`);
          return { type: "video", data: video };
        }
        lastError = "Failed to parse track data.";
        continue;
      }

      logger.worker(`[Worker] No results from ${prov}`);
    }

    this.emit("message", `**No results found for '${query}'.**`);
    return { type: "error", data: null, error: lastError ?? "No results found" };
  }
}

const jobId = workerData?.jobId;
const data  = workerData?.data;

if (workerData?.poolMode) {
  const utils = new YTUtils();

  const post = (jobKey, event, payload) => {
    parentPort.postMessage(JSON.stringify({ jobKey, event, data: payload }));
  };

  parentPort.on("message", async (raw) => {
    let parsed;
    try { parsed = typeof raw === "string" ? JSON.parse(raw) : raw; }
    catch (_) { return; }

    const { jobKey, jobId: jId, data: jData } = parsed;
    if (!jobKey || !jId) return;

    const nlJob         = jData?.nodelink ?? {};
    const nlHostJob     = nlJob.host      ?? "localhost";
    const nlPortJob     = nlJob.port      ?? 3000;
    const nlPassJob     = nlJob.password  ?? NL_DEFAULT_PASSWORD;
    const nlSidJob      = nlJob.sessionId ?? null;
    const nlGidJob      = jData?.guildId  ?? null;

    const nlGetJob = (path) => new Promise((resolve, reject) => {
      const isHttps  = nlPortJob === 443;
      const mod      = isHttps ? https : http;
      const protocol = isHttps ? "https" : "http";
      const req = mod.get(
        `${protocol}://${nlHostJob}:${nlPortJob}${path}`,
        {
          headers: {
            Authorization: nlPassJob,
            ...(nlSidJob ? { "Session-Id": nlSidJob } : {}),
            ...(nlGidJob ? { "Guild-Id":   nlGidJob } : {}),
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", d => chunks.push(d));
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString();

            if (res.statusCode < 200 || res.statusCode >= 300) {
              let detail = "";
              try {
                const parsed = JSON.parse(body);
                detail = parsed.error ?? parsed.message ?? "";
              } catch (_) {
                detail = body.slice(0, 200);
              }
              return reject(new Error(`NodeLink HTTP ${res.statusCode}${detail ? ": " + detail : ""}`));
            }

            try { resolve(JSON.parse(body)); }
            catch (e) { reject(new Error(`NodeLink JSON parse error: ${e.message}`)); }
          });
        },
      );
      req.on("error", reject);
      req.setTimeout(30_000, () => { req.destroy(); reject(new Error("NodeLink request timeout")); });
    });

    const jobUtils = new YTUtils();
    jobUtils._nlGet = nlGetJob;

    jobUtils.on("message", (m) => post(jobKey, "message", m));
    jobUtils.on("error",   (m) => post(jobKey, "error", m));

    try {
      let result;
      switch (jId) {
        case "generalQuery":
          result = await jobUtils.getVideoData(jData.query, jData.provider, jData.trackMeta);
          break;
        case "searchResults":
          result = await jobUtils.getResults(jData.query, jData.resultCount, jData.provider, jData.trackMeta);
          break;
        case "search":
          result = await jobUtils.getVideoData(jData.query ?? String(jData), "ytm");
          result = result?.data ?? null;
          break;
        default:
          post(jobKey, "error", `Unknown jobId: ${jId}`);
          return;
      }
      post(jobKey, "finished", result);
    } catch (err) {
      post(jobKey, "error", err.message);
    } finally {
      jobUtils.removeAllListeners();
    }
  });

} else {

if (!jobId) {
  logger.error("No jobId provided to worker");
  process.exit(1);
}

const utils = new YTUtils();

const post = (event, payload) => {
  parentPort.postMessage(JSON.stringify({ event, data: payload }));
};

utils.on("message", (m) => {
  post("message", m);
});

utils.on("error", (m) => {
  post("error", m);
});

(async () => {
  try {
    switch (jobId) {
      case "generalQuery": {
        const result = await utils.getVideoData(data.query, data.provider, data.trackMeta);
        post("finished", result);
        break;
      }
      case "searchResults": {
        const result = await utils.getResults(data.query, data.resultCount, data.provider, data.trackMeta);
        post("finished", result);
        break;
      }
      case "search": {
        const result = await utils.getVideoData(data.query ?? String(data), "ytm");
        post("finished", result?.data ?? null);
        break;
      }
      default:
        logger.error("Invalid jobId:", jobId);
        post("error", `Unknown jobId: ${jobId}`);
    }
  } catch (err) {
    post("error", err.message);
  } finally {
    process.exit(0);
  }
})();
}
