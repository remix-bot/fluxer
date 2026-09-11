/**
 * @module src/music/player/PlaybackMixin
 * @description Playback advancement concern for {@link Player}: track-end
 * handling, playNext generation guarding, bridge playback with Lavalink
 * pre-resolution, track-option timers, and lyrics.
 *
 * These methods are applied onto the Player class prototype via
 * {@link applyMixins} — `this` is a Player instance.
 */

import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../../ui/index.mjs";
import { Utils, cleanId } from "../../utils/Utils.mjs";
import { logger } from "../../core/Logger.mjs";
import meta from "../probe.mjs";
import { getBilibiliStreamUrl } from "../bilibili/index.mjs";

/**
 * @type {object}
 * @description Playback mixin — applied to Player.
 */
const PlaybackMixin = {
  /**
   * Handle the end of a track. Advances to the next song or starts the
   * inactivity timer (if not 24/7). For radio tracks, stops playback.
   * @this {import('./Player.mjs').Player}
   * @private
   */
  _handleTrackEnd() {
    const songData = this.queue.getCurrent();
    if (!songData) return;

    this._clearTrackEndTimer();

    if (songData.type === "radio") {
      logger.player(`[Player] Radio track ended: ${songData.title}`);
      this._lastPlayedTrack = this.queue.getCurrent() ?? songData;
      this.queue.current = null;
      this.emit("stopplay");
      if (!this._is247Enabled()) {
        this._startInactivityTimer();
      }
      return;
    }

    if (!this._paused) {
      this._lastPlayedTrack = this.queue.getCurrent() ?? songData;
      if (!this.queue.songLoop) this.queue.current = null;
      this._playingNext = false;
      this.playNext().catch(e => logger.error("[Player] auto-advance playNext error:", e.message));
    }
  },

  /**
   * @private Extract track duration in ms from various track data shapes.
   * @this {import('./Player.mjs').Player}
   * @param {object} track
   * @returns {number}
   */
  _getTrackDurationMs(track) {
    if (track?._durationMs != null && track._durationMs > 0) {
      return track._durationMs;
    }
    if (track?.duration) {
      if (typeof track.duration === "object" && track.duration?.seconds != null) {
        return track.duration.seconds * 1000;
      }
      if (typeof track.duration === "string" && track.duration.startsWith("PT")) {
        return Utils.parseISODuration(track.duration);
      }
      if (typeof track.duration === "number") return track.duration;
    }
    if (track?.info?.length) return track.info.length;
    if (track?.info?.duration != null) {
      if (typeof track.info.duration === "number") return track.info.duration;
      if (typeof track.info.duration === "object" && track.info.duration.seconds != null)
        return track.info.duration.seconds * 1000;
    }
    return 0;
  },

  /**
   * @private Check if a track has played past 85% or within 15s of the end.
   * @this {import('./Player.mjs').Player}
   * @param {object} track
   * @returns {boolean}
   */
  _didTrackMostlyFinish(track) {
    const totalMs = this._getTrackDurationMs(track);
    if (!totalMs || !this.startedPlaying) return false;

    const elapsedMs = Math.max(0, Date.now() - this.startedPlaying);
    const remainingMs = Math.max(0, totalMs - elapsedMs);

    return elapsedMs / totalMs >= this.constructor.TRACK_MOSTLY_FINISHED_RATIO || remainingMs <= this.constructor.TRACK_MOSTLY_FINISHED_FLOOR_MS;
  },

  /**
   * @async Advance to the next track. Guarded against overlapping runs: a
   * generation counter ensures an older run's cleanup never clears the
   * in-flight flag of a newer run (which previously allowed double-advances).
   * @this {import('./Player.mjs').Player}
   * @returns {Promise<void>}
   */
  async playNext() {
    if (this._playingNext) return;
    this._playingNext = true;
    const generation = (this._playNextGeneration = (this._playNextGeneration ?? 0) + 1);
    try { await this._doPlayNext(); }
    finally { if (generation === this._playNextGeneration) this._playingNext = false; }
  },

  /**
   * @private @async Core logic for advancing to the next track: resolves
   * track options, announces, starts playback via the bridge, arms the
   * track-end timer, and handles the queue-end path.
   * @this {import('./Player.mjs').Player}
   */
  async _doPlayNext() {
    this._bridgeStop();

    const currentBeforeNext = this.queue.getCurrent();
    if (currentBeforeNext) this._lastPlayedTrack = currentBeforeNext;
    const songData = this.queue.next();
    if (!songData) {
      this.emit("stopplay");
      this.emit("queueEnd");

      if (!this._is247Enabled()) {
        this._startInactivityTimer();
      } else {
        logger.voice247("[Player] 24/7 enabled, staying in channel");
      }

      if (!this._wasRadio && !this._queueEndedSent && !this._autoplay) {
        this._queueEndedSent = true;
        const prefix = this._getPrefix?.(this._guildId) ?? "%";
        this.emit("message", { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this._t("responses._common.queueEnded", { prefix }))], system: true });
      }
      this._wasRadio = false;
      return;
    }

    this._stopInactivityTimer();
    this._wasRadio = songData.type === "radio";

    if (!this._voiceConn || this.leaving) return;

    if (this.preferredVolume !== 1 && this._voiceConn) {
      try { this._voiceConn.setVolume(this.preferredVolume * 100); } catch(_) {}
    }

    if (!this._voiceConn || this.leaving) return;

    this._activeTrackOpt  = null;
    this._clearTrackEndTimer();

    let trackOptMatch = null;
    try {
      trackOptMatch = await this._lookupTrackOptions(songData);
    } catch (e) {
      logger.warn("[Player] TrackOptions lookup error:", e.message);
    }

    if (trackOptMatch) {
      this._activeTrackOpt = trackOptMatch;
    }

    logger.player(`[Player:${this._guildId}] Playing: ${songData.title}`);

    this.startedPlaying   = Date.now();
    this._paused          = false;
    this._pausedAt        = null;
    this._queueEndedSent  = false;
    this._consecutiveErrors = 0;

    if (songData.type !== "radio" || !this._radioAnnounced) {
      this.announceSong(songData);
      if (songData.type === "radio") this._radioAnnounced = true;
    }
    this.emit("startplay", songData);

    try {
      const playUri = songData.url;
      const seekSec = trackOptMatch?.startMs > 0 ? trackOptMatch.startMs / 1000 : 0;

      if (!playUri || !Utils.isValidUrl(playUri)) {
        logger.warn(`[Player] No valid URL for track: ${songData.title} (url=${songData.url}), trying search...`);
        try {
          if (this._lavalink) {
            const result = await this._lavalink.search(songData.title, { source: "ytmsearch" });
            const track = result?.tracks?.[0];
            if (track?.info?.uri) {
              songData.url = track.info.uri;
              if (track.encoded) songData.encoded = track.encoded;
              await this._playTrackViaBridge(songData, { seekSeconds: seekSec });
            } else {
              throw new Error("No tracks found for title search");
            }
          } else {
            throw new Error("No Lavalink for fallback search");
          }
        } catch (searchErr) {
          logger.error("[Player] Could not resolve track:", searchErr?.message);
          this.emit("message", { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this._t("responses._common.couldNotGetStream", { title: songData.title }))] });
          this.emit("stopplay");
          if (!this._is247Enabled()) {
            this._startInactivityTimer();
          }
          return;
        }
      } else {
        await this._playTrackViaBridge(songData, { seekSeconds: seekSec });
      }

      if (trackOptMatch && trackOptMatch.endMs > 0) {
        const elapsedMs = Date.now() - this.startedPlaying;
        const remainingMs = trackOptMatch.endMs - elapsedMs;
        if (remainingMs > 0) {
          const match = trackOptMatch;
          this._trackEndTimer = setTimeout(() => this._onTrackEndTimeReached(match), remainingMs);
        }
      }
    } catch (err) {
      logger.error("[Player] Play error:", err.message);
      if (!this._skipping && !this.leaving && !this._paused && songData.type !== "radio") {
        this.emit("message", { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this._t("responses._common.errorStreaming", { title: songData.title }))] });
      }
      if (!this._skipping && !this.leaving) {
        this._consecutiveErrors = (this._consecutiveErrors || 0) + 1;
        if (this._consecutiveErrors <= 3) {
          this._handleTrackEnd();
        } else {
          logger.error(`[Player] ${this._consecutiveErrors} consecutive play errors — stopping auto-advance`);
          this._consecutiveErrors = 0;
          this.emit("stopplay");
          if (!this._is247Enabled()) {
            this._startInactivityTimer();
          }
        }
      }
    }
  },

  /**
   * @private @async Play a track through the FluxerAudioBridge. For
   * radio/external tracks without an encoded payload, attempts Lavalink URL
   * resolution first so MP3/AAC streams can use the loadstream pipeline.
   * Bilibili tracks get a FRESH signed proxy URL here on every play (DASH
   * audio URLs expire after a few hours, and each play/seek/loop needs its
   * own), which also clears any stale encoded payload so the pre-resolve
   * below re-resolves against the new URL.
   * @this {import('./Player.mjs').Player}
   * @param {object} songData
   * @param {object} [options={}]
   * @returns {Promise<void>}
   */
  async _playTrackViaBridge(songData, options = {}) {
    if (!this._voiceConn || !this._audioBridge) {
      throw new Error("No voice connection or audio bridge available");
    }
    if (!songData?.encoded && !songData?.url) {
      throw new Error("No encoded track or URL for: " + (songData?.title ?? "unknown"));
    }

    let bridgeUrl = songData.url;
    if (songData.type === "bilibili") {
      const stream = await getBilibiliStreamUrl(songData);
      songData.streamUrl = stream.url;
      songData.encoded   = null;
      bridgeUrl          = stream.url;
    }

    if (!songData.encoded && bridgeUrl && bridgeUrl.startsWith("http") && this._lavalink && songData.type !== "external") {
      try {
        const nlInfo = this._lavalink.getNodeLinkInfo?.();
        if (nlInfo) {
          const protocol = nlInfo.secure ? "https" : "http";
          const baseUrl = protocol + "://" + nlInfo.host + ":" + nlInfo.port;
          const headers = { "Authorization": nlInfo.password };
          if (nlInfo.sessionId) headers["Session-Id"] = nlInfo.sessionId;
          if (this._guildId) headers["Guild-Id"] = this._guildId;

          const loadtracksUrl = baseUrl + "/v4/loadtracks?identifier=" + encodeURIComponent(bridgeUrl);
          logger.player(`[Player] Pre-resolving ${songData.type || "external"} URL via Lavalink...`);

          const body = await this._request(loadtracksUrl, { headers });
          const track = body?.data?.tracks?.[0] ?? body?.tracks?.[0] ?? body?.data;
          const encoded = track?.encoded ?? track?.data;

          if (encoded && typeof encoded === "string") {
            songData.encoded = encoded;
            logger.player("[Player] Lavalink pre-resolve succeeded — track now has encoded payload");
          } else {
            logger.player("[Player] Lavalink pre-resolve: no encoded track returned, bridge will try direct URL");
          }
        }
      } catch (e) {
        logger.warn("[Player] Lavalink pre-resolve failed (bridge will try direct URL): " + e.message);
      }
    }

    this._audioBridge._conn = this._voiceConn;

    const seekMs = Math.floor((options.seekSeconds ?? 0) * 1000);

    const totalMs   = this._getTrackDurationMs(songData);
    const durationMs = totalMs > 0 ? Math.max(0, totalMs - seekMs) : 0;

    const result = await this._audioBridge.play(this._voiceConn, {
      encoded: songData.encoded,
      url:     bridgeUrl,
      title:   songData.title,
      guildId: this._guildId,
    }, {
      seekSeconds: options.seekSeconds ?? 0,
      durationMs,
      videoId: songData.videoId || null,
      filterPayload: this.activeFilterPayload || null,
    });

    if (result === "finished" && !this._skipping && !this.leaving && !this._paused) {
      this._handleTrackEnd();
    } else if (result === "stopped") {
    }
  },

  /**
   * @private Handle when a track option's end time is reached.
   * @this {import('./Player.mjs').Player}
   * @param {object} match
   */
  _onTrackEndTimeReached(match) {
    if (this._destroyed || this.leaving || !this._activeTrackOpt) return;
    logger.player(`[Player] TrackOptions: end time reached (${match.endMs}ms), skipping track`);
    this._activeTrackOpt = null;
    this._trackEndTimer = null;
    this._trackEndRemainingMs = null;
    this._skipping = true;
    this._bridgeStop();
    this._playingNext = false;
    this._lastPlayedTrack = this.queue.getCurrent() ?? this._lastPlayedTrack;
    this.emit("trackSkip", this._lastPlayedTrack);
    if (!this.queue.isEmpty() && !this.leaving) {
      this.playNext().catch(e => logger.error("[Player] TrackEnd playNext error:", e.message));
    } else {
      this.queue.current = null;
      if (!this._wasRadio && !this._queueEndedSent) {
        this._queueEndedSent = true;
        this.emit("queueEnd");
        if (!this._autoplay) {
          const prefix = this._getPrefix?.(this._guildId) ?? "%";
          this.emit("message", { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this._t("responses._common.queueEnded", { prefix }))], system: true });
        }
      }
      this.emit("stopplay");
      if (!this._is247Enabled()) {
        this._startInactivityTimer();
      }
    }
    this._skipping = false;
  },

  /**
   * @private Clear the track-end timer.
   * @this {import('./Player.mjs').Player}
   */
  _clearTrackEndTimer() {
    if (this._trackEndTimer) {
      clearTimeout(this._trackEndTimer);
      this._trackEndTimer = null;
    }
    this._trackEndRemainingMs = null;
  },

  /**
   * @private Pause the track-end timer, saving remaining time.
   * @this {import('./Player.mjs').Player}
   */
  _pauseTrackEndTimer() {
    if (!this._trackEndTimer || !this._activeTrackOpt || this._activeTrackOpt.endMs <= 0) return;
    clearTimeout(this._trackEndTimer);
    const elapsedMs = Date.now() - this.startedPlaying;
    this._trackEndRemainingMs = Math.max(0, this._activeTrackOpt.endMs - elapsedMs);
    this._trackEndTimer = null;
  },

  /**
   * @private Resume the track-end timer.
   * @this {import('./Player.mjs').Player}
   */
  _resumeTrackEndTimer() {
    if (this._trackEndRemainingMs == null || this._trackEndRemainingMs <= 0 || !this._activeTrackOpt || this._activeTrackOpt.endMs <= 0) {
      this._trackEndRemainingMs = null;
      return;
    }
    const remainingMs = this._trackEndRemainingMs;
    const match = this._activeTrackOpt;
    this._trackEndTimer = setTimeout(() => this._onTrackEndTimeReached(match), remainingMs);
    this._trackEndRemainingMs = null;
  },

  /**
   * @private Recalculate and restart the track-end timer (after a seek).
   * @this {import('./Player.mjs').Player}
   */
  _recalcTrackEndTimer() {
    if (!this._activeTrackOpt || this._activeTrackOpt.endMs <= 0) return;
    this._clearTrackEndTimer();
    const elapsedMs = Date.now() - this.startedPlaying;
    const remainingMs = this._activeTrackOpt.endMs - elapsedMs;
    if (remainingMs <= 0) {
      this._onTrackEndTimeReached(this._activeTrackOpt);
      return;
    }
    const match = this._activeTrackOpt;
    this._trackEndTimer = setTimeout(() => this._onTrackEndTimeReached(match), remainingMs);
  },

  /**
   * @async Seek to a specific position in the currently playing track.
   * @this {import('./Player.mjs').Player}
   * @param {number} ms - Target position in milliseconds.
   * @returns {Promise<boolean>} True if seek succeeded, false otherwise.
   */
  async seekToPosition(ms) {
    if (!this._voiceConn || !this.queue.getCurrent()) return false;

    this._seeking = true;

    try {
      this._bridgeStop();
      const current = this.queue.getCurrent();
      if (current?.url) {
        this.startedPlaying = Date.now() - ms;
        await this._playTrackViaBridge(current, { seekSeconds: ms / 1000 });
      }
      logger.player(`[Player] Seeked to ${ms}ms — adjusted startedPlaying`);

      this._recalcTrackEndTimer();

      return true;
    } catch (e) {
      this._seeking = false;
      logger.error("[Player] Seek failed:", e?.message);
      return false;
    } finally {
      this._seeking = false;
    }
  },

  /**
   * @async Apply an audio filter to playback. Stores filter metadata for
   * dashboard tracking; filters are applied server-side by NodeLink on the
   * next track.
   * @this {import('./Player.mjs').Player}
   * @param {object} filterPayload
   * @param {object|null} [filterMeta=null]
   * @returns {Promise<{ok: boolean, reason?: string, pending?: boolean}>}
   */
  async applyFilter(filterPayload, filterMeta = null) {
    if (!this._guildId) {
      return { ok: false, reason: "Player not bound to a guild." };
    }

    const current = this.queue.getCurrent();

    this.activeFilter = filterMeta ?? null;
    this.activeFilterPayload = filterMeta ? filterPayload : null;
    this.emit("filter", this.activeFilter);

    if (!current?.encoded || !this._voiceConn) {
      return { ok: true, pending: true };
    }

    return { ok: true };
  },

  /**
   * Clear any active audio filter.
   * @this {import('./Player.mjs').Player}
   */
  clearFilter() {
    this.activeFilter = null;
    this.activeFilterPayload = null;
    this.emit("filter", null);
    logger.warn("[Player] clearFilter: filters not supported in LiveKit mode");
  },

  /**
   * @private @async Look up per-user track options for the humans currently
   * in the player's channel.
   * @this {import('./Player.mjs').Player}
   * @param {object} songData
   * @returns {Promise<object|null>}
   */
  async _lookupTrackOptions(songData) {
    if (!this.trackOptions || !songData || songData.type === "radio") return null;
    if (!this._guildId || !this._channelId) return null;

    const userIds = [];
    if (this._voiceCache) {
      const humans = this._voiceCache.getHumansInChannel(
          cleanId(this._guildId),
          cleanId(this._channelId)
      );
      userIds.push(...humans);
    }

    if (userIds.length === 0) {
      try {
        const guild = this.client?.guilds?.get?.(this._guildId);
        const voiceStates = guild?.voice_states ?? guild?.voiceStates;
        if (voiceStates) {
          const entries = Array.isArray(voiceStates) ? voiceStates
              : typeof voiceStates.values === "function" ? [...voiceStates.values()]
                  : Object.values(voiceStates);
          for (const state of entries) {
            const ch = cleanId(state?.channelId ?? state?.channel_id ?? "");
            if (ch === cleanId(this._channelId)) {
              const uid = state?.userId ?? state?.user_id;
              const member = guild?.members?.get?.(uid);
              if (uid && !member?.user?.bot) userIds.push(uid);
            }
          }
        }
      } catch(e) { logger.warn("[Player] Voice state lookup error:", e?.message); }
    }

    if (userIds.length === 0) return null;

    const match = await this.trackOptions.getBestMatchForChannel(userIds, songData);
    return match || null;
  },

  /**
   * @private @async Auto-seek to a track options start position.
   * @this {import('./Player.mjs').Player}
   * @param {object} match
   */
  async _applyTrackOptionsSeek(match) {
    if (!match || match.startMs <= 0) return;
    const current = this.queue.getCurrent();
    if (!current?.url || !this._voiceConn || this.leaving) {
      logger.warn(`[Player] TrackOptions: cannot seek (encoded=${!!current?.encoded} lavalinkPlayer=${!!this.lavalinkPlayer} leaving=${this.leaving})`);
      return;
    }
    let seeked = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      await Utils.sleep(500);
      try {
        const result = await this.seekToPosition(match.startMs);
        if (result) {
          seeked = true;
          logger.player(`[Player] TrackOptions: auto-seeked to ${match.startMs}ms for user ${match.userId} (attempt ${attempt + 1})`);
          break;
        }
      } catch (e) {
        logger.warn(`[Player] TrackOptions auto-seek attempt ${attempt + 1} error:`, e.message);
      }
    }
    if (!seeked) {
      logger.warn(`[Player] TrackOptions: auto-seek to ${match.startMs}ms failed after all retries`);
    }
  },

  /**
   * @async Apply a track options match (custom start/end times) to the
   * currently playing track.
   * @this {import('./Player.mjs').Player}
   * @param {object} match - Track options match with startMs and optional endMs.
   * @returns {Promise<boolean>} True if applied successfully, false otherwise.
   */
  async applyTrackOption(match) {
    if (!match || !this._voiceConn || this._paused) return false;

    this._clearTrackEndTimer();
    this._activeTrackOpt = null;

    try {
      await this.seekToPosition(match.startMs || 0);
    } catch (e) {
      logger.warn("[Player] TrackOptions apply-seek error:", e.message);
      return false;
    }

    if (match.endMs > 0) {
      const elapsedMs = Date.now() - this.startedPlaying;
      const remainingMs = match.endMs - elapsedMs;
      if (remainingMs > 0) {
        this._activeTrackOpt = match;
        this._trackEndTimer = setTimeout(() => this._onTrackEndTimeReached(match), remainingMs);
      }
    } else {
      this._activeTrackOpt = match;
    }

    return true;
  },

  /**
   * @async Fetch lyrics for the currently playing track via the Lavalink
   * REST API.
   * @this {import('./Player.mjs').Player}
   * @returns {Promise<{text: string, source: string, synced: boolean, lines: Array}|null>}
   */
  async lyrics() {
    const current = this.queue.getCurrent();
    if (!current) return null;

    const node = this._lavalink?.getNode?.() ?? null;

    if (node) {
      try {
        const searchQuery = current.artists?.[0]?.name
            ? `${current.title} ${current.artists[0].name}`
            : current.title;

        const path = current.encoded
          ? `/loadlyrics?encodedTrack=${encodeURIComponent(current.encoded)}`
          : `/loadlyrics?identifier=${encodeURIComponent(searchQuery)}`;

        const results = await node.request(path);

        if (results?.data?.lines?.length) {
          return {
            text:   results.data.lines.map(l => l.text).join("\n"),
            source: "Lavalink",
            synced: results.data.lines.some(l => l.startTimeMs != null),
            lines:  results.data.lines,
          };
        }
      } catch (e) {
        logger.player(`[Lyrics] Lavalink REST lyrics failed: ${e.message}`);
      }
    }

    return null;
  },
};

export default PlaybackMixin;
export { PlaybackMixin };
