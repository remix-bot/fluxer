/**
 * @module src/voice/gateway/GatewayHandler
 * @description Handles all gateway events relevant to voice state
 * tracking, 24/7 mode, boot recovery, presence rotation, and permission
 * checks. Base class file: constructor & state, raw WS listener, presence
 * rotation, event registration, READY sequencing and 24/7 boot recovery.
 * Voice-state routing, guild sync and rejoin management live in sibling
 * mixin modules applied onto the prototype at the bottom of this file.
 */
import { Events, GatewayOpcodes } from "@fluxerjs/core";
import { logger, _wsErrorCooldown } from "../../core/Logger.mjs";
import { ServerSettings } from "../../db/Settings.mjs";
import { get247ChannelMode, remove247ChannelMode } from "../../utils/Helpers247.mjs";
import { cleanId } from "../../utils/Utils.mjs";
import * as ShardingUtils from "../../utils/ShardingUtils.mjs";
import { iterateVoiceStates, hasHumansInChannel, getChannelsWithHumans } from "../VoiceStateResolver.mjs";
import { applyMixins } from "../../utils/mixins.mjs";
import VoiceStateRouting from "./VoiceStateRouting.mjs";
import GuildSync from "./GuildSync.mjs";
import RejoinManager from "./RejoinManager.mjs";

const RAW_GATEWAY_INTEREST =
    /"(?:t|op)":\s*(?:"(?:VOICE_STATE_UPDATE|VOICE_SERVER_UPDATE|GUILD_CREATE|READY|RESUMED)"|(?:7|9|10|12)\b)/;

/** @class GatewayHandler @description Handles all gateway events relevant to voice state tracking, 24/7 mode, boot recovery, presence rotation, and permission checks. Key responsibilities include voice state cache seeding and updates, bot move-away detection with 24/7 rejoin scheduling, boot recovery with sequential rejoin of 24/7 channels, inactivity timer management on human join/leave, and guild create/delete handling with startup grace period. */
class GatewayHandler {
  /**
   * Create a new GatewayHandler.
   * @param {import('../../core/Bot.mjs').Remix} remix - The bot context.
   */
  constructor(remix) {
    this.remix = remix;

    const timers = remix.config.timers ?? {};
    this.T = {
      aloneCheckDebounce: timers.aloneCheckDebounce ?? 500,
      rejoin247Delay:     timers.rejoin247Delay     ?? 3_000,
    };

    this.presenceContents = remix.config.presenceContents ?? [];
    this.presenceInterval = remix.config.presenceInterval ?? 30_000;

    this.wsListenerAttached = false;
    this.presenceTimer = null;
    this.presenceIndex = 0;

    this._prevVoiceState = new Map();

    this._deferredGuildDeletes = new Map();
    this._startupDeleteGraceMs = 15_000;
    this._inStartupGrace = true;
    this._deferredDeleteCount = 0;

    this._lastReadyAt = 0;
    this._wsReconnectGraceMs = 30_000;
    this._moveEvidenceWindowMs = 10_000;
  }

  /** @private @type {Set<string>} @description Channel IDs currently being rejoined (duplicate guard). */
  _rejoinInProgress = new Set();

  /** @private @type {Map<string, number>} @description Channel ID → retry count for exponential backoff. */
  _rejoinAttempts = new Map();

  /** @private @type {boolean} @description Whether boot recovery is actively rejoining 24/7 channels. */
  _bootRecoveryActive = false;

  /** @type {number} @description Maximum number of rejoin retry attempts per channel. */
  static MAX_REJOIN_RETRIES = 3;

  /**
   * Check whether a WebSocket reconnect happened recently (within 30s).
   * Used to treat transient disconnects as non-24/7-requiring.
   * @returns {boolean}
   */
  isWsReconnectRecent() {
    if (!this._lastReadyAt) return false;
    return Date.now() - this._lastReadyAt < this._wsReconnectGraceMs;
  }

  /** @private Build a composite bot key for voice state tracking. @param {string} userId @param {string} guildId @returns {string|null} */
  getObservedVoiceBotKey(userId, guildId) {
    const cleanUserId = cleanId(userId ?? "");
    const cleanGuildId = cleanId(guildId ?? "");
    return cleanUserId && cleanGuildId ? `${cleanGuildId}:${cleanUserId}` : cleanUserId || null;
  }

