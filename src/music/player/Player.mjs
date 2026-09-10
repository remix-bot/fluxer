/**
 * @module src/music/player/Player
 * @description Per-channel music player: voice connection lifecycle (join /
 * leave / destroy / rejoin), playback controls (pause, resume, skip, seek,
 * volume, filters), queue operations, 24/7 mode helpers and the inactivity
 * timer. Playback advancement, search and display rendering live in the
 * playback/search/display mixin modules applied at the bottom of this file.
 */

import { getVoiceManager } from "@fluxerjs/voice";
import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../../ui/index.mjs";
import { Utils, cleanId } from "../../utils/Utils.mjs";
import { logger } from "../../core/Logger.mjs";
import { get247ChannelMode, detachPlayerFromManager } from "../../utils/Helpers247.mjs";
import { hasHumansInChannel } from "../../voice/VoiceStateResolver.mjs";
import { FluxerAudioBridge } from "../audio/FluxerAudioBridge.mjs";
import { applyMixins } from "../../utils/mixins.mjs";
import { Queue } from "./Queue.mjs";
import PlaybackMixin from "./PlaybackMixin.mjs";
import SearchMixin from "./SearchMixin.mjs";
import DisplayMixin from "./DisplayMixin.mjs";

/**
 * @class Player
 * @description Main music player class. Manages voice connections, playback,
 * queue, filters, and search.
 * @extends {EventEmitter}
 *
 * Events:
 * - `"queue"` — queue mutation (proxied from the Queue)
 * - `"message"` — announcements `{ embeds: [...] }` (or a plain string)
 * - `"startplay"` / `"stopplay"` / `"queueEnd"` / `"trackSkip"`
 * - `"playback"` (paused state boolean), `"volume"`, `"filter"`
 * - `"autoleave"`, `"leave"`, `"roomfetched"`
 */
class Player extends EventEmitter {
  /** @private @type {object|null} The LiveKit voice connection. */
  _voiceConn         = null;
  /** @private @type {FluxerAudioBridge|null} */
  _audioBridge       = null;
  lavalinkPlayer     = null;
  /** @type {object|null} Alias of _voiceConn (kept for dashboard/debug compat). */
  connection         = null;
  /** @private @type {string|null} */
  _guildId           = null;
  /** @private @type {string|null} */
  _channelId         = null;
  /** @private @type {number|null} */
  _lastConnectedAt   = null;
  /** @private @type {string|null} The home channel of a 24/7 spawn. */
  _home247Channel    = null;

  /** @type {Queue} */
  queue        = null;
  client       = null;
  settings     = null;
  config       = {};

  /** @type {import('../LavalinkManager.mjs').LavalinkManager|null} */
  _lavalink    = null;

  leaving           = false;
  _paused           = false;
  _pausedAt         = null;
  _playingNext      = false;
  startedPlaying    = null;
  /** @type {Map<string, Array>} Search sessions by key. */
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

  /** @type {number} Default inactivity timeout before auto-leave. */
  static INACTIVITY_DEFAULT_MS = 3 * 60 * 1000;
  /** @type {number} Track is considered finished past this ratio. */
  static TRACK_MOSTLY_FINISHED_RATIO = 0.85;
  /** @type {number} Or when less than this much time remains. */
  static TRACK_MOSTLY_FINISHED_FLOOR_MS = 15_000;
  /** @type {number} Hard radio safety timeout. */
  static RADIO_SAFETY_TIMEOUT_MS = 20 * 60 * 1000;

  /** @private @type {Timeout|null} */
  _inactivityTimer     = null;
  /** @private @type {number} */
  _inactivityLimit = Player.INACTIVITY_DEFAULT_MS;
  /** @private @type {boolean} */
  _pendingInactivityCheck = false;

  /** @private @type {boolean} */
  _isJoining           = false;
  /** @private @type {boolean} */
  _destroyed           = false;

