/** @module src/music/attachments
 * @description Helpers for playing audio files attached directly to command
 * messages (Opus voice files, OGG, WebM, MP3, MP4/M4A/MOV video+audio, AAC,
 * FLAC, WAV).
 *
 * Attachment URLs are queued through {@link module:src/music/player/SearchMixin~playExternal}
 * as "external" tracks. The FluxerAudioBridge's direct-URL route sniffs magic
 * bytes on fetch: Ogg/Opus (incl. `.opus` voice recordings) is remuxed to
 * WebM/Opus in-process without re-encoding, WebM passes through untouched,
 * MP4/M4A/MOV ("ftyp" box header) is decoded locally by ffmpeg (audio track
 * only), and other formats are resolved through Lavalink.
 */

/** @type {RegExp} Audio file extensions recognized on attachment filenames. mp4/m4v/mov are accepted for their audio track (decoded locally by ffmpeg). */
const AUDIO_ATTACHMENT_EXTENSIONS = /\.(?:opus|ogg|oga|webm|mp3|mp4|m4v|m4a|m4b|mov|aac|flac|wav|wma)$/i;

/** @type {string[]} Content-type prefixes that always count as playable audio. */
const AUDIO_CONTENT_TYPE_PREFIXES = ["audio/", "application/ogg", "video/ogg", "video/mp4", "video/quicktime"];

/**
 * Decide whether an attachment is a playable audio file.
 * @param {object} att - Raw Fluxer MessageAttachment.
 * @returns {boolean} True when the attachment can be queued for playback.
 */
export function isAudioAttachment(att) {
  if (!att || att.expired) return false;
  if (!att.url && !att.proxyUrl) return false;

  const contentType = String(att.contentType ?? "").toLowerCase();
  if (AUDIO_CONTENT_TYPE_PREFIXES.some(prefix => contentType.startsWith(prefix))) return true;

  const name = String(att.filename ?? "");
  return AUDIO_ATTACHMENT_EXTENSIONS.test(name);
}

/**
 * Collect every playable audio attachment from a command message, in the
 * order they appear on the message.
 * @param {object} message - Command message wrapper (src/ui/Wrappers.Message).
 *   The raw Fluxer message with its attachments Collection is read from
 *   `message.message`, falling back to the wrapper itself.
 * @returns {object[]} Array of raw attachment objects.
 */
export function getAudioAttachments(message) {
  const raw = message?.message ?? message;
  const attachments = raw?.attachments;
  if (!attachments || typeof attachments.values !== "function") return [];
  return [...attachments.values()].filter(isAudioAttachment);
}

/**
 * Derive a display title from an attachment: the platform-provided title when
 * present, otherwise the filename without its extension.
 * @param {object} att - Raw Fluxer MessageAttachment.
 * @returns {string} Human-readable track title.
 */
export function attachmentTitle(att) {
  const name = String(att?.title ?? att?.filename ?? "attachment").trim();
  return name.replace(/\.[^.]+$/, "").trim() || "attachment";
}

/**
 * Build playback metadata for an attachment. Voice-note style attachments
 * carry their duration in seconds (Discord-compatible schema); it is exposed
 * in milliseconds via `_durationMs`, the field the player's duration
 * resolution (`_getTrackDurationMs`) reads first, so queue/now-playing
 * displays get a progress bar without an extra ffprobe round-trip.
 * @param {object} att - Raw Fluxer MessageAttachment.
 * @returns {{durationMs: number, artist: null, thumbnail: null}} Metadata for playExternal().
 */
export function attachmentTrackMeta(att) {
  let durationMs = 0;
  const dur = att?.duration;
  if (typeof dur === "number" && dur > 0) {
    durationMs = dur < 100_000 ? Math.round(dur * 1000) : Math.round(dur);
  }
  return { durationMs, artist: null, thumbnail: null };
}

/**
 * Pick the download URL for an attachment, preferring the canonical CDN URL.
 * @param {object} att - Raw Fluxer MessageAttachment.
 * @returns {string|null} Absolute URL or null when the attachment has none.
 */
export function attachmentUrl(att) {
  return att?.url ?? att?.proxyUrl ?? null;
}