  /** @private Build a previous voice state lookup key. @param {string} userId @param {string} guildId @returns {string|null} */
  getPrevVoiceStateKey(userId, guildId) {
    const cleanUserId = cleanId(userId ?? "");
    const cleanGuildId = cleanId(guildId ?? "");
    return cleanUserId && cleanGuildId ? `${cleanGuildId}:${cleanUserId}` : null;
  }

  /** Find a previous voice state entry for a user. @param {string} userId @param {string|null} [guildId=null] @returns {{key: string|null, value: object|null}} */
  findPrevVoiceStateEntry(userId, guildId = null) {
    const directKey = this.getPrevVoiceStateKey(userId, guildId);
    if (directKey && this._prevVoiceState.has(directKey)) {
      return { key: directKey, value: this._prevVoiceState.get(directKey) };
    }

    const cleanUserId = cleanId(userId ?? "");
    if (!cleanUserId) return { key: null, value: null };

    for (const [key, value] of this._prevVoiceState) {
      if (key.endsWith(`:${cleanUserId}`)) {
        return { key, value };
      }
    }

    return { key: null, value: null };
  }

  /** Attach a raw WebSocket listener to cache VOICE_SERVER_UPDATE events. @private */
  attachRawListener() {
    const { remix } = this;
    const client = remix.client;

    try {
      // Fluxer 3.0 + sharding: the ws manager exposes shards via getShards()
      // (2.2 used a `shards` Map property) and a sharded child owns several
      // shards — track the raw socket of EVERY local shard, not just shard 0.
      const wsObjs = ShardingUtils.localShardSockets(client);

      if (!remix._rawGatewayWsObjs) remix._rawGatewayWsObjs = new Set();
      const attached = remix._rawGatewayWsObjs;

      // Detach listeners from sockets that went away (reconnects).
      for (const old of attached) {
        if (wsObjs.includes(old)) continue;
        try {
          if (typeof old.removeEventListener === "function") {
            old.removeEventListener("message", remix._rawGatewayMessageListener ?? remix._rawGatewayHandler);
            old.removeEventListener("error",   remix._rawGatewayErrorHandler);
          } else if (typeof old.off === "function") {
            old.off("message", remix._rawGatewayMessageListener ?? remix._rawGatewayHandler);
            old.off("error",   remix._rawGatewayErrorHandler);
          }
        } catch(e) { logger.warn("[Gateway] Failed to detach old WS listener:", e?.message); }
        attached.delete(old);
      }

      let attachedNew = false;

      // Create the shared raw-socket handlers once (stateless parsers
      // shared by every local shard socket).
      if (!remix._rawGatewayHandler) {
        remix._rawGatewayHandler = (data) => {
          try {
            if (typeof data === "string" && !RAW_GATEWAY_INTEREST.test(data)) return;
            const payload = typeof data === "string" ? JSON.parse(data) : data;

            if (payload?.op === GatewayOpcodes.GatewayError || payload?.op === 12) {
              logger.warn("[Gateway] GatewayError (12) received from Fluxer:", payload.d);
            }

            if (payload?.op === GatewayOpcodes.Hello || payload?.op === 10) {
              logger.player(`[Gateway] HELLO received (heartbeat ${payload.d?.heartbeat_interval ?? "unknown"}ms)`);
            }
            if (payload?.op === GatewayOpcodes.Reconnect || payload?.op === 7) {
              logger.warn("[Gateway] RECONNECT requested by gateway.");
            }
            if (payload?.op === GatewayOpcodes.InvalidSession || payload?.op === 9) {
              logger.warn("[Gateway] INVALID_SESSION received from gateway.");
            }

            if (payload?.op !== 0) return;

            if (payload.t === "READY") {
              logger.player(`[Gateway] READY received (session ${payload.d?.session_id ?? "unknown"})`);
              const readyGuilds = payload.d?.guilds;
              if (Array.isArray(readyGuilds)) {
                for (const g of readyGuilds) {
                  const gId = g?.id;
                  if (!gId || !Array.isArray(g.voice_states)) continue;
                  for (const state of g.voice_states) {
                    const userId    = state.user_id;
                    const channelId = state.channel_id;
                    if (!userId || !channelId) continue;
                    const isBot  = state.member?.user?.bot ?? false;
                    remix.voiceCache.updateUser({ guildId: gId, userId, channelId, isBot });
                  }
                }
              }
            }

            if (payload.t === "RESUMED") {
              logger.player("[Gateway] RESUMED received from gateway.");
            }

            if (payload.t === "GUILD_CREATE") {
              const d           = payload.d;
              const gId         = d?.id;
              const voiceStates = d?.voice_states;
              if (gId && Array.isArray(voiceStates) && voiceStates.length > 0) {
                for (const state of voiceStates) {
                  const userId    = state.user_id;
                  const channelId = state.channel_id;
                  if (!userId || !channelId) continue;
                  const isBot  = state.member?.user?.bot ?? false;
                  remix.voiceCache.updateUser({ guildId: gId, userId, channelId, isBot });
                }
              }
            }

            if (payload.t === "VOICE_SERVER_UPDATE") {
              logger.voiceState(`[Gateway] VOICE_SERVER_UPDATE guild=${payload.d?.guild_id ?? "dm"} endpoint=${payload.d?.endpoint ?? "unknown"}`);
            }

            if (payload.t === "VOICE_STATE_UPDATE") {
              const d         = payload.d;
              const userId    = d?.user_id;
              const channelId = d?.channel_id ?? null;
              const guildId   = d?.guild_id;
              const isBot     = d?.member?.user?.bot ?? false;
              if (!userId) return;
              if (channelId) {
                remix.voiceCache.updateUser({ guildId, userId, channelId, isBot });
              } else {
                remix.voiceCache.updateUser({ guildId, userId, channelId: null, isBot });
              }
            }
          } catch(e) { logger.warn("[Gateway] Raw gateway handler error:", e?.message); }
        };

        remix._rawGatewayErrorHandler = (errOrEvent) => {
          if (typeof errOrEvent?.preventDefault === "function") errOrEvent.preventDefault();
          const err = errOrEvent?.error ?? errOrEvent?.message ?? errOrEvent;
          const now = Date.now();
          if (now - _wsErrorCooldown.lastLogged < _wsErrorCooldown.COOLDOWN_MS) return;
          _wsErrorCooldown.lastLogged = now;
          logger.warn("[Gateway] Raw WS socket error (will reconnect):", err?.message ?? err);
        };
        remix._rawGatewayMessageListener = (event) => remix._rawGatewayHandler(event?.data ?? event);
      }

      for (const wsObj of wsObjs) {
        if (attached.has(wsObj)) continue;

        if (typeof wsObj.addEventListener === "function") {
          wsObj.addEventListener("message", remix._rawGatewayMessageListener);
          wsObj.addEventListener("error",   remix._rawGatewayErrorHandler);
        } else if (typeof wsObj.on === "function") {
          wsObj.on("message", remix._rawGatewayMessageListener);
          wsObj.on("error",   remix._rawGatewayErrorHandler);
        }

        attached.add(wsObj);
        attachedNew = true;
      }

      // Legacy singular field kept in sync (first socket) for compatibility.
      remix._rawGatewayWsObj = wsObjs[0] ?? null;
      this.wsListenerAttached = attached.size > 0;
      if (attachedNew) {
        logger.player("[Gateway] Raw WS listener attached to new socket.");
      }
    } catch(e) { logger.warn("[Gateway] attachRawListener failed:", e?.message); }
  }

