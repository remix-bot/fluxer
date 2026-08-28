/** @module constants/Helpers247 */

/**
 * Simplified 24/7 helpers — single mode (on/off), no per-channel modes.
 * get247ChannelMode is used by Player.mjs, PlayerManager.mjs, GatewayHandler.mjs, leave.mjs.
 * remove247ChannelMode and set247ChannelMode are kept as no-ops for backward compat
 * (original files in the zip still import them).
 */

/**
 * Check if a channel has 24/7 enabled.
 * @param {object} set - ServerSettings instance
 * @param {string} channelId
 * @returns {"on"|"off"}
 */
export function get247ChannelMode(set, channelId) {
  if (!set?.get) return "off";
  const raw = set.get("stay_247");
  if (!raw || raw === "none") return "off";
  const channels = Array.isArray(raw)
    ? raw.map(id => String(id).trim()).filter(Boolean)
    : [String(raw).trim()];
  return channels.includes(channelId) ? "on" : "off";
}

/**
 * No-op: per-channel modes removed. Kept for backward compatibility.
 * Original GatewayHandler.mjs and index.mjs still import this.
 */
export function remove247ChannelMode(set, channelId, currentChannels) {
  // No-op: modes no longer exist, stay_247 array is managed directly.
}

/**
 * No-op: per-channel modes removed. Kept for backward compatibility.
 */
export function set247ChannelMode(set, channelId, mode) {
  // No-op: modes no longer exist.
}