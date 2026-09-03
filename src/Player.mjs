/** @module src/Player @description Core music player with queue management, voice connection handling, track streaming, and playback controls. */


import { getVoiceManager } from "@fluxerjs/voice";
import { Utils, cleanId } from "./Utils.mjs";
import { EventEmitter } from "node:events";
import meta from "./probe.mjs";
import http from "node:http";
import https from "node:https";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "./MessageHandler.mjs";
import { logger } from "./constants/Logger.mjs";
import { get247ChannelMode } from "./constants/Helpers247.mjs";
import { PROVIDERS, PROVIDER_NAMES } from "./constants/providers.mjs";
import { hasHumansInChannel } from "./constants/VoiceStateResolver.mjs";
import { FluxerAudioBridge } from "./FluxerAudioBridge.mjs";


/** @class Queue @description Internal queue data structure that tracks tracks, loop state, and emits queue events. @extends {EventEmitter} */
export class Queue extends EventEmitter {
  /** @type {Array<object>} @description The queued track objects. */
  data = [];
  /** @type {object|null} @description The currently playing track. */
  current = null;
  /** @type {boolean} @description Whether queue loop is enabled. */
  loop = false;
  /** @type {boolean} @description Whether single-song loop is enabled. */
  songLoop = false;

  /** Initialize an empty queue with no loop enabled. */
  constructor() {
    super();
  }

  /** @returns {boolean} Whether the queue has no tracks. */
  isEmpty() { return this.data.length === 0; }
  /** @returns {number} Number of tracks in the queue (excluding current). */
  size()    { return this.data.length; }

  /** Advance to the next track in the queue. If songLoop is active, returns the current track. Emits a queue update event. @returns {object|null} The next track, or null if the queue is empty. */
  next() {
    const previous = this.current;

    if (this.songLoop && this.current) return this.current;
    if (this.loop && this.current) this.data.push(this.current);

    if (this.isEmpty()) {
      this.current = null;
      return null;
    }

    this.current = this.data.shift();
    this.emit("queue", {
      type: "update",
      data: { current: this.current, old: previous, loop: this.loop }
    });
    return this.current;
  }

/** Remove a track from the queue by index. @param {number} idx - Zero-based index of the track to remove. @returns {string} Result message indicating success or out-of-bounds error. */
  remove(idx) {
    if (idx < 0 || idx >= this.data.length) return "Index out of bounds";
    const title = this.data[idx].title;
    const removed = this.data.splice(idx, 1);
    this.emit("queue", { type: "remove", data: { index: idx, old: this.data.slice(), removed, new: this.data } });
    return `Successfully removed **${title}** from the queue.`;
  }

/** Move a track from one position to another (0-based indices). @param {number} from - Source index. @param {number} to - Destination index. @returns {string} Result message indicating success or error. */
  move(from, to) {
    if (from < 0 || from >= this.data.length) return "Source index out of bounds";
    if (to < 0 || to >= this.data.length)     return "Target index out of bounds";
    if (from === to)                            return "Track is already in that position";
    const [track] = this.data.splice(from, 1);
    this.data.splice(to, 0, track);
    this.emit("queue", { type: "move", data: { from, to, track } });
    return `Moved **${track.title}** from position ${from + 1} to ${to + 1}.`;
  }

/** Add a single track to the queue. @param {object} data - Track data object. @param {boolean} [top=false] - If true, insert at the front of the queue. @returns {number} The new length of the queue. */
  add(data, top = false) {
    this.emit("queue", { type: "add", data: { append: !top, data } });
    return top ? this.data.unshift(data) : this.data.push(data);
  }

/** Add multiple tracks to the queue (up to 1000). @param {Array<object>} tracks - Array of track data objects. @param {boolean} [top=false] - If true, insert at the front of the queue. @returns {number} Number of tracks actually added. */
  addMany(tracks, top = false) {
    if (!tracks?.length) return 0;
    if (!Array.isArray(tracks)) tracks = [];
    const count = Math.min(tracks.length, 1000);
    if (top) {
      for (let i = count - 1; i >= 0; i--) this.data.unshift(tracks[i]);
    } else {
      for (let i = 0; i < count; i++) this.data.push(tracks[i]);
    }
    this.emit("queue", { type: "addMany", data: { append: !top, tracks: tracks.slice(0, count) } });
    return count;
  }

  /** Remove all tracks from the queue. */
  clear()  { this.data.length = 0; }
  /** Clear the queue and reset all state (current, loops). */
  reset()  { this.clear(); this.current = null; this.songLoop = false; this.loop = false; }

  /** @param {boolean} bool - Enable or disable song loop. */
  setSongLoop(bool) { this.songLoop = bool; }
  /** @param {boolean} bool - Enable or disable queue loop. */
  setLoop(bool)     { this.loop = bool; }

/** Toggle a loop mode on or off. @param {"song"|"queue"} loop - The type of loop to toggle. @returns {boolean|null} The new loop state, or null if the loop type is invalid. */
  toggleLoop(loop) {
    if (loop === "song")  { this.setSongLoop(!this.songLoop); return this.songLoop; }
    if (loop === "queue") { this.setLoop(!this.loop);         return this.loop; }
    return null;
  }

  /** Shuffle the queue in place and emit a queue event. */
  shuffle() {
    Utils.shuffleArr(this.data);
    this.emit("queue", { type: "shuffle", data: this.data });
  }

  /** @returns {object|null} The currently playing track. */
  getCurrent() { return this.current; }
  /** @returns {Array<object>} A copy of the queue array. */
  getQueue()   { return this.data; }

/** Get a paginated slice of the queue. @param {number} [page=1] - 1-based page number (clamped to valid range). @param {number} [pageSize=10] - Number of tracks per page. @returns {object} Page result with items, page, totalPages, total, and start index. */
  getPage(page = 1, pageSize = 10) {
    const total      = this.data.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage   = Utils.clamp(page, 1, totalPages);
    const start      = (safePage - 1) * pageSize;
    return { items: this.data.slice(start, start + pageSize), page: safePage, totalPages, total, start };
  }
}

/** @class Player @description Main music player class. Manages voice connections, playback, queue, filters, and search. Extends EventEmitter. */
export default class Player extends EventEmitter {
  /** @private */
  _voiceConn         = null;
  _audioBridge       = null;
  lavalinkPlayer     = null;
  connection         = null;
  _guildId           = null;
  _channelId         = null;
  _lastConnectedAt   = null;
  _home247Channel    = null;

  queue        = null;
  client       = null;
  settings     = null;
  config       = {};

  _lavalink    = null;

  leaving           = false;
  _paused           = false;
  _pausedAt         = null;
  _playingNext      = false;
  startedPlaying    = null;
  searches          = new Map();
  _searchMaxSize    = 50;
  _maxQueueSize     = 10_000;
  resultLimit       = 5;
  preferredVolume   = 1;

  _skipping            = false;
  _seeking             = false;
  _wasRadio            = false;
  _radioAnnounced      = false;
  _queueEndedSent      = false;
  _lastPlayedTrack     = null;

  _autoplay            = false;
  _autoplayHandler     = null;

  activeFilter         = null;
  activeFilterPayload  = null;

  static INACTIVITY_DEFAULT_MS = 3 * 60 * 1000;
  static TRACK_MOSTLY_FINISHED_RATIO = 0.85;
  static TRACK_MOSTLY_FINISHED_FLOOR_MS = 15_000;
  static RADIO_SAFETY_TIMEOUT_MS = 20 * 60 * 1000;

  _inactivityTimer     = null;
  _inactivityLimit = Player.INACTIVITY_DEFAULT_MS;
  _pendingInactivityCheck = false;

  _isJoining           = false;

