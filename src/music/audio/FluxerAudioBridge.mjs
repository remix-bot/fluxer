/** @module src/music/audio/FluxerAudioBridge @description Audio bridge for streaming Lavalink/NodeLink audio through Fluxer voice connections. 100% in-process — Opus encoding via prism-media (native/WASM), WebM muxing via WebMOpusMuxer. No FFmpeg processes. Supports MP3/AAC/radio streams via Lavalink resolve-through. Base class: lifecycle (play/stop/destroy), state getters, volume and cleanup. Stream pipeline building and Lavalink REST HTTP helpers live in the StreamPipeline/HttpStreams mixin modules applied at the bottom of this file. */

import { logger } from "../../core/Logger.mjs";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { applyMixins } from "../../utils/mixins.mjs";
import StreamPipeline from "./StreamPipeline.mjs";
import HttpStreams from "./HttpStreams.mjs";

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

// Attach the split-out concerns: stream pipeline building/routing
// (StreamPipeline) and Lavalink REST HTTP helpers (HttpStreams).
applyMixins(FluxerAudioBridge, StreamPipeline, HttpStreams);
