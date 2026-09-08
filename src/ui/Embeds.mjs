/**
 * @module src/ui/Embeds
 * @description Global embed color management plus message-shape helpers used
 * across the UI layer.
 */

/**
 * Parse a color value (hex string, 0x-prefixed string, or number) into an integer.
 * @param {string|number} value
 * @param {number} [fallback=0xe9196c]
 * @returns {number}
 */
export function parseColor(value, fallback = 0xe9196c) {
  if (!value) return fallback;
  if (typeof value === "number") return value;
  const cleaned = String(value).replace(/^#/, "").replace(/^0x/i, "");
  const n = parseInt(cleaned, 16);
  return isNaN(n) ? fallback : n;
}

/** @private @type {number} */
let _globalColor = 0xe9196c;

/**
 * Set the global embed color (accepts hex strings or numbers).
 * @param {string|number} value
 */
export function setGlobalColor(value) { _globalColor = parseColor(value); }

/**
 * @returns {number} The current global embed color.
 */
export function getGlobalColor()      { return _globalColor; }

/**
 * Extract the guild ID from various message wrapper shapes.
 * @param {object} message
 * @returns {string|null}
 */
export function getMessageGuildId(message) {
  return message?.channel?.guildId ??
    message?.channel?.guild?.id ??
    message?.message?.guildId ??
    message?.message?.guild?.id ??
    message?.channel?.server_id ??
    message?.channel?.serverId ??
    message?.message?.server_id ??
    message?.message?.serverId ??
    null;
}