  /** Rotate the bot's presence/status text at a configured interval. @private */
  setupPresenceRotation() {
    if (this.presenceContents.length === 0) return;

    const { remix } = this;
    const client = remix.client;

    const setPresence = () => {
      const entry = this.presenceContents[this.presenceIndex];

      const isObj = typeof entry === "object" && entry !== null;

      const custom_status = {};
      if (isObj) {
        if (entry.text)       custom_status.text       = entry.text;
        if (entry.emoji_name) custom_status.emoji_name  = entry.emoji_name;
        if (entry.emoji_id)   custom_status.emoji_id    = entry.emoji_id;
      } else {
        custom_status.text = String(entry);
      }

      const presence = {
        status:        "online",
        mobile:        false,
        afk:           false,
        custom_status,
      };

      if (isObj && entry.activity) {
        presence.activities = [{
          name: entry.activity.name ?? "music",
          type: entry.activity.type ?? 0,
          url:  entry.activity.url  ?? undefined,
        }];
      }

      // Fluxer 3.0: client.ws is a throwing getter when the gateway is not
      // connected (2.2 exposed a plain optional). The raw opcode-3 payload
      // below stays in wire format (custom_status) because it bypasses
      // ClientUser.setPresence() and hits the shard directly.
      // Sharded children fan the update out to every gateway shard in this
      // process (presence is per shard); single process = shard 0 as before.
      try {
        if (client.ws?.send) {
          for (const id of ShardingUtils.localShardIds(client)) {
            client.ws.send(id, { op: GatewayOpcodes.PresenceUpdate, d: presence });
          }
        } else {
          const shard = ShardingUtils.getShard(client, 0);
          if (shard) shard.send({ op: GatewayOpcodes.PresenceUpdate, d: presence });
        }
      } catch (e) {
        logger.warn("[Presence] Gateway not ready, skipping rotation update:", e?.message);
      }
      this.presenceIndex = (this.presenceIndex + 1) % this.presenceContents.length;
    };
    setPresence();
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = setInterval(setPresence, this.presenceInterval);
  }

