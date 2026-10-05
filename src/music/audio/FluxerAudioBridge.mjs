/** @module src/music/audio/FluxerAudioBridge @description Audio bridge for streaming Lavalink/NodeLink audio through Fluxer voice connections. 100% in-process — Opus encoding via prism-media (native/WASM), WebM muxing via WebMOpusMuxer. No FFmpeg processes. Primary route: /v4/trackstream zero-re-encode passthrough with automatic fresh-URL retry on stale/forbidden direct URLs, and in-process WebM/Ogg byte positioning for ffmpeg-free seeks (StreamPositioner). The legacy /v4/loadstream route (server-side seek, filters, MP3/AAC decode — needs FFmpeg on the audio node) is opt-in via config.json -> audio.allowLoadstream. Base class: lifecycle (play/stop/destroy), state getters, volume and cleanup. Stream pipeline building and Lavalink REST HTTP helpers live in the StreamPipeline/HttpStreams mixin modules applied at the bottom of this file. */

import { logger } from "../../core/Logger.mjs";
import { EventEmitter } from "node:events";
import { applyMixins } from "../../utils/mixins.mjs";
import { isLoadstreamEnabled, isPrivateUrlsAllowed } from "./AudioSettings.mjs";
import { openPublicStream } from "./SafeHttp.mjs";
import StreamPipeline from "./StreamPipeline.mjs";
import HttpStreams from "./HttpStreams.mjs";

/** @type {number} @description livekit TrackKind.KIND_AUDIO — publications with this kind are managed by the bridge. */
const TRACK_KIND_AUDIO = 1;

/** @type {WeakMap<object, Map<string, Promise<void>>>} @description Audio SIDs currently being unpublished from LiveKit, keyed per local participant, mapped to a promise that resolves once that specific unpublish settles. LiveKit's unpublishTrack() is async — the publication stays listed in trackPublications until the RTC layer completes it, so repeated sweeps (stop() -> play() -> stop()) would otherwise re-unpublish the same SID, producing duplicate "Unpublished stale audio track" logs and LiveKit "RoomEvent.LocalTrackSubscribed: Publication not found" warnings. Beyond dedup, play() now also awaits these promises before publishing a new track (see _awaitPendingUnpublishes): without that wait, stop()'s fire-and-forget unpublish of the previous track could still be in flight when the next track's publish lands, briefly overlapping two audio publications on the same participant — heard as static/garbled audio until the stale one finished tearing down (fixed by a manual pause/resume, which forces a clean renegotiation). Entries remove themselves once their unpublish settles, so the map cannot grow unbounded across a 24/7 session. The WeakMap GCs itself when the participant is destroyed. */
const pendingUnpublishSids = new WeakMap();

