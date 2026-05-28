/**
 * FluxerRevoice.mjs — Revoice-compatible adapter that uses the Fluxer API
 *
 * This module provides the same interface as revoice.js's `Revoice` class
 * but uses the Fluxer gateway (via @fluxerjs/voice) to obtain LiveKit
 * credentials instead of POSTing to a third-party REST API.
 *
 * Why this exists:
 *   revoice.js internally calls `POST /channels/{id}/join_call` on
 *   a third-party API with an `X-Bot-Token` header.  A Fluxer
 *   bot token is NOT valid on that API, resulting in a 401.
 *   Fluxer's voice join flow instead uses the gateway WebSocket:
 *     1. Bot sends VOICE_STATE_UPDATE opcode
 *     2. Gateway responds with VOICE_STATE_UPDATE (ack)
 *     3. Gateway sends VOICE_SERVER_UPDATE with { endpoint, token }
 *     4. The endpoint/token are LiveKit credentials
 *
 * This adapter wraps @fluxerjs/voice's `joinVoiceChannel()` and returns
 * a `FluxerVoiceConnection` that is API-compatible with revoice.js's
 * `VoiceConnection`, so Player.mjs and MediaPlayer work unchanged.
 *
 * IMPORTANT: @livekit/rtc-node (Node.js SDK) does NOT have `room.state`.
 *   ✅ room.isConnected      — boolean getter (true when connected)
 *   ✅ room.connectionState  — ConnectionState enum getter
 *     (CONN_DISCONNECTED = 0, CONN_CONNECTED = 1, CONN_RECONNECTING = 2)
 *   ❌ room.state            — does NOT exist (that's the browser SDK API)
 */

import { EventEmitter } from "node:events";
import { joinVoiceChannel, getVoiceManager } from "@fluxerjs/voice";

export const ConnectionState = Object.freeze({
  CONN_DISCONNECTED: 0,
  CONN_CONNECTED:   1,
  CONN_RECONNECTING: 2,
});

export const LKRoomEvent = Object.freeze({
  ConnectionStateChanged:  "connectionStateChanged",
  Disconnected:           "disconnected",
  ParticipantConnected:   "participantConnected",
  ParticipantDisconnected:"participantDisconnected",
});

/** @deprecated Use LKRoomEvent instead — kept for backward compat within this file */
const RoomEvent = LKRoomEvent;

import { logger } from "./Logger.mjs";

{
  if (!globalThis.__fluxerLiveKitLogPatchApplied) {
    globalThis.__fluxerLiveKitLogPatchApplied = true;

    const _originalConsoleLog = console.log;
    console.log = function (...args) {
      if (args.length === 1 && typeof args[0] === "string" && args[0].startsWith("{")) {
        try {
          const parsed = JSON.parse(args[0]);
          if (parsed.name === "lk-rtc") return;
        } catch (_) {
        }
      }
      if (args.length >= 1 && typeof args[0] === "string" && args[0].includes("[voice LiveKitRtc]")) {
        return;
      }
      _originalConsoleLog.apply(console, args);
    };

    const _originalStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = function (chunk, encoding, callback) {
      if (typeof chunk === "string" && chunk.startsWith("{")) {
        try {
          if (chunk.includes('"lk-rtc"')) {
            const parsed = JSON.parse(chunk);
            if (parsed.name === "lk-rtc") {
              if (typeof encoding === "function") { encoding(); }
              else if (typeof callback === "function") { callback(); }
              return true;
            }
          }
        } catch (_) {
        }
      }
      return _originalStdoutWrite(chunk, encoding, callback);
    };
  }
}

/** Helper: returns a human-readable label for a ConnectionState value */
function stateLabel(cs) {
  if (cs === ConnectionState?.CONN_CONNECTED) return "CONN_CONNECTED";
  if (cs === ConnectionState?.CONN_DISCONNECTED) return "CONN_DISCONNECTED";
  if (cs === ConnectionState?.CONN_RECONNECTING) return "CONN_RECONNECTING";
  if (cs === 1) return "CONN_CONNECTED(1)";
  if (cs === 0) return "CONN_DISCONNECTED(0)";
  if (cs === 2) return "CONN_RECONNECTING(2)";
  return String(cs);
}

