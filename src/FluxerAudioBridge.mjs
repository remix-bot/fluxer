/** @module src/FluxerAudioBridge @description Audio bridge for streaming Lavalink/NodeLink audio through Fluxer voice connections. 100% in-process — Opus encoding via prism-media (native/WASM), WebM muxing via WebMOpusMuxer. No FFmpeg processes. Supports MP3/AAC/radio streams via Lavalink resolve-through. */

import { logger } from "./constants/Logger.mjs";
import { WebMOpusMuxer, OPUS_FRAME_MS } from "./constants/audio/WebMOpusMuxer.mjs";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import http from "node:http";
import https from "node:https";
import prismMedia from "prism-media";

const { Encoder: PrismOpusEncoder, OggDemuxer: PrismOggDemuxer } = prismMedia.opus;

/** @type {number} @description Maximum number of HTTP redirect hops to follow. */
const MAX_REDIRECTS = 5;

/** @type {number} @description Timeout (ms) for HTTP requests to Lavalink REST endpoints (trackstream, loadtracks JSON). */
const REST_REQUEST_TIMEOUT_MS = 15_000;

/** @type {number} @description Timeout (ms) to wait for the first byte from loadstream (Lavalink may need time to resolve HLS/external streams). */
const LOADSTREAM_CONNECT_TIMEOUT_MS = 60_000;

/** @type {number} @description Idle timeout (ms) once loadstream data is flowing — if no data arrives for this long, abort. */
const LOADSTREAM_IDLE_TIMEOUT_MS = 30_000;

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

/** @type {number} @description livekit TrackKind.KIND_AUDIO — publications with this kind are managed by the bridge. */
const TRACK_KIND_AUDIO = 1;

/** @extends {EventEmitter} */
export class FluxerAudioBridge extends EventEmitter {
  _conn = null;
  _stream = null;
  _encoder = null;
  _sourceStream = null;
  _sourceReq = null;
  _playing = false;
  _stopped = false;
  _startedAt = 0;
  _currentUri = null;
  _lavalink = null;
  _playGeneration = 0;
  _durationTimer = null;
  _endResolve = null;
  _endReject = null;
  _usedTrackstream = false;

  /** @type {boolean} @description Whether audio is currently playing. */
  get playing() { return this._playing; }
  /** @type {number} @description Timestamp (ms) when playback started. */
  get startedAt() { return this._startedAt; }
  /** @type {string|null} @description URI of the currently playing track. */
  get currentUri() { return this._currentUri; }

  /** @param {LavalinkManager|null} lavalinkManager - LavalinkManager for trackstream/loadstream. */
  constructor(lavalinkManager = null) {
    super();
    this._lavalink = lavalinkManager;
  }

