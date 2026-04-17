import * as fs from "fs";
import path from "path";
import { initLogger, logger } from "./src/constants/Logger.mjs";
import { Client, Events, GatewayOpcodes, EmbedBuilder } from "@fluxerjs/core";
import { CommandHandler, CommandLoader, PrefixManager } from "./src/CommandHandler.mjs";
import { MessageHandler, PageBuilder, HelpCommand, setGlobalColor, getGlobalColor } from "./src/MessageHandler.mjs";
import { RemoteSettingsManager, ServerSettings } from "./src/Settings.mjs";
import { PlayerManager } from "./src/PlayerManager.mjs";
import Player from "./src/Player.mjs";
import childProcess from "node:child_process";
import { getVoiceManager } from "@fluxerjs/voice";
import { MoonlinkManager } from "./src/MoonlinkManager.mjs";
import mysql from "mysql";

class Remix {
  constructor() {
    const config = JSON.parse(fs.readFileSync("config.json"));
    this.config  = config;

    // Apply embed color from config globally
    setGlobalColor(config.embedColor);

    const presenceContents = config.presenceContents ?? [];
    const presenceInterval = config.presenceInterval ?? 30_000;

    // ── Timers config ─────────────────────────────────────────────────────────
    const timers = config.timers ?? {};
    const T = {
      aloneCheckInterval:  timers.aloneCheckInterval  ?? 30_000,
      aloneCheckDebounce:  timers.aloneCheckDebounce  ?? 500,
      rejoin247Delay:      timers.rejoin247Delay       ?? 3_000,
      leave247RejoinDelay: timers.leave247RejoinDelay  ?? 5_000,
      intentionalLeaveTTL: timers.intentionalLeaveTTL  ?? 10_000,
    };

    const client = new Client({
      intents: 0,
      ...config["fluxer.js"],
      presence: presenceContents.length > 0 ? {
        status:        "online",
        mobile:        false,
        afk:           false,
        custom_status: { text: presenceContents[0] },
      } : undefined,
    });

    client.setMaxListeners(50);

    this.client = client;

    const messages = new MessageHandler(this.client);
    this.messages  = messages;

    const settings    = new RemoteSettingsManager(config.mysql, "./storage/defaults.json");
    this.settingsMgr  = settings;

    const commands = new CommandHandler(messages);
    this.handler   = commands;

    commands.setPrefixManager(new PrefixManager(settings));

    // ── Help command ──────────────────────────────────────────────────────────
    new HelpCommand(commands, messages, (msg) => this.getSettings(msg)).register();

    commands.onPing = (msg) => {
      msg.replyEmbed(
          this.handler.format(
              "My prefix in this server is `$prefix`\n\nRun `$prefix$helpCmd` to get started!",
              msg.message.guildId
          ),
          false,
          {
            icon_url: msg.channel.channel.guild?.icon
                ? `https://cdn.fluxer.app/icons/${msg.channel.channel.guild.id}/${msg.channel.channel.guild.icon}.webp`
                : null,
            title:    msg.channel.channel.guild?.name        ?? null,
          }
      );
    };
    commands.owners = config.owners ?? [];

    // ── MoonlinkManager ───────────────────────────────────────────────────────
    this.moonlink = null;

    // Guards for one-time setup inside Events.Ready (which fires on every reconnect).
    // Without these, each reconnect stacks another listener / interval.
    let wsListenerAttached  = false;
    let moonlinkInitialised = false;
    let presenceTimer       = null;

    // track presence rotation index outside the Ready handler so it
    // persists across reconnects instead of resetting to 0 each time.
    let presenceIndex = 0;

    // Per-channel spawn mutex — prevents two rapid calls both passing the
    // playerMap.has() guard before either has inserted, creating zombie players.
    const pendingSpawns = new Set();

    // ── spawnPlayer ───────────────────────────────────────────────────────────
    const spawnPlayer = async (guildId, channelId, delayMs = 0, recoveryData = null) => {
      if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));

      const cleanChannelId = String(channelId).replace(/\D/g, "");
      if (!cleanChannelId) return;

      // Only enforce 24/7 check if we are NOT recovering from a reboot
      if (!recoveryData) {
        const set = this.settingsMgr.getServer(guildId);
        const raw = set.get("stay_247");
        if (!raw || raw === "none") return;

        const channels = Array.isArray(raw)
            ? new Set(raw.map(id => String(id).replace(/\D/g, "")).filter(Boolean))
            : new Set([String(raw).replace(/\D/g, "")]);
        if (!channels.has(cleanChannelId)) return;
      }

      // Atomic mutex check — blocks concurrent spawns for the same channel.
      if (this.players.playerMap.has(cleanChannelId) || pendingSpawns.has(cleanChannelId)) return;
      pendingSpawns.add(cleanChannelId);