  /**
   * Register all gateway event handlers (GuildCreate, GuildDelete, VoiceStateUpdate, VoiceStatesSync).
   * Called once during bot initialisation.
   */
  setupEventHandlers() {
    const { remix } = this;
    const client = remix.client;

    client.on(Events.GuildCreate, async (guild) => {
      const guildId = guild?.id ?? guild?._id;
      if (!guildId) return;

      const deferred = this._deferredGuildDeletes.get(guildId);
      if (deferred) {
        clearTimeout(deferred.timer);
        this._deferredGuildDeletes.delete(guildId);
        logger.guild(
            `[GuildDelete] Cancelled deferred cleanup for server ${guildId} — ` +
            `guild came back (GuildCreate received during grace period).`
        );
      }

      const voiceStatesRaw =
          guild.voice_states ??
          guild.voiceStates ??
          null;

      if (voiceStatesRaw) {
        const newUserIds = new Set();
        for (const vs of iterateVoiceStates(guild)) {
          newUserIds.add(vs.userId);
        }
        remix.voiceCache.purgeUsersInGuild(guildId, newUserIds);
      }
      if (voiceStatesRaw) {
        for (const vs of iterateVoiceStates(guild)) {
          remix.voiceCache.updateUser({ guildId, userId: vs.userId, channelId: vs.channelId, isBot: vs.isBot });
        }
      }

      if (!remix.settingsMgr.guilds.has(guildId)) {
        logger.guild(`[GuildCreate] (Re-)joined server ${guildId} — initialising settings.`);
        try {
          const cleanGuildId = cleanId(guildId);
          if (!cleanGuildId) throw new Error("Invalid guildId: " + guildId);
          const res = await remix.settingsMgr.selectGuild(cleanGuildId);
          if (res?.results?.length) {
            const row    = res.results[0];
            const server = new ServerSettings(guildId, remix.settingsMgr);
            const parsed = (typeof row.data === "string") ? JSON.parse(row.data) : row.data;
            server.deserialize(parsed);
            server.checkDefaults(remix.settingsMgr.defaults);
            remix.settingsMgr.guilds.set(guildId, server);
            logger.guild(`[GuildCreate] Restored existing settings for server ${guildId}.`);
          } else {
            const server = new ServerSettings(guildId, remix.settingsMgr);
            server.checkDefaults(remix.settingsMgr.defaults);
            remix.settingsMgr.guilds.set(guildId, server);
            await remix.settingsMgr.create(guildId, server);
            logger.guild(`[GuildCreate] Fresh settings initialised for server ${guildId}.`);
          }
        } catch (err) {
          logger.warn("[GuildCreate] Settings init failed for", guildId, err.message);
        }
      }

      this._checkGuildPermissions(guild, guildId).catch(e => logger.warn("[GuildCreate] Permission check error for", guildId, e.message));

    });

    client.on(Events.GuildDelete, (guild) => {
      const guildId = guild?.id ?? guild?._id;
      if (!guildId) return;

      if (this._inStartupGrace) {
        this._deferredDeleteCount++;
        if (this._deferredDeleteCount <= 3) {
          logger.guild(
              `[GuildDelete] Deferring cleanup for server ${guildId} ` +
              `(startup grace — will confirm after ${this._startupDeleteGraceMs / 1000}s).`
          );
        }
        const existing = this._deferredGuildDeletes.get(guildId);
        if (existing) clearTimeout(existing.timer);

        const timer = setTimeout(() => {
          this._deferredGuildDeletes.delete(guildId);
          this._processGuildDelete(guildId);
        }, this._startupDeleteGraceMs);

        this._deferredGuildDeletes.set(guildId, { guild, timer });
        return;
      }

      logger.guild(`[GuildDelete] Received GuildDelete for server ${guildId}.`);
      this._processGuildDelete(guildId);
    });

    client.on(Events.VoiceStateUpdate, async (data) => {
      this._handleVoiceStateUpdate(data);
    });

    client.on(Events.VoiceStatesSync, (data) => {
      this._handleVoiceStatesSync(data);
    });
  }

