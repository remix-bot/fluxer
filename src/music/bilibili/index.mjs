/**
 * @module src/music/bilibili
 * @description Bilibili playback support barrel: URL detection, video/page
 * resolution via the public web API (fully anonymous — no login cookies),
 * best-audio-stream selection, and the signed local proxy that lets the
 * audio node fetch Bilibili CDN streams.
 *
 * Flow: `%play https://www.bilibili.com/video/BV…` → SearchMixin.play()
 * detects the link → resolveBilibiliVideo() builds queueable track(s) → at
 * playback time getBilibiliStreamUrl() re-resolves a fresh stream (the URLs
 * expire) and wraps it in a signed proxy URL → the existing
 * Lavalink/NodeLink resolve-through pipeline decodes it like any other
 * direct audio stream. Anonymous DASH audio is preferred; videos without
 * DASH audio fall back to the html5 progressive mp4, with multi-segment
 * streams served through the concatenating proxy mode.
 */

import {
  bilibiliEnabled,
  buildSignedProxyUrl,
  buildSignedListProxyUrl,
  configureBilibiliProxy,
  ensureBilibiliProxy,
} from "./BilibiliProxy.mjs";
import { fetchBilibiliPlayUrl, pickBestAudioStream, pickProgressiveSegments } from "./BilibiliResolver.mjs";
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
 */
export function configureBilibili(section = {}) {
  configureBilibiliProxy(section);
}

/**
 * Resolve a fresh, playable stream URL for a queued Bilibili track.
 * DASH audio URLs expire after a few hours, so this runs at every play
 * (and every seek/loop) rather than at queue time. Selection order,
 * fully anonymous:
 * 1. DASH audio from the fnval=16 playurl (best quality, ~130-170 kbps);
 * 2. progressive durl segments from that same payload;
 * 3. html5-platform progressive mp4 (single or multi segment).
 * Single segments go through the plain `/s` proxy URL, multi-segment
 * streams through the concatenating `/l` proxy URL.
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

  // 1. Anonymous DASH audio.
  const data = await fetchBilibiliPlayUrl(meta);
  const best = pickBestAudioStream(data);
  if (best?.baseUrl) {
    const url = await buildSignedProxyUrl(best.baseUrl);
    logger.player("[Bilibili] audio stream ready (bandwidth " + (best.bandwidth || "?") + "): " + url.substring(0, 60) + "...");
    return { url, backupUrls: Array.isArray(best.backupUrl) ? best.backupUrl : [] };
  }

  // 2. Progressive segments from the DASH-mode payload.
  let progressive = pickProgressiveSegments(data);

  // 3. html5-platform progressive mp4 as the second chance.
  if (!progressive) {
    const html5 = await fetchBilibiliPlayUrl(meta, { mode: "html5" });
    progressive = pickProgressiveSegments(html5);
  }

  if (progressive) {
    if (progressive.segments.length === 1) {
      const seg = progressive.segments[0];
      const url = await buildSignedProxyUrl(seg.url);
      logger.player("[Bilibili] no DASH audio — using progressive mp4: " + url.substring(0, 60) + "...");
      return { url, backupUrls: seg.backupUrls };
    }
    const url = await buildSignedListProxyUrl(progressive.segments);
    logger.player("[Bilibili] no DASH audio — using " + progressive.segments.length + " progressive segments: " + url.substring(0, 60) + "...");
    return { url, backupUrls: [] };
  }

  throw new Error("Bilibili returned no playable audio stream for this video (it may be region-locked, premium-only, or deleted)");
}

export { isBilibiliUrl, parseBilibiliVideoRef, resolveBilibiliVideo } from "./BilibiliResolver.mjs";
export { resetBilibiliFingerprint, BILIBILI_UA, BILIBILI_REFERER } from "./BilibiliResolver.mjs";
export {
  bilibiliEnabled,
  bilibiliProxyInfo,
  ensureBilibiliProxy,
  resetBilibiliProxy,
  buildSignedProxyUrl,
  buildSignedListProxyUrl,
} from "./BilibiliProxy.mjs";
