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
import { Room, RoomEvent, ConnectionState } from "@livekit/rtc-node";
import { joinVoiceChannel, getVoiceManager } from "@fluxerjs/voice";
import { logger } from "./Logger.mjs";

// ConnectionState enum values for reference:
// ConnectionState.CONN_DISCONNECTED = 0
// ConnectionState.CONN_CONNECTED   = 1
// ConnectionState.CONN_RECONNECTING = 2

/** Helper: returns a human-readable label for a ConnectionState value */
function stateLabel(cs) {
  if (cs === ConnectionState?.CONN_CONNECTED) return "CONN_CONNECTED";
  if (cs === ConnectionState?.CONN_DISCONNECTED) return "CONN_DISCONNECTED";
  if (cs === ConnectionState?.CONN_RECONNECTING) return "CONN_RECONNECTING";
  // Fallback for numeric values if enum import fails
  if (cs === 1) return "CONN_CONNECTED(1)";
  if (cs === 0) return "CONN_DISCONNECTED(0)";
  if (cs === 2) return "CONN_RECONNECTING(2)";
  return String(cs);
}

// ═══════════════════════════════════════════════════════════════════════════════
// FluxerVoiceConnection — compatible with revoice.js VoiceConnection
// ═══════════════════════════════════════════════════════════════════════════════

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
  /** @type {Room|null} */
  room        = null;
  channelId   = null;
  _voice      = null;  // parent FluxerRevoice instance
  _connected  = false; // internal flag, set by events
  users       = [];
  _destroyed  = false;

  // @fluxerjs/voice native connection reference (for proper disconnect)
  _nativeConn = null;

  constructor(channelId, voice, opts = {}) {
    super();
    this.channelId = channelId;
    this._voice    = voice;
    this.room      = opts.room ?? null;
    this._nativeConn = opts.nativeConnection ?? null;
    // Use room.isConnected (boolean getter) — the correct Node.js SDK API
    this._connected = !!(this.room && this.room.isConnected);
  }

  /**
   * Whether this connection is currently alive.
   * Reads from the LiveKit Room's `isConnected` boolean getter,
   * which is the correct API in @livekit/rtc-node (Node.js SDK).
   */
  get connected() {
    if (this._destroyed) return false;
    // Prefer the LiveKit Room's own isConnected getter (source of truth)
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
    // Mark this as an intentional disconnect so the RoomEvent.Disconnected
    // handler knows not to trigger recovery
    if (this._voice && this.channelId) {
      this._voice.markIntentionalDisconnect(this.channelId);
    }
    this._destroyed = true;
    this._connected = false;

    // Method 1: Use @fluxerjs/voice native connection disconnect
    if (this._nativeConn && typeof this._nativeConn.disconnect === "function") {
      try {
        await this._nativeConn.disconnect();
      } catch (e) {
        logger.warn("[FluxerVoiceConnection] Native disconnect error:", e?.message);
      }
    }

    // Method 2: Close LiveKit Room directly as fallback
    if (this.room) {
      try {
        await this.room.disconnect();
      } catch (e) {
        // Room may already be closed
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

// ═══════════════════════════════════════════════════════════════════════════════
// FluxerRevoice — drop-in replacement for revoice.js Revoice
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Revoice-compatible class that uses the Fluxer gateway for voice joins.
 *
 * Usage (drop-in for `new Revoice(token)`):
 *
 *   // Before (third-party API — 401 on Fluxer):
 *   this.revoice = new Revoice(config.token);
 *
 *   // After (Fluxer API — works on Fluxer):
 *   this.revoice = new FluxerRevoice(client);
 */
export class FluxerRevoice extends EventEmitter {
  /** @type {import("@fluxerjs/core").Client} */
  client       = null;
  connections  = new Map();
  users        = new Map();

  // Guild-level join mutex: prevents concurrent joinVoiceChannel() calls
  // for the same guild. When the bot tries to join multiple channels in
  // the same guild simultaneously (e.g. during recovery), the Fluxer
  // voice server can return 401 Unauthorized because the previous
  // session's token hasn't been fully cleaned up yet. Serializing joins
  // per guild eliminates this race condition.
  /** @type {Map<string, Promise>} */
  _guildJoinQueue = new Map();
  /** @type {number} Delay between consecutive guild joins (ms) — increased from 3000 to 4000
   *  to give the Fluxer gateway more time to clean up the previous voice session
   *  before we request a new one. 3000ms was too short and caused 401 errors when
   *  multiple channels in the same guild were joined in quick succession.
   *  The Fluxer gateway's Erlang backend needs time to process voice state
   *  transitions, and concurrent joins within the cleanup window cause
   *  the new LiveKit token to be rejected with 401 Unauthorized. */
  _guildJoinDelay = 4000;

  /** @type {Set<string>} Channel IDs where disconnect is expected (bot-initiated) */
  _intentionalDisconnects = new Set();

  /** @type {Map<string, number>} Guild ID → timestamp of last successful join.
   *  Used to add an extra safety delay when the previous join in this guild
   *  was very recent (< 5 seconds), which is the window where 401 errors
   *  are most likely due to the gateway not having fully processed the
   *  previous session's voice state. */
  _guildLastJoinTime = new Map();

  /** @type {number} Minimum time between guild joins (ms) — enforced on top of
   *  the per-join delay. If a new join is requested within this window, we
   *  wait the remaining time before proceeding. Increased from 5000 to 7000
   *  because 5000ms was insufficient to prevent 401 errors when the bot
   *  re-joins a channel in the same guild quickly after a disconnect. */
  _guildMinJoinInterval = 7000;

  /** @type {Map<string, number>} Guild IDs that recently had a 401 error.
   *  Used to add an even longer backoff before retrying joins in that guild. */
  _guild401Cooldown = new Map(); // guildId → timestamp when cooldown expires

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
   * RoomEvent.Disconnected handler does not trigger recovery.
   * @param {string} channelId
   */
  markIntentionalDisconnect(channelId) {
    this._intentionalDisconnects.add(String(channelId));
    // Auto-clear after 10 seconds as safety net
    setTimeout(() => this._intentionalDisconnects.delete(String(channelId)), 10_000);
  }

  /**
   * Send a VOICE_STATE_UPDATE leave signal to the Fluxer gateway so it
   * knows the bot is no longer in the given channel.  Without this, the
   * gateway may think the bot is still connected and won't send a fresh
   * VOICE_SERVER_UPDATE on the next joinVoiceChannel() call, causing the
   * rejoin to hang or fail.
   *
   * @param {string} channelId — The channel ID to leave
   */
  _leaveGateway(channelId, guildId = null) {
    try {
      const vm = getVoiceManager(this.client);
      if (!vm) return;

      const guildForLeave = guildId ?? this._resolveGuildForChannel(channelId);

      // ── Method 1: Use vm.leave(guildId) — the recommended API ──────────
      // The VoiceManager's leave() method sends a VOICE_STATE_UPDATE with
      // channel_id=null for the specified guild, which is the correct way
      // to leave voice on Fluxer. This avoids the unscoped leave problem.
      if (guildForLeave && typeof vm.leave === "function") {
        try {
          vm.leave(guildForLeave);
          logger.player(`[FluxerRevoice] Sent gateway leave via vm.leave() for guild ${guildForLeave}`);
          return;
        } catch (e) {
          logger.warn(`[FluxerRevoice] vm.leave() failed for guild ${guildForLeave}: ${e?.message}`);
        }
      }

      // ── Method 2: Use vm.leaveChannel(channelId) ──────────────────────
      if (typeof vm.leaveChannel === "function") {
        try {
          vm.leaveChannel(channelId);
          logger.player(`[FluxerRevoice] Sent gateway leave via vm.leaveChannel() for channel ${channelId}`);
          return;
        } catch (e) {
          logger.warn(`[FluxerRevoice] vm.leaveChannel() failed for channel ${channelId}: ${e?.message}`);
        }
      }

      // ── Method 3: Use vm.updateVoiceState() as last resort ─────────────
      if (typeof vm.updateVoiceState === "function") {
        if (guildForLeave) {
          // NEVER send an unscoped updateVoiceState(null, opts) because it
          // tells the gateway to leave ALL guilds' voice channels, causing
          // cascading disconnections across all active voice connections.
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
    // 1. Remove from map immediately so no other code can get this dead ref
    this.connections.delete(channelId);
    // Mark as intentional so the LiveKit disconnect handler doesn't trigger recovery
    this.markIntentionalDisconnect(channelId);

    // 2. Disconnect the native @fluxerjs/voice connection (sends gateway leave)
    if (existing._nativeConn && typeof existing._nativeConn.disconnect === "function") {
      try {
        await existing._nativeConn.disconnect();
      } catch (e) {
        logger.warn(`[FluxerRevoice] Stale native disconnect error for ${channelId}: ${e?.message}`);
      }
    }

    // 3. Close the LiveKit Room directly
    if (existing.room) {
      try {
        await existing.room.disconnect();
      } catch (_) {
        // Room may already be closed
      }
    }

    // 4. Mark as destroyed and clean up listeners
    existing._destroyed = true;
    existing._connected = false;
    try { existing.removeAllListeners(); } catch (_) {}

    // 5. Send an explicit gateway leave signal so the gateway knows we left.
    //    This is critical: if the gateway still thinks we're in the channel,
    //    the next joinVoiceChannel() won't receive VOICE_SERVER_UPDATE and
    //    the rejoin will fail.
    const staleGuildId = this._resolveGuildForChannel(channelId);
    this._leaveGateway(channelId, staleGuildId);

    // 6. Brief delay to let the gateway process the leave before we rejoin.
    //    Increased from 1500ms to 2000ms to give the Erlang gateway backend
    //    more time to clean up the previous voice session.
    await new Promise(r => setTimeout(r, 2000));
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
    // Resolve the guild ID for this channel so we can serialize joins per guild.
    // This prevents the 401 Unauthorized race condition that occurs when
    // multiple channels in the same guild are joined simultaneously.
    let guildId = null;
    try {
      const ch = this.client.channels?.get?.(channelId);
      guildId = ch?.guildId ?? ch?.guild?.id ?? null;
    } catch (_) {}

    if (guildId) {
      // Serialize: wait for any in-flight join for this guild to complete,
      // then add a delay before starting our join.
      const prev = this._guildJoinQueue.get(guildId) ?? Promise.resolve();
      const ourTurn = prev.then(async () => {
        // Wait the base guild join delay
        await new Promise(r => setTimeout(r, this._guildJoinDelay));

        // Additional safety: if this guild was joined very recently, wait
        // until the minimum interval has elapsed. This prevents the rapid
        // rejoin that causes 401 Unauthorized errors.
        const lastJoin = this._guildLastJoinTime.get(guildId) ?? 0;
        const elapsed = Date.now() - lastJoin;
        if (elapsed < this._guildMinJoinInterval) {
          const extraWait = this._guildMinJoinInterval - elapsed;
          logger.player(
            `[FluxerRevoice] Guild ${guildId} was joined ${elapsed}ms ago — ` +
            `waiting additional ${extraWait}ms to avoid 401 race`
          );
          await new Promise(r => setTimeout(r, extraWait));
        }

        // If this guild recently had a 401 error, wait for the cooldown
        const cooldownExpiry = this._guild401Cooldown.get(guildId) ?? 0;
        const cooldownRemaining = cooldownExpiry - Date.now();
        if (cooldownRemaining > 0) {
          logger.player(
            `[FluxerRevoice] Guild ${guildId} has 401 cooldown — ` +
            `waiting ${cooldownRemaining}ms before attempting join`
          );
          await new Promise(r => setTimeout(r, cooldownRemaining));
        }
      });
      this._guildJoinQueue.set(guildId, ourTurn);
      await ourTurn;
    }

    if (this.connections.has(channelId)) {
      const existing = this.connections.get(channelId);
      // If the existing connection is still alive, reuse it.
      // If the LiveKit room disconnected, the connection is stale — clean it
      // up fully and rejoin instead of returning a dead connection that will
      // fail with "LiveKit disconnected (connectionState: 0)".
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

    // Fetch the channel object from the client cache (or REST)
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

    // Resolve the guild ID for this channel (used for guild-scoped leave signals)
    const channelGuildId = guildId ?? channel?.guildId ?? channel?.guild?.id ?? null;

    // Use @fluxerjs/voice to join the channel via the Fluxer gateway.
    // This handles the VOICE_STATE_UPDATE → VOICE_SERVER_UPDATE flow
    // and creates a LiveKit connection with the returned credentials.
    let nativeConnection;
    try {
      nativeConnection = await joinVoiceChannel(this.client, channel);
    } catch (e) {
      // If the error is 401 Unauthorized, set a cooldown for this guild
      // so subsequent join attempts wait longer before retrying.
      if (e.message?.includes("401") || e.message?.includes("Unauthorized")) {
        const gId = channelGuildId ?? this._resolveGuildForChannel(channelId);
        if (gId) {
          // Set 45-second cooldown for this guild to prevent rapid 401 retries
          this._guild401Cooldown.set(gId, Date.now() + 45_000);
          logger.warn(
            `[FluxerRevoice] 401 error for channel ${channelId} — ` +
            `setting 45s cooldown for guild ${gId}`
          );
        }
      }
      throw new Error(`Fluxer voice join failed for ${channelId}: ${e.message}`);
    }

    if (!nativeConnection) {
      throw new Error(`Fluxer voice join returned null for ${channelId}`);
    }

    logger.player(`[FluxerRevoice] Gateway join successful, extracting LiveKit room...`);

    // The @fluxerjs/voice connection wraps a LiveKit Room.
    // Extract it so we can use it with revoice.js's MediaPlayer.
    let room = null;

    // Try to get the LiveKit Room from the native connection
    if (nativeConnection.room) {
      room = nativeConnection.room;
      logger.player(`[FluxerRevoice] Got LiveKit room from native connection (isConnected: ${room.isConnected}, connectionState: ${stateLabel(room.connectionState)})`);
    }

    // (non-LiveKit) which we don't support for music playback.
    if (!room) {
      try { await nativeConnection.disconnect(); } catch (_) {}
      throw new Error(
        `Fluxer voice connection for ${channelId} does not expose a LiveKit Room. ` +
        `Music playback requires a LiveKit-based voice server.`
      );
    }

    // ── Wait for the room to be connected ────────────────────────────────
    // Use room.isConnected (boolean) and room.connectionState (enum) which
    // are the correct APIs in @livekit/rtc-node Node.js SDK.
    // Also listen for the ConnectionStateChanged event for immediate feedback.
    const maxWait = 10_000;
    const startTime = Date.now();

    // If already connected, skip the wait loop
    if (!room.isConnected) {
      // Listen for the ConnectionStateChanged event to resolve faster
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
            resolve(); // resolve so we can check isConnected below
          }
        };
        room.on(RoomEvent.ConnectionStateChanged, handler);
      });

      // Poll + event race
      while (!room.isConnected && (Date.now() - startTime) < maxWait) {
        // Wait for either the event to fire or a 200ms poll interval
        await Promise.race([
          statePromise,
          new Promise(r => setTimeout(r, 200)),
        ]);

        // Check if connected
        if (room.isConnected) break;

        // Check if disconnected (dead state)
        const cs = room.connectionState;
        if (cs === ConnectionState?.CONN_DISCONNECTED || cs === 0) break;
      }
    }

    // Final state check using the correct API
    const finalConnected = room.isConnected;
    const finalCS = room.connectionState;

    if (!finalConnected && (finalCS === ConnectionState?.CONN_DISCONNECTED || finalCS === 0)) {
      try { await nativeConnection.disconnect(); } catch (_) {}
      throw new Error(`LiveKit room in disconnected state: ${stateLabel(finalCS)}`);
    }

    logger.player(`[FluxerRevoice] LiveKit room ready (isConnected: ${finalConnected}, connectionState: ${stateLabel(finalCS)})`);

    // Record the successful join time for this guild so future joins
    // can enforce the minimum interval and avoid 401 races.
    if (channelGuildId) {
      this._guildLastJoinTime.set(channelGuildId, Date.now());
      // Clear any 401 cooldown for this guild since the join succeeded
      this._guild401Cooldown.delete(channelGuildId);
    }

    // Create our FluxerVoiceConnection wrapper
    const connection = new FluxerVoiceConnection(channelId, this, {
      room,
      nativeConnection,
    });

    // ── LiveKit room event forwarding ──────────────────────────────────
    // Forward LiveKit events to FluxerVoiceConnection events so
    // Player.mjs's connection.on("disconnect") etc. still work.

    room.on(RoomEvent.Disconnected, (reason) => {
      const isIntentional = this._intentionalDisconnects.has(String(channelId));
      const reasonLabel = isIntentional ? "intentional" : (reason ?? "unexpected");
      logger.player(`[FluxerRevoice] Room disconnected: ${reasonLabel}${isIntentional ? " (bot-initiated, recovery suppressed)" : ""}`);
      this._intentionalDisconnects.delete(String(channelId));
      connection._connected = false;
      connection._destroyed = true;

      // Remove from connections map so the next join() creates a fresh
      // connection instead of returning this dead one.
      this.connections.delete(channelId);

      // Send gateway leave signal so the gateway knows we're gone.
      // Without this, the gateway may still think the bot is in the channel
      // and won't send a fresh VOICE_SERVER_UPDATE on rejoin.
      this._leaveGateway(channelId, channelGuildId);

      // Try to disconnect the native @fluxerjs/voice connection as well,
      // in case it still has resources open.
      if (nativeConnection && typeof nativeConnection.disconnect === "function") {
        try { nativeConnection.disconnect(); } catch (_) {}
      }

      connection.emit("disconnect");
    });

    room.on(RoomEvent.Reconnecting, () => {
      logger.player("[FluxerRevoice] Room reconnecting...");
    });

    room.on(RoomEvent.Reconnected, () => {
      logger.player("[FluxerRevoice] Room reconnected");
      connection._connected = true;
    });

    room.on(RoomEvent.ParticipantConnected, (participant) => {
      const userId = participant?.identity ?? participant?.sid;
      if (userId) {
        connection.users.push({ id: userId, connectedTo: channelId });
        this.users.set(userId, { id: userId, connectedTo: channelId });
        connection.emit("userjoin", userId);
      }
    });

    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      const userId = participant?.identity ?? participant?.sid;
      if (userId) {
        connection.users = connection.users.filter(u => u.id !== userId);
        this.users.delete(userId);
        connection.emit("userleave", userId);
      }
    });

    // Track the connection
    this.connections.set(channelId, connection);

    // Auto-leave when room empties (if requested)
    if (_leaveIfEmpty) {
      connection.on("userleave", () => {
        // Only trigger autoleave if no remote participants remain
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
