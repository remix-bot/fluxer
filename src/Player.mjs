/**
 * Player.mjs — FluxerRevoice edition
 *
 * Track resolution  → moonlink.js Manager (search / load via NodeLink REST)
 * Session handling  → moonlink.js (WebSocket to NodeLink, session ID, player state)
 * Voice connection  → FluxerRevoice (Fluxer gateway → LiveKit voice)
 * Audio playback    → revoice.js MediaPlayer (FFmpeg → LiveKit audio track)
 *
 * FluxerRevoice uses the Fluxer API/gateway (via @fluxerjs/voice) to obtain
 * LiveKit credentials instead of a third-party REST API that the default
 * revoice.js Revoice class uses. This avoids the 401 Unauthorized error
 * that occurs when a Fluxer bot token is sent to an incompatible API.
 */

import Revoicejs from "revoice.js";
const { MediaPlayer } = Revoicejs;

import { ConnectionState, LKRoomEvent } from "./constants/FluxerRevoice.mjs";
import { getVoiceManager } from "@fluxerjs/voice";
import { Utils } from "./Utils.mjs";
import { EventEmitter } from "node:events";
import meta from "./probe.mjs";
import { Worker } from "node:worker_threads";
import http from "node:http";
import https from "node:https";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "./MessageHandler.mjs";
import { logger } from "./constants/Logger.mjs";
import { get247ChannelMode } from "./constants/Helpers247.mjs";
import { PROVIDER_NAMES } from "./constants/providers.mjs";

/** Emit a plain embed payload so listeners can send it directly */
function mkEmbed(desc) {
  return { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(desc)] };
}


/** NodeLink default password — centralised so it doesn't need to be hardcoded in two places. */
const NL_DEFAULT_PASSWORD = "youshallnotpass";

const _sanitizeCache = new Map();

/**
 * Strip NodeLink host, port, and password from a string so they are never
 * shown to end-users in Fluxer messages.
 * @param {string} msg
 * @param {Object} nl  - The player's _nl config object { host, port, password }
 * @returns {string}
 */
function sanitizeError(msg, nl = {}) {
  if (!msg) return msg;
  const host     = nl.host     ?? "";
  const port     = nl.port     ?? 0;
  const password = nl.password ?? NL_DEFAULT_PASSWORD;
  const cacheKey = `${host}:${port}:${password}`;

  let regexes = _sanitizeCache.get(cacheKey);
  if (!regexes) {
    regexes = [];
    if (host && host !== "localhost") {
      const eh = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      regexes.push(new RegExp(`https?://${eh}(:\\d+)?[^\\s"']*`, "gi"));
      if (port) regexes.push(new RegExp(`${eh}:${port}`, "g"));
    }
    if (port) {
      regexes.push(new RegExp(`https?://localhost:${port}[^\\s"']*`, "gi"));
    }
    if (password && password !== NL_DEFAULT_PASSWORD) {
      const ep = password.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      regexes.push(new RegExp(ep, "g"));
    }
    if (_sanitizeCache.size >= 20) _sanitizeCache.clear();
    _sanitizeCache.set(cacheKey, regexes);
  }

  let s = String(msg);
  for (const re of regexes) {
    re.lastIndex = 0;
    s = s.replace(re, re.source.includes("redacted") ? "[redacted]" : "[internal]");
  }
  return s;
}

function isIgnorableMediaStateError(err) {
  const msg = err?.message ?? String(err ?? "");
  return msg.includes("InvalidState") || msg.includes("failed to capture frame") || msg.includes("capture frame");
}

class PlayerWorkerPool {
  constructor(size, workerPath, nlConfig = {}) {
    this._size       = size;
    this._workerPath = workerPath;
    this._nlConfig   = nlConfig;
    this._workers    = [];
    this._queue      = [];
    this._pending    = new Map();
    this._jobCounter = 0;

    for (let i = 0; i < size; i++) this._spawn();
  }

  _spawn() {
    const worker = new Worker(this._workerPath, {
      workerData: {
        poolMode: true,
        data: { nodelink: this._nlConfig ?? {} }
      }
    });
    const entry = { worker, busy: false, _currentJobKey: null };

    worker.on("message", (raw) => {
      try {
        const msg = typeof raw === "string" ? JSON.parse(raw) : raw;
        const { jobKey, event, data } = msg;
        const cb = this._pending.get(jobKey);
        if (!cb) return;
        if (event === "message" && cb.onMessage) {
          cb.onMessage(data);
        } else if (event === "finished") {
          this._pending.delete(jobKey);
          entry.busy = false;
          entry._currentJobKey = null;
          cb.resolve(data);
          this._drain();
        } else if (event === "error") {
          this._pending.delete(jobKey);
          entry.busy = false;
          entry._currentJobKey = null;
          cb.reject(new Error(String(data)));
          this._drain();
        }
      } catch (_) {}
    });

    worker.on("error", (err) => {
      if (entry._currentJobKey != null) {
        const cb = this._pending.get(entry._currentJobKey);
        if (cb) {
          this._pending.delete(entry._currentJobKey);
          cb.reject(err);
        }
        entry._currentJobKey = null;
      }
      entry.busy = false;
      const errIdx = this._workers.indexOf(entry);
      if (errIdx !== -1) this._workers.splice(errIdx, 1);
      this._spawn();
      this._drain();
    });

    worker.on("exit", (code) => {
      const exitIdx = this._workers.indexOf(entry);
      if (exitIdx !== -1) this._workers.splice(exitIdx, 1);
      if (this._workers.length < this._size) this._spawn();
    });

    this._workers.push(entry);
  }

  _drain() {
    if (this._queue.length === 0) return;
    const free = this._workers.find(e => !e.busy);
    if (!free) return;
    const job = this._queue.shift();
    this._dispatch(free, job);
  }

  _dispatch(entry, { jobKey, msg, resolve, reject, onMessage }) {
    entry.busy = true;
    entry._currentJobKey = jobKey;
    this._pending.set(jobKey, { resolve, reject, onMessage });
    entry.worker.postMessage(JSON.stringify(msg));
  }

  run(jobId, data, onMessage = null) {
    const jobKey = String(++this._jobCounter);
    const msg    = { poolMode: true, jobKey, jobId, data };
    return new Promise((resolve, reject) => {
      const free = this._workers.find(e => !e.busy);
      if (free) {
        this._dispatch(free, { jobKey, msg, resolve, reject, onMessage });
      } else {
        this._queue.push({ jobKey, msg, resolve, reject, onMessage });
      }
    });
  }

  terminate() {
    for (const entry of this._workers) {
      entry.worker.terminate().catch(() => {});
    }
    this._workers  = [];
    this._queue    = [];
    this._pending.clear();
  }
}

export class Queue extends EventEmitter {
  data = [];
  current = null;
  loop = false;
  songLoop = false;

  constructor() {
    super();
  }

  isEmpty() { return this.data.length === 0; }
  size()    { return this.data.length; }

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

  remove(idx) {
    if (idx < 0 || idx >= this.data.length) return "Index out of bounds";
    const title = this.data[idx].title;
    const removed = this.data.splice(idx, 1);
    this.emit("queue", { type: "remove", data: { index: idx, old: this.data.slice(), removed, new: this.data } });
    return `Successfully removed **${title}** from the queue.`;
  }

  move(from, to) {
    if (from < 0 || from >= this.data.length) return "Source index out of bounds";
    if (to < 0 || to >= this.data.length)     return "Target index out of bounds";
    if (from === to)                            return "Track is already in that position";
    const [track] = this.data.splice(from, 1);
    this.data.splice(to, 0, track);
    this.emit("queue", { type: "move", data: { from, to, track } });
    return `Moved **${track.title}** from position ${from + 1} to ${to + 1}.`;
  }

  add(data, top = false) {
    this.emit("queue", { type: "add", data: { append: !top, data } });
    return top ? this.data.unshift(data) : this.data.push(data);
  }

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

  clear()  { this.data.length = 0; }
  reset()  { this.clear(); this.current = null; this.songLoop = false; this.loop = false; }

  setSongLoop(bool) { this.songLoop = bool; }
  setLoop(bool)     { this.loop = bool; }

  toggleLoop(loop) {
    if (loop === "song")  { this.setSongLoop(!this.songLoop); return this.songLoop; }
    if (loop === "queue") { this.setLoop(!this.loop);         return this.loop; }
    return null;
  }

  shuffle() {
    Utils.shuffleArr(this.data);
    this.emit("queue", { type: "shuffle", data: this.data });
  }

  getCurrent() { return this.current; }
  getQueue()   { return this.data; }

