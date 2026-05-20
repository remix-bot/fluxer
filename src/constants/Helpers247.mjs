/**
 * Shared 24/7 mode helpers.
 *
 * The per-channel mode map (`stay_247_modes`) stores each channel's 24/7 mode
 * independently so a guild can have channel A on "on" and channel B on "auto".
 *
 * Format in settings:
 *   stay_247_modes: { "1483577390731942416": "on", "1478011355626209606": "auto" }
 *
 * For backward compatibility, `stay_247_mode` (guild-wide string) is still
 * written when any channel is updated.  All reads go through
 * `get247ChannelMode()` which prefers the per-channel entry and falls back
 * to the guild-wide value.
 */

/**
 * Get the 24/7 mode for a specific channel.
 *
 * @param {{ get: (key: string) => any }} set  ServerSettings instance
 * @param {string} channelId  Clean (digits-only) channel ID
 * @returns {"on"|"auto"|"off"}
 */
export function get247ChannelMode(set, channelId) {
  if (!set?.get) return "off";
  const modes = set.get("stay_247_modes");
  if (modes && typeof modes === "object" && !Array.isArray(modes)) {
    const perChannel = modes[channelId];
    if (perChannel === "on" || perChannel === "auto" || perChannel === "off") return perChannel;
  }
  const guildMode = set.get("stay_247_mode") ?? "off";
  return guildMode;
}

/**
 * Set the 24/7 mode for a specific channel.
 *
 * @param {{ get: (key: string) => any, set: (key: string, value: any) => void }} set
 * @param {string} channelId  Clean (digits-only) channel ID
 * @param {"on"|"auto"|"off"} mode
 */
export function set247ChannelMode(set, channelId, mode) {
  let modes = set.get("stay_247_modes");
  if (!modes || typeof modes !== "object" || Array.isArray(modes)) modes = {};
  modes[channelId] = mode;
  set.set("stay_247_modes", modes);
  set.set("stay_247_mode", mode);
}

/**
 * Remove a channel from the per-channel modes map.
 *
 * @param {{ get: (key: string) => any, set: (key: string, value: any) => void }} set
 * @param {string} channelId  Clean channel ID
 * @param {Set<string>} currentChannels  Current set of all 247 channels for this guild
 */
export function remove247ChannelMode(set, channelId, currentChannels) {
  let modes = set.get("stay_247_modes");
  if (!modes || typeof modes !== "object" || Array.isArray(modes)) return;
  delete modes[channelId];
  set.set("stay_247_modes", modes);
  if (currentChannels.size === 0) {
    set.set("stay_247_mode", "off");
  } else {
    const firstChannel = [...currentChannels][0];
    set.set("stay_247_mode", modes[firstChannel] ?? "auto");
  }
}
