/** @module src/music/audio/AudioSettings @description Audio subsystem settings, merged from the config.json `audio` section at startup (see Bot.mjs). Keeps the streaming core free of direct config dependencies — the bridge, player mixins and tests read the effective settings via {@link getAudioSettings}. */

/** @type {object} @description Effective audio settings (merged from config.json -> audio). */
const _settings = {
  /** @type {boolean} @description Whether the legacy /v4/loadstream route may be used (server-side seek, filters, MP3/AAC decode). Disabled by default: playback runs on /v4/trackstream only. */
  allowLoadstream: false,
  /** @type {boolean} @description Whether direct audio URLs typed by users may point at private/loopback/link-local addresses (LAN radio, a home Icecast...). Off by default so %play cannot be used to probe internal services. Admin-configured radio stations and the local Bilibili proxy are always trusted. */
  allowPrivateUrls: false,
};

/**
 * Merge the config.json `audio` section into the effective settings.
 * @param {object|null} [section] - config.json -> audio
 * @param {boolean|string} [section.allowLoadstream] - Opt into the NodeLink
 *   /v4/loadstream route. Accepts true / "true"; anything else keeps it off.
 */
export function configureAudio(section = null) {
  const raw = section?.allowLoadstream;
  _settings.allowLoadstream = raw === true || raw === "true";
  const rawPrivate = section?.allowPrivateUrls;
  _settings.allowPrivateUrls = rawPrivate === true || rawPrivate === "true";
}

/**
 * @returns {object} A snapshot of the effective audio settings.
 */
export function getAudioSettings() {
  return { ..._settings };
}

/**
 * @returns {boolean} Whether the /v4/loadstream route is enabled. When false
 * the bot never calls /v4/loadstream: playback and seeking run entirely on
 * /v4/trackstream plus in-process WebM/Ogg handling.
 */
export function isLoadstreamEnabled() {
  return _settings.allowLoadstream === true;
}

/**
 * @returns {boolean} Whether user-supplied direct URLs may target private/internal addresses.
 */
export function isPrivateUrlsAllowed() {
  return _settings.allowPrivateUrls === true;
}

export default { configureAudio, getAudioSettings, isLoadstreamEnabled, isPrivateUrlsAllowed };
