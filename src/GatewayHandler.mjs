/**
 * @file GatewayHandler.mjs — GatewayHandler — processes raw WebSocket events for voice state tracking, 24/7 recovery, and guild lifecycle
 * @module src.GatewayHandler
 */

import { Events, GatewayOpcodes } from "@fluxerjs/core";
import { getVoiceManager } from "@fluxerjs/voice";
import { logger, _wsErrorCooldown } from "./constants/Logger.mjs";
import { ServerSettings } from "./Settings.mjs";
import { get247ChannelMode, remove247ChannelMode } from "./constants/Helpers247.mjs";
import { VoiceStateCache } from "./constants/VoiceStateCache.mjs";
import { REQUIRED_BOT_PERMISSIONS } from "./MessageHandler.mjs";
import { cleanId } from "./Utils.mjs";
import { iterateVoiceStates, hasHumansInChannel, getChannelsWithHumans } from "./constants/VoiceStateResolver.mjs";

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

    /** @type {Map<string, {channelId, guildId}>} guildId:userId → state */
    this._prevVoiceState = new Map();

    /** @type {Map<string, {guild, timer}>} guildId → deferred cleanup data */
    this._deferredGuildDeletes = new Map();
    /** @type {number} How long to defer GuildDelete processing during startup (ms) */
    this._startupDeleteGraceMs = 15_000;
    /** @type {boolean} Whether we're still in the startup grace period */
    this._inStartupGrace = true;
    /** @type {number} Counter for deferred deletions (used for batch summary log) */
    this._deferredDeleteCount = 0;
  }

  /**
   * Generate a composite key for bots in the observedVoiceBots map.
   * Bots can be in multiple guilds so we namespace by guildId.
   */
  getObservedVoiceBotKey(userId, guildId) {
    const cleanUserId = cleanId(userId ?? "");
    const cleanGuildId = cleanId(guildId ?? "");
    return cleanUserId && cleanGuildId ? `${cleanGuildId}:${cleanUserId}` : cleanUserId || null;
  }

  getPrevVoiceStateKey(userId, guildId) {
    const cleanUserId = cleanId(userId ?? "");
    const cleanGuildId = cleanId(guildId ?? "");
    return cleanUserId && cleanGuildId ? `${cleanGuildId}:${cleanUserId}` : null;
  }

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

  /**
   * Check if the bot has all required permissions in a newly joined guild.
   * If critical permissions are missing, log a warning and attempt to send
   * a notification to the guild's system channel (or first text channel).
   *
   * @param {import('@fluxerjs/core').Guild} guild
   * @param {string} guildId
   */
  async _checkGuildPermissions(guild, guildId) {
    const { remix } = this;

    try {
      if (guild.members && !guild.members.me) {
        await guild.members.fetchMe();
      }
    } catch (_) { logger.warn("[GatewayHandler] fetchMe failed"); }

    const channels = guild.channels;
    if (!channels) return;

    let targetChannel = null;
    if (guild.systemChannelId) {
      targetChannel = channels.get?.(guild.systemChannelId)
          ?? channels.cache?.get?.(guild.systemChannelId)
          ?? null;
    }
    if (!targetChannel) {
      for (const ch of (channels.values?.() ?? [])) {
        if (ch.isTextBased?.() || ch.type === 0 || ch.type === "GUILD_TEXT") {
          targetChannel = ch;
          break;
        }
      }
    }
    if (!targetChannel) return;

    const result = remix.messages.checkAllBotPermissions(targetChannel);
    if (result.missing.length === 0) return;

    const missingNames = result.missing.map(k => REQUIRED_BOT_PERMISSIONS.get(k)?.name ?? k);
    if (result.criticalMissing.length > 0) {
      logger.warn(
          `[GuildCreate] Server ${guildId} is missing CRITICAL bot permissions: ${result.criticalMissing.join(", ")}\n` +
          `  All missing: ${missingNames.join(", ")}`
      );
    } else {
      logger.guild(
          `[GuildCreate] Server ${guildId} is missing optional permissions: ${result.optionalMissing.join(", ")}`
      );
    }

    try {
      const permEmbed = remix.messages.buildPermissionEmbed(result.missing, guildId);
      await targetChannel.send({ embeds: [permEmbed] });
    } catch (e) {
      logger.warn(`[GuildCreate] Cannot send permission warning to server ${guildId}: ${e.message}`);
      try {
        const t = this.remix.locale?.translate?.bind(this.remix.locale);
        const guildIdStr = cleanId(guildId);
        await targetChannel.send(
            t ? t(guildIdStr, "responses.gateway.missingPermsFallback", { perms: missingNames.join("**, **") }) :
            "⚠️ I'm missing permissions I need to work properly! Missing: **" + missingNames.join("**, **") + "**. Please ask a server administrator to grant these permissions in Server Settings → Roles."
        );
      } catch (_) {
        logger.warn(`[GuildCreate] Cannot send ANY notification to server ${guildId} — bot is missing SendMessages permission.`);
      }
    }
  }

  /**
   * Seed observedVoiceUsers / observedVoiceBots from all cached guild voice
   * states.  Called once on Ready after the guild cache is populated.
   */
  seedVoiceStatesFromGuilds() {
    const { remix } = this;
    const client = remix.client;

    try {
      const vm = getVoiceManager(client);
      if (vm?.voiceStates && vm.voiceStates.size > 0) {
        let totalHumans = 0;
        let totalBots = 0;
        for (const [guildId, userMap] of vm.voiceStates) {
          if (!userMap || typeof userMap.forEach !== "function") continue;
          const cleanGuildId = cleanId(guildId);
          if (!cleanGuildId) continue;
          userMap.forEach((channelId, userId) => {
            if (!userId || !channelId) return;
            const botId = client.user?.id;
            if (userId === botId) {
              remix.voiceCache.updateUser({ guildId: cleanGuildId, userId, channelId, isBot: true });
              totalBots++;
            } else {
              const guild = client.guilds.get(cleanGuildId) ?? client.guilds.get(guildId);
              const member = guild?.members?.get?.(userId);
              const isBot = member?.user?.bot ?? false;
              remix.voiceCache.updateUser({ guildId: cleanGuildId, userId, channelId, isBot });
              if (isBot) totalBots++;
              else totalHumans++;
            }
          });
        }
        logger.voiceState(
            `[Seed] Seeded from VoiceManager.voiceStates — ` +
            `${totalHumans} humans, ${totalBots} bots across ${vm.voiceStates.size} guilds. ` +
            `Cache now: ${remix.voiceCache.observedVoiceUsersSize} humans, ${remix.voiceCache.observedVoiceBotsSize} bots.`
        );
        return;
      }
      logger.voiceState(`[Seed] VoiceManager.voiceStates is empty (${vm?.voiceStates?.size ?? "null"} guilds). ` +
          `This is expected if no users were in voice when the bot started. ` +
          `VoiceStatesSync handler will populate the cache as guilds become available.`);
    } catch (e) {
      logger.voiceState(`[Seed] VoiceManager seeding failed: ${e?.message} — falling back to guild cache.`);
    }

    for (const [gId, guild] of client.guilds) {
      for (const vs of iterateVoiceStates(guild)) {
        remix.voiceCache.updateUser({ guildId: gId, userId: vs.userId, channelId: vs.channelId, isBot: vs.isBot });
      }
    }
  }

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

    const cleanGuild   = cleanId(guildId);
    const cleanChannel = cleanId(channelId);
    if (!cleanGuild || !cleanChannel) return 0;

    let humansFound = 0;
    const botId = client.user?.id;

    try {
      const vm = getVoiceManager(client);
      if (vm?.voiceStates) {
        const guildVoiceMap = vm.voiceStates.get(cleanGuild) ?? vm.voiceStates.get(guildId);
        if (guildVoiceMap && typeof guildVoiceMap.forEach === "function") {
          guildVoiceMap.forEach((userChannelId, userId) => {
            if (!userId || !userChannelId) return;
            const userChannel = cleanId(userChannelId);
            if (userChannel !== cleanChannel) return;
            if (userId === botId) {
              remix.voiceCache.updateUser({ guildId: cleanGuild, userId, channelId: cleanChannel, isBot: true });
            } else {
              const guild = client.guilds.get(cleanGuild) ?? client.guilds.get(guildId);
              const member = guild?.members?.get?.(userId);
              const isBot = member?.user?.bot ?? false;
              if (isBot) {
                remix.voiceCache.updateUser({ guildId: cleanGuild, userId, channelId: cleanChannel, isBot: true });
              } else {
                remix.voiceCache.updateUser({ guildId: cleanGuild, userId, channelId: cleanChannel, isBot: false });
                humansFound++;
                logger.voiceState(
                    `[Reseed] Found human ${userId} in channel ${cleanChannel} (guild ${cleanGuild}) via VoiceManager`
                );
              }
            }
          });

          if (botId) {
            remix.voiceCache.updateUser({ guildId: cleanGuild, userId: botId, channelId: cleanChannel, isBot: true });
          }

          logger.voiceState(
              `[Reseed] Channel ${cleanChannel} (guild ${cleanGuild}): ` +
              `found ${humansFound} human(s) via VoiceManager, observedVoiceUsers size now ${remix.voiceCache.observedVoiceUsersSize}`
          );

          if (humansFound > 0) return humansFound;
        }
      }
    } catch (e) {
      logger.voiceState(`[Reseed] VoiceManager lookup failed: ${e?.message} — falling back.`);
    }

    const guild = client.guilds.get(cleanGuild) ?? client.guilds.get(guildId);
    if (!guild) {
      logger.voiceState(
          `[Reseed] Guild ${cleanGuild} not in cache — cannot reseed voice states.`
      );
    } else {
      for (const vs of iterateVoiceStates(guild)) {
        if (vs.isBot) continue;
        if (vs.channelId === cleanChannel) {
          remix.voiceCache.updateUser({ guildId: cleanGuild, userId: vs.userId, channelId: vs.channelId, isBot: false });
          humansFound++;
          logger.voiceState(
              `[Reseed] Found human ${vs.userId} in channel ${cleanChannel} (guild ${cleanGuild})`
          );
        }
      }

      if (botId) {
        remix.voiceCache.updateUser({ guildId: cleanGuild, userId: botId, channelId: cleanChannel, isBot: true });
      }

      if (humansFound > 0) {
        logger.voiceState(
            `[Reseed] Channel ${cleanChannel} (guild ${cleanGuild}): ` +
            `found ${humansFound} human(s), observedVoiceUsers size now ${remix.voiceCache.observedVoiceUsersSize}`
        );
        return humansFound;
      }
    }

    if (humansFound === 0 && remix.voiceCache) {
      const humans = remix.voiceCache.getHumansInChannel(cleanGuild, cleanChannel);
      for (const uid of humans) {
        humansFound++;
        logger.voiceState(
            `[Reseed] Found human ${uid} in channel ${cleanChannel} (guild ${cleanGuild}) via VoiceStateCache`
        );
      }

      if (botId) {
        remix.voiceCache.updateUser({ guildId: cleanGuild, userId: botId, channelId: cleanChannel, isBot: true });
      }
    }

    if (humansFound === 0) {
      try {
        const player = remix.players.playerMap.get(cleanChannel);
        const room = player?.connection?.room;
        if (room?.isConnected && room.remoteParticipants) {
          for (const [, participant] of room.remoteParticipants) {
            const userId = participant?.identity ?? participant?.sid;
            if (userId) {
              humansFound++;
              remix.voiceCache.updateUser({ guildId: cleanGuild, userId, channelId: cleanChannel, isBot: false });
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
        `found ${humansFound} human(s), observedVoiceUsers size now ${remix.voiceCache.observedVoiceUsersSize}`
    );

    return humansFound;
  }

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

      if (this.wsListenerAttached && remix._rawGatewayWsObj && remix._rawGatewayWsObj !== wsObj) {
        try {
          if (typeof remix._rawGatewayWsObj.removeEventListener === "function") {
            remix._rawGatewayWsObj.removeEventListener("message", remix._rawGatewayMessageListener ?? remix._rawGatewayHandler);
            remix._rawGatewayWsObj.removeEventListener("error",   remix._rawGatewayErrorHandler);
          } else if (typeof remix._rawGatewayWsObj.off === "function") {
            remix._rawGatewayWsObj.off("message", remix._rawGatewayMessageListener ?? remix._rawGatewayHandler);
            remix._rawGatewayWsObj.off("error",   remix._rawGatewayErrorHandler);
          }
        } catch(e) { logger.warn("[Gateway] Failed to detach old WS listener:", e?.message); }
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
    } catch(e) { logger.warn("[Gateway] attachRawListener failed:", e?.message); }
  }

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

  /**
   * Register all high-level Fluxer event listeners on the Fluxer client.
   * Call once during bot startup.
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
   * Main voice state update dispatcher — calls focused sub-handlers.
   * Parses the raw VOICE_STATE_UPDATE payload, computes the old channel,
   * then delegates to specialised methods.
   */
  async _handleVoiceStateUpdate(data) {
    const { remix } = this;
    const client = remix.client;

    const userId = data?.user_id;
    if (!userId) return;

    const newChannelId = data?.channel_id ?? null;
    const vsuGuildId   = data?.guild_id;
    const isBot        = data?.member?.user?.bot ?? null;


    const prevEntry    = this.findPrevVoiceStateEntry(userId, vsuGuildId);
    const prev         = prevEntry.value;
    const prevSameGuild = prev &&
        cleanId(prev.guildId ?? "") === cleanId(vsuGuildId ?? "");
    const oldChannelId = prevSameGuild ? (prev?.channelId ?? null) : null;


    this._updatePreviousStates(userId, vsuGuildId, oldChannelId, newChannelId, isBot, prevEntry, prev);
    this._updateVoiceStateCache(userId, vsuGuildId, oldChannelId, newChannelId, isBot, prev);


    const { player, playerGuildId, homeChannelId } = this._findAffectedPlayer(vsuGuildId, oldChannelId, newChannelId);

    const isBotUser = isBot === true && userId === client.user?.id;

    if (!isBotUser) {

      this._handleInactivityOnVoiceChange(player, playerGuildId, homeChannelId, userId, oldChannelId, newChannelId, vsuGuildId, data);
      return;
    }


    this._handleBotVoiceChange(player, playerGuildId, homeChannelId, oldChannelId, newChannelId, vsuGuildId, data);
  }

  /**
   * Handle bulk voice state sync from GUILD_CREATE or READY.
   * Populates VoiceStateCache with all users currently in voice channels
   * for a guild. This is the PRIMARY way the bot learns about users who
   * were already in voice when the bot started (before it receives any
   * individual VOICE_STATE_UPDATE events).
   *
   * @param {{ guildId: string, voiceStates: Array<{user_id: string, channel_id: string|null, member?: {user?: {bot?: boolean}}}> }} data
   */
  _handleVoiceStatesSync(data) {
    const { remix } = this;
    const client = remix.client;
    const guildId = data?.guildId;
    if (!guildId || !Array.isArray(data?.voiceStates)) return;

    const botId = client.user?.id;
    let humansAdded = 0;
    let botsAdded = 0;

    for (const vs of data.voiceStates) {
      const userId = vs.user_id;
      const channelId = vs.channel_id;
      if (!userId || !channelId) continue;

      const isBot = vs.member?.user?.bot ?? (userId === botId);

      remix.voiceCache.updateUser({ guildId, userId, channelId, isBot });
      if (isBot) {
        botsAdded++;
      } else {
        humansAdded++;
      }
    }

    if (humansAdded > 0 || botsAdded > 0) {
      logger.voiceState(
          `[VoiceStatesSync] Guild ${guildId}: seeded ${humansAdded} humans, ${botsAdded} bots ` +
          `(${data.voiceStates.length} total states).`
      );
    }
  }

  /**
   * Update the voice state cache when users move between channels.
   * Adds users to the cache on join, removes them on leave.
   */
  _updateVoiceStateCache(userId, guildId, oldChannelId, newChannelId, isBot, prev) {
    const { remix } = this;

    if (newChannelId) {
      remix.voiceCache.updateUser({ guildId: guildId ?? prev?.guildId, userId, channelId: newChannelId, isBot: isBot === true });
    } else {
      const resolvedGuildId = guildId ?? prev?.guildId;
      if (resolvedGuildId) {
        remix.voiceCache.deleteHumanUser(userId, resolvedGuildId);
        remix.voiceCache.deleteBotUser(VoiceStateCache.userKey(resolvedGuildId, userId));
      }
    }
  }

  /**
   * Update the previous state map (LRU eviction).
   * Maintains a bounded map of previous voice states for computing oldChannelId.
   */
  _updatePreviousStates(userId, guildId, oldChannelId, newChannelId, isBot, prevEntry, prev) {
    const { remix } = this;
    const prevKey = prevEntry.key;
    const nextKey = this.getPrevVoiceStateKey(userId, guildId ?? prev?.guildId);

    if (newChannelId) {
      if (prevKey && prevKey !== nextKey) {
        const prevGuildPart = prevKey.split(":")[0];
        const nextGuildPart = nextKey.split(":")[0];
        if (prevGuildPart === nextGuildPart) {
          this._prevVoiceState.delete(prevKey);
        }
      }
      if (nextKey && this._prevVoiceState.size >= 10_000 && !this._prevVoiceState.has(nextKey)) {
        const evictKey = this._prevVoiceState.keys().next().value;
        const evictEntry = this._prevVoiceState.get(evictKey);
        this._prevVoiceState.delete(evictKey);
        if (evictEntry) {
          const evictGuildId = evictEntry.guildId;
          const evictUserId = evictKey.split(":")[1];
          if (evictGuildId && evictUserId) {
            const currentLoc = remix.voiceCache.getUserLocation(evictGuildId, evictUserId);
            if (currentLoc && currentLoc.channelId === evictEntry.channelId) {
              remix.voiceCache.updateUser({ guildId: evictGuildId, userId: evictUserId, channelId: null, isBot: evictEntry.isBot ?? false });
            }
          }
        }
      }
      if (nextKey) this._prevVoiceState.set(nextKey, { channelId: newChannelId, guildId: guildId ?? prev?.guildId, isBot: isBot === true });
    } else {
      if (prevKey) this._prevVoiceState.delete(prevKey);
    }
  }

  /**
   * Find which player is affected by this voice state change.
   * Checks both old and new channels for an existing player.
   *
   * @returns {{ player: object|null, playerGuildId: string|null, homeChannelId: string|null }}
   */
  _findAffectedPlayer(guildId, oldChannelId, newChannelId) {
    const { remix } = this;


    if (oldChannelId) {
      const cleanOld = cleanId(oldChannelId);
      const player = remix.players.playerMap.get(cleanOld);
      if (player) {
        return { player, playerGuildId: player._guildId, homeChannelId: player._home247Channel };
      }
    }


    if (newChannelId) {
      const cleanNew = cleanId(newChannelId);
      const player = remix.players.playerMap.get(cleanNew);
      if (player) {
        return { player, playerGuildId: player._guildId, homeChannelId: player._home247Channel };
      }
    }

    return { player: null, playerGuildId: null, homeChannelId: null };
  }

  /**
   * Manage inactivity timers when humans join/leave voice channels.
   * Also handles dashboard updates for human voice state changes.
   */
  async _handleInactivityOnVoiceChange(player, playerGuildId, homeChannelId, userId, oldChannelId, newChannelId, vsuGuildId, vsu) {
    const { remix } = this;
    const client = remix.client;
    const resolvedGuildId = vsuGuildId ?? playerGuildId;
    if (!resolvedGuildId) return;

    if (newChannelId) {
      try {
        const cleanId247 = cleanId(newChannelId);
        const player247  = remix.players.playerMap.get(cleanId247);
        if (player247 && typeof player247._stopInactivityTimer === "function") {
          logger.voiceState(`[VoiceState] Human joined 247 channel ${cleanId247}, stopping inactivity timer`);
          player247._stopInactivityTimer();
        }
      } catch(e) { logger.warn("[VoiceState] 247 inactivity timer stop failed:", e?.message); }
    }

    if (oldChannelId && oldChannelId !== newChannelId) {
      try {
        const cleanOld = cleanId(oldChannelId);
        const oldPlayer = remix.players.playerMap.get(cleanOld);
        if (oldPlayer && typeof oldPlayer._startInactivityTimer === "function") {
          setTimeout(() => {
            if (!oldPlayer._hasHumansInChannel()) {
              logger.voiceState(`[VoiceState] Last human left ${cleanOld}, starting inactivity timer`);
              oldPlayer._startInactivityTimer();
            }
          }, this.T.aloneCheckDebounce);
        }
      } catch(e) { logger.warn("[VoiceState] Inactivity timer start failed:", e?.message); }
    }

    if (newChannelId) {
      try {
        const cleanChId = cleanId(newChannelId);
        const newPlayer = remix.players.playerMap.get(cleanChId);
        if (newPlayer && typeof newPlayer._stopInactivityTimer === "function") {
          logger.voiceState(`[VoiceState] Human joined ${cleanChId}, stopping inactivity timer`);
          newPlayer._stopInactivityTimer();
        }
      } catch(e) { logger.warn("[VoiceState] Inactivity timer stop failed:", e?.message); }
    }

    if (remix.dashboard?.enabled) {
      try {
        let userObj = vsu?.member?.user;
        if (!userObj) {
          try { userObj = await client.users.fetch(userId).catch(() => null); } catch(e) { logger.warn("[VoiceState] Dashboard user fetch failed:", e?.message); }
        }
        if (userObj) {
          const details = {
            type: newChannelId ? "join" : "leave",
            guildId: resolvedGuildId,
            channelId: newChannelId ?? null,
            oldChannelId: oldChannelId ?? null,
          };
          remix.dashboard.updateUser(details, userObj);
        }

        const refChannel = newChannelId ?? oldChannelId;
        const cleanId_ref = refChannel ? cleanId(refChannel) : null;

        if (cleanId_ref) {
          const dashPlayer = remix.players.playerMap.get(cleanId_ref);
          if (dashPlayer) {
            const eventType = newChannelId ? "join" : "leave";
            remix.dashboard.updatePlayer({
              type: eventType,
              data: userId,
            }, dashPlayer);

            remix.dashboard.playerUpdate({
              type: eventType,
            }, dashPlayer);
          }
        }
      } catch(e) { logger.warn("[VoiceState] Dashboard update failed:", e?.message); }
    }
  }

  /**
   * Handle the bot being moved to a different channel or disconnected.
   * Covers 24/7 re-key on move and auto-rejoin / autoleave on disconnect.
   */
  _handleBotVoiceChange(player, playerGuildId, homeChannelId, oldChannelId, newChannelId, vsuGuildId, vsu) {
    const { remix } = this;
    const client = remix.client;
    const guildId = vsuGuildId;

    const activeGuildPlayers = [...remix.players.playerMap.entries()].filter(([, p]) =>
        cleanId(p?._guildId ?? "") === cleanId(guildId ?? "")
    );
    const multiVoiceGuild = activeGuildPlayers.length > 1;


    if (newChannelId && guildId && oldChannelId && oldChannelId !== newChannelId) {
      try {
        const cleanNew  = cleanId(newChannelId);
        const cleanOld = cleanId(oldChannelId);
        const moveSet = remix.settingsMgr.getServer(guildId);
        const moveRaw = moveSet?.get("stay_247");
        const saved247Channels = (!moveRaw || moveRaw === "none")
            ? []
            : Array.isArray(moveRaw)
                ? moveRaw.map(id => cleanId(id)).filter(id => id.length >= 15)
                : [cleanId(moveRaw)].filter(id => id.length >= 15);

        if (saved247Channels.length > 1) {
          logger.voice247(
              `[247] Ignoring move-style bot voice update ${cleanOld} → ${cleanNew} ` +
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
                ? raw.map(id => cleanId(id)).filter(id => id.length >= 15)
                : [cleanId(raw)].filter(id => id.length >= 15);
            return saved.includes(cleanNew);
          } catch (_) {
            return false;
          }
        })();
        const newChannelPendingSpawn =
            remix.players?._pendingJoins?.has?.(cleanNew) ||
            false;
        const targetChannel = client.channels.get(cleanNew)
            ?? client.channels.get?.(cleanNew)
            ?? null;
        const targetGuildId = cleanId(targetChannel?.guildId ?? targetChannel?.guild?.id ?? guildId ?? "");
        const playerGuildIdLocal = cleanId(existingPlayer?._guildId ?? "");
        const guildPlayers = [...remix.players.playerMap.entries()].filter(([, p]) =>
            cleanId(p?._guildId ?? "") === cleanId(guildId ?? "")
        );
        const guildIsAmbiguous = guildPlayers.length > 1;

        let rekeyed = false;
        if (existingPlayer && cleanNew !== cleanOld) {
          if (newChannelAlreadySaved || newChannelPendingSpawn) {
            logger.voice247(
                `[247] Keeping both channels ${cleanOld} and ${cleanNew} ` +
                `(saved=${newChannelAlreadySaved} pending=${newChannelPendingSpawn})`
            );
            rekeyed = false;
          } else
          if (guildIsAmbiguous) {
            const playerAtNewKey = remix.players.playerMap.get(cleanNew);
            if (playerAtNewKey && playerAtNewKey !== existingPlayer) {
              existingPlayer._channelId = cleanNew;
              existingPlayer._home247Channel = cleanNew;
              if (targetGuildId) existingPlayer._guildId = targetGuildId;
              rekeyed = false;
              logger.voice247(
                  `[247] Updated player channel ${cleanOld} → ${cleanNew} ` +
                  `(guild ${guildId} has ${guildPlayers.length} active players, ` +
                  `new key occupied by another player — skipped re-key)`
              );
            } else {
              remix.players.playerMap.delete(cleanOld);
              remix.players.playerMap.set(cleanNew, existingPlayer);
              existingPlayer._channelId = cleanNew;
              existingPlayer._home247Channel = cleanNew;
              if (targetGuildId) existingPlayer._guildId = targetGuildId;
              rekeyed = true;
              logger.voice247(
                  `[247] Re-keyed playerMap ${cleanOld} → ${cleanNew} ` +
                  `(guild ${guildId} has ${guildPlayers.length} active players)`
              );
            }
          } else if (playerGuildIdLocal && targetGuildId && playerGuildIdLocal !== targetGuildId) {
            if (!existingPlayer) {
              logger.voice247(
                  `[247] Stale cross-guild move ${cleanOld} → ${cleanNew} ` +
                  `(no player in playerMap for old channel — updating bot state only)`
              );
            } else {
              const vsuGuildIdClean = cleanId(guildId ?? "");
              if (vsuGuildIdClean && targetGuildId === vsuGuildIdClean) {
                existingPlayer._guildId = targetGuildId;
                existingPlayer._channelId = cleanNew;
                existingPlayer._home247Channel = cleanNew;
                remix.players.playerMap.delete(cleanOld);
                remix.players.playerMap.set(cleanNew, existingPlayer);
                rekeyed = true;
                logger.voice247(
                    `[247] Fixed stale guild during recovery: re-keyed ${cleanOld} → ${cleanNew} ` +
                    `(playerGuild ${playerGuildIdLocal} → ${targetGuildId})`
                );
              } else {
                logger.warn(
                    `[247] Refused cross-guild re-key ${cleanOld} → ${cleanNew} ` +
                    `(playerGuild=${playerGuildIdLocal} targetGuild=${targetGuildId})`
                );
              }
            }
          } else {
            remix.players.playerMap.delete(cleanOld);
            remix.players.playerMap.set(cleanNew, existingPlayer);
            existingPlayer._channelId = cleanNew;
            existingPlayer._home247Channel = cleanNew;
            if (targetGuildId) existingPlayer._guildId = targetGuildId;
            rekeyed = true;
            logger.voice247(`[247] Re-keyed playerMap ${cleanOld} → ${cleanNew}`);
          }
        }

        const set = remix.settingsMgr.getServer(guildId);
        const raw = set?.get("stay_247");
        if ((rekeyed || existingPlayer) && raw && raw !== "none") {
          const channels = Array.isArray(raw)
              ? new Set(raw.map(id => cleanId(id)).filter(id => id.length >= 15))
              : new Set();
          if (channels.has(cleanOld) && cleanOld !== cleanNew && cleanNew.length >= 15) {
            if (channels.has(cleanNew) || newChannelAlreadySaved || newChannelPendingSpawn) {
              logger.voice247(
                  `[247] Preserved stay_247 channels ${cleanOld} and ${cleanNew} ` +
                  `(saved=${channels.has(cleanNew) || newChannelAlreadySaved} pending=${newChannelPendingSpawn})`
              );
              return;
            }

            const currentGuildPlayers = [...remix.players.playerMap.values()].filter(p =>
                cleanId(p?._guildId ?? "") === cleanId(guildId ?? "")
            );
            if (currentGuildPlayers.length > 1) {
              if (!channels.has(cleanNew)) {
                channels.add(cleanNew);
                set.set("stay_247", [...channels]);
                const modes2 = set.get("stay_247_modes");
                if (modes2 && typeof modes2 === "object" && !Array.isArray(modes2) && !modes2[cleanNew]) {
                  modes2[cleanNew] = modes2[cleanOld] ?? "auto";
                  set.set("stay_247_modes", modes2);
                }
                logger.voice247(
                    `[247] Added stay_247 channel ${cleanNew} (kept ${cleanOld}) — guild has ${currentGuildPlayers.length} active players`
                );
              }
              return;
            }

            channels.delete(cleanOld);
            channels.add(cleanNew);
            set.set("stay_247", [...channels]);

            const modes = set.get("stay_247_modes");
            if (modes && typeof modes === "object" && !Array.isArray(modes)) {
              if (modes[cleanOld] && !modes[cleanNew]) {
                modes[cleanNew] = modes[cleanOld];
              }
              delete modes[cleanOld];
              set.set("stay_247_modes", modes);
            }

            logger.voice247(`[247] Updated stay_247: ${cleanOld} → ${cleanNew}`);
          }
        }
      } catch (e) {
        logger.warn("[247] Failed to auto-save channel:", e.message);
      }
    }


    if (!newChannelId && oldChannelId && guildId) {
      try {
        const cleanOld = cleanId(oldChannelId);
        const cleanGuild = cleanId(guildId);

        if (this._inStartupGrace) {
          const bootPlayer = remix.players.playerMap.get(cleanOld);
          if (bootPlayer && !bootPlayer._destroyed) {
            logger.voiceState(
                `[VoiceState] Bot disconnected from ${cleanOld} during startup grace — ` +
                `player still active, ignoring stale disconnect.`
            );
          } else {
            logger.voiceState(
                `[VoiceState] Bot disconnected from ${cleanOld} during startup grace — ` +
                `deferring until grace period ends.`
            );
          }
          return;
        }

        if (remix.intentionalLeaves.has(cleanOld)) {
          logger.voiceState(`[VoiceState] Bot disconnected from ${cleanOld} — intentional leave.`);
        } else if (remix.revoice?._intentionalDisconnects?.has?.(cleanOld)) {
          logger.voiceState(`[VoiceState] Bot disconnected from ${cleanOld} — intentional (revoice).`);
        } else if (this._isGuildMoveInProgress(cleanGuild, cleanOld)) {
          logger.voiceState(`[VoiceState] Bot disconnected from ${cleanOld} — guild move in progress, skipping.`);
        } else if (this._bootRecoveryActive) {
          logger.voiceState(`[VoiceState] Bot disconnected from ${cleanOld} — boot recovery active, skipping.`);
        } else {
          const set = remix.settingsMgr.getServer(guildId);
          const mode = set ? get247ChannelMode(set, cleanOld) : "off";

          if (mode === "auto") {
            logger.voice247(
                `[VoiceState] Bot unexpectedly disconnected from ${cleanOld} (24/7 auto) — cleaning up and scheduling rejoin.`
            );
            const discPlayer = remix.players.playerMap.get(cleanOld);
            if (discPlayer && !discPlayer._destroyed) {
              remix.players.playerMap.delete(cleanOld);
              const homeChannel = cleanId(discPlayer._home247Channel ?? "");
              if (homeChannel && homeChannel !== cleanOld) {
                remix.players.playerMap.delete(homeChannel);
              }
              try { discPlayer.destroy(); } catch(e) { logger.warn("[VoiceState] Player destroy failed:", e?.message); }
              const pendingScrobble = remix.players._pendingScrobbleTimers?.get(cleanOld);
              if (pendingScrobble) {
                clearTimeout(pendingScrobble.timer);
                remix.players._pendingScrobbleTimers.delete(cleanOld);
              }
            }
            const rejoinDelay = this.T.rejoin247Delay ?? 3_000;
            setTimeout(() => {
              this._rejoinChannel(cleanGuild, cleanOld).catch(err => {
                logger.warn(`[VoiceState] Failed to rejoin ${cleanOld} after disconnect:`, err.message);
              });
            }, rejoinDelay);
          } else {
            const leavePlayer = remix.players.playerMap.get(cleanOld);
            if (leavePlayer && !leavePlayer.leaving && !leavePlayer._destroyed) {
              logger.voiceState(
                  `[VoiceState] Bot disconnected from ${cleanOld} (24/7 mode: ${mode}) — emitting autoleave.`
              );
              leavePlayer.emit("autoleave");
            }
          }
        }
      } catch (e) {
        logger.warn("[VoiceState] Bot disconnect handler failed:", e.message);
      }
    }
  }

  /** @type {Set<string>} Channel IDs currently being rejoined (dedup guard) */
  _rejoinInProgress = new Set();

  /** @type {Map<string, number>} Channel IDs with retry attempt counts */
  _rejoinAttempts = new Map();

  /** @type {boolean} Whether boot recovery (rejoin247Channels) is currently running */
  _bootRecoveryActive = false;

  /** @type {number} Maximum number of rejoin retry attempts */
  static MAX_REJOIN_RETRIES = 3;

  /**
   * Shared rejoin attempt logic with exponential backoff retry.
   * Used by both _rejoinChannel (disconnect recovery) and
   * rejoin247Channels (boot recovery).
   *
   * @param {string} channelId - Clean channel ID
   * @param {string} guildId - Clean guild ID
   * @param {number} [maxRetries=3] Maximum retry attempts
   * @param {number} [baseDelay=5000] Base delay for exponential backoff (ms)
   * @param {string} [context="Rejoin"] Log context prefix
   * @returns {Promise<object|null>} The spawned player, or null on failure
   */
  async _attemptRejoin(channelId, guildId, maxRetries = 3, baseDelay = 5_000, context = "Rejoin") {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const player = await this.remix._spawnPlayer(guildId, channelId);
        this.reseedVoiceStatesForChannel(guildId, channelId);
        logger.voice247(
            `[${context}] Successfully rejoined channel ${channelId}` +
            (attempt > 1 ? ` (after ${attempt - 1} retry/retries)` : '')
        );
        return player;
      } catch (err) {
        const errMsg = err?.message ?? String(err);
        const isTrackTimeout = errMsg.includes("track publication timed out")
            || errMsg.includes("publishToRoom failed")
            || errMsg.includes("Failed to create MediaPlayer")
            || errMsg.includes("internal error");

        if (isTrackTimeout && attempt < maxRetries) {
          const backoffMs = baseDelay * Math.pow(2, attempt - 1);
          logger.warn(
              `[${context}] Track publication failed for channel ${channelId} (attempt ${attempt}/${maxRetries}) — ` +
              `retrying in ${backoffMs / 1000}s: ${errMsg}`
          );
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          continue;
        }

        logger.warn(
            `[${context}] Failed to rejoin channel ${channelId} (attempt ${attempt}/${maxRetries}): ${errMsg}` +
            (attempt > 1 ? ` (after ${attempt} attempts)` : '')
        );
        return null;
      }
    }
    return null;
  }

  /**
   * Rejoin a voice channel after an unexpected disconnect.
   * Used by the %247 auto mode to automatically reconnect.
   *
   * Includes deduplication (prevents concurrent rejoin for the same channel)
   * and delegates retry logic to _attemptRejoin.
   *
   * @param {string} guildId
   * @param {string} channelId
   */
  async _rejoinChannel(guildId, channelId) {
    const { remix } = this;
    const cleanGuildId   = cleanId(guildId);
    const cleanChannelId = cleanId(channelId);

    if (this._rejoinInProgress.has(cleanChannelId)) {
      logger.voice247(`[Rejoin] Channel ${cleanChannelId} rejoin already in progress — skipping.`);
      return;
    }

    const existing = remix.players.playerMap.get(cleanChannelId);
    if (existing && !existing._destroyed) {
      logger.voice247(`[Rejoin] Channel ${cleanChannelId} already has a player — skipping.`);
      this._rejoinAttempts.delete(cleanChannelId);
      return;
    }

    if (remix.players._pendingJoins?.has?.(cleanChannelId)) {
      logger.voice247(`[Rejoin] Channel ${cleanChannelId} already has a pending join — skipping.`);
      return;
    }

    if (remix.intentionalLeaves.has(cleanChannelId)) {
      logger.voice247(`[Rejoin] Channel ${cleanChannelId} was intentionally left — skipping.`);
      this._rejoinAttempts.delete(cleanChannelId);
      return;
    }

    if (remix.revoice?._intentionalDisconnects?.has?.(cleanChannelId)) {
      logger.voice247(`[Rejoin] Channel ${cleanChannelId} was intentionally left (revoice) — skipping.`);
      this._rejoinAttempts.delete(cleanChannelId);
      return;
    }

    const channel = remix.client?.channels?.get?.(cleanChannelId);
    if (!channel) {
      logger.voice247(`[Rejoin] Channel ${cleanChannelId} no longer exists — skipping.`);
      this._rejoinAttempts.delete(cleanChannelId);
      return;
    }

    this._rejoinInProgress.add(cleanChannelId);

    const maxRetries = GatewayHandler.MAX_REJOIN_RETRIES;
    logger.voice247(
        `[Rejoin] Attempting to rejoin channel ${cleanChannelId} in guild ${cleanGuildId}...`
    );

    try {
      const player = await this._attemptRejoin(cleanChannelId, cleanGuildId, maxRetries, 5_000, "Rejoin");
      if (player) {
        this._rejoinAttempts.delete(cleanChannelId);
      } else {
        this._rejoinAttempts.delete(cleanChannelId);
      }
      return player;
    } finally {
      this._rejoinInProgress.delete(cleanChannelId);
    }
  }

  /**
   * Check whether a guild-move operation is currently in progress for the
   * given guild and old channel.  During a move, Fluxer sends two
   * VoiceStateUpdate events (leave old + join new) in rapid succession;
   * the "leave" should NOT be treated as an unexpected disconnect.
   *
   * @param {string} guildId       The guild ID to check
   * @param {string} oldChannelId  The channel the bot appears to have left
   * @returns {boolean} True if a move is in progress and the disconnect should be ignored
   */
  _isGuildMoveInProgress(guildId, oldChannelId) {
    const { remix } = this;
    const cleanGuild = cleanId(guildId);
    const cleanOld = cleanId(oldChannelId);
    if (!cleanGuild || !cleanOld) return false;

    const activePlayers = [...remix.players.playerMap.values()].filter(
        p => !p._destroyed && cleanId(p._guildId ?? "") === cleanGuild
    );

    for (const player of activePlayers) {
      const playerChannel = cleanId(player._channelId ?? "");
      if (playerChannel && playerChannel !== cleanOld) {
        return true;
      }
    }

    if (remix.players._pendingJoins) {
      for (const pendingId of remix.players._pendingJoins) {
        const cleanPending = cleanId(pendingId);
        if (cleanPending && cleanPending !== cleanOld) {
          const pendingChannel = remix.client?.channels?.get?.(cleanPending);
          if (pendingChannel && cleanId(pendingChannel.guildId ?? "") === cleanGuild) {
            return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * Invoke after the bot has connected and Moonlink has been initialised.
   * Seeds voice states, attaches raw WS listener, kicks off presence rotation,
   * and rejoins 24/7 channels with staggered delays to avoid overwhelming
   * the LiveKit server.
   */
  /**
   * Paginate /users/@me/guilds via REST and add any guilds that Fluxer
   * didn't cache (because their GUILD_CREATE was never received) as
   * lightweight stubs into client.guilds.  This ensures guild count and
   * any guild-map lookups reflect the real server count.
   *
   * Stubs only carry { id, name } — enough for counting and ID lookups.
   * They are skipped if a full guild object is already in the cache.
   */
  async seedGuildsFromRest() {
    const { remix } = this;
    const client    = remix.client;

    try {
      let after = null;
      let added = 0;

      while (true) {
        const url   = "/users/@me/guilds?limit=200" + (after ? "&after=" + after : "");
        const chunk = await client.rest.get(url);

        if (!Array.isArray(chunk) || chunk.length === 0) break;

        for (const g of chunk) {
          const id = g?.id;
          if (!id) continue;
          if (!client.guilds.has(id)) {
            try {
              const Guild = this._getGuildClass();
              if (Guild) {
                const stub = new Guild(client, { id, name: g.name ?? "unknown" });
                stub._stub = true;
                client.guilds.set(id, stub);
              } else {
                client.guilds.set(id, {
                  id,
                  name: g.name ?? "unknown",
                  _stub: true,
                  members: { set: () => {}, get: () => undefined, has: () => false, me: null },
                  channels: { set: () => {}, get: () => undefined, has: () => false },
                  roles: { set: () => {}, get: () => undefined, has: () => false },
                  emojis: { set: () => {}, get: () => undefined, has: () => false },
                  stickers: { set: () => {}, get: () => undefined, has: () => false },
                });
              }
            } catch (stubErr) {
              logger.guild(`[GuildSeed] Guild constructor failed for ${id}, using safe stub: ${stubErr?.message}`);
              client.guilds.set(id, {
                id,
                name: g.name ?? "unknown",
                _stub: true,
                members: { set: () => {}, get: () => undefined, has: () => false, me: null },
                channels: { set: () => {}, get: () => undefined, has: () => false },
                roles: { set: () => {}, get: () => undefined, has: () => false },
                emojis: { set: () => {}, get: () => undefined, has: () => false },
                stickers: { set: () => {}, get: () => undefined, has: () => false },
              });
            }
            added++;
          }
        }

        if (chunk.length < 200) break;
        after = chunk[chunk.length - 1].id;
      }

      if (added > 0) {
        logger.guild(`[GuildSeed] Added ${added} missing guild stub(s) from REST. Total: ${client.guilds.size}`);
      } else {
        logger.guild(`[GuildSeed] All guilds already cached. Total: ${client.guilds.size}`);
      }
    } catch (err) {
      logger.warn("[GuildSeed] REST guild seeding failed:", err?.message ?? err);
    }
  }

  /**
   * Try to get the Guild class from @fluxerjs/core so we can create proper
   * Guild instances for stubs instead of plain objects.
   * Returns null if the class can't be resolved.
   */
  _getGuildClass() {
    if (this._GuildClass) return this._GuildClass;
    try {
      const { client } = this.remix;
      for (const guild of client.guilds.values()) {
        if (guild && !guild._stub && typeof guild.constructor === 'function' && guild.constructor.name === 'Guild') {
          this._GuildClass = guild.constructor;
          return this._GuildClass;
        }
      }
    } catch(e) { logger.warn("[Gateway] _getGuildClass failed:", e?.message); }
    this._GuildClass = null;
    return null;
  }

  onReady() {
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
   * Rejoin all 24/7 channels after boot with staggered delays.
   *
   * Both %247 auto and %247 on channels are rejoined because:
   *   %247 auto: always stays in voice (disconnect + reboot)
   *   %247 on:   only on reboot, not on disconnect
   *
   * Channels are rejoined one at a time with a delay between each to
   * avoid overwhelming the LiveKit server with concurrent track publications.
   */
  async rejoin247Channels() {
    this._bootRecoveryActive = true;
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
        if (mode === "auto" || mode === "on") {
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

        try {
          const set = remix.settingsMgr.getServer(guildId);
          if (set) {
            const raw = set.get("stay_247");
            const channels = new Set(
                (Array.isArray(raw) ? raw : [raw])
                    .filter(id => id && id !== "none" && cleanId(id) !== channelId)
            );
            set.set("stay_247", channels.size > 0 ? [...channels] : "none");
            remove247ChannelMode(set, channelId, channels);
            logger.warn(
                `[BootRecovery] Auto-removed channel ${channelId} from 24/7 ` +
                `in guild ${guildId} after persistent track publication failure`
            );
          }
        } catch (cleanupErr) {
          logger.error(
              `[BootRecovery] Failed to auto-remove channel ${channelId} from 24/7:`,
              cleanupErr?.message ?? cleanupErr
          );
        }
      }
    }

    logger.voice247(
        `[BootRecovery] Boot recovery complete. ${channelsToRejoin.length} channel(s) processed.`
    );

    setTimeout(() => { this._bootRecoveryActive = false; }, 15_000);
  }

  /**
   * Perform the actual cleanup for a guild that the bot was removed from.
   * Extracted from the GuildDelete handler so it can be called after the
   * startup grace period expires.
   * @param {string} guildId
   */
  _processGuildDelete(guildId) {
    const { remix } = this;
    const cleanGuildId = cleanId(guildId);

    logger.guild(
        `[GuildDelete] Received GuildDelete for server ${guildId} — ` +
        `skipping removal (24/7 removal system disabled). ` +
        `Settings and players are preserved. If the server truly removed the bot, ` +
        `the GuildCreate handler will re-initialise on re-invite.`
    );

    remix.voiceCache.removeGuild(cleanGuildId);
    for (const [stateKey, info] of [...this._prevVoiceState]) {
      if (cleanId(info.guildId) === cleanGuildId)
        this._prevVoiceState.delete(stateKey);
    }
    remix._announcementChannelCache?.delete(guildId);
  }
}