  _destroyed           = false;
  _rejoinTimer         = null;

/**
 * Create a new Player instance bound to a voice channel.
 *
 * @param {string} token - Bot authentication token (used internally, NOT guild ID).
 * @param {object} [opts={}] - Player configuration options.
 * @param {import('@fluxerjs/core').Client} [opts.client] - The Discord/Fluxer client instance.
 * @param {object} [opts.config] - Full bot configuration object.
 * @param {import('../src/LavalinkManager.mjs').LavalinkManager} [opts.lavalink] - Lavalink node manager for track search.
 * @param {import('../src/Settings.mjs').RemoteSettingsManager} [opts.settingsMgr] - Remote settings manager.
 * @param {Function} [opts.getPrefix] - Function returning command prefix for a guild: (guildId) => string.
 * @param {import('../src/constants/VoiceStateCache.mjs').VoiceStateCache} [opts.observedVoiceUsers] - Voice state cache (legacy alias, same as voiceCache).
 * @param {import('../src/constants/VoiceStateCache.mjs').VoiceStateCache} [opts.voiceCache] - Voice state cache for human/bot tracking.
 * @param {import('../src/constants/Locale.mjs').Locale} [opts.locale] - Locale manager for i18n.
 * @param {import('../src/TrackOptionsManager.mjs').TrackOptionsManager} [opts.trackOptions] - Per-user track option matcher.
 */
  constructor(token, opts = {}) {
    super();

    this.queue        = new Queue();
    this.queue.on("queue", (...args) => this.emit("queue", ...args));
    this.client       = opts.client;
    this.config       = opts.config ?? {};
    this.settings     = opts.settings ?? null;
    this.settingsMgr  = opts.settingsMgr ?? null;
    this._getPrefix   = opts.getPrefix ?? null;
    this._observedVoiceUsers = opts.observedVoiceUsers ?? null;
    this._voiceCache          = opts.voiceCache ?? null;
    this.locale       = opts.locale ?? null;
    this.trackOptions = opts.trackOptions ?? null;
    this._activeTrackOpt = null;

    this._lavalink = opts.lavalink ?? null;

    this._audioBridge = new FluxerAudioBridge(opts.lavalink ?? null);
    this._audioBridge.on("error", (err) => {
      logger.error(`[Player] Audio bridge error (guild ${this._guildId}): ${err.message}`);
    });

    const inactivityMs = this.config?.timers?.inactivityTimeout ?? this.config?.inactivityTimeout;
    if (inactivityMs !== undefined) {
      const parsed = Number(inactivityMs);
      if (!Number.isNaN(parsed) && parsed >= 0) {
        this._inactivityLimit = parsed;
      }
    }

    if (this._lavalink) {
      this._onLavalinkPlayerDisconnect = (lavaPlayer) => {
        if (!lavaPlayer || String(lavaPlayer.guildId) !== String(this._guildId)) return;
        logger.lavalink("[Player] lavalink-client player disconnect (guild: " + this._guildId + ") — ignored (voice via LiveKit)");
      };
      this._lavalink.on("playerDisconnected", this._onLavalinkPlayerDisconnect);
    }
  }

  /**
   * Handle the end of a track. Advances to next song or starts 24/7 wait.
   * For radio tracks, stops playback and starts inactivity (if not 24/7).
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
  }

  /**
   * Check whether 24/7 mode is active for this player's current channel.
   * @returns {boolean} True if 24/7 is enabled.
   */
  _is247Enabled() {
    return this._get247Mode() !== "off";
  }

  /**
   * Resolve the 24/7 mode for this player's current or home channel.
   * Checks the guild's stay_247 setting to determine if the channel is registered.
   * @returns {"on"|"off"} The 24/7 mode. Only "on" or "off" — no "auto".
   * @private
   */
  _get247Mode() {
    if (!this._guildId) return "off";
    const serverSettings = this.settingsMgr?.getServer?.(this._guildId)
        ?? this.settings
        ?? this.client?.settings?.getServer?.(this._guildId);
    if (!serverSettings?.get) return "off";

    const channelId = cleanId(this._home247Channel ?? this._channelId ?? "");
    if (!channelId) return "off";


    const raw = serverSettings.get("stay_247");
    if (raw && raw !== "none") {
      const channels = Array.isArray(raw)
        ? raw.map(id => cleanId(id)).filter(Boolean)
        : [cleanId(raw)].filter(Boolean);
      if (!channels.includes(channelId)) return "off";
    } else {
      return "off";
    }

    return get247ChannelMode(serverSettings, channelId);
  }

  /** @private @returns {string|null} The cleaned guild ID, or null if unresolvable. */
  _resolveGuildId() {
    const cleanGuild = cleanId(this._guildId ?? "");
    if (cleanGuild) return cleanGuild;

    try {
      const channelId = this._channelId ?? this._home247Channel;
      if (channelId) {
        const ch = this.client?.channels?.get?.(channelId);
        const fromChannel = ch?.guildId ?? ch?.guild?.id ?? null;
        if (fromChannel) return cleanId(fromChannel);
      }
    } catch(e) { logger.warn("[Player] Guild resolution failed:", e?.message); }

    return null;
  }

  /** @private Restore saved volume from guild settings. */
  _restoreVolume() {
    if (!this._guildId) return;
    let savedVol = null;

    if (this.settings?.get) {
      savedVol = this.settings.get("volume");
    } else if (this.settingsMgr?.getServer) {
      const set = this.settingsMgr.getServer(this._guildId);
      savedVol = set?.get?.("volume");
    } else if (this.client?.settings?.getServer) {
      savedVol = this.client.settings.getServer(this._guildId)?.get?.("volume");
    } else if (this.client?.settings?.get) {
      const s = this.client.settings.get(this._guildId);
      savedVol = s?.get?.("volume") ?? s?.volume;
    }

    if (savedVol !== undefined && savedVol !== null) {
      const parsed = Number(savedVol);
      if (!Number.isNaN(parsed) && parsed > 0) {
        this.preferredVolume = Utils.clamp(parsed / 100, 0, 2);
        logger.player(`[Player] Restored volume ${savedVol}% for guild ${this._guildId}`);
        if (this._voiceConn) {
          try { this._voiceConn.setVolume(this.preferredVolume * 100); } catch (_) {}
        }
      }
    }
  }

  /** @private @returns {boolean} Whether there are non-bot users in the voice channel. */
  _hasHumansInChannel() {
    return hasHumansInChannel({
      guildId:   cleanId(this._guildId ?? ""),
      channelId: cleanId(this._channelId ?? ""),
      client:    this.client,
      voiceCache: this._voiceCache,
      observedVoiceUsers: this._observedVoiceUsers,
      botId:     this.client?.user?.id,
    });
  }

  /**
   * Start the inactivity timer. Skipped if:
   * - 24/7 mode is active (mode === "on")
   * - Queue has songs
   * - Humans are present in the channel
   * The timer callback re-checks all conditions before emitting autoleave.
   */
  _startInactivityTimer() {
    this._stopInactivityTimer();
    if (this._inactivityLimit <= 0) return;

    const mode = this._get247Mode();
    logger.inactivity(`[Player] Checking 24/7 mode for guild ${this._guildId}: ${mode}`);

    if (mode === "on") {
      logger.inactivity(`[Player] 24/7 mode active for guild ${this._guildId}, skipping inactivity timer`);
      return;
    }

    if (this.queue?.getCurrent() || !this.queue?.isEmpty()) {
      logger.inactivity(`[Player] Queue has songs for guild ${this._guildId}, skipping inactivity timer`);
      return;
    }

    if (this._hasHumansInChannel()) {
      logger.inactivity(`[Player] Humans present in channel ${this._channelId}, skipping inactivity timer`);
      return;
    }

    logger.inactivity(`[Player] Starting inactivity timer for guild ${this._guildId} (${this._inactivityLimit / 1000}s)`);
    this._inactivityTimer = setTimeout(() => {
      const currentMode = this._get247Mode();
      if (currentMode === "on") {
        logger.inactivity(`[Player] 24/7 mode enabled during inactivity wait, aborting leave`);
        return;
      }
      if (this.queue?.getCurrent() || !this.queue?.isEmpty()) {
        logger.inactivity("[Player] Song in queue during inactivity wait, aborting leave");
        return;
      }
      if (this._hasHumansInChannel()) {
        logger.inactivity("[Player] Human joined during inactivity wait, aborting leave");
        return;
      }
      logger.inactivity(`[Player] Guild ${this._guildId} inactive too long. Leaving.`);
      this.emit("autoleave");
    }, this._inactivityLimit);
  }

  /**
   * Clear the inactivity timer if running.
   */
  _stopInactivityTimer() {
    this._pendingInactivityCheck = false;
    if (this._inactivityTimer) {
      logger.inactivity(`[Player] Stopping inactivity timer for guild ${this._guildId}`);
      clearTimeout(this._inactivityTimer);
      this._inactivityTimer = null;
    }
  }

