/**
 *
 * worker.mjs — NodeLink REST edition (moonlink.js session-aware)
 *
 */

import { workerData, parentPort } from "worker_threads";
import { EventEmitter } from "events";
import http  from "http";
import https from "https";
import { Utils } from "./Utils.mjs";
import { PROVIDERS } from "./constants/providers.mjs";
import { logger } from "./constants/Logger.mjs";

// ═══════════════════════════════════════════════════════════════════════════════
// NodeLink Configuration (forwarded from Player via workerData)
// ═══════════════════════════════════════════════════════════════════════════════

const nl           = workerData?.data?.nodelink ?? {};
const NL_HOST      = nl.host      ?? "localhost";
const NL_PORT      = nl.port      ?? 3000;
// Shared default — must match NL_DEFAULT_PASSWORD in Player.mjs
const NL_DEFAULT_PASSWORD = "youshallnotpass";
const NL_PASSWORD  = nl.password  ?? NL_DEFAULT_PASSWORD;
const NL_SESSION_ID = nl.sessionId ?? null;   // provided by moonlink.js Manager
const NL_GUILD_ID  = workerData?.data?.guildId ?? null;

// ─── Error sanitizer ──────────────────────────────────────────────────────────
// Compile regexes once at module load (constants are fixed for the worker's lifetime).
// Re-compiling on every sanitizeError() call was wasteful and identical each time.
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

// Strips the NodeLink host, port, and password from any string so they are
// never shown to end-users in messages.
function sanitizeError(msg) {
  if (!msg) return msg;
  let s = String(msg);
  for (const { re, sub } of _sanitizeRegexes) {
    re.lastIndex = 0; // reset stateful global regexes between calls
    s = s.replace(re, sub);
  }
  return s;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP Helper
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Make a GET request to NodeLink and return the parsed JSON body.
 * @param {string} path - API path (e.g. "/v4/loadtracks?identifier=…")
 * @returns {Promise<object>}
 */
function nlGet(path) {
  return new Promise((resolve, reject) => {
    const isHttps  = NL_PORT === 443;
    const mod      = isHttps ? https : http;
    const protocol = isHttps ? "https" : "http";

    const req = mod.get(
        `${protocol}://${NL_HOST}:${NL_PORT}${path}`,
        {
          headers: {
            Authorization: NL_PASSWORD,
            ...(NL_SESSION_ID ? { "Session-Id": NL_SESSION_ID } : {}),
            ...(NL_GUILD_ID   ? { "Guild-Id":   NL_GUILD_ID   } : {}),
          }
        },
        (res) => {
          const chunks = [];
          res.on("data", d => chunks.push(d));
          res.on("end", () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString()));
            } catch (e) {
              reject(new Error(`NodeLink JSON parse error: ${e.message}`));
            }
          });
        }
    );

    req.on("error", reject);
    req.setTimeout(30_000, () => {
      req.destroy();
      reject(new Error("NodeLink request timeout"));
    });
  });
}

/**
 * Call NodeLink /v4/loadtracks.
 * @param {string} identifier
 * @returns {Promise<object>}
 */