/**
 * A voice connection that wraps a LiveKit Room obtained via the Fluxer
 * gateway.  Exposes the same interface as revoice.js's VoiceConnection:
 *
 *   .room        — LiveKit Room
 *   .channelId   — the voice channel ID
 *   .connected   — boolean (getter, reads from room.isConnected)
 *   .users       — array (minimal; real tracking is via observedVoiceUsers)
 *   .disconnect() — tear down the LiveKit connection
 *   .leave()     — alias for disconnect()
 *   Events: "disconnect", "error", "autoleave"
 */
export class FluxerVoiceConnection extends EventEmitter {
  /** @type {any} LiveKit Room instance from @fluxerjs/voice */
  room        = null;
  channelId   = null;
  _voice      = null;
  _connected  = false;
  _users      = [];
  _destroyed  = false;

  _nativeConn = null;

  /**
   * Users currently in this voice channel.
   * Derived from the parent FluxerRevoice's unified users map (single source of truth).
   * This prevents the old divergence bug where the array and Map could get out of sync.
   */
  get users() {
    return this._users;
  }

  set users(val) {
    this._users = Array.isArray(val) ? val : [];
  }

  constructor(channelId, voice, opts = {}) {
    super();
    this.channelId = channelId;
    this._voice    = voice;
    this.room      = opts.room ?? null;
    this._nativeConn = opts.nativeConnection ?? null;
    this._connected = !!(this.room && this.room.isConnected);
  }

  /**
   * Whether this connection is currently alive.
   * Reads from the LiveKit Room's `isConnected` boolean getter,
   * which is the correct API in @livekit/rtc-node (Node.js SDK).
   */
  get connected() {
    if (this._destroyed) return false;
    if (this.room) return this.room.isConnected;
    return this._connected;
  }

  set connected(val) {
    this._connected = !!val;
  }

  /**
   * Disconnect from the voice channel.
   * Tries the @fluxerjs/voice native disconnect first, then falls back
   * to closing the LiveKit Room directly.
   */
  async disconnect() {
    if (this._destroyed) return;
    if (this._voice && this.channelId) {
      this._voice.markIntentionalDisconnect(this.channelId);
      const guildId = this._voice._resolveGuildForChannel?.(this.channelId) ?? null;
      this._voice._leaveGateway?.(this.channelId, guildId);
    }
    this._destroyed = true;
    this._connected = false;

    if (this.room) {
      try {
        await this.room.disconnect();
      } catch (e) {
      }
    } else if (this._nativeConn && typeof this._nativeConn.disconnect === "function") {
      try {
        await this._nativeConn.disconnect();
      } catch (e) {
        logger.warn("[FluxerVoiceConnection] Native disconnect error:", e?.message);
      }
    }

    this.emit("disconnect");
    this.removeAllListeners();
  }

  /**
   * Leave — alias for disconnect (matches revoice.js VoiceConnection API).
   */
  async leave() {
    return this.disconnect();
  }
}

/**
 * Revoice-compatible class that uses the Fluxer gateway for voice joins.
 *
 * Usage (drop-in for `new Revoice(token)`):
 *
 *
 *   this.revoice = new Revoice(config.token);
 *
 *
 *   this.revoice = new FluxerRevoice(client);
 */
export class FluxerRevoice extends EventEmitter {
  /** @type {import("@fluxerjs/core").Client} */
  client       = null;
  connections  = new Map();
  users        = new Map();

  /** @type {Map<string, Promise>} */
  _guildJoinQueue = new Map();

  /** @type {Promise} Global join serializer — only one join at a time across all guilds */
  _globalJoinQueue = Promise.resolve();
  /** @type {number} Minimum delay between ANY two joins (ms), even across guilds.
   *  This delay runs AFTER the previous join completes and BEFORE the next
   *  one starts, giving the Fluxer gateway time to clean up the previous
   *  voice session. */
  _globalJoinDelay = 1500;

  /** @type {Set<string>} Channel IDs where disconnect is expected (bot-initiated) */
  _intentionalDisconnects = new Set();

  /** @type {FluxerRevoice|null} Singleton instance */
  static _instance = null;

  /**
   * Get or create the singleton FluxerRevoice instance.
   * @param {import("@fluxerjs/core").Client} client
   * @returns {FluxerRevoice}
   */
  static getInstance(client) {
    if (!FluxerRevoice._instance) {
      FluxerRevoice._instance = new FluxerRevoice(client);
    }
    return FluxerRevoice._instance;
  }

