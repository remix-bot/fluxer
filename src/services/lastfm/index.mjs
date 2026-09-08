/**
 * @module src/services/lastfm
 * @description Public surface of the Last.fm service.
 *
 * Import map from the old layout:
 * - `src/LastFmManager.mjs` → LastFmManager.mjs (class) + urlUtils.mjs (URL helpers)
 */

export { LastFmManager } from "./LastFmManager.mjs";
export { parseLastFmUrl, isLastFmUrl } from "./urlUtils.mjs";