  /**
   * Schedule a 24/7 rejoin after a delay. Guards against:
   * - Player already destroyed
   * - Intentional leave registered
   * - Pending or existing player in the target channel
   * @param {string} channelId - The channel to rejoin.
   * @param {string} guildId - The guild ID.
   * @param {string} mode - The 24/7 mode ("on").
   * @private
   */
  _schedule247Rejoin(channelId, guildId, mode) {
    const ctx = this.client?._remix;
    if (!ctx) {
      logger.warn(`[Player] Cannot schedule 24/7 rejoin for ${channelId} — no bot context`);
      return;
    }

    if (ctx.players?._pendingJoins?.has?.(channelId)) {
      logger.voice247(`[Player] 24/7 rejoin skipped for ${channelId} — join already pending`);
      return;
    }

    if (ctx.players?.playerMap?.has(channelId)) {
      const existing = ctx.players.playerMap.get(channelId);
      if (existing && !existing._destroyed && existing !== this) {
        logger.voice247(`[Player] 24/7 rejoin skipped for ${channelId} — another player already exists`);
        return;
      }
    }

    const rejoinDelay = ctx.config?.timers?.rejoin247Delay ?? 3_000;
    logger.voice247(`[Player] Scheduling 24/7 ${mode} rejoin for channel ${channelId} (guild ${guildId}) in ${rejoinDelay / 1000}s`);

    this._rejoinTimer = setTimeout(() => {
      this._rejoinTimer = null;
      if (this._destroyed) {
        logger.voice247(`[Player] 24/7 rejoin cancelled — player destroyed`);
        return;
      }
      if (ctx.intentionalLeaves?.has(channelId)) {
        logger.voice247(`[Player] 24/7 rejoin cancelled — intentional leave registered`);
        return;
      }

      ctx.gatewayHandler?._rejoinChannel?.(guildId, channelId).catch(err => {
        logger.warn(`[Player] 24/7 rejoin failed for channel ${channelId}:`, err?.message);
      });
    }, rejoinDelay);
  }

  /** @private @async @param {string} url @param {object} [options={}] @param {boolean} [returnStream=false] @returns {Promise<object|Readable|null>} */
  async _request(url, options = {}, returnStream = false) {
    return new Promise((resolve, reject) => {
      const fetchUrl = (target, _redirects = 0) => {
        const urlObj = new URL(target);
        const client = urlObj.protocol === "https:" ? https : http;

        const req = client.request({
          protocol: urlObj.protocol,
          host:     urlObj.hostname,
          port:     urlObj.port,
          path:     urlObj.pathname + urlObj.search,
          method:   options.method || "GET",
          headers: {
            "User-Agent":    "Mozilla/5.0 (compatible; Bot/1.0)",
            "Accept":        "*/*",
            ...options.headers,
          },
        }, (res) => {
          if (returnStream) req.setTimeout(0);

          if ([301, 302, 307, 308].includes(res.statusCode)) {
            let loc = res.headers.location;
            if (!loc) return reject(new Error("Redirect without location"));
            if (loc.startsWith("/")) loc = `${urlObj.protocol}//${urlObj.host}${loc}`;
            if (_redirects >= 5) return reject(new Error("Too many redirects"));
            const redirectUrl = new URL(loc);
            if (redirectUrl.host !== urlObj.host) {
              if (options.headers) delete options.headers.Authorization;
            }
            return fetchUrl(loc, _redirects + 1);
          }
          if (![200, 204, 206].includes(res.statusCode)) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          if (returnStream) return resolve(res);

          if (res.statusCode === 204) { res.resume(); return resolve(null); }

          const chunks = [];
          res.on("data", d => chunks.push(d));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString().trim();
            if (!raw) return resolve(null);
            try { resolve(JSON.parse(raw)); }
            catch (e) { reject(new Error(`JSON parse error from ${target}`)); }
          });
        });

        req.on("error", reject);
        req.setTimeout(options.timeout || 60_000, () => {
          req.destroy();
          reject(new Error("Request timeout"));
        });
        if (options.body) req.write(options.body);
        req.end();
      };
      fetchUrl(url);
    });
  }

  /** @private Extract track duration in milliseconds from various possible track data shapes. @param {object} track @returns {number} */
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
  }

  /** @private Check if a track has played past 85% or within 15s of the end. @param {object} track @returns {boolean} */
 _didTrackMostlyFinish(track) {
    const totalMs = this._getTrackDurationMs(track);
    if (!totalMs || !this.startedPlaying) return false;

    const elapsedMs = Math.max(0, Date.now() - this.startedPlaying);
    const remainingMs = Math.max(0, totalMs - elapsedMs);

    return elapsedMs / totalMs >= Player.TRACK_MOSTLY_FINISHED_RATIO || remainingMs <= Player.TRACK_MOSTLY_FINISHED_FLOOR_MS;
  }

  /** @private Stop the audio bridge if currently playing. */
 _bridgeStop() {
    if (this._audioBridge?.playing) {
      this._audioBridge.stop();
    }
  }

/** @async Join a voice channel via LiveKit. Sets up voice connection, event listeners, and resumes playback if queue has tracks. @param {string} channelId - The voice channel ID to join. @returns {Promise<void>} @throws {Error} If the channel is not found, VoiceManager is unavailable, or connection fails. */
  async join(channelId) {
    if (this._destroyed) return;

    if (this._isJoining) {
      logger.player(`[Player] Busy joining. Ignoring: ${channelId}`);
      return;
    }
    if (this._voiceConn && this._channelId === channelId) {
      logger.player(`[Player] Already in channel: ${channelId}`);
      return;
    }

    if (this._voiceConn) {
      logger.player("[Player] Cleaning up existing voice connection before join");
      this._bridgeStop();
      try { await this._voiceConn.disconnect(); } catch(e) { logger.warn("[Player] Existing voiceConn disconnect error:", e?.message); }
      this._voiceConn = null;
      this.connection = null;
      await Utils.sleep(500);
    }

    this._isJoining = true;
    try {
      const channel = this.client?.channels?.get?.(channelId);
      if (!channel) throw new Error(`Channel not found: ${channelId}`);

      if (this._lavalink) {
        logger.player(`[Player] Waiting for Lavalink node...`);
        await this._lavalink.waitForNode({ timeoutMs: 15_000 });
      }

      this._channelId = channelId;
      this._guildId   = cleanId(channel.guildId);
      this._lastConnectedAt = Date.now();
      this.leaving    = false;

      logger.player(`[Player] Joining channel ${channelId} via vm.join() (LiveKit)...`);
      const vm = getVoiceManager(this.client);
      if (!vm) {
        throw new Error("VoiceManager not available — call getVoiceManager(client) before login");
      }

      let voiceConn;
      try {
        voiceConn = await vm.join(channel);
      } catch (e) {
        throw new Error(`vm.join() failed for channel ${channelId}: ${e.message}`);
      }

      if (!voiceConn) {
        throw new Error(`vm.join() returned null for channel ${channelId}`);
      }

      this._voiceConn = voiceConn;
      this.connection = voiceConn;

      if (typeof voiceConn.isConnected === "function" && !voiceConn.isConnected()) {
        logger.player("[Player] Waiting for LiveKit room to connect...");
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("LiveKit connection timeout (15s)")), 15_000);
          const check = () => {
            try {
              if (voiceConn.isConnected()) { clearTimeout(timeout); return resolve(); }
              if (voiceConn.connectionState === 0) { clearTimeout(timeout); return resolve(); }
            } catch (_) { clearTimeout(timeout); return resolve(); }
            setTimeout(check, 200);
          };
          check();
        });
        await Utils.sleep(500);
      }

      logger.player(`[Player] LiveKit voice connected (guild: ${this._guildId}, channel: ${channelId})` +
        ` isConnected=${voiceConn.isConnected ? voiceConn.isConnected() : 'unknown'}`);

      try {
        vm.updateVoiceState(channelId, { self_deaf: true, self_mute: false });
      } catch (e) {
        logger.warn("[Player] Self-deafen failed:", e.message);
      }

      if (typeof voiceConn.on === "function") {
        voiceConn.on("serverLeave", () => {
          if (this.leaving || this._destroyed) return;
          logger.player(`[Player] serverLeave received — Fluxer/LiveKit terminated session`);
          this._voiceConn = null;
          this.connection = null;
          this._paused = true;
          this._stopInactivityTimer();

          const mode = this._get247Mode();
          const cId = cleanId(this._channelId ?? this._home247Channel ?? "");
          const gId = cleanId(this._guildId ?? "");

          if (mode === "on") {
            logger.player("[Player] serverLeave in 24/7 mode — scheduling rejoin");
            this.emit("autoleave");
            if (cId && gId) this._schedule247Rejoin(cId, gId, mode);
          } else {
            logger.player("[Player] Unexpected serverLeave");
            this.emit("autoleave");
          }
        });

        voiceConn.on("disconnect", () => {
          if (this.leaving || this._destroyed) return;
          logger.player(`[Player] Voice connection disconnected`);
        });
      }

      this._restoreVolume();
      this.emit("roomfetched");
      logger.player(`[Player] Voice connected to ${channel.name || channelId}`);

      if (!this.queue.isEmpty() && !this.queue.getCurrent()) {
        this.playNext().catch(e => logger.error("[Player] playNext error:", e.message));
      } else if (this.queue.isEmpty()) {
        this._pendingInactivityCheck = true;
        setTimeout(() => {
          if (!this._pendingInactivityCheck) return;
          this._pendingInactivityCheck = false;
          if (this.queue.isEmpty() && !this.queue.getCurrent()) {
            this._startInactivityTimer();
          }
        }, 3000);
      }

    } catch (e) {
      const causeStr = e.cause ? ` (Cause: ${e.cause})` : "";
      logger.error("[Player] Join failed:", e.message, causeStr);

      if (this._voiceConn) {
        try { await this._voiceConn.disconnect(); } catch(err) { logger.warn("[Player] voiceConn disconnect on join failure:", err?.message); }
        this._voiceConn = null;
        this.connection = null;
      }
      throw e;
    } finally {
      this._isJoining = false;
    }
  }

