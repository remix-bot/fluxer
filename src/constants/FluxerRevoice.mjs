/**
 * @file FluxerRevoice.mjs — FluxerRevoice — voice connection adapter that bridges Fluxer gateway with LiveKit rooms, replacing revoice.js API calls
 * @module src.constants.FluxerRevoice
 */

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
 * This adapter wraps @fluxerjs/voice's VoiceManager.join() and returns
 * a `FluxerVoiceConnection` that is API-compatible with revoice.js's
 * `VoiceConnection`, so Player.mjs and MediaPlayer work unchanged.
 *
 * Reference: https://fluxer.js.org/v/latest/guides/voice
 *
 * IMPORTANT: @livekit/rtc-node (Node.js SDK) does NOT have `room.state`.
 *   ✅ room.isConnected      — boolean getter (true when connected)
 *   ✅ room.connectionState  — ConnectionState enum getter
 *     (CONN_DISCONNECTED = 0, CONN_CONNECTED = 1, CONN_RECONNECTING = 2)
 *   ❌ room.state            — does NOT exist (that's the browser SDK API)
 */

import { EventEmitter } from "node:events";
import { getVoiceManager } from "@fluxerjs/voice";
import { cleanId } from "../Utils.mjs";

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

import { logger } from "./Logger.mjs";

/**
 * LiveKit log filter — intercepts LiveKit SDK noise without monkey-patching
 * console.log or process.stdout globally.  Applied per-room by setting
 * the room's logger to a filtered version.
 */
const LIVEKIT_LOG_PREFIXES = ["[voice LiveKitRtc]", "lk-rtc"];

function isLiveKitLogMessage(...args) {
  if (args.length === 1 && typeof args[0] === "string") {
    if (args[0].startsWith("{")) {
      try {
        const parsed = JSON.parse(args[0]);
        if (parsed.name === "lk-rtc") return true;
      } catch (e) { logger.warn("[FluxerRevoice] Error parsing livekit args:", e?.message); }
    }
    if (LIVEKIT_LOG_PREFIXES.some(p => args[0].includes(p))) return true;
  }
  return false;
}

/**
 * Temporarily suppress LiveKit SDK log noise during room setup.
 * Unlike the old global monkey-patch, this is scoped to a callback
 * and restores the original console.log when done.
 */
function withSuppressedLiveKitLogs(fn) {
  const origLog = console.log;
  console.log = function (...args) {
    if (isLiveKitLogMessage(...args)) return;
    origLog.apply(console, args);
  };
  try {
    return fn();
  } finally {
    console.log = origLog;
  }
}

/** Helper: returns a human-readable label for a ConnectionState value */
function stateLabel(cs) {
  if (cs === ConnectionState.CONN_CONNECTED) return "CONN_CONNECTED";
  if (cs === ConnectionState.CONN_DISCONNECTED) return "CONN_DISCONNECTED";
  if (cs === ConnectionState.CONN_RECONNECTING) return "CONN_RECONNECTING";
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
        logger.warn("[FluxerVoiceConnection] Room disconnect error:", e?.message);
      }
    }
    if (this._nativeConn && typeof this._nativeConn.disconnect === "function") {
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

  /** @type {Map<string, NodeJS.Timeout>} Per-channel timeout tokens for intentional disconnect marks */
  _intentionalDisconnectTokens = new Map();

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
    if (FluxerRevoice._instance && FluxerRevoice._instance !== this) {
      logger.warn(
        `[FluxerRevoice] Duplicate instance detected! Use FluxerRevoice.getInstance().`
      );
    }
    if (!client) throw new Error("FluxerRevoice requires a Fluxer client instance");
    this.client = client;
    if (!FluxerRevoice._instance) FluxerRevoice._instance = this;
    logger.player("[FluxerRevoice] Instance created with Fluxer client.");
  }

  /**
   * Mark a channel as expecting an intentional disconnect so the
   * LKRoomEvent.Disconnected handler can log it correctly.
   * @param {string} channelId
   */
  markIntentionalDisconnect(channelId) {
    const key = String(channelId);
    this._intentionalDisconnects.add(key);
    const prev = this._intentionalDisconnectTokens.get(key);
    if (prev) clearTimeout(prev);
    this._intentionalDisconnectTokens.set(key, setTimeout(() => {
      this._intentionalDisconnects.delete(key);
      this._intentionalDisconnectTokens.delete(key);
    }, 10_000));
    const cleanChannelId = cleanId(key);
    if (this.client?._remix?.intentionalLeaves && !this.client._remix.intentionalLeaves.has(cleanChannelId)) {
      this.client._remix.intentionalLeaves.set(cleanChannelId, setTimeout(() => {
        this.client._remix.intentionalLeaves.delete(cleanChannelId);
      }, 10_000));
    }
  }

  /**
   * Send a channel-specific leave signal to the Fluxer gateway so it
   * knows the bot is no longer in the given channel. Without this, the
   * gateway may think the bot is still connected and won't send a fresh
   * VOICE_SERVER_UPDATE on the next VoiceManager.join() call, causing the
   * rejoin to hang or fail.
   *
   * IMPORTANT: Only uses channel-specific leave (vm.leaveChannel).
   * Guild-level leave (vm.leave / vm.updateVoiceState with null channel)
   * disconnects ALL voice channels in that guild, which is catastrophic
   * for multi-voice setups where the bot is in multiple channels with
   * 24/7 enabled. If vm.leaveChannel is unavailable, the gateway leave
   * is skipped entirely rather than risk disconnecting other channels.
   *
   * @param {string} channelId — The channel ID to leave
   * @param {string} [guildId] — Unused, kept for API compatibility
   */
  _leaveGateway(channelId, guildId = null) {
    try {
      const vm = getVoiceManager(this.client);
      if (!vm) return;

      if (typeof vm.leaveChannel === "function") {
        try {
          vm.leaveChannel(channelId);
          logger.player(`[FluxerRevoice] Sent channel-specific gateway leave via vm.leaveChannel() for channel ${channelId}`);
          return;
        } catch (e) {
          logger.warn(`[FluxerRevoice] vm.leaveChannel() failed for channel ${channelId}: ${e?.message}`);
        }
      }

      logger.warn(
        `[FluxerRevoice] No channel-specific leave API available for channel ${channelId}. ` +
        `Skipping gateway leave to avoid disconnecting other voice channels in the guild.`
      );
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
      } catch (e) {
        logger.warn("[FluxerRevoice] Stale room disconnect error:", e?.message);
      }
    }
    if (existing._nativeConn && typeof existing._nativeConn.disconnect === "function") {
      try {
        await existing._nativeConn.disconnect();
      } catch (e) {
        logger.warn(`[FluxerRevoice] Stale native disconnect error for ${channelId}: ${e?.message}`);
      }
    }

    existing._destroyed = true;
    existing._connected = false;
    try { existing.removeAllListeners(); } catch (e) { logger.warn("[FluxerRevoice] Error removing listeners:", e?.message); }
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
    this._globalJoinQueue = ourResult.catch((err) => {
      logger.warn("[FluxerRevoice] Previous join in queue failed:", err?.message ?? err);
    });
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
    } catch (e) {
      logger.debug("[FluxerRevoice] Could not resolve guild for channel:", e?.message);
    }

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

    const vm = getVoiceManager(this.client);
    if (!vm) {
      throw new Error(`Fluxer voice join failed for ${channelId}: VoiceManager not available — call getVoiceManager(client) before login`);
    }

    let nativeConnection;
    try {
      nativeConnection = await vm.join(channel);
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


    if (room && typeof room.setLogger === "function") {
      try {
        room.setLogger({
          debug: () => {},
          info:  () => {},
          warn:  (...args) => { if (!isLiveKitLogMessage(...args)) logger.warn("[LiveKit]", ...args); },
          error: (...args) => logger.error("[LiveKit]", ...args),
        });
      } catch (e) { logger.warn("[FluxerRevoice] Error creating LiveKit logger adapter:", e?.message); }
    }

    if (!room) {
      try { await nativeConnection.disconnect(); } catch (e) {
        logger.warn("[FluxerRevoice] Cleanup disconnect error:", e?.message);
      }
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
          if (cs === ConnectionState.CONN_CONNECTED || cs === 1) {
            eventResolved = true;
            room.off(LKRoomEvent.ConnectionStateChanged, handler);
            resolve();
          } else if (cs === ConnectionState.CONN_DISCONNECTED || cs === 0) {
            eventResolved = true;
            room.off(LKRoomEvent.ConnectionStateChanged, handler);
            resolve();
          }
        };
        room.on(LKRoomEvent.ConnectionStateChanged, handler);
      });

      while (!room.isConnected && (Date.now() - startTime) < maxWait) {
        await Promise.race([
          statePromise,
          new Promise(r => setTimeout(r, 200)),
        ]);

        if (room.isConnected) break;

        const cs = room.connectionState;
        if (cs === ConnectionState.CONN_DISCONNECTED || cs === 0) break;
      }
    }

    const finalConnected = room.isConnected;
    const finalCS = room.connectionState;

    if (!finalConnected && (finalCS === ConnectionState.CONN_DISCONNECTED || finalCS === 0)) {
      try { await nativeConnection.disconnect(); } catch (e) {
        logger.warn("[FluxerRevoice] Cleanup disconnect error:", e?.message);
      }
      throw new Error(`LiveKit room in disconnected state: ${stateLabel(finalCS)}`);
    }

    logger.player(`[FluxerRevoice] LiveKit room ready (isConnected: ${finalConnected}, connectionState: ${stateLabel(finalCS)})`);


    const connection = withSuppressedLiveKitLogs(() => {
      const conn = new FluxerVoiceConnection(channelId, this, {
        room,
        nativeConnection,
      });

      room.on(LKRoomEvent.ConnectionStateChanged, (cs) => {
        if (cs === ConnectionState.CONN_RECONNECTING || cs === 2) {
          logger.player(`[FluxerRevoice] Room reconnecting for channel ${channelId}`);
        } else if (cs === ConnectionState.CONN_CONNECTED || cs === 1) {
          if (conn._destroyed) return;
          conn._connected = true;
          logger.player(`[FluxerRevoice] Room (re)connected for channel ${channelId}`);
        }
      });

      room.on(LKRoomEvent.Disconnected, (reason) => {
        if (conn._destroyed) return;
        const isIntentional = this._intentionalDisconnects.has(String(channelId));
        const reasonLabel = isIntentional ? "intentional" : (reason ?? "unexpected");
        logger.player(`[FluxerRevoice] Room disconnected: ${reasonLabel}`);
        conn._connected = false;
        conn._destroyed = true;

        this.connections.delete(channelId);

        if (!isIntentional) {
          this._leaveGateway(channelId, channelGuildId);

          if (nativeConnection && typeof nativeConnection.disconnect === "function") {
            try { nativeConnection.disconnect(); } catch (e) {
              logger.warn("[FluxerRevoice] Native disconnect error:", e?.message);
            }
          }
        }

        if (conn.listenerCount("disconnect") > 0) {
          conn.emit("disconnect");
        }
      });

      room.on(LKRoomEvent.ParticipantConnected, (participant) => {
        const userId = participant?.identity ?? participant?.sid;
        if (userId) {
          const uKey = `${channelId}:${userId}`;
          this.users.set(uKey, { id: userId, connectedTo: channelId });
          conn._users = [...this.users.values()].filter(u => u.connectedTo === channelId);
          conn.emit("userjoin", userId);
        }
      });

      room.on(LKRoomEvent.ParticipantDisconnected, (participant) => {
        const userId = participant?.identity ?? participant?.sid;
        if (userId) {
          const uKey = `${channelId}:${userId}`;
          this.users.delete(uKey);
          conn._users = [...this.users.values()].filter(u => u.connectedTo === channelId);
          conn.emit("userleave", userId);
        }
      });

      /**
       * Handle the VoiceManager's serverLeave event, which fires when
       * the Fluxer/LiveKit server terminates the session server-side.
       * Without this handler the bot never learns the session is dead,
       * leading to "validate request timed out" on the next join attempt.
       *
       * Reference: https://fluxer.js.org/v/latest/guides/voice
       *   "If using LiveKit, the server may emit serverLeave.
       *    Listen and reconnect if needed."
       */
      if (nativeConnection && typeof nativeConnection.on === "function") {
        nativeConnection.on("serverLeave", () => {
          if (conn._destroyed) return;
          logger.player(`[FluxerRevoice] serverLeave received for channel ${channelId} — cleaning up`);
          conn._connected = false;
          conn._destroyed = true;
          this.connections.delete(channelId);
          this._leaveGateway(channelId, channelGuildId);
          if (room) {
            try { room.disconnect().catch(() => {}); } catch (_) { /** already gone */ }
          }
          if (conn.listenerCount("disconnect") > 0) {
            conn.emit("disconnect");
          }
        });
      }

      this.connections.set(channelId, conn);

      if (_leaveIfEmpty) {
        conn.on("userleave", () => {
          const remoteCount = room.remoteParticipants?.size ?? 0;
          if (remoteCount === 0) {
            logger.player(`[FluxerRevoice] Room empty, triggering autoleave for ${channelId}`);
            conn.emit("autoleave");
            this.connections.delete(channelId);
          }
        });
      }

      return conn;
    });

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
