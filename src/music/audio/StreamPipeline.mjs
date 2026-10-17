/**
 * @module src/music/audio/StreamPipeline
 * @description Stream pipeline concern for {@link FluxerAudioBridge}:
 * end-of-playback waiting, magic-byte routing, the in-process PCM -> Opus ->
 * WebM pipeline, Ogg/Opus remuxing, positioned trackstream URL streaming,
 * trackstream/loadstream URL handling and Lavalink URL resolution.
 *
 * These methods are applied onto the FluxerAudioBridge class prototype via
 * {@link module:src/utils/mixins.applyMixins} — `this` is a
 * FluxerAudioBridge instance.
 */

import { logger } from "../../core/Logger.mjs";
import { Readable } from "node:stream";
import { spawn as spawnProcess } from "node:child_process";
import { createRequire } from "node:module";
import { WebMOpusMuxer, OPUS_FRAME_MS } from "./WebMOpusMuxer.mjs";
import { StreamPositioner } from "./StreamPositioner.mjs";
import prismMedia from "prism-media";

const { Encoder: PrismOpusEncoder, OggDemuxer: PrismOggDemuxer } = prismMedia.opus;

/** @type {number} @description PCM sample rate expected from NodeLink loadstream (48kHz stereo s16le). */
const PCM_RATE = 48000;
/** @type {number} @description PCM channel count expected from NodeLink loadstream. */
const PCM_CHANNELS = 2;
/** @type {number} @description Opus frame size in samples per channel (20ms @ 48kHz). */
const PCM_FRAME_SIZE = 960;
/** @type {number} @description Opus encoding bitrate. */
const OPUS_BITRATE = 128000;

/** @type {Buffer} @description WebM/Matroska EBML magic bytes. */
const WEBM_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
/** @type {Buffer} @description OGG container magic bytes ("OggS"). */
const OGG_MAGIC = Buffer.from("OggS", "ascii");
/** @type {Buffer} @description ISOBMFF box header (MP4/M4A/MOV/3GP family) — sits at byte offset 4, after the 4-byte big-endian box size. */
const FTYP_MAGIC = Buffer.from("ftyp", "ascii");

/** @type {string} @description User-Agent sent for direct media fetches (kept identical across the bridge and ffmpeg's own HTTP client). */
const HTTP_UA = "Mozilla/5.0 (compatible; Bot/1.0)";

/** @type {string|null} @description Resolved ffmpeg binary (null = not installed). Checked once per process. */
let _ffmpegCmd = null;
/** @type {boolean} @description Whether the ffmpeg binary lookup already ran. */
let _ffmpegChecked = false;

/**
 * Locate a usable ffmpeg binary: ffmpeg-static (when installed) first, then
 * the system PATH. Result is memoized for the process lifetime.
 * @returns {Promise<string|null>}
 * @private
 */
async function _resolveFfmpegCmd() {
  if (_ffmpegChecked) return _ffmpegCmd;
  _ffmpegChecked = true;
  const candidates = [];
  try {
    candidates.push(createRequire(import.meta.url)("ffmpeg-static"));
  } catch (_) {}
  candidates.push("ffmpeg");
  for (const cmd of candidates) {
    if (!cmd) continue;
    const ok = await new Promise((resolve) => {
      let probe;
      try {
        probe = spawnProcess(cmd, ["-version"], { stdio: "ignore" });
      } catch (_) {
        return resolve(false);
      }
      probe.on("error", () => resolve(false));
      probe.on("close", (code) => resolve(code === 0));
    });
    if (ok) {
      _ffmpegCmd = cmd;
      return cmd;
    }
  }
  return null;
}

/**
 * @type {object}
 * @description Stream pipeline mixin — applied to FluxerAudioBridge.
 */