  /**
   * Called when the bot receives the READY event.
   * Seeds voice states, starts presence rotation, ends startup grace period,
   * and begins 24/7 boot recovery.
   */
  onReady() {
    this._lastReadyAt = Date.now();
    this.seedVoiceStatesFromGuilds();
    this.seedGuildsFromRest().catch(e => logger.warn("[onReady] seedGuildsFromRest error:", e.message));
    this.attachRawListener();

    this.setupPresenceRotation();

    setTimeout(() => {
      this._inStartupGrace = false;
      const pending = this._deferredGuildDeletes.size;
      if (pending > 0) {
        logger.guild(
            `[GuildDelete] Startup grace period ended. ` +
            `${pending} deferred deletion(s) confirmed — cleaning up.`
        );
      } else {
        logger.guild(`[GuildDelete] Startup grace period ended. No deferred deletions.`);
      }
      if (this._deferredDeleteCount > 3) {
        logger.guild(
            `[GuildDelete] (Suppressed ${this._deferredDeleteCount - 3} deferral log lines for brevity)`
        );
      }
    }, this._startupDeleteGraceMs);

    this.rejoin247Channels();
  }

  /**
   * Boot recovery: sequentially rejoin all saved 24/7 channels.
   * Sets _bootRecoveryActive=true to suppress fake move events during the process.
   * Cleans up missing channels from settings to prevent repeated failures.
   * @returns {Promise<void>}
   */
  async rejoin247Channels() {
    this._bootRecoveryActive = true;
    try {
      await this._rejoin247ChannelsInner();
    } catch (err) {
      logger.warn("[BootRecovery] 24/7 boot recovery crashed:", err?.message ?? err);
    } finally {
      this._bootRecoveryActive = false;
    }
  }