      try {
        let channel = client.channels.cache.get(cleanChannelId);
        if (!channel) {
          // voiceAdapterCreator is a concept and not meaningful in Fluxer.
          // A simple cache-miss check is sufficient — fetch only when not already cached.
          try {
            channel = await client.channels.fetch(cleanChannelId);
          } catch (e) {
            logger.warn("[PlayerSpawn] Could not fetch channel", cleanChannelId, e.message);
            return;
          }
        }
        if (!channel) { logger.warn("[PlayerSpawn] Channel not found:", cleanChannelId); return; }
        client.channels.cache.set(cleanChannelId, channel);

        const p = new Player(this.config.token, {
          client:           client,
          config:           config,
          nodelink:         config.nodelink,
          moonlink:         this.moonlink,
          settingsMgr:      this.settingsMgr,
          observedVoiceUsers: this.observedVoiceUsers,
        });

        p.on("autoleave", async () => {
          this.players.playerMap.delete(cleanChannelId);
          p.destroy();
          const raw2      = this.settingsMgr.getServer(guildId).get("stay_247");
          const channels2 = (!raw2 || raw2 === "none")
              ? []
              : Array.isArray(raw2)
                  ? raw2.map(id => String(id).replace(/\D/g, "")).filter(Boolean)
                  : [String(raw2).replace(/\D/g, "")].filter(Boolean);
          if (channels2.includes(cleanChannelId)) {
            const mode = this.settingsMgr.getServer(guildId).get("stay_247_mode") ?? "auto";
            if (mode === "auto") await spawnPlayer(guildId, cleanChannelId, T.rejoin247Delay);
          } else {
            // 24/7 is off — send inactivity message with hint to enable 247
            try {
              const prefix = this.handler?.getPrefix?.(guildId) ?? "%";
              const guild  = this.client.guilds.cache.get(guildId);
              // isTextBased() and permissionsFor() are APIs — use optional
              // chaining so missing implementations fail gracefully. Fall back to channel_type
              // string check which is the raw Fluxer gateway field.
              const ch = guild?.channels?.cache?.find(c =>
                  (c.isTextBased?.() ?? c.channel_type === "TextChannel" ?? true) &&
                  (c.permissionsFor?.(this.client.user)?.has?.("SendMessages") ?? true)
              );
              if (ch) {
                const embed = new EmbedBuilder()
                    .setColor(getGlobalColor())
                    .setDescription(
                      `Left channel <#${cleanChannelId}> because of inactivity.\n` +
                      `If you want me to stay in voice, use \`${prefix}247 on/auto\``
                    )
                    .toJSON();
                ch.send({ embeds: [embed] }).catch(() => {});
              }
            } catch (_) {}
          }
        });

        p.on("message", (m) => {
          const raw      = this.settingsMgr.getServer(guildId).get("songAnnouncements");
          // Centralised falsy check — mirrors the canonical list in settings/runnables.mjs
          // so both places stay in sync if valid values ever change.
          const disabled = raw === false || raw === 0 ||
              ["false", "0", "no", "off", "disable"].includes(String(raw).toLowerCase().trim());
          if (disabled) return;
          const guild = this.client.guilds.cache.get(guildId);
          // _announcementChannelCache is always a Map — no null check needed.
          const cachedChId = this._announcementChannelCache.get(guildId);
          let ch = cachedChId ? guild?.channels?.cache?.get(cachedChId) : null;
          // if cached channel is gone (deleted/uncached), clear the stale
          // entry immediately so we don't re-scan on every subsequent message event.
          if (cachedChId && !ch) {
            this._announcementChannelCache.delete(guildId);
          }
          if (!ch) {
            ch = guild?.channels?.cache?.find(c =>
                (c.isTextBased?.() ?? c.channel_type === "TextChannel" ?? true) &&
                (c.permissionsFor?.(this.client.user)?.has?.("SendMessages") ?? true)
            );
            if (ch) this._announcementChannelCache.set(guildId, ch.id);
          }
          ch?.send({ embeds: [{ description: String(m), color: getGlobalColor() }] }).catch(() => {});
        });

        this.players.playerMap.set(cleanChannelId, p);

        try {
          await p.join(cleanChannelId);

          // ==== RESTORE STATE IF RECOVERING ====
          if (recoveryData) {
            if (recoveryData.textChannelId) {
              p.textChannel = client.channels.cache.get(recoveryData.textChannelId);
            }
            if (recoveryData.loopQueue) p.queue.setLoop(true);
            if (recoveryData.loopSong)  p.queue.setSongLoop(true);

            if (recoveryData.queue && recoveryData.queue.length > 0) {
              p.queue.addMany(recoveryData.queue);
              p.playNext();
            }
            logger.recovery(`[Recovery] Restored session in ${cleanChannelId}.`);
          }
        } catch (e) {
          this.players.playerMap.delete(cleanChannelId);
          logger.warn("[PlayerSpawn] Failed to join channel", cleanChannelId, "guild", guildId, e.message);
        }

        return p;
      } finally {
        // Always release the mutex so future spawns aren't permanently blocked.
        pendingSpawns.delete(cleanChannelId);
      }
    };

    this._spawnPlayer = spawnPlayer;

    // ── Auto-join & Recovery ──────────────────────────────────────────────────
    let botReady      = false;
    let settingsReady = false;

    const tryAutoJoin = async () => {
      if (!botReady || !settingsReady) return;
      await new Promise(r => setTimeout(r, 2000));

      // 1. Recover standard reboots first
      const recoveryPath = "./storage/recovery.json";
      if (fs.existsSync(recoveryPath)) {
        logger.recovery("[Recovery] Found previous session data, restoring...");
        try {
          const data = JSON.parse(fs.readFileSync(recoveryPath, "utf8"));
          for (const session of data) {
            await spawnPlayer(session.guildId, session.channelId, 500, session);
          }
          fs.unlinkSync(recoveryPath);
        } catch (e) {
          logger.error("[Recovery] Failed to recover sessions:", e);
        }
      }

      // 2. Check traditional 24/7 channels
      for (const [guildId, serverSettings] of this.settingsMgr.guilds) {
        const raw  = serverSettings.get("stay_247");
        if (!raw || raw === "none") continue;
        const mode = serverSettings.get("stay_247_mode") ?? "auto";

        if (mode !== "auto" && mode !== "on") continue;

        const channelIds = Array.isArray(raw)
            ? raw.map(id => String(id).replace(/\D/g, "")).filter(Boolean)
            : [String(raw).replace(/\D/g, "")].filter(Boolean);
        for (const channelId of channelIds) await spawnPlayer(guildId, channelId);
      }
    };

    settings.on("ready", () => {
      initLogger(config);
      logger.settings("[settings] Loaded from DB.");
      for (const [guildId, serverSettings] of settings.guilds) {
        const val = serverSettings.get("stay_247");
        if (!val || val === "none") continue;
        if (Array.isArray(val)) {
          const cleaned = val.map(id => String(id).replace(/\D/g, "")).filter(Boolean);
          if (JSON.stringify(cleaned) !== JSON.stringify(val)) {
            serverSettings.set("stay_247", cleaned.length > 0 ? cleaned : "none");
          }
        } else {
          const clean = String(val).replace(/\D/g, "");
          serverSettings.set("stay_247", clean ? [clean] : "none");
        }
      }
      settingsReady = true;
      tryAutoJoin();
    });

    // ── Bot ready ─────────────────────────────────────────────────────────────
    client.on(Events.Ready, async () => {
      logger.player("Logged in as " + (client.user?.username ?? "bot"));

      try {
        getVoiceManager(client);
        logger.player("VoiceManager initialized.");
      } catch (e) {
        logger.warn("[VoiceManager] Init failed:", e.message);
      }

      const botId = client.user?.id ?? "0";

      // Guard Moonlink creation exactly like wsListenerAttached guards the WS listener.
      // Previously new MoonlinkManager() + .on("ready") ran on every gateway reconnect,
      // creating a fresh instance each time and stacking an extra "ready" listener on it.
      // The old orphaned instance kept its listener alive → duplicate session updates + memory leak.
      if (!moonlinkInitialised) {
        moonlinkInitialised = true;
        this.moonlink = new MoonlinkManager(config.nodelink ?? {}, client);

        this.moonlink.on("ready", (sessionId) => {
          logger.moonlink(`[Moonlink] Session ready: ${sessionId}`);
          for (const player of this.players?.playerMap?.values() ?? []) {
            player._nl.sessionId = sessionId;
          }
          this.playerContext.moonlink = this.moonlink;
        });

        try {
          await this.moonlink.init(botId);
        } catch (e) {
          logger.error("[Moonlink] Init failed:", e.message);
        }
      } else {
        // On reconnect, re-announce the node so Moonlink re-establishes its WS session.
        logger.moonlink("[Moonlink] Reconnected — re-initialising node session.");
        try {
          await this.moonlink.init(botId);
        } catch (e) {
          logger.error("[Moonlink] Re-init failed:", e.message);
        }
      }

      for (const [gId, guild] of client.guilds.cache) {
        // guild.voice_states — raw snake_case array from @fluxerjs/core gateway payload (preferred).
        // guild.voiceStates?.cache — voiceStateManager collection (fallback, may not exist).
        // guild.voiceStates — bare iterable fallback if cache sub-property is absent.
        const voiceStatesRaw =
            guild.voice_states ??
            guild.voiceStates?.cache ??
            guild.voiceStates ??
            null;
        if (!voiceStatesRaw) continue;
        const entries = Array.isArray(voiceStatesRaw)
            ? voiceStatesRaw
            : typeof voiceStatesRaw.values === "function"
                ? [...voiceStatesRaw.values()]
                : Object.values(voiceStatesRaw);
        for (const state of entries) {
          const userId    = state.userId ?? state.user_id ?? state.id;
          const channelId = state.channelId ?? state.channel_id;
          if (!userId || !channelId) continue;
          const isBot  = state.member?.user?.bot ?? false;
          const target = isBot ? this.observedVoiceBots : this.observedVoiceUsers;
          target.set(userId, { channelId, guildId: gId });
        }
      }

      // Guard WS listener registration so it only runs once across all reconnects.
      // Without this, each reconnect stacks a new listener on the same socket, causing
      // every WS frame to be processed N times after N reconnects.
      if (!wsListenerAttached) {
        wsListenerAttached = true;
        try {
          // NOTE: client.ws.shards is declared private in @fluxerjs/ws, but there is
          // no public API for attaching a raw message listener to the underlying socket.
          // ws.send(shardId, payload) exists for sending, but not for receiving.
          // This access is intentional — if @fluxerjs/core ever exposes a public
          // onRawMessage() hook, replace these two lines with that API instead.
          const shard0 = client.ws?.shards?.get?.(0);
          const wsObj  = shard0?.ws ?? null;

          const handleRaw = (data) => {
            try {
              const payload = typeof data === "string" ? JSON.parse(data) : data;

              if (payload?.op === GatewayOpcodes.GatewayError || payload?.op === 12) {
                logger.warn("[Gateway] GatewayError (12) received from Fluxer:", payload.d);
              }

              if (payload?.op !== 0) return;

              // READY payload contains an unavailable-guilds summary, but some
              // Fluxer gateway implementations include voice_states inside each
              // guild object in the READY d.guilds array — seed them here so the
              // bot knows who is in voice immediately on reboot, before the
              // individual GUILD_CREATE bursts complete.
              if (payload.t === "READY") {
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
                      const target = isBot ? this.observedVoiceBots : this.observedVoiceUsers;
                      target.set(userId, { channelId, guildId: gId });
                    }
                  }
                }
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
                    const target = isBot ? this.observedVoiceBots : this.observedVoiceUsers;
                    target.set(userId, { channelId, guildId: gId });
                  }
                }
              }

              if (payload.t === "VOICE_STATE_UPDATE") {
                const d         = payload.d;
                const userId    = d?.user_id;
                const channelId = d?.channel_id ?? null;
                const guildId   = d?.guild_id;
                const isBot     = d?.member?.user?.bot ?? false;
                if (!userId) return;
                const target = isBot ? this.observedVoiceBots : this.observedVoiceUsers;
                // WS path correctly deletes on channelId=null,
                // keeping observedVoice* from growing unbounded.
                if (channelId) target.set(userId, { channelId, guildId });
                else           target.delete(userId);
              }
            } catch (_) {}
          };

          if (typeof wsObj?.addEventListener === "function") {
            wsObj.addEventListener("message", (event) => handleRaw(event.data));
          } else if (typeof wsObj?.on === "function") {
            wsObj.on("message", handleRaw);
          }
        } catch (_) {}
      }

      botReady = true;
      tryAutoJoin();

      if (presenceContents.length > 0) {
        // setPresence now uses the outer presenceIndex so rotation
        // continues from where it left off after a reconnect instead of
        // restarting from 0 each time.
        const setPresence = () => {
          const presence = {
            status:        "online",
            mobile:        false,
            afk:           false,
            custom_status: { text: presenceContents[presenceIndex] },
          };
          // Use the public ws.send(shardId, payload) API instead of accessing the
          // private shards Map directly — shards is declared private in @fluxerjs/ws
          // and accessing it works at runtime but breaks on any internal refactor.
          if (client.ws?.send) {
            client.ws.send(0, { op: GatewayOpcodes.PresenceUpdate, d: presence });
          } else {
            // Fallback: access shards directly only if public API is unavailable
            const shard = client.ws?.shards?.get?.(0);
            if (shard) shard.send({ op: GatewayOpcodes.PresenceUpdate, d: presence });
          }
          presenceIndex = (presenceIndex + 1) % presenceContents.length;
        };
        setPresence();
        // Clear any existing interval before creating a new one.
        // Without this, each reconnect stacks another setInterval, eventually
        // spamming the gateway with duplicate presence updates.
        if (presenceTimer) clearInterval(presenceTimer);
        presenceTimer = setInterval(setPresence, presenceInterval);
      }
    });

    // ── Voice state tracking ──────────────────────────────────────────────────
    // Both maps are cleaned up in the WS handleRaw VOICE_STATE_UPDATE path
    // (channelId=null → delete) and in GuildDelete, so they don't grow unbounded.
    this.observedVoiceUsers = new Map();
    this.observedVoiceBots  = new Map();
    // initialise announcement channel cache eagerly alongside other caches
    // so the hot path never needs a null-check allocation.
    this._announcementChannelCache = new Map();

    /**
     * Channels the bot is intentionally leaving.
     * @type {Map<string, ReturnType<typeof setTimeout>>}
     */
    this.intentionalLeaves = new Map();

    // Merged the two separate GuildCreate handlers into one.
    // Previously there were two client.on(Events.GuildCreate) registrations.
    // Every GuildCreate event was firing both handlers — doubling voice-state work and
    // triggering a burst of parallel DB queries on startup for every guild.
    client.on(Events.GuildCreate, async (guild) => {
      const guildId = guild?.id ?? guild?._id;
      if (!guildId) return;

      // ── Part 1: Voice state population ──────────────────────────────────────
      const voiceStatesRaw =
          guild.voice_states ??
          guild.voiceStates?.cache ??
          guild.voiceStates ??
          null;
      if (voiceStatesRaw) {
        const entries = Array.isArray(voiceStatesRaw)
            ? voiceStatesRaw
            : typeof voiceStatesRaw.values === "function"
                ? [...voiceStatesRaw.values()]
                : Object.values(voiceStatesRaw);

        for (const state of entries) {
          const channelId = state.channelId ?? state.channel_id;
          const userId    = state.userId    ?? state.user_id ?? state.id;
          const sgid      = state.guildId   ?? state.guild_id ?? guildId;
          const isBot     = state.member?.user?.bot ?? false;
          if (!channelId || !userId) continue;
          const target = isBot ? this.observedVoiceBots : this.observedVoiceUsers;
          target.set(userId, { channelId, guildId: sgid });
        }
      }

      // ── Part 2: Settings init for new/re-joined servers ──────────────────────
      // GuildCreate fires on initial join AND on gateway resume for existing servers.
      // Only act when the guild is missing from our cache (new join or post-GuildDelete).
      if (!this.settingsMgr.guilds.has(guildId)) {
        logger.guild(`[GuildCreate] (Re-)joined server ${guildId} — initialising settings.`);
        try {
          const res = await this.settingsMgr.query(
              `SELECT * FROM settings WHERE id=${mysql.escape(guildId)}`
          );
          if (res?.results?.length) {
            const row    = res.results[0];
            const server = new ServerSettings(guildId, this.settingsMgr);
            server.deserialize(JSON.parse(row.data));
            server.checkDefaults(this.settingsMgr.defaults);
            this.settingsMgr.guilds.set(guildId, server);
            logger.guild(`[GuildCreate] Restored existing settings for server ${guildId}.`);
          } else {
            const server = new ServerSettings(guildId, this.settingsMgr);
            server.checkDefaults(this.settingsMgr.defaults);
            this.settingsMgr.guilds.set(guildId, server);
            // Persist the new row so settings survive restarts from the first join.
            await this.settingsMgr.create(guildId, server);
            logger.guild(`[GuildCreate] Fresh settings initialised for server ${guildId}.`);
          }
        } catch (err) {
          logger.warn("[GuildCreate] Settings init failed for", guildId, err.message);
        }
      }
    });

    // ── Bot kicked / banned / server deleted ─────────────────────────────────
    client.on(Events.GuildDelete, (guild) => {
      const guildId = guild?.id ?? guild?._id;
      if (!guildId) return;

      logger.guild(`[GuildDelete] Removed from server ${guildId} — cleaning up.`);

      // Use player._guildId directly instead of resolving the channel from
      // client.channels.cache (which may already be evicted at this point).
      // The old approach fell through 4 property-chain guesses and silently leaked the
      // player when all of them were undefined (e.g. after a partial cache eviction).
      for (const [channelId, player] of this.players.playerMap) {
        if (!player._guildId || player._guildId === guildId) {
          this.players.playerMap.delete(channelId);
          try { player.leave().catch(() => {}); } catch (_) {}
          try { player.destroy();               } catch (_) {}
          logger.guild(`[GuildDelete] Destroyed player for channel ${channelId}.`);
        }
      }

      // Clear voice-state tracking for this server
      for (const [userId, info] of [...this.observedVoiceUsers]) {
        if (info.guildId === guildId) this.observedVoiceUsers.delete(userId);
      }
      for (const [userId, info] of [...this.observedVoiceBots]) {
        if (info.guildId === guildId) this.observedVoiceBots.delete(userId);
      }

      // Drop the cached settings so stale data can't be read back
      this.settingsMgr.removeServer(guildId);

      // Clear announcement channel cache for this guild
      this._announcementChannelCache.delete(guildId);

      logger.guild(`[GuildDelete] Cleanup complete for server ${guildId}.`);
    });

    // Track previous voice state per-user so we can detect channel moves.
    // @fluxerjs/core fires VoiceStateUpdate with ONE arg (raw gateway data),
    // not two args (oldState, newState) We maintain prev state manually.
    const _prevVoiceState = new Map(); // userId → { channelId, guildId }

    client.on(Events.VoiceStateUpdate, (data) => {
      // data is the raw GatewayVoiceStateUpdateDispatchData — always snake_case
      const userId = data?.user_id;
      if (!userId) return;

      const channelId = data?.channel_id ?? null;
      const guildId   = data?.guild_id;
      const isBot     = data?.member?.user?.bot ?? null;

      // Capture old channel BEFORE updating prev state
      const prev         = _prevVoiceState.get(userId);
      const oldChannelId = prev?.channelId ?? null;

      // Update prev state
      if (channelId) {
        _prevVoiceState.set(userId, { channelId, guildId });
      } else {
        _prevVoiceState.delete(userId);
      }

      // Always update/delete the voice maps so they never accumulate stale entries
      const target = isBot === true ? this.observedVoiceBots : this.observedVoiceUsers;
      if (channelId) {
        target.set(userId, { channelId, guildId });
      } else {
        // On leave, delete from BOTH maps — isBot can be null/inconsistent
        // between join and leave events, so the user may be in either map.
        this.observedVoiceUsers.delete(userId);
        this.observedVoiceBots.delete(userId);
      }

      const isBotUser = isBot === true && userId === client.user?.id;

      if (!isBotUser) {
        // Resolve guildId from prev state too — leave events may have null guild_id
        const resolvedGuildId = guildId ?? prev?.guildId;
        if (!resolvedGuildId) return;

        if (channelId) {
          try {
            const raw = this.settingsMgr.getServer(resolvedGuildId)?.get("stay_247");
            if (raw && raw !== "none") {
              const cleanId  = String(channelId).replace(/\D/g, "");
              const channels = Array.isArray(raw)
                  ? new Set(raw.map(id => String(id).replace(/\D/g, "")).filter(Boolean))
                  : new Set([String(raw).replace(/\D/g, "")]);
              if (channels.has(cleanId)) return;
            }
          } catch (_) {}
        }

        // Human LEFT a voice channel → check if bot is now alone
        if (oldChannelId && oldChannelId !== channelId) {
          try {
            const cleanOld = String(oldChannelId).replace(/\D/g, "");
            const player   = this.players.playerMap.get(cleanOld);
            if (player && typeof player._startInactivityTimer === "function") {
              setTimeout(() => {
                if (!player._hasHumansInChannel()) {
                  logger.voiceState(`[VoiceState] Last human left ${cleanOld}, starting inactivity timer`);
                  player._startInactivityTimer();
                }
              }, T.aloneCheckDebounce);
            }
          } catch (_) {}
        }

        // Human JOINED the bot's channel → cancel inactivity timer
        if (channelId) {
          try {
            const cleanId = String(channelId).replace(/\D/g, "");
            const player  = this.players.playerMap.get(cleanId);
            if (player && typeof player._stopInactivityTimer === "function") {
              logger.voiceState(`[VoiceState] Human joined ${cleanId}, stopping inactivity timer`);
              player._stopInactivityTimer();
            }
          } catch (_) {}
        }

        return;
      }

      // ── Bot-only logic below ─────────────────────────────────────────────

      // Auto-save channel when bot moves (247 active)
      if (channelId && guildId && oldChannelId && oldChannelId !== channelId) {
        try {
          const set = this.settingsMgr.getServer(guildId);
          const raw = set.get("stay_247");
          if (raw && raw !== "none") {
            const cleanId  = String(channelId).replace(/\D/g, "");
            const cleanOld = String(oldChannelId).replace(/\D/g, "");
            const channels = Array.isArray(raw)
                ? new Set(raw.map(id => String(id).replace(/\D/g, "")).filter(Boolean))
                : new Set([String(raw).replace(/\D/g, "")]);
            if (channels.has(cleanOld) && cleanOld !== cleanId) {
              channels.delete(cleanOld);
              channels.add(cleanId);
              set.set("stay_247", [...channels]);
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
          if (this.intentionalLeaves.has(cleanOld)) {
            logger.voice247(`[247] Skipping rejoin for ${cleanOld} — intentional leave.`);
          } else {
            const set = this.settingsMgr.getServer(guildId);
            const raw = set.get("stay_247");
            if (raw && raw !== "none") {
              const channels = Array.isArray(raw)
                  ? new Set(raw.map(id => String(id).replace(/\D/g, "")).filter(Boolean))
                  : new Set([String(raw).replace(/\D/g, "")]);
              if (channels.has(cleanOld)) {
                const mode = set.get("stay_247_mode") ?? "auto";
                if (mode === "auto") {
                  const player = this.players.playerMap.get(cleanOld);
                  if (player && !player.leaving) {
                    logger.voice247("[247] Fluxer gateway disconnected us. Forcing player recovery...");
                    if (typeof player._recoverConnection === "function") {
                      player._recoverConnection();
                    }
                  } else {
                    spawnPlayer(guildId, cleanOld, T.rejoin247Delay);
                  }
                } else {
                  logger.voice247(`[247] stay_247_mode='${mode}' — not rejoining. Removing from 24/7.`);
                  channels.delete(cleanOld);
                  set.set("stay_247", channels.size > 0 ? [...channels] : "none");
                  if (channels.size === 0) set.set("stay_247_mode", "off");
                }
              }
            }
          }
        } catch (e) {
          logger.warn("[247] Rejoin on disconnect failed:", e.message);
        }
      }
    });

    // ── Commands ──────────────────────────────────────────────────────────────
    const loader    = new CommandLoader(commands, this);
    const __dirname = import.meta.dirname;
    const dir       = path.join(__dirname, "commands");
    logger.commands("Started loading commands.");
    loader.loadFromDir(dir)
        .then(() => logger.commands("Commands loaded."))
        .catch(e => logger.error("Failed to load commands:", e));

    // ── Modules ───────────────────────────────────────────────────────────────
    logger.commands("Loading Modules.");
    this.loadedModules = new Map();
    this.modules       = JSON.parse(fs.readFileSync("./storage/modules.json"));
    Promise.all(this.modules.map(async m => {
      if (!m.enabled) return;
      const exported = await import(m.index);
      const ModClass = exported.default;
      this.loadedModules.set(m.name, { instance: new ModClass(this), c: ModClass });
    }))
        .then(() => logger.commands("Modules loaded."))
        .catch(e => logger.error("Failed to load modules:", e));

    // ── Git commit hash ───────────────────────────────────────────────────────
    try {
      this.comHash     = childProcess.execSync("git rev-parse --short HEAD", { cwd: __dirname, timeout: 3000 }).toString().trim();
      this.comHashLong = childProcess.execSync("git rev-parse HEAD",         { cwd: __dirname, timeout: 3000 }).toString().trim();
    } catch {
      logger.warn("[Git] comhash error");
      this.comHash     = "Newest";
      this.comHashLong = null;
    }

    // ── Player ────────────────────────────────────────────────────────────────
    this.playerContext = {
      client:   this.client,
      config,
      nodelink: config.nodelink,
      moonlink: null,
    };
    this.players = new PlayerManager(settings, commands, { config, player: this.playerContext });
    this.players.observedVoiceUsers = this.observedVoiceUsers;

    // ── Periodic alone-check ───────────────────────────────────────────────────
    // Every 30 seconds, scan all active players. If the bot is alone in a voice
    // channel (no humans) and 247 is NOT on/auto, leave immediately.
    // This is the authoritative leave mechanism — does not rely on voice state events.
    const ALONE_CHECK_INTERVAL = T.aloneCheckInterval;
    setInterval(() => {
      for (const [channelId, player] of this.players.playerMap) {
        try {
          const guildId = player._guildId;
          if (!guildId) continue;

          // Skip if 247 is on or auto
          if (player._is247Enabled()) continue;

          // Read directly from observedVoiceUsers — bypass any cache issues
          // Normalize both sides to digits-only to avoid format mismatch
          const cleanChanId  = String(channelId).replace(/\D/g, "");
          const cleanGuildId = String(guildId).replace(/\D/g, "");
          let hasHuman = false;
          for (const [, info] of this.observedVoiceUsers) {
            const infoChannel = String(info.channelId ?? "").replace(/\D/g, "");
            const infoGuild   = String(info.guildId   ?? "").replace(/\D/g, "");
            if (infoGuild === cleanGuildId && infoChannel === cleanChanId) {
              hasHuman = true;
              break;
            }
          }

          logger.aloneCheck(`[AloneCheck] channel=${channelId} guild=${guildId} hasHuman=${hasHuman} paused=${player._paused}`);

          if (!hasHuman && !player._paused) {
            // If the bot is playing (queue has a current track), start the
            // inactivity timer so it waits the configured timeout before leaving.
            // _startInactivityTimer is a no-op if the timer is already running,
            // so this is safe to call on every interval tick.
            if (player.queue?.getCurrent() || !player.queue?.isEmpty()) {
              logger.aloneCheck(`[AloneCheck] Bot alone in ${channelId} (guild ${guildId}) with songs in queue — starting inactivity timer.`);
              player._startInactivityTimer?.();
            } else {
              logger.aloneCheck(`[AloneCheck] Bot alone in ${channelId} (guild ${guildId}), leaving.`);
              player._stopInactivityTimer?.();
              player.emit("autoleave");
            }
          } else if (hasHuman) {
            // A human rejoined — cancel any pending inactivity leave.
            player._stopInactivityTimer?.();
          }
        } catch (e) {
          logger.warn("[AloneCheck] Error checking channel", channelId, e.message);
        }
      }
    }, ALONE_CHECK_INTERVAL);

    const self = this;
    this.players.checkVoiceChannels = function (message) {
      const userId  = message?.author?.id   ?? message?.message?.author?.id;
      const guildId =
          message?.channel?.server_id    ??
          message?.channel?.serverId     ??
          message?.channel?.guild?.id    ??
          message?.channel?.guildId      ??
          message?.message?.server_id    ??
          message?.message?.serverId     ??
          message?.message?.guildId      ??
          message?.message?.channel?.server_id ??
          message?.message?.channel?.serverId  ??
          message?.message?.channel?.guildId;
      if (!userId || !guildId) return null;

      // Normalise to digits-only for all comparisons so "123" === "123" regardless
      // of how the platform formatted the snowflake.
      const cleanGuild = String(guildId).replace(/\D/g, "");

      const seed = (channelId) => {
        // Only seed if no entry exists — never overwrite fresh gateway voice state
        // with potentially stale member-cache data.
        if (!self.observedVoiceUsers.has(userId)) {
          self.observedVoiceUsers.set(userId, { channelId, guildId: cleanGuild });
        }
        return self.observedVoiceUsers.get(userId)?.channelId ?? channelId;
      };

      const observed = self.observedVoiceUsers.get(userId);
      // Use normalised comparison — the stored guildId and message guildId may come
      // from different gateway fields with different formatting.
      if (observed && String(observed.guildId).replace(/\D/g, "") === cleanGuild) return observed.channelId;

      // vm.getVoiceChannelId() is an unverified @fluxerjs/voice method — optional-chained
      // so it fails silently and falls through to the next strategy if absent.
      try {
        const vm        = getVoiceManager(client);
        const channelId = vm?.getVoiceChannelId?.(guildId, userId);
        if (channelId) return seed(channelId);
      } catch (_) {}

      // @fluxerjs/core member objects may not carry a .voice property.
      // Optional-chained so it's a silent no-op if absent.
      const memberVoice =
          message?.member?.voice?.channelId ??
          message?.message?.member?.voice?.channelId ??
          null;
      if (memberVoice) return seed(memberVoice);

      // @fluxerjs/core may expose voice states differently (e.g. raw voice_states array
      // on the guild object from the gateway payload, which is handled in GuildCreate).
      // The dual snake_case/camelCase probe covers both shapes.
      try {
        // Try both the raw guildId and the normalized cleanGuild — the guilds cache
        // key may be stored as the raw string the gateway sent.
        const guild = client.guilds.cache.get(guildId) ?? client.guilds.cache.get(cleanGuild);
        // guild.voice_states = raw array from gateway (Fluxer-native)
        // guild.voiceStates?.cache = VoiceStateManager (fallback)
        const voiceStates = guild?.voice_states ?? guild?.voiceStates?.cache ?? guild?.voiceStates ?? null;
        if (voiceStates) {
          const entries = Array.isArray(voiceStates)
              ? voiceStates
              : typeof voiceStates.values === "function"
                  ? voiceStates.values()
                  : Object.values(voiceStates);
          for (const state of entries) {
            const sid  = state.userId ?? state.user_id ?? state.id;
            const sch  = state.channelId ?? state.channel_id;
            const sgid = String(state.guildId ?? state.guild_id ?? guildId).replace(/\D/g, "");
            if (sid === userId && sgid === cleanGuild && sch) return seed(sch);
          }
        }
      } catch (_) {}

      // Last resort: scan ALL entries in observedVoiceUsers for this userId regardless
      // of guildId format, then verify the channel belongs to the right guild.
      // This catches cases where the guildId was stored with a different string format.
      try {
        for (const [uid, info] of self.observedVoiceUsers) {
          if (uid !== userId) continue;
          if (String(info.guildId).replace(/\D/g, "") === cleanGuild) return info.channelId;
        }
      } catch (_) {}

      return null;
    };

    this.comLink = "https://github.com/remix-bot/fluxer/commit/" + (this.comHashLong ?? "");

    client.login(config.token);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  markIntentionalLeave(channelId, ttlMs = null) {
    const clean = String(channelId).replace(/\D/g, "");
    if (!clean) return;
    if (ttlMs === null) ttlMs = this.config?.timers?.intentionalLeaveTTL ?? 10_000;
    const existing = this.intentionalLeaves.get(clean);
    if (existing) clearTimeout(existing);
    this.intentionalLeaves.set(clean, setTimeout(() => {
      this.intentionalLeaves.delete(clean);
    }, ttlMs));
  }

  async leaveChannel(channelId, guildId, message, force = false) {
    const cleanId = String(channelId).replace(/\D/g, "");
    const set     = this.settingsMgr.getServer(guildId);
    const raw     = set.get("stay_247");
    const mode    = set.get("stay_247_mode") ?? "auto";

    const channels = (!raw || raw === "none")
        ? new Set()
        : Array.isArray(raw)
            ? new Set(raw.map(id => String(id).replace(/\D/g, "")).filter(Boolean))
            : new Set([String(raw).replace(/\D/g, "")]);

    // If mode is auto, block the leave command
    if (channels.has(cleanId) && !force) {
      if (mode === "auto") {
        if (message) {
          message.replyEmbed(
              `⚠️ 24/7 mode is enabled (auto) — I'll rejoin <#${cleanId}> in a few seconds.\n` +
              `To permanently remove me, disable 24/7 mode first: \`%247 off\``
          );
        }
        return false;
      }
    }

    // If mode is 'on' or it's forced, allow leaving & remove from 24/7 list
    if (channels.has(cleanId)) {
      channels.delete(cleanId);
      set.set("stay_247", channels.size > 0 ? [...channels] : "none");
      if (channels.size === 0) set.set("stay_247_mode", "off");
    }

    this.markIntentionalLeave(cleanId);

    const player = this.players.playerMap.get(cleanId);
    if (player) {
      this.players.playerMap.delete(cleanId);
      await player.leave().catch(() => {});
      player.destroy();
    }

    if (message) message.replyEmbed("✅ Successfully Left");
    return true;
  }

  /** @param {Message} message */
  getSettings(message) {
    const guildId = message?.channel?.channel?.guildId ?? message?.guildId ?? null;
    return this.settingsMgr.getServer(guildId);
  }

  getPlayer(message, promptJoin, verifyUser, shouldJoin) {
    return this.players.getPlayer(message, promptJoin, verifyUser, shouldJoin);
  }

  getSharedServers(user) {
    // guild.members.cache.has() only works for cached members (requires privileged intents).
    // Instead, use the settings guilds map — any guild the bot is in and has settings for
    // is one we actually serve, which is a reliable proxy for "shared server".
    const mutualGuilds = this.client.guilds.cache.filter(g =>
        this.settingsMgr.guilds.has(g.id)
    );
    return Promise.resolve([...mutualGuilds.values()].map(guild => ({
      name:          guild.name,
      id:            guild.id,
      icon:          guild.icon
          ? `https://cdn.fluxer.app/icons/${guild.id}/${guild.icon}.webp`
          : null,
      voiceChannels: guild.channels.cache
          .filter(c => c.isVoiceBased())
          .map(c => ({ name: c.name, id: c.id, icon: null })),
    })));
  }

  pagination(form, content, msg, linesPerPage) {
    this.messages.initPagination(
        new PageBuilder(content).setForm(form).setMaxLines(linesPerPage),
        msg
    );
  }
}

const remix = new Remix();

process.on("unhandledRejection", (reason, p) => {
  if (reason?.message?.includes("AudioSource is closed")) return;
  logger.error("[Error_Handling] Unhandled Rejection/Catch");
  logger.error("Reason:", reason, p);
});
process.on("uncaughtException", (err, origin) => {
  logger.error("[Error_Handling] Uncaught Exception/Catch");
  logger.error("Error:", err, origin);
});
process.on("uncaughtExceptionMonitor", (err, origin) => {
  logger.error("[Error_Handling] Uncaught Exception/Catch (MONITOR)");
  logger.error("Error:", err, origin);
});

// ── Session Reboot Recovery Hooks ───────────────────────────────────────────
const saveAndExit = () => {
  logger.recovery("\n[Shutdown] Saving active sessions for reboot recovery...");
  try {
    const state = [];
    for (const [channelId, player] of remix.players.playerMap.entries()) {
      const current    = player.queue.getCurrent();
      const queueData  = player.queue.getQueue();
      const tracksToSave = [];

      if (current) tracksToSave.push(current);
      tracksToSave.push(...queueData);

      // Save ALL active sessions unconditionally so the bot always rejoins
      // the channel it was in before rebooting (queue or not, 24/7 or not)
      state.push({
        guildId:       player._guildId,
        channelId:     channelId,
        textChannelId: player.textChannel?.id ?? player.textChannel?._id,
        queue:         tracksToSave,
        loopQueue:     player.queue.loop,
        loopSong:      player.queue.songLoop,
      });
    }

    if (state.length > 0) {
      // Write to a temp file then rename atomically to prevent partial writes
      // if the OS sends SIGKILL before writeFileSync finishes on large queue states.
      const recoveryPath = "./storage/recovery.json";
      const tmpPath      = recoveryPath + ".tmp";
      fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
      fs.renameSync(tmpPath, recoveryPath);
      logger.recovery(`[Shutdown] Saved ${state.length} active sessions to storage/recovery.json`);
    } else {
      logger.recovery("[Shutdown] No active sessions to save.");
    }
  } catch (e) {
    logger.error("[Shutdown] Failed to save recovery state:", e.message);
  }
  process.exit(0);
};

process.once("SIGINT",  saveAndExit);
process.once("SIGTERM", saveAndExit);
process.once("SIGUSR2", saveAndExit);