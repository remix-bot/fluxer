/**
 * Player.mjs — moonlink.js + revoice.js edition
 *
 * Track resolution  → moonlink.js Manager (search / load via NodeLink REST)
 * Session handling  → moonlink.js (WebSocket to NodeLink, session ID, player state)
 * Audio playback    → revoice.js (LiveKit voice connection → Fluxer VC)
 *
 */

import Revoicejs from "revoice.js";
const { MediaPlayer } = Revoicejs;
import { joinVoiceChannel, getVoiceManager } from "@fluxerjs/voice";
import { Utils } from "./Utils.mjs";
import { EventEmitter } from "node:events";
import meta from "./probe.mjs";
import { Worker } from "node:worker_threads";
import http from "node:http";
import https from "node:https";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "./MessageHandler.mjs";
import { logger } from "./constants/Logger.mjs";
import { PROVIDER_NAMES } from "./constants/providers.mjs";

/** Emit a plain embed payload so listeners can send it directly */
function mkEmbed(desc) {
  return { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(desc).toJSON()] };
}

/** NodeLink default password — centralised so it doesn't need to be hardcoded in two places. */
const NL_DEFAULT_PASSWORD = "youshallnotpass";

// Cache compiled sanitize regexes keyed by "host:port:password" to avoid
// rebuilding identical RegExp objects on every error path.
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
    // Cap cache size — in practice there's only one NodeLink config, but guard anyway
    if (_sanitizeCache.size >= 20) _sanitizeCache.clear();
    _sanitizeCache.set(cacheKey, regexes);
  }

  let s = String(msg);
  for (const re of regexes) {
    re.lastIndex = 0; // reset stateful global regexes between calls
    s = s.replace(re, re.source.includes("redacted") ? "[redacted]" : "[internal]");
  }
  return s;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Queue Class