  /** @private Inner boot-recovery loop. The flag reset is handled by the caller's finally block. */
  async _rejoin247ChannelsInner() {
    const { remix } = this;
    const channelsToRejoin = [];

    for (const [guildId, serverSettings] of remix.settingsMgr.guilds) {
      const raw = serverSettings.get("stay_247");
      if (!raw || raw === "none") continue;

      const rawArr = Array.isArray(raw) ? raw : [raw];
      const channels = rawArr
          .map(id => cleanId(id))
          .filter(id => id.length >= 15 && id.length <= 22);

      for (const channelId of channels) {
        const mode = get247ChannelMode(serverSettings, channelId);
        if (mode === "on") {
          channelsToRejoin.push({ guildId, channelId, mode });
        }
      }
    }

    if (channelsToRejoin.length === 0) {
      logger.voice247("[BootRecovery] No 24/7 channels to rejoin.");
      return;
    }

    logger.voice247(
        `[BootRecovery] Found ${channelsToRejoin.length} 24/7 channel(s) to rejoin: ` +
        channelsToRejoin.map(c => `${c.channelId}(${c.mode})`).join(", ")
    );

    const baseStagger = remix.config?.timers?.bootRejoinStagger ?? 5_000;

    for (let i = 0; i < channelsToRejoin.length; i++) {
      const { guildId, channelId, mode } = channelsToRejoin[i];

      if (i > 0) {
        let staggerDelay = baseStagger;
        if (i >= 8) staggerDelay = baseStagger * 2;
        else if (i >= 4) staggerDelay = Math.round(baseStagger * 1.5);
        logger.voice247(`[BootRecovery] Waiting ${staggerDelay / 1000}s before rejoining next channel...`);
        await new Promise(resolve => setTimeout(resolve, staggerDelay));
      }

      const existing = remix.players.playerMap.get(channelId);
      if (existing && !existing._destroyed) {
        logger.voice247(`[BootRecovery] Channel ${channelId} already has a player — skipping.`);
        continue;
      }
      if (remix.players._pendingJoins?.has?.(channelId)) {
        logger.voice247(`[BootRecovery] Channel ${channelId} already has a pending join — skipping.`);
        continue;
      }

      const channelObj = remix.client?.channels?.get?.(channelId);
      if (!channelObj) {
        logger.warn(
            `[BootRecovery] Channel ${channelId} in guild ${guildId} no longer exists — ` +
            `removing from 24/7 settings to prevent repeated failures.`
        );
        try {
          const set = remix.settingsMgr.getServer(guildId);
          if (set) {
            const raw = set.get("stay_247");
            const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
            const filtered = arr.filter(id => id && id !== "none" && cleanId(id) !== channelId);
            const remainingSet = new Set(filtered.map(id => cleanId(id)));
            remove247ChannelMode(set, channelId, remainingSet);
            set.set("stay_247", filtered.length > 0 ? filtered : "none");
          }
        } catch (cleanupErr) {
          logger.warn(`[BootRecovery] Failed to auto-remove missing channel ${channelId} from 24/7:`, cleanupErr?.message);
        }
        continue;
      }
      if (channelObj.type !== 2) {
        logger.warn(
            `[BootRecovery] Channel ${channelId} in guild ${guildId} is not a voice channel (type: ${channelObj.type}) — skipping.`
        );
        continue;
      }

      const guildHasActivePlayer = [...remix.players.playerMap.values()]
          .some(p => !p._destroyed && cleanId(p._guildId ?? "") === guildId);
      if (guildHasActivePlayer && i > 0) {
        const extraDelay = 3_000;
        logger.voice247(
            `[BootRecovery] Guild ${guildId} already has an active player — ` +
            `waiting extra ${extraDelay / 1000}s to avoid move-disconnect.`
        );
        await new Promise(resolve => setTimeout(resolve, extraDelay));
      }

      logger.voice247(
          `[BootRecovery] Rejoining channel ${channelId} in guild ${guildId} (mode: ${mode}) [${i + 1}/${channelsToRejoin.length}]`
      );

      const player = await this._attemptRejoin(channelId, guildId, 3, 5_000, "BootRecovery");

      if (player) {
        logger.voice247(
            `[BootRecovery] Successfully rejoined channel ${channelId} (mode: ${mode}) [${i + 1}/${channelsToRejoin.length}]`
        );
      } else {
        logger.warn(
            `[BootRecovery] Failed to rejoin channel ${channelId} in guild ${guildId} after retries — ` +
            `keeping 24/7 setting intact, will retry on next disconnect/restart.`
        );
      }
    }

    logger.voice247(
        `[BootRecovery] Boot recovery complete. ${channelsToRejoin.length} channel(s) processed.`
    );
  }
}

// Attach the split-out concerns: voice-state routing (VoiceStateRouting),
// guild sync & seeding (GuildSync), and 24/7 rejoin management (RejoinManager).
applyMixins(GatewayHandler, VoiceStateRouting, GuildSync, RejoinManager);

export { GatewayHandler };
