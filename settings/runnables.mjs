/**
 * @module settings/runnables
 * @description Validation runnables for settings values.
 * Each function is called with (value, context) and returns an error string or null.
 */

/**
 * Validate a prefix setting value.
 * @param {*} value - The value to validate.
 * @param {object} ctx - Command context (unused but provided by the settings system).
 * @returns {string|null} Error message if invalid, or null if valid.
 */
export default {
  prefix(value) {
    if (!value || typeof value !== 'string') return 'Prefix must be a non-empty string.';
    if (value.length > 5) return 'Prefix must be 5 characters or fewer.';
    if (/\s/.test(value)) return 'Prefix must not contain whitespace.';
    return null;
  },

  /**
   * Validate a pfp (profile picture) setting value.
   * Only 'default' is accepted on Fluxer.
   * @param {*} value - The value to validate.
   * @returns {string|null} Error message if invalid, or null if valid.
   */
  pfp(value) {
    if (value !== 'default') {
      return 'Profile picture customisation is not supported on Fluxer.';
    }
    return null;
  },

  /**
   * Validate stay_247 setting. Always valid — the 24/7 system manages
   * this value internally via the toggle command.
   * @param {*} value - The value (ignored).
   * @returns {string|null} Always null (no error).
   */
  stay_247(value) {
    return null;
  },
};