/** @async Leave the current voice channel. Stops playback, resets state, and cleans up the voice connection. @returns {Promise<boolean>} True if leave was successful, false otherwise. */
  async leave() {
    if (!this._voiceConn && !this.connection) return false;
    try {
      this.leaving = true;
      this._stopInactivityTimer();
      this._clearTrackEndTimer();
      this._activeTrackOpt = null;

      const channelId = this._channelId;

      this._bridgeStop();

      try {
        const vm = getVoiceManager(this.client);
        if (channelId) {
          vm.leaveChannel(channelId);
          logger.player("[Player] Left channel " + channelId + " via vm.leaveChannel()");
        }
      } catch(e) { logger.warn("[Player] Gateway leave error:", e?.message); }

      if (this._voiceConn) {
        try { await this._voiceConn.disconnect(); } catch(e) { logger.warn("[Player] voiceConn disconnect error:", e?.message); }
      }

      if (this._audioBridge) {
        this._audioBridge.stop();
      }

      this.queue.reset();
      this._voiceConn     = null;
      this.lavalinkPlayer = null;
      this.connection     = null;
      this._paused        = false;
      this._pausedAt      = null;
      this._playingNext   = false;
      this._autoplay      = false;
      if (this._autoplayHandler) {
        this.removeListener("queueEnd", this._autoplayHandler);
        this._autoplayHandler = null;
      }
    } catch (e) {
      logger.error("[Player] leave error:", e.message);
      this.leaving = false;
      return false;
    }
    this.leaving = false;
    this.emit("leave");
    return true;
  }

  /** Fully destroy this player instance: clean up timers, listeners, connections, and resources. */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

    this._clearTrackEndTimer();
    this._activeTrackOpt = null;

    try {
      if (this._lavalink) {
        if (this._onLavalinkPlayerDisconnect) {
          try { this._lavalink.off("playerDisconnected", this._onLavalinkPlayerDisconnect); } catch(e) { /* best effort */ }
          this._onLavalinkPlayerDisconnect = null;
        }
      }
      this.leaving          = true;
      this._stopInactivityTimer();
      if (this._rejoinTimer) { clearTimeout(this._rejoinTimer); this._rejoinTimer = null; }
      this._autoplay = false;
      if (this._autoplayHandler) {
        this.removeListener("queueEnd", this._autoplayHandler);
        this._autoplayHandler = null;
      }
      this.searches.clear();

      this._bridgeStop();
      if (this._audioBridge) {
        this._audioBridge.destroy();
        this._audioBridge = null;
      }
      if (this._voiceConn) {
        try { this._voiceConn.disconnect(); } catch(e) { logger.warn("[Player] voiceConn disconnect in destroy:", e?.message); }
        this._voiceConn = null;
      }
      this.lavalinkPlayer = null;
      this.connection     = null;

      if (this._channelId) {
        try {
          const vm = getVoiceManager(this.client);
          vm.leaveChannel(this._channelId);
        } catch(e) { /* best effort */ }
      }
    } catch (e) {
      logger.error("[Player] destroy error:", e.message);
    }
  }

  /** @type {boolean} Whether the player is currently paused. */
  get paused() { return this._paused; }

  /** Pause current playback. @returns {string} Status message. */
  pause() {
    if (!this._voiceConn || !this.queue.getCurrent())
      return ":negative_squared_cross_mark: There's nothing playing at the moment!";
    if (this._paused)
      return ":negative_squared_cross_mark: Already paused!";

    this._bridgeStop();
    this._paused = true;
    this._pausedAt = Date.now();
    this._pauseTrackEndTimer();
    this.emit("playback", false);
    this._stopInactivityTimer();
    return ":pause_button: Paused";
  }

  /** Resume paused playback. @returns {string} Status message. */
 resume() {
    if (!this._voiceConn || !this.queue.getCurrent())
      return ":negative_squared_cross_mark: There's nothing playing at the moment!";
    if (!this._paused)
      return ":negative_squared_cross_mark: Not paused!";

    if (this._pausedAt) {
      this.startedPlaying += (Date.now() - this._pausedAt);
    }

    this._paused = false;
    this._pausedAt = null;
    this._resumeTrackEndTimer();
    this.emit("playback", true);
    this._stopInactivityTimer();

    const current = this.queue.getCurrent();
    if (current?.url) {
      const elapsedMs = Date.now() - this.startedPlaying;
      this._playTrackViaBridge(current, { seekSeconds: elapsedMs / 1000 }).catch(e =>
        logger.error("[Player] Resume playback error:", e.message)
      );
    }
    return ":arrow_forward: Resumed";
  }

  /** Skip the current track and advance to the next. Emits "trackSkip" with the skipped
   *  track so autoplay (when enabled) can replenish the queue with a new song. @returns {string} Status message. */
  skip() {
    if (!this._voiceConn || !this.queue.getCurrent())
      return ":negative_squared_cross_mark: There's nothing playing at the moment!";
    this._lastPlayedTrack = this.queue.getCurrent();
    this._skipping       = true;
    this._radioAnnounced = false;
    this._activeTrackOpt = null;
    this._clearTrackEndTimer();
    this.queue.current   = null;

    this._bridgeStop();

    this.emit("trackSkip", this._lastPlayedTrack);

    if (this.queue.isEmpty() && !this._wasRadio && !this._queueEndedSent) {
      this._queueEndedSent = true;
      this.emit("queueEnd");
      if (!this._autoplay) {
        const prefix = this._getPrefix?.(this._guildId) ?? "%";
        this.emit("message", { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this._t("responses._common.queueEnded", { prefix }))], system: true });
      }
    }

    this._playingNext = false;
    if (!this.queue.isEmpty() && !this.leaving) {
      this.playNext().catch(e => logger.error("[Player] playNext error:", e.message));
    } else {
      this.emit("stopplay");
      if (!this._is247Enabled()) {
        this._startInactivityTimer();
      }
    }

    this._skipping = false;
    return ":track_next: Skipped";
  }

  /** Skip to a specific position in the queue. @param {number} position - 1-based queue position. @returns {string} Status message. */
  skipTo(position) {
    if (!this._voiceConn || !this.queue.getCurrent())
      return ":negative_squared_cross_mark: There's nothing playing at the moment!";
    const idx = position - 1;
    if (idx < 0 || idx >= this.queue.size())
      return `:negative_squared_cross_mark: Position ${position} out of range (queue has ${this.queue.size()} tracks).`;
    this._lastPlayedTrack = this.queue.getCurrent();
    this.queue.data.splice(0, idx);
    this.queue.current = null;
    this._skipping     = true;

    this._bridgeStop();

    this.emit("trackSkip", this._lastPlayedTrack);

    if (this.queue.isEmpty() && !this._wasRadio && !this._queueEndedSent) {
      this._queueEndedSent = true;
      this.emit("queueEnd");
      if (!this._autoplay) {
        const prefix = this._getPrefix?.(this._guildId) ?? "%";
        this.emit("message", { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this._t("responses._common.queueEnded", { prefix }))], system: true });
      }
    }

    this._playingNext = false;
    if (!this.queue.isEmpty() && !this.leaving) {
      this.playNext().catch(e => logger.error("[Player] playNext error:", e.message));
    } else {
      this.emit("stopplay");
      if (!this._is247Enabled()) {
        this._startInactivityTimer();
      }
    }

    this._skipping = false;
    return `:track_next: Skipped to position ${position}`;
  }

  /** Set the playback volume. @param {number} v - Volume as a decimal (0–2, where 1 = 100%). @returns {string} Status message. */
  setVolume(v) {
    this.preferredVolume = Utils.clamp(v, 0, 2);
    this.emit("volume", this.preferredVolume);
    if (this._voiceConn) {
      this._voiceConn.setVolume(this.preferredVolume * 100);
    }
    if (!this._voiceConn)
      return `Volume set to \`${Math.round(this.preferredVolume * 100)}%\` — will apply when connected.`;
    return `Volume changed to \`${Math.round(this.preferredVolume * 100)}%\`.`;
  }