  /**
   * Play a track through a Fluxer voice connection, entirely in-process.
   * Routing order:
   *   1. trackstream passthrough (seek=0, no filters) — NodeLink hands back a WebM/Opus
   *      direct URL which the voice connection plays natively (zero re-encode).
   *   2. loadstream — NodeLink returns raw PCM (48k stereo s16le) with server-side
   *      seek/filters; PCM is Opus-encoded in-process and muxed to WebM.
   *   3. direct URL fallback — magic-byte sniff: WebM passthrough or Ogg/Opus remux.
   * @param {object} conn - Fluxer voice connection
   * @param {object} trackInfo - Track metadata (encoded, title, url, guildId)
   * @param {object} [options]
   * @param {number} [options.seekSeconds=0]
   * @param {number} [options.durationMs=0]
   * @param {object} [options.filterPayload]
   * @returns {Promise<"finished"|"stopped">}
   */
  async play(conn, trackInfo, options = {}) {
    this.stop();
    if (!conn) throw new Error("[AudioBridge] No voice connection provided");

    this._unpublishStaleAudioTracks(conn);

    const generation = ++this._playGeneration;
    this._conn = conn;
    this._playing = true;
    this._stopped = false;
    this._startedAt = Date.now();
    this._currentUri = trackInfo?.url ?? trackInfo?.title ?? "unknown";
    this._usedTrackstream = false;

    const seekMs = Math.floor((options.seekSeconds ?? 0) * 1000);
    let durationMs = options.durationMs || 0;

    try {
      if (seekMs === 0 && !options.filterPayload && trackInfo.encoded && this._lavalink) {
        try {
          const direct = await this._getTrackstreamUrl(trackInfo);
          if (direct?.url && /webm|opus/i.test(direct.format || "")) {
            this._usedTrackstream = true;
            logger.player("[AudioBridge] Passthrough webm/opus via trackstream (zero-copy): " + (trackInfo.title || "unknown"));

            await conn.play(direct.url);
            if (generation !== this._playGeneration) return "stopped";

            if (durationMs > 0) await this._waitDuration(durationMs);
            if (generation !== this._playGeneration) return "stopped";

            if (this._playing && !this._stopped) {
              this._playing = false;
              logger.player("[AudioBridge] Track finished naturally (trackstream passthrough)");
              return "finished";
            }
            return "stopped";
          }
          if (direct?.url && this._lavalink && trackInfo.url && trackInfo.url.startsWith("http")) {
            logger.player("[AudioBridge] trackstream format " + (direct.format || "?") + " — resolving original source URL via Lavalink for fresh encoded track...");
            const freshEncoded = await this._resolveUrlViaLavalink(trackInfo.url, trackInfo.guildId);
            if (freshEncoded) {
              trackInfo.encoded = freshEncoded;
              logger.player("[AudioBridge] Fresh encoded track obtained — retrying trackstream for webm/opus...");
              try {
                const freshDirect = await this._getTrackstreamUrl(trackInfo);
                if (freshDirect?.url && /webm|opus/i.test(freshDirect.format || "")) {
                  this._usedTrackstream = true;
                  logger.player("[AudioBridge] Fresh trackstream is webm/opus — zero-copy passthrough: " + (trackInfo.title || "unknown"));
                  await conn.play(freshDirect.url);
                  if (generation !== this._playGeneration) return "stopped";
                  if (durationMs > 0) await this._waitDuration(durationMs);
                  if (generation !== this._playGeneration) return "stopped";
                  if (this._playing && !this._stopped) {
                    this._playing = false;
                    logger.player("[AudioBridge] Track finished naturally (fresh trackstream passthrough)");
                    return "finished";
                  }
                  return "stopped";
                }
                logger.player("[AudioBridge] Fresh trackstream also " + (freshDirect?.format || "?") + ", falling through to loadstream");
              } catch (e2) {
                logger.player("[AudioBridge] Fresh trackstream failed, falling through to loadstream: " + e2.message);
              }
            } else {
              logger.player("[AudioBridge] Could not resolve source URL via Lavalink, using original encoded track for loadstream");
            }
          } else {
            logger.player("[AudioBridge] trackstream format not opus/webm (" + (direct?.format || "?") + "), falling through to loadstream");
          }
        } catch (e) {
          logger.warn("[AudioBridge] Trackstream failed, falling back to loadstream: " + e.message);
          this._playing = true;
          this._stopped = false;
          this._startedAt = Date.now();
        }
      }

      if (trackInfo.encoded && this._lavalink) {
        const loaded = await this._streamFromLoadstream(trackInfo, seekMs, options.filterPayload);
        if (generation !== this._playGeneration) {
          loaded.stream.destroy();
          return "stopped";
        }

        const routed = await this._routeByMagic(loaded.stream);
        this._sourceStream = loaded.stream;
        this._sourceReq = loaded.req || null;

        if (routed.kind === "webm") {
          logger.player("[AudioBridge] Playing loadstream webm/opus passthrough: " + (trackInfo.title || "unknown") +
              (seekMs > 0 ? " [seek: " + seekMs + "ms]" : ""));
          this._stream = routed.stream;
          await conn.play(routed.stream);
        } else if (routed.kind === "ogg") {
          logger.player("[AudioBridge] Playing loadstream ogg/opus (remux to webm): " + (trackInfo.title || "unknown"));
          const oggResult = await this._remuxOggToWebM(routed.stream);
          this._stream = oggResult;
          if (durationMs <= 0) durationMs = oggResult.getDurationMs();
          await conn.play(this._stream);
        } else {
          logger.player("[AudioBridge] Playing via loadstream PCM -> in-process Opus: " + (trackInfo.title || "unknown") +
              (seekMs > 0 ? " [seek: " + seekMs + "ms]" : "") +
              (options.filterPayload ? " [filters]" : ""));
          this._stream = this._buildPcmPipeline(routed.stream);
          await conn.play(this._stream);
        }
        if (generation !== this._playGeneration) return "stopped";

        await this._awaitEnd(durationMs);
        if (generation !== this._playGeneration) return "stopped";

        if (this._playing && !this._stopped) {
          this._playing = false;
          logger.player("[AudioBridge] Track finished naturally (loadstream)");
          return "finished";
        }
        return "stopped";
      }

      if (trackInfo.url && trackInfo.url.startsWith("http")) {
        logger.player("[AudioBridge] Route 3: Fetching directly: " + trackInfo.url.substring(0, 80) + "...");
        const response = await fetch(trackInfo.url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; Bot/1.0)" },
          redirect: "follow",
        });
        if (!response.ok) {
          throw new Error("HTTP " + response.status + " for " + trackInfo.url);
        }
        const stream = Readable.fromWeb(response.body);
        this._sourceStream = stream;

        const routed = await this._routeByMagic(stream);
        if (routed.kind === "webm") {
          logger.player("[AudioBridge] Route 3a: webm/opus passthrough: " + (trackInfo.title || "unknown"));
          this._stream = routed.stream;
          await conn.play(routed.stream);
        } else if (routed.kind === "ogg") {
          logger.player("[AudioBridge] Route 3b: ogg/opus remux to webm: " + (trackInfo.title || "unknown"));
          const oggResult = await this._remuxOggToWebM(routed.stream);
          this._stream = oggResult;
          await conn.play(this._stream);
          if (generation !== this._playGeneration) return "stopped";

          await new Promise(r => {
            if (this._stream.readableEnded) return r();
            const done = () => { this._stream.off("end", done); this._stream.off("close", done); r(); };
            this._stream.once("end", done);
            this._stream.once("close", done);
          });
          if (generation !== this._playGeneration) return "stopped";

          const fullDurationMs = oggResult.getDurationMs();
          const elapsedMs = Date.now() - this._startedAt;
          const remainingMs = Math.max(0, fullDurationMs - elapsedMs);
          logger.player("[AudioBridge] Route 3b: OGG " + fullDurationMs + "ms total, " + elapsedMs + "ms elapsed, waiting " + remainingMs + "ms more");

          if (remainingMs > 0) await this._awaitEnd(remainingMs);
          if (generation !== this._playGeneration) return "stopped";

          if (this._playing && !this._stopped) {
            this._playing = false;
            logger.player("[AudioBridge] Track finished naturally (direct URL, OGG remux)");
            return "finished";
          }
          return "stopped";
        } else {
          stream.destroy();
          this._sourceStream = null;
          logger.player("[AudioBridge] Route 3c: Direct stream is " + routed.kind + " (MP3/AAC?) — resolving through Lavalink...");

          if (this._lavalink) {
            const encoded = await this._resolveUrlViaLavalink(trackInfo.url, trackInfo.guildId);
            if (encoded) {
              trackInfo.encoded = encoded;
              logger.player("[AudioBridge] Route 3c: Got encoded track from Lavalink, retrying via loadstream...");
              const loaded = await this._streamFromLoadstream(trackInfo, 0, null);
              if (generation !== this._playGeneration) {
                loaded.stream.destroy();
                return "stopped";
              }

              const routed2 = await this._routeByMagic(loaded.stream);
              this._sourceStream = loaded.stream;
              this._sourceReq = loaded.req || null;

              if (routed2.kind === "webm") {
                logger.player("[AudioBridge] Route 3c (Lavalink): webm/opus passthrough");
                this._stream = routed2.stream;
                await conn.play(routed2.stream);
              } else if (routed2.kind === "ogg") {
                logger.player("[AudioBridge] Route 3c (Lavalink): ogg/opus remux to webm");
                const oggResult3c = await this._remuxOggToWebM(routed2.stream);
                this._stream = oggResult3c;
                if (durationMs <= 0) durationMs = oggResult3c.getDurationMs();
                await conn.play(this._stream);
              } else {
                logger.player("[AudioBridge] Route 3c (Lavalink): PCM -> Opus -> WebM");
                this._stream = this._buildPcmPipeline(routed2.stream);
                await conn.play(this._stream);
              }
              if (generation !== this._playGeneration) return "stopped";

              await this._awaitEnd(durationMs);
              if (generation !== this._playGeneration) return "stopped";

              if (this._playing && !this._stopped) {
                this._playing = false;
                logger.player("[AudioBridge] Track finished naturally (Route 3c Lavalink resolve)");
                return "finished";
              }
              return "stopped";
            }
          }

          throw new Error(
              "[AudioBridge] Direct URL is not WebM/Opus or Ogg/Opus (" + routed.kind + "). " +
              "Lavalink resolve also failed or is unavailable. " +
              "Make sure your Lavalink/NodeLink node is running and can decode this stream format."
          );
        }
        if (generation !== this._playGeneration) return "stopped";

        await this._awaitEnd(durationMs);
        if (generation !== this._playGeneration) return "stopped";

        if (this._playing && !this._stopped) {
          this._playing = false;
          logger.player("[AudioBridge] Track finished naturally (direct URL)");
          return "finished";
        }
        return "stopped";
      }

