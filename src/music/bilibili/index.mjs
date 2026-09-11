/**
 * @module src/music/bilibili
 * @description Bilibili playback support barrel: URL detection, video/page
 * resolution via the public web API, best-audio-stream selection, and the
 * signed local proxy that lets the audio node fetch Bilibili CDN streams.
 *
 * Flow: `%play https://www.bilibili.com/video/BV…` → SearchMixin.play()
 * detects the link → resolveBilibiliVideo() builds queueable track(s) → at
 * playback time getBilibiliStreamUrl() re-resolves a fresh DASH audio URL
 * (they expire) and wraps it in a signed proxy URL → the existing
 * Lavalink/NodeLink resolve-through pipeline decodes it like any other
 * direct audio stream.
 */

import {
  bilibiliEnabled,
  buildSignedProxyUrl,
  configureBilibiliProxy,
  ensureBilibiliProxy,
} from "./BilibiliProxy.mjs";
import { fetchBilibiliPlayUrl, pickBestAudioStream, setBilibiliCookie } from "./BilibiliResolver.mjs";
import { logger } from "../../core/Logger.mjs";

/**
 * Configure Bilibili support from the config.json `bilibili` section.
 * Called once at bot startup; every field is optional.
 * @param {object} [section] - config.json -> bilibili
 * @param {boolean} [section.enabled=true] - false disables Bilibili playback.
 * @param {string} [section.bind="127.0.0.1"] - Proxy listen address.
 * @param {number} [section.port=0] - Proxy listen port (0 = ephemeral).
 * @param {string} [section.advertiseHost] - Host the audio node uses to
 *   reach the proxy when it runs on another machine/container.
 * @param {string} [section.cookie] - Browser cookie string (SESSDATA etc.);
 *   unlocks higher audio quality and works around IP blocks.
 */
export function configureBilibili(section = {}) {
  setBilibiliCookie(section.cookie ?? null);
  configureBilibiliProxy(section);
}

/**
 * Resolve a fresh, playable stream URL for a queued Bilibili track.
 * DASH audio URLs expire after a few hours, so this runs at every play
 * (and every seek/loop) rather than at queue time: the playurl API is
 * re-queried, the best audio stream picked, and the CDN URL wrapped in a
 * signed proxy URL the audio node can fetch with the right Referer/UA.
 * @param {object} track - Internal track with a `bilibili` metadata field.
 * @returns {Promise<{url: string, backupUrls: Array<string>}>}
 * @throws {Error} with a user-readable message when resolution fails.
 */
export async function getBilibiliStreamUrl(track) {
  const meta = track?.bilibili;
  if (!meta || (!meta.bvid && meta.aid == null) || meta.cid == null) {
    throw new Error("track is missing Bilibili stream metadata");
  }
  if (!bilibiliEnabled()) {
    throw new Error("Bilibili playback is disabled in config.json -> bilibili.enabled");
  }
  await ensureBilibiliProxy();

  const data = await fetchBilibiliPlayUrl(meta);
  const best = pickBestAudioStream(data);
  if (!best?.baseUrl) {
    throw new Error("Bilibili returned no playable audio stream for this video");
  }

  const url = await buildSignedProxyUrl(best.baseUrl);
  logger.player("[Bilibili] audio stream ready (bandwidth " + (best.bandwidth || "?") + "): " + url.substring(0, 60) + "...");
  return { url, backupUrls: Array.isArray(best.backupUrl) ? best.backupUrl : [] };
}

export { isBilibiliUrl, parseBilibiliVideoRef, resolveBilibiliVideo } from "./BilibiliResolver.mjs";
export { setBilibiliCookie, BILIBILI_UA, BILIBILI_REFERER } from "./BilibiliResolver.mjs";
export {
  bilibiliEnabled,
  bilibiliProxyInfo,
  ensureBilibiliProxy,
  resetBilibiliProxy,
  buildSignedProxyUrl,
} from "./BilibiliProxy.mjs";
