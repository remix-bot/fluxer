import * as fs from "fs";
import path from "path";
import { initLogger, logger } from "./src/constants/Logger.mjs";
import { Client, Events } from "@fluxerjs/core";
import { CommandHandler, CommandLoader, PrefixManager } from "./src/CommandHandler.mjs";
import { MessageHandler, PageBuilder, HelpCommand, setGlobalColor } from "./src/MessageHandler.mjs";
import { RemoteSettingsManager } from "./src/Settings.mjs";
import { PlayerManager } from "./src/PlayerManager.mjs";
import childProcess from "node:child_process";
import { getVoiceManager } from "@fluxerjs/voice";
import { MoonlinkManager } from "./src/MoonlinkManager.mjs";
import { Dashboard } from "./src/dashboard/Dashboard.mjs";
import { Locale } from "./src/constants/Locale.mjs";
import { RecoveryManager } from "./src/RecoveryManager.mjs";
import { GatewayHandler } from "./src/GatewayHandler.mjs";

export class Remix {
  constructor() {
    // ── Config ───────────────────────────────────────────────────────────────
    let config;
    try {
      config = JSON.parse(fs.readFileSync("config.json", "utf8"));
    } catch (e) {
      const reason = e.code === "ENOENT"
          ? "config.json not found. Copy config_example.json → config.json and fill in your values."
          : `config.json is malformed JSON: ${e.message}`;
      console.error(`[Startup] FATAL: ${reason}`);
      process.exit(1);
    }
    const REQUIRED_KEYS = ["token", "mysql"];
    for (const key of REQUIRED_KEYS) {
      if (config[key] == null) {
        console.error(`[Startup] FATAL: config.json is missing required key "${key}".`);
        process.exit(1);
      }
    }
    this.config = config;

    // Apply embed color from config globally
    setGlobalColor(config.embedColor);

    // ── Locale (i18n) ────────────────────────────────────────────────────────
    this.locale = new Locale();
    this.locale.load();

    this.dashboard = new Dashboard(this, {
      enabled: config.dashboard?.enabled,
      redis: config.dashboard?.redis,
      mysql: config.mysql,
    });

    const presenceContents = config.presenceContents ?? [];
    const presenceInterval = config.presenceInterval ?? 30_000;

    // ── Timers config ─────────────────────────────────────────────────────────
    const timers = config.timers ?? {};
    this.T = {
      aloneCheckInterval:  timers.aloneCheckInterval  ?? 30_000,
      aloneCheckDebounce:  timers.aloneCheckDebounce  ?? 500,
      rejoin247Delay:      timers.rejoin247Delay       ?? 3_000,
      leave247RejoinDelay: timers.leave247RejoinDelay  ?? 5_000,
      intentionalLeaveTTL: timers.intentionalLeaveTTL  ?? 10_000,
    };

    // ── Fluxer Client ────────────────────────────────────────────────────────
    const client = new Client({
      intents: config["fluxer.js"]?.intents ?? 0,
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

    // ── Message & Settings handlers ──────────────────────────────────────────
    const messages = new MessageHandler(this.client);
    this.messages  = messages;

    const settings    = new RemoteSettingsManager(config.mysql, "./storage/defaults.json");
    this.settingsMgr  = settings;

    this.locale.bind(this.settingsMgr);

    // ── Command handler ──────────────────────────────────────────────────────
    const commands = new CommandHandler(messages);
    this.handler   = commands;

    commands.setPrefixManager(new PrefixManager(settings));
    commands.setLocale(this.locale);
    messages.setLocale(this.locale);

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

    // ── MoonlinkManager (placeholder) ───────────────────────────────────────
    this.moonlink = null;
    let moonlinkInitialised = false;

    // ── Voice state tracking maps (created early so all modules can reference) ──
    this.observedVoiceUsers = new Map();
    this.observedVoiceBots  = new Map();

    // ── Caches ───────────────────────────────────────────────────────────────
    this._announcementChannelCache = new Map();
    this.intentionalLeaves = new Map();

    // ── Recovery Manager ────────────────────────────────────────────────────
    // Handles session persistence, boot recovery, 24/7 auto-join, and player
    // spawning with concurrency control.
    this.recoveryManager = new RecoveryManager(this);

    // ── Gateway Handler ─────────────────────────────────────────────────────
    // Handles raw WS gateway events, voice-state tracking, presence rotation,
    // and high-level Fluxer event handlers (GuildCreate, GuildDelete,
    // VoiceStateUpdate).
    this.gatewayHandler = new GatewayHandler(this, this.recoveryManager);

    // Give RecoveryManager a back-reference to GatewayHandler so it can call
    // reseedVoiceStatesForChannel() after spawning a player.
    this.recoveryManager.gatewayHandler = this.gatewayHandler;

    // Register GuildCreate, GuildDelete, VoiceStateUpdate handlers now so they
    // are active before the first Ready event fires.
    this.gatewayHandler.setupEventHandlers();

    // ── Settings ready callback ──────────────────────────────────────────────
    settings.on("ready", () => {
      initLogger(config);
      logger.settings("[settings] Loaded from DB.");
      for (const [guildId, serverSettings] of settings.guilds) {
        const val = serverSettings.get("stay_247");
        if (!val || val === "none") continue;
        // ── Sanitise stay_247 values ────────────────────────────────────────
        // Strip any value that isn't a valid Fluxer ID (>= 15 digits).
        // This catches corruption from old JSON_SET paths or bad data.
        const rawArr = Array.isArray(val) ? val : [val];
        const cleaned = rawArr
            .map(id => String(id).replace(/\D/g, ""))
            .filter(id => id.length >= 15 && id.length <= 22);
        const needsSave = JSON.stringify(cleaned) !== JSON.stringify(val);
        if (needsSave || !Array.isArray(val)) {
          const newVal = cleaned.length > 0 ? cleaned : "none";
          serverSettings.set("stay_247", newVal);
          if (cleaned.length === 0 && (val && val !== "none")) {
            serverSettings.set("stay_247_mode", "off");
          }
          logger.settings(
            `[settings] Cleaned stay_247 for guild ${guildId}: ${JSON.stringify(val)} → ${JSON.stringify(newVal)}`
          );
        }

        // ── Migrate guild-wide stay_247_mode → per-channel stay_247_modes ──
        // If stay_247_modes doesn't exist yet but stay_247_mode does, create
        // the per-channel map from the guild-wide mode so all channels inherit
        // the same mode (backward compatible).
        const modesMap = serverSettings.get("stay_247_modes");
        if (!modesMap || typeof modesMap !== "object") {
          const guildMode = serverSettings.get("stay_247_mode") ?? "off";
          if (guildMode && guildMode !== "off" && cleaned.length > 0) {
            const newModes = {};
            for (const chId of cleaned) {
              newModes[chId] = guildMode;
            }
            serverSettings.set("stay_247_modes", newModes);
            logger.settings(
              `[settings] Migrated stay_247_mode → stay_247_modes for guild ${guildId}: ${guildMode} → ${JSON.stringify(newModes)}`
            );
          }
        }
      }
      this.recoveryManager.settingsReady = true;
      this.recoveryManager.tryAutoJoin();
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

      // MoonlinkManager initialisation — stays here because it's audio
      // infrastructure, not gateway handling.  The guard prevents stacking
      // listeners on reconnect.
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
        logger.moonlink("[Moonlink] Reconnected — re-initialising node session.");
        try {
          await this.moonlink.init(botId);
        } catch (e) {
          logger.error("[Moonlink] Re-init failed:", e.message);
        }
      }

      // Delegate remaining Ready work to the gateway handler (voice-state
      // seeding, raw WS listener, presence rotation, tryAutoJoin).
      this.gatewayHandler.onReady();
    });

    // ── Player Manager ───────────────────────────────────────────────────────
    this.playerContext = {
      client:   this.client,
      config,
      nodelink: config.nodelink,
      moonlink: null,
    };
    this.players = new PlayerManager(settings, commands, {
      config,
      player: this.playerContext,
      dashboard: this.dashboard,
      locale: this.locale,
      spawnPlayer: this._spawnPlayer,
      timers: this.T,
    });
    this.players.observedVoiceUsers = this.observedVoiceUsers;

    // ── Periodic alone-check ───────────────────────────────────────────────────
    const ALONE_CHECK_INTERVAL = this.T.aloneCheckInterval;
    setInterval(() => {
      for (const [mapKey, player] of this.players.playerMap) {
        try {
          const guildId = player._guildId;
          if (!guildId) continue;

          if (player._isJoining || player._isRecovering) continue;

          const channelId   = player._channelId ?? mapKey;
          const cleanChanId = String(channelId).replace(/\D/g, "");
          if (!cleanChanId) continue;

          const cleanGuildId = String(guildId).replace(/\D/g, "");
          const channelGuildId = String(
              this.client?.channels?.get?.(channelId)?.guildId ??
              this.client?.channels?.get?.(channelId)?.guild_id ??
              ""
          ).replace(/\D/g, "");
          if (channelGuildId && channelGuildId !== cleanGuildId) {
            logger.warn(`[AloneCheck] Skipping inconsistent player state channel=${channelId} playerGuild=${guildId} channelGuild=${channelGuildId}`);
            continue;
          }

          if (player._is247Enabled()) continue;

          let hasHuman = false;
          for (const [, info] of this.observedVoiceUsers) {
            const infoChannel = String(info.channelId ?? "").replace(/\D/g, "");
            const infoGuild   = String(info.guildId   ?? "").replace(/\D/g, "");
            if (infoGuild === cleanGuildId && infoChannel === cleanChanId) {
              hasHuman = true;
              break;
            }
          }

          // Fallback: check guild voice_states cache if observedVoiceUsers
          // didn't find anyone (can happen after bot restart before reseed).
          if (!hasHuman) {
            try {
              const guild = this.client?.guilds?.get?.(cleanGuildId);
              const voiceStates = guild?.voice_states ?? guild?.voiceStates;
              if (voiceStates) {
                const entries = Array.isArray(voiceStates)
                    ? voiceStates
                    : typeof voiceStates.values === "function"
                        ? [...voiceStates.values()]
                        : Object.values(voiceStates);
                for (const state of entries) {
                  const stateChannel = String(state?.channelId ?? state?.channel_id ?? "").replace(/\D/g, "");
                  if (stateChannel === cleanChanId) {
                    const stateUserId = state?.userId ?? state?.user_id ?? state?.id;
                    const member = guild?.members?.get?.(stateUserId);
                    const isBot = member?.user?.bot ?? state?.member?.user?.bot ?? false;
                    if (!isBot) {
                      hasHuman = true;
                      // Also update observedVoiceUsers so future checks are fast
                      if (stateUserId) {
                        this.observedVoiceUsers.set(stateUserId, { channelId: cleanChanId, guildId: cleanGuildId });
                      }
                      break;
                    }
                  }
                }
              }
            } catch (_) {}
          }

          logger.aloneCheck(`[AloneCheck] channel=${channelId} guild=${guildId} hasHuman=${hasHuman} paused=${player._paused}`);

          if (!hasHuman && !player._paused) {
            if (player.queue?.getCurrent() || !player.queue?.isEmpty()) {
              logger.aloneCheck(`[AloneCheck] Bot alone in ${channelId} (guild ${guildId}) with songs in queue — starting inactivity timer.`);
              player._startInactivityTimer?.();
            } else {
              logger.aloneCheck(`[AloneCheck] Bot alone in ${channelId} (guild ${guildId}), leaving.`);
              player._stopInactivityTimer?.();
              player.emit("autoleave");
            }
          } else if (hasHuman) {
            player._stopInactivityTimer?.();
          }
        } catch (e) {
          logger.warn("[AloneCheck] Error checking channel", channelId, e.message);
        }
      }
    }, ALONE_CHECK_INTERVAL);

    // ── Voice channel detection ──────────────────────────────────────────────
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

      logger.voice(`[checkVC] userId=${userId} guildId=${guildId}`);
      logger.voice(`[checkVC] channel keys: ${Object.keys(message?.channel ?? {}).join(",")}`);
      logger.voice(`[checkVC] observedVoiceUsers size=${self.observedVoiceUsers.size}`);
      for (const [uid, info] of self.observedVoiceUsers) {
        logger.voice(`[checkVC]   stored: uid=${uid} channelId=${info.channelId} guildId=${info.guildId}`);
      }

      if (!userId || !guildId) {
        logger.voice(`[checkVC] BAIL — missing userId or guildId`);
        return null;
      }

      const cleanGuild = String(guildId).replace(/\D/g, "");

      const seed = (channelId) => {
        if (!self.observedVoiceUsers.has(userId)) {
          self.observedVoiceUsers.set(userId, { channelId, guildId: cleanGuild });
        }
        return self.observedVoiceUsers.get(userId)?.channelId ?? channelId;
      };

      const observed = self.observedVoiceUsers.get(userId);
      logger.voice(`[checkVC] observed=${JSON.stringify(observed)} cleanGuild=${cleanGuild}`);
      if (observed && String(observed.guildId).replace(/\D/g, "") === cleanGuild) {
        logger.voice(`[checkVC] HIT observedVoiceUsers → ${observed.channelId}`);
        return observed.channelId;
      }

      try {
        const vm        = getVoiceManager(client);
        const channelId = vm?.getVoiceChannelId?.(guildId, userId);
        logger.voice(`[checkVC] vm.getVoiceChannelId → ${channelId}`);
        if (channelId) return seed(channelId);
      } catch (e) { logger.voice(`[checkVC] vm error: ${e.message}`); }

      const memberVoice =
          message?.member?.voice?.channelId ??
          message?.message?.member?.voice?.channelId ??
          null;
      logger.voice(`[checkVC] memberVoice=${memberVoice}`);
      if (memberVoice) return seed(memberVoice);

      try {
        const guild = client.guilds.get(guildId) ?? client.guilds.get(cleanGuild);
        logger.voice(`[checkVC] guild=${guild?.id ?? guild?._id ?? "null"}`);
        const voiceStates = guild?.voice_states ?? guild?.voiceStates ?? null;
        logger.voice(`[checkVC] voiceStates=${Array.isArray(voiceStates) ? "array["+voiceStates.length+"]" : typeof voiceStates}`);
        if (voiceStates) {
          if (!Array.isArray(voiceStates) && typeof voiceStates === "object") {
            const direct = voiceStates[userId];
            logger.voice(`[checkVC] direct lookup voiceStates[userId]=${JSON.stringify(direct)}`);
            if (direct) {
              const sch = typeof direct === "string" ? direct
                  : direct?.channelId ?? direct?.channel_id ?? null;
              if (sch) { logger.voice(`[checkVC] HIT direct obj lookup → ${sch}`); return seed(sch); }
            }
            const firstKey = Object.keys(voiceStates)[0];
            if (firstKey) {
              logger.voice(`[checkVC] shape sample: key=${firstKey} val=${JSON.stringify(voiceStates[firstKey])}`);
            }
          }
          const entries = Array.isArray(voiceStates)
              ? voiceStates
              : typeof voiceStates.values === "function"
                  ? voiceStates.values()
                  : Object.values(voiceStates);
          for (const state of entries) {
            const sid  = state?.userId ?? state?.user_id ?? state?.id;
            const sch  = state?.channelId ?? state?.channel_id;
            const sgid = String(state?.guildId ?? state?.guild_id ?? guildId).replace(/\D/g, "");
            logger.voice(`[checkVC]   state: sid=${sid} sch=${sch} sgid=${sgid}`);
            if (sid === userId && sgid === cleanGuild && sch) {
              logger.voice(`[checkVC] HIT guild.voice_states iterate → ${sch}`);
              return seed(sch);
            }
          }
        }
      } catch (e) { logger.voice(`[checkVC] guild error: ${e.message}`); }

      try {
        for (const [uid, info] of self.observedVoiceUsers) {
          if (uid !== userId) continue;
          logger.voice(`[checkVC] last-resort: uid=${uid} stored.guildId=${info.guildId} cleanGuild=${cleanGuild}`);
          if (String(info.guildId).replace(/\D/g, "") === cleanGuild) {
            logger.voice(`[checkVC] HIT last-resort → ${info.channelId}`);
            return info.channelId;
          }
        }
      } catch (e) { logger.voice(`[checkVC] last-resort error: ${e.message}`); }

      logger.voice(`[checkVC] MISS — returning null`);
      return null;
    };

    this.comLink = "https://github.com/remix-bot/fluxer/commit/" + (this.comHashLong ?? "");

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
    Promise.allSettled(this.modules.map(async m => {
      if (!m.enabled) return;
      try {
        const exported = await import(m.index);
        const ModClass = exported.default;
        this.loadedModules.set(m.name, { instance: new ModClass(this), c: ModClass });
      } catch (e) {
        logger.error(`[Module] Failed to load "${m.name}":`, e.message);
      }
    }))
        .then(results => {
          const succeeded = results.filter(r => r.status === "fulfilled").length;
          const failed = results.filter(r => r.status === "rejected").length;
          logger.commands(`Modules loaded (${succeeded} succeeded, ${failed} failed).`);
        });

    // ── Git commit hash ───────────────────────────────────────────────────────
    try {
      this.comHash     = childProcess.execSync("git rev-parse --short HEAD", { cwd: __dirname, timeout: 3000 }).toString().trim();
      this.comHashLong = childProcess.execSync("git rev-parse HEAD",         { cwd: __dirname, timeout: 3000 }).toString().trim();
    } catch {
      logger.warn("[Git] comhash error");
      this.comHash     = "Newest";
      this.comHashLong = null;
    }

    // ── Login ─────────────────────────────────────────────────────────────────
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

  /** @param {import("./src/MessageHandler.mjs").Message} message */
  getSettings(message) {
    const guildId = message?.channel?.channel?.guildId ?? message?.guildId ?? null;
    return this.settingsMgr.getServer(guildId);
  }

  /**
   * Translate a key for the guild of the given message.
   * @param {import("./src/MessageHandler.mjs").Message} message
   * @param {string} key
   * @param {Object} [data={}]
   * @returns {string}
   */
  t(message, key, data = {}) {
    const guildId = message?.channel?.channel?.guildId
        ?? message?.message?.guildId
        ?? message?.guildId
        ?? null;
    return this.locale.translate(guildId, key, data);
  }

  getPlayer(message, promptJoin, verifyUser, shouldJoin) {
    return this.players.getPlayer(message, promptJoin, verifyUser, shouldJoin);
  }

  /**
   * Return all guilds the given user shares with this bot.
   * No longer gated behind settingsMgr — works with or without MySQL.
   * Uses cached members first, falls back to observedVoiceUsers, then
   * an async REST fetch for large guilds where the member cache is incomplete.
   *
   * @param {import("@fluxerjs/core").User} user
   * @returns {Promise<Array<{name:string,id:string,icon:string|null,voiceChannels:Array}>>}
   */
  async getSharedServers(user) {
    if (!user) return [];

    const shared = [];

    for (const guild of this.client.guilds.values()) {
      let isMember = false;

      // 1. Fast path — check cached members
      if (guild.members?.has?.(user.id)) {
        isMember = true;
      }

      // 2. Fallback — observed voice users (REST-less)
      if (!isMember) {
        const cleanGuildId = String(guild.id).replace(/\D/g, "");
        for (const [, info] of (this.observedVoiceUsers ?? [])) {
          if (String(info.guildId ?? "").replace(/\D/g, "") === cleanGuildId) {
            isMember = true;
            break;
          }
        }
      }

      // 3. Slow path — REST fetch for large guilds with incomplete caches
      if (!isMember) {
        try {
          const member = await guild.members.fetch(user.id).catch(() => null);
          if (member) isMember = true;
        } catch (_) { /* not a member or fetch failed */ }
      }

      if (!isMember) continue;

      shared.push({
        name:   guild.name,
        id:     guild.id,
        icon:   guild.icon
            ? `https://cdn.fluxer.app/icons/${guild.id}/${guild.icon}.webp`
            : null,
        description: guild.description ?? null,
        ownerId: guild.ownerId ?? null,
        voiceChannels: guild.channels
            .filter(c => c.isVoiceBased?.() ?? false)
            .map(c => {
              // Build voice participants list for this channel
              const voiceParticipants = [];
              if (guild.voice_states) {
                const vs = Array.isArray(guild.voice_states) ? guild.voice_states :
                    typeof guild.voice_states.values === "function" ? [...guild.voice_states.values()] : Object.values(guild.voice_states);
                for (const state of vs) {
                  const scId = String(state?.channelId ?? state?.channel_id ?? "").replace(/\D/g, "");
                  const chId = String(c.id ?? "").replace(/\D/g, "");
                  if (scId === chId) {
                    const member = guild.members?.get?.(state?.userId ?? state?.user_id);
                    if (member?.user && !member.user.bot) {
                      voiceParticipants.push(Dashboard.convertUser(member.user));
                    }
                  }
                }
              }
              return {
                name: c.name,
                displayName: c.name,
                id: c.id,
                icon: null,
                description: c.topic ?? null,
                isVoice: true,
                mature: c.nsfw ?? false,
                serverId: guild.id,
                voiceParticipants,
              };
            }),
      });
    }

    return shared;
  }

  pagination(form, content, msg, linesPerPage) {
    this.messages.initPagination(
        new PageBuilder(content).setForm(form).setMaxLines(linesPerPage),
        msg
    );
  }

  buildRecoveryState() {
    return this._buildRecoveryState?.() ?? [];
  }

  writeRecoveryState(state, sourceLabel = "Recovery") {
    return this._writeRecoveryState?.(state, sourceLabel) ?? false;
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

const remix = new Remix();

// ── Error handling ────────────────────────────────────────────────────────────

const isIgnorableWsCrash = (err) => {
  const message = String(err?.message ?? err ?? "");
  const stack = String(err?.stack ?? "");
  return message === "WebSocket error" &&
      (
        stack.includes("@fluxerjs/ws/dist/index.mjs") ||
        stack.includes("node:internal/deps/undici/undici")
      );
};

process.on("unhandledRejection", (reason, p) => {
  if (reason?.message?.includes("AudioSource is closed")) return;
  logger.error("[Error_Handling] Unhandled Rejection/Catch");
  logger.error("Reason:", reason, p);
});
process.on("uncaughtException", (err, origin) => {
  if (isIgnorableWsCrash(err)) {
    logger.warn("[Error_Handling] Suppressed recoverable websocket transport crash.");
    logger.warn("Error:", err?.stack ?? err, origin);
    return;
  }
  logger.error("[Error_Handling] Uncaught Exception/Catch");
  logger.error("Error:", err, origin);
  try {
    const state = remix.buildRecoveryState();
    remix.writeRecoveryState(state, "Shutdown/Crash");
  } catch (_) {}
  process.exit(1);
});
process.on("uncaughtExceptionMonitor", (err, origin) => {
  logger.error("[Error_Handling] Uncaught Exception/Catch (MONITOR)");
  logger.error("Error:", err, origin);
});

// ── Session Reboot Recovery Hooks ───────────────────────────────────────────
const saveAndExit = async () => {
  logger.recovery("\n[Shutdown] Saving active sessions for reboot recovery...");
  try {
    const state = remix.buildRecoveryState();
    remix.writeRecoveryState(state, "Shutdown");
  } catch (e) {
    logger.error("[Shutdown] Failed to save recovery state:", e.message);
  }
  try {
    if (remix.dashboard?.redis?.destroy) {
      await remix.dashboard.redis.destroy();
    }
  } catch (e) {
    logger.error("[Shutdown] Failed to close Redis:", e.message);
  }
  try {
    if (remix.dashboard?.db?.close) {
      await remix.dashboard.db.close();
    }
  } catch (e) {
    logger.error("[Shutdown] Failed to close Dashboard DB:", e.message);
  }
  process.exit(0);
};

process.once("SIGINT",  saveAndExit);
process.once("SIGTERM", saveAndExit);
process.once("SIGUSR2", saveAndExit);

// ── SIGPIPE handler ──────────────────────────────────────────────────────────
// On some systems, writing to a broken pipe (e.g. Redis connection) raises
// SIGPIPE which defaults to terminating the process. Ignoring it lets the
// error surface through the normal exception/rejection handlers above so
// recovery state is saved before exit.
process.on("SIGPIPE", () => {});
