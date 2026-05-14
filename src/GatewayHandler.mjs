import { Events, GatewayOpcodes } from "@fluxerjs/core";
import { getVoiceManager } from "@fluxerjs/voice";
import { logger } from "./constants/Logger.mjs";
import { ServerSettings } from "./Settings.mjs";
import { get247ChannelMode } from "./constants/Helpers247.mjs";
import mysql from "mysql2";

/**
 * GatewayHandler — manages raw WebSocket gateway events, voice-state tracking,
 * presence rotation, and high-level Fluxer event handlers (GuildCreate,
 * GuildDelete, VoiceStateUpdate).
 *
 * Extracted from index.mjs to reduce the Remix constructor footprint.
 */
export class GatewayHandler {
  /**
   * @param {import('../../index.mjs').Remix} remix          The running bot instance.
   * @param {import('./RecoveryManager.mjs').RecoveryManager} recoveryManager  For scheduleSpawn / 24/7 auto-join.
   */
  constructor(remix, recoveryManager) {
    this.remix = remix;
    this.recoveryManager = recoveryManager;

    // ── Timers config (kept local — derived from remix.config) ───────────────
    const timers = remix.config.timers ?? {};
    this.T = {
      aloneCheckDebounce: timers.aloneCheckDebounce ?? 500,
      rejoin247Delay:     timers.rejoin247Delay     ?? 3_000,
    };

    // ── Presence rotation config ─────────────────────────────────────────────
    this.presenceContents = remix.config.presenceContents ?? [];
    this.presenceInterval = remix.config.presenceInterval ?? 30_000;

    // ── One-time setup guards (persist across reconnects) ─────────────────────
    this.wsListenerAttached = false;
    this.presenceTimer = null;
    this.presenceIndex = 0;

    // ── Previous voice state per-user (for detecting channel moves) ───────────
    /** @type {Map<string, {channelId, guildId}>} guildId:userId → state */
    this._prevVoiceState = new Map();

    // ── Recent join tracker (for detecting channel moves during recovery) ────
    // When the bot joins a new channel via recovery/spawn, the gateway sends
    // a VOICE_STATE_UPDATE with channel_id=null for the old channel. Without
    // tracking recent joins, this looks like a real disconnect and triggers
    // a recovery loop. By tracking recent joins, we can distinguish between
    // a real disconnect and a channel-move side effect.
    /** @type {Map<string, number>} guildId → timestamp of last bot voice join */
    this._recentBotJoins = new Map();
    /** @type {number} Window in ms during which a bot disconnect is considered
     *  a move side-effect rather than a real disconnect. */
    this._moveDetectionWindow = 10_000;

    // ── Gateway disconnect cooldown ──────────────────────────────────────────
    // After the gateway force-disconnects the bot, don't attempt recovery
    // for this guild until the cooldown expires. This prevents the cascade
    // where recovery rejoins → gateway disconnects again → recovery again.
    /** @type {Map<string, number>} guildId → timestamp when cooldown expires */
    this._gatewayDisconnectCooldown = new Map();

    // ── Startup GuildDelete deferral ───────────────────────────────────────
    // Fluxer's GUILD_DELETE does NOT expose the `unavailable` flag, so we
    // cannot distinguish "bot was kicked" from "guild is temporarily
    // unavailable."  During startup, the gateway sends GUILD_DELETE for
    // guilds that went offline while the bot was down, followed immediately
    // by GUILD_CREATE when they come back.  If we process GuildDelete
    // immediately, we wipe in-memory state (settings cache, player map,
    // voice observations) for guilds the bot IS still in, then GuildCreate
    // has to re-load everything from DB — wasting time and causing scary
    // "bot removed from server" log messages for guilds that are fine.
    //
    // Solution: During a startup grace period, buffer GuildDelete events
    // and only process them after the grace period expires.  If a GuildCreate
    // arrives for the same guild before the grace period ends, we cancel the
    // deferred cleanup because the guild is still active.
    /** @type {Map<string, {guild, timer}>} guildId → deferred cleanup data */
    this._deferredGuildDeletes = new Map();
    /** @type {number} How long to defer GuildDelete processing during startup (ms) */
    this._startupDeleteGraceMs = 15_000;
    /** @type {boolean} Whether we're still in the startup grace period */
    this._inStartupGrace = true;
  }

  // ── Voice-state key helpers ──────────────────────────────────────────────────

  /**
   * Generate a composite key for bots in the observedVoiceBots map.
   * Bots can be in multiple guilds so we namespace by guildId.
   */
  getObservedVoiceBotKey(userId, guildId) {
    const cleanUserId = String(userId ?? "").replace(/\D/g, "");
    const cleanGuildId = String(guildId ?? "").replace(/\D/g, "");
    return cleanUserId && cleanGuildId ? `${cleanGuildId}:${cleanUserId}` : cleanUserId || null;
  }

  getPrevVoiceStateKey(userId, guildId) {
    const cleanUserId = String(userId ?? "").replace(/\D/g, "");
    const cleanGuildId = String(guildId ?? "").replace(/\D/g, "");
    return cleanUserId && cleanGuildId ? `${cleanGuildId}:${cleanUserId}` : null;
  }

  findPrevVoiceStateEntry(userId, guildId = null) {
    const directKey = this.getPrevVoiceStateKey(userId, guildId);
    if (directKey && this._prevVoiceState.has(directKey)) {
      return { key: directKey, value: this._prevVoiceState.get(directKey) };
    }

    const cleanUserId = String(userId ?? "").replace(/\D/g, "");
    if (!cleanUserId) return { key: null, value: null };

    for (const [key, value] of this._prevVoiceState) {
      if (key.endsWith(`:${cleanUserId}`)) {
        return { key, value };
      }
    }

    return { key: null, value: null };
  }

  // ── Voice-state seeding from guild cache ─────────────────────────────────────

