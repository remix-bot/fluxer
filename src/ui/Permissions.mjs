/**
 * @module src/ui/Permissions
 * @description Bot permission requirements for full functionality, split into
 * critical (bot cannot operate without) and optional (UX improvements).
 */

/**
 * Required bot permissions with human-readable names and descriptions.
 * @type {Map<string, {name: string, desc: string}>}
 */
export const REQUIRED_BOT_PERMISSIONS = Object.freeze(new Map([
  ["ViewChannel",        { name: "View Channels",        desc: "See channels and read their content" }],
  ["SendMessages",       { name: "Send Messages",        desc: "Respond to commands and send messages" }],
  ["EmbedLinks",         { name: "Embed Links",          desc: "Send rich embed messages (bot responses, now playing, etc.)" }],
  ["AddReactions",       { name: "Add Reactions",        desc: "Add pagination reactions (help pages, queue, etc.)" }],
  ["ReadMessageHistory", { name: "Read Message History", desc: "Read previous messages for context" }],
  ["ManageMessages",     { name: "Manage Messages",      desc: "Pin messages, clean up bot responses" }],
  ["AttachFiles",        { name: "Attach Files",         desc: "Send files and thumbnails" }],
  ["Connect",            { name: "Connect (Join Voice)", desc: "Join voice channels to play music" }],
  ["Speak",              { name: "Speak",                desc: "Stream audio in voice channels" }],
]));

/** @type {string[]} Permission keys that are strictly required for the bot to function. */
export const CRITICAL_PERMISSIONS = ["ViewChannel", "SendMessages", "EmbedLinks", "Connect", "Speak"];

/** @type {string[]} Permission keys that are optional but improve the user experience. */
export const OPTIONAL_PERMISSIONS = ["AddReactions", "ReadMessageHistory", "ManageMessages", "AttachFiles"];
