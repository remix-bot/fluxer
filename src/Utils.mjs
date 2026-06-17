/**
 * @file Utils.mjs — Utility class with static helpers — text normalization, markdown escaping, duration parsing, and string truncation
 * @module src.Utils
 */

/**
 * Utils.mjs — Music bot utility functions
 * @module Utils
 *
 * Internal helpers delegate to @fluxerjs/util where available
 * (escapeMarkdown, truncate) with additional null-safety guards.
 */

import { escapeMarkdown as _escapeMarkdown, truncate as _truncate } from "@fluxerjs/util";
import { logger } from "./constants/Logger.mjs";

/**
 * Strip non-digit characters from a value, returning a clean ID string.
 * Replaces the inline `String(x).replace(/\D/g, "")` pattern used 97+ times.
 * @param {string|number} value
 * @returns {string}
 */
export function cleanId(value) {
  return String(value ?? "").replace(/\D/g, "");
}

/**
 * @class Utils
 * @description Static utility methods for time formatting, array manipulation,
 * string processing, and validation used across the music bot.
 */
export class Utils {

  /**
   * Format milliseconds to human-readable time string (H:MM:SS or M:SS)
   * @param {number} milliseconds - Duration in milliseconds
   * @returns {string} Formatted time string
   */
  static prettifyMS(milliseconds) {
    if (!milliseconds || milliseconds < 0 || !isFinite(milliseconds)) {
      return "0:00";
    }

    const totalSeconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const pad = (n) => String(n).padStart(2, "0");

    return hours > 0
        ? `${hours}:${pad(minutes)}:${pad(seconds)}`
        : `${minutes}:${pad(seconds)}`;
  }

  /**
   * Parse duration string (H:MM:SS or M:SS or raw seconds) to milliseconds.
   * @param {string} str - Duration string
   * @returns {number} Milliseconds, 0 if invalid
   */
  static parseDuration(str) {
    if (!str || typeof str !== "string") return 0;
    str = str.trim();

    if (/^\d+$/.test(str)) {
      return parseInt(str, 10) * 1000;
    }

    const parts = str.split(":").map((s) => parseInt(s.trim(), 10)).reverse();
    if (parts.some(isNaN) || parts.some(n => n < 0)) return 0;

    let ms = 0;
    if (parts[0] !== undefined) ms += parts[0] * 1000;
    if (parts[1] !== undefined) ms += parts[1] * 60 * 1000;
    if (parts[2] !== undefined) ms += parts[2] * 3600 * 1000;

    return ms;
  }

  /**
   * Format seconds to MM:SS (for NodeLink duration compatibility)
   * @param {number} seconds - Duration in seconds
   * @returns {string} Formatted time
   */
  static formatSeconds(seconds) {
    if (!seconds || seconds < 0 || !isFinite(seconds)) return "0:00";
    return this.prettifyMS(seconds * 1000);
  }

  /**
   * Shuffles array in-place using Fisher-Yates algorithm
   * @template T
   * @param {T[]} array - Array to shuffle
   * @returns {T[]} Same array reference (shuffled)
   */
  static shuffleArr(array) {
    if (!Array.isArray(array) || array.length < 2) return array;

    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  /**
   * Truncate text with ellipsis
   * @param {string} str - String to truncate
   * @param {number} [maxLen=100] - Maximum length
   * @param {string} [suffix="..."] - Suffix to add
   * @returns {string} Truncated string
   */
  static truncate(str, maxLen = 100, suffix = "...") {
    if (!str || typeof str !== "string") return "";
    if (str.length <= maxLen) return str;
    if (maxLen <= suffix.length) return str.substring(0, maxLen);
    return str.substring(0, maxLen - suffix.length) + suffix;
  }

  /**
   * Clean song title by removing common suffixes/prefixes for better matching
   * Used for lyrics search and display normalization
   * @param {string} title - Raw title
   * @returns {string} Cleaned title
   */
  static cleanTitle(title) {
    if (!title || typeof title !== "string") return "Unknown";

    let cleaned = title;
    for (let pass = 0; pass < 3; pass++) {
      const prev = cleaned;
      cleaned = cleaned
          .replace(/\s*\([^()]*\)/g, (match) => {
            const inner = match.toLowerCase();
            if (/(?:feat|ft|featuring|remix|edit|version|prod|official|audio|video|lyrics|visualizer|deluxe|explicit|clean|radio|instrumental|acoustic|extended|mono|stereo|remaster)/.test(inner)) {
              return "";
            }
            return match;
          })
          .replace(/\s*\[[^\[\]]*\]/g, (match) => {
            const inner = match.toLowerCase();
            if (/(?:feat|ft|featuring|remix|edit|version|prod|official|audio|video|lyrics|visualizer|deluxe|explicit|clean|radio|instrumental|acoustic|extended|remaster)/.test(inner)) {
              return "";
            }
            return match;
          });
      if (cleaned === prev) break;
    }

    return cleaned
        .replace(/\s*-\s*(?:feat|ft|featuring)\.?.*/gi, "")
        .replace(/\s*\|.*$/g, "")
        .replace(/\s*【.*?】/g, "")
        .replace(/\s{2,}/g, " ")
        .trim() || "Unknown";
  }

  /**
   * Escape markdown formatting characters.
   * Delegates to @fluxerjs/util escapeMarkdown.
   * @param {string} text - Raw text
   * @returns {string} Escaped text
   */
  static escapeMarkdown(text) {
    if (!text || typeof text !== "string") return "";
    return _escapeMarkdown(text);
  }

  /**
   * Format number with commas (e.g., 1,000,000)
   * @param {number} num - Number to format
   * @returns {string} Formatted number
   */
  static formatNumber(num) {
    if (num === null || num === undefined || isNaN(num)) return "0";
    return num.toLocaleString("en-US");
  }

  /**
   * Generate random unique ID
   * @param {number} [length=16] - Desired length of ID (8-32 recommended)
   * @returns {string} Random ID
   */
  static uid(length = 16) {
    const targetLen = Math.max(8, Math.min(length, 32));

    const timestamp = Date.now().toString(36).toUpperCase();
    let random = "";

    while ((timestamp + random).length < targetLen) {
      random += Math.random().toString(36).substring(2).toUpperCase();
    }

    return (timestamp + random).substring(0, targetLen);
  }

  /**
   * Check if a value represents a finite number
   * @param {string|number} str
   * @returns {boolean}
   */
  static isNumber(str) {
    if (str === null || str === undefined || str === "") return false;
    if (typeof str === "number") return !isNaN(str) && isFinite(str);
    if (typeof str !== "string") return false;
    return !isNaN(str) && isFinite(str);
  }

  /**
   * Check if value is a valid URL
   * Used by worker.mjs YTUtils.isValidUrl
   * @param {string} str - String to check
   * @returns {boolean} True if valid URL
   */
  static isValidUrl(str) {
    if (!str || typeof str !== "string") return false;
    try {
      new URL(str);
      return true;
    } catch (e) {
        logger.warn("[Utils] Error:", e?.message);
        return false;
    }
  }

  /**
   * Clamp number between min and max
   * @param {number} num - Number to clamp
   * @param {number} min - Minimum value
   * @param {number} max - Maximum value
   * @returns {number} Clamped value
   */
  static clamp(num, min, max) {
    if (isNaN(num)) return min;
    return Math.max(min, Math.min(max, num));
  }

  /**
   * Sleep/delay promise
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise<void>}
   */
  static sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }

  /**
   * Timeout wrapper for promises
   * @template T
   * @param {Promise<T>} promise - Promise to wrap
   * @param {number} ms - Timeout in milliseconds
   * @param {string} [message="Operation timed out"] - Error message
   * @returns {Promise<T>}
   */
  static timeout(promise, ms, message = "Operation timed out") {
    let timerId;
    const timeoutPromise = new Promise((_, reject) => {
      timerId = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timerId));
  }

  /**
   * Create progress bar string
   * @param {number} current - Current position in ms or 0-1 ratio
   * @param {number} [total] - Total duration in ms (if omitted, current is treated as 0-1 ratio)
   * @param {number} [length=15] - Bar length in characters
   * @param {string} [filledChar="━"] - Filled character
   * @param {string} [emptyChar="─"] - Empty character
   * @param {string} [indicator="⬤"] - Position indicator
   * @returns {string} Progress bar string
   */
  static progressBar(
      current,
      total,
      length = 15,
      filledChar = "━",
      emptyChar = "─",
      indicator = "⬤"
  ) {
    let progress;
    if (total !== undefined && total > 0) {
      progress = this.clamp(current / total, 0, 1);
    } else {
      progress = this.clamp(current, 0, 1);
    }

    const position = Math.min(Math.floor(progress * length), length - 1);
    let bar = "";

    for (let i = 0; i < length; i++) {
      if (i === position) {
        bar += indicator;
      } else if (i < position) {
        bar += filledChar;
      } else {
        bar += emptyChar;
      }
    }

    return bar;
  }

  /**
   * Format track info for display
   * @param {object} track - Track object
   * @param {boolean} [includeDuration=true] - Include duration
   * @returns {string} Formatted string
   */
  static formatTrackInfo(track, includeDuration = true) {
    if (!track) return "Unknown Track";

    const title = this.cleanTitle(track.title || "Unknown");
    const author = track.author?.name || track.author || "Unknown Artist";

    if (includeDuration && track.duration) {
      const duration = typeof track.duration === "number"
          ? this.prettifyMS(track.duration)
          : track.duration.timestamp || track.duration.seconds
              ? this.formatSeconds(track.duration.seconds)
              : "?:??";
      return `${title} - ${author} [${duration}]`;
    }

    return `${title} - ${author}`;
  }

  /**
   * Parse YouTube-like ISO duration (PT4M13S) to milliseconds
   * @param {string} isoDuration - ISO 8601 duration
   * @returns {number} Milliseconds
   */
  static parseISODuration(isoDuration) {
    if (!isoDuration || typeof isoDuration !== "string") return 0;

    const match = isoDuration.match(
        /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/
    );
    if (!match) return 0;

    const hours = parseInt(match[1] || 0, 10);
    const minutes = parseInt(match[2] || 0, 10);
    const seconds = parseFloat(match[3] || 0);

    return (hours * 3600 + minutes * 60 + seconds) * 1000;
  }

  /**
   * Normalize text for fuzzy matching: NFKD, strip non-word chars, collapse whitespace, lowercase.
   * Replaces the duplicated normalizeMatchText / normalizeTrackText functions.
   * @param {string} value - Raw text to normalize
   * @param {boolean} [cleanFirst=false] - Run cleanTitle() first (for worker.mjs title matching)
   * @returns {string} Normalized text
   */
  static normalizeText(value, cleanFirst = false) {
    let text = String(value ?? "");
    if (cleanFirst) text = this.cleanTitle(text);
    return text
        .normalize("NFKD")
        .replace(/[^\w\s]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
  }
}