  /**
   * @param {string} token - Bot authentication token (used internally).
   * @param {object} [opts={}] - Player configuration options.
   * @param {import('@fluxerjs/core').Client} [opts.client]
   * @param {object} [opts.config]
   * @param {import('../LavalinkManager.mjs').LavalinkManager} [opts.lavalink]
   * @param {import('../../db/Settings.mjs').RemoteSettingsManager} [opts.settingsMgr]
   * @param {Function} [opts.getPrefix]
   * @param {import('../../voice/VoiceStateCache.mjs').VoiceStateCache} [opts.observedVoiceUsers]
   * @param {import('../../voice/VoiceStateCache.mjs').VoiceStateCache} [opts.voiceCache]
   * @param {import('../../core/Locale.mjs').Locale} [opts.locale]
   * @param {import('../../services/TrackOptionsManager.mjs').TrackOptionsManager} [opts.trackOptions]
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
   * Check whether 24/7 mode is active for this player's current channel.
   * @returns {boolean} True if 24/7 is enabled.
   */
  _is247Enabled() {
    return this._get247Mode() !== "off";
  }

  /**
   * Resolve the 24/7 mode for this player's current or home channel by
   * consulting the guild's stay_247 setting.
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

  /** @private @returns {boolean} Whether there are non-bot users in the channel. */
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
   * Start the inactivity timer. Skipped when 24/7 is active, the queue has
   * songs, or humans are present. The timer callback re-checks all
   * conditions before emitting autoleave.
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

  /** Clear the inactivity timer if running. */
  _stopInactivityTimer() {
    this._pendingInactivityCheck = false;
    if (this._inactivityTimer) {
      logger.inactivity(`[Player] Stopping inactivity timer for guild ${this._guildId}`);
      clearTimeout(this._inactivityTimer);
      this._inactivityTimer = null;
    }
  }

  /**
   * 24/7 serverLeave recovery: remove this (now connection-less) player
   * from every manager index, schedule a BOT-LEVEL rejoin, notify listeners,
   * and destroy the player.
   *
   * Why bot-level: the old design kept the rejoin timer on the dying player
   * (`this._rejoinTimer`), so `destroy()` — which cleared that timer — and
   * the rejoin scheduler fought each other; and when the player survived,
   * `_rejoinChannel` skipped the rejoin because the zombie was still in the
   * playerMap. Either way the channel never came back. The rejoin now lives
   * on the Remix context (`ctx.schedule247Rejoin`), which survives this
   * instance's destruction.
   *
   * @param {string} channelId - The 24/7 channel to rejoin.
   * @param {string} guildId - The guild ID.
   * @private
   */
  _detachAndSchedule247Rejoin(channelId, guildId) {
    const ctx = this.client?._remix;
    if (typeof ctx?.schedule247Rejoin !== "function") {
      logger.warn(`[Player] No bot-level rejoin scheduler for ${channelId} — falling back to autoleave`);
      this.emit("autoleave");
      return;
    }

    detachPlayerFromManager(ctx, this, channelId);

    ctx.schedule247Rejoin(channelId, guildId);

    this.emit("autoleave");

    this.destroy();
  }

  /**
   * @private Low-level HTTP(S) request helper with redirects and JSON parsing.
   * Used for Lavalink REST calls (pre-resolve, loadtracks).
   * @param {string} url
   * @param {object} [options={}]
   * @param {boolean} [returnStream=false]
   * @returns {Promise<object|null|import('node:stream').Readable>}
   */
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

  /**
   * @async Join a voice channel via LiveKit. Sets up voice connection, event
   * listeners, and resumes playback if the queue has tracks.
   * @param {string} channelId - The voice channel ID to join.
   * @returns {Promise<void>}
   * @throws {Error} If the channel is not found, VoiceManager is unavailable, or connection fails.
   */
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

      this._assertSelfDeaf(vm, channelId);