const StreamPipeline = {
  /**
   * Wait for playback end: duration timer for fixed-length tracks, pipeline
   * end event for live/radio streams (durationMs = 0). Rejects early on
   * pipeline errors so the player can skip to the next track.
   * @param {number} durationMs
   * @returns {Promise<void>}
   * @private
   */
  _awaitEnd(durationMs) {
    return new Promise((resolve, reject) => {
      this._endResolve = resolve;
      this._endReject = reject;
      const failFast = (err) => {
        if (this._playing && !this._stopped) {
          this._playing = false;
          reject(err);
        } else {
          resolve();
        }
      };

      const stream = this._stream;
      if (stream) {
        if (durationMs <= 0 && (stream.readableEnded || stream.destroyed)) {
          this._endResolve = null;
          this._endReject = null;
          return resolve();
        }
        // Finite tracks: never short-circuit on stream state — conn.play can
        // drain the whole stream into its playback buffer far faster than
        // realtime, so only the duration timer reflects actual playback end.
        const onEnd = () => {
          if (durationMs > 0 && this._playing && !this._stopped) return;
          resolve();
        };
        stream.once("end", onEnd);
        stream.once("close", onEnd);
        stream.once("error", failFast);
      }

      if (durationMs > 0) {
        this._durationTimer = setTimeout(resolve, durationMs);
      } else if (!stream) {
        return resolve();
      }

      if (this._sourceStream) {
        this._sourceStream.once("error", failFast);
      }
      if (this._encoder) {
        this._encoder.once("error", failFast);
      }
    });
  },

  /**
   * Wait until the bridge's source stream is fully consumed (end/close) so
   * downstream frame counts (durations) are final. Stop-safe: cleanup()
   * destroys the source, which fires "close". Resolves on source errors.
   * @returns {Promise<void>}
   * @private
   */
  _awaitSourceEnd() {
    return new Promise((resolve) => {
      const src = this._sourceStream;
      if (!src || src.readableEnded || src.destroyed) return resolve();
      const done = () => {
        src.off("end", done);
        src.off("close", done);
        src.off("error", done);
        resolve();
      };
      src.once("end", done);
      src.once("close", done);
      src.once("error", done);
    });
  },

  /**
   * Simple timed wait used by the trackstream passthrough route (no local
   * pipeline to watch). Resolves early when stop()/cleanup clears the timer —
   * the resolve handle lives on the bridge (`_durationResolve`) so a stop can
   * never leave this promise pending forever.
   * @param {number} durationMs
   * @returns {Promise<void>}
   * @private
   */
  _waitDuration(durationMs) {
    return new Promise((resolve) => {
      this._durationResolve = resolve;
      const timer = setTimeout(() => {
        this._durationTimer = null;
        this._durationResolve = null;
        resolve();
      }, durationMs);
      this._durationTimer = timer;
    });
  },

  /**
   * Open a direct media URL (typically the NodeLink trackstream result) as a
   * bot-side stream and — for seeks — drop leading WebM clusters / Ogg pages
   * so playback starts near the target position without re-encoding
   * (StreamPositioner). Also used with seekMs = 0 whenever the caller wants a
   * real stream handle (unknown-duration tracks) instead of zero-copy URL
   * passthrough. Registers the HTTP stream on the bridge for stop/cleanup.
   * @param {string} url - Direct media URL to fetch.
   * @param {number} [seekMs=0] - Target position in milliseconds (0 = start).
   * @returns {Promise<{stream: Transform, kind: "webm"|"ogg"}>}
   * @throws {Error} When the URL does not serve WebM or Ogg (nothing the
   *   in-process pipeline can position or play without decoding).
   * @private
   */
  async _openPositionedStream(url, seekMs = 0) {
    const loaded = await this._httpRequestStream(url);
    this._sourceStream = loaded.stream;
    this._sourceReq = loaded.req || null;

    const routed = await this._routeByMagic(loaded.stream);
    if (routed.kind !== "webm" && routed.kind !== "ogg") {
      loaded.stream.destroy();
      this._sourceStream = null;
      this._sourceReq = null;
      throw new Error(
          "Trackstream URL is not WebM/Ogg (" + (loaded.inputFormat || routed.kind) + ") — " +
          "in-process positioning supports WebM/Opus and Ogg/Opus only"
      );
    }

    const positioner = new StreamPositioner({ kind: routed.kind, seekMs });
    const out = routed.stream.pipe(positioner);
    logger.player("[AudioBridge] Positioned stream open (kind=" + routed.kind + ", seek=" + seekMs + "ms)");
    return { stream: out, kind: routed.kind };
  },

  /**
   * Peek at the first bytes of a stream and classify it, pushing the peeked
   * bytes back so nothing is lost. MP4/M4A/MOV (ISOBMFF) is detected via the
   * "ftyp" box header at offset 4 — those files must be decoded by ffmpeg
   * fetching the URL itself (their moov atom often trails mdat, which a
   * non-seekable pipe cannot reach back into).
   * @param {Readable} stream
   * @returns {Promise<{stream: Readable, kind: "webm"|"ogg"|"mp4"|"pcm"}>}
   * @private
   */
  async _routeByMagic(stream) {
    const head = await this._peek(stream, 8);
    if (head.length >= 4 && head.subarray(0, 4).equals(WEBM_MAGIC)) return { stream, kind: "webm" };
    if (head.length >= 4 && head.subarray(0, 4).equals(OGG_MAGIC)) return { stream, kind: "ogg" };
    if (head.length >= 8 && head.subarray(4, 8).equals(FTYP_MAGIC)) return { stream, kind: "mp4" };
    return { stream, kind: "pcm" };
  },

  /**
   * Read up to `n` bytes from a paused-mode stream, then unshift them.
   * @param {Readable} stream
   * @param {number} n
   * @returns {Promise<Buffer>}
   * @private
   */
  _peek(stream, n) {
    return new Promise((resolve, reject) => {
      const tryRead = () => {
        const chunks = [];
        let total = 0;
        let chunk;
        while (total < n && (chunk = stream.read()) !== null) {
          chunks.push(chunk);
          total += chunk.length;
        }
        if (total >= n || stream.readableEnded) {
          const buf = Buffer.concat(chunks);
          cleanup();
          if (buf.length > 0) stream.unshift(buf);
          resolve(buf.subarray(0, n));
          return;
        }
      };
      const onReadable = () => { cleanup(); tryRead(); };
      const onEnd = () => { cleanup(); tryRead(); };
      const onError = (err) => { cleanup(); reject(err); };
      const cleanup = () => {
        stream.off("readable", onReadable);
        stream.off("end", onEnd);
        stream.off("error", onError);
      };
      stream.once("readable", onReadable);
      stream.once("end", onEnd);
      stream.once("error", onError);
      tryRead();
    });
  },

  /**
   * Wall-clock ms still left to play: durationMs (already remaining-after-seek
   * when the player knows the track length) or, when unknown, the pipeline's
   * measured frame/byte count — minus playback time elapsed since start.
   * @param {number} durationMs
   * @param {number} [measuredMs=0]
   * @returns {number}
   * @private
   */
  _remainingPlayMs(durationMs, measuredMs = 0) {
    const total = durationMs > 0 ? durationMs : measuredMs;
    return Math.max(0, total - (Date.now() - this._startedAt));
  },

  /**
   * Build the in-process PCM -> Opus -> WebM pipeline. The returned wrapper
   * exposes getDurationMs() derived from counted PCM bytes (final once the
   * PCM source ends) so unknown-duration tracks can still be timed.
   * @param {Readable} pcmStream - s16le 48kHz stereo byte stream
   * @returns {WebMOpusMuxer} - byte stream consumable by conn.play()
   * @private
   */
  _buildPcmPipeline(pcmStream) {
    let encoder;
    try {
      encoder = new PrismOpusEncoder({
        rate: PCM_RATE,
        channels: PCM_CHANNELS,
        frameSize: PCM_FRAME_SIZE,
      });
    } catch (e) {
      pcmStream.destroy();
      throw new Error(
          "No Opus encoder available (" + e.message + "). Install one: npm install opusscript"
      );
    }
    try { encoder.setBitrate(OPUS_BITRATE); } catch (_) {}

    const muxer = new WebMOpusMuxer({ sampleRate: PCM_RATE, channels: PCM_CHANNELS });
    this._encoder = encoder;

    let pcmBytes = 0;
    pcmStream.on("data", (chunk) => { pcmBytes += chunk.length; });

    pcmStream.pipe(encoder).pipe(muxer);
    muxer.getDurationMs = () => Math.round((pcmBytes / (PCM_RATE * PCM_CHANNELS * 2)) * 1000);
    return muxer;
  },

  /**
   * Spawn a local ffmpeg process decoding an audio URL to s16le 48kHz stereo
   * PCM on stdout (fed through _buildPcmPipeline). Last-resort route for
   * formats the in-process pipeline cannot handle (FLAC, MP4/M4A/MOV, MP3/AAC
   * files the NodeLink worker refuses, ...).
   *
   * Input modes:
   *  - piped (default): the bot fetches the URL itself and pipes the body into
   *    ffmpeg's stdin, so request headers match the other direct-URL routes.
   *    Works for streamable containers (FLAC, OGG, MP3, WAV, faststart MP4).
   *  - directInput: ffmpeg fetches the URL itself via its HTTP protocol (range
   *    requests, proper seeking). Required for MP4/MOV files whose moov atom
   *    trails mdat — a non-seekable pipe can never reach back to demux it.
   * @param {string} url - Audio URL (signed attachment URL, radio, ...)
   * @param {number} [seekSeconds=0]
   * @param {object} [options]
   * @param {boolean} [options.directInput=false] - Let ffmpeg fetch the URL itself.
   * @returns {Promise<{stream: WebMOpusMuxer, source: Readable|null, proc: ChildProcess, getDurationMs: function, hasAudio: function, stderrText: function}|null>} null when no usable ffmpeg binary is installed
   * @private
   */
  async _spawnFfmpegPcm(url, seekSeconds = 0, { directInput = false } = {}) {
    const cmd = await _resolveFfmpegCmd();
    if (!cmd) return null;

    const args = ["-hide_banner", "-loglevel", "error"];
    if (seekSeconds > 0) args.push("-ss", String(Math.floor(seekSeconds)));
    if (directInput) {
      args.push("-user_agent", HTTP_UA, "-i", url);
    } else {
      args.push("-i", "pipe:0");
    }
    args.push("-vn", "-f", "s16le", "-ar", String(PCM_RATE), "-ac", String(PCM_CHANNELS), "pipe:1");

    let proc;
    try {
      proc = spawnProcess(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (_) {
      return null;
    }

    let source = null;
    if (!directInput) {
      try {
        const response = await fetch(url, {
          headers: { "User-Agent": HTTP_UA },
          redirect: "follow",
        });
        if (!response.ok) throw new Error("HTTP " + response.status + " for " + url);
        source = Readable.fromWeb(response.body);
      } catch (e) {
        try { proc.kill("SIGKILL"); } catch (_) {}
        throw e;
      }
    }

    const stderrChunks = [];
    proc.stderr.on("data", (chunk) => { if (stderrChunks.length < 16) stderrChunks.push(chunk); });
    let gotPcm = false;
    proc.stdout.once("data", () => { gotPcm = true; });
    let closeResolve;
    const exited = new Promise((resolve) => { closeResolve = resolve; });
    proc.stdin.on("error", () => {}); // EPIPE when ffmpeg exits early — not fatal
    if (source) {
      source.on("error", (err) => {
        try { proc.stdin.destroy(); } catch (_) {}
        try { proc.kill("SIGKILL"); } catch (_) {}
        logger.warn("[AudioBridge] ffmpeg source error: " + err.message);
      });
    }
    proc.on("close", (code, signal) => {
      if (!gotPcm) logger.warn("[AudioBridge] ffmpeg exited early (code=" + code + " signal=" + signal + ")");
      closeResolve();
      if (source) { try { source.destroy(); } catch (_) {} }
    });

    if (source) source.pipe(proc.stdin);
    const pipeline = this._buildPcmPipeline(proc.stdout);
    return {
      stream: pipeline,
      source,
      proc,
      exited,
      getDurationMs: () => pipeline.getDurationMs(),
      hasAudio: () => gotPcm,
      stderrText: () => {
        const text = Buffer.concat(stderrChunks).toString("utf8").trim();
        return text.length > 400 ? text.substring(text.length - 400) : text;
      },
    };
  },

  /**
   * Remux an Ogg/Opus stream into WebM/Opus (packet-level, no re-encode).
   * @param {Readable} oggStream
   * @returns {Promise<{stream: WebMOpusMuxer, getDurationMs: function}>}
   * @private
   */
  async _remuxOggToWebM(oggStream) {
    const demuxer = new PrismOggDemuxer();
    const muxer = new WebMOpusMuxer();
    oggStream.on("error", (err) => demuxer.destroy(err));
    demuxer.on("error", (err) => muxer.destroy(err));
    let frameCount = 0;
    demuxer.on("data", () => { frameCount++; });
    const headPromise = new Promise((resolve, reject) => {
      demuxer.once("head", () => resolve());
      demuxer.once("error", (err) => reject(new Error("OGG demux: " + err.message)));
      oggStream.once("error", (err) => reject(new Error("OGG source: " + err.message)));
    });
    oggStream.pipe(demuxer).pipe(muxer);
    await headPromise;
    muxer.getDurationMs = () => frameCount * OPUS_FRAME_MS;
    return muxer;
  },

  /**
   * @param {object} trackInfo
   * @returns {Promise<{url: string, format: string}>}
   * @private
   */
  async _getTrackstreamUrl(trackInfo) {
    const nlInfo = this._lavalink.getNodeLinkInfo?.();
    if (!nlInfo) throw new Error("NodeLink info not available");

    const protocol = nlInfo.secure ? "https" : "http";
    const baseUrl = protocol + "://" + nlInfo.host + ":" + nlInfo.port;

    const headers = { "Authorization": nlInfo.password };
    if (nlInfo.sessionId) headers["Session-Id"] = nlInfo.sessionId;
    if (trackInfo.guildId) headers["Guild-Id"] = trackInfo.guildId;

    const params = "encodedTrack=" + encodeURIComponent(trackInfo.encoded);
    const url = baseUrl + "/v4/trackstream?" + params;

    logger.player("[AudioBridge] Querying /v4/trackstream...");

    const body = await this._httpGetJson(url, headers);

    const directUrl = body?.url;
    if (!directUrl || typeof directUrl !== "string") {
      throw new Error("trackstream returned no URL");
    }

    const format = body?.format || "";
    logger.player("[AudioBridge] trackstream: format=" + format + " url=" + directUrl.substring(0, 100) + "...");

    return { url: directUrl, format };
  },

  /**
   * @param {object} trackInfo
   * @param {number} [seekMs=0]
   * @param {object|null} [filterPayload]
   * @returns {Promise<{stream: Readable, inputFormat: string|null}>}
   * @private
   */
  async _streamFromLoadstream(trackInfo, seekMs = 0, filterPayload = null) {
    const nlInfo = this._lavalink.getNodeLinkInfo?.();
    if (!nlInfo) {
      throw new Error("NodeLink info not available");
    }

    const protocol = nlInfo.secure ? "https" : "http";
    const baseUrl = protocol + "://" + nlInfo.host + ":" + nlInfo.port;

    const headers = { "Authorization": nlInfo.password };
    if (nlInfo.sessionId) headers["Session-Id"] = nlInfo.sessionId;
    if (trackInfo.guildId) headers["Guild-Id"] = trackInfo.guildId;

    let baseParams = "encodedTrack=" + encodeURIComponent(trackInfo.encoded) + "&position=" + seekMs + "&volume=100";
    if (filterPayload) {
      baseParams += "&filters=" + encodeURIComponent(JSON.stringify(filterPayload));
    }

    const url = baseUrl + "/v4/loadstream?" + baseParams;
    logger.player("[AudioBridge] Querying /v4/loadstream (seek: " + seekMs + "ms)...");

    return this._httpRequestStream(url, headers);
  },

  /**
   * Resolve a direct audio URL through Lavalink's /v4/loadtracks to get an encoded track.
   * This allows MP3/AAC radio streams and direct audio URLs to be played through
   * the loadstream pipeline without any FFmpeg dependency.
   * @param {string} url - The HTTP(S) audio stream URL to resolve.
   * @param {string} [guildId] - Optional guild ID for the request.
   * @returns {Promise<string|null>} The encoded track string, or null if resolution failed.
   * @private
   */
  async _resolveUrlViaLavalink(url, guildId) {
    try {
      const nlInfo = this._lavalink.getNodeLinkInfo?.();
      if (!nlInfo) {
        logger.warn("[AudioBridge] _resolveUrlViaLavalink: no NodeLink info");
        return null;
      }

      const protocol = nlInfo.secure ? "https" : "http";
      const baseUrl = protocol + "://" + nlInfo.host + ":" + nlInfo.port;

      const headers = { "Authorization": nlInfo.password };
      if (nlInfo.sessionId) headers["Session-Id"] = nlInfo.sessionId;
      if (guildId) headers["Guild-Id"] = guildId;

      const params = "identifier=" + encodeURIComponent(url);
      const loadtracksUrl = baseUrl + "/v4/loadtracks?" + params;

      logger.player("[AudioBridge] Resolving URL via Lavalink /v4/loadtracks: " + url.substring(0, 80) + "...");

      const body = await this._httpGetJson(loadtracksUrl, headers, 0, 30_000);

      const track = body?.data?.tracks?.[0] ?? body?.tracks?.[0] ?? body?.data;
      const encoded = track?.encoded ?? track?.data;

      if (encoded && typeof encoded === "string") {
        logger.player("[AudioBridge] Lavalink resolved URL to encoded track successfully");
        return encoded;
      }

      const loadType = body?.loadType ?? body?.data?.loadType;
      logger.warn("[AudioBridge] Lavalink loadtracks returned no playable track (loadType=" + loadType + ")");
      return null;
    } catch (e) {
      logger.warn("[AudioBridge] _resolveUrlViaLavalink failed: " + e.message);
      return null;
    }
  },
};

export default StreamPipeline;
export { StreamPipeline };