/** @async Seek to a specific position in the currently playing track. @param {number} ms - Target position in milliseconds. @returns {Promise<boolean>} True if seek succeeded, false otherwise. */
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
  }

/** @async Apply an audio filter to the current playback. Stores filter metadata for dashboard tracking. @param {object} filterPayload - The filter configuration payload. @param {object|null} [filterMeta=null] - Human-readable filter metadata (name, etc.). @returns {Promise<{ok: boolean, reason?: string, pending?: boolean}>} Result indicating success or failure reason. */
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

    try {
      return { ok: true };
    } catch (e) {
      const errMsg = e.message ?? "";
      return { ok: false, reason: errMsg };
    }
  }

  /** Clear any active audio filter. */
  clearFilter() {
    this.activeFilter = null;
    this.activeFilterPayload = null;
    this.emit("filter", null);
    logger.warn("[Player] clearFilter: filters not supported in LiveKit mode");
  }

  /** @returns {boolean} Whether the queue is empty. */
  isEmpty()           { return this.queue.isEmpty(); }

  /** Add a track to the queue with optional top-insert. @param {object} d - Track data. @param {boolean} [t=false] - Insert at the top of the queue. */
  addToQueue(d, t)    {
    if (this.queue.data.length >= this._maxQueueSize) {
      logger.warn(`[Player] Queue size cap reached (${this._maxQueueSize}) — dropping oldest track`);
      this.queue.data.shift();
    }
    this.queue.add(d, t);
    this.emit("update", "queue");
    this._stopInactivityTimer();
  }

  /** Clear the queue and start inactivity timer if nothing is playing. */
  clear()             {
    this.queue.clear();
    this.emit("update", "queue");
    if (!this.queue.getCurrent()) {
      this._startInactivityTimer();
    }
  }

  /** Add multiple tracks to the queue. @param {Array} t - Track data array. @param {boolean} [top=false] - Insert at the top. @returns {number} Number of tracks added. */
  addManyToQueue(t, top = false) {
    if (!Array.isArray(t)) return 0;
    const overflow = (this.queue.data.length + t.length) - this._maxQueueSize;
    if (overflow > 0) {
      logger.warn(`[Player] Queue size cap (${this._maxQueueSize}) — dropping ${overflow} oldest tracks`);
      this.queue.data.splice(0, overflow);
    }
    const added = this.queue.addMany(t, top);
    this.emit("update", "queue");
    this._stopInactivityTimer();
    return added;
  }

  /** Shuffle the queue. @returns {string} Status message. */
  shuffle() {
    if (this.isEmpty()) return "There is nothing to shuffle in the queue.";
    this.queue.shuffle();
    this.emit("update", "queue");
    return ":twisted_rightwards_arrows: Shuffled queue";
  }

  /** Move a track from one position to another (1-based indices). @param {number} from - Source position (1-based). @param {number} to - Destination position (1-based). @returns {string} Result message. */
  move(from, to) {
    if (this.queue.size() === 0) return "The queue is empty.";
    return this.queue.move(from - 1, to - 1);
  }

  /** Toggle a loop mode. @param {"song"|"queue"} choice @returns {string} */
  loop(choice) {
    if (!["song", "queue"].includes(choice))
      return `'${choice}' is not valid. Use \`song\` or \`queue\``;
    const state = this.queue.toggleLoop(choice);
    const name  = choice.charAt(0).toUpperCase() + choice.slice(1);
    return state
        ? `:repeat: ${name} loop activated`
        : `:arrow_right: ${name} loop disabled`;
  }

  /** Remove a track from the queue by index. @param {number} index - 0-based. @returns {string} @throws {Error} If index is empty. */
  remove(index) {
    if (index === undefined || index === null) throw new Error("Index can't be empty");
    const oldSize = this.queue.size();
    const msg = this.queue.remove(index);
    if (oldSize !== this.queue.size()) this.emit("update", "queue");

    if (this.isEmpty() && !this.queue.getCurrent()) {
      this._startInactivityTimer();
    }
    return msg;
  }

  /** @private @param {number} [length=15] @returns {string} */
  _createProgressBar(length = 15) {
    const current = this.queue.getCurrent();
    if (!current?.duration || !this.startedPlaying) {
      const total = this._getTrackDurationMs(current);
      if (total > 0) {
        return `${Utils.progressBar(0, total, length)} \`0:00 / ${Utils.prettifyMS(total)}\``;
      }
      return Utils.progressBar(0, 1, length);
    }

    const totalMs = this._getTrackDurationMs(current);
    let elapsed = Date.now() - this.startedPlaying;
    if (this._paused && this._pausedAt) {
      elapsed = this._pausedAt - this.startedPlaying;
    }

    if (totalMs > 0 && elapsed > totalMs) elapsed = totalMs;
    elapsed = Math.max(0, elapsed);

    const bar     = Utils.progressBar(elapsed, totalMs, length);
    const timeNow = Utils.prettifyMS(elapsed);
    const total   = Utils.prettifyMS(totalMs);
    return `${bar} \`${timeNow} / ${total}\``;
  }

  /** @returns {string} Formatted name of the currently playing track. */
  getCurrent() {
    const c = this.queue.getCurrent();
    if (!c) return "There's nothing playing at the moment.";
    return this.getVideoName(c);
  }

  /** Format a track object into a display name. @param {object} vid @param {boolean} [code=false] @returns {string} */
  getVideoName(vid, code = false) {
    if (!vid) return "Unknown";
    if (vid.type === "radio") {
      return code
          ? `[Radio]: ${vid.title} - ${vid.author?.url || ""}`
          : `[Radio] [${vid.title} by ${vid.author?.name || "Unknown"}](${vid.author?.url || ""})`;
    }
    if (vid.type === "external" || vid.type === "stream") {
      return code
          ? `${vid.title} - ${vid.url}`
          : `[${vid.title}](${vid.url})`;
    }
    const elapsed = this.getCurrentElapsedDuration();
    const total   = this.getDuration(vid.duration);
    const link    = vid.spotifyUrl || vid.url || "";
    return code
        ? `${vid.title} (${elapsed}/${total})${link ? " - " + link : ""}`
        : `[${vid.title} (${elapsed}/${total})]${link ? "(" + link + ")" : ""}`;
  }

  /** @returns {string} Human-readable total remaining time for all queued tracks. */
  getQueueRemainingTime() {
    let totalMs  = 0;
    const current = this.queue.getCurrent();
    if (current?.duration && this.startedPlaying) {
      const totalMsCurrent = this._getTrackDurationMs(current);
      let elapsed = Date.now() - this.startedPlaying;
      if (this._paused && this._pausedAt) {
        elapsed = this._pausedAt - this.startedPlaying;
      }
      totalMs += Math.max(0, totalMsCurrent - elapsed);
    }
    for (const track of this.queue.data) {
      totalMs += this._getTrackDurationMs(track);
    }
    return Utils.prettifyMS(totalMs);
  }

  /** @returns {string} Elapsed time of the current track. */
  getCurrentElapsedDuration() {
    if (!this.startedPlaying) return "0:00";
    const current = this.queue.getCurrent();
    const totalMs = this._getTrackDurationMs(current);

    let elapsed = Date.now() - this.startedPlaying;
    if (this._paused && this._pausedAt) {
      elapsed = this._pausedAt - this.startedPlaying;
    }

    if (totalMs > 0 && elapsed > totalMs) elapsed = totalMs;
    return Utils.prettifyMS(Math.max(0, elapsed));
  }

  /** Generate a text-based queue listing. @param {number} [page=1] @param {number} [pageSize=10] @returns {string} */
  list(page = 1, pageSize = 10) {
    const current = this.queue.getCurrent();
    const total   = this.queue.size();
    let text = "";
    if (current) {
      const remaining = this.getQueueRemainingTime();
      text += `🎧 **Queue**\n`;
      text += `**${total} tracks** • ⏱️ ${remaining}\n`;
      text += `${this._createProgressBar()}\n\n`;
      text += `🎵 **Now Playing**\n`;
      text += `${this.getVideoName(current)}\n\n`;
    }
    if (total === 0) { if (!current) text += "--- Empty ---"; return text; }
    const { items, page: pg, totalPages, start } = this.queue.getPage(page, pageSize);
    items.forEach((vid, i) => {
      const index = String(start + i + 1).padStart(2, " ");
      const name  = this.getVideoName({ ...vid, title: Utils.truncate(vid.title, 60) });
      text += `\`${index}.\` ${name}\n`;
    });
    text += `\nPage ${pg}/${totalPages} • Loop: ${this.queue.loop ? "🟢" : "🔴"}`;
    return text;
  }