  getPage(page = 1, pageSize = 10) {
    const total      = this.data.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage   = Utils.clamp(page, 1, totalPages);
    const start      = (safePage - 1) * pageSize;
    return { items: this.data.slice(start, start + pageSize), page: safePage, totalPages, total, start };
  }
}

export default class Player extends EventEmitter {
  /** @type {import("revoice.js").VoiceConnection|null} */
  connection        = null;
  _guildId          = null;
  _channelId        = null;
  _home247Channel   = null;

  queue        = null;
  client       = null;
  settings     = null;
  config       = {};
  /** @type {import("revoice.js").MediaPlayer|null} */
  _mediaPlayer = null;
  /** @type {import("./constants/FluxerRevoice.mjs").FluxerRevoice|null} Shared FluxerRevoice instance (injected from Remix) */
  _revoice     = null;

  /** @type {import("./MoonlinkManager.mjs").MoonlinkManager|null} */
  _moonlink    = null;

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

  _streamingStopped    = false;
  _skipping            = false;
  _seeking             = false;
  _replayingSeek       = false;
  _currentPassthrough  = null;
  _wasRadio            = false;
  _radioAnnounced      = false;
  _queueEndedSent      = false;
  _lastPlayedTrack     = null;

  _autoplay            = false;
  _autoplayHandler     = null;

  activeFilter         = null;
  activeFilterPayload  = null;

  _inactivityTimer     = null;
  _inactivityLimit = 3 * 60 * 1000;
  _pendingInactivityCheck = false;

  _isJoining           = false;

  _destroyed           = false;

  _nl = {
    host:           "localhost",
    port:           3000,
    password:       "youshallnotpass",
    sessionId:      null,
    requestTimeout: 60_000,
  };

  constructor(token, opts = {}) {
    super();

    this.queue        = new Queue();
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

    this._nl = {
      ...this._nl,
      ...(this.config?.nodelink ?? {}),
      ...(opts.nodelink ?? {}),
    };

    const inactivityMs = this.config?.timers?.inactivityTimeout ?? this.config?.inactivityTimeout;
    if (inactivityMs !== undefined) {
      const parsed = Number(inactivityMs);
      if (!Number.isNaN(parsed) && parsed >= 0) {
        this._inactivityLimit = parsed;
      }
    }

    this._moonlink = opts.moonlink ?? null;

    this._revoice = opts.revoice ?? null;

    if (this._moonlink) {
      this._onMoonlinkReady = (sessionId) => {
        const oldId = this._nl.sessionId;
        this._nl.sessionId = sessionId;
        if (oldId && oldId !== sessionId) {
          logger.moonlink(`[Player] Session ID updated: ${oldId} → ${sessionId}`);
        }
      };
      this._moonlink.on("ready", this._onMoonlinkReady);
      const existingSession = this._moonlink.getLiveSessionId?.() ?? this._moonlink.sessionId;
      if (existingSession) {
        this._nl.sessionId = existingSession;
      }
    }
  }

  /**
   * Check if 24/7 mode is enabled for this player's channel.
   * Returns true for both "on" and "auto" modes.
   */
  _is247Enabled() {
    return this._get247Mode() !== "off";
  }

  /**
   * Get the 24/7 mode for this player's channel.
   * Returns "auto", "on", or "off".
   *
   *   %247 auto: bot stays in voice always (never leaves, auto-rejoins on disconnect + reboot)
   *   %247 on:   bot stays in voice always (never leaves due to inactivity, rejoins on reboot)
   *   %247 off:  bot leaves when inactive
   */
  _get247Mode() {
    if (!this._guildId) return "off";

    const checkSettings = (set) => {
      if (!set?.get) return "off";
      const raw = set.get("stay_247");
      if (!raw || raw === "none") return "off";

      const channels = Array.isArray(raw)
          ? raw.map(id => String(id).replace(/\D/g, "")).filter(Boolean)
          : [String(raw).replace(/\D/g, "")];

      const homeChannel    = this._home247Channel
          ? String(this._home247Channel).replace(/\D/g, "")
          : null;
      const currentChannel = String(this._channelId ?? "").replace(/\D/g, "");

      const matchChannel = channels.includes(homeChannel) ? homeChannel
          : channels.includes(currentChannel) ? currentChannel
              : null;
      if (!matchChannel) return "off";

      return get247ChannelMode(set, matchChannel);
    };

    if (this.settingsMgr?.getServer) return checkSettings(this.settingsMgr.getServer(this._guildId));
    if (this.settings?.get)          return checkSettings(this.settings);
    if (this.client?.settings?.getServer) return checkSettings(this.client.settings.getServer(this._guildId));
    return "off";
  }

