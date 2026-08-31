/** @module src/Utils @description General-purpose utility functions for formatting, validation, string manipulation, and ID cleaning. */

import { escapeMarkdown as _escapeMarkdown, truncate as _truncate } from "@fluxerjs/util";
import { logger } from "./constants/Logger.mjs";

/**
 * Strip all non-digit characters from a value to extract a Snowflake/numeric ID.
 * @param {*} value - The value to clean (string, number, or null/undefined).
 * @returns {string} The numeric portion of the value, or empty string if none.
 */
export function cleanId(value) {
  return String(value ?? "").replace(/\D/g, "");
}

/** @class Utils @description Collection of static utility methods for formatting, parsing, and string manipulation. */
export class Utils {

  /**
   * Format a duration in milliseconds to a human-readable string (e.g. "1:23:45").
   * @param {number} milliseconds - Duration in milliseconds.
   * @returns {string} Formatted duration string.
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
   * Parse a duration string (e.g. "1:30", "1:30:00", "90") into milliseconds.
   * @param {string} str - Duration string in mm:ss, hh:mm:ss, or plain seconds.
   * @returns {number} Duration in milliseconds, or 0 if unparseable.
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
   * Format seconds into a human-readable duration string.
   * @param {number} seconds - Duration in seconds.
   * @returns {string} Formatted duration string.
   */
  static formatSeconds(seconds) {
    if (!seconds || seconds < 0 || !isFinite(seconds)) return "0:00";
    return this.prettifyMS(seconds * 1000);
  }

  /**
   * Fisher-Yates in-place shuffle of an array.
   * @param {Array} array - The array to shuffle (mutated in place).
   * @returns {Array} The same array, shuffled.
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
   * Truncate a string to a maximum length, appending a suffix if truncated.
   * @param {string} str - The string to truncate.
   * @param {number} [maxLen=100] - Maximum character length.
   * @param {string} [suffix="..."] - Suffix to append when truncated.
   * @returns {string} Truncated string.
   */
  static truncate(str, maxLen = 100, suffix = "...") {
    if (!str || typeof str !== "string") return "";
    if (str.length <= maxLen) return str;
    if (maxLen <= suffix.length) return str.substring(0, maxLen);
    return str.substring(0, maxLen - suffix.length) + suffix;
  }

  /**
   * Clean a track title by removing common noise patterns (feat, remix, lyrics, etc.).
   * @param {string} title - The raw track title.
   * @returns {string} Cleaned title.
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
   * Escape Discord markdown special characters in text.
   * @param {string} text - The text to escape.
   * @returns {string} Escaped text, or empty string if falsy.
   */
  static escapeMarkdown(text) {
    if (!text || typeof text !== "string") return "";
    return _escapeMarkdown(text);
  }

  /**
   * Format a number with locale-aware thousand separators.
   * @param {number} num - The number to format.
   * @returns {string} Formatted number string.
   */
  static formatNumber(num) {
    if (num === null || num === undefined || isNaN(num)) return "0";
    return num.toLocaleString("en-US");
  }

  /**
   * Generate a unique ID string based on timestamp and random characters.
   * @param {number} [length=16] - Target length of the ID (clamped 8–32).
   * @returns {string} A unique alphanumeric ID.
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
   * Check whether a value is a valid finite number or numeric string.
   * @param {*} str - Value to check.
   * @returns {boolean} True if the value is a valid number.
   */
  static isNumber(str) {
    if (str === null || str === undefined || str === "") return false;
    if (typeof str === "number") return !isNaN(str) && isFinite(str);
    if (typeof str !== "string") return false;
    const trimmed = str.trim();
    if (trimmed === "") return false;
    return !isNaN(trimmed) && isFinite(trimmed);
  }

  /**
   * Check whether a string is a valid URL.
   * @param {string} str - String to check.
   * @returns {boolean} True if the string is a valid URL.
   */
  static isValidUrl(str) {
    if (!str || typeof str !== "string") return false;
    try {
      new URL(str);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Clamp a number between a minimum and maximum value.
   * @param {number} num - The number to clamp.
   * @param {number} min - Minimum value.
   * @param {number} max - Maximum value.
   * @returns {number} Clamped value.
   */
  static clamp(num, min, max) {
    if (isNaN(num)) return min;
    return Math.max(min, Math.min(max, num));
  }

  /**
   * Return a promise that resolves after a specified delay.
   * @param {number} ms - Delay in milliseconds.
   * @returns {Promise<void>}
   */
  static sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }

  /**
   * Wrap a promise with a timeout. Rejects if the promise does not settle in time.
   * @template T
   * @param {Promise<T>} promise - The promise to wrap.
   * @param {number} ms - Timeout in milliseconds.
   * @param {string} [message="Operation timed out"] - Rejection message.
   * @returns {Promise<T>} The original promise result, or rejection on timeout.
   */
  static timeout(promise, ms, message = "Operation timed out") {
    let timerId;
    const timeoutPromise = new Promise((_, reject) => {
      timerId = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timerId));
  }

  /**
   * Generate a text-based progress bar.
   * @param {number} current - Current progress value or ratio.
   * @param {number} [total] - Total value. If omitted, current is treated as a 0–1 ratio.
   * @param {number} [length=15] - Bar length in characters.
   * @param {string} [filledChar="━"] - Character for the filled portion.
   * @param {string} [emptyChar="─"] - Character for the empty portion.
   * @param {string} [indicator="⬤"] - Character for the current position indicator.
   * @returns {string} The progress bar string.
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
   * Format a track object into a display string with title, artist, and optional duration.
   * @param {object} track - Track object with title, author, and optional duration.
   * @param {boolean} [includeDuration=true] - Whether to include the duration.
   * @returns {string} Formatted track info string.
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
   * Parse an ISO 8601 duration string (e.g. "PT1H30M45S") into milliseconds.
   * @param {string} isoDuration - The ISO duration string.
   * @returns {number} Duration in milliseconds, or 0 if unparseable.
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
   * Normalize text by stripping non-alphanumeric characters, lowercasing, and trimming.
   * Optionally cleans the title first using cleanTitle.
   * @param {string} value - The text to normalize.
   * @param {boolean} [cleanFirst=false] - Whether to run cleanTitle before normalizing.
   * @returns {string} Normalized lowercase text.
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