/** @type {number} @description Max time to wait for a stale-track unpublish to settle before publishing anyway (defensive — an unpublish should resolve almost instantly; this only guards against a hung/never-resolving LiveKit promise blocking playback indefinitely). */
const UNPUBLISH_WAIT_TIMEOUT_MS = 1200;

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
  _durationResolve = null;
  _endResolve = null;
  _endReject = null;
  _usedTrackstream = false;

  /** @type {boolean} @description Whether audio is currently playing. */
  get playing() { return this._playing; }
  /** @type {number} @description Timestamp (ms) when playback started. */
  get startedAt() { return this._startedAt; }
  /** @type {string|null} @description URI of the currently playing track. */
  get currentUri() { return this._currentUri; }
  /** @type {boolean} @description Whether the current track was served via /v4/trackstream. */
  get usedTrackstream() { return this._usedTrackstream; }

  /** @param {LavalinkManager|null} lavalinkManager - LavalinkManager for trackstream/loadstream. */
  constructor(lavalinkManager = null) {
    super();
    this._lavalink = lavalinkManager;
  }

  /**
   * Play a track through a Fluxer voice connection, entirely in-process.
   * Routing order (audio.allowLoadstream defaults to false — trackstream-only):
   *   1. trackstream — NodeLink hands back a WebM/Opus direct URL which the
   *      voice connection plays natively (zero re-encode). Stale/forbidden
   *      URLs (HTTP 403 etc.) trigger one fresh-encoded retry via Lavalink.
   *      Seeks are served in-process by StreamPositioner (byte-level cluster/
   *      page skip); when the track length is unknown the URL is streamed
   *      through the bot so end-of-stream can be observed.
   *   2. loadstream (only when audio.allowLoadstream is true) — NodeLink
   *      returns raw audio with server-side seek/filters/decoding; WebM
   *      passes through, Ogg is remuxed, PCM is Opus-encoded in-process.
   *   3. direct URL fallback — only for tracks WITHOUT an encoded payload
   *      (Bilibili proxy, radio, direct links); magic-byte sniff: WebM
   *      passthrough or Ogg/Opus remux; other formats need the loadstream
   *      route or a Lavalink resolve + trackstream retry.
   * Every await is followed by a play-generation check so a stop()/new play()
   * can never leave a superseded play() publishing audio (double-audio race).
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

    await this._awaitPendingUnpublishes(conn);
    if (generation !== this._playGeneration) return "stopped";

    const seekMs = Math.floor((options.seekSeconds ?? 0) * 1000);
    let durationMs = options.durationMs || 0;
    const filterPayload = options.filterPayload ?? null;
    const loadstreamEnabled = isLoadstreamEnabled();

    if (filterPayload && !loadstreamEnabled) {
      logger.warn("[AudioBridge] Audio filter ignored — the loadstream route is disabled (config.json -> audio.allowLoadstream). Playing unfiltered.");
    }

    try {
      // ── Route A: /v4/trackstream — primary path, never touches /v4/loadstream.
      // In trackstream-only mode it also covers seeks (in-process positioning);
      // filters are ignored there because they are NodeLink server-side effects.
      const trackstreamGate = loadstreamEnabled
          ? (seekMs === 0 && !filterPayload) // loadstream owns seek/filter cases when enabled
          : true;
      if (trackstreamGate && trackInfo.encoded && this._lavalink) {
        const result = await this._playViaTrackstream(conn, trackInfo, { seekMs, durationMs, generation });
        if (result !== null) return result;
        // Trackstream could not serve this track (returned null for a LIVE play).
        if (generation !== this._playGeneration) return "stopped";
        durationMs = options.durationMs || 0; // reset in case trackstream consumed it
      }

      // ── Route B: /v4/loadstream — opt-in legacy route (server-side seek,
      // filters and MP3/AAC/PCM decoding). Unchanged behavior when enabled.
      if (loadstreamEnabled && trackInfo.encoded && this._lavalink) {
        const loaded = await this._streamFromLoadstream(trackInfo, seekMs, filterPayload);
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
              (filterPayload ? " [filters]" : ""));
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

      // ── Route C: direct URL — only for tracks WITHOUT an encoded payload
      // (Bilibili proxy, radio, direct links). Encoded tracks that reached
      // this point get the explicit error below instead of fetching their
      // source page.
      if (!trackInfo.encoded && trackInfo.url && trackInfo.url.startsWith("http")) {
        logger.player("[AudioBridge] Route 3: Fetching directly: " + trackInfo.url.substring(0, 80) + "...");
        const { stream, req: sourceReq } = await openPublicStream(trackInfo.url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; Bot/1.0)" },
          allowPrivate: trackInfo.trusted === true || isPrivateUrlsAllowed(),
        });
        this._sourceStream = stream;
        this._sourceReq = sourceReq;

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

          const encoded = this._lavalink
              ? await this._resolveUrlViaLavalink(trackInfo.url, trackInfo.guildId)
              : null;
          if (encoded) {
            trackInfo.encoded = encoded;
            logger.player("[AudioBridge] Route 3c: Got encoded track from Lavalink — retrying via trackstream...");
            const result3c = await this._playViaTrackstream(conn, trackInfo, { seekMs, durationMs, generation });
            if (result3c !== null) return result3c;
            if (generation !== this._playGeneration) return "stopped";
            // Trackstream could not serve the resolved track either — fall
            // through to loadstream when allowed, else the explicit error.
            if (loadstreamEnabled) {
              const loaded3c = await this._streamFromLoadstream(trackInfo, seekMs, null);
              if (generation !== this._playGeneration) {
                loaded3c.stream.destroy();
                return "stopped";
              }
              const routed3c = await this._routeByMagic(loaded3c.stream);
              this._sourceStream = loaded3c.stream;
              this._sourceReq = loaded3c.req || null;
              if (routed3c.kind === "webm") {
                logger.player("[AudioBridge] Route 3c (loadstream): webm/opus passthrough");
                this._stream = routed3c.stream;
                await conn.play(routed3c.stream);
              } else if (routed3c.kind === "ogg") {
                logger.player("[AudioBridge] Route 3c (loadstream): ogg/opus remux to webm");
                const oggResult3c = await this._remuxOggToWebM(routed3c.stream);
                this._stream = oggResult3c;
                if (durationMs <= 0) durationMs = oggResult3c.getDurationMs();
                await conn.play(this._stream);
              } else {
                logger.player("[AudioBridge] Route 3c (loadstream): PCM -> Opus -> WebM");
                this._stream = this._buildPcmPipeline(routed3c.stream);
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
              "[AudioBridge] Direct stream is " + routed.kind + " (MP3/AAC/PCM?) — this format needs server-side decoding. " +
              "Set audio.allowLoadstream to true in config.json (requires a NodeLink exposing /v4/loadstream), " +
              "or play a WebM/Opus source."
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

      if (trackInfo.encoded && this._lavalink && !loadstreamEnabled) {
        throw new Error(
            "[AudioBridge] NodeLink trackstream could not serve a playable WebM/Opus stream for this track, " +
            "and the loadstream route is disabled. Set audio.allowLoadstream to true in config.json " +
            "if your audio node can decode this format server-side (MP3/AAC sources need it)."
        );
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
   * Play an already-opened (optionally positioned) stream through the voice
   * connection and wait for its end. Shared bookkeeping for the trackstream
   * routes.
   * @param {object} conn - Fluxer voice connection
   * @param {{stream: Readable}} opened - Opened stream wrapper
   * @param {number} durationMs - Remaining duration (0 = until stream end)
   * @param {number} generation - Play generation guard
   * @returns {Promise<"finished"|"stopped"|null>} null when playback failed early
   * @private
   */
  async _playOpened(conn, opened, durationMs, generation) {
    try {
      if (generation !== this._playGeneration) {
        opened.stream.destroy();
        return "stopped";
      }
      this._stream = opened.stream;
      await conn.play(opened.stream);
    } catch (e) {
      if (generation !== this._playGeneration) return "stopped";
      if (this._stopped || !this._playing) return "stopped";
      logger.warn("[AudioBridge] Trackstream playback failed, falling back: " + e.message);
      return null;
    }

    if (generation !== this._playGeneration) return "stopped";

    await this._awaitEnd(durationMs);
    if (generation !== this._playGeneration) return "stopped";

    if (this._playing && !this._stopped) {
      this._playing = false;
      logger.player("[AudioBridge] Track finished naturally (trackstream)");
      return "finished";
    }
    return "stopped";
  }

  /**
   * Play a track through the /v4/trackstream route (no loadstream involved).
   * Resolves the direct URL and plays WebM/Opus with zero re-encode —
   * zero-copy URL passthrough for plain playback of known-length tracks,
   * in-process byte positioning (StreamPositioner) for seeks, and a streamed
   * route whenever the duration is unknown so end-of-stream can be observed.
   * A failed or stale direct URL (HTTP 403 from the media host, expired
   * googlevideo params, ...) triggers ONE fresh-encoded retry via Lavalink
   * before giving up. Non-WebM results get the same fresh-encoded retry,
   * then a magic-byte sniff of the direct URL itself (format strings can
   * lie). Returns null when trackstream cannot serve the track so the caller
   * can decide on a fallback.
   * @param {object} conn - Fluxer voice connection
   * @param {object} trackInfo - Track metadata (encoded, title, url, guildId)
   * @param {object} ctx - { seekMs, durationMs, generation }
   * @returns {Promise<"finished"|"stopped"|null>} null when trackstream is unusable
   * @private
   */
  async _playViaTrackstream(conn, trackInfo, ctx) {
    const { seekMs, generation } = ctx;
    const durationMs = ctx.durationMs;

    const stale = () => generation !== this._playGeneration;

    let direct;
    try {
      direct = await this._getTrackstreamUrl(trackInfo);
      if (!direct?.url) throw new Error("trackstream returned no URL");
    } catch (e) {
      if (stale()) return "stopped";
      // The encoded payload may be stale (expired googlevideo URL → HTTP 403)
      // — resolve a fresh one once and retry before giving up.
      logger.warn("[AudioBridge] Trackstream failed (" + e.message + ") — trying one fresh-encoded retry...");
      const freshEncoded = trackInfo.url && trackInfo.url.startsWith("http")
          ? await this._resolveUrlViaLavalink(trackInfo.url, trackInfo.guildId).catch(() => null)
          : null;
      if (stale()) return "stopped";
      if (!freshEncoded) return null;
      trackInfo.encoded = freshEncoded;
      try {
        direct = await this._getTrackstreamUrl(trackInfo);
        if (!direct?.url) throw new Error("trackstream returned no URL");
      } catch (e2) {
        if (stale()) return "stopped";
        logger.warn("[AudioBridge] Fresh-encoded trackstream retry failed: " + e2.message);
        return null;
      }
    }

    if (stale()) return "stopped";

    if (!/webm|opus/i.test(String(direct.format || ""))) {
      logger.player("[AudioBridge] trackstream format not opus/webm (" + (direct.format || "?") + "), refreshing encoded track once...");
      const freshEncoded = trackInfo.url && trackInfo.url.startsWith("http")
          ? await this._resolveUrlViaLavalink(trackInfo.url, trackInfo.guildId)
          : null;
      if (stale()) return "stopped";
      if (freshEncoded) {
        trackInfo.encoded = freshEncoded;
        try {
          const freshDirect = await this._getTrackstreamUrl(trackInfo);
          if (freshDirect?.url && /webm|opus/i.test(String(freshDirect.format || ""))) {
            direct = freshDirect;
            logger.player("[AudioBridge] Fresh trackstream is webm/opus: " + (trackInfo.title || "unknown"));
          }
        } catch (e2) {
          if (stale()) return "stopped";
          logger.player("[AudioBridge] Fresh trackstream failed: " + e2.message);
        }
      }

      if (!/webm|opus/i.test(String(direct.format || ""))) {
        // Last chance: sniff the direct URL's actual bytes — format strings
        // can lie (e.g. "mp4" that is really a WebM/Opus stream).
        try {
          const opened = await this._openPositionedStream(direct.url, seekMs);
          if (stale()) return "stopped";
          logger.player("[AudioBridge] trackstream direct URL is actually " + opened.kind + " — playing it");
          this._usedTrackstream = true;
          const result = await this._playOpened(conn, opened, durationMs, generation);
          return result;
        } catch (e3) {
          if (stale()) return "stopped";
          logger.player("[AudioBridge] trackstream direct URL not playable in-process (" + e3.message + ")");
          return null;
        }
      }
    }

    // WebM/Opus direct URL — play with zero re-encode.
    this._usedTrackstream = true;
    logger.player("[AudioBridge] Passthrough webm/opus via trackstream" +
        (seekMs > 0 ? " [positioned seek " + seekMs + "ms]" : " (zero-copy)") + ": " +
        (trackInfo.title || "unknown"));

    try {
      if (seekMs > 0 || durationMs <= 0) {
        // Streamed route: byte-positioned for seeks; also gives an
        // end-of-stream handle when the duration is unknown.
        const opened = await this._openPositionedStream(direct.url, seekMs);
        if (stale()) {
          opened.stream.destroy();
          return "stopped";
        }
        return await this._playOpened(conn, opened, durationMs, generation);
      }
      // Zero-copy: the voice connection fetches the URL itself.
      await conn.play(direct.url);
    } catch (e) {
      if (stale()) return "stopped";
      if (this._stopped || !this._playing) return "stopped";
      logger.warn("[AudioBridge] Trackstream playback failed, falling back: " + e.message);
      return null;
    }

    if (stale()) return "stopped";

    await this._waitDuration(durationMs);
    if (stale()) return "stopped";

    if (this._playing && !this._stopped) {
      this._playing = false;
      logger.player("[AudioBridge] Track finished naturally (trackstream)");
      return "finished";
    }
    return "stopped";
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

      // One guard map per participant, shared by every bridge instance in this
      // process: a SID currently being unpublished is skipped by later sweeps,
      // and its promise is awaitable via _awaitPendingUnpublishes().
      let pending = pendingUnpublishSids.get(participant);
      if (!pending) {
        pending = new Map();
        pendingUnpublishSids.set(participant, pending);
      }

      for (const [sid, pub] of publications.entries()) {
        if (keepSid && sid === keepSid) continue;
        if (pub?.kind !== TRACK_KIND_AUDIO) continue;
        if (pending.has(sid)) continue;
        try {
          const settle = Promise.resolve(participant.unpublishTrack(sid, true))
              .catch(() => {}) // failed unpublish is still a settled state — don't block on it
              .finally(() => { if (pending.get(sid) === settle) pending.delete(sid); });
          pending.set(sid, settle);
          logger.player("[AudioBridge] Unpublished stale audio track: " + sid);
        } catch (_) {
          pending.delete(sid);
        }
      }
    } catch (_) {
    }
  }

  /**
   * Wait for any in-flight unpublishes on `conn`'s participant to settle
   * (bounded by UNPUBLISH_WAIT_TIMEOUT_MS) before the caller publishes a new
   * track. Without this, a fire-and-forget unpublish from the previous
   * stop() can still be tearing down when the next track's publish lands,
   * briefly overlapping two audio publications — heard as static/garbled
   * audio at the start of the next track.
   * @param {object} conn - Fluxer voice connection
   * @returns {Promise<void>}
   * @private
   */
  async _awaitPendingUnpublishes(conn) {
    try {
      const participant = conn?.room?.localParticipant;
      if (!participant) return;
      const pending = pendingUnpublishSids.get(participant);
      if (!pending || pending.size === 0) return;

      const waits = [...pending.values()];
      let timedOut = false;
      const timeout = new Promise((resolve) => {
        setTimeout(() => { timedOut = true; resolve(); }, UNPUBLISH_WAIT_TIMEOUT_MS).unref?.();
      });
      await Promise.race([Promise.allSettled(waits), timeout]);
      if (timedOut) {
        logger.warn(
            `[AudioBridge] Timed out waiting for ${waits.length} stale unpublish(es) to settle after ${UNPUBLISH_WAIT_TIMEOUT_MS}ms — publishing new track anyway.`
        );
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
    if (this._durationResolve) {
      const resolve = this._durationResolve;
      this._durationResolve = null;
      resolve();
    }
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

applyMixins(FluxerAudioBridge, StreamPipeline, HttpStreams);
