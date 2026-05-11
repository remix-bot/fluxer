import { Events, GatewayOpcodes } from "@fluxerjs/core";
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
   * @param {import('./RecoveryManager.mjs').RecoveryManager} recoveryManager  For scheduleSpawn / tryAutoJoin.
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

    const guild = client.guilds.get(cleanGuild) ?? client.guilds.get(guildId);
    if (!guild) {
      logger.voiceState(
        `[Reseed] Guild ${cleanGuild} not in cache — cannot reseed voice states.`
      );
      return 0;
    }

    const voiceStatesRaw =
        guild.voice_states ??
        guild.voiceStates ??
        null;

    if (!voiceStatesRaw) {
      logger.voiceState(
        `[Reseed] Guild ${cleanGuild} has no voice_states cache — cannot reseed.`
      );
      return 0;
    }

    // Process object-style voice_states (keyed by userId)
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
      // Process array / iterable style voice_states
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

    // Also check the bot's own observed bots map — update the bot's entry
    // so the voice state handler knows the bot is in this channel.
    const botId = client.user?.id;
    if (botId) {
      const botKey = this.getObservedVoiceBotKey(botId, cleanGuild);
      if (botKey) {
        remix.observedVoiceBots.set(botKey, { channelId: cleanChannel, guildId: cleanGuild });
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

      // Part 1: Voice state population
      // Purge stale entries for this guild first.
      for (const [uid, info] of [...remix.observedVoiceUsers]) {
        if (String(info.guildId).replace(/\D/g, "") === String(guildId).replace(/\D/g, ""))
          remix.observedVoiceUsers.delete(uid);
      }
      for (const [uid, info] of [...remix.observedVoiceBots]) {
        if (String(info.guildId).replace(/\D/g, "") === String(guildId).replace(/\D/g, ""))
          remix.observedVoiceBots.delete(uid);
      }

      const voiceStatesRaw =
          guild.voice_states ??
          guild.voiceStates ??
          null;
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
                  this.recoveryManager.scheduleSpawn(guildId, chId, this.T.rejoin247Delay, null, "guild-create-247");
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

      logger.guild(`[GuildDelete] Removed from server ${guildId} — cleaning up.`);

      for (const [channelId, player] of remix.players.playerMap) {
        if (!player._guildId || String(player._guildId).replace(/\D/g, "") === String(guildId).replace(/\D/g, "")) {
          remix.players.playerMap.delete(channelId);
          try { player.leave().catch(() => {}); } catch (_) {}
          try { player.destroy();               } catch (_) {}
          logger.guild(`[GuildDelete] Destroyed player for channel ${channelId}.`);
        }
      }

      for (const [userId, info] of [...remix.observedVoiceUsers]) {
        if (String(info.guildId).replace(/\D/g, "") === String(guildId).replace(/\D/g, "")) remix.observedVoiceUsers.delete(userId);
      }
      for (const [userId, info] of [...remix.observedVoiceBots]) {
        if (String(info.guildId).replace(/\D/g, "") === String(guildId).replace(/\D/g, "")) remix.observedVoiceBots.delete(userId);
      }
      for (const [stateKey, info] of [...this._prevVoiceState]) {
        if (String(info.guildId).replace(/\D/g, "") === String(guildId).replace(/\D/g, ""))
          this._prevVoiceState.delete(stateKey);
      }

      remix.settingsMgr.removeServer(guildId);
      remix._announcementChannelCache.delete(guildId);

      logger.guild(`[GuildDelete] Cleanup complete for server ${guildId}.`);
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

        const existingPlayer = remix.players.playerMap.get(cleanOld);
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
          if (guildIsAmbiguous) {
            // Multi-voice guild: can't safely re-key the playerMap (another player
            // might already use cleanId), but still update the moved player's
            // home channel so 24/7 recovery targets the right channel.
            existingPlayer._channelId = cleanId;
            existingPlayer._home247Channel = cleanId;
            if (targetGuildId) existingPlayer._guildId = targetGuildId;
            rekeyed = false; // keep false — don't touch playerMap keys
            logger.voice247(
              `[247] Updated player channel ${cleanOld} → ${cleanId} ` +
              `(guild ${guildId} has ${guildPlayers.length} active players, skipped re-key)`
            );
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
            // Keep the old channel saved AND add the new one.
            // The bot moved from one 24/7 channel to another — both should
            // remain in the saved list so the bot can auto-rejoin either one.
            channels.add(cleanId);
            set.set("stay_247", [...channels]);

            // Copy the per-channel mode from old → new channel (keep old too)
            const modes = set.get("stay_247_modes");
            if (modes && typeof modes === "object" && !Array.isArray(modes) && modes[cleanOld]) {
              if (!modes[cleanId]) modes[cleanId] = modes[cleanOld];
              set.set("stay_247_modes", modes);
            }

            logger.voice247(`[247] Added to stay_247: ${cleanId} (kept ${cleanOld})`);
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
        if (remix.intentionalLeaves.has(cleanOld)) {
          logger.voice247(`[247] Skipping rejoin for ${cleanOld} — intentional leave.`);
        } else {
          const set = remix.settingsMgr.getServer(guildId);
          const raw = set.get("stay_247");
          if (raw && raw !== "none") {
            const channels = Array.isArray(raw)
                ? new Set(raw.map(id => String(id).replace(/\D/g, "")).filter(id => id.length >= 15))
                : new Set();
            if (channels.has(cleanOld)) {
              // Per-channel mode: check the mode for this specific channel
              const mode = get247ChannelMode(set, cleanOld);
              if (mode === "on" || mode === "auto") {
                // For multi-voice guilds, match the specific player by channel ID
                // instead of skipping recovery entirely (was: if multiVoiceGuild return)
                const player = remix.players.playerMap.get(cleanOld);
                if (player && !player.leaving) {
                  logger.voice247("[247] Fluxer gateway disconnected us. Forcing player recovery...");
                  if (typeof player._recoverConnection === "function") {
                    player._recoverConnection();
                  } else {
                    remix.players.playerMap.delete(cleanOld);
                    try { player.destroy(); } catch (_) {}
                    this.recoveryManager.scheduleSpawn(guildId, cleanOld, this.T.rejoin247Delay, null, "gateway-disconnect");
                  }
                } else {
                  this.recoveryManager.scheduleSpawn(guildId, cleanOld, this.T.rejoin247Delay, null, "gateway-disconnect");
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
  }
}
