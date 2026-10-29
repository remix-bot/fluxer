/**
 * @module src/utils/AttachmentUtils
 * @description Utilities for detecting, inspecting, and extracting media from
 * Fluxer attachments, uploaded message files, and direct fluxerusercontent.com URLs.
 */

/**
 * Common media file extensions supported for direct streaming or decoding.
 * Includes native zero-re-encode formats (WebM, Opus, OGG) and container formats (MP4, MP3, AAC, FLAC, WAV).
 */
export const MEDIA_EXTENSIONS = /\.(?:mp4|webm|mkv|mov|opus|ogg|mp3|m4a|aac|flac|wav|wma)(?:\?|$)/i;

/**
 * Formats handled natively by FluxerAudioBridge without re-encoding (WebM/Opus, OGG/Opus).
 */
export const NATIVE_MEDIA_EXTENSIONS = /\.(?:opus|webm|ogg)(?:\?|$)/i;

/**
 * Check if a URL originates from the official Fluxer user-content CDN.
 * @param {string} str
 * @returns {boolean}
 */
export function isFluxerAttachmentUrl(str) {
  if (!str || typeof str !== "string") return false;
  return /fluxerusercontent\.com\/attachments\//i.test(str) ||
         /cdn\.fluxer\.app\/attachments\//i.test(str);
}

/**
 * Check if a string is a direct playable media link (Fluxer attachment or audio/video extension).
 * Excludes standard service hosts (YouTube, Spotify, etc.) which use search/catalog resolvers.
 * @param {string} str
 * @returns {boolean}
 */
export function isPlayableMediaUrl(str) {
  if (!str || typeof str !== "string") return false;
  const trimmed = str.trim();
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) return false;
  if (isFluxerAttachmentUrl(trimmed)) return true;
  return MEDIA_EXTENSIONS.test(trimmed);
}

/**
 * Extract all attachments from a message or message wrapper.
 * Safely handles arrays, Collections, Maps, and object dictionaries.
 * @param {object} msg
 * @returns {Array<object>}
 */
export function getMessageAttachments(msg) {
  const raw = msg?.attachments ?? msg?.message?.attachments;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw.values === "function") return [...raw.values()];
  if (typeof raw === "object") return Object.values(raw);
  return [];
}

/**
 * Find the first playable media attachment in a message.
 * @param {object} msg
 * @returns {{ url: string, filename: string, size: number, contentType: string }|null}
 */
export function getPlayableAttachment(msg) {
  const list = getMessageAttachments(msg);
  for (const att of list) {
    if (!att || typeof att !== "object") continue;
    const url = att.url || att.proxy_url || att.proxyUrl;
    const filename = att.filename || att.name || "";
    const contentType = att.content_type || att.contentType || "";
    const isMedia = MEDIA_EXTENSIONS.test(filename) ||
                    MEDIA_EXTENSIONS.test(url) ||
                    contentType.startsWith("audio/") ||
                    contentType.startsWith("video/") ||
                    contentType === "application/ogg" ||
                    isFluxerAttachmentUrl(url);

    if (url && isMedia) {
      return {
        url,
        filename: filename || "Attachment",
        size: Number(att.size ?? 0),
        contentType,
      };
    }
  }
  return null;
}

/**
 * Extract a clean, human-readable display title from a media URL or filename.
 * Removes URL query parameters, directory paths, and file extensions.
 * @param {string} urlOrFilename
 * @param {string} [fallback="Attachment"]
 * @returns {string}
 */
export function extractMediaTitle(urlOrFilename, fallback = "Attachment") {
  if (!urlOrFilename || typeof urlOrFilename !== "string") return fallback;
  try {
    let clean = urlOrFilename;
    if (clean.startsWith("http://") || clean.startsWith("https://")) {
      clean = new URL(clean).pathname;
    }
    const filename = clean.split("/").pop();
    if (filename && filename.includes(".")) {
      const decoded = decodeURIComponent(filename.replace(/\.[^.]+$/, "").trim());
      if (decoded) return decoded;
    }
  } catch (_) { }
  return fallback;
}