/** @async Build a now-playing info object for the current track, including progress bar, volume, and loop states. @returns {Promise<object>} Object with msg (description string) and optional image URL. */
  async nowPlaying() {
    const current = this.queue.getCurrent();
    if (!current) return { msg: "There's nothing playing at the moment." };

    const loopqueue = this.queue.loop     ? "🔄" : "⏹️";
    const songloop  = this.queue.songLoop ? "🔂" : "⏹️";
    const vol       = `${Math.round((this.preferredVolume || 1) * 100)}%`;
    const autoplay  = this._autoplay ? "🔁" : "⏹️";

    const vcLine = this._channelId ? `🔊 <#${this._channelId}>\n` : "";

    if (current.type === "radio") {
      try {
        const data = await meta(current.url);
        return {
          msg: `${vcLine}📻 **[${current.title}](${current.author?.url || current.url})**\n${current.description || ""}\n\n🎵 Now playing: ${data?.title || "Unknown"}\n\n🔉 ${vol} │ ${loopqueue} Queue │ ${songloop} Song │ ${autoplay} Autoplay`,
          image: current.thumbnail
        };
      } catch (e) {
          logger.warn("[Player] Error:", e?.message);
          return {
          msg: `${vcLine}📻 **[${current.title}](${current.author?.url || current.url})**\n\n🔉 ${vol} │ ${loopqueue} Queue │ ${songloop} Song │ ${autoplay} Autoplay`,
          image: current.thumbnail
        };
      }
    }

    if (current.type === "external" || current.type === "stream") {
      const totalMs = this._getTrackDurationMs(current);
      let progressLine = "";

      if (totalMs > 0) {
        progressLine = `\n${this._createProgressBar(20)}`;
      }
      return {
        msg: `${vcLine}🎵 **[${current.title}](${current.url})** by ${current.artist || "Unknown"}${progressLine}\n\n🔉 ${vol} │ ${loopqueue} Queue │ ${songloop} Song │ ${autoplay} Autoplay`,
        image: current.thumbnail
      };
    }

    const progressBar = this._createProgressBar(20);
    let trackOptLine = "";
    if (this._activeTrackOpt) {
      const optStart = Utils.prettifyMS(this._activeTrackOpt.startMs);
      const optEnd = this._activeTrackOpt.endMs > 0 ? Utils.prettifyMS(this._activeTrackOpt.endMs) : "end";
      trackOptLine = `\n✂️ Custom: ${optStart} → ${optEnd}`;
    }
    return {
      msg: `${vcLine}🎵 **[${current.title}](${current.spotifyUrl || current.url})**\n${progressBar}${trackOptLine}\n\n🔉 ${vol} │ ${loopqueue} Queue │ ${songloop} Song │ ${autoplay} Autoplay`,
      image: current.thumbnail
    };
  }

/** @async Get the thumbnail of the currently playing track. @returns {Promise<{msg: string, image: string|null}>} Object with description message and image URL or null. */
  async getThumbnail() {
    const current = this.queue.getCurrent();
    if (!current) return { msg: "There's nothing playing at the moment.", image: null };
    if (!current.thumbnail) return { msg: "No thumbnail available.", image: null };
    return { msg: `Thumbnail of [${current.title}](${current.url}):`, image: current.thumbnail };
  }

  /** Format a track duration from various shapes. @param {*} duration @returns {string} */
  getDuration(duration) {
    if (typeof duration === "object" && duration?.timestamp) return duration.timestamp;
    if (typeof duration === "object" && duration?.seconds  != null) return Utils.formatSeconds(duration.seconds);
    if (typeof duration === "string" && duration.startsWith("PT")) return Utils.prettifyMS(Utils.parseISODuration(duration));
    return Utils.prettifyMS(duration);
  }

  /** @returns {string} Formatted duration of the currently playing track. */
  getCurrentDuration() {
    const current = this.queue.getCurrent();
    if (!current?.duration) return "?:??";
    return this.getDuration(current.duration);
  }

  /** @private Translate a locale key. @param {string} key @param {object} [replacements={}] @returns {string} */
  _t(key, replacements = {}) {
    if (!this.locale) return key;
    return this.locale.translate(this._guildId, key, replacements);
  }

  /** Emit a now-playing announcement for the given track. @param {object} s */
  announceSong(s) {
    if (!s) return;

    if (s.type === "radio") {
      this.emit("message", { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this._t("responses.radio.nowPlaying", {
        title:  Utils.escapeMarkdown(s.title),
        author: s.author?.name || "Unknown",
        url:    s.author?.url || "",
        channel: this._channelId || "",
      }))] });
      return;
    }
    const author = s.artists
        ? s.artists.map(a => a.url ? `[${a.name}](${a.url})` : a.name).join(" & ")
        : s.author?.url
            ? `[${s.author.name}](${s.author.url})`
            : s.author?.name || null;

    if (!author && (s.type === "external" || s.type === "stream")) {
      const desc = "🎵 Now playing [" + Utils.escapeMarkdown(s.title) + "](" + (s.url || "") + ") in <#" + (this._channelId || "") + ">";
      this.emit("message", { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(desc)] });
      return;
    }

    this.emit("message", { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this._t("responses.play.nowPlaying", {
      title:   Utils.escapeMarkdown(s.title),
      url:     s.spotifyUrl || s.url,
      author:  author || "Unknown",
      channel: this._channelId || "",
    }))] });
  }


  /** @async Resolve a free-text query or URL to track data via Lavalink, for internal consumers (autoplay, Last.fm).
   *  URL queries are loaded directly (like play()) instead of being prefixed with a search
   *  source, so playlist/mix URLs resolve to their full track lists. @param {{query: string, provider?: string, trackMeta?: object}} opts - Query, optional provider key, optional track metadata to attach. @returns {Promise<{type: "video"|"list"|"error", data?: object}|null>} Resolved track shape, or null on failure. */
  async generalQuery({ query, provider = "yt", trackMeta = null }) {
    try {
      if (!this._lavalink) return { type: "error", data: "Audio node not ready." };
      await this._lavalink.waitForNode({ timeoutMs: 15_000 });
      const isUrl = typeof query === "string" && Utils.isValidUrl(query);
      const result = isUrl
        ? await this._lavalink.search(query)
        : await this._lavalink.search(query, { source: this._getSource(provider) });
      const tracks = (result?.tracks ?? []).map(t => this._lcTrackToVideo(t, trackMeta)).filter(Boolean);
      if (!tracks.length) return null;
      return tracks.length === 1 ? { type: "video", data: tracks[0] } : { type: "list", data: tracks };
    } catch (err) {
      logger.warn("[Player] generalQuery failed:", err?.message);
      return { type: "error", data: err?.message ?? String(err) };
    }
  }

