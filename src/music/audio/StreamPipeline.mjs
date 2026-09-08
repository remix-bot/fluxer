/**
 * @module src/music/audio/StreamPipeline
 * @description Stream pipeline concern for {@link FluxerAudioBridge}:
 * end-of-playback waiting, magic-byte routing, the in-process PCM -> Opus ->
 * WebM pipeline, Ogg/Opus remuxing, trackstream/loadstream URL handling and
 * Lavalink URL resolution.
 *
 * These methods are applied onto the FluxerAudioBridge class prototype via
 * {@link module:src/utils/mixins.applyMixins} — `this` is a
 * FluxerAudioBridge instance.
 */

import { logger } from "../../core/Logger.mjs";
import { WebMOpusMuxer, OPUS_FRAME_MS } from "./WebMOpusMuxer.mjs";
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
  _awaitEnd(durationMs) {    return new Promise((resolve, reject) => {
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

    if (durationMs > 0) {
      this._durationTimer = setTimeout(resolve, durationMs);
    } else {
      const stream = this._stream;
      if (!stream) return resolve();
      const onEnd = () => resolve();
      stream.once("end", onEnd);
      stream.once("close", onEnd);
      stream.once("error", failFast);
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
   * Simple timed wait used by the trackstream passthrough route (no local
   * pipeline to watch). Resolves early if stopped.
   * @param {number} durationMs
   * @returns {Promise<void>}
   * @private
   */
  _waitDuration(durationMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._durationTimer = null;
        resolve();
      }, durationMs);
      this._durationTimer = timer;
    });
  },

  /**
   * Peek at the first bytes of a stream and classify it, pushing the peeked
   * bytes back so nothing is lost.
   * @param {Readable} stream
   * @returns {Promise<{stream: Readable, kind: "webm"|"ogg"|"pcm"}>}
   * @private
   */
  async _routeByMagic(stream) {
    const head = await this._peek(stream, 4);
    if (head.length >= 4 && head.subarray(0, 4).equals(WEBM_MAGIC)) return { stream, kind: "webm" };
    if (head.length >= 4 && head.subarray(0, 4).equals(OGG_MAGIC)) return { stream, kind: "ogg" };
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
   * Build the in-process PCM -> Opus -> WebM pipeline.
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

    pcmStream.on("error", (err) => {
      logger.warn("[AudioBridge] PCM source error: " + err.message);
      encoder.destroy(err);
    });
    encoder.on("error", (err) => {
      muxer.destroy(err);
    });

    pcmStream.pipe(encoder).pipe(muxer);
    return muxer;
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
    const wrapper = Object.create(muxer);
    wrapper.getDurationMs = () => frameCount * OPUS_FRAME_MS;
    return wrapper;
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