  /**
   * Seed observedVoiceUsers / observedVoiceBots from all cached guild voice
   * states.  Called once on Ready after the guild cache is populated.
   */
  seedVoiceStatesFromGuilds() {
    const { remix } = this;
    const client = remix.client;

    // ── Primary source: @fluxerjs/voice VoiceManager.voiceStates ────────────
    // The VoiceManager populates its voiceStates Map from VOICE_STATES_SYNC
    // and VOICE_STATE_UPDATE gateway events. This is the most reliable source
    // because it works regardless of whether guild.voice_states is populated
    // by @fluxerjs/core (which it often isn't on Fluxer).
    try {
      const vm = getVoiceManager(client);
      if (vm?.voiceStates) {
        // voiceStates is a Map<guildId, Map<userId, channelId|null>>
        for (const [guildId, userMap] of vm.voiceStates) {
          if (!userMap || typeof userMap.forEach !== "function") continue;
          const cleanGuildId = String(guildId).replace(/\D/g, "");
          if (!cleanGuildId) continue;
          userMap.forEach((channelId, userId) => {
            if (!userId || !channelId) return;
            // The bot's own ID is included in voiceStates — track it as a bot
            const botId = client.user?.id;
            if (userId === botId) {
              const botKey = this.getObservedVoiceBotKey(userId, cleanGuildId);
              if (botKey) remix.observedVoiceBots.set(botKey, { channelId, guildId: cleanGuildId });
            } else {
              // Check if this user is a bot via the members cache
              const guild = client.guilds.get(cleanGuildId) ?? client.guilds.get(guildId);
              const member = guild?.members?.get?.(userId);
              const isBot = member?.user?.bot ?? false;
              if (isBot) {
                const botKey = this.getObservedVoiceBotKey(userId, cleanGuildId);
                if (botKey) remix.observedVoiceBots.set(botKey, { channelId, guildId: cleanGuildId });
              } else {
                remix.observedVoiceUsers.set(userId, { channelId, guildId: cleanGuildId });
              }
            }
          });
        }
        logger.voiceState(
          `[Seed] Seeded from VoiceManager.voiceStates — ` +
          `${remix.observedVoiceUsers.size} humans, ${remix.observedVoiceBots.size} bots tracked.`
        );
        return; // VoiceManager is the primary source — skip fallback
      }
    } catch (e) {
      logger.voiceState(`[Seed] VoiceManager seeding failed: ${e?.message} — falling back to guild cache.`);
    }

    // ── Fallback: guild.voice_states cache ──────────────────────────────────
    // Only used if VoiceManager is unavailable (shouldn't happen in normal ops).
    for (const [gId, guild] of client.guilds) {
      const voiceStatesRaw =
          guild.voice_states ??
          guild.voiceStates ??
          null;
      if (!voiceStatesRaw) continue;

      if (!Array.isArray(voiceStatesRaw) && typeof voiceStatesRaw === "object"
          && typeof voiceStatesRaw.values !== "function") {
        for (const [uid, val] of Object.entries(voiceStatesRaw)) {
          const channelId = typeof val === "string" ? val
              : val?.channelId ?? val?.channel_id ?? null;
          if (!uid || !channelId) continue;
          const isBot = val?.member?.user?.bot ?? false;
          const target = isBot ? remix.observedVoiceBots : remix.observedVoiceUsers;
          target.set(uid, { channelId, guildId: gId });
        }
      } else {
        const entries = Array.isArray(voiceStatesRaw)
            ? voiceStatesRaw
            : [...voiceStatesRaw.values()];
        for (const state of entries) {
          const userId    = state?.userId ?? state?.user_id ?? state?.id;
          const channelId = state?.channelId ?? state?.channel_id;
          if (!userId || !channelId) continue;
          const isBot  = state?.member?.user?.bot ?? false;
          const target = isBot ? remix.observedVoiceBots : remix.observedVoiceUsers;
          target.set(userId, { channelId, guildId: gId });
        }
      }
    }
  }

  // ── Reseed voice states for a specific channel ─────────────────────────────

  /**
   * Re-read the guild's voice_states cache and update observedVoiceUsers
   * for any human users found in the specified channel.
   *
   * This is crucial after bot recovery: when the bot restarts and rejoins a
   * voice channel, the initial `seedVoiceStatesFromGuilds()` may have run
   * before the guild cache was fully populated, or before the bot received
   * VOICE_STATE_UPDATE events for users already in the channel.  Calling
   * this after a player joins ensures the bot knows about humans who were
   * already present.
   *
   * @param {string} guildId
   * @param {string} channelId
   * @returns {number} Number of human users found in the channel.
   */
  reseedVoiceStatesForChannel(guildId, channelId) {
    const { remix } = this;
    const client = remix.client;

    const cleanGuild   = String(guildId).replace(/\D/g, "");
    const cleanChannel = String(channelId).replace(/\D/g, "");
    if (!cleanGuild || !cleanChannel) return 0;

    let humansFound = 0;
    const botId = client.user?.id;

    // ── Primary source: @fluxerjs/voice VoiceManager.voiceStates ────────────
    try {
      const vm = getVoiceManager(client);
      if (vm?.voiceStates) {
        const guildVoiceMap = vm.voiceStates.get(cleanGuild) ?? vm.voiceStates.get(guildId);
        if (guildVoiceMap && typeof guildVoiceMap.forEach === "function") {
          guildVoiceMap.forEach((userChannelId, userId) => {
            if (!userId || !userChannelId) return;
            const userChannel = String(userChannelId).replace(/\D/g, "");
            if (userChannel !== cleanChannel) return;
            if (userId === botId) {
              const botKey = this.getObservedVoiceBotKey(userId, cleanGuild);
              if (botKey) remix.observedVoiceBots.set(botKey, { channelId: cleanChannel, guildId: cleanGuild });
            } else {
              const guild = client.guilds.get(cleanGuild) ?? client.guilds.get(guildId);
              const member = guild?.members?.get?.(userId);
              const isBot = member?.user?.bot ?? false;
              if (isBot) {
                const botKey = this.getObservedVoiceBotKey(userId, cleanGuild);
                if (botKey) remix.observedVoiceBots.set(botKey, { channelId: cleanChannel, guildId: cleanGuild });
              } else {
                remix.observedVoiceUsers.set(userId, { channelId: cleanChannel, guildId: cleanGuild });
                humansFound++;
                logger.voiceState(
                  `[Reseed] Found human ${userId} in channel ${cleanChannel} (guild ${cleanGuild}) via VoiceManager`
                );
              }
            }
          });

          // Update the bot's own entry
          if (botId) {
            const botKey = this.getObservedVoiceBotKey(botId, cleanGuild);
            if (botKey) remix.observedVoiceBots.set(botKey, { channelId: cleanChannel, guildId: cleanGuild });
          }

          logger.voiceState(
            `[Reseed] Channel ${cleanChannel} (guild ${cleanGuild}): ` +
            `found ${humansFound} human(s) via VoiceManager, observedVoiceUsers size now ${remix.observedVoiceUsers.size}`
          );

          // If VoiceManager found humans, skip fallbacks
          if (humansFound > 0) return humansFound;
        }
      }
    } catch (e) {
      logger.voiceState(`[Reseed] VoiceManager lookup failed: ${e?.message} — falling back.`);
    }

    // ── Fallback: guild.voice_states cache ──────────────────────────────────
    const guild = client.guilds.get(cleanGuild) ?? client.guilds.get(guildId);
    if (!guild) {
      logger.voiceState(
        `[Reseed] Guild ${cleanGuild} not in cache — cannot reseed voice states.`
      );
    } else {
      const voiceStatesRaw =
          guild.voice_states ??
          guild.voiceStates ??
          null;

      if (voiceStatesRaw) {
        if (!Array.isArray(voiceStatesRaw) && typeof voiceStatesRaw === "object"
            && typeof voiceStatesRaw.values !== "function") {
          for (const [uid, val] of Object.entries(voiceStatesRaw)) {
            const stateChannel = typeof val === "string" ? val
                : val?.channelId ?? val?.channel_id ?? null;
            if (!uid || !stateChannel) continue;
            const isBot = val?.member?.user?.bot ?? false;
            if (isBot) continue;
            if (String(stateChannel).replace(/\D/g, "") === cleanChannel) {
              remix.observedVoiceUsers.set(uid, { channelId: stateChannel, guildId: cleanGuild });
              humansFound++;
              logger.voiceState(
                `[Reseed] Found human ${uid} in channel ${cleanChannel} (guild ${cleanGuild})`
              );
            }
          }
        } else {
          const entries = Array.isArray(voiceStatesRaw)
              ? voiceStatesRaw
              : [...voiceStatesRaw.values()];
          for (const state of entries) {
            const userId       = state?.userId ?? state?.user_id ?? state?.id;
            const stateChannel = state?.channelId ?? state?.channel_id;
            if (!userId || !stateChannel) continue;
            const isBot = state?.member?.user?.bot ?? false;
            if (isBot) continue;
            if (String(stateChannel).replace(/\D/g, "") === cleanChannel) {
              remix.observedVoiceUsers.set(userId, { channelId: stateChannel, guildId: cleanGuild });
              humansFound++;
              logger.voiceState(
                `[Reseed] Found human ${userId} in channel ${cleanChannel} (guild ${cleanGuild})`
              );
            }
          }
        }

        // Update bot's own entry
        if (botId) {
          const botKey = this.getObservedVoiceBotKey(botId, cleanGuild);
          if (botKey) remix.observedVoiceBots.set(botKey, { channelId: cleanChannel, guildId: cleanGuild });
        }

        if (humansFound > 0) {
          logger.voiceState(
            `[Reseed] Channel ${cleanChannel} (guild ${cleanGuild}): ` +
            `found ${humansFound} human(s), observedVoiceUsers size now ${remix.observedVoiceUsers.size}`
          );
          return humansFound;
        }
      }
    }

    // ── Fallback: observedVoiceUsers ────────────────────────────────────────
    if (humansFound === 0) {
      for (const [uid, info] of remix.observedVoiceUsers) {
        const infoGuild   = String(info.guildId ?? "").replace(/\D/g, "");
        const infoChannel = String(info.channelId ?? "").replace(/\D/g, "");
        if (infoGuild === cleanGuild && infoChannel === cleanChannel) {
          humansFound++;
          logger.voiceState(
            `[Reseed] Found human ${uid} in channel ${cleanChannel} (guild ${cleanGuild}) via observedVoiceUsers`
          );
        }
      }

      // Update bot's own entry
      if (botId) {
        const botKey = this.getObservedVoiceBotKey(botId, cleanGuild);
        if (botKey) remix.observedVoiceBots.set(botKey, { channelId: cleanChannel, guildId: cleanGuild });
      }
    }

    // ── Last resort: LiveKit remote participants ────────────────────────────
    if (humansFound === 0) {
      try {
        const player = remix.players.playerMap.get(cleanChannel);
        const room = player?.connection?.room;
        if (room?.isConnected && room.remoteParticipants) {
          for (const [, participant] of room.remoteParticipants) {
            const userId = participant?.identity ?? participant?.sid;
            if (userId) {
              humansFound++;
              remix.observedVoiceUsers.set(userId, { channelId: cleanChannel, guildId: cleanGuild });
              logger.voiceState(
                `[Reseed] Found human ${userId} in channel ${cleanChannel} (guild ${cleanGuild}) via LiveKit participants`
              );
            }
          }
        }
      } catch (e) {
        logger.voiceState(`[Reseed] LiveKit participant fallback error: ${e?.message}`);
      }
    }

    logger.voiceState(
      `[Reseed] Channel ${cleanChannel} (guild ${cleanGuild}): ` +
      `found ${humansFound} human(s), observedVoiceUsers size now ${remix.observedVoiceUsers.size}`
    );

    return humansFound;
  }