  /**
   * Resolve the guild ID for this player, using the channel cache
   * as a fallback if _guildId is not set. This is needed for
   * guild-scoped gateway leave signals.
   * @returns {string|null}
   */
  _resolveGuildId() {
    const cleanGuild = String(this._guildId ?? "").replace(/\D/g, "");
    if (cleanGuild) return cleanGuild;

    try {
      const channelId = this._channelId ?? this._home247Channel;
      if (channelId) {
        const ch = this.client?.channels?.get?.(channelId);
        const fromChannel = ch?.guildId ?? ch?.guild?.id ?? null;
        if (fromChannel) return String(fromChannel).replace(/\D/g, "");
      }
    } catch (_) {}

    return null;
  }

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
      }
    }
  }

  _hasHumansInChannel() {
    if (!this._channelId || !this._guildId) return false;
    const cleanChan  = String(this._channelId).replace(/\D/g, "");
    const cleanGuild = String(this._guildId).replace(/\D/g, "");

    if (this._voiceCache && this._voiceCache.hasHumansInChannel(cleanGuild, cleanChan)) {
      return true;
    }

    try {
      const voiceUsers = this._observedVoiceUsers;
      if (voiceUsers && typeof voiceUsers.iterateHumanUsers === "function") {
        for (const [, info] of voiceUsers.iterateHumanUsers()) {
          if (
              String(info.guildId   ?? "").replace(/\D/g, "") === cleanGuild &&
              String(info.channelId ?? "").replace(/\D/g, "") === cleanChan
          ) return true;
        }
      } else if (voiceUsers) {
        for (const [, info] of voiceUsers) {
          if (
              String(info.guildId   ?? "").replace(/\D/g, "") === cleanGuild &&
              String(info.channelId ?? "").replace(/\D/g, "") === cleanChan
          ) return true;
        }
      }
    } catch (_) {}
    try {
      const guild = this.client?.guilds?.get?.(this._guildId);
      const voiceStates = guild?.voice_states;
      if (voiceStates) {
        const entries = Array.isArray(voiceStates)
            ? voiceStates
            : typeof voiceStates.values === "function"
                ? voiceStates.values()
                : Object.values(voiceStates);
        for (const state of entries) {
          const stateChannelId = String(state?.channelId ?? state?.channel_id ?? "").replace(/\D/g, "");
          if (stateChannelId === cleanChan) {
            const userId = String(state?.userId ?? state?.user_id ?? "");
            const member = guild?.members?.get?.(userId);
            const isBot = member?.user?.bot ?? false;
            if (!isBot) return true;
          }
        }
      }
    } catch (_) {}

    try {
      const room = this.connection?.room;
      if (room?.isConnected && room.remoteParticipants) {
        const botId = this.client?.user?.id;
        for (const [, participant] of room.remoteParticipants) {
          const pId = participant?.identity || participant?.sid;
          if (pId && pId !== botId) {
            return true;
          }
        }
      }
    } catch (_) {}

    return false;
  }

  _startInactivityTimer() {
    this._stopInactivityTimer();
    if (this._inactivityLimit <= 0) return;

    const mode = this._get247Mode();
    logger.inactivity(`[Player] Checking 24/7 mode for guild ${this._guildId}: ${mode}`);

    if (mode === "auto" || mode === "on") {
      logger.inactivity(`[Player] 24/7 ${mode} mode active for guild ${this._guildId}, skipping inactivity timer`);
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
      if (currentMode === "auto" || currentMode === "on") {
        logger.inactivity(`[Player] 24/7 ${currentMode} mode enabled during inactivity wait, aborting leave`);
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

  _stopInactivityTimer() {
    this._pendingInactivityCheck = false;
    if (this._inactivityTimer) {
      logger.inactivity(`[Player] Stopping inactivity timer for guild ${this._guildId}`);
      clearTimeout(this._inactivityTimer);
      this._inactivityTimer = null;
    }
  }

  async _ensureMediaPlayer() {
    if (this._destroyed) return false;
    if (!this.connection) return false;

    const room = this.connection.room;
    if (!room) return false;

    const roomAlive = room.isConnected;
    const cs = room.connectionState;

    logger.mediaplayer(`[Player] _ensureMediaPlayer: attempting to create MediaPlayer (isConnected: ${roomAlive}, connectionState: ${cs})`);

    if (this._mediaPlayer) {
      const mpAlive = !this._mediaPlayer.destroyed && typeof this._mediaPlayer.playStream === "function";
      if (roomAlive && mpAlive) {
        logger.mediaplayer("[Player] Reusing healthy MediaPlayer");
        return true;
      }
      logger.mediaplayer("[Player] Existing MediaPlayer unhealthy, cleaning up...");
      try {
        if (this._mediaPlayer.fProc) {
          try { this._mediaPlayer.fProc.removeAllListeners(); } catch (_) {}
        }
        await this._mediaPlayer.stop();
      } catch (_) {}
      this._mediaPlayer = null;
    }

    if (!roomAlive) {
      logger.mediaplayer(`[Player] Room dead, skipping MediaPlayer creation`);
      return false;
    }

    if (this._destroyed) return false;

    const MAX_PUBLISH_RETRIES = 3;
    const BASE_RETRY_DELAY_MS = 3_000;

    for (let attempt = 1; attempt <= MAX_PUBLISH_RETRIES; attempt++) {
      try {
        const mp = new MediaPlayer();
        mp.setMaxListeners(20);

        if (mp.source && typeof mp.source.captureFrame === "function") {
          const _orig = mp.source.captureFrame.bind(mp.source);
          mp.source.captureFrame = async (frame) => {
            if (this._streamingStopped || this._skipping || this._seeking || this.leaving || this._destroyed) {
              return;
            }
            try {
              return await _orig(frame);
            } catch (e) {
              if (
                  e?.message?.includes("InvalidState") ||
                  e?.message?.includes("failed to capture frame")
              ) {
                return;
              }
              throw e;
            }
          };
        }

        await mp.publishToRoom(room);
        this._mediaPlayer = mp;
        logger.mediaplayer("[Player] MediaPlayer published successfully");
        return true;
      } catch (e) {
        const msg = e?.message ?? String(e);
        const isTransient = msg.includes("track publication timed out")
            || msg.includes("publishToRoom failed")
            || msg.includes("internal error");

        try { this._mediaPlayer?.stop?.(); } catch (_) {}
        this._mediaPlayer = null;

        if (isTransient && attempt < MAX_PUBLISH_RETRIES) {
          const backoffMs = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
          logger.warn(`[Player] publishToRoom failed (attempt ${attempt}/${MAX_PUBLISH_RETRIES}): ${msg} — retrying in ${backoffMs / 1000}s`);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          if (this._destroyed || !room.isConnected) return false;
          continue;
        }

        logger.error(`[Player] publishToRoom failed: ${msg}`);
        return false;
      }
    }
    return false;
  }

  async _stopMediaPlayer() {
    this._streamingStopped = true;

    if (this._currentPassthrough) {
      try {
        const stream = this._currentPassthrough;
        this._currentPassthrough = null;
        if (typeof stream.unpipe === "function") stream.unpipe();
        if (typeof stream.destroy === "function") stream.destroy();
      } catch (e) {
        logger.error("[Player] Error destroying passthrough:", e.message);
      }
    }

    if (this._mediaPlayer) {
      try {
        if (this._mediaPlayer.fProc) {
          try { this._mediaPlayer.fProc.removeAllListeners(); } catch (_) {}
        }

        await this._mediaPlayer.stop();
      } catch (e) {
        logger.error("[Player] Error stopping media player:", e.message);
      }

      try {
        if (this._mediaPlayer?.fProc && !this._mediaPlayer.ffmpegFinished) {
          try { this._mediaPlayer.fProc.kill("SIGKILL"); } catch (_) {}
        }
      } catch (_) {}

      this._mediaPlayer = null;
    }
  }

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
            "Authorization": this._nl.password,
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
              delete options.headers?.Authorization;
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
        req.setTimeout(options.timeout || this._nl.requestTimeout || 60_000, () => {
          req.destroy();
          reject(new Error("Request timeout"));
        });
        if (options.body) req.write(options.body);
        req.end();
      };
      fetchUrl(url);
    });
  }

  async _fetchStream(url) {
    return this._request(url, {
      headers: {
        ...(this._nl.sessionId ? { "Session-Id": this._nl.sessionId } : {}),
        ...(this._guildId      ? { "Guild-Id":   this._guildId      } : {}),
      }
    }, true);
  }

  _getTrackDurationMs(track) {
    if (!track?.duration) return 0;
    if (typeof track.duration === "object" && track.duration?.seconds != null) {
      return track.duration.seconds * 1000;
    }
    if (typeof track.duration === "string" && track.duration.startsWith("PT")) {
      return Utils.parseISODuration(track.duration);
    }
    if (typeof track.duration === "number") return track.duration;
    return 0;
  }

  _didTrackMostlyFinish(track) {
    const totalMs = this._getTrackDurationMs(track);
    if (!totalMs || !this.startedPlaying) return false;

    const elapsedMs = Math.max(0, Date.now() - this.startedPlaying);
    const remainingMs = Math.max(0, totalMs - elapsedMs);

    return elapsedMs / totalMs >= 0.85 || remainingMs <= 15_000;
  }

  async _streamViaRevoice(url, inputOptions = []) {
    if (this._streamingStopped) return;

    this._streamingStopped = false;
    let audioStream = null;
    const currentTrack = this.queue.getCurrent();

    try {
      audioStream = await this._fetchStream(url);
      this._currentPassthrough = audioStream;

      const cleanup = () => {
        if (audioStream) {
          try {
            if (typeof audioStream.unpipe  === "function") audioStream.unpipe();
            if (typeof audioStream.destroy === "function") audioStream.destroy();
          } catch (_) {}
        }
        this._currentPassthrough = null;
      };

      await new Promise((resolve, reject) => {
        audioStream.on("error", (e) => {
          cleanup();
          if (this._streamingStopped || this._skipping || this._seeking) return resolve();
          const graceful = ["aborted", "ECONNRESET", "ERR_STREAM_DESTROYED", "ENOTFOUND", "ETIMEDOUT", "ECONNREFUSED"];
          if (graceful.some(g => e.code === g || e.message?.includes(g))) {
            if (this._didTrackMostlyFinish(currentTrack)) return resolve();
            return reject(new Error(`Stream ended early for ${currentTrack?.title || "track"}: ${e.message ?? e.code ?? "stream aborted"}`));
          }
          reject(e);
        });

        if (!this._mediaPlayer) { cleanup(); return resolve(); }

        this._mediaPlayer.removeAllListeners("finish");
        this._mediaPlayer.removeAllListeners("error");

        const onFfmpegError = (err) => {
          const ffMsg = err?.message ?? String(err);

          const isGracefulKill =
              ffMsg.includes("aborted") ||
              ffMsg.includes("Input stream error") ||
              ffMsg.includes("SIGKILL") ||
              ffMsg.includes("killed with signal");

          if (isGracefulKill) {
            if (this._didTrackMostlyFinish(currentTrack)) {
              logger.player("[Player] FFmpeg stream ended near track completion");
              cleanup();
              return resolve();
            }
            cleanup();
            if (this._streamingStopped || this._skipping || this._seeking) return resolve();
            return reject(new Error(`FFmpeg stream ended early: ${ffMsg}`));
          }

          logger.error("[Player] FFmpeg error:", ffMsg);
          cleanup();
          if (this._streamingStopped || this._skipping || this._seeking) return resolve();
          reject(new Error(`FFmpeg: ${ffMsg}`));
        };

        try {
          const playResult = this._mediaPlayer.playStream(audioStream, inputOptions);
          if (playResult && typeof playResult.catch === "function") {
            playResult.catch((e) => {
              if (isIgnorableMediaStateError(e) || this._streamingStopped || this._skipping || this._seeking || this.leaving) {
                logger.mediaplayer("[Player] Suppressed async playStream InvalidState rejection");
                cleanup();
                resolve();
                return;
              }
              cleanup();
              reject(e);
            });
          }
          if (this._mediaPlayer.fProc) {
            this._mediaPlayer.fProc.once("error", onFfmpegError);
          }
        } catch (e) {
          cleanup();
          if (isIgnorableMediaStateError(e)) {
            logger.mediaplayer("[Player] Suppressed InvalidState during stream start");
            return resolve();
          }
          return reject(e);
        }

        const trackDuration = this._getTrackDurationMs(currentTrack);
        const safetyMs = (trackDuration > 0 && currentTrack?.type !== "radio")
            ? trackDuration + 15_000
            : 20 * 60 * 1000;

        const safetyTimer = setTimeout(() => {
          logger.warn(`[Player] Stream safety timeout hit (${Math.round(safetyMs/1000)}s) — advancing queue`);
          cleanup();
          resolve();
        }, safetyMs);

        this._mediaPlayer.once("finish", () => {
          clearTimeout(safetyTimer);
          if (this._mediaPlayer?.fProc) this._mediaPlayer.fProc.removeListener("error", onFfmpegError);
          cleanup();
          resolve();
        });
        this._mediaPlayer.once("error", (e) => {
          clearTimeout(safetyTimer);
          if (this._mediaPlayer?.fProc) this._mediaPlayer.fProc.removeListener("error", onFfmpegError);
          cleanup();
          if (isIgnorableMediaStateError(e)) {
            logger.mediaplayer("[Player] Suppressed InvalidState during playback");
            return resolve();
          }
          if (this._streamingStopped) return resolve();
          reject(e);
        });
      });

    } catch (e) {
      if (audioStream && !audioStream.destroyed) {
        try { audioStream.destroy(); } catch (_) {}
      }
      this._currentPassthrough = null;
      if (isIgnorableMediaStateError(e)) {
        logger.mediaplayer("[Player] Suppressed InvalidState in stream setup");
        return;
      }
      if (this._streamingStopped) return;
      throw e;
    }
  }

  async _streamUrl(url) {
    const isNodeLink = url.includes(`${this._nl.host}:${this._nl.port}`) ||
        url.includes("/v4/trackstream") ||
        url.includes("/v4/loadstream");

    if (!isNodeLink) return this._streamViaRevoice(url);

    if (url.includes("/v4/loadstream")) {
      logger.player(`[Player] NodeLink loadStream PCM active`);
      const pcmInputOpts = ["-f", "s16le", "-ar", "48000", "-ac", "2"];
      return await this._streamViaRevoice(url, pcmInputOpts);
    }

    try {
      const json = await this._request(url, {
        headers: {
          ...(this._nl.sessionId ? { "Session-Id": this._nl.sessionId } : {}),
          ...(this._guildId      ? { "Guild-Id":   this._guildId      } : {}),
        }
      });
      if (!json?.url) throw new Error(`NodeLink gave no URL: ${JSON.stringify(json)}`);
      logger.player(`[Player] NodeLink resolved stream URL`);
      return this._streamViaRevoice(json.url);
    } catch (err) {
      logger.error("[Player] NodeLink resolve error:", err.message);
      throw new Error(sanitizeError(err.message, this._nl));
    }
  }

  async join(channelId) {
    if (this._destroyed) return;

    if (this._isJoining) {
      logger.player(`[Player] Busy joining. Ignoring: ${channelId}`);
      return;
    }
    if (this.connection && this._channelId === channelId) {
      const isConnected = this.connection.connected ?? false;
      if (isConnected) {
        logger.player(`[Player] Already in channel: ${channelId}`);
        return;
      }
      logger.player(`[Player] Dead connection detected for ${channelId}, cleaning up`);
      try { this.connection.removeAllListeners(); } catch (_) {}

      if (this._revoice && this._channelId) {
        try { this._revoice.markIntentionalDisconnect(this._channelId); } catch (_) {}
        try { this._revoice._leaveGateway(this._channelId, this._guildId ?? this._resolveGuildId()); } catch (_) {}
        try { this._revoice.deleteConnection(this._channelId); } catch (_) {}
      }

      try { await this.connection.disconnect(); } catch (_) {}
      this.connection   = null;
      this._mediaPlayer = null;
    }

    this._isJoining = true;
    try {
      const channel = this.client?.channels?.get?.(channelId);
      if (!channel) throw new Error(`Channel not found: ${channelId}`);

      if (this.connection) {
        logger.mediaplayer("[Player] Cleaning up existing connection before join");
        try { this.connection.removeAllListeners(); } catch (_) {}

        if (this._revoice && this._channelId) {
          try { this._revoice.markIntentionalDisconnect(this._channelId); } catch (_) {}
          try { this._revoice._leaveGateway(this._channelId, this._guildId ?? this._resolveGuildId()); } catch (_) {}
          try { this._revoice.deleteConnection(this._channelId); } catch (_) {}
        }

        try {
          await this.connection.disconnect();
        } catch (_) {}

        await Utils.sleep(500);
        this.connection   = null;
        this._mediaPlayer = null;
      }

      if (!this._revoice) {
        throw new Error("FluxerRevoice instance not available — cannot join voice channel");
      }

      logger.mediaplayer(`[Player] Joining channel ${channelId} via FluxerRevoice (Fluxer API)...`);

      const connection = await this._revoice.join(channelId, false);
      this.connection = connection;
      this._channelId = channelId;
      this._guildId   = channel.guildId;
      this.leaving    = false;

      const room = connection.room;
      if (!room) {
        throw new Error("No room available after revoice.js join");
      }

      logger.mediaplayer(`[Player] FluxerVoiceConnection obtained (isConnected: ${room.isConnected}, connectionState: ${room.connectionState})`);

      let connected = false;
      let settled   = false;

      try {
        if (room.isConnected) {
          connected = true;
          settled   = true;
          logger.mediaplayer("[Player] Room already connected (immediate check via isConnected)");
        } else {
          await new Promise((resolve, reject) => {
            const cleanup = () => {
              clearTimeout(timeout);
              clearInterval(poll);
              try { room.off(LKRoomEvent.ConnectionStateChanged, onStateChange); } catch (_) {}
            };

            const timeout = setTimeout(() => {
              if (settled) return;
              cleanup();
              if (room.isConnected) {
                connected = true;
                settled   = true;
                resolve();
              } else if (!room.isConnected && (room.connectionState === ConnectionState.CONN_DISCONNECTED || room.connectionState === 0)) {
                reject(new Error(`LiveKit disconnected (connectionState: ${room.connectionState})`));
              } else {
                connected = true;
                settled   = true;
                resolve();
              }
            }, 3_000);

            const onStateChange = (cs) => {
              if (settled) return;
              logger.mediaplayer(`[Player] LiveKit connectionStateChanged: ${cs}`);
              if (cs === ConnectionState.CONN_CONNECTED || cs === 1) {
                connected = true;
                settled   = true;
                cleanup();
                resolve();
              } else if (cs === ConnectionState.CONN_DISCONNECTED || cs === 0) {
                cleanup();
                reject(new Error(`LiveKit disconnected (connectionState: ${cs})`));
              }
            };

            room.on(LKRoomEvent.ConnectionStateChanged, onStateChange);

            const poll = setInterval(() => {
              if (settled) return;
              if (room.isConnected) {
                connected = true;
                settled   = true;
                cleanup();
                resolve();
              } else if (room.connectionState === ConnectionState.CONN_DISCONNECTED || room.connectionState === 0) {
                cleanup();
                reject(new Error(`LiveKit disconnected (connectionState: ${room.connectionState})`));
              }
            }, 500);

            if (room.isConnected) {
              connected = true;
              settled   = true;
              cleanup();
              logger.mediaplayer("[Player] Room already connected (immediate check)");
              resolve();
            } else if (room.connectionState === ConnectionState.CONN_DISCONNECTED || room.connectionState === 0) {
              cleanup();
              reject(new Error(`LiveKit disconnected (connectionState: ${room.connectionState})`));
            }
          });
        }
      } catch (err) {
        logger.error("[Player] LiveKit connection failed:", err.message);
        throw err;
      }

      if (connected) {
        logger.mediaplayer("[Player] Room ready via FluxerRevoice, proceeding to MediaPlayer");
      }

      connection.on("error", (err) => {
        if (this.connection !== connection) {
          try { connection.removeAllListeners(); } catch (_) {}
          return;
        }
        logger.error("[Player] Voice error:", err?.message ?? err);
        const mode = this._get247Mode();
        this._stopMediaPlayer()
            .catch(() => {})
            .finally(() => {
              if (this.leaving || this._destroyed) return;
              if (mode === "auto" || mode === "on") {
                logger.inactivity(`[Player] Voice error in 24/7 ${mode} mode — staying in channel, not autoleaving`);
                return;
              }
              this.emit("autoleave");
            });
      });

      connection.on("disconnect", () => {
        if (this.connection !== connection) {
          try { connection.removeAllListeners(); } catch (_) {}
          return;
        }
        if (!this.leaving && !this._destroyed) {
          const mode = this._get247Mode();
          if (mode === "auto" || mode === "on") {
            logger.mediaplayer(`[Player] Unexpected disconnect detected (24/7 ${mode}) — stopping media player, GatewayHandler will schedule rejoin`);
            this._stopMediaPlayer().catch(() => {});
          } else {
            logger.mediaplayer("[Player] Unexpected disconnect detected");
            this._stopMediaPlayer()
                .catch(() => {})
                .finally(() => this.emit("autoleave"));
          }
        } else {
          try { connection.removeAllListeners(); } catch (_) {}
        }
      });

      connection.on("autoleave", () => {
        if (this.connection !== connection) return;
        const mode = this._get247Mode();
        if (mode === "auto" || mode === "on") {
          logger.mediaplayer(`[Player] Auto-leave suppressed for 24/7 ${mode} channel (room empty but staying)`);
          return;
        }
        logger.mediaplayer("[Player] Auto-leave triggered by FluxerVoiceConnection (room empty)");
        if (!this.leaving && !this._destroyed) {
          this.emit("autoleave");
        }
      });

      try {
        const vm = getVoiceManager(this.client);
        vm.updateVoiceState(channelId, { self_deaf: true, self_mute: false });
      } catch (e) {
        logger.warn("[Player] Self-deafen failed:", e.message);
      }

      const playerReady = await this._ensureMediaPlayer();
      if (!playerReady) throw new Error("Failed to create MediaPlayer");

      this._restoreVolume();
      this.emit("roomfetched");
      logger.player(`[Player] Voice connected to ${channel.name || channelId} via FluxerRevoice`);

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

      if (e.message?.includes("401") || e.message?.includes("Unauthorized")) {
        logger.warn(`[Player] Join failed with 401 Unauthorized for guild ${this._guildId}`);
      }

      if (this.connection) {
        try { this.connection.disconnect(); } catch (_) {}
        this.connection = null;
      }
      throw e;
    } finally {
      this._isJoining = false;
    }
  }

  async leave() {
    if (!this.connection) return false;
    try {
      this.leaving = true;
      this._stopInactivityTimer();
      this._streamingStopped = true;
      this._replayingSeek = false;
      this._clearTrackEndTimer();
      this._activeTrackOpt = null;

      if (this._mediaPlayer) {
        this._mediaPlayer.destroy();
        this._mediaPlayer = null;
      }

      const channelId = this._channelId;
      if (this._revoice && channelId) {
        try {
          if (typeof this._revoice.deleteConnection === "function") {
            this._revoice.deleteConnection(channelId);
          } else if (this._revoice.connections) {
            this._revoice.connections.delete(channelId);
          }
        } catch (_) {}
      }

      await this.connection.leave();

      this.queue.reset();
      this.connection  = null;
      this._paused     = false;
      this._pausedAt   = null;
      this._playingNext = false;
      this._autoplay = false;
      if (this._autoplayHandler) {
        this.removeListener("queueEnd", this._autoplayHandler);
        this._autoplayHandler = null;
      }
      this.leaving     = false;
    } catch (e) {
      logger.error("[Player] leave error:", e.message);
      return false;
    }
    this.emit("leave");
    return true;
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

    this._clearTrackEndTimer();
    this._activeTrackOpt = null;
    this._replayingSeek = false;

    try {
      if (this._moonlink && this._onMoonlinkReady) {
        try { this._moonlink.off("ready", this._onMoonlinkReady); } catch (_) {}
        this._onMoonlinkReady = null;
      }
      this.leaving          = true;
      this._streamingStopped = true;
      this._stopInactivityTimer();
      this._autoplay = false;
      if (this._autoplayHandler) {
        this.removeListener("queueEnd", this._autoplayHandler);
        this._autoplayHandler = null;
      }
      this.searches.clear();

      if (this._workerPool) {
        try { this._workerPool.terminate(); } catch (_) {}
        this._workerPool = null;
      }

      const connToDestroy = this.connection;
      this.connection   = null;
      this._mediaPlayer = null;
      if (this._revoice && this._channelId) {
        try { this._revoice.markIntentionalDisconnect(this._channelId); } catch (_) {}
      }
      this._stopMediaPlayer().catch(() => {}).then(() => {
        if (connToDestroy) {
          try { connToDestroy.removeAllListeners?.(); } catch (_) {}
          const disconnectPromise = connToDestroy.disconnect?.();
          if (disconnectPromise instanceof Promise) {
            disconnectPromise.catch((err) => {
              logger.error("[Player] Deferred disconnect failed:", err.message);
            });
          }
        }
      });
    } catch (e) {
      logger.error("[Player] destroy error:", e.message);
    }
  }

  get paused() { return this._paused; }

  pause() {
    if (!this.connection || !this.queue.getCurrent())
      return ":negative_squared_cross_mark: There's nothing playing at the moment!";
    if (this._paused)
      return ":negative_squared_cross_mark: Already paused!";
    this._paused = true;
    this._pausedAt = Date.now();
    this._mediaPlayer?.pause();
    this._pauseTrackEndTimer();
    this.emit("playback", false);
    this._stopInactivityTimer();
    return ":pause_button: Paused";
  }

  resume() {
    if (!this.connection || !this.queue.getCurrent())
      return ":negative_squared_cross_mark: There's nothing playing at the moment!";
    if (!this._paused)
      return ":negative_squared_cross_mark: Not paused!";

    if (this._pausedAt) {
      this.startedPlaying += (Date.now() - this._pausedAt);
    }

    this._paused = false;
    this._pausedAt = null;
    this._mediaPlayer?.resume();
    this._resumeTrackEndTimer();
    this.emit("playback", true);
    this._stopInactivityTimer();
    return ":arrow_forward: Resumed";
  }

  skip() {
    if (!this.connection || !this.queue.getCurrent())
      return ":negative_squared_cross_mark: There's nothing playing at the moment!";
    this._lastPlayedTrack = this.queue.getCurrent();
    this._skipping       = true;
    this._radioAnnounced = false;
    this._activeTrackOpt = null;
    this._clearTrackEndTimer();
    this.queue.current   = null;

    if (this.queue.isEmpty() && !this._wasRadio && !this._queueEndedSent) {
      this._queueEndedSent = true;
      this.emit("queueEnd");
      if (!this._autoplay) {
        const prefix = this._getPrefix?.(this._guildId) ?? "%";
        this.emit("message", { ...mkEmbed(this._t("responses._common.queueEnded", { prefix })), system: true });
      }
    }

    this._stopMediaPlayer().then(() => {
      this._playingNext = false;
      if (!this.queue.isEmpty() && !this.leaving) {
        this.playNext().catch(e => logger.error("[Player] playNext error:", e.message));
      } else {
        this.emit("stopplay");
        if (!this._is247Enabled()) {
          this._startInactivityTimer();
        }
      }
    }).catch(e => logger.error("[Player] skip stop error:", e.message))
        .finally(() => {
          this._skipping = false;
        });
    return ":track_next: Skipped";
  }

  skipTo(position) {
    if (!this.connection || !this.queue.getCurrent())
      return ":negative_squared_cross_mark: There's nothing playing at the moment!";
    const idx = position - 1;
    if (idx < 0 || idx >= this.queue.size())
      return `:negative_squared_cross_mark: Position ${position} out of range (queue has ${this.queue.size()} tracks).`;
    this._lastPlayedTrack = this.queue.getCurrent();
    this.queue.data.splice(0, idx);
    this.queue.current = null;
    this._skipping     = true;

    if (this.queue.isEmpty() && !this._wasRadio && !this._queueEndedSent) {
      this._queueEndedSent = true;
      this.emit("queueEnd");
      if (!this._autoplay) {
        const prefix = this._getPrefix?.(this._guildId) ?? "%";
        this.emit("message", { ...mkEmbed(this._t("responses._common.queueEnded", { prefix })), system: true });
      }
    }

    this._stopMediaPlayer().then(() => {
      this._playingNext = false;
      if (!this.queue.isEmpty() && !this.leaving) {
        this.playNext().catch(e => logger.error("[Player] playNext error:", e.message));
      } else {
        this.emit("stopplay");
        if (!this._is247Enabled()) {
          this._startInactivityTimer();
        }
      }
    }).catch(e => logger.error("[Player] skipTo stop error:", e.message))
        .finally(() => {
          this._skipping = false;
        });
    return `:track_next: Skipped to position ${position}`;
  }

  setVolume(v) {
    this.preferredVolume = Utils.clamp(v, 0, 2);
    this.emit("volume", this.preferredVolume);
    this._mediaPlayer?.setVolume(this.preferredVolume);
    if (!this.connection)
      return `Volume set to \`${Math.round(this.preferredVolume * 100)}%\` — will apply when connected.`;
    return `Volume changed to \`${Math.round(this.preferredVolume * 100)}%\`.`;
  }

  /**
   * Seek to a specific position (in milliseconds) in the currently playing track.
   *
   * 1. Sends a PATCH to the NodeLink REST API so the session state is aware
   *    of the new position.
   * 2. Adjusts `startedPlaying` so that elapsed-time calculations remain
   *    consistent after the seek.
   * 3. Restarts the audio stream from the new position (re-uses the
   *    `_replayWithFilters` path so active filters are preserved).
   *
   * @param {number} ms  Position in milliseconds to seek to.
   * @returns {Promise<boolean>}  true if the seek succeeded, false if the
   *          node doesn't support it or no session is available.
   */
  async seekToPosition(ms) {
    const guildId = this._guildId;
    if (!guildId) return false;

    const current = this.queue.getCurrent();
    if (!current?.encoded) return false;

    const liveSessionId = this._moonlink?.getLiveSessionId?.() ?? this._moonlink?.sessionId ?? this._nl.sessionId;
    if (!liveSessionId) return false;

    const { host, port } = this._nl;
    const url = `http://${host}:${port}/v4/sessions/${liveSessionId}/players/${guildId}`;
    const body = JSON.stringify({ position: ms });

    this._seeking = true;

    try {
      await this._request(url, {
        method: "PATCH",
        headers: {
          "Content-Type":  "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        body,
      });

      if (liveSessionId !== this._nl.sessionId) {
        this._nl.sessionId = liveSessionId;
        logger.moonlink(`[Player] Synced session ID after seek: ${liveSessionId}`);
      }

      this.startedPlaying = Date.now() - ms;
      logger.player(`[Player] Seeked to ${ms}ms — adjusted startedPlaying`);

      this._recalcTrackEndTimer();

      if (this.connection && !this.leaving && !this._streamingStopped) {
        this._replayWithFilters(ms).catch((e) => {
          logger.warn("[Player] Seek replay failed (non-fatal):", e.message);
        });
      }

      await Utils.sleep(500);
      this._seeking = false;

      return true;
    } catch (e) {
      this._seeking = false;
      const errMsg = e?.message ?? "";
      if (errMsg.includes("HTTP 404") || errMsg.includes("HTTP 405")) {
        logger.warn("[Player] Seek not supported by audio node:", errMsg);
        return false;
      }
      logger.error("[Player] Seek request failed:", errMsg);
      throw new Error(sanitizeError(errMsg, this._nl));
    }
  }

  async applyFilter(filterPayload, meta = null) {
    const guildId = this._guildId;
    if (!guildId) {
      return { ok: false, reason: "Player not bound to a guild." };
    }

    const current = this.queue.getCurrent();
    const liveSessionId = this._moonlink?.getLiveSessionId?.() ?? this._moonlink?.sessionId ?? this._nl.sessionId;

    if (!liveSessionId || !current?.encoded) {
      this.activeFilter = meta ?? null;
      this.activeFilterPayload = meta ? filterPayload : null;
      this.emit("filter", this.activeFilter);
      return { ok: true, pending: true };
    }

    const { host, port } = this._nl;
    const url = `http://${host}:${port}/v4/sessions/${liveSessionId}/players/${guildId}?noReplace=true`;

    const body = JSON.stringify({ filters: filterPayload });

    try {
      await this._request(url, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        body,
      });

      if (liveSessionId !== this._nl.sessionId) {
        this._nl.sessionId = liveSessionId;
        logger.moonlink(`[Player] Synced session ID after filter apply: ${liveSessionId}`);
      }

      this.activeFilter = meta ?? null;
      this.activeFilterPayload = meta ? filterPayload : null;
      this.emit("filter", this.activeFilter);

      if (current?.encoded && this.connection && !this.leaving && !this._streamingStopped && this.startedPlaying && !this._playingNext) {
        const elapsed = this.startedPlaying ? (Date.now() - this.startedPlaying) : 0;
        const positionMs = Math.max(0, elapsed);
        logger.player(`[Player] Filter applied — restarting stream from ${positionMs}ms`);
        this._seeking = true;
        this._replayWithFilters(positionMs).catch((e) => {
          logger.warn("[Player] Filter replay failed (non-fatal):", e.message);
        });
        setTimeout(() => { this._seeking = false; }, 500);
      }

      return { ok: true };
    } catch (e) {
      const errMsg = e.message ?? "";
      return { ok: false, reason: sanitizeError(errMsg, this._nl) };
    }
  }

  /**
   * Restart playback of the current track from a given position with the
   * currently active filters baked into the loadstream URL.
   */
  async _replayWithFilters(positionMs = 0) {
    const current = this.queue.getCurrent();
    if (!current?.encoded || !this.connection || this.leaving) return;

    this._replayingSeek = true;
    this._streamingStopped = true;
    await this._stopMediaPlayer().catch(() => {});
    this._streamingStopped = false;

    const hasPlayer = await this._ensureMediaPlayer();
    if (!hasPlayer) {
      logger.warn("[Player] _replayWithFilters: could not recreate MediaPlayer");
      return;
    }

    if (this.preferredVolume !== 1) {
      this._mediaPlayer.setVolume(this.preferredVolume);
    }

    const nlBase = `http://${this._nl.host}:${this._nl.port}`;
    let streamUrl = `${nlBase}/v4/loadstream?encodedTrack=${encodeURIComponent(current.encoded)}&position=${positionMs}&volume=100`;

    if (this.activeFilterPayload) {
      streamUrl += `&filters=${encodeURIComponent(JSON.stringify(this.activeFilterPayload))}`;
    }

    try {
      await this._streamUrl(streamUrl);
    } catch (e) {
      logger.warn("[Player] _replayWithFilters stream error:", e.message);
    }

    this._replayingSeek = false;

    if (!this.leaving && !this._skipping && !this._seeking && !this._paused) {
      const current = this.queue.getCurrent();
      if (current?.type === "radio") {
        logger.player("[Player] Radio stream ended after replay");
        this._lastPlayedTrack = current;
        this.queue.current = null;
        this._streamingStopped = true;
        this.emit("stopplay");
        if (!this._is247Enabled()) {
          this._startInactivityTimer();
        }
      } else {
        this._lastPlayedTrack = current;
        if (!this.queue.songLoop) this.queue.current = null;
        this._streamingStopped = false;
        this._clearTrackEndTimer();
        this._activeTrackOpt = null;
        this.playNext().catch(e => logger.error("[Player] post-replay playNext error:", e.message));
      }
    } else {
      this._streamingStopped = false;
    }
  }

  isEmpty()           { return this.queue.isEmpty(); }

  addToQueue(d, t)    {
    if (this.queue.data.length >= this._maxQueueSize) {
      logger.warn(`[Player] Queue size cap reached (${this._maxQueueSize}) — dropping oldest track`);
      this.queue.data.shift();
    }
    this.queue.add(d, t);
    this.emit("update", "queue");
    this._stopInactivityTimer();
  }

  clear()             {
    this.queue.clear();
    this.emit("update", "queue");
    if (!this.queue.getCurrent()) {
      this._startInactivityTimer();
    }
  }

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

  shuffle() {
    if (this.isEmpty()) return "There is nothing to shuffle in the queue.";
    this.queue.shuffle();
    this.emit("update", "queue");
    return ":twisted_rightwards_arrows: Shuffled queue";
  }

  move(from, to) {
    if (this.queue.size() === 0) return "The queue is empty.";
    return this.queue.move(from - 1, to - 1);
  }

  loop(choice) {
    if (!["song", "queue"].includes(choice))
      return `'${choice}' is not valid. Use \`song\` or \`queue\``;
    const state = this.queue.toggleLoop(choice);
    const name  = choice.charAt(0).toUpperCase() + choice.slice(1);
    return state
        ? `:repeat: ${name} loop activated`
        : `:arrow_right: ${name} loop disabled`;
  }

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

  getCurrent() {
    const c = this.queue.getCurrent();
    if (!c) return "There's nothing playing at the moment.";
    return this.getVideoName(c);
  }

  getVideoName(vid, code = false) {
    if (!vid) return "Unknown";
    if (vid.type === "radio") {
      return code
          ? `[Radio]: ${vid.title} - ${vid.author?.url || ""}`
          : `[Radio] [${vid.title} by ${vid.author?.name || "Unknown"}](${vid.author?.url || ""})`;
    }
    if (vid.type === "external") {
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
      } catch {
        return {
          msg: `${vcLine}📻 **[${current.title}](${current.author?.url || current.url})**\n\n🔉 ${vol} │ ${loopqueue} Queue │ ${songloop} Song │ ${autoplay} Autoplay`,
          image: current.thumbnail
        };
      }
    }

    if (current.type === "external") {
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

  async getThumbnail() {
    const current = this.queue.getCurrent();
    if (!current) return { msg: "There's nothing playing at the moment.", image: null };
    if (!current.thumbnail) return { msg: "No thumbnail available.", image: null };
    return { msg: `Thumbnail of [${current.title}](${current.url}):`, image: current.thumbnail };
  }

  getDuration(duration) {
    if (typeof duration === "object" && duration?.timestamp) return duration.timestamp;
    if (typeof duration === "object" && duration?.seconds  != null) return Utils.formatSeconds(duration.seconds);
    if (typeof duration === "string" && duration.startsWith("PT")) return Utils.prettifyMS(Utils.parseISODuration(duration));
    return Utils.prettifyMS(duration);
  }

  getCurrentDuration() {
    const current = this.queue.getCurrent();
    if (!current?.duration) return "?:??";
    return this.getDuration(current.duration);
  }

  /** Translate a locale key for this player's guild, with fallback. */
  _t(key, replacements = {}) {
    if (!this.locale) return key;
    return this.locale.translate(this._guildId, key, replacements);
  }

  announceSong(s) {
    if (!s) return;

    if (s.type === "radio") {
      this.emit("message", mkEmbed(this._t("responses.radio.nowPlaying", {
        title:  Utils.escapeMarkdown(s.title),
        author: s.author?.name || "Unknown",
        url:    s.author?.url || "",
        channel: this._channelId || "",
      })));
      return;
    }
    const author = s.artists
        ? s.artists.map(a => a.url ? `[${a.name}](${a.url})` : a.name).join(" & ")
        : s.author?.url
            ? `[${s.author.name}](${s.author.url})`
            : s.author?.name || "Unknown";
    this.emit("message", mkEmbed(this._t("responses.play.nowPlaying", {
      title:   Utils.escapeMarkdown(s.title),
      url:     s.spotifyUrl || s.url,
      author:  author,
      channel: this._channelId || "",
    })));
  }

  _workerPool = null;

  _getWorkerPool() {
    if (!this._workerPool) {
      const workerPath = new URL("./worker.mjs", import.meta.url);
      this._workerPool = new PlayerWorkerPool(2, workerPath, this._nl);
    }
    return this._workerPool;
  }

  workerJob(jobId, data, onMessage = null) {
    if (this._destroyed) return Promise.resolve(null);

    const pool = this._getWorkerPool();
    const jobData = {
      ...data,
      nodelink: this._nl,
      guildId:  this._guildId,
    };

    return Utils.timeout(
        pool.run(jobId, jobData, onMessage),
        60_000,
        "Worker timeout after 60s"
    );
  }

  async fetchResults(query, id, provider = "ytm") {
    try {
      const data = await this.workerJob("searchResults", { query, provider, resultCount: this.resultLimit });
      const results = Array.isArray(data?.data) ? data.data : [];
      let list = `Search results using **${PROVIDER_NAMES[provider] || "YouTube Music"}**:\n\n`;
      results.forEach((v, i) => {
        const url   = v.url || "";
        const title = v.title || Utils.formatTrackInfo(v, false);
        const dur   = v.duration ? this.getDuration(v.duration) : "?:??";
        list += `${i + 1}. [${title}](${url}) - ${dur}\n`;
      });
      list += "\nSend the number of the result. Example: `2`\nSend 'x' to cancel.";

      if (this.searches.size >= this._searchMaxSize) {
        const oldestKey = this.searches.keys().next().value;
        if (oldestKey !== undefined) this.searches.delete(oldestKey);
      }
      this.searches.set(id, results);

      return { m: list, count: results.length };
    } catch (err) {
      return { m: `Error searching: ${err.message}`, count: 0 };
    }
  }

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

  playFirst(query, provider, trackMeta) { return this.play(query, true, provider, trackMeta); }

  play(query, top = false, provider, trackMeta = null) {
    const events = new EventEmitter();
    this.workerJob("generalQuery", { query, provider, trackMeta }, (msg) => events.emit("message", msg))
        .then((data) => {
          if (!data) {
            logger.worker("[Player] Worker returned empty result");
            events.emit("message", "Could not load track - no data returned.");
            events.removeAllListeners();
            return;
          }

          if (data.type === "error") {
            logger.worker("[Player] Worker returned error:", data.error);
            events.emit("message", sanitizeError(data.error, this._nl) || "Failed to load track.");
            events.removeAllListeners();
            return;
          }

          if (data.type === "list") {
            this.addManyToQueue(data.data, top);
          } else if (data.type === "video") {
            this.addToQueue(data.data, top);
          } else {
            logger.worker("[Player] Unknown worker result:", data);
            events.emit("message", "Unexpected result from track loader.");
            events.removeAllListeners();
            return;
          }

          if (!this.queue.getCurrent()) {
            this.playNext().catch(e => logger.error("[Player] playNext error:", e.message));
          }
          events.removeAllListeners();
        })
        .catch((reason) => {
          logger.error("[Player] Worker job failed:", reason);
          events.emit("message", sanitizeError(reason?.message, this._nl) || "An error occurred while loading the track.");
          events.removeAllListeners();
        });
    return events;
  }

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

  playRadio(radio, top = false) {
    if (!radio?.url) { logger.error("[Player] Invalid radio data"); return; }
    this.addToQueue(this._buildRadioTrack(radio), top);
    if (!this.queue.getCurrent()) this.playNext().catch(e => logger.error("[Player] playNext error:", e.message));
  }

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
    await this._stopMediaPlayer();
    this._playingNext = false;
    this._skipping    = false;
    if (!this.leaving) this.playNext().catch(e => logger.error("[Player] playNext error:", e.message));
  }

  async playNext() {
    if (this._playingNext) return;
    this._playingNext = true;
    try { await this._doPlayNext(); }
    finally { this._playingNext = false; }
  }

  async _doPlayNext() {
    if (this._currentPassthrough) {
      try {
        if (typeof this._currentPassthrough.unpipe  === "function") this._currentPassthrough.unpipe();
        if (typeof this._currentPassthrough.destroy === "function") this._currentPassthrough.destroy();
      } catch (_) {}
      this._currentPassthrough = null;
    }

    if (this._mediaPlayer) {
      try {
        if (this._mediaPlayer.fProc) {
          try { this._mediaPlayer.fProc.removeAllListeners(); } catch (_) {}
        }
        await this._mediaPlayer.stop();
      } catch (_) {}
    }

    this._streamingStopped = false;

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
        this.emit("message", { ...mkEmbed(this._t("responses._common.queueEnded", { prefix })), system: true });
      }
      this._wasRadio = false;
      return;
    }

    this._stopInactivityTimer();
    this._wasRadio = songData.type === "radio";

    if (!this.connection || this.leaving) return;

    const room = this.connection.room;
    if (!room || !room.isConnected) {
      const cs = room?.connectionState;
      const mode = this._get247Mode();
      if (mode === "auto" || mode === "on") {
        logger.mediaplayer(`[Player] Room not connected (isConnected: ${room?.isConnected}, connectionState: ${cs}) in 24/7 ${mode} mode — deferring autoleave, waiting for rejoin.`);
        if (songData) {
          this.queue.data.unshift(songData);
          this.queue.current = null;
        }
        return;
      }
      logger.mediaplayer(`[Player] Room not connected (isConnected: ${room?.isConnected}, connectionState: ${cs}) — emitting autoleave.`);
      if (songData) {
        this.queue.data.unshift(songData);
        this.queue.current = null;
      }
      this.emit("autoleave");
      return;
    }

    const hasValidPlayer = await this._ensureMediaPlayer();
    if (!hasValidPlayer) {
      logger.error("[Player] Failed to create healthy MediaPlayer — cannot play.");
      this.emit("message", mkEmbed(this._t("responses._common.voiceConnectionLost")));

      if (!this._is247Enabled()) {
        this._startInactivityTimer();
      }
      return;
    }

    if (songData.encoded && this.activeFilter) {
      const { ok, pending, reason } = await this.applyFilter(this.activeFilterPayload ?? {}, this.activeFilter);
      if (!ok) {
        logger.warn(`[Player] Failed to apply active filter before playback: ${reason}`);
      } else if (!pending) {
        logger.mediaplayer(`[Player] Applied active filter before playback: ${this.activeFilter.label}`);
      }
    }

    if (this._mediaPlayer && this.preferredVolume !== 1) {
      this._mediaPlayer.setVolume(this.preferredVolume);
    }

    if (!this.connection || this.leaving) return;

    let streamUrl = null;
    let startOffsetMs = 0;

    if (songData.type === "radio" || songData.type === "external") {
      streamUrl = songData.url;
    } else if (songData.encoded) {
      const nlBase = `http://${this._nl.host}:${this._nl.port}`;
      const positionMs = 0;
      streamUrl = `${nlBase}/v4/loadstream?encodedTrack=${encodeURIComponent(songData.encoded)}&position=${positionMs}&volume=100`;

      if (this.activeFilterPayload) {
        streamUrl += `&filters=${encodeURIComponent(JSON.stringify(this.activeFilterPayload))}`;
      }
    } else if (songData.url && Utils.isValidUrl(songData.url)) {
      streamUrl = songData.url;
    } else {
      try {
        if (this._moonlink?.manager) {
          const result = await this._moonlink.search(`ytsearch:${songData.title}`);
          const track  = result?.tracks?.[0];
          if (track?.encoded) {
            const nlBase = `http://${this._nl.host}:${this._nl.port}`;
            const guildParam = this._guildId ? `&guildId=${this._guildId}` : "";
            streamUrl = `${nlBase}/v4/trackstream?encodedTrack=${encodeURIComponent(track.encoded)}${guildParam}`;
          } else if (track?.uri) {
            streamUrl = track.uri;
          }
        }
      } catch (e) {
        logger.error("[Player] moonlink search fallback error:", e.message);
      }
    }

    if (!streamUrl || !Utils.isValidUrl(streamUrl)) {
      logger.error("[Player] No valid stream URL for:", songData.title);
      this.emit("message", mkEmbed(this._t("responses._common.couldNotGetStream", { title: songData.title })));
      this._streamingStopped = true;
      this.emit("stopplay");
      if (!this._is247Enabled()) {
        this._startInactivityTimer();
      }
      return;
    }

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
      if (trackOptMatch.startMs > 0 && songData.encoded && streamUrl.includes("/v4/loadstream")) {
        startOffsetMs = trackOptMatch.startMs;
        streamUrl = streamUrl.replace(/position=\d+/, `position=${startOffsetMs}`);
        logger.player(`[Player] TrackOptions: starting from ${startOffsetMs}ms via loadstream position param`);
      }
    }

    logger.player(`[Player:${this._guildId}] Streaming: ${songData.title}`);

    this.startedPlaying   = Date.now() - startOffsetMs;
    this._paused          = false;
    this._pausedAt        = null;
    this._queueEndedSent  = false;

    if (songData.type !== "radio" || !this._radioAnnounced) {
      this.announceSong(songData);
      if (songData.type === "radio") this._radioAnnounced = true;
    }
    this.emit("startplay", songData);

    if (trackOptMatch && trackOptMatch.startMs > 0 && startOffsetMs === 0) {
      this._applyTrackOptionsSeek(trackOptMatch).catch((e) => {
        logger.warn("[Player] TrackOptions auto-seek error:", e.message);
      });
    }

    if (trackOptMatch && trackOptMatch.endMs > 0) {
      const elapsedMs = Date.now() - this.startedPlaying;
      const remainingMs = trackOptMatch.endMs - elapsedMs;
      if (remainingMs > 0) {
        const match = trackOptMatch;
        this._trackEndTimer = setTimeout(() => this._onTrackEndTimeReached(match), remainingMs);
      }
    }

    try {
      await this._streamUrl(streamUrl);
    } catch (err) {
      logger.error("[Player] Stream error:", err.message);
      this._streamingStopped = true;
      if (!this._skipping && !this.leaving && !this._paused) {
        if (songData.type !== "radio") {
          this.emit("message", mkEmbed(this._t("responses._common.errorStreaming", { title: songData.title })));
        }
      }
    }

    this._clearTrackEndTimer();

    if (!this.leaving && !this._skipping && !this._seeking) {
      if (songData.type === "radio") {
        logger.player(`[Player] Radio stream ended: ${songData.title}`);
        this._lastPlayedTrack = this.queue.getCurrent() ?? songData;
        this.queue.current = null;
        this._streamingStopped = true;
        this.emit("stopplay");
        if (!this._is247Enabled()) {
          this._startInactivityTimer();
        }
        return;
      } else {
        if (!this._paused) {
          this._lastPlayedTrack = this.queue.getCurrent() ?? songData;
          if (!this.queue.songLoop) this.queue.current = null;
          this._streamingStopped = false;
          return this._doPlayNext();
        }
      }
    }
    this._skipping = false;
    if (this._seeking) this._seeking = false;
  }

  _trackEndTimer = null;
  _trackEndRemainingMs = null;

  _onTrackEndTimeReached(match) {
    if (this._destroyed || this.leaving || !this._activeTrackOpt) return;
    logger.player(`[Player] TrackOptions: end time reached (${match.endMs}ms), skipping track`);
    this._activeTrackOpt = null;
    this._trackEndTimer = null;
    this._trackEndRemainingMs = null;
    this._skipping = true;
    this._stopMediaPlayer().then(() => {
      this._doPlayNext();
    }).catch(() => {
      this._doPlayNext();
    });
  }

  _clearTrackEndTimer() {
    if (this._trackEndTimer) {
      clearTimeout(this._trackEndTimer);
      this._trackEndTimer = null;
    }
    this._trackEndRemainingMs = null;
  }

  _pauseTrackEndTimer() {
    if (!this._trackEndTimer || !this._activeTrackOpt || this._activeTrackOpt.endMs <= 0) return;
    clearTimeout(this._trackEndTimer);
    const elapsedMs = Date.now() - this.startedPlaying;
    this._trackEndRemainingMs = Math.max(0, this._activeTrackOpt.endMs - elapsedMs);
    this._trackEndTimer = null;
  }

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

  async _lookupTrackOptions(songData) {
    if (!this.trackOptions || !songData || songData.type === "radio") return null;
    if (!this._guildId || !this._channelId) return null;

    const userIds = [];
    if (this._voiceCache) {
      const humans = this._voiceCache.getHumansInChannel(
        String(this._guildId).replace(/\D/g, ""),
        String(this._channelId).replace(/\D/g, "")
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
            const ch = String(state?.channelId ?? state?.channel_id ?? "").replace(/\D/g, "");
            if (ch === String(this._channelId).replace(/\D/g, "")) {
              const uid = state?.userId ?? state?.user_id;
              const member = guild?.members?.get?.(uid);
              if (uid && !member?.user?.bot) userIds.push(uid);
            }
          }
        }
      } catch (_) {}
    }

    if (userIds.length === 0) return null;

    const match = await this.trackOptions.getBestMatchForChannel(userIds, songData);
    return match || null;
  }

  async _applyTrackOptionsSeek(match) {
    if (!match || match.startMs <= 0) return;
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

  async applyTrackOption(match) {
    if (!match || !this.connection || this._paused) return false;

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

  async lyrics() {
    const current = this.queue.getCurrent();
    if (!current) return null;

    if (this._moonlink?.manager) {
      try {
        const node = this._moonlink.manager.nodes.findNode();
        if (node) {
          const searchQuery = current.artists?.[0]?.name
              ? `${current.title} ${current.artists[0].name}`
              : current.title;
          const result = await node.loadLyrics(current.encoded || searchQuery);
          if (result?.data?.lines?.length) {
            return {
              text:   result.data.lines.map(l => l.text).join("\n"),
              source: "NodeLink",
              synced: result.data.lines.some(l => l.startTimeMs != null),
              lines:  result.data.lines,
            };
          }
        }
      } catch (e) {
        logger.player(`[Lyrics] moonlink loadLyrics failed: ${e.message}`);
      }
    }

    try {
      const searchQuery = current.artists?.[0]?.name
          ? `${current.title} ${current.artists[0].name}`
          : current.title;
      const url = current.encoded
          ? `http://${this._nl.host}:${this._nl.port}/v4/loadlyrics?encodedTrack=${encodeURIComponent(current.encoded)}`
          : `http://${this._nl.host}:${this._nl.port}/v4/loadlyrics?identifier=${encodeURIComponent(searchQuery)}`;
      const results = await this._request(url, {
        headers: {
          ...(this._nl.sessionId ? { "Session-Id": this._nl.sessionId } : {}),
          ...(this._guildId      ? { "Guild-Id":   this._guildId      } : {}),
        }
      });
      if (results?.data?.lines?.length) {
        return {
          text:   results.data.lines.map(l => l.text).join("\n"),
          source: "NodeLink",
          synced: results.data.lines.some(l => l.startTimeMs != null),
          lines:  results.data.lines,
        };
      }
    } catch (e) {
      logger.player(`[Lyrics] REST fallback failed: ${e.message}`);
    }

    return null;
  }
}
