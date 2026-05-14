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
import { Room, RoomEvent, ConnectionState, setLogLevel } from "@livekit/rtc-node";
import { joinVoiceChannel, getVoiceManager } from "@fluxerjs/voice";
import { logger } from "./Logger.mjs";

// Suppress LiveKit SDK's verbose pino/JSON logs (lk-rtc, [voice LiveKitRtc]).
// Only show warnings and errors from the SDK — the "Connect callback received"
// JSON lines and "connected to room" messages are noise for production.
try { setLogLevel("warn"); } catch (_) {}

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
      // Prefer a channel-scoped gateway leave before tearing down the room.
      // The native disconnect path can be guild-scoped in some environments,
      // which drops every voice connection in the guild.
      const guildId = this._voice._resolveGuildForChannel?.(this.channelId) ?? null;
      this._voice._leaveGateway?.(this.channelId, guildId);
    }
    this._destroyed = true;
    this._connected = false;

    // Close the LiveKit room directly after sending the leave signal.
    // This keeps the disconnect scoped to the target channel.
    if (this.room) {
      try {
        await this.room.disconnect();
      } catch (e) {
        // Room may already be closed
      }
    } else if (this._nativeConn && typeof this._nativeConn.disconnect === "function") {
      // Fallback only when no room object is available.
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

  // Guild-level join mutex: kept for per-guild cooldown tracking (401 cooldowns
  // and minimum join intervals), but actual join serialization is handled by
  // the global queue above. The per-guild queue was insufficient because the
  // Fluxer gateway can't handle concurrent joins from DIFFERENT guilds either.
  /** @type {Map<string, Promise>} */
  _guildJoinQueue = new Map();

  // ── Global join queue ──────────────────────────────────────────────────────
  // The per-guild queue serializes joins within the same guild, but the Fluxer
  // gateway also struggles when many DIFFERENT guilds are joined simultaneously.
  // During boot recovery, 10+ channels can be spawned within seconds, each
  // triggering VOICE_STATE_UPDATE + VOICE_SERVER_UPDATE + LiveKit connect.
  // The gateway's Erlang backend can't process this flood fast enough, causing
  // 401 Unauthorized errors on guilds that were scheduled later.
  //
  // The global queue ensures that only ONE join is in-flight at a time across
  // ALL guilds, with a delay between each to let the gateway catch up.
  /** @type {Promise} Global join serializer — only one join at a time across all guilds */
  _globalJoinQueue = Promise.resolve();
  /** @type {number} Minimum delay between ANY two joins (ms), even across guilds.
   *  This delay runs AFTER the previous join completes and BEFORE the next
   *  one starts, giving the Fluxer gateway time to clean up the previous
   *  voice session. 500ms is sufficient; the per-guild _guildMinJoinInterval
   *  provides additional safety for rapid same-guild rejoins. */
  _globalJoinDelay = 500;

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
   *  wait the remaining time before proceeding. 2s is enough with the global
   *  join queue providing additional serialization. */
  _guildMinJoinInterval = 2000;

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

      // ── Method 1 (PREFERRED): Use vm.leaveChannel(channelId) ──────────
      // This sends a channel-specific VOICE_STATE_UPDATE that only leaves
      // the specified channel, preserving all other voice connections in
      // the same guild.  This is critical for multi-voice / 24/7 setups
      // where the bot may be in several channels simultaneously.
      if (typeof vm.leaveChannel === "function") {
        try {
          vm.leaveChannel(channelId);
          logger.player(`[FluxerRevoice] Sent channel-specific gateway leave via vm.leaveChannel() for channel ${channelId}`);
          return;
        } catch (e) {
          logger.warn(`[FluxerRevoice] vm.leaveChannel() failed for channel ${channelId}: ${e?.message} — falling back`);
        }
      }

      // ── Method 2: Use vm.leave(guildId) — guild-level fallback ─────────
      // WARNING: This disconnects ALL voice channels in the guild, not just
      // the target channel.  Only used when leaveChannel() is unavailable.
      // The caller must handle rejoining other 24/7 channels if needed.
      if (guildForLeave && typeof vm.leave === "function") {
        try {
          vm.leave(guildForLeave);
          logger.player(`[FluxerRevoice] Sent guild-level gateway leave via vm.leave() for guild ${guildForLeave} (leaveChannel unavailable — other channels may be disconnected)`);
          return;
        } catch (e) {
          logger.warn(`[FluxerRevoice] vm.leave() failed for guild ${guildForLeave}: ${e?.message}`);
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
    const staleGuildId = this._resolveGuildForChannel(channelId);
    this._leaveGateway(channelId, staleGuildId);

    // 2. Close the LiveKit Room directly
    if (existing.room) {
      try {
        await existing.room.disconnect();
      } catch (_) {
        // Room may already be closed
      }
    } else if (existing._nativeConn && typeof existing._nativeConn.disconnect === "function") {
      try {
        await existing._nativeConn.disconnect();
      } catch (e) {
        logger.warn(`[FluxerRevoice] Stale native disconnect error for ${channelId}: ${e?.message}`);
      }
    }

    // 3. Mark as destroyed and clean up listeners
    existing._destroyed = true;
    existing._connected = false;
    try { existing.removeAllListeners(); } catch (_) {}

    // 4. Brief delay to let the gateway process the leave before we rejoin.
    //    250ms is enough since the join() operation itself adds _globalJoinDelay.
    await new Promise(r => setTimeout(r, 250));
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
    // ── Global join queue (TRUE serialization) ───────────────────────────
    // Serialize ALL joins so that only ONE join is in-flight at a time across
    // the entire bot. The Fluxer gateway's Erlang backend cannot handle
    // concurrent VOICE_STATE_UPDATE + VOICE_SERVER_UPDATE flows — it returns
    // 401 Unauthorized when LiveKit tokens haven't propagated for the previous
    // join yet.
    //
    // PREVIOUS APPROACH (broken): Add a 2s delay between starts, but don't
    // wait for the previous join to complete. Multiple joins were in-flight
    // simultaneously, causing 401 errors.
    //
    // NEW APPROACH: The global queue wraps the ENTIRE join() call. Each join
    // must FULLY COMPLETE (including LiveKit room connection) before the next
    // one starts, plus a 3-second gap between joins to give the gateway time
    // to clean up the previous voice session.
    //
    // The promise chain works like this:
    //   _globalJoinQueue = Promise.resolve()           // initial
    //   _globalJoinQueue = prev.then(() => joinA())    // joinA runs after prev
    //   _globalJoinQueue = prev.then(() => joinB())    // joinB runs after joinA completes
    //
    // Each caller awaits its own turn, which only resolves after the full
    // join operation completes (or throws).
    const joinOperation = async () => {
      // Small gap between joins to let the gateway process the previous
      // session's cleanup. This runs BEFORE the actual join logic.
      await new Promise(r => setTimeout(r, this._globalJoinDelay));
      return await this._joinInternal(channelId, _leaveIfEmpty);
    };

    // Chain onto the global queue: our join only starts after the previous
    // one has fully completed (or failed). We store the new tail of the chain.
    const prevQueue = this._globalJoinQueue;
    const ourResult = prevQueue.then(() => joinOperation());
    this._globalJoinQueue = ourResult.catch(() => {}); // don't break chain on error
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
    // Resolve the guild ID for this channel so we can serialize joins per guild.
    // This prevents the 401 Unauthorized race condition that occurs when
    // multiple channels in the same guild are joined simultaneously.
    let guildId = null;
    try {
      const ch = this.client.channels?.get?.(channelId);
      guildId = ch?.guildId ?? ch?.guild?.id ?? null;
    } catch (_) {}

    // Per-guild cooldown checks (still useful for same-guild rapid rejoins
    // from recovery or user commands, even though the global queue prevents
    // concurrent joins)
    if (guildId) {
      // Additional safety: if this guild was joined very recently, wait
      // until the minimum interval has elapsed. This prevents the rapid
      // rejoin that causes 401 Unauthorized errors.
      const lastJoin = this._guildLastJoinTime.get(guildId) ?? 0;
      const elapsed = Date.now() - lastJoin;
      if (elapsed < this._guildMinJoinInterval) {
        const extraWait = this._guildMinJoinInterval - elapsed;
        logger.mediaplayer(
          `[FluxerRevoice] Guild ${guildId} was joined ${elapsed}ms ago — ` +
          `waiting additional ${extraWait}ms to avoid 401 race`
        );
        await new Promise(r => setTimeout(r, extraWait));
      }

      // If this guild recently had a 401 error, wait for the cooldown.
      const cooldownExpiry = this._guild401Cooldown.get(guildId) ?? 0;
      const cooldownRemaining = cooldownExpiry - Date.now();
      if (cooldownRemaining > 0) {
        if (cooldownRemaining > 30_000) {
          throw new Error(
            `Guild ${guildId} has active 401 cooldown (${Math.round(cooldownRemaining / 1000)}s remaining) — ` +
            `aborting join for channel ${channelId} to avoid guaranteed failure. `
          );
        }
        logger.mediaplayer(
          `[FluxerRevoice] Guild ${guildId} has 401 cooldown — ` +
          `waiting ${Math.round(cooldownRemaining / 1000)}s before attempting join`
        );
        await new Promise(r => setTimeout(r, cooldownRemaining));
      }

      // Re-check cooldown after waiting
      const recheckExpiry = this._guild401Cooldown.get(guildId) ?? 0;
      const recheckRemaining = recheckExpiry - Date.now();
      if (recheckRemaining > 30_000) {
        throw new Error(
          `Guild ${guildId} 401 cooldown re-activated during wait — ` +
          `aborting join for channel ${channelId}.`
        );
      }
    }

    if (this.connections.has(channelId)) {
      const existing = this.connections.get(channelId);
      // If the existing connection is still alive, reuse it.
      // If the LiveKit room disconnected, the connection is stale — clean it
      // up fully and rejoin instead of returning a dead connection that will
      // fail with "LiveKit disconnected (connectionState: 0)".
      if (existing && !existing._destroyed && existing.room && existing.room.isConnected) {
      logger.mediaplayer(`[FluxerRevoice] Already connected to ${channelId}, returning existing connection`);
        return existing;
      }
      logger.mediaplayer(
        `[FluxerRevoice] Stale connection for ${channelId} — cleaning up and rejoining`
      );
      await this._destroyStaleConnection(channelId, existing);
    }

    logger.mediaplayer(`[FluxerRevoice] Joining channel ${channelId} via Fluxer gateway...`);

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
          // Set 15-second cooldown for this guild to prevent rapid 401 retries
          this._guild401Cooldown.set(gId, Date.now() + 15_000);
          logger.warn(
            `[FluxerRevoice] 401 error for channel ${channelId} — ` +
            `setting 15s cooldown for guild ${gId}`
          );
        }
      }
      throw new Error(`Fluxer voice join failed for ${channelId}: ${e.message}`);
    }

    if (!nativeConnection) {
      throw new Error(`Fluxer voice join returned null for ${channelId}`);
    }

    logger.mediaplayer(`[FluxerRevoice] Gateway join successful, extracting LiveKit room...`);

    // The @fluxerjs/voice connection wraps a LiveKit Room.
    // Extract it so we can use it with revoice.js's MediaPlayer.
    let room = null;

    // Try to get the LiveKit Room from the native connection
    if (nativeConnection.room) {
      room = nativeConnection.room;
      logger.mediaplayer(`[FluxerRevoice] Got LiveKit room from native connection (isConnected: ${room.isConnected}, connectionState: ${stateLabel(room.connectionState)})`);
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

    logger.mediaplayer(`[FluxerRevoice] LiveKit room ready (isConnected: ${finalConnected}, connectionState: ${stateLabel(finalCS)})`);

    // Record the successful join time for this guild so future joins
    // can enforce the minimum interval and avoid 401 races.
    // Clear any 401 cooldown for this guild since the join succeeded.
    // Try both the resolved channelGuildId and the pre-resolved guildId
    // to ensure the cooldown is properly cleared even if channelGuildId
    // couldn't be resolved from the channel object.
    const clearIds = new Set([channelGuildId, guildId].filter(Boolean));
    for (const gId of clearIds) {
      this._guildLastJoinTime.set(gId, Date.now());
      this._guild401Cooldown.delete(gId);
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
      logger.mediaplayer(`[FluxerRevoice] Room disconnected: ${reasonLabel}${isIntentional ? " (bot-initiated, recovery suppressed)" : ""}`);
      this._intentionalDisconnects.delete(String(channelId));
      connection._connected = false;
      connection._destroyed = true;

      // Remove from connections map so the next join() creates a fresh
      // connection instead of returning this dead one.
      this.connections.delete(channelId);

      if (!isIntentional) {
        // Unexpected disconnects still need a gateway leave signal so the
        // next join gets a fresh voice session.
        this._leaveGateway(channelId, channelGuildId);

        // Best-effort cleanup for the native wrapper. Skip this on intentional
        // leaves because it can collapse multi-voice into a guild-wide leave.
        if (nativeConnection && typeof nativeConnection.disconnect === "function") {
          try { nativeConnection.disconnect(); } catch (_) {}
        }
      }

      connection.emit("disconnect");
    });

    room.on(RoomEvent.Reconnecting, () => {
      logger.mediaplayer("[FluxerRevoice] Room reconnecting...");
    });

    room.on(RoomEvent.Reconnected, () => {
      logger.mediaplayer("[FluxerRevoice] Room reconnected");
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