  // ── Raw WebSocket gateway listener ───────────────────────────────────────────

  /**
   * Attach a raw "message" listener to the shard-0 WebSocket so we can
   * process gateway opcodes (READY, GUILD_CREATE, VOICE_STATE_UPDATE, etc.)
   * before @fluxerjs/core emits its high-level events.
   *
   * Safe to call on every reconnect — will detach from the old socket first.
   */
  attachRawListener() {
    const { remix } = this;
    const client = remix.client;

    try {
      const shard0     = client.ws?.shards?.get?.(0);
      const wsObj      = shard0?.ws ?? null;

      // Remove listener from the previous socket if it's a different object
      if (this.wsListenerAttached && remix._rawGatewayWsObj && remix._rawGatewayWsObj !== wsObj) {
        try {
          if (typeof remix._rawGatewayWsObj.removeEventListener === "function") {
            remix._rawGatewayWsObj.removeEventListener("message", remix._rawGatewayMessageListener ?? remix._rawGatewayHandler);
            remix._rawGatewayWsObj.removeEventListener("error",   remix._rawGatewayErrorHandler);
          } else if (typeof remix._rawGatewayWsObj.off === "function") {
            remix._rawGatewayWsObj.off("message", remix._rawGatewayMessageListener ?? remix._rawGatewayHandler);
            remix._rawGatewayWsObj.off("error",   remix._rawGatewayErrorHandler);
          }
        } catch (_) {}
      }

      if (wsObj && wsObj !== remix._rawGatewayWsObj) {
        remix._rawGatewayHandler = (data) => {
          try {
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

            // READY — seed voice states from unavailable-guilds summary
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
                    const target = isBot ? remix.observedVoiceBots : remix.observedVoiceUsers;
                    target.set(isBot ? this.getObservedVoiceBotKey(userId, gId) : userId, { channelId, guildId: gId });
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
                  const target = isBot ? remix.observedVoiceBots : remix.observedVoiceUsers;
                  target.set(isBot ? this.getObservedVoiceBotKey(userId, gId) : userId, { channelId, guildId: gId });
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
              const target = isBot ? remix.observedVoiceBots : remix.observedVoiceUsers;
              const voiceKey = isBot ? this.getObservedVoiceBotKey(userId, guildId) : userId;
              if (channelId) target.set(voiceKey, { channelId, guildId });
              else if (voiceKey) target.delete(voiceKey);
            }
          } catch (_) {}
        };

        remix._rawGatewayErrorHandler = (err) => {
          logger.warn("[Gateway] Raw WS socket error (will reconnect):", err?.message ?? err);
        };
        remix._rawGatewayMessageListener = (event) => remix._rawGatewayHandler(event?.data ?? event);

        if (typeof wsObj.addEventListener === "function") {
          wsObj.addEventListener("message", remix._rawGatewayMessageListener);
          wsObj.addEventListener("error",   remix._rawGatewayErrorHandler);
        } else if (typeof wsObj.on === "function") {
          wsObj.on("message", remix._rawGatewayMessageListener);
          wsObj.on("error",   remix._rawGatewayErrorHandler);
        }

        remix._rawGatewayWsObj = wsObj;
        this.wsListenerAttached = true;
        logger.player("[Gateway] Raw WS listener attached to new socket.");
      }
    } catch (_) {}
  }

  // ── Presence rotation ───────────────────────────────────────────────────────

  setupPresenceRotation() {
    if (this.presenceContents.length === 0) return;

    const { remix } = this;
    const client = remix.client;

    const setPresence = () => {
      const entry = this.presenceContents[this.presenceIndex];

      // Support both plain strings and rich objects:
      // String: "Ping for Prefix"
      // Object: { text: "...", emoji_name: "🎵", activity: { name: "kyun.sh", type: 2 } }
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

      // Add activity (e.g. "Listening to kyun.sh") if provided
      if (isObj && entry.activity) {
        presence.activities = [{
          name: entry.activity.name ?? "music",
          type: entry.activity.type ?? 0,
          url:  entry.activity.url  ?? undefined,
        }];
      }

      if (client.ws?.send) {
        client.ws.send(0, { op: GatewayOpcodes.PresenceUpdate, d: presence });
      } else {
        const shard = client.ws?.shards?.get?.(0);
        if (shard) shard.send({ op: GatewayOpcodes.PresenceUpdate, d: presence });
      }
      this.presenceIndex = (this.presenceIndex + 1) % this.presenceContents.length;
    };
    setPresence();
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = setInterval(setPresence, this.presenceInterval);
  }

  // ── Fluxer event handlers ─────────────────────────────────────────────────────

  /**
   * Register all high-level Fluxer event listeners on the Fluxer client.
   * Call once during bot startup.
   */
  setupEventHandlers() {
    const { remix } = this;
    const client = remix.client;

    // ── GUILD_CREATE ────────────────────────────────────────────────────────
    // Voice-state seeding + settings init for new/re-joined servers.
    client.on(Events.GuildCreate, async (guild) => {
      const guildId = guild?.id ?? guild?._id;
      if (!guildId) return;

      // ── Cancel any deferred GuildDelete for this guild ────────────────
      // If we got GuildDelete → GuildCreate for the same guild during the
      // startup grace period, the guild was temporarily unavailable, not
      // actually kicked. Cancel the deferred cleanup timer.
      const deferred = this._deferredGuildDeletes.get(guildId);
      if (deferred) {
        clearTimeout(deferred.timer);
        this._deferredGuildDeletes.delete(guildId);
        logger.guild(
          `[GuildDelete] Cancelled deferred cleanup for server ${guildId} — ` +
          `guild came back (GuildCreate received during grace period).`
        );
      }

      // Part 1: Voice state population
      // Only purge stale entries if the GUILD_CREATE actually contains
      // voice_states data. If voice_states is empty, the guild may just
      // not provide voice state data in GUILD_CREATE (common on Fluxer),
      // and purging would destroy data we collected from VOICE_STATE_UPDATE
      // events. Only purge entries for users that appear in the new
      // voice_states data (so we can replace them with fresh data).
      const voiceStatesRaw =
          guild.voice_states ??
          guild.voiceStates ??
          null;
      
      if (voiceStatesRaw) {
        // Build a set of user IDs from the new voice_states data
        const newUserIds = new Set();
        if (!Array.isArray(voiceStatesRaw) && typeof voiceStatesRaw === "object"
            && typeof voiceStatesRaw.values !== "function") {
          for (const uid of Object.keys(voiceStatesRaw)) {
            newUserIds.add(uid);
          }
        } else {
          const entries = Array.isArray(voiceStatesRaw)
              ? voiceStatesRaw
              : [...voiceStatesRaw.values()];
          for (const state of entries) {
            const userId = state?.userId ?? state?.user_id ?? state?.id;
            if (userId) newUserIds.add(userId);
          }
        }
        
        // Only purge entries for users/bots that are being replaced by new data.
        // Previously, ALL observedVoiceBots entries for the guild were deleted,
        // which removed the bot's own entry that was set up during recovery.
        // Now we only delete entries for bots whose user ID appears in the new
        // voice_states data, matching the same logic used for observedVoiceUsers.
        for (const [uid, info] of [...remix.observedVoiceUsers]) {
          if (String(info.guildId).replace(/\D/g, "") === String(guildId).replace(/\D/g, "")
              && newUserIds.has(uid)) {
            remix.observedVoiceUsers.delete(uid);
          }
        }
        for (const [uid, info] of [...remix.observedVoiceBots]) {
          if (String(info.guildId).replace(/\D/g, "") === String(guildId).replace(/\D/g, "")) {
            // Only delete if this bot's user ID appears in the new voice_states
            // data — i.e., it's being replaced by fresh data. This prevents
            // destroying the bot's own entry set up during recovery.
            const botUserId = uid.split(":").pop(); // key is "guildId:userId"
            if (botUserId && newUserIds.has(botUserId)) {
              remix.observedVoiceBots.delete(uid);
            }
          }
        }
      }
      if (voiceStatesRaw) {
        if (!Array.isArray(voiceStatesRaw) && typeof voiceStatesRaw === "object"
            && typeof voiceStatesRaw.values !== "function") {
          for (const [uid, val] of Object.entries(voiceStatesRaw)) {
            const channelId = typeof val === "string" ? val
                : val?.channelId ?? val?.channel_id ?? null;
            if (!uid || !channelId) continue;
            const isBot = val?.member?.user?.bot ?? false;
            const target = isBot ? remix.observedVoiceBots : remix.observedVoiceUsers;
            target.set(isBot ? this.getObservedVoiceBotKey(uid, guildId) : uid, { channelId, guildId });
          }
        } else {
          const entries = Array.isArray(voiceStatesRaw)
              ? voiceStatesRaw
              : [...voiceStatesRaw.values()];

          for (const state of entries) {
            const channelId = state?.channelId ?? state?.channel_id;
            const userId    = state?.userId    ?? state?.user_id ?? state?.id;
            const sgid      = state?.guildId   ?? state?.guild_id ?? guildId;
            const isBot     = state?.member?.user?.bot ?? false;
            if (!channelId || !userId) continue;
            const target = isBot ? remix.observedVoiceBots : remix.observedVoiceUsers;
            target.set(isBot ? this.getObservedVoiceBotKey(userId, sgid) : userId, { channelId, guildId: sgid });
          }
        }
      }

      // Part 2: Settings init for new/re-joined servers
      if (!remix.settingsMgr.guilds.has(guildId)) {
        logger.guild(`[GuildCreate] (Re-)joined server ${guildId} — initialising settings.`);
        try {
          const cleanGuildId = String(guildId).replace(/\D/g, "");
          if (!cleanGuildId) throw new Error("Invalid guildId: " + guildId);
          const res = await remix.settingsMgr.query(
              `SELECT * FROM settings WHERE id=${mysql.escape(cleanGuildId)}`
          );
          if (res?.results?.length) {
            const row    = res.results[0];
            const server = new ServerSettings(guildId, remix.settingsMgr);
            // mysql2 may return JSON columns as already-parsed objects;
            // only JSON.parse when the value is still a string.
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

      // Part 3: 24/7 auto-join for late-arriving guilds
      // If tryAutoJoin() has already completed (meaning this GUILD_CREATE
      // arrived after the initial recovery sweep), check whether this guild
      // has 24/7 channels that need a player.  This handles the race where
      // the guild cache wasn't populated when tryAutoJoin() built its join
      // list, causing those channels to be skipped.
      if (this.recoveryManager._autoJoinDone) {
        try {
          const set  = remix.settingsMgr.getServer(guildId);
          if (set) {
            const raw  = set.get("stay_247");
            if (raw && raw !== "none") {
              const channels = Array.isArray(raw)
                  ? raw.map(id => String(id).replace(/\D/g, "")).filter(id => id.length >= 15)
                  : [String(raw).replace(/\D/g, "")].filter(id => id.length >= 15);
              for (const chId of channels) {
                // Per-channel mode: only spawn if this channel is on/auto
                const mode = get247ChannelMode(set, chId);
                if (mode !== "on" && mode !== "auto") continue;
                // Only spawn if there isn't already a player for this channel
                if (!remix.players.playerMap.has(chId) && !this.recoveryManager.pendingSpawns.has(chId)) {
                  logger.voice247(
                    `[GuildCreate] Late-arriving guild ${guildId} — scheduling 24/7 spawn for channel ${chId} (mode ${mode})`
                  );
                  this.recoveryManager.scheduleSpawn(guildId, chId, this.T.rejoin247Delay, "guild-create-247");
                }
              }
            }
          }
        } catch (_) {}
      }
    });

    // ── GUILD_DELETE ────────────────────────────────────────────────────────
    client.on(Events.GuildDelete, (guild) => {
      const guildId = guild?.id ?? guild?._id;
      if (!guildId) return;

      // ── Startup deferral ──────────────────────────────────────────────
      // During startup, the gateway may send GUILD_DELETE for guilds that
      // are temporarily unavailable (not actually kicked). If we process
      // these immediately, we wipe settings/players for guilds that will
      // come back via GUILD_CREATE moments later.  Defer cleanup during
      // the startup grace period; if GuildCreate arrives first, cancel.
      if (this._inStartupGrace) {
        logger.guild(
          `[GuildDelete] Deferring cleanup for server ${guildId} ` +
          `(startup grace — will confirm after ${this._startupDeleteGraceMs / 1000}s).`
        );
        // Cancel any existing deferred timer for this guild
        const existing = this._deferredGuildDeletes.get(guildId);
        if (existing) clearTimeout(existing.timer);

        const timer = setTimeout(() => {
          this._deferredGuildDeletes.delete(guildId);
          // Grace period expired without GuildCreate — this guild is really gone
          logger.guild(`[GuildDelete] Confirmed removal from server ${guildId} — cleaning up.`);
          this._processGuildDelete(guildId);
        }, this._startupDeleteGraceMs);

        this._deferredGuildDeletes.set(guildId, { guild, timer });
        return;
      }

      // ── Runtime (after startup grace) — process immediately ─────────
      logger.guild(`[GuildDelete] Removed from server ${guildId} — cleaning up.`);
      this._processGuildDelete(guildId);
    });

    // ── VOICE_STATE_UPDATE ──────────────────────────────────────────────────
    client.on(Events.VoiceStateUpdate, async (data) => {
      this._handleVoiceStateUpdate(data);
    });
  }

  /**
   * Internal handler for VoiceStateUpdate events.
   * Separated for readability — covers human join/leave, bot move, and bot
   * disconnect recovery.
   */
  async _handleVoiceStateUpdate(data) {
    const { remix } = this;
    const client = remix.client;

    const userId = data?.user_id;
    if (!userId) return;

    const channelId = data?.channel_id ?? null;
    const guildId   = data?.guild_id;
    const isBot     = data?.member?.user?.bot ?? null;

    // Capture old channel BEFORE updating prev state
    const prevEntry    = this.findPrevVoiceStateEntry(userId, guildId);
    const prev         = prevEntry.value;
    // Only treat as a channel move if the previous state is from the SAME guild.
    // Cross-guild previous states are NOT moves — the bot can be in multiple
    // guilds' voice channels simultaneously.  Without this check, concurrent
    // 24/7 recovery triggers a cascading re-key that destroys all but the
    // last guild's playerMap entry.
    const prevSameGuild = prev &&
        String(prev.guildId ?? "").replace(/\D/g, "") === String(guildId ?? "").replace(/\D/g, "");
    const oldChannelId = prevSameGuild ? (prev?.channelId ?? null) : null;
    const prevKey      = prevEntry.key;

    // Update prev state
    const nextKey = this.getPrevVoiceStateKey(userId, guildId ?? prev?.guildId);
    if (channelId) {
      if (prevKey && prevKey !== nextKey) {
        // Only delete the previous entry if it's from the SAME guild.
        // The bot can be in multiple guilds' voice channels simultaneously,
        // so we must preserve cross-guild entries.
        const prevGuildPart = prevKey.split(":")[0];
        const nextGuildPart = nextKey.split(":")[0];
        if (prevGuildPart === nextGuildPart) {
          this._prevVoiceState.delete(prevKey);
        }
      }
      if (nextKey && this._prevVoiceState.size >= 10_000 && !this._prevVoiceState.has(nextKey)) {
        this._prevVoiceState.delete(this._prevVoiceState.keys().next().value);
      }
      if (nextKey) this._prevVoiceState.set(nextKey, { channelId, guildId: guildId ?? prev?.guildId });
    } else {
      if (prevKey) this._prevVoiceState.delete(prevKey);
    }

    // Always update/delete the voice maps
    const target = isBot === true ? remix.observedVoiceBots : remix.observedVoiceUsers;
    const voiceKey = isBot === true ? this.getObservedVoiceBotKey(userId, guildId ?? prev?.guildId) : userId;
    if (channelId) {
      if (voiceKey) target.set(voiceKey, { channelId, guildId });
    } else {
      remix.observedVoiceUsers.delete(userId);
      if (voiceKey) remix.observedVoiceBots.delete(voiceKey);
      const fallbackBotKey = this.getObservedVoiceBotKey(userId, prev?.guildId);
      if (fallbackBotKey && fallbackBotKey !== voiceKey) remix.observedVoiceBots.delete(fallbackBotKey);
    }

    const isBotUser = isBot === true && userId === client.user?.id;

    if (!isBotUser) {
      // ── Human user logic ──────────────────────────────────────────────────
      const resolvedGuildId = guildId ?? prev?.guildId;
      if (!resolvedGuildId) return;

      if (channelId) {
        try {
          const cleanId247 = String(channelId).replace(/\D/g, "");
          const player247  = remix.players.playerMap.get(cleanId247);
          if (player247 && typeof player247._stopInactivityTimer === "function") {
            logger.voiceState(`[VoiceState] Human joined 247 channel ${cleanId247}, stopping inactivity timer`);
            player247._stopInactivityTimer();
          }
        } catch (_) {}
      }

      // Human LEFT a voice channel
      if (oldChannelId && oldChannelId !== channelId) {
        try {
          const cleanOld = String(oldChannelId).replace(/\D/g, "");
          const player   = remix.players.playerMap.get(cleanOld);
          if (player && typeof player._startInactivityTimer === "function") {
            setTimeout(() => {
              if (!player._hasHumansInChannel()) {
                logger.voiceState(`[VoiceState] Last human left ${cleanOld}, starting inactivity timer`);
                player._startInactivityTimer();
              }
            }, this.T.aloneCheckDebounce);
          }
        } catch (_) {}
      }

      // Human JOINED the bot's channel
      if (channelId) {
        try {
          const cleanId = String(channelId).replace(/\D/g, "");
          const player  = remix.players.playerMap.get(cleanId);
          if (player && typeof player._stopInactivityTimer === "function") {
            logger.voiceState(`[VoiceState] Human joined ${cleanId}, stopping inactivity timer`);
            player._stopInactivityTimer();
          }
        } catch (_) {}
      }

      // Dashboard update
      if (remix.dashboard?.enabled) {
        try {
          const userObj = data?.member?.user;
          if (!userObj) {
            try { await client.users.fetch(userId).catch(() => {}); } catch (_) {}
          }
          if (userObj) {
            // Send user update on the global :users channel
            const details = {
              type: channelId ? "join" : "leave",
              guildId: resolvedGuildId,
              channelId: channelId ?? null,
              oldChannelId: oldChannelId ?? null,
            };
            remix.dashboard.updateUser(details, userObj);
          }

          // Send per-player channel events for join/leave
          const refChannel = channelId ?? oldChannelId;
          const cleanId_ref = refChannel ? String(refChannel).replace(/\D/g, "") : null;

          if (cleanId_ref) {
            const player = remix.players.playerMap.get(cleanId_ref);
            if (player) {
              // Send "join" or "leave" on the per-player channel
              // (standard format: { type, data } where data = userId)
              const eventType = channelId ? "join" : "leave";
              remix.dashboard.updatePlayer({
                type: eventType,
                data: userId,
              }, player);

              // Also update the global players channel with current player state
              remix.dashboard.playerUpdate({
                type: eventType,
              }, player);
            }
          }
        } catch (_) {}
      }

      return;
    }

    // ── Bot-only logic below ───────────────────────────────────────────────

    // Track recent bot joins to distinguish real disconnects from move side-effects
    if (channelId && guildId) {
      this._recentBotJoins.set(String(guildId).replace(/\D/g, ""), Date.now());
    }

    const activeGuildPlayers = [...remix.players.playerMap.entries()].filter(([, player]) =>
      String(player?._guildId ?? "").replace(/\D/g, "") === String(guildId ?? "").replace(/\D/g, "")
    );
    const multiVoiceGuild = activeGuildPlayers.length > 1;

    // Bot moved channels — auto-save 247 setting
    if (channelId && guildId && oldChannelId && oldChannelId !== channelId) {
      try {
        // For multi-voice guilds, only re-key if we can unambiguously match
        // the player by oldChannelId. Previously this skipped entirely for
        // multi-voice guilds, which broke recovery for all channels.
        const cleanId  = String(channelId).replace(/\D/g, "");
        const cleanOld = String(oldChannelId).replace(/\D/g, "");
        const moveSet = remix.settingsMgr.getServer(guildId);
        const moveRaw = moveSet?.get("stay_247");
        const saved247Channels = (!moveRaw || moveRaw === "none")
            ? []
            : Array.isArray(moveRaw)
                ? moveRaw.map(id => String(id).replace(/\D/g, "")).filter(id => id.length >= 15)
                : [String(moveRaw).replace(/\D/g, "")].filter(id => id.length >= 15);

        if (saved247Channels.length > 1) {
          logger.voice247(
            `[247] Ignoring move-style bot voice update ${cleanOld} → ${cleanId} ` +
            `because guild ${guildId} already has multiple saved 24/7 channels ` +
            `[${saved247Channels.join(", ")}]`
          );
          return;
        }

        const existingPlayer = remix.players.playerMap.get(cleanOld);
        const newChannelAlreadySaved = (() => {
          try {
            const set = remix.settingsMgr.getServer(guildId);
            const raw = set?.get("stay_247");
            if (!raw || raw === "none") return false;
            const saved = Array.isArray(raw)
                ? raw.map(id => String(id).replace(/\D/g, "")).filter(id => id.length >= 15)
                : [String(raw).replace(/\D/g, "")].filter(id => id.length >= 15);
            return saved.includes(cleanId);
          } catch (_) {
            return false;
          }
        })();
        const newChannelPendingSpawn =
            this.recoveryManager?.pendingSpawns?.has?.(cleanId) ||
            remix.players?._pendingJoins?.has?.(cleanId) ||
            false;
        const targetChannel = client.channels.get(cleanId)
          ?? client.channels.get?.(cleanId)
          ?? null;
        const targetGuildId = String(targetChannel?.guildId ?? targetChannel?.guild?.id ?? guildId ?? "").replace(/\D/g, "");
        const playerGuildId = String(existingPlayer?._guildId ?? "").replace(/\D/g, "");
        const guildPlayers = [...remix.players.playerMap.entries()].filter(([, player]) =>
          String(player?._guildId ?? "").replace(/\D/g, "") === String(guildId ?? "").replace(/\D/g, "")
        );
        const guildIsAmbiguous = guildPlayers.length > 1;

        let rekeyed = false;
        if (existingPlayer && cleanId !== cleanOld) {
          if (newChannelAlreadySaved || newChannelPendingSpawn) {
            // Multi-voice case: joining/spawning another channel in the same
            // guild can look like a move event for the bot user. In that
            // situation we must NOT re-key the old player or rewrite stay_247,
            // otherwise one saved channel gets collapsed into the newer one.
            logger.voice247(
              `[247] Keeping both channels ${cleanOld} and ${cleanId} ` +
              `(saved=${newChannelAlreadySaved} pending=${newChannelPendingSpawn})`
            );
            rekeyed = false;
          } else
          if (guildIsAmbiguous) {
            // Multi-voice guild: we need to re-key the playerMap so that
            // lookups by the new channelId work. First check that no OTHER
            // player is already using the new channelId as its key.
            const playerAtNewKey = remix.players.playerMap.get(cleanId);
            if (playerAtNewKey && playerAtNewKey !== existingPlayer) {
              // Another player already uses the new key — update the moved
              // player's channel fields but don't re-key to avoid collision.
              existingPlayer._channelId = cleanId;
              existingPlayer._home247Channel = cleanId;
              if (targetGuildId) existingPlayer._guildId = targetGuildId;
              rekeyed = false;
              logger.voice247(
                `[247] Updated player channel ${cleanOld} → ${cleanId} ` +
                `(guild ${guildId} has ${guildPlayers.length} active players, ` +
                `new key occupied by another player — skipped re-key)`
              );
            } else {
              // Safe to re-key: no collision
              remix.players.playerMap.delete(cleanOld);
              remix.players.playerMap.set(cleanId, existingPlayer);
              existingPlayer._channelId = cleanId;
              existingPlayer._home247Channel = cleanId;
              if (targetGuildId) existingPlayer._guildId = targetGuildId;
              rekeyed = true;
              logger.voice247(
                `[247] Re-keyed playerMap ${cleanOld} → ${cleanId} ` +
                `(guild ${guildId} has ${guildPlayers.length} active players)`
              );
            }
          } else if (playerGuildId && targetGuildId && playerGuildId !== targetGuildId) {
            // If there's no player for the old channel in playerMap, this is a
            // stale "move" from a pre-restart voice state — the bot was in
            // cleanOld before the restart, but recovery already spawned a
            // player for the new channel (cleanId) or a different channel.
            // In this case, just update the observed bot state without re-keying.
            if (!existingPlayer) {
              logger.voice247(
                `[247] Stale cross-guild move ${cleanOld} → ${cleanId} ` +
                `(no player in playerMap for old channel — updating bot state only)`
              );
            } else {
              // There IS a player in the old channel but the guilds don't match.
              // This can happen during recovery when voice state data is
              // inconsistent. Instead of refusing outright, check if the player
              // in the old channel actually belongs to the target guild (the
              // playerGuildId might be stale from before restart).
              // If the target channel's guild matches the VOICE_STATE_UPDATE's
              // guild, update the player's guildId and re-key.
              const vsuGuildId = String(guildId ?? "").replace(/\D/g, "");
              if (vsuGuildId && targetGuildId === vsuGuildId) {
                // The VOICE_STATE_UPDATE guild matches the target channel —
                // this is likely a stale playerGuildId from before restart.
                // Safe to update the player's guild and re-key.
                existingPlayer._guildId = targetGuildId;
                existingPlayer._channelId = cleanId;
                existingPlayer._home247Channel = cleanId;
                remix.players.playerMap.delete(cleanOld);
                remix.players.playerMap.set(cleanId, existingPlayer);
                rekeyed = true;
                logger.voice247(
                  `[247] Fixed stale guild during recovery: re-keyed ${cleanOld} → ${cleanId} ` +
                  `(playerGuild ${playerGuildId} → ${targetGuildId})`
                );
              } else {
                logger.warn(
                  `[247] Refused cross-guild re-key ${cleanOld} → ${cleanId} ` +
                  `(playerGuild=${playerGuildId} targetGuild=${targetGuildId})`
                );
              }
            }
          } else {
            remix.players.playerMap.delete(cleanOld);
            remix.players.playerMap.set(cleanId, existingPlayer);
            existingPlayer._channelId = cleanId;
            existingPlayer._home247Channel = cleanId;
            if (targetGuildId) existingPlayer._guildId = targetGuildId;
            rekeyed = true;
            logger.voice247(`[247] Re-keyed playerMap ${cleanOld} → ${cleanId}`);
          }
        }

        const set = remix.settingsMgr.getServer(guildId);
        const raw = set.get("stay_247");
        if ((rekeyed || existingPlayer) && raw && raw !== "none") {
          const channels = Array.isArray(raw)
              ? new Set(raw.map(id => String(id).replace(/\D/g, "")).filter(id => id.length >= 15))
              : new Set();
          if (channels.has(cleanOld) && cleanOld !== cleanId && cleanId.length >= 15) {
            if (channels.has(cleanId) || newChannelAlreadySaved || newChannelPendingSpawn) {
              logger.voice247(
                `[247] Preserved stay_247 channels ${cleanOld} and ${cleanId} ` +
                `(saved=${channels.has(cleanId) || newChannelAlreadySaved} pending=${newChannelPendingSpawn})`
              );
              return;
            }
            // Replace the old channel with the new one in stay_247.
            // Previously this kept BOTH channels, causing unbounded growth
            // in the stay_247 list (e.g. guild 1480202154270605526 ended up
            // with 5+ channels). Now we remove the old channel and add the
            // new one so the list stays at the correct size.
            channels.delete(cleanOld);
            channels.add(cleanId);
            set.set("stay_247", [...channels]);

            // Move the per-channel mode from old → new channel
            const modes = set.get("stay_247_modes");
            if (modes && typeof modes === "object" && !Array.isArray(modes)) {
              if (modes[cleanOld] && !modes[cleanId]) {
                modes[cleanId] = modes[cleanOld];
              }
              delete modes[cleanOld];
              set.set("stay_247_modes", modes);
            }

            logger.voice247(`[247] Updated stay_247: ${cleanOld} → ${cleanId}`);
          }
        }
      } catch (e) {
        logger.warn("[247] Failed to auto-save channel:", e.message);
      }
    }

    // Bot disconnected unexpectedly — rejoin if 247 active
    if (!channelId && oldChannelId && guildId) {
      try {
        const cleanOld = String(oldChannelId).replace(/\D/g, "");
        const cleanGuild = String(guildId).replace(/\D/g, "");
        if (remix.intentionalLeaves.has(cleanOld)) {
          logger.voice247(`[247] Skipping rejoin for ${cleanOld} — intentional leave.`);
        } else {
          // Check if the bot is still in another voice channel in this guild.
          // During multi-voice recovery, the bot may be moved from one channel
          // to another, which triggers a disconnect event for the old channel.
          // This is NOT a real disconnect — it's a side effect of joining a
          // new channel in the same guild. Skip recovery in this case to
          // prevent the recovery loop (Bug #5).
          const botInOtherChannel = [...remix.players.playerMap.entries()].some(([mapKey, p]) => {
            if (String(p?._guildId ?? "").replace(/\D/g, "") !== String(guildId ?? "").replace(/\D/g, "")) return false;
            const pChannel = String(p?._channelId ?? mapKey).replace(/\D/g, "");
            return pChannel !== cleanOld && !p.leaving && !p._destroyed;
          });

          // Also check if there was a recent bot join in this guild — if so,
          // the disconnect is likely a side-effect of the channel move, not a
          // real disconnect that needs recovery.
          // IMPORTANT: We also verify that the bot is in another channel in
          // THIS SAME guild. Cross-guild joins should NOT suppress recovery
          // for this guild's disconnect — that was causing guilds to lose
          // their 24/7 player silently when a different guild joined nearby.
          const recentJoin = this._recentBotJoins.get(cleanGuild) ?? 0;
          const timeSinceJoin = Date.now() - recentJoin;
          const isLikelyMoveSideEffect = timeSinceJoin < this._moveDetectionWindow && botInOtherChannel;

          // Also check if there are pending spawns for this guild — if a
          // spawnPlayer is in progress, the disconnect is expected.
          // pendingSpawns is a Set<string> (channel IDs), not a Map — we
          // cross-reference with scheduledSpawns to check the guild.
          const hasPendingSpawn = (() => {
            for (const chId of this.recoveryManager.pendingSpawns) {
              const entry = this.recoveryManager.scheduledSpawns.get(chId);
              if (entry && String(entry.guildId).replace(/\D/g, "") === cleanGuild) return true;
            }
            for (const [, entry] of this.recoveryManager.scheduledSpawns) {
              if (String(entry.guildId).replace(/\D/g, "") === cleanGuild) return true;
            }
            return false;
          })();

          // Check gateway disconnect cooldown — if the gateway recently
          // force-disconnected us, don't attempt recovery again immediately.
          const cooldownExpiry = this._gatewayDisconnectCooldown.get(cleanGuild) ?? 0;
          const inCooldown = Date.now() < cooldownExpiry;

          if (inCooldown) {
            logger.voice247(
              `[247] Skipping recovery for ${cleanOld} in guild ${guildId} — ` +
              `gateway disconnect cooldown active (${Math.ceil((cooldownExpiry - Date.now()) / 1000)}s remaining).`
            );
          } else if (botInOtherChannel || (isLikelyMoveSideEffect && !hasPendingSpawn)) {
            const reason = botInOtherChannel ? "bot in other channel" : `recent join ${timeSinceJoin}ms ago (move side-effect)`;
            logger.voice247(
              `[247] Bot disconnected from ${cleanOld} but ${reason} ` +
              `in guild ${guildId} — skipping recovery (likely a channel move).`
            );
            // Clean up the old player entry if it wasn't already removed
            const oldPlayer = remix.players.playerMap.get(cleanOld);
            if (oldPlayer && !oldPlayer._destroyed) {
              remix.players.playerMap.delete(cleanOld);
              try { oldPlayer.destroy(); } catch (_) {}
            }
          } else if (hasPendingSpawn) {
            logger.voice247(
              `[247] Bot disconnected from ${cleanOld} in guild ${guildId} — ` +
              `pending spawn in progress, skipping recovery to avoid race.`
            );
          } else {
            const set = remix.settingsMgr.getServer(guildId);
            if (!set) {
              logger.voice247(
                `[247] Skipping recovery for ${cleanOld} in guild ${guildId} — ` +
                `settings not loaded yet (race with GuildCreate).`
              );
              return;
            }
            const raw = set.get("stay_247");
            if (raw && raw !== "none") {
              const channels = Array.isArray(raw)
                  ? new Set(raw.map(id => String(id).replace(/\D/g, "")).filter(id => id.length >= 15))
                  : new Set();
              if (channels.has(cleanOld)) {
                // Per-channel mode: check the mode for this specific channel
                const mode = get247ChannelMode(set, cleanOld);
                if (mode === "on" || mode === "auto") {
                  // Check persistent 401 ban — if this guild was recently
                  // 401-banned, don't attempt recovery (it will fail).
                  const banExpiry = this.recoveryManager._guild401Ban?.get(cleanGuild) ?? 0;
                  if (banExpiry > Date.now()) {
                    logger.voice247(
                      `[247] Skipping recovery for ${cleanOld} in guild ${guildId} — ` +
                      `guild is 401-banned (${Math.round((banExpiry - Date.now()) / 1000)}s remaining).`
                    );
                    // Remove the old player entry and destroy it
                    const bannedPlayer = remix.players.playerMap.get(cleanOld);
                    remix.players.playerMap.delete(cleanOld);
                    try { bannedPlayer?.destroy(); } catch (_) {}
                    return;
                  }

                  // Match the specific player by channel ID
                  const player = remix.players.playerMap.get(cleanOld);
                  if (player && !player.leaving) {
                    logger.voice247(
                      `[247] Fluxer gateway disconnected ${cleanOld} in guild ${guildId} — scheduling 24/7 respawn.`
                    );

                    // Set a gateway disconnect cooldown for this guild to
                    // prevent recovery cascades. If recovery rejoins and the
                    // gateway force-disconnects again, we don't want to
                    // immediately retry.
                    this._gatewayDisconnectCooldown.set(cleanGuild, Date.now() + 15_000);
                    // Auto-clear the cooldown after 30 seconds
                    setTimeout(() => this._gatewayDisconnectCooldown.delete(cleanGuild), 30_000);

                    // Mark the disconnect reason before shutting the player down.
                    player._lastDisconnectReason = "gateway";
                    player._lastDisconnectTime = Date.now();
                    remix.players.playerMap.delete(cleanOld);
                    try { player.destroy(); } catch (_) {}
                    this.recoveryManager.scheduleSpawn(guildId, cleanOld, this.T.rejoin247Delay, "gateway-disconnect");
                  } else {
                    this.recoveryManager.scheduleSpawn(guildId, cleanOld, this.T.rejoin247Delay, "gateway-disconnect");
                  }
                } else {
                  logger.voice247(`[247] Channel ${cleanOld} mode='${mode}' — not rejoining.`);
                  channels.delete(cleanOld);
                  set.set("stay_247", channels.size > 0 ? [...channels] : "none");
                  // Also clean up the per-channel mode entry
                  const modes = set.get("stay_247_modes");
                  if (modes && typeof modes === "object" && !Array.isArray(modes)) {
                    delete modes[cleanOld];
                    set.set("stay_247_modes", modes);
                  }
                  if (channels.size === 0) set.set("stay_247_mode", "off");
                  else {
                    const first = [...channels][0];
                    set.set("stay_247_mode", modes?.[first] ?? "auto");
                  }
                }
              }
            }
          }
        }
      } catch (e) {
        logger.warn("[247] Rejoin on disconnect failed:", e.message);
      }
    }
  }

  // ── Called from Events.Ready ─────────────────────────────────────────────────

  /**
   * Invoke after the bot has connected and Moonlink has been initialised.
   * Seeds voice states, attaches raw WS listener, signals botReady, and
   * kicks off presence rotation.
   */
  onReady() {
    this.seedVoiceStatesFromGuilds();
    this.attachRawListener();

    this.recoveryManager.botReady = true;
    this.recoveryManager.tryAutoJoin();

    this.setupPresenceRotation();

    // End the startup grace period after the configured delay.
    // Any deferred GuildDelete events that weren't cancelled by a GuildCreate
    // will be processed at this point.
    setTimeout(() => {
      this._inStartupGrace = false;
      const pending = this._deferredGuildDeletes.size;
      if (pending > 0) {
        logger.guild(
          `[GuildDelete] Startup grace period ended. ` +
          `${pending} deferred deletion(s) will be processed by their timers.`
        );
      } else {
        logger.guild(`[GuildDelete] Startup grace period ended. No deferred deletions.`);
      }
    }, this._startupDeleteGraceMs);
  }

  // ── GuildDelete cleanup (extracted for deferred processing) ────────────────

  /**
   * Perform the actual cleanup for a guild that the bot was removed from.
   * Extracted from the GuildDelete handler so it can be called after the
   * startup grace period expires.
   * @param {string} guildId
   */
  _processGuildDelete(guildId) {
    const { remix } = this;
    const cleanGuildId = String(guildId).replace(/\D/g, "");

    for (const [channelId, player] of remix.players.playerMap) {
      if (String(player._guildId ?? "").replace(/\D/g, "") === cleanGuildId) {
        remix.players.playerMap.delete(channelId);
        try { player.leave().catch(() => {}); } catch (_) {}
        try { player.destroy();               } catch (_) {}
        logger.guild(`[GuildDelete] Destroyed player for channel ${channelId}.`);
      }
    }

    for (const [userId, info] of [...remix.observedVoiceUsers]) {
      if (String(info.guildId).replace(/\D/g, "") === cleanGuildId) remix.observedVoiceUsers.delete(userId);
    }
    for (const [userId, info] of [...remix.observedVoiceBots]) {
      if (String(info.guildId).replace(/\D/g, "") === cleanGuildId) remix.observedVoiceBots.delete(userId);
    }
    for (const [stateKey, info] of [...this._prevVoiceState]) {
      if (String(info.guildId).replace(/\D/g, "") === cleanGuildId)
        this._prevVoiceState.delete(stateKey);
    }

    remix.settingsMgr.removeServer(guildId);
    remix._announcementChannelCache.delete(guildId);

    logger.guild(`[GuildDelete] Cleanup complete for server ${guildId}.`);
  }
}