  constructor(client) {
    super();
    if (FluxerRevoice._instance) {
      logger.warn(
        `[FluxerRevoice] Duplicate instance creation detected! ` +
        `Use FluxerRevoice.getInstance() instead of new FluxerRevoice(). ` +
        `Stack: ${new Error().stack?.split('\n').slice(2, 5).join(' | ')}`
      );
    } else {
      FluxerRevoice._instance = this;
    }
    if (!client) throw new Error("FluxerRevoice requires a Fluxer client instance");
    this.client = client;
    logger.player("[FluxerRevoice] Instance created with Fluxer client.");
  }

  /**
   * Mark a channel as expecting an intentional disconnect so the
   * RoomEvent.Disconnected handler can log it correctly.
   * @param {string} channelId
   */
  markIntentionalDisconnect(channelId) {
    this._intentionalDisconnects.add(String(channelId));
    setTimeout(() => this._intentionalDisconnects.delete(String(channelId)), 10_000);
  }

  /**
   * Send a VOICE_STATE_UPDATE leave signal to the Fluxer gateway so it
   * knows the bot is no longer in the given channel.  Without this, the
   * gateway may think the bot is still connected and won't send a fresh
   * VOICE_SERVER_UPDATE on the next joinVoiceChannel() call, causing the
   * rejoin to hang or fail.
   *
   * IMPORTANT: We try channel-specific leave (leaveChannel) FIRST because
   * vm.leave(guildId) disconnects ALL voice channels in that guild, which
   * is catastrophic for multi-voice setups where the bot is in multiple
   * channels with 24/7 enabled.  Only fall back to guild-level leave if
   * the channel-specific API is unavailable.
   *
   * @param {string} channelId — The channel ID to leave
   * @param {string} [guildId] — The guild ID (for fallback)
   */
  _leaveGateway(channelId, guildId = null) {
    try {
      const vm = getVoiceManager(this.client);
      if (!vm) return;

      const guildForLeave = guildId ?? this._resolveGuildForChannel(channelId);

      if (typeof vm.leaveChannel === "function") {
        try {
          vm.leaveChannel(channelId);
          logger.player(`[FluxerRevoice] Sent channel-specific gateway leave via vm.leaveChannel() for channel ${channelId}`);
          return;
        } catch (e) {
          logger.warn(`[FluxerRevoice] vm.leaveChannel() failed for channel ${channelId}: ${e?.message} — falling back`);
        }
      }

      if (guildForLeave && typeof vm.leave === "function") {
        try {
          vm.leave(guildForLeave);
          logger.player(`[FluxerRevoice] Sent guild-level gateway leave via vm.leave() for guild ${guildForLeave} (leaveChannel unavailable — other channels may be disconnected)`);
          return;
        } catch (e) {
          logger.warn(`[FluxerRevoice] vm.leave() failed for guild ${guildForLeave}: ${e?.message}`);
        }
      }

      if (typeof vm.updateVoiceState === "function") {
        if (guildForLeave) {
          try {
            vm.updateVoiceState(guildForLeave, null, { self_deaf: false, self_mute: false });
            logger.player(`[FluxerRevoice] Sent gateway leave via updateVoiceState() for guild ${guildForLeave}`);
            return;
          } catch (e1) {
            try { vm.updateVoiceState(guildForLeave, null); return; } catch (e2) {}
          }
        }
        logger.warn(
          `[FluxerRevoice] Cannot send guild-scoped leave for channel ${channelId} — ` +
          `skipping leave signal to avoid disconnecting all guilds.`
        );
      }
    } catch (e) {
      logger.warn(`[FluxerRevoice] Gateway leave signal failed for ${channelId}: ${e?.message}`);
    }
  }

