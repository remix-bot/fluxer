/** @module constants/UI */

/** Hex color string for error embeds. @type {string} */
export const ERROR_COLOR = "#ff0000";

/** Numeric hex color for warning embeds. @type {number} */
export const WARN_COLOR = 0xFFAA00;

/** Numeric hex color for success embeds. @type {number} */
export const SUCCESS_COLOR = 0x00CC66;

/** Numeric hex color for danger/critical embeds. @type {number} */
export const DANGER_COLOR = 0xFF4444;

/** Auto-remove reaction collectors after this many ms. @type {number} */
export const EMOJI_REMOVE_TIMEOUT = 60_000;

/** Session idle timeout in ms. @type {number} */
export const SESSION_TIMEOUT = 30_000;

/** Number emoji map for selection menus (indices 1-10). @type {string[]} */
export const NUMBER_EMOJIS = [
  "1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣",
  "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟",
];

/** Emoji used to cancel a selection. @type {string} */
export const CANCEL_EMOJI = "❌";

/** Emoji for previous-page navigation. @type {string} */
export const PREV_EMOJI = "⬅️";

/** Emoji for next-page navigation. @type {string} */
export const NEXT_EMOJI = "➡️";

/** Maximum allowed volume value. @type {number} */
export const MAX_VOLUME = 200;