/** @async Search for tracks via Lavalink and store results for interactive selection. @param {string} query - The search query string. @param {string} id - A unique key to identify this search session (e.g. message ID). @param {string} [provider="ytm"] - The search provider key. @returns {Promise<{m: string, count: number}>} Object with formatted result list message and track count. */
  async fetchResults(query, id, provider = "ytm") {
    try {
      if (!this._lavalink) return { m: "Audio node not ready.", count: 0 };

      await this._lavalink.waitForNode({ timeoutMs: 15_000 });

      const source = this._getSource(provider);
      const result = await this._lavalink.search(query, { source });
      const lcTracks = result?.tracks ?? [];

      const results = lcTracks.slice(0, this.resultLimit).map(t => this._lcTrackToVideo(t)).filter(Boolean);

      let list = "Search results using **" + (PROVIDER_NAMES[provider] || "YouTube Music") + "**:\n\n";
      results.forEach((v, i) => {
        const url   = v.url || "";
        const title = v.title || Utils.formatTrackInfo(v, false);
        const dur   = v.duration ? this.getDuration(v.duration) : "?:??";
        list += (i + 1) + ". [" + title + "](" + url + ") - " + dur + "\n";
      });
      list += "\nSend the number of the result. Example: `2`\nSend 'x' to cancel.";

      if (this.searches.size >= this._searchMaxSize) {
        const oldestKey = this.searches.keys().next().value;
        if (oldestKey !== undefined) this.searches.delete(oldestKey);
      }
      this.searches.set(id, results);

      return { m: list, count: results.length };
    } catch (err) {
      return { m: "Error searching: " + err.message, count: 0 };
    }
  }

  /** Select a search result and add it to the queue. @param {string} id @param {number} [result=0] @param {boolean} [next=false] @returns {object|null} */
  playResult(id, result = 0, next = false) {
    if (!this.searches.has(id)) return null;
    const searchResults = this.searches.get(id);
    if (!searchResults || !searchResults[result]) return null;

    const res = searchResults[result];
    this.addToQueue(res, next);

    this.searches.delete(id);

    if (!this.queue.getCurrent()) {
      this.playNext().catch(e => logger.error("[Player] playNext error:", e.message));
    }
    return res;
  }

  /** Search and add a track to the top of the queue. @returns {EventEmitter} */
  playFirst(query, provider, trackMeta) { return this.play(query, true, provider, trackMeta); }

  /** @private Convert a Lavalink track to internal format. @param {object} track @param {object|null} [trackMeta=null] @returns {object|null} */
  _lcTrackToVideo(track, trackMeta = null) {
    if (!track || typeof track !== "object") return null;
    const info = track.info ?? track ?? {};

    let ms = info.length ?? track.length ?? info.durationMs ?? 0;
    if (ms === 0 && info.duration != null) {
      if (typeof info.duration === "number") {
        ms = info.duration;
      } else if (typeof info.duration === "object" && info.duration.seconds != null) {
        ms = info.duration.seconds * 1000;
      }
    }

      let trackUri = info.uri ?? ("https://www.youtube.com/watch?v=" + (info.identifier || ""));
      if (typeof trackUri === 'string' && trackUri.includes('music.youtube.com')) {
        trackUri = trackUri.replace('music.youtube.com', 'www.youtube.com');
      }
      const video = {
      videoId:    info.identifier ?? "",
      encoded:    track.encoded ?? info.encoded ?? "",
      sourceName: info.sourceName ?? "unknown",
      title:      Utils.cleanTitle(info.title ?? "Unknown"),
      url:        trackUri,
      thumbnail:  info.artworkUrl ?? null,
      spotifyUrl: null,
      _durationMs: ms,
      duration: {
        timestamp: Utils.prettifyMS(ms),
        seconds:   Math.floor(ms / 1000),
      },
      author: {
        name: info.author ?? "Unknown",
        url:  info.uri    ?? null,
      },
      artists: null,
    };
    if (trackMeta) {
      video.artist          = trackMeta.artist ?? null;
      video.requestedArtist = trackMeta.artist ?? null;
      video.requestedTitle  = trackMeta.name ?? trackMeta.title ?? null;
      video.lastfm = {
        source: trackMeta.source ?? "lastfm",
        artist: trackMeta.artist ?? null,
        name:   trackMeta.name ?? trackMeta.title ?? null,
        url:    trackMeta.url ?? "",
      };
    }
    return video;
  }

  /** @private Resolve a provider key to a Lavalink search prefix. @param {string} provider @returns {string} */
  _getSource(provider) {
    return PROVIDERS[provider]?.prefix ?? (provider + "search");
  }

  /** Search for a track and add it to the queue. @param {string} query @param {boolean} [top=false] @param {string} [provider] @param {object} [trackMeta=null] @returns {EventEmitter} */
  play(query, top = false, provider, trackMeta = null) {
    const events = new EventEmitter();
    const source = this._getSource(provider || "ytm");
    const isUrl  = Utils.isValidUrl(query);

    (async () => {
      try {
        if (!this._lavalink) {
          events.emit("message", "Audio node not ready yet.");
          return;
        }

        await this._lavalink.waitForNode({ timeoutMs: 15_000 });

        events.emit("message", "Searching...");

        let result;
        if (isUrl) {
          result = await this._lavalink.search(query);
        } else {
          result = await this._lavalink.search(query, { source });
        }
        const lcTracks = result?.tracks ?? [];

        if (lcTracks.length === 0) {
          if (!isUrl && source !== "ytmsearch") {
            events.emit("message", "No results from primary source, trying YouTube Music...");
            const fallback = await this._lavalink.search(query, { source: "ytmsearch" });
            if (fallback?.tracks?.length > 0) {
              const video = this._lcTrackToVideo(fallback.tracks[0], trackMeta);
              if (video) {
                this.addToQueue(video, top);
                events.emit("message", "Successfully added [" + video.title + "](" + video.url + ") to the queue.");
                if (!this.queue.getCurrent()) {
                  this.playNext().catch(e => logger.error("[Player] playNext error:", e.message));
                }
                return;
              }
            }
          }
          events.emit("message", "**No results found for '" + query + "'.**");
          return;
        }

        const firstTrack = lcTracks[0];
        if (isUrl && lcTracks.length > 1) {
          const videos = lcTracks.map(t => this._lcTrackToVideo(t, trackMeta)).filter(Boolean);
          this.addManyToQueue(videos, top);
          events.emit("message", "Successfully added **" + videos.length + "** songs to the queue.");
        } else {
          const video = this._lcTrackToVideo(firstTrack, trackMeta);
          if (video) {
            this.addToQueue(video, top);
            events.emit("message", "Successfully added [" + video.title + "](" + video.url + ") to the queue.");
          } else {
            events.emit("message", "**Failed to parse track data.**");
            return;
          }
        }

        if (!this.queue.getCurrent()) {
          this.playNext().catch(e => logger.error("[Player] playNext error:", e.message));
        }
      } catch (err) {
        logger.error("[Player] play() search error:", err?.message);
        events.emit("message", err?.message || "An error occurred while loading the track.");
      }
    })();

    return events;
  }

