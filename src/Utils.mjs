/**
 * Utils.mjs — Utility functions for the music bot
 * @module Utils
 */

/**
 * @class Utils
 * @description Static utility methods for time formatting, array manipulation,
 * string processing, and validation used across the music bot.
 */
export class Utils {
  // ═════════════════════════════════════════════════════════════════════════════
  // Time & Duration
  // ═════════════════════════════════════════════════════════════════════════════

  /**
   * Format milliseconds to human-readable time string (H:MM:SS or M:SS)
   * @param {number} milliseconds - Duration in milliseconds
   * @returns {string} Formatted time string
   * @example Utils.prettifyMS(125000) // "2:05"
   * @example Utils.prettifyMS(3661000) // "1:01:01"
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
   * Parse duration string (H:MM:SS or M:SS) to milliseconds
   * @param {string} str - Duration string
   * @returns {number} Milliseconds, 0 if invalid
   */
  static parseDuration(str) {
    if (!str || typeof str !== "string") return 0;

    const parts = str.split(":").map((s) => parseInt(s.trim(), 10)).reverse();
    if (parts.some(isNaN) || parts.some(n => n < 0)) return 0;

    let ms = 0;
    if (parts[0] !== undefined) ms += parts[0] * 1000;      // seconds
    if (parts[1] !== undefined) ms += parts[1] * 60 * 1000;  // minutes
    if (parts[2] !== undefined) ms += parts[2] * 3600 * 1000; // hours

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

  // ═════════════════════════════════════════════════════════════════════════════
  // Array Manipulation
  // ═════════════════════════════════════════════════════════════════════════════

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
   * Get random element from array
   * @template T
   * @param {T[]} array - Source array
   * @returns {T | undefined} Random element or undefined if empty
   */
  static randomElement(array) {
    if (!Array.isArray(array) || array.length === 0) return undefined;
    return array[Math.floor(Math.random() * array.length)];
  }

  /**
   * Chunk array into smaller arrays
   * @template T
   * @param {T[]} array - Array to chunk
   * @param {number} size - Chunk size (minimum 1)
   * @returns {T[][]} Array of chunks
   */
  static chunk(array, size) {
    if (!Array.isArray(array) || size < 1) return [];
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * Remove duplicates from array (primitive values only)
   * @template T
   * @param {T[]} array - Array with potential duplicates
   * @returns {T[]} New array without duplicates
   */
  static unique(array) {
    if (!Array.isArray(array)) return [];
    return [...new Set(array)];
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // String Formatting
  // ═════════════════════════════════════════════════════════════════════════════

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

    return title
        .replace(/\s*[\(\[][^\)\]]*(?:feat|ft|featuring|remix|edit|version|prod|official|audio|video|lyrics|visualizer)[^\)\]]*[\)\]]/gi, "")
        .replace(/\s*-\s*(?:feat|ft|featuring)\.?.*/gi, "")
        .replace(/\s*\|.*$/g, "") // Remove pipe and everything after
        .replace(/\s*【.*?】/g, "") // Remove Japanese brackets
        .replace(/\s*\[.*?\]/g, "") // Remove square brackets
        .replace(/\s*\(.*?\)/g, "") // Remove parentheses
        .replace(/\s{2,}/g, " ")    // Collapse multiple spaces
        .trim();
  }

  /**
   * Sanitize string for safe filename
   * @param {string} str - Input string
   * @param {number} [maxLen=50] - Maximum length
   * @returns {string} Safe filename
   */
  static sanitizeFilename(str, maxLen = 50) {
    if (!str || typeof str !== "string") return "unknown";
    return str
        .replace(/[^a-z0-9\u4e00-\u9fa5]/gi, "_") // Keep CJK chars too
        .replace(/_{2,}/g, "_")
        .substring(0, maxLen)
        .replace(/^_+|_+$/g, "");
  }

  /**
   * Escape markdown characters for Discord
   * @param {string} text - Raw text
   * @returns {string} Escaped text
   */
  static escapeMarkdown(text) {
    if (!text || typeof text !== "string") return "";
    return text
        .replace(/\\/g, "\\\\")
        .replace(/`/g, "\\`")
        .replace(/\*/g, "\\*")
        .replace(/_/g, "\\_")
        .replace(/~/g, "\\~")
        .replace(/\|/g, "\\|");
  }

  /**
   * Format number with commas (e.g., 1,000,000)
   * @param {number} num - Number to format
   * @returns {string} Formatted number
   */
  static formatNumber(num) {
    if (num === null || num === undefined || isNaN(num)) return "0";
    return num.toLocaleString();
  }

  /**
   * Format bytes to human readable (KB, MB, GB)
   * @param {number} bytes - Bytes to format
   * @param {number} [decimals=2] - Decimal places
   * @returns {string} Human readable size
   */
  static formatBytes(bytes, decimals = 2) {
    if (!bytes || bytes === 0) return "0 Bytes";
    if (bytes < 0) return "Unknown";

    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB"];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);

    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // ID Generation
  // ═════════════════════════════════════════════════════════════════════════════

  /**
   * Generate random unique ID
   * @param {number} [length=16] - Desired length of ID (8-32 recommended)
   * @returns {string} Random ID
   */
  static uid(length = 16) {
    const targetLen = Math.max(8, Math.min(length, 32));

    const timestamp = Date.now().toString(36).toUpperCase();
    let random = "";

    // Generate enough random data
    while ((timestamp + random).length < targetLen) {
      random += Math.random().toString(36).substring(2).toUpperCase();
    }

    return (timestamp + random).substring(0, targetLen);
  }

  /**
   * Generate UUID v4 (RFC4122 compliant)
   * @returns {string} UUID string
   */
  static uuid() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // Validation & Safety (CRITICAL for worker.mjs compatibility)
  // ═════════════════════════════════════════════════════════════════════════════

  /**
   * Check if a string represents a finite number
   * @param {string} str
   * @returns {boolean}
   */
  static isNumber(str) {
    if (str === null || str === undefined || str === "") return false;
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
    } catch {
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
   * Safe JSON parse with fallback
   * @template T
   * @param {string} str - JSON string
   * @param {T} [fallback=null] - Fallback value on error
   * @returns {T | null} Parsed object or fallback
   */
  static safeJsonParse(str, fallback = null) {
    if (!str || typeof str !== "string") return fallback;
    try {
      return JSON.parse(str);
    } catch {
      return fallback;
    }
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // Async Utilities
  // ═════════════════════════════════════════════════════════════════════════════

  /**
   * Sleep/delay promise
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise<void>}
   */
  static sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }

  /**
   * Retry an async operation with exponential backoff
   * @template T
   * @param {() => Promise<T>} fn - Function to retry
   * @param {number} [attempts=3] - Max retry attempts
   * @param {number} [delay=1000] - Initial delay in ms
   * @param {number} [backoff=2] - Backoff multiplier
   * @returns {Promise<T>}
   */
  static async retry(fn, attempts = 3, delay = 1000, backoff = 2) {
    if (typeof fn !== "function") {
      throw new TypeError("First argument must be a function");
    }

    let lastError;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (i < attempts - 1) {
          await this.sleep(delay * Math.pow(backoff, i));
        }
      }
    }
    throw lastError;
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
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeoutPromise]);
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // Object Utilities
  // ═════════════════════════════════════════════════════════════════════════════

  /**
   * Deep clone an object (JSON method - not suitable for circular refs)
   * @template T
   * @param {T} obj - Object to clone
   * @returns {T} Cloned object
   */
  static deepClone(obj) {
    if (obj === null || typeof obj !== "object") return obj;
    try {
      return JSON.parse(JSON.stringify(obj));
    } catch {
      return obj;
    }
  }

  /**
   * Pick specific keys from object
   * @template T, K
   * @param {T} obj - Source object
   * @param {K[]} keys - Keys to pick
   * @returns {Pick<T, K>} New object with picked keys
   */
  static pick(obj, keys) {
    if (!obj || typeof obj !== "object") return {};
    const result = {};
    for (const key of keys) {
      if (key in obj) result[key] = obj[key];
    }
    return result;
  }

  /**
   * Omit specific keys from object
   * @template T, K
   * @param {T} obj - Source object
   * @param {K[]} keys - Keys to omit
   * @returns {Omit<T, K>} New object without omitted keys
   */
  static omit(obj, keys) {
    if (!obj || typeof obj !== "object") return {};
    const result = { ...obj };
    for (const key of keys) {
      delete result[key];
    }
    return result;
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // Music-Specific Helpers
  // ═════════════════════════════════════════════════════════════════════════════

  /**
   * Create progress bar string
   * @param {number} current - Current position in ms or 0-1 ratio
   * @param {number} [total] - Total duration in ms (if omitted, current is treated as 0-1 ratio)
   * @param {number} [length=15] - Bar length in characters
   * @param {string} [filledChar="▬"] - Filled character
   * @param {string} [emptyChar="▬"] - Empty character
   * @param {string} [indicator="🔘"] - Position indicator
   * @returns {string} Progress bar string
   */
  static progressBar(
      current,
      total,
      length = 15,
      filledChar = "▬",
      emptyChar = "▬",
      indicator = "🔘"
  ) {
    let progress;
    if (total !== undefined && total > 0) {
      progress = this.clamp(current / total, 0, 1);
    } else {
      progress = this.clamp(current, 0, 1);
    }

    const position = Math.floor(progress * length);
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
}