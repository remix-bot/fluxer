/**
 * @module src/services/lastfm/urlUtils
 * @description Standalone Last.fm URL helpers: parsing music URLs into
 * artist/track/album components and Last.fm URL validation.
 */

import { logger } from "../../core/Logger.mjs";

/**
 * Parse a Last.fm music URL into its components.
 * @param {string} url - The Last.fm URL to parse.
 * @returns {{artist: string, track: string|null, album: string|null, url: string}|null} Parsed components, or null if not a valid Last.fm music URL.
 */
export function parseLastFmUrl(url) {
  try {
    const u = new URL(url);
    if (!/^(?:www\.)?last\.fm$/i.test(u.hostname)) return null;

    const match = u.pathname.match(/^\/music\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?/);
    if (!match) return null;

    const artist = decodeURIComponent(match[1].replace(/\+/g, " "));
    const segment2 = match[2] ? decodeURIComponent(match[2].replace(/\+/g, " ")) : null;
    const segment3 = match[3] ? decodeURIComponent(match[3].replace(/\+/g, " ")) : null;

    let track = null;
    let album = null;

    if (segment3) {
      album = segment2 === "_" ? null : segment2;
      track = segment3;
    } else if (segment2 && segment2 !== "_") {
      track = segment2;
    }

    return { artist, track, album, url };
  } catch (e) {
    logger.warn("[LastFm] parseLastFmUrl error:", e?.message);
    return null;
  }
}

/**
 * Check whether a string is a valid Last.fm music URL.
 * @param {string} str - String to check.
 * @returns {boolean} True if the string is a Last.fm URL with a /music/ path.
 */
export function isLastFmUrl(str) {
  if (!str || typeof str !== "string") return false;
  try {
    const u = new URL(str);
    return /^(?:www\.)?last\.fm$/i.test(u.hostname) && /^\/music\//i.test(u.pathname);
  } catch (e) {
    return false;
  }
}