      if (typeof voiceConn.on === "function") {
        voiceConn.on("requestVoiceStateSync", () => {
          if (this.leaving || this._destroyed) return;
          this._assertSelfDeaf(vm, channelId);
        });

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

          if (mode === "on" && cId && gId) {
            logger.player("[Player] serverLeave in 24/7 mode — detaching and scheduling rejoin");
            this._detachAndSchedule247Rejoin(cId, gId);
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

  /**
   * @async Leave the current voice channel. Stops playback, resets state, and
   * cleans up the voice connection.
   * @returns {Promise<boolean>} True if leave was successful, false otherwise.
   */
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

  /**
   * Fully destroy this player instance: clean up timers, listeners,
   * connections, and resources.
   */
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

  /**
   * Pause current playback.
   * @returns {string} Status message.
   */
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

  /**
   * Resume paused playback.
   * @returns {string} Status message.
   */
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

  /**
   * Skip the current track and advance to the next. Emits "trackSkip" with
   * the skipped track so autoplay (when enabled) can replenish the queue.
   * @returns {string} Status message.
   */
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

  /**
   * Skip to a specific position in the queue.
   * @param {number} position - 1-based queue position.
   * @returns {string} Status message.
   */
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

  /**
   * Set the playback volume.
   * @param {number} v - Volume as a decimal (0–2, where 1 = 100%).
   * @returns {string} Status message.
   */
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

  /** @returns {boolean} Whether the queue is empty. */
  isEmpty()           { return this.queue.isEmpty(); }

  /**
   * Add a track to the queue with optional top-insert.
   * @param {object} d - Track data.
   * @param {boolean} [t=false] - Insert at the top of the queue.
   */
  addToQueue(d, t)    {
    if (this.queue.data.length >= this._maxQueueSize) {
      logger.warn(`[Player] Queue size cap reached (${this._maxQueueSize}) — dropping oldest track`);
      this.queue.data.shift();
    }
    this.queue.add(d, t);
    this.emit("update", "queue");
    this._stopInactivityTimer();
  }

  /** Clear the queue and start the inactivity timer if nothing is playing. */
  clear()             {
    this.queue.clear();
    this.emit("update", "queue");
    if (!this.queue.getCurrent()) {
      this._startInactivityTimer();
    }
  }

  /**
   * Add multiple tracks to the queue.
   * @param {Array} t - Track data array.
   * @param {boolean} [top=false] - Insert at the top.
   * @returns {number} Number of tracks added.
   */
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

  /**
   * Shuffle the queue.
   * @returns {string} Status message.
   */
  shuffle() {
    if (this.isEmpty()) return "There is nothing to shuffle in the queue.";
    this.queue.shuffle();
    this.emit("update", "queue");
    return ":twisted_rightwards_arrows: Shuffled queue";
  }

  /**
   * Move a track from one position to another (1-based indices).
   * @param {number} from
   * @param {number} to
   * @returns {string} Result message.
   */
  move(from, to) {
    if (this.queue.size() === 0) return "The queue is empty.";
    return this.queue.move(from - 1, to - 1);
  }

  /**
   * Toggle a loop mode.
   * @param {"song"|"queue"} choice
   * @returns {string}
   */
  loop(choice) {
    if (!["song", "queue"].includes(choice))
      return `'${choice}' is not valid. Use \`song\` or \`queue\``;
    const state = this.queue.toggleLoop(choice);
    const name  = choice.charAt(0).toUpperCase() + choice.slice(1);
    return state
        ? `:repeat: ${name} loop activated`
        : `:arrow_right: ${name} loop disabled`;
  }

  /**
   * Remove a track from the queue by index.
   * @param {number} index - 0-based.
   * @returns {string}
   * @throws {Error} If index is empty.
   */
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

  /** @private Stop the audio bridge if currently playing. */
  _bridgeStop() {
    if (this._audioBridge?.playing) {
      this._audioBridge.stop();
    }
  }

  /**
   * @private Send the self-deafen voice state update. Best effort: the
   * VoiceManager silently no-ops when the connection has no connection_id
   * yet (missing from VoiceServerUpdate) — re-sent after every
   * requestVoiceStateSync so later attempts still land once it exists.
   * @param {object} vm - VoiceManager instance.
   * @param {string} channelId - Voice channel ID.
   */
  _assertSelfDeaf(vm, channelId) {
    try {
      vm.updateVoiceState(channelId, { self_deaf: true, self_mute: false });
    } catch (e) {
      logger.warn("[Player] Self-deafen failed:", e.message);
    }
  }

  /**
   * @private Translate a locale key for this player's guild.
   * @param {string} key
   * @param {object} [replacements={}]
   * @returns {string}
   */
  _t(key, replacements = {}) {
    if (!this.locale) return key;
    return this.locale.translate(this._guildId, key, replacements);
  }
}

applyMixins(Player, PlaybackMixin, SearchMixin, DisplayMixin);

export { Player as default, Player, Queue };
