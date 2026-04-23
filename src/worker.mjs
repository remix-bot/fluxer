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
async function loadTracks(identifier) {
  return nlGet(`/v4/loadtracks?identifier=${encodeURIComponent(identifier)}`);
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

  async getResults(query, limit = 5, provider = "ytm") {
    const id   = this.isValidUrl(query) ? query : this._buildIdentifier(provider, query);
    const data = await loadTracks(id);

    let tracks = [];
    if      (data.loadType === "search")   tracks = data.data ?? [];
    else if (data.loadType === "track")    tracks = [data.data];
    else if (data.loadType === "playlist") tracks = data.data?.tracks ?? [];

    const validTracks = tracks.filter(track => {
      const info = track.info ?? {};
      const uri  = info.uri  || "";
      if (uri.includes("/channel/"))                         return false;
      if (uri.includes("/c/") && !uri.includes("/watch"))   return false;
      if (uri.includes("/playlist?"))                        return false;
      if (uri.includes("/user/"))                            return false;
      if (!info.length || info.length === 0)                 return false;
      return true;
    });

    const resultTracks = validTracks.length > 0 ? validTracks : tracks;
    return { data: resultTracks.slice(0, limit).map(trackToVideo) };
  }

  async getVideoData(query, provider = "ytm") {
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
        data = await loadTracks(cleanedUrl);
      } catch (e) {
        this.emit("message", `**Failed to load that track.**`);
        return { type: "error", data: null, error: sanitizeError(e.message) };
      }

      // Handle playlist results
      if (data.loadType === "playlist") {
        const tracks = (data.data?.tracks ?? []).map(trackToVideo);
        tracks.forEach(t => { t.playlistName = data.data?.info?.name ?? null; });
        this.emit("message", `Successfully added **${tracks.length}** songs to the queue.`);
        return { type: "list", data: tracks };
      }

      // Handle single track
      if (data.loadType === "track") {
        const video = trackToVideo(data.data);
        this.emit("message", `Successfully added [${video.title}](${video.url}) to the queue.`);
        return { type: "video", data: video };
      }

      // Handle search results (take first)
      if (data.loadType === "search" && data.data?.length) {
        const video = trackToVideo(data.data[0]);
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
      data = await loadTracks(this._buildIdentifier(provider, query));
    } catch (e) {
      this.emit("message", `**Search failed. Please try again.**`);
      return { type: "error", data: null, error: sanitizeError(e.message) };
    }

    // Handle search results
    if (data.loadType === "search" && data.data?.length) {
      const validTrack = data.data.find(track => {
        const info = track.info ?? {};
        const uri  = info.uri  || "";
        if (uri.includes("/channel/"))                       return false;
        if (uri.includes("/c/") && !uri.includes("/watch")) return false;
        if (!info.length || info.length === 0)               return false;
        return true;
      });
      const trackToUse = validTrack || data.data[0];
      const video      = trackToVideo(trackToUse);
      this.emit("message", `Successfully added [${video.title}](${video.url}) to the queue.`);
      return { type: "video", data: video };
    }

    // Handle playlist from search
    if (data.loadType === "playlist") {
      const tracks = (data.data?.tracks ?? []).map(trackToVideo);
      if (tracks.length > 0) {
        this.emit("message", `Successfully added **${tracks.length}** songs to the queue.`);
        return { type: "list", data: tracks };
      }
    }

    // Single track from search
    if (data.loadType === "track") {
      const video = trackToVideo(data.data);
      this.emit("message", `Successfully added [${video.title}](${video.url}) to the queue.`);
      return { type: "video", data: video };
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
        const result = await utils.getVideoData(data.query, data.provider);
        post("finished", result);
        break;
      }
      case "searchResults": {
        const result = await utils.getResults(data.query, data.resultCount, data.provider);
        post("finished", result);
        break;
      }
      case "search": {
        const result = await utils.getVideoData(String(data), "ytm");
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