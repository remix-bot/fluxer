/**
 * @module src/music/audio/VolumeNormalizer
 * @description Dynamic volume normalization and ReplayGain / EBU R128 loudness leveling.
 * Balances acoustic/quiet recordings against loud EDM/rock tracks across YouTube,
 * Spotify, SoundCloud, and Bilibili.
 */

import { Utils } from "../../utils/Utils.mjs";

/** Target loudness reference according to EBU R128 / international streaming standards (LUFS). */
export const TARGET_LUFS = -14.0;

/** Baseline perceived loudness offsets per audio source platform (relative gain multipliers). */
export const SOURCE_GAIN_OFFSETS = {
  youtube: 1.00,    // YouTube standard master target (-14 LUFS)
  ytmusic: 1.00,    // YouTube Music target (-14 LUFS)
  spotify: 1.00,    // Spotify standard target (-14 LUFS)
  soundcloud: 0.82, // SoundCloud tracks average -10 to -8 LUFS (uncompressed loud mastering) -> -2.5dB
  bilibili: 1.15,   // Bilibili audio averages -17 to -20 LUFS -> +1.5dB boost
  deezer: 0.95,     // Deezer averages -13 LUFS
  apple: 1.05,      // Apple Music Sound Check averages -16 LUFS
  bandcamp: 0.90,   // Bandcamp self-mastered tracks average -11 LUFS
};

/**
 * Detect the audio source key for a given track object.
 * @param {object} track - Track or video metadata object.
 * @returns {string} Source platform identifier.
 */
export function detectTrackSource(track) {
  if (!track) return "youtube";
  const sourceName = (track.sourceName || track.source || "").toLowerCase();
  if (sourceName) {
    if (sourceName.includes("soundcloud")) return "soundcloud";
    if (sourceName.includes("spotify"))    return "spotify";
    if (sourceName.includes("bilibili"))   return "bilibili";
    if (sourceName.includes("deezer"))     return "deezer";
    if (sourceName.includes("apple"))      return "apple";
    if (sourceName.includes("bandcamp"))   return "bandcamp";
    if (sourceName.includes("youtube"))    return "youtube";
  }

  const url = (track.url || track.uri || "").toLowerCase();
  if (url.includes("soundcloud.com")) return "soundcloud";
  if (url.includes("spotify.com"))    return "spotify";
  if (url.includes("bilibili.com"))   return "bilibili";
  if (url.includes("deezer.com"))     return "deezer";
  if (url.includes("music.apple.com"))return "apple";
  if (url.includes("bandcamp.com"))   return "bandcamp";

  return "youtube";
}

/**
 * Calculate the normalization gain multiplier for a given track.
 * Uses EBU R128 loudness tags if present, otherwise applies calibrated source offset.
 * Clamped between 0.50x (-6 dB) and 1.50x (+3.5 dB) to prevent clipping.
 *
 * @param {object|null} track - Track object.
 * @returns {number} Gain multiplier (e.g. 1.0 = unity gain, 0.82 = -2.5dB).
 */
export function calculateNormalizationGain(track) {
  if (!track) return 1.0;

  // Check for explicit ReplayGain or LUFS loudness tags in metadata
  const measuredLufs = track.pluginInfo?.loudness ??
      track.info?.loudness ??
      track.loudness ??
      track.info?.replaygain;

  if (typeof measuredLufs === "number" && !isNaN(measuredLufs)) {
    // EBU R128 formula: gain = 10 ^ ((Target - Measured) / 20)
    const deltaDb = TARGET_LUFS - measuredLufs;
    const gain = Math.pow(10, deltaDb / 20);
    return Utils.clamp(gain, 0.50, 1.50);
  }

  // Fallback to platform-calibrated baseline offset
  const source = detectTrackSource(track);
  const baseline = SOURCE_GAIN_OFFSETS[source] ?? 1.0;
  return Utils.clamp(baseline, 0.50, 1.50);
}

/**
 * Compute the effective output volume percentage (0-200) given a user's preferred volume,
 * current track, and normalization setting.
 *
 * @param {number} preferredVolume - Base volume fraction (e.g. 1.0 = 100%).
 * @param {object|null} track - Currently playing track.
 * @param {boolean} [normalizationEnabled=true] - Whether normalization is active.
 * @returns {number} Effective volume percentage (0-200).
 */
export function getEffectiveVolume(preferredVolume = 1.0, track = null, normalizationEnabled = true) {
  const base = Number.isFinite(preferredVolume) ? preferredVolume : 1.0;
  if (!normalizationEnabled) {
    return Utils.clamp(Math.round(base * 100), 0, 200);
  }
  const gain = calculateNormalizationGain(track);
  return Utils.clamp(Math.round(base * gain * 100), 0, 200);
}
