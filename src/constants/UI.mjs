/**
 * @file UI.mjs — UI constants — shared color values, emoji arrays, timeout durations, and volume limits used across commands and embeds
 * @module src.constants.UI
 */

/**
 * UI.mjs — Shared UI constants used across commands and embeds.
 *
 * Centralises emoji arrays, timeout values, and colour constants
 * that were previously duplicated across many command files.
 */

/** Error embed colour — used everywhere instead of hardcoding "#ff0000". */
export const ERROR_COLOR = "#ff0000";

/** Warning/highlight colour for diagnostic and debug embeds. */
export const WARN_COLOR = 0xFFAA00;

/** Success colour for diagnostic embeds. */
export const SUCCESS_COLOR = 0x00CC66;

/** Failure/danger colour for diagnostic embeds (same as ERROR_COLOR but numeric). */
export const DANGER_COLOR = 0xFF4444;

/** Default timeout (ms) before removing navigation reactions from embeds. */
export const EMOJI_REMOVE_TIMEOUT = 60_000;

/** Default inactivity timeout (ms) for interactive embed sessions. */
export const SESSION_TIMEOUT = 30_000;

/** Number emojis for search/radio selection menus. */
export const NUMBER_EMOJIS = [
  "1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣",
  "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟",
];

/** Cancel emoji for selection menus. */
export const CANCEL_EMOJI = "❌";

/** Navigation emojis for paginated embeds. */
export const PREV_EMOJI = "⬅️";
export const NEXT_EMOJI = "➡️";

/** Maximum allowed volume percentage. */
export const MAX_VOLUME = 200;
