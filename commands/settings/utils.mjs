/**
 * @module commands/settings/utils
 * @description Constants and pure helpers
 * shared by the settings command modules. Bodies are verbatim from the
 * original single-file command; `export ` prefixes and setValidLocales()
 * are the only additions.
 */


import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor, cleanId } from "../../src/ui/index.mjs";

/**
 * Command alias to setting key mapping.
 * @type {Object.<string, string>}
 */
export const SHORTCUTS = {
  prefix: "prefix",
  pfx:    "prefix",
  "247":  "stay_247",
};

/** @private @type {Set<string>} Strings that evaluate to boolean true. */
const BOOL_TRUE  = new Set(["true",  "1", "yes", "on",  "enable", "enabled"]);
/** @private @type {Set<string>} Strings that evaluate to boolean false. */
const BOOL_FALSE = new Set(["false", "0", "no",  "off", "disable", "disabled"]);
/** @private @type {Set<string>} Setting keys that use boolean display formatting. */
export const BOOL_SETTINGS = new Set(["songAnnouncements"]);

/** @private @type {Set<string>} Available locale codes, populated at load time. */
export let VALID_LOCALES = new Set(["en"]);

/** @private @type {number} Minimum allowed volume value. */
export const VOLUME_MIN = 1;
/** @private @type {number} Maximum allowed volume value. */
export const VOLUME_MAX = 200;
/** @private @type {number} Maximum prefix length in characters. */
export const PREFIX_MAX = 5;
/** @private @type {number} Maximum number of 24/7 channels per guild. */
export const MAX_247_CHANNELS = 1;

/**
 * Replace the set of known locale codes (called by the settings command
 * factory at load time). Importers read VALID_LOCALES as a live binding,
 * so this stays behavior-identical to the original module-level assignment.
 * @param {Iterable<string>} locales
 */
export function setValidLocales(locales) {
  VALID_LOCALES = locales;
}


/**
 * Check whether a string looks like a valid Fluxer ID (Snowflake-like).
 * @param {string} id - The ID to validate.
 * @returns {boolean} True if the ID is 15-22 characters after cleaning.
 */
export function isValidFluxerId(id) {
  const cleaned = cleanId(id);
  return cleaned.length >= 15 && cleaned.length <= 22;
}
/**
 * Parse a string into a boolean, or return null if unrecognised.
 * @param {string} str - The string to parse.
 * @returns {boolean|null} True, false, or null if not a boolean string.
 */
export function parseBool(str) {
  const s = String(str).toLowerCase().trim();
  if (BOOL_TRUE.has(s))  return true;
  if (BOOL_FALSE.has(s)) return false;
  return null;
}
/**
 * Format a setting value for display in embed messages.
 * @param {string} key - The setting key.
 * @param {*} value - The setting value.
 * @returns {string} Formatted display string.
 */
export function displayValue(key, value) {
  if (BOOL_SETTINGS.has(key)) return value ? "\u2705 enabled" : "\u274c disabled";
  if (value === null || value === undefined || value === "none") return "none";
  return "`" + value + "`";
}
/**
 * @private
 * Get the display name of the guild from a message object.
 * @param {object} message - The command message wrapper.
 * @returns {string} The guild name, or a fallback string.
 */
export function getGuildName(message) {
  return message.message?.guild?.name ?? message.channel?.guild?.name ?? "this server";
}
/**
 * @private
 * Create a simple embed payload with global color, description, and optional title/footer.
 * @param {string} desc - The embed description text.
 * @param {object} [opts={}] - Optional overrides for title, iconURL, and footer.
 * @returns {object} Embed payload for message.reply().
 */
export function embed(desc, opts = {}) {
  const b = new EmbedBuilder().setColor(getGlobalColor()).setDescription(desc);
  if (opts.title) b.setTitle(opts.title);
  if (opts.iconURL) b.setAuthor({ name: opts.title || "\u200b", iconURL: opts.iconURL });
  if (opts.footer) b.setFooter({ text: opts.footer });
  return { embeds: [b] };
}

/**
 * @private
 * Create a translation function bound to the given context and guild.
 * @param {object} ctx - The bot (Remix) context.
 * @param {string} guildId - The guild ID for localization.
 * @returns {Function} A translation function with signature (key, data?) => string.
 */
export function tWrap(ctx, guildId) {
  const tFn = ctx.locale?.translate?.bind(ctx.locale);
  return (key, data = {}) => tFn ? tFn(guildId, key, data) : key;
}
/**
 * @private
 * Get a human-readable label for a setting key, using locale translations when available.
 * @param {string} key - The setting key.
 * @param {Function|null} t - Translation function (guildId, key, data) => string.
 * @param {string} guildId - The guild ID for localization.
 * @returns {string} The pretty-printed setting label.
 */
export function prettifySettingLabel(key, t, guildId) {
  const localeMap = {
    songAnnouncements: "responses.settings.labelSongAnnouncements",
    prefix: "responses.settings.labelPrefix",
    pfx: "responses.settings.labelPfp",
    locale: "responses.settings.labelLocale",
    stay_247: "responses.settings.label247",
    volume: "responses.settings.labelVolume",
  };
  if (localeMap[key] && t && guildId) return t(guildId, localeMap[key]);
  const fallback = {
    songAnnouncements: "Song announcements",
    prefix: "Prefix",
    pfp: "Bot avatar style",
    locale: "Locale",
    stay_247: "24/7 mode",
    volume: "Default volume",
  };
  return fallback[key] ?? key.replace(/_/g, " ");
}