/** @async Search for tracks via Lavalink and return raw track results. @param {string} query - The search query string. @param {string} [provider="ytm"] - The search provider key. @returns {Promise<Array<object>>} Array of raw Lavalink track objects, or empty array on error. */
  async search(query, provider = 'ytm') {
    if (!this._lavalink) return [];
    try {
      const source = this._getSource(provider);
      const result = await this._lavalink.search(query, { source });
      return result.tracks || [];
    } catch (e) {
      logger.error(`[Player] lavalink search error:`, e?.message);
      return [];
    }
  }

  /** @private Build a radio-type track object. @param {object} radio @returns {object} */
  _buildRadioTrack(radio) {
    return {
      type:        "radio",
      title:       radio.detailedName || radio.title || "Unknown Radio",
      description: Utils.truncate(radio.description || "", 200),
      url:         radio.url,
      author: {
        name: radio.author?.name || "Unknown",
        url:  radio.author?.url  || radio.url,
      },
      thumbnail: radio.thumbnail ?? null,
    };
  }

  /** Add a radio stream to the queue. @param {object} radio @param {boolean} [top=false] */
  playRadio(radio, top = false) {
    if (!radio?.url) { logger.error("[Player] Invalid radio data"); return; }
    this.addToQueue(this._buildRadioTrack(radio), top);
    if (!this.queue.getCurrent()) this.playNext().catch(e => logger.error("[Player] playNext error:", e.message));
  }

/** @async Switch to a different radio stream, replacing any current radio tracks. @param {object} radio - Radio object with url, title, author, and thumbnail. @returns {Promise<void>} */
  async switchRadio(radio) {
    if (!radio?.url) { logger.error("[Player] switchRadio: invalid radio data"); return; }

    const newTrack = this._buildRadioTrack(radio);
    this.queue.data = this.queue.data.filter(t => t.type !== "radio");

    if (!this.queue.getCurrent()) {
      this.queue.add(newTrack);
      this.playNext().catch(e => logger.error("[Player] playNext error:", e.message));
      return;
    }

    this.queue.data.unshift(newTrack);
    this._skipping       = true;
    this._radioAnnounced = false;
    this.queue.current   = null;
    this._bridgeStop();
    this._playingNext = false;
    this._skipping    = false;
    if (!this.leaving) this.playNext().catch(e => logger.error("[Player] playNext error:", e.message));
  }

  /** @private Build a direct-URL track object. @param {string} url @param {string} [title] @param {string} [artist] @param {string} [trackType="external"] @returns {object} */
  _buildExternalTrack(url, title = null, artist = null, trackType = "external") {
    const displayTitle = title || this._extractFilenameFromUrl(url);
    return {
      type:      trackType,
      title:     displayTitle,
      url:       url,
      artist:    artist || null,
      thumbnail: null,
    };
  }

  /** @private Extract a display filename from a URL. @param {string} url @returns {string} */
  _extractFilenameFromUrl(url) {
    try {
      const pathname = new URL(url).pathname;
      const filename = pathname.split("/").pop();
      if (filename && filename.includes(".")) {
        return decodeURIComponent(filename.replace(/\.[^.]+$/, "")) || "Stream";
      }
    } catch (_) {}
    return "External Stream";
  }

  /**
   * Play a direct audio URL (MP3, OGG, AAC, stream, etc.) without Lavalink search.
   * The bridge handles decoding via Lavalink if needed. No FFmpeg required.
   * @param {string} url - Direct HTTP(S) audio URL.
   * @param {string} [title] - Optional display title.
   * @param {string} [artist] - Optional artist name.
   * @param {boolean} [top=false] - Insert at top of queue.
   * @param {string} [trackType="external"] - Track type: "external" (no pre-resolve) or "stream" (Lavalink pre-resolve).
   * @returns {EventEmitter} Emitter that emits "message" events with status strings.
   */
  playExternal(url, title = null, artist = null, top = false, trackType = "external") {
    const events = new EventEmitter();

    (async () => {
      try {
        const track = this._buildExternalTrack(url, title, artist, trackType);
        this.addToQueue(track, top);
        events.emit("message", "Added **[" + track.title + "](" + url + ")** to the queue.");

        if (!this.queue.getCurrent()) {
          this.playNext().catch(e => {
            logger.error("[Player] playExternal playNext error:", e.message);
            events.emit("message", "Error playing stream: " + e.message);
          });
        }
      } catch (err) {
        logger.error("[Player] playExternal error:", err?.message);
        events.emit("message", "Error: " + (err?.message || "Failed to add external stream."));
      }
    })();

    return events;
  }

  /** @private @async Advance to the next track. Guarded against overlapping runs: a
   *  generation counter ensures an older run's cleanup never clears the in-flight
   * flag of a newer run (which previously allowed double-advances). */
  async playNext() {
    if (this._playingNext) return;
    this._playingNext = true;
    const generation = (this._playNextGeneration = (this._playNextGeneration ?? 0) + 1);
    try { await this._doPlayNext(); }
    finally { if (generation === this._playNextGeneration) this._playingNext = false; }
  }

  /** @private @async Core logic for advancing to the next track. */
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
  }

  /** @private @async Play a track through the FluxerAudioBridge. For radio/external tracks
   * without an encoded payload, attempts Lavalink URL resolution first so MP3/AAC
   * streams can use the loadstream pipeline instead of the limited direct-URL path.
   * @param {object} songData @param {object} [options={}] @returns {Promise<void>} */
  async _playTrackViaBridge(songData, options = {}) {
    if (!this._voiceConn || !this._audioBridge) {
      throw new Error("No voice connection or audio bridge available");
    }
    if (!songData?.encoded && !songData?.url) {
      throw new Error("No encoded track or URL for: " + (songData?.title ?? "unknown"));
    }

    if (!songData.encoded && songData.url && songData.url.startsWith("http") && this._lavalink && songData.type !== "external") {
      try {
        const nlInfo = this._lavalink.getNodeLinkInfo?.();
        if (nlInfo) {
          const protocol = nlInfo.secure ? "https" : "http";
          const baseUrl = protocol + "://" + nlInfo.host + ":" + nlInfo.port;
          const headers = { "Authorization": nlInfo.password };
          if (nlInfo.sessionId) headers["Session-Id"] = nlInfo.sessionId;
          if (this._guildId) headers["Guild-Id"] = this._guildId;

          const loadtracksUrl = baseUrl + "/v4/loadtracks?identifier=" + encodeURIComponent(songData.url);
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
      url:     songData.url,
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
  }

  /** @private @type {Timeout|null} */
  _trackEndTimer = null;
  /** @private @type {number|null} */
  _trackEndRemainingMs = null;

  /** @private Handle when a track option's end time is reached. @param {object} match */
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
  }

  /** @private Clear the track-end timer. */
  _clearTrackEndTimer() {
    if (this._trackEndTimer) {
      clearTimeout(this._trackEndTimer);
      this._trackEndTimer = null;
    }
    this._trackEndRemainingMs = null;
  }

  /** @private Pause the track-end timer, saving remaining time. */
  _pauseTrackEndTimer() {
    if (!this._trackEndTimer || !this._activeTrackOpt || this._activeTrackOpt.endMs <= 0) return;
    clearTimeout(this._trackEndTimer);
    const elapsedMs = Date.now() - this.startedPlaying;
    this._trackEndRemainingMs = Math.max(0, this._activeTrackOpt.endMs - elapsedMs);
    this._trackEndTimer = null;
  }

  /** @private Resume the track-end timer. */
  _resumeTrackEndTimer() {
    if (this._trackEndRemainingMs == null || this._trackEndRemainingMs <= 0 || !this._activeTrackOpt || this._activeTrackOpt.endMs <= 0) {
      this._trackEndRemainingMs = null;
      return;
    }
    const remainingMs = this._trackEndRemainingMs;
    const match = this._activeTrackOpt;
    this._trackEndTimer = setTimeout(() => this._onTrackEndTimeReached(match), remainingMs);
    this._trackEndRemainingMs = null;
  }

  /** @private Recalculate and restart the track-end timer. */
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
  }

  /** @private @async Look up per-user track options. @param {object} songData @returns {Promise<object|null>} */
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
  }

  /** @private @async Auto-seek to a track options start position. @param {object} match */
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
  }

/** @async Apply a track options match (custom start/end times) to the currently playing track. Seeks to the start position and sets a timer for the end position. @param {object} match - Track options match with startMs and optional endMs. @returns {Promise<boolean>} True if applied successfully, false otherwise. */
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
  }

/** @async Fetch lyrics for the currently playing track via Lavalink REST API. @returns {Promise<{text: string, source: string, synced: boolean, lines: Array}|null>} Lyrics object with text, source, synced flag, and lines array, or null if unavailable. */
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
  }
}
