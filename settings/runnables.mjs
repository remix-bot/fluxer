/**
 * @file runnables.mjs — Runnable validators — server-side validation functions for settings values (prefix, volume, 24/7 mode, etc.)
 * @module settings.runnables
 */

export default {
  /**
   * Validate a prefix setting value.
   * @param {string} value - The proposed prefix
   * @param {object} _data - Additional context (reserved for future use)
   * @returns {true|string} True if valid, error message string if invalid
   */
  prefix(value, _data) {
    if (!value || typeof value !== "string") return "Prefix must be a non-empty string.";
    if (value.length > 10) return "Prefix must be 10 characters or fewer.";
    if (/\s/.test(value)) return "Prefix must not contain whitespace.";
    return true;
  },

  /**
   * Validate a profile picture setting value.
   * @param {string} value - The proposed pfp value
   * @param {object} _data - Additional context (reserved for future use)
   * @returns {true|string} True if valid, error message string if invalid
   */
  pfp(value, _data) {
    if (value !== "default") {
      return "Profile picture customisation is not supported on Fluxer.";
    }
    return true;
  },

  /**
   * Validate the 24/7 stay mode setting.
   * @param {string|boolean} value - The proposed stay_247 value
   * @param {object} _data - Additional context (reserved for future use)
   * @returns {true|string} True if valid, error message string if invalid
   */
  stay_247(value, _data) {
    if (value === true || value === false || value === "true" || value === "false") return true;
    if (typeof value === "string" && value.length > 0) return true;
    return "Invalid value for 24/7 mode.";
  },
};