      throw new Error("Could not get audio stream for: " + (trackInfo.title || trackInfo.url || "unknown"));

    } catch (e) {
      if (generation !== this._playGeneration) return "stopped";
      if (this._stopped || !this._playing) return "stopped";
      this._playing = false;
      logger.error("[AudioBridge] Playback error: " + e.message);
      throw e;
    } finally {
      this._cleanup();
    }
  }

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
  }

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
  }

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
  }

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
  }

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
          "No Opus encoder available (" + e.message + "). Install one: npm install @discordjs/opus (or opusscript)"
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
  }

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
  }

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
  }

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
  }

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
  }

  /**
   * @param {string} url
   * @param {object} [headers]
   * @returns {Promise<object>}
   * @private
   */
  _httpGetJson(url, headers = {}, _redirectCount = 0, timeoutMs = REST_REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (_redirectCount >= MAX_REDIRECTS) {
        return reject(new Error("Too many redirects (" + _redirectCount + ")"));
      }
      const urlObj = new URL(url);
      const client = urlObj.protocol === "https:" ? https : http;

      const req = client.request({
        protocol: urlObj.protocol,
        host: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname + urlObj.search,
        method: "GET",
        headers: { "User-Agent": "Mozilla/5.0 (compatible; Bot/1.0)", ...headers },
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          let loc = res.headers.location;
          if (loc.startsWith("/")) loc = urlObj.protocol + "//" + urlObj.host + loc;
          return this._httpGetJson(loc, headers, _redirectCount + 1, timeoutMs).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          let body = "";
          res.on("data", (chunk) => { body += chunk; });
          res.on("end", () => {
            reject(new Error("HTTP " + res.statusCode + " for " + url + ": " + body.substring(0, 300)));
          });
          return;
        }

        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error("Invalid JSON from trackstream: " + data.substring(0, 200)));
          }
        });
      });

      req.on("socket", (socket) => {
        socket.on("error", () => {});
      });
      req.on("error", reject);
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        reject(new Error("REST request timeout (" + timeoutMs / 1000 + "s)"));
      });
      req.end();
    });
  }

  /**
   * @param {string} url
   * @param {object} [headers]
   * @param {number} [_redirectCount=0]
   * @returns {Promise<{stream: Readable, inputFormat: string|null, req: http.ClientRequest}>}
   * @private
   */
  _httpRequestStream(url, headers = {}, _redirectCount = 0) {
    return new Promise((resolve, reject) => {
      if (_redirectCount >= MAX_REDIRECTS) {
        return reject(new Error("Too many redirects (" + _redirectCount + ")"));
      }

      const urlObj = new URL(url);
      const client = urlObj.protocol === "https:" ? https : http;
      let firstByte = true;
      let connectTimer = null;
      let idleTimer = null;

      const resetIdleTimeout = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          req.destroy();
          reject(new Error("loadstream idle timeout (" + LOADSTREAM_IDLE_TIMEOUT_MS / 1000 + "s no data)"));
        }, LOADSTREAM_IDLE_TIMEOUT_MS);
        idleTimer.unref?.();
      };

      const req = client.request({
        protocol: urlObj.protocol,
        host: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname + urlObj.search,
        method: "GET",
        headers: { "User-Agent": "Mozilla/5.0 (compatible; Bot/1.0)", ...headers },
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
          res.resume();
          let nextHeaders = headers;
          let loc = res.headers.location;
          if (loc.startsWith("/")) loc = urlObj.protocol + "//" + urlObj.host + loc;
          try {
            const redirectHost = new URL(loc).hostname;
            if (redirectHost !== urlObj.hostname) {
              const { Authorization, "Session-Id": _, ...safe } = headers;
              nextHeaders = safe;
            }
          } catch (_) {}
          return this._httpRequestStream(loc, nextHeaders, _redirectCount + 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
          let body = "";
          res.on("data", (chunk) => { body += chunk; });
          res.on("end", () => {
            reject(new Error("HTTP " + res.statusCode + " for " + url + ": " + body.substring(0, 300)));
          });
          return;
        }

        if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
        resetIdleTimeout();
        res.once("data", () => resetIdleTimeout());

        logger.player("[AudioBridge] loadstream response: " + res.statusCode + " content-type=" + (res.headers["content-type"] || "?"));
        resolve({ stream: res, inputFormat: res.headers["content-type"] || null, req });
      });

      req.on("socket", (socket) => {
        socket.on("error", () => {});
      });

      req.on("error", (err) => {
        if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        reject(err);
      });

      connectTimer = setTimeout(() => {
        req.destroy();
        reject(new Error("loadstream connect timeout (" + LOADSTREAM_CONNECT_TIMEOUT_MS / 1000 + "s — Lavalink took too long to start stream)"));
      }, LOADSTREAM_CONNECT_TIMEOUT_MS);
      connectTimer.unref?.();

      req.end();
    });
  }

  /** Stop current playback and clean up resources. */
  stop() {
    const wasPlaying = this._playing;
    this._stopped = true;
    this._playing = false;
    this._playGeneration++;

    this._cleanup();

    if (this._conn) {
      try { this._conn.stop(); } catch (_) {}
      this._unpublishStaleAudioTracks(this._conn);
    }

    if (wasPlaying) {
      this.emit("stopped");
      logger.player("[AudioBridge] Playback stopped");
    }
  }

  /**
   * @param {object} conn - Fluxer voice connection
   * @param {string|null} [keepSid=null] - Track SID to keep (currently active publication)
   * @private
   */
  _unpublishStaleAudioTracks(conn, keepSid = null) {
    try {
      const room = conn?.room;
      const participant = room?.localParticipant;
      if (!room?.isConnected || typeof participant?.unpublishTrack !== "function") return;

      const publications = participant.trackPublications;
      if (!publications || typeof publications.entries !== "function") return;

      for (const [sid, pub] of publications.entries()) {
        if (keepSid && sid === keepSid) continue;
        if (pub?.kind !== TRACK_KIND_AUDIO) continue;
        try {
          const p = participant.unpublishTrack(sid, true);
          if (p?.catch) p.catch(() => {});
          logger.player("[AudioBridge] Unpublished stale audio track: " + sid);
        } catch (_) {}
      }
    } catch (_) {
    }
  }

  /**
   * Set the playback volume on the voice connection.
   * @param {number} percent - Volume 0–100.
   */
  setVolume(percent) {
    if (this._conn) {
      try { this._conn.setVolume(percent); } catch (e) {
        logger.warn("[AudioBridge] setVolume error: " + e.message);
      }
    }
  }

  /** @returns {number} Current volume percentage (0–100). */
  getVolume() {
    if (this._conn) {
      try { return this._conn.getVolume(); } catch (_) {}
    }
    return 100;
  }

  /** @returns {boolean} Whether the voice connection is currently active. */
  isConnected() {
    if (this._conn) {
      try { return this._conn.isConnected(); } catch (_) {}
    }
    return false;
  }

  /**
   * Clear timers, settle pending waits, and tear down the pipeline.
   * @private
   */
  _cleanup() {
    if (this._durationTimer) { clearTimeout(this._durationTimer); this._durationTimer = null; }
    if (this._endResolve) {
      const resolve = this._endResolve;
      this._endResolve = null;
      this._endReject = null;
      resolve();
    }
    for (const s of [this._stream, this._encoder, this._sourceStream]) {
      if (s) {
        try { s.destroy(); } catch (_) {}
      }
    }
    if (this._sourceReq) {
      try { this._sourceReq.destroy(); } catch (_) {}
    }
    this._stream = null;
    this._encoder = null;
    this._sourceStream = null;
    this._sourceReq = null;
  }

  /** Stop playback, release the voice connection, and remove all listeners. */
  destroy() {
    this.stop();
    this._conn = null;
    this._currentUri = null;
    this.removeAllListeners();
  }
}