  /**
   * Resolve the guild ID for a given channel ID from the client cache.
   * @param {string} channelId
   * @returns {string|null}
   */
  _resolveGuildForChannel(channelId) {
    try {
      const ch = this.client.channels?.get?.(channelId);
      return ch?.guildId ?? ch?.guild?.id ?? null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Fully tear down a stale FluxerVoiceConnection: disconnect the native
   * @fluxerjs/voice connection, close the LiveKit room, remove from the
   * connections map, and send a gateway leave signal.
   *
   * @param {string} channelId
   * @param {FluxerVoiceConnection} existing
   */
  async _destroyStaleConnection(channelId, existing) {
    this.connections.delete(channelId);
    this.markIntentionalDisconnect(channelId);
    const staleGuildId = this._resolveGuildForChannel(channelId);
    this._leaveGateway(channelId, staleGuildId);

    if (existing.room) {
      try {
        await existing.room.disconnect();
      } catch (_) {
      }
    } else if (existing._nativeConn && typeof existing._nativeConn.disconnect === "function") {
      try {
        await existing._nativeConn.disconnect();
      } catch (e) {
        logger.warn(`[FluxerRevoice] Stale native disconnect error for ${channelId}: ${e?.message}`);
      }
    }

    existing._destroyed = true;
    existing._connected = false;
    try { existing.removeAllListeners(); } catch (_) {}
  }

  /**
   * Join a voice channel using the Fluxer gateway.
   *
   * This sends a VOICE_STATE_UPDATE through the Fluxer gateway, receives
   * VOICE_SERVER_UPDATE with LiveKit credentials, then connects to the
   * LiveKit room — the same flow @fluxerjs/voice uses internally.
   *
   * @param {string} channelId — The voice channel ID to join
   * @param {boolean} [_leaveIfEmpty=false] — Not used (compatibility param)
   * @returns {Promise<FluxerVoiceConnection>}
   */
  async join(channelId, _leaveIfEmpty = false) {
    const joinOperation = async () => {
      await new Promise(r => setTimeout(r, this._globalJoinDelay));
      return await this._joinInternal(channelId, _leaveIfEmpty);
    };

    const prevQueue = this._globalJoinQueue;
    const ourResult = prevQueue.then(() => joinOperation());
    this._globalJoinQueue = ourResult.catch(() => {});
    return await ourResult;
  }

  /**
   * Internal join implementation — called by join() through the global queue.
   * Do NOT call this directly; always use join() to ensure serialization.
   *
   * @param {string} channelId
   * @param {boolean} _leaveIfEmpty
   * @returns {Promise<FluxerVoiceConnection>}
   */
  async _joinInternal(channelId, _leaveIfEmpty = false) {
    let guildId = null;
    try {
      const ch = this.client.channels?.get?.(channelId);
      guildId = ch?.guildId ?? ch?.guild?.id ?? null;
    } catch (_) {}

    if (this.connections.has(channelId)) {
      const existing = this.connections.get(channelId);
      if (existing && !existing._destroyed && existing.room && existing.room.isConnected) {
        logger.player(`[FluxerRevoice] Already connected to ${channelId}, returning existing connection`);
        return existing;
      }
      logger.player(
        `[FluxerRevoice] Stale connection for ${channelId} ` +
        `(isConnected: ${existing?.room?.isConnected ?? false}, ` +
        `destroyed: ${existing?._destroyed ?? true}) — cleaning up and rejoining`
      );
      await this._destroyStaleConnection(channelId, existing);
    }

    logger.player(`[FluxerRevoice] Joining channel ${channelId} via Fluxer gateway...`);

    let channel = this.client.channels?.get?.(channelId);
    if (!channel) {
      try {
        channel = await this.client.channels.fetch(channelId);
      } catch (e) {
        throw new Error(`Could not fetch channel ${channelId}: ${e.message}`);
      }
    }
    if (!channel) {
      throw new Error(`Channel not found: ${channelId}`);
    }

    const channelGuildId = guildId ?? channel?.guildId ?? channel?.guild?.id ?? null;

    let nativeConnection;
    try {
      nativeConnection = await joinVoiceChannel(this.client, channel);
    } catch (e) {
      throw new Error(`Fluxer voice join failed for ${channelId}: ${e.message}`);
    }

    if (!nativeConnection) {
      throw new Error(`Fluxer voice join returned null for ${channelId}`);
    }

    logger.player(`[FluxerRevoice] Gateway join successful for ${channelId}`);

    let room = null;

    if (nativeConnection.room) {
      room = nativeConnection.room;
      logger.player(`[FluxerRevoice] Got LiveKit room from native connection (isConnected: ${room.isConnected}, connectionState: ${stateLabel(room.connectionState)})`);
    }

    if (!room) {
      try { await nativeConnection.disconnect(); } catch (_) {}
      throw new Error(
        `Fluxer voice connection for ${channelId} does not expose a LiveKit Room. ` +
        `Music playback requires a LiveKit-based voice server.`
      );
    }

    const maxWait = 10_000;
    const startTime = Date.now();

    if (!room.isConnected) {
      let eventResolved = false;
      const statePromise = new Promise((resolve) => {
        const handler = (cs) => {
          if (eventResolved) return;
          if (cs === ConnectionState?.CONN_CONNECTED || cs === 1) {
            eventResolved = true;
            room.off(RoomEvent.ConnectionStateChanged, handler);
            resolve();
          } else if (cs === ConnectionState?.CONN_DISCONNECTED || cs === 0) {
            eventResolved = true;
            room.off(RoomEvent.ConnectionStateChanged, handler);
            resolve();
          }
        };
        room.on(RoomEvent.ConnectionStateChanged, handler);
      });

      while (!room.isConnected && (Date.now() - startTime) < maxWait) {
        await Promise.race([
          statePromise,
          new Promise(r => setTimeout(r, 200)),
        ]);

        if (room.isConnected) break;

        const cs = room.connectionState;
        if (cs === ConnectionState?.CONN_DISCONNECTED || cs === 0) break;
      }
    }

    const finalConnected = room.isConnected;
    const finalCS = room.connectionState;

    if (!finalConnected && (finalCS === ConnectionState?.CONN_DISCONNECTED || finalCS === 0)) {
      try { await nativeConnection.disconnect(); } catch (_) {}
      throw new Error(`LiveKit room in disconnected state: ${stateLabel(finalCS)}`);
    }

    logger.player(`[FluxerRevoice] LiveKit room ready (isConnected: ${finalConnected}, connectionState: ${stateLabel(finalCS)})`);

    const connection = new FluxerVoiceConnection(channelId, this, {
      room,
      nativeConnection,
    });

    room.on(RoomEvent.ConnectionStateChanged, (cs) => {
      if (cs === ConnectionState.CONN_RECONNECTING || cs === 2) {
        logger.player(`[FluxerRevoice] Room reconnecting for channel ${channelId}`);
      } else if (cs === ConnectionState.CONN_CONNECTED || cs === 1) {
        if (connection._destroyed) return;
        connection._connected = true;
        logger.player(`[FluxerRevoice] Room (re)connected for channel ${channelId}`);
      }
    });

    room.on(RoomEvent.Disconnected, (reason) => {
      const isIntentional = this._intentionalDisconnects.has(String(channelId));
      const reasonLabel = isIntentional ? "intentional" : (reason ?? "unexpected");
      logger.player(`[FluxerRevoice] Room disconnected: ${reasonLabel}`);
      this._intentionalDisconnects.delete(String(channelId));
      connection._connected = false;
      connection._destroyed = true;

      this.connections.delete(channelId);

      if (!isIntentional) {
        this._leaveGateway(channelId, channelGuildId);

        if (nativeConnection && typeof nativeConnection.disconnect === "function") {
          try { nativeConnection.disconnect(); } catch (_) {}
        }
      }

      connection.emit("disconnect");
    });

    room.on(RoomEvent.ParticipantConnected, (participant) => {
      const userId = participant?.identity ?? participant?.sid;
      if (userId) {
        const uKey = `${channelId}:${userId}`;
        this.users.set(uKey, { id: userId, connectedTo: channelId });
        connection._users = [...this.users.values()].filter(u => u.connectedTo === channelId);
        connection.emit("userjoin", userId);
      }
    });

    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      const userId = participant?.identity ?? participant?.sid;
      if (userId) {
        const uKey = `${channelId}:${userId}`;
        this.users.delete(uKey);
        connection._users = [...this.users.values()].filter(u => u.connectedTo === channelId);
        connection.emit("userleave", userId);
      }
    });

    this.connections.set(channelId, connection);

    if (_leaveIfEmpty) {
      connection.on("userleave", () => {
        const remoteCount = room.remoteParticipants?.size ?? 0;
        if (remoteCount === 0) {
          logger.player(`[FluxerRevoice] Room empty, triggering autoleave for ${channelId}`);
          connection.emit("autoleave");
          this.connections.delete(channelId);
        }
      });
    }

    return connection;
  }

  /**
   * Delete a connection from the map (called during player leave/cleanup).
   * @param {string} channelId
   */
  deleteConnection(channelId) {
    this.connections.delete(channelId);
  }
}
