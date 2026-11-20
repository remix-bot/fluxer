/**
 * @module src/music/audio/RadioMetadata
 * @description Out-of-band Shoutcast and Icecast metadata extractor.
 * Polls stream headers and interleaved ICY metadata frames or Icecast status
 * JSON out-of-band without corrupting or interfering with audio streaming.
 */

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

/**
 * Extract live song title from Shoutcast/Icecast ICY metadata frames out-of-band.
 * @param {string} url - Stream URL to probe.
 * @param {number} [timeoutMs=6000] - Socket timeout in milliseconds.
 * @returns {Promise<string|null>}
 */
export function fetchIcyStreamTitle(url, timeoutMs = 6000) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const client = parsed.protocol === "https:" ? https : http;
      const req = client.get(parsed, {
        headers: {
          "Icy-MetaData": "1",
          "User-Agent": "FluxerBot/1.0 (Radio Title Poller)",
        },
      }, (res) => {
        const metaint = parseInt(res.headers["icy-metaint"], 10);
        if (!metaint || isNaN(metaint)) {
          req.destroy();
          return resolve(null);
        }

        let totalBytes = 0;
        let metaLen = 0;
        let metaBuffer = null;
        let metaBytesRead = 0;
        let state = 0;

        res.on("data", (chunk) => {
          let pos = 0;
          while (pos < chunk.length) {
            if (state === 0) {
              const needed = metaint - totalBytes;
              const available = chunk.length - pos;
              if (available < needed) {
                totalBytes += available;
                pos = chunk.length;
              } else {
                pos += needed;
                totalBytes = 0;
                state = 1;
              }
            } else if (state === 1) {
              metaLen = chunk[pos] * 16;
              pos += 1;
              if (metaLen === 0) {
                state = 0;
              } else {
                metaBuffer = Buffer.alloc(metaLen);
                metaBytesRead = 0;
                state = 2;
              }
            } else if (state === 2) {
              const needed = metaLen - metaBytesRead;
              const available = chunk.length - pos;
              const toCopy = Math.min(needed, available);
              chunk.copy(metaBuffer, metaBytesRead, pos, pos + toCopy);
              metaBytesRead += toCopy;
              pos += toCopy;
              if (metaBytesRead >= metaLen) {
                const metaStr = metaBuffer.toString("utf8");
                const match = metaStr.match(/StreamTitle='([^']*)'/i);
                req.destroy();
                return resolve(match && match[1] ? match[1].trim() : null);
              }
            }
          }
        });

        res.on("error", () => {
          try { req.destroy(); } catch (_) {}
          resolve(null);
        });
      });

      req.on("error", () => resolve(null));
      req.setTimeout(timeoutMs, () => {
        try { req.destroy(); } catch (_) {}
        resolve(null);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

/**
 * Fetch current track title from Icecast status-json.xsl endpoint.
 * @param {string} streamUrl - Stream URL.
 * @param {number} [timeoutMs=3000] - Request timeout.
 * @returns {Promise<string|null>}
 */
export async function fetchIcecastJsonTitle(streamUrl, timeoutMs = 3000) {
  try {
    const parsed = new URL(streamUrl);
    const jsonUrl = `${parsed.protocol}//${parsed.host}/status-json.xsl`;
    const res = await fetch(jsonUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": "FluxerBot/1.0" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const sources = Array.isArray(data?.icestats?.source)
      ? data.icestats.source
      : [data?.icestats?.source].filter(Boolean);
    const mount = parsed.pathname;
    const match = sources.find((s) => s.listenurl?.endsWith(mount) || s.server_name);
    const raw = match?.title || match?.yp_currently_playing;
    return raw && typeof raw === "string" ? raw.trim() : null;
  } catch (_) {
    return null;
  }
}

/**
 * Resolve radio stream title using out-of-band ICY frames with status-json fallback.
 * @param {string} url - Stream URL.
 * @param {number} [timeoutMs=6000] - Timeout.
 * @returns {Promise<string|null>}
 */
export async function fetchRadioStreamTitle(url, timeoutMs = 6000) {
  if (!url || typeof url !== "string") return null;
  const icyTitle = await fetchIcyStreamTitle(url, timeoutMs);
  if (icyTitle) return icyTitle;
  return fetchIcecastJsonTitle(url, 3000);
}