async function loadTracks(identifier, nlGetFn = nlGet) {
  return nlGetFn(`/v4/loadtracks?identifier=${encodeURIComponent(identifier)}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Track Conversion
// ═══════════════════════════════════════════════════════════════════════════════

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
  return Utils.cleanTitle(String(value ?? ""))
    .normalize("NFKD")
    .replace(/[^\w\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function tokenizeMatchText(value) {
  return normalizeMatchText(value).split(" ").filter(Boolean);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Provider Configuration  (imported from constants/providers.mjs)
// ═══════════════════════════════════════════════════════════════════════════════

const TYPE_MODIFIERS = ["track","playlist","album","artist","channel","user"];

// ═══════════════════════════════════════════════════════════════════════════════
// YTUtils Class
// ═══════════════════════════════════════════════════════════════════════════════

class YTUtils extends EventEmitter {
  constructor() { super(); }

  isValidUrl(str)      { return Utils.isValidUrl(str); }
  _prefix(p)           { return PROVIDERS[p]?.prefix  ?? "ytmsearch"; }
  _providerLabel(p)    { return PROVIDERS[p]?.label   ?? "YouTube Music"; }
  _isAudioPreferredProvider(p) { return p === "ytm"; }

  _buildRequestContext(query, trackMeta = null) {
    const requestedTitle = trackMeta?.name ?? trackMeta?.title ?? query;
    const requestedArtist = trackMeta?.artist ?? "";

    return {
      normalizedTitle: normalizeMatchText(requestedTitle),
      normalizedArtist: normalizeMatchText(requestedArtist),
      queryTokens: tokenizeMatchText(query),
      titleTokens: tokenizeMatchText(requestedTitle),
      artistTokens: tokenizeMatchText(requestedArtist),
    };
  }

  _buildIdentifier(provider, query) {
    const prefix    = this._prefix(provider);
    const colonIdx  = query.indexOf(":");
    if (colonIdx !== -1) {
      const maybeType = query.slice(0, colonIdx).toLowerCase();
      if (TYPE_MODIFIERS.includes(maybeType)) return `${prefix}:${query}`;
    }
    return `${prefix}:track:${query}`;
  }

  /**
   * Clean YouTube Radio/Mix URLs to extract just the video
   * YouTube Radio URLs (list=RD...) often cause metadata mismatches
   */
  _cleanYouTubeUrl(url) {
    try {
      const urlObj = new URL(url);

      // Check if it's a YouTube Radio/Mix URL
      const list = urlObj.searchParams.get("list");
      if (list && list.startsWith("RD")) {
        // Extract just the video ID and create clean URL
        const videoId = urlObj.searchParams.get("v");
        if (videoId) {
          logger.worker(`[Worker] Cleaning YouTube Radio URL, extracted video: ${videoId}`);
          return `https://www.youtube.com/watch?v=${videoId}`;
        }
      }

      // Remove start_radio parameter if present
      if (urlObj.searchParams.has("start_radio")) {
        urlObj.searchParams.delete("start_radio");
        return urlObj.toString();
      }

      return url;
    } catch (e) {
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
      const normalizedTitle = normalizeMatchText(info.title);
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
    const playable = tracks.filter(track => this._isPlayableTrack(track));
    const candidates = playable.length > 0 ? playable : tracks;
    if (!candidates.length) return null;

    return candidates
        .map((track, index) => ({ track, index, score: this._scoreTrackForAudio(track, provider, request) }))
        .sort((a, b) => b.score - a.score || a.index - b.index)[0]
        ?.track ?? null;
  }

  _rankTracks(tracks, provider = "ytm", request = null) {
    const playable = tracks.filter(track => this._isPlayableTrack(track));
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
      artist: trackMeta.artist ?? video.artist ?? null,
      requestedArtist: trackMeta.artist ?? video.requestedArtist ?? null,
      requestedTitle: trackMeta.name ?? trackMeta.title ?? video.requestedTitle ?? null,
      lastfm: {
        source: trackMeta.source ?? "lastfm",
        artist: trackMeta.artist ?? null,
        name: trackMeta.name ?? trackMeta.title ?? null,
        url: trackMeta.url ?? "",
      },
    };
  }

  async getResults(query, limit = 5, provider = "ytm", trackMeta = null) {
    const id   = this.isValidUrl(query) ? query : this._buildIdentifier(provider, query);
    const data = await loadTracks(id, this._nlGet ?? nlGet);
    const request = this._buildRequestContext(query, trackMeta);

    let tracks = [];
    if      (data.loadType === "search")   tracks = data.data ?? [];
    else if (data.loadType === "track")    tracks = data.data ? [data.data] : [];
    else if (data.loadType === "playlist") tracks = data.data?.tracks ?? [];

    const resultTracks = this._rankTracks(tracks, provider, request);
    return { data: resultTracks.slice(0, limit).map(track => this._applyTrackMeta(trackToVideo(track), trackMeta)) };
  }

  async getVideoData(query, provider = "ytm", trackMeta = null) {
    const request = this._buildRequestContext(query, trackMeta);

    // Handle URLs (including YouTube Radio/Mix)
    if (this.isValidUrl(query)) {
      this.emit("message", "Loading...");

      // Clean YouTube Radio URLs to prevent metadata mismatches
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

      // Handle playlist results
      if (data.loadType === "playlist") {
        const tracks = (data.data?.tracks ?? []).map(track => this._applyTrackMeta(trackToVideo(track), trackMeta));
        tracks.forEach(t => { t.playlistName = data.data?.info?.name ?? null; });
        this.emit("message", `Successfully added **${tracks.length}** songs to the queue.`);
        return { type: "list", data: tracks };
      }

      // Handle single track
      if (data.loadType === "track" && data.data) {
        const video = this._applyTrackMeta(trackToVideo(data.data), trackMeta);
        if (!video) return { type: "error", data: "Failed to parse track data." };
        this.emit("message", `Successfully added [${video.title}](${video.url}) to the queue.`);
        return { type: "video", data: video };
      }

      if (data.loadType === "track" && !data.data) {
        this.emit("message", `**Track data was empty for '${query}'.**`);
        return { type: "error", data: "Empty track data returned." };
      }

      // Handle search results (take first)
      if (data.loadType === "search" && data.data?.length) {
        const bestTrack = this._pickBestTrack(data.data, provider, request) ?? data.data[0];
        const video = this._applyTrackMeta(trackToVideo(bestTrack), trackMeta);
        this.emit("message", `Successfully added [${video.title}](${video.url}) to the queue.`);
        return { type: "video", data: video };
      }

      // No recognizable loadType
      this.emit("message", `**Could not load that URL.** (loadType: ${data.loadType || "unknown"})`);
      return { type: "error", data: null, error: "Unknown loadType: " + (data.loadType || "none") };
    }

    // Handle search queries (non-URLs)
    this.emit("message", `Searching ${this._providerLabel(provider)}...`);

    let data;
    try {
      data = await loadTracks(this._buildIdentifier(provider, query), this._nlGet ?? nlGet);
    } catch (e) {
      this.emit("message", `**Search failed. Please try again.**`);
      return { type: "error", data: null, error: sanitizeError(e.message) };
    }

    // Handle search results
    if (data.loadType === "search" && data.data?.length) {
      const trackToUse = this._pickBestTrack(data.data, provider, request) ?? data.data[0];
      const video      = this._applyTrackMeta(trackToVideo(trackToUse), trackMeta);
      this.emit("message", `Successfully added [${video.title}](${video.url}) to the queue.`);
      return { type: "video", data: video };
    }

    // Handle playlist from search
    if (data.loadType === "playlist") {
      const tracks = (data.data?.tracks ?? []).map(track => this._applyTrackMeta(trackToVideo(track), trackMeta));
      if (tracks.length > 0) {
        this.emit("message", `Successfully added **${tracks.length}** songs to the queue.`);
        return { type: "list", data: tracks };
      }
    }

    // Single track from search
    if (data.loadType === "track" && data.data) {
      const video = this._applyTrackMeta(trackToVideo(data.data), trackMeta);
      if (!video) return { type: "error", data: "Failed to parse track data." };
      this.emit("message", `Successfully added [${video.title}](${video.url}) to the queue.`);
      return { type: "video", data: video };
    }

    if (data.loadType === "track" && !data.data) {
      this.emit("message", `**Track data was empty for '${query}'.**`);
      return { type: "error", data: "Empty track data returned." };
    }

    // Nothing found
    this.emit("message", `**No results found for '${query}'.**`);
    return { type: "error", data: null, error: "No results found" };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Worker Entry Point
// ═══════════════════════════════════════════════════════════════════════════════

const jobId = workerData?.jobId;
const data  = workerData?.data;

// ─── Pool mode ────────────────────────────────────────────────────────────────
// When spawned by PlayerWorkerPool, the worker stays alive and handles multiple
// jobs via parentPort messages instead of exiting after one.
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

    const nl           = jData?.nodelink ?? {};
    const NL_HOST_job  = nl.host      ?? "localhost";
    const NL_PORT_job  = nl.port      ?? 3000;
    const NL_PASS_job  = nl.password  ?? NL_DEFAULT_PASSWORD;
    const NL_SID_job   = nl.sessionId ?? null;
    const NL_GID_job   = jData?.guildId ?? null;

    // Build a job-scoped request helper so pool workers handle different
    // nodelink configs per job (useful when the session ID rotates).
    const nlGetJob = (path) => new Promise((resolve, reject) => {
      const isHttps  = NL_PORT_job === 443;
      const mod      = isHttps ? https : http;
      const protocol = isHttps ? "https" : "http";
      const req = mod.get(
          `${protocol}://${NL_HOST_job}:${NL_PORT_job}${path}`,
          {
            headers: {
              Authorization: NL_PASS_job,
              ...(NL_SID_job ? { "Session-Id": NL_SID_job } : {}),
              ...(NL_GID_job ? { "Guild-Id":   NL_GID_job } : {}),
            }
          },
          (res) => {
            const chunks = [];
            res.on("data", d => chunks.push(d));
            res.on("end", () => {
              try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
              catch (e) { reject(new Error(`NodeLink JSON parse error: ${e.message}`)); }
            });
          }
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

  // Keep the worker alive — don't exit, the pool will terminate() when done.
}

// ─── Legacy single-job mode (fallback / dev) ──────────────────────────────────
else {

if (!jobId) {
  logger.error("No jobId provided to worker");
  process.exit(1);
}

const utils = new YTUtils();

const post = (event, payload) => {
  parentPort.postMessage(JSON.stringify({ event, data: payload }));
};

utils.on("message", (m) => {
  if (jobId === "dev") { logger.worker("[Message]", m); return; }
  post("message", m);
});

utils.on("error", (m) => {
  if (jobId === "dev") { logger.worker("[Error]", m); return; }
  post("error", m);
});

(async () => {
  if (jobId === "dev") {
    try {
      const result = await utils.getVideoData("Neoni funeral", "ytm");
      logger.worker("[Worker result]", result);
    } catch (e) {
      logger.error("[Worker error]", e);
    }
    return;
  }

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