// ═══════════════════════════════════════════════════════════════════════════════

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

  addFirst(data) { return this.add(data, true); }

  add(data, top = false) {
    this.emit("queue", { type: "add", data: { append: !top, data } });
    return top ? this.data.unshift(data) : this.data.push(data);
  }

  addMany(tracks, top = false) {
    if (!tracks?.length) return 0;
    if (top) {
      for (let i = tracks.length - 1; i >= 0; i--) this.data.unshift(tracks[i]);
    } else {
      this.data.push(...tracks);
    }
    this.emit("queue", { type: "addMany", data: { append: !top, tracks } });
    return tracks.length;
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

// ═══════════════════════════════════════════════════════════════════════════════
// Player Class
// ═══════════════════════════════════════════════════════════════════════════════

export default class Player extends EventEmitter {
  /** @type {import("revoice.js").VoiceConnection|null} */
  connection   = null;
  _guildId     = null;
  _channelId   = null;

  // Components
  queue        = null;
  client       = null;
  settings     = null;
  config       = {};
  spotifyConfig = null;

  // revoice.js instances
  /** @type {import("revoice.js").MediaPlayer|null} */
  _mediaPlayer = null;

  // moonlink.js manager reference (set by PlayerManager)
  /** @type {import("./MoonlinkManager.mjs").MoonlinkManager|null} */
  _moonlink    = null;

  // Playback state
  leaving           = false;
  _paused           = false;
  _playingNext      = false;
  _isRecovering     = false;
  startedPlaying    = null;
  // searches Map with max-size eviction to prevent memory leak on busy servers.
  // Map preserves insertion order natively, so we use keys().next() for LRU eviction
  // instead of a separate _searchOrder array (which could hold ghost keys after playResult()).
  searches          = new Map();
  _searchMaxSize    = 50;       // cap: max concurrent pending search sessions
  resultLimit       = 5;
  preferredVolume   = 1;

  // Streaming state
  _streamingStopped    = false;
  _skipping            = false;
  _currentPassthrough  = null;
  _wasRadio            = false;
  _radioAnnounced      = false;

  // Active audio filter — { key, label, payload } or null
  activeFilter         = null;

  // Inactivity timeout
  _inactivityTimer     = null;
  _inactivityLimit = 3 * 60 * 1000; // 3 min default

  // Join mutex — prevents concurrent join() calls from racing each other
  _isJoining           = false;

  // NodeLink config (kept for direct stream URL building; session managed by moonlink)
  _nl = {
    host:           "localhost",
    port:           3000,
    password:       "youshallnotpass",
    sessionId:      null,
    requestTimeout: 60_000, // ms before a NodeLink HTTP request is aborted (raise in config if needed)
  };

  constructor(token, opts = {}) {
    super();

    this.queue        = new Queue();
    this.client       = opts.client;
    this.config       = opts.config ?? {};
    this.spotifyConfig = opts.config?.spotify;
    this.settings     = opts.settings ?? null;
    this.settingsMgr  = opts.settingsMgr ?? null;
    this._observedVoiceUsers = opts.observedVoiceUsers ?? null;

    // Merge NodeLink config (for stream URL building)
    this._nl = {
      ...this._nl,
      ...(this.config?.nodelink ?? {}),
      ...(opts.nodelink ?? {}),
    };

    // Set inactivity limit — checks config.timers.inactivityTimeout first, then legacy config.inactivityTimeout
    const inactivityMs = this.config?.timers?.inactivityTimeout ?? this.config?.inactivityTimeout;
    if (inactivityMs !== undefined) {
      this._inactivityLimit = inactivityMs;
    }

    // moonlink.js manager reference — injected by PlayerManager
    this._moonlink = opts.moonlink ?? null;

    // FIXED: Robust session sync that handles reconnection and stale sessions
    if (this._moonlink) {
      this._onMoonlinkReady = (sessionId) => {
        const oldId = this._nl.sessionId;
        this._nl.sessionId = sessionId;
        if (oldId && oldId !== sessionId) {
          logger.moonlink(`[Player] Session ID updated: ${oldId} → ${sessionId}`);
        }
      };
      this._moonlink.on("ready", this._onMoonlinkReady);
      // Immediate sync if moonlink is already ready
      const existingSession = this._moonlink.getLiveSessionId?.() ?? this._moonlink.sessionId;
      if (existingSession) {
        this._nl.sessionId = existingSession;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 24/7 Mode Check
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if 24/7 mode is enabled for this guild.
   * @private
   */
  _is247Enabled() {
    if (!this._guildId) return false;

    const checkSettings = (set) => {
      if (!set?.get) return false;
      const raw = set.get("stay_247");
      if (!raw || raw === "none") return false;
      const channels = Array.isArray(raw)
          ? raw.map(id => String(id).replace(/\D/g, "")).filter(Boolean)
          : [String(raw).replace(/\D/g, "")];
      const currentChannel = String(this._channelId).replace(/\D/g, "");
      if (!channels.includes(currentChannel)) return false;
      const mode = set.get("stay_247_mode") ?? "auto";
      return mode === "on" || mode === "auto";
    };

    if (this.settingsMgr?.getServer) return checkSettings(this.settingsMgr.getServer(this._guildId));
    if (this.settings?.get)          return checkSettings(this.settings);
    if (this.client?.settings?.getServer) return checkSettings(this.client.settings.getServer(this._guildId));
    return false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Volume Restore
  // ═══════════════════════════════════════════════════════════════════════════

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
      this.preferredVolume = Utils.clamp(savedVol / 100, 0, 1);
      logger.player(`[Player] Restored volume ${savedVol}% for guild ${this._guildId}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Connection Recovery
  // ═══════════════════════════════════════════════════════════════════════════

  async _recoverConnection() {
    if (this._isRecovering) return;
    this._isRecovering = true;
    logger.mediaplayer(`[Player] Attempting to recover voice connection for ${this._guildId}`);

    try {
      if (this.connection) {
        try { await this.connection.disconnect(); } catch (_) {}
      }

      await Utils.sleep(2000);
      if (this.leaving) return;

      logger.mediaplayer(`[Player] Rejoining channel ${this._channelId}`);
      await this.join(this._channelId);

      // Verify the join actually produced a healthy connection before resuming playback.
      // Releasing _isRecovering here (rather than in finally) means a second "disconnected"
      // event that fires while join() is in-flight cannot enter a concurrent recovery cycle.
      const roomState = this.connection?.room?.state;
      const isConnected = roomState === 1 || roomState === "connected" || roomState === "connecting";
      if (!isConnected) {
        throw new Error(`Room in unexpected state after rejoin: ${roomState}`);
      }

      // Release the guard only after confirming the connection is live
      this._isRecovering = false;

      const current = this.queue.getCurrent();
      if (current) {
        logger.player(`[Player] Resuming track after recovery: ${current.title}`);
        this.queue.data.unshift(current);
        this.queue.current = null;
        this._playingNext = false;
        await this.playNext();
      } else if (!this.queue.isEmpty()) {
        this._playingNext = false;
        await this.playNext();
      }
    } catch (e) {
      logger.error("[Player] Recovery failed:", e.message);
      this._isRecovering = false;
      this.emit("autoleave");
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Inactivity Timer
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Returns true if there is at least one non-bot human in the bot's current voice channel.
   */
  _hasHumansInChannel() {
    if (!this._channelId || !this._guildId) return false;
    const cleanChan  = String(this._channelId).replace(/\D/g, "");
    const cleanGuild = String(this._guildId).replace(/\D/g, "");
    try {
      const voiceUsers = this._observedVoiceUsers;
      if (voiceUsers) {
        for (const [, info] of voiceUsers) {
          if (
              String(info.guildId   ?? "").replace(/\D/g, "") === cleanGuild &&
              String(info.channelId ?? "").replace(/\D/g, "") === cleanChan
          ) return true;
        }
        return false;
      }
    } catch (_) {}
    try {
      const channel = this.client?.channels?.cache?.get(this._channelId);
      const members = channel?.members;
      if (members) {
        const iter = typeof members.values === "function" ? members.values() : Object.values(members);
        for (const entry of iter) {
          const isBot = entry?.user?.bot ?? entry?.member?.user?.bot ?? false;
          if (!isBot) return true;
        }
      }
    } catch (_) {}
    return false;
  }

  _startInactivityTimer() {
    this._stopInactivityTimer();
    if (this._inactivityLimit <= 0) return;

    const is247 = this._is247Enabled();
    logger.inactivity(`[Player] Checking 24/7 mode for guild ${this._guildId}: ${is247}`);

    if (is247) {
      logger.inactivity(`[Player] 24/7 mode active for guild ${this._guildId}, skipping inactivity timer`);
      return;
    }

    if (this._hasHumansInChannel()) {
      logger.inactivity(`[Player] Humans present in channel ${this._channelId}, skipping inactivity timer`);
      return;
    }

    logger.inactivity(`[Player] Starting inactivity timer for guild ${this._guildId} (${this._inactivityLimit / 1000}s)`);
    this._inactivityTimer = setTimeout(() => {
      if (this._is247Enabled()) {
        logger.inactivity("[Player] 24/7 mode enabled during inactivity wait, aborting leave");
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
    if (this._inactivityTimer) {
      logger.inactivity(`[Player] Stopping inactivity timer for guild ${this._guildId}`);
      clearTimeout(this._inactivityTimer);
      this._inactivityTimer = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MediaPlayer Management
  // ═══════════════════════════════════════════════════════════════════════════

  async _ensureMediaPlayer() {
    if (!this.connection) {
      logger.mediaplayer("[Player] No connection available");
      return false;
    }

    const room = this.connection.room;
    if (!room) {
      logger.mediaplayer("[Player] No room available");
      return false;
    }

    logger.mediaplayer(`[Player] _ensureMediaPlayer: attempting to create MediaPlayer (room.state: ${room.state})`);

    if (this._mediaPlayer) {
      const room      = this.connection?.room;
      const roomAlive = room && room.state !== "disconnected" && room.state !== "failed" && room.state !== 0;
      const mpAlive   = !this._mediaPlayer.destroyed && typeof this._mediaPlayer.playStream === "function";

      if (roomAlive && mpAlive) {
        logger.mediaplayer("[Player] Reusing healthy MediaPlayer");
        return true;
      }

      logger.mediaplayer("[Player] Existing MediaPlayer unhealthy, cleaning up...");
      await this._cleanupMediaPlayer();
    }

    try {
      this._mediaPlayer = new MediaPlayer();
      this._mediaPlayer.setMaxListeners(0);
      this._setupMediaPlayerMonitoring();

      await this._mediaPlayer.publishToRoom(room);
      logger.mediaplayer("[Player] MediaPlayer published successfully");
      return true;
    } catch (e) {
      logger.error("[Player] publishToRoom failed:", e.message);
      this._mediaPlayer = null;
      return false;
    }
  }

  _setupMediaPlayerMonitoring() {
    // No-op: recovery is fully handled by connection.on("disconnected") in join().
  }

  async _cleanupMediaPlayer() {
    try {
      await this._mediaPlayer?.stop();
    } catch (_) {}

    this._mediaPlayer = null;
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
        this._mediaPlayer.removeAllListeners("finish");
        this._mediaPlayer.removeAllListeners("error");
        await this._mediaPlayer.stop();
      } catch (e) {
        logger.error("[Player] Error stopping media player:", e.message);
      }

      await new Promise(r => setTimeout(r, 150));
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HTTP/Stream Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  async _request(url, options = {}, returnStream = false) {
    return new Promise((resolve, reject) => {
      const fetchUrl = (target) => {
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
          if (returnStream) req.setTimeout(0); // Disable socket idle timeout for media streams

          if ([301, 302, 307, 308].includes(res.statusCode)) {
            let loc = res.headers.location;
            if (!loc) return reject(new Error("Redirect without location"));
            if (loc.startsWith("/")) loc = `${urlObj.protocol}//${urlObj.host}${loc}`;
            return fetchUrl(loc);
          }
          if (![200, 204, 206].includes(res.statusCode)) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode} at ${target}`));
          }
          if (returnStream) return resolve(res);

          // 204 No Content — valid success with no body
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

  // ═══════════════════════════════════════════════════════════════════════════
  // Audio Streaming (revoice.js)
  // ═══════════════════════════════════════════════════════════════════════════

  async _streamViaRevoice(url) {
    this._streamingStopped = false;
    let audioStream = null;

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
          if (this._streamingStopped || this._skipping) return resolve();
          const graceful = ["aborted", "ECONNRESET", "ERR_STREAM_DESTROYED", "ENOTFOUND", "ETIMEDOUT", "ECONNREFUSED"];
          // Use substring matching so "Input stream error: aborted" (from NodeLink) is also caught
          if (graceful.some(g => e.code === g || e.message?.includes(g))) return resolve();
          reject(e);
        });

        if (!this._mediaPlayer) { cleanup(); return resolve(); }

        this._mediaPlayer.removeAllListeners("finish");
        this._mediaPlayer.removeAllListeners("error");

        const onFfmpegError = (err) => {
          const ffMsg = err?.message ?? String(err);
          // "Input stream error: aborted" means NodeLink dropped the HTTP stream
          // (e.g. filter PATCH restarted the player before voice state arrived).
          // Treat it as graceful so the queue can advance normally.
          if (ffMsg.includes("aborted") || ffMsg.includes("Input stream error")) {
            logger.player("[Player] FFmpeg stream aborted gracefully (NodeLink stream closed)");
            cleanup();
            return resolve();
          }
          logger.error("[Player] FFmpeg error:", ffMsg);
          cleanup();
          if (this._streamingStopped || this._skipping) return resolve();
          reject(new Error(`FFmpeg: ${ffMsg}`));
        };

        try {
          this._mediaPlayer.playStream(audioStream);
          if (this._mediaPlayer.fProc) {
            this._mediaPlayer.fProc.once("error", onFfmpegError);
          }
        } catch (e) {
          cleanup();
          if (e.message?.includes("InvalidState") || e.message?.includes("capture frame")) {
            logger.mediaplayer("[Player] Suppressed InvalidState during stream start");
            return resolve();
          }
          return reject(e);
        }

        const safetyMs = 24 * 60 * 60 * 1000; // 24 hours
        const safetyTimer = setTimeout(() => {
          logger.warn("[Player] Stream safety timeout — advancing queue");
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
          if (e.message?.includes("InvalidState") || e.message?.includes("capture frame")) {
            logger.mediaplayer("[Player] Suppressed InvalidState during playback");
            if (this._streamingStopped) return resolve();
            return;
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
      if (e.message?.includes("InvalidState") || e.message?.includes("capture frame")) {
        logger.mediaplayer("[Player] Suppressed InvalidState in stream setup");
        return;
      }
      if (this._streamingStopped) return;
      throw e;
    }
  }

  async _streamUrl(url) {
    const isNodeLink = url.includes(`${this._nl.host}:${this._nl.port}`) ||
        url.includes("/v4/trackstream");

    if (!isNodeLink) return this._streamViaRevoice(url);

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

  // ═══════════════════════════════════════════════════════════════════════════
  // Voice Connection (revoice.js)
  // ═══════════════════════════════════════════════════════════════════════════

  async join(channelId) {
    if (this._isJoining) {
      logger.player(`[Player] Busy joining. Ignoring: ${channelId}`);
      return;
    }
    if (this.connection && this._channelId === channelId) {
      const state = this.connection.room?.state;
      if (state === 1 || state === "connected") {
        logger.player(`[Player] Already in channel: ${channelId}`);
        return;
      }
      logger.mediaplayer(`[Player] Connection in bad state (${state}), reconnecting...`);
      try { await this.connection.disconnect(); } catch (_) {}
      this.connection = null;
      this._mediaPlayer = null;
    }

    this._isJoining = true;
    try {
      const channel = this.client?.channels?.cache?.get(channelId);
      if (!channel) throw new Error(`Channel not found: ${channelId}`);

      if (this.connection) {
        logger.mediaplayer("[Player] Cleaning up existing connection before join");
        try {
          await this.connection.disconnect();
          await Utils.sleep(500);
        } catch (_) {}
        this.connection  = null;
        this._mediaPlayer = null;
      }

      const connection = await joinVoiceChannel(this.client, channel);
      this.connection = connection;
      this._channelId = channelId;
      this._guildId   = channel.guildId;
      this.leaving    = false;

      const room = connection.room;
      if (room) {
        logger.mediaplayer("[Player] Waiting for LiveKit room to connect...");

        let connected = false;

        if (room.state === "connected" || room.state === 1) {
          logger.mediaplayer("[Player] Room appears connected");
          connected = true;
        } else {
          try {
            await new Promise((resolve, reject) => {
              const timeout = setTimeout(() => {
                room.off("connectionStateChanged", onStateChange);
                reject(new Error("LiveKit connection timeout"));
              }, 15_000);

              const onStateChange = (state) => {
                logger.mediaplayer(`[Player] LiveKit state changed: ${state}`);
                if (state === "connected" || state === 1 || state === "connecting") {
                  clearTimeout(timeout);
                  room.off("connectionStateChanged", onStateChange);
                  connected = true;
                  resolve();
                } else if (state === "disconnected" || state === 0 || state === "failed") {
                  clearTimeout(timeout);
                  room.off("connectionStateChanged", onStateChange);
                  reject(new Error(`LiveKit failed: ${state}`));
                }
              };

              room.on("connectionStateChanged", onStateChange);
            });
          } catch (err) {
            logger.error("[Player] LiveKit connection failed:", err.message);
            throw err;
          }
        }

        await Utils.sleep(300);
        logger.mediaplayer("[Player] Proceeding to create MediaPlayer (trusting connection event)");
      } else {
        throw new Error("No room available after joinVoiceChannel");
      }

      connection.on("error", (err) => {
        const causeStr = err?.cause ? ` (Cause: ${err.cause})` : "";
        logger.error("[Player] Voice error:", err?.message ?? err, causeStr);
        this._cleanupMediaPlayer();
      });

      connection.on("disconnected", () => {
        if (!this.leaving) {
          logger.mediaplayer("[Player] Unexpected disconnect detected");
          this._cleanupMediaPlayer();
          this._recoverConnection();
        } else {
          try { connection.destroy(); } catch (_) {}
        }
      });

      try {
        const vm = getVoiceManager(this.client);
        vm.updateVoiceState(channelId, { self_deaf: true, self_mute: false });
      } catch (e) {
        logger.warn("[Player] Self-deafen failed:", e.message);
      }

      const playerReady = await this._ensureMediaPlayer();
      if (!playerReady) {
        logger.mediaplayer("[Player] First MediaPlayer attempt failed, retrying after delay...");
        await Utils.sleep(1000);
        const retryReady = await this._ensureMediaPlayer();
        if (!retryReady) throw new Error("Failed to create MediaPlayer after retry");
      }

      this._restoreVolume();
      this.emit("roomfetched");
      logger.player(`[Player] Voice connected to ${channel.name}`);

      if (!this.queue.isEmpty() && !this.queue.getCurrent()) {
        this.playNext();
      } else if (this.queue.isEmpty()) {
        setTimeout(() => {
          if (this.queue.isEmpty() && !this.queue.getCurrent()) {
            this._startInactivityTimer();
          }
        }, 3000);
      }

    } catch (e) {
      const causeStr = e.cause ? ` (Cause: ${e.cause})` : "";
      logger.error("[Player] Join failed:", e.message, causeStr);

      if (this.connection) {
        try { this.connection.destroy(); } catch (_) {}
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
      await this._stopMediaPlayer();
      await Utils.sleep(100);
      await this.connection.disconnect();
      this.queue.reset();
      this.connection  = null;
      this._mediaPlayer = null;
      this._paused     = false;
      this._playingNext = false;
      this.leaving     = false;
    } catch (e) {
      logger.error("[Player] leave error:", e.message);
      return false;
    }
    this.emit("leave");
    return true;
  }

  destroy() {
    try {
      if (this._moonlink && this._onMoonlinkReady) {
        try { this._moonlink.off("ready", this._onMoonlinkReady); } catch (_) {}
        this._onMoonlinkReady = null;
      }
      this.leaving          = true;
      this._streamingStopped = true;
      this._stopInactivityTimer();
      this._stopMediaPlayer().catch(() => {}).then(() => {
        setTimeout(() => {
          const disconnectPromise = this.connection?.disconnect?.();
          if (disconnectPromise instanceof Promise) {
            disconnectPromise.catch((err) => {
              logger.error("[Player] Deferred disconnect failed:", err.message);
            });
          }
          this.connection = null;
        }, 100);
      });
    } catch (e) {
      logger.error("[Player] destroy error:", e.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Playback Controls
  // ═══════════════════════════════════════════════════════════════════════════

  get paused() { return this._paused; }

  pause() {
    if (!this.connection || !this.queue.getCurrent())
      return ":negative_squared_cross_mark: There's nothing playing at the moment!";
    if (this._paused)
      return ":negative_squared_cross_mark: Already paused!";
    this._paused = true;
    this._mediaPlayer?.pause();
    this.emit("playback", false);
    this._stopInactivityTimer();
    return ":pause_button: Paused";
  }

  resume() {
    if (!this.connection || !this.queue.getCurrent())
      return ":negative_squared_cross_mark: There's nothing playing at the moment!";
    if (!this._paused)
      return ":negative_squared_cross_mark: Not paused!";
    this._paused = false;
    this._mediaPlayer?.resume();
    this.emit("playback", true);
    this._stopInactivityTimer();
    return ":arrow_forward: Resumed";
  }

  skip() {
    if (!this.connection || !this.queue.getCurrent())
      return ":negative_squared_cross_mark: There's nothing playing at the moment!";
    this._skipping       = true;
    this._radioAnnounced = false;
    this.queue.current   = null;
    this._stopMediaPlayer().then(() => {
      this._playingNext = false;
      this._skipping    = false;
      if (!this.queue.isEmpty() && !this.leaving) this.playNext();
      else {
        this.emit("stopplay");
        if (!this._is247Enabled()) {
          this._startInactivityTimer();
        }
      }
    }).catch(e => logger.error("[Player] skip stop error:", e.message));
    return ":track_next: Skipped";
  }

  skipTo(position) {
    if (!this.connection || !this.queue.getCurrent())
      return ":negative_squared_cross_mark: There's nothing playing at the moment!";
    const idx = position - 1;
    if (idx < 0 || idx >= this.queue.size())
      return `:negative_squared_cross_mark: Position ${position} out of range (queue has ${this.queue.size()} tracks).`;
    this.queue.data.splice(0, idx);
    this.queue.current = null;
    this._skipping     = true;
    this._stopMediaPlayer().then(() => {
      this._playingNext = false;
      this._skipping    = false;
      if (!this.queue.isEmpty() && !this.leaving) this.playNext();
      else {
        this.emit("stopplay");
        if (!this._is247Enabled()) {
          this._startInactivityTimer();
        }
      }
    }).catch(e => logger.error("[Player] skipTo stop error:", e.message));
    return `:track_next: Skipped to position ${position}`;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Volume Control
  // ═══════════════════════════════════════════════════════════════════════════

  setVolume(v) {
    this.preferredVolume = Utils.clamp(v, 0, 1);
    this.emit("volume", this.preferredVolume);
    this._mediaPlayer?.setVolume(this.preferredVolume);
    if (!this.connection)
      return `Volume set to \`${Math.round(this.preferredVolume * 100)}%\` — will apply when connected.`;
    return `Volume changed to \`${Math.round(this.preferredVolume * 100)}%\`.`;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Audio Filter Control (NodeLink PATCH /v4/sessions/:id/players/:guildId)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Apply (or clear) an audio filter by sending a PATCH to NodeLink.
   * Includes encodedTrack so NodeLink doesn't create a ghost player.
   * Uses live session ID from moonlink to avoid stale sessions.
   * Auto-retries once on stale session detection.
   *
   * @param {Object} filterPayload  - Lavalink v4 filters object. Pass {} to clear all filters.
   * @param {{ key: string, label: string, emoji?: string }|null} meta - Filter metadata to store, or null to clear.
   * @returns {Promise<{ ok: boolean, reason?: string }>}
   */
  async applyFilter(filterPayload, meta = null, _retryCount = 0) {
    const guildId = this._guildId;
    if (!guildId) {
      return { ok: false, reason: "Player not bound to a guild." };
    }

    const liveSessionId = this._moonlink?.getLiveSessionId?.() ?? this._moonlink?.sessionId ?? this._nl.sessionId;
    if (!liveSessionId) {
      return { ok: false, reason: "No active NodeLink session. Try again in a few seconds." };
    }

    const { host, port } = this._nl;
    const url = `http://${host}:${port}/v4/sessions/${liveSessionId}/players/${guildId}`;

    const current = this.queue.getCurrent();
    if (!current?.encoded) {
      return { ok: false, reason: "No active track loaded. Start playback first." };
    }

    // Include the current track so NodeLink knows what to keep playing.
    // Use the v4 format: track.encoded (not the deprecated encodedTrack).
    // Also include position so it resumes from where it left off instead of restarting.
    const body = JSON.stringify({
      track: { encoded: current.encoded },
      position: this.startedPlaying ? Date.now() - this.startedPlaying : 0,
      filters: filterPayload,
    });

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
      this.emit("filter", this.activeFilter);
      return { ok: true };
    } catch (e) {
      const errMsg = e.message ?? "";
      if (_retryCount === 0 && (errMsg.includes("404") || errMsg.includes("not found") || errMsg.includes("Session-ID") || errMsg.includes("does not exist"))) {
        logger.warn("[Player] Filter apply failed with stale session, forcing re-sync...");
        const freshSession = this._moonlink?.getLiveSessionId?.() ?? this._moonlink?.sessionId;
        if (freshSession && freshSession !== liveSessionId) {
          this._nl.sessionId = freshSession;
          return this.applyFilter(filterPayload, meta, 1);
        }
      }
      return { ok: false, reason: sanitizeError(errMsg, this._nl) };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Queue Management
  // ═══════════════════════════════════════════════════════════════════════════

  isEmpty()           { return this.queue.isEmpty(); }

  addToQueue(d, t)    {
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

  // ═══════════════════════════════════════════════════════════════════════════
  // Display Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  _createProgressBar(length = 15) {
    const current = this.queue.getCurrent();
    if (!current?.duration || !this.startedPlaying) return Utils.progressBar(0, 1, length);
    const elapsed = Date.now() - this.startedPlaying;
    let totalMs;
    if (typeof current.duration === "object") totalMs = (current.duration.seconds ?? 0) * 1000;
    else if (typeof current.duration === "number") totalMs = current.duration;
    else return Utils.progressBar(0, 1, length);
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
      const elapsed   = Date.now() - this.startedPlaying;
      const durationMs = typeof current.duration === "object"
          ? (current.duration.seconds ?? 0) * 1000
          : current.duration;
      totalMs += Math.max(0, durationMs - elapsed);
    }
    for (const track of this.queue.data) {
      if (!track?.duration) continue;
      if (typeof track.duration === "object" && track.duration?.seconds) totalMs += track.duration.seconds * 1000;
      else if (typeof track.duration === "number") totalMs += track.duration;
    }
    return Utils.prettifyMS(totalMs);
  }

  getCurrentElapsedDuration() {
    if (!this.startedPlaying) return "0:00";
    return Utils.prettifyMS(Date.now() - this.startedPlaying);
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

    const loopqueue = this.queue.loop     ? "**enabled**" : "**disabled**";
    const songloop  = this.queue.songLoop ? "**enabled**" : "**disabled**";
    const vol       = `${Math.round((this.preferredVolume || 1) * 100)}%`;

    const vcLine = this._channelId ? `🔊 **Now playing in:** <#${this._channelId}>\n\n` : "";

    if (current.type === "radio") {
      try {
        const data = await meta(current.url);
        return {
          msg: `${vcLine}📻 Streaming **[${current.title}](${current.author?.url || current.url})**\n\n${current.description || ""}\n\nCurrent song: ${data?.title || "Unknown"}\n\nVolume: ${vol}\n\nQueue loop: ${loopqueue}\nSong loop: ${songloop}`,
          image: current.thumbnail
        };
      } catch {
        return {
          msg: `${vcLine}📻 Streaming **[${current.title}](${current.author?.url || current.url})**\n\nVolume: ${vol}\n\nQueue loop: ${loopqueue}\nSong loop: ${songloop}`,
          image: current.thumbnail
        };
      }
    }

    if (current.type === "external") {
      return {
        msg: `${vcLine}Playing **[${current.title}](${current.url}) by [${current.artist || "Unknown"}](${current.author?.url || ""})**\n\nVolume: ${vol}\n\nQueue loop: ${loopqueue}\nSong loop: ${songloop}`,
        image: current.thumbnail
      };
    }

    return {
      msg: `${vcLine}🎵 Playing: **[${current.title}](${current.spotifyUrl || current.url})** (${this.getCurrentElapsedDuration()}/${this.getCurrentDuration()})\n\nVolume: ${vol}\n\nQueue loop: ${loopqueue}\nSong loop: ${songloop}`,
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

  announceSong(s) {
    if (!s) return;

    const inVC = this._channelId ? ` in <#${this._channelId}>` : "";

    if (s.type === "radio") {
      this.emit("message", mkEmbed(`📻 Now streaming _${Utils.escapeMarkdown(s.title)}_ by [${s.author?.name || "Unknown"}](${s.author?.url || ""})${inVC}`))
      return;
    }
    const author = s.artists
        ? s.artists.map(a => a.url ? `[${a.name}](${a.url})` : a.name).join(" & ")
        : s.author?.url
            ? `[${s.author.name}](${s.author.url})`
            : s.author?.name || "Unknown";
    this.emit("message", mkEmbed(`🎵 Now playing [${Utils.escapeMarkdown(s.title)}](${s.spotifyUrl || s.url}) by ${author}${inVC}`))
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Worker Management
  // ═══════════════════════════════════════════════════════════════════════════

  workerJob(jobId, data, onMessage = null) {
    const workerPath = new URL("./worker.mjs", import.meta.url);
    const worker = new Worker(workerPath, {
      workerData: {
        jobId,
        data: {
          ...data,
          nodelink: this._nl,
          guildId:  this._guildId,
        }
      }
    });

    const job = new Promise((resolve, reject) => {
      worker.on("message", (raw) => {
        const parsed = Utils.safeJsonParse(raw);
        if (!parsed) { reject(new Error("Invalid worker message")); return; }
        if      (parsed.event === "error")    reject(parsed.data);
        else if (parsed.event === "message" && onMessage) onMessage(parsed.data);
        else if (parsed.event === "finished") resolve(parsed.data);
      });
      worker.on("error", reject);
      worker.on("exit", (code) => { if (code !== 0) reject(new Error(`Worker exited ${code}`)); });
    });

    const raced = Utils.timeout(job, 60_000, "Worker timeout after 60s");

    // Absorb any late "error" events emitted after the timeout has already settled
    // the promise.  Without this no-op, a worker error arriving post-timeout produces
    // an unhandled rejection / uncaughtException on some Node versions.
    worker.on("error", () => {});

    return raced.finally(() => worker.terminate().catch(() => {}));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Public Play Methods
  // ═══════════════════════════════════════════════════════════════════════════

  async fetchResults(query, id, provider = "ytm") {
    try {
      const data = await this.workerJob("searchResults", { query, provider, resultCount: this.resultLimit });
      let list = `Search results using **${PROVIDER_NAMES[provider] || "YouTube Music"}**:\n\n`;
      data.data.forEach((v, i) => {
        const url   = v.url || "";
        const title = v.title || Utils.formatTrackInfo(v, false);
        const dur   = v.duration ? this.getDuration(v.duration) : "?:??";
        list += `${i + 1}. [${title}](${url}) - ${dur}\n`;
      });
      list += "\nSend the number of the result. Example: `2`\nSend 'x' to cancel.";

      // LRU eviction: Map preserves insertion order; the first key() is always the oldest.
      // This avoids the ghost-key bug that existed when _searchOrder tracked keys separately
      // from the Map — playResult() could remove a key from searches but leave it in the
      // order array, causing the eviction to silently skip the true oldest live entry.
      if (this.searches.size >= this._searchMaxSize) {
        const oldestKey = this.searches.keys().next().value;
        if (oldestKey !== undefined) this.searches.delete(oldestKey);
      }
      this.searches.set(id, data.data);

      return { m: list, count: data.data.length };
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
      this.playNext();
    }
    return res;
  }

  playFirst(query, provider) { return this.play(query, true, provider); }

  play(query, top = false, provider) {
    const events = new EventEmitter();
    this.workerJob("generalQuery", { query, provider }, (msg) => events.emit("message", msg))
        .then((data) => {
          if (!data) {
            logger.worker("[Player] Worker returned empty result");
            events.emit("message", "Could not load track - no data returned.");
            return;
          }

          if (data.type === "error") {
            logger.worker("[Player] Worker returned error:", data.error);
            events.emit("message", sanitizeError(data.error, this._nl) || "Failed to load track.");
            return;
          }

          if (data.type === "list") {
            this.addManyToQueue(data.data, top);
          } else if (data.type === "video") {
            this.addToQueue(data.data, top);
          } else {
            logger.worker("[Player] Unknown worker result:", data);
            events.emit("message", "Unexpected result from track loader.");
            return;
          }

          if (!this.queue.getCurrent()) {
            this.playNext();
          }
        })
        .catch((reason) => {
          logger.error("[Player] Worker job failed:", reason);
          events.emit("message", sanitizeError(reason?.message, this._nl) || "An error occurred while loading the track.");
        });
    return events;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Radio track builder
  // ═══════════════════════════════════════════════════════════════════════════

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
    if (!this.queue.getCurrent()) this.playNext();
  }

  async switchRadio(radio) {
    if (!radio?.url) { logger.error("[Player] switchRadio: invalid radio data"); return; }

    const newTrack = this._buildRadioTrack(radio);
    this.queue.data = this.queue.data.filter(t => t.type !== "radio");

    if (!this.queue.getCurrent()) {
      this.queue.add(newTrack);
      this.playNext();
      return;
    }

    this.queue.data.unshift(newTrack);
    this._skipping       = true;
    this._radioAnnounced = false;
    this.queue.current   = null;
    await this._stopMediaPlayer();
    this._playingNext = false;
    this._skipping    = false;
    if (!this.leaving) this.playNext();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Core Playback
  // ═══════════════════════════════════════════════════════════════════════════

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
        await this._mediaPlayer.stop();
      } catch (_) {}
    }

    this._streamingStopped = false;

    const songData = this.queue.next();
    if (!songData) {
      this.emit("stopplay");

      if (!this._is247Enabled()) {
        this._startInactivityTimer();
      } else {
        logger.voice247("[Player] 24/7 enabled, staying in channel");
      }

      if (!this._wasRadio) {
        const prefix = (() => {
          try {
            return this.settingsMgr?.getServer?.(this._guildId)?.get?.("prefix")
                ?? this.settings?.get?.("prefix")
                ?? "%";
          } catch (_) { return "%"; }
        })();
        this.emit("message", mkEmbed(`🎵 The queue has ended — nothing left to play. Add more songs with \`${prefix}play\`!`));
      }
      this._wasRadio = false;
      return;
    }

    this._stopInactivityTimer();
    this._wasRadio = songData.type === "radio";

    if (!this.connection || this.leaving) return;

    const room = this.connection.room;
    if (!room || room.state === "disconnected" || room.state === 0) {
      logger.mediaplayer("[Player] Room disconnected, recovering connection before playing.");
      if (songData) {
        this.queue.data.unshift(songData);
        this.queue.current = null;
        this._playingNext = false;
      }
      this._recoverConnection();
      return;
    }

    const hasValidPlayer = await this._ensureMediaPlayer();
    if (!hasValidPlayer) {
      logger.error("[Player] Failed to create healthy MediaPlayer — cannot play.");
      this.emit("message", mkEmbed(":x: Voice connection lost. Please rejoin."))

      if (!this._is247Enabled()) {
        this._startInactivityTimer();
      }
      return;
    }

    if (this._mediaPlayer && this.preferredVolume !== 1) {
      this._mediaPlayer.setVolume(this.preferredVolume);
    }

    await Utils.sleep(200);
    if (!this.connection || this.leaving) return;

    let streamUrl = null;

    if (songData.type === "radio" || songData.type === "external") {
      streamUrl = songData.url;
    } else if (songData.encoded) {
      const nlBase = `http://${this._nl.host}:${this._nl.port}`;
      const sessionParam = this._nl.sessionId ? `&sessionId=${encodeURIComponent(this._nl.sessionId)}` : "";
      const guildParam   = this._guildId      ? `&guildId=${this._guildId}`                            : "";
      streamUrl = `${nlBase}/v4/trackstream?encodedTrack=${encodeURIComponent(songData.encoded)}${guildParam}${sessionParam}`;
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
      this.emit("message", mkEmbed(`:x: Could not get stream URL for **${songData.title}** — skipping...`))
      this._playingNext    = false;
      this._streamingStopped = false;
      this.playNext();
      return;
    }

    logger.player(`[Player:${this._guildId}] Streaming: ${songData.title}`);
    this.startedPlaying = Date.now();
    this._paused        = false;
    if (songData.type !== "radio" || !this._radioAnnounced) {
      this.announceSong(songData);
      if (songData.type === "radio") this._radioAnnounced = true;
    }
    this.emit("startplay", songData);

    try {
      await Utils.retry(() => this._streamUrl(streamUrl), 2, 1000);
    } catch (err) {
      logger.error("[Player] Stream error:", err.message);
      this._streamingStopped = true;
      if (!this._skipping && !this.leaving && !this._paused) {
        if (songData.type !== "radio") {
          this.emit("message", mkEmbed(`:x: Error streaming **${songData.title}** — skipping...`))
        }
      }
    }

    if (!this.leaving && !this._skipping) {
      if (songData.type === "radio") {
        this.queue.data.unshift(songData);
        this.queue.current = null;
        this._streamingStopped = false;
        this._playingNext      = false;
        await Utils.sleep(1500);
        if (!this.leaving && !this._skipping) this.playNext();
      } else {
        if (!this._paused) {
          if (!this.queue.songLoop) this.queue.current = null;
          this._streamingStopped = false;
          this._playingNext      = false;
          this.playNext();
        }
      }
    }
    this._skipping = false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Lyrics
  // ═══════════════════════════════════════════════════════════════════════════

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