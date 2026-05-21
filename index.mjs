import * as fs from "fs";
import path from "path";
import { initLogger, logger } from "./src/constants/Logger.mjs";
import { Client, Events, EmbedBuilder } from "@fluxerjs/core";
import { get247ChannelMode, remove247ChannelMode } from "./src/constants/Helpers247.mjs";
import { CommandHandler, CommandLoader, PrefixManager } from "./src/CommandHandler.mjs";
import { MessageHandler, PageBuilder, HelpCommand, setGlobalColor, getGlobalColor } from "./src/MessageHandler.mjs";
import { RemoteSettingsManager } from "./src/Settings.mjs";
import { PlayerManager } from "./src/PlayerManager.mjs";
import childProcess from "node:child_process";
import { getVoiceManager } from "@fluxerjs/voice";
import { FluxerRevoice } from "./src/constants/FluxerRevoice.mjs";
import { MoonlinkManager } from "./src/MoonlinkManager.mjs";
import { Dashboard } from "./src/dashboard/Dashboard.mjs";
import { Locale } from "./src/constants/Locale.mjs";
import { VoiceStateCache } from "./src/constants/VoiceStateCache.mjs";
import { GatewayHandler } from "./src/GatewayHandler.mjs";
import { LastFmManager } from "./src/LastFmManager.mjs";
import { FluxerListManager } from "./src/FluxerListManager.mjs";
import { TrackOptionsManager } from "./src/TrackOptionsManager.mjs";

/**
 * Create a backward-compatible "bot view" wrapper around VoiceStateCache.
 *
 * The old code used separate Maps for observedVoiceUsers and observedVoiceBots.
 * VoiceStateCache merged both into one object, but the default iterator/size
 * only exposes human users.  This wrapper provides the Map-like interface that
 * iterates BOT entries instead, so code that does `for (const [k, v] of observedVoiceBots)`
 * still gets bot data, not human data.
 */
function createBotView(voiceCache) {
  return {
    get size()            { return voiceCache.botLocations.size; },
    get(key)              { return voiceCache.botLocations.get(key); },
    set(key, val)         { voiceCache.setBotUser(key, val); },
    has(key)              { return voiceCache.botLocations.has(key); },
    delete(key)           { voiceCache.deleteBotUser(key); },
    forEach(fn)           { for (const [k, v] of voiceCache.iterateBotUsers()) fn(v, k, this); },
    *[Symbol.iterator]()  { yield* voiceCache.iterateBotUsers(); },
    *entries()            { yield* voiceCache.iterateBotUsers(); },
    *keys()               { for (const [k] of voiceCache.iterateBotUsers()) yield k; },
    *values()             { for (const [, v] of voiceCache.iterateBotUsers()) yield v; },
    get observedVoiceBotsSize() { return voiceCache.botLocations.size; },
  };
}

/** Helper — build a plain embed payload from a description string */
function mkEmbed(desc) {
  return { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(desc)] };
}

export class Remix {
  constructor() {
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

    setGlobalColor(config.embedColor);

    this.locale = new Locale();
    this.locale.load();

    this.dashboard = new Dashboard(this, {
      enabled: config.dashboard?.enabled,
      redis: config.dashboard?.redis,
      mysql: config.mysql,
    });

    const presenceContents = config.presenceContents ?? [];
    const presenceInterval = config.presenceInterval ?? 30_000;

    const timers = config.timers ?? {};
    this.T = {
      aloneCheckInterval:  timers.aloneCheckInterval  ?? 30_000,
      aloneCheckDebounce:  timers.aloneCheckDebounce  ?? 500,
      rejoin247Delay:      timers.rejoin247Delay       ?? 3_000,
      leave247RejoinDelay: timers.leave247RejoinDelay  ?? 5_000,
      intentionalLeaveTTL: timers.intentionalLeaveTTL  ?? 10_000,
    };

    const client = new Client({
      intents: 0,
      suppressIntentWarning: true,
      waitForGuilds: true,
      ...config["fluxer.js"],
      presence: (() => {
        if (presenceContents.length === 0) return undefined;
        const entry = presenceContents[0];
        const isObj = typeof entry === "object" && entry !== null;

        const custom_status = {};
        if (isObj) {
          if (entry.text)       custom_status.text       = entry.text;
          if (entry.emoji_name) custom_status.emoji_name  = entry.emoji_name;
          if (entry.emoji_id)   custom_status.emoji_id    = entry.emoji_id;
        } else {
          custom_status.text = String(entry);
        }

        const p = {
          status:        "online",
          mobile:        false,
          afk:           false,
          custom_status,
        };

        if (isObj && entry.activity) {
          p.activities = [{
            name: entry.activity.name ?? "music",
            type: entry.activity.type ?? 0,
            url:  entry.activity.url  ?? undefined,
          }];
        }

        return p;
      })(),
    });

    client.setMaxListeners(50);
    this.client = client;

    try {
      getVoiceManager(client);
      logger.player("[Startup] VoiceManager initialized before login.");
    } catch (e) {
      logger.warn("[Startup] VoiceManager pre-login init failed:", e.message);
    }

    const messages = new MessageHandler(this.client);
    this.messages  = messages;

    const settings    = new RemoteSettingsManager(config.mysql, "./storage/defaults.json");
    this.settingsMgr  = settings;

    const configPrefix = config.prefix ?? null;
    if (configPrefix && settings.defaults) {
      settings.defaults.prefix = configPrefix;
    }

    this.locale.bind(this.settingsMgr);

    const commands = new CommandHandler(messages, configPrefix);
    this.handler   = commands;

    const prefixMgr = new PrefixManager(settings, configPrefix);
    commands.setPrefixManager(prefixMgr);
    commands.setLocale(this.locale);
    messages.setLocale(this.locale);

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

    this.moonlink = null;
    let moonlinkInitialised = false;

    this.voiceCache = new VoiceStateCache({ maxUsers: 50_000, maxBots: 10_000 });

    this.observedVoiceUsers = this.voiceCache;
    this.observedVoiceBots  = createBotView(this.voiceCache);

    this._announcementChannelCache = new Map();
    this._announcementChannelTTL  = 5 * 60 * 1000;
    setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this._announcementChannelCache) {
        if (v.timestamp && now - v.timestamp > this._announcementChannelTTL) this._announcementChannelCache.delete(k);
      }
    }, 60_000);
    this.intentionalLeaves = new Map();

    this.gatewayHandler = new GatewayHandler(this);

    this.gatewayHandler.setupEventHandlers();

    this.lastfm = new LastFmManager(config.lastfm, config.mysql);

    this.fluxerlist = new FluxerListManager(config.fluxerlist);

    this.trackOptions = new TrackOptionsManager(config.mysql);

    settings.on("ready", () => {
      initLogger(config);
      logger.settings("[settings] Loaded from DB.");
      for (const [guildId, serverSettings] of settings.guilds) {
        const val = serverSettings.get("stay_247");
        if (!val || val === "none") continue;
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

    });

    client.on(Events.Ready, async () => {
      try {
      logger.player("Logged in as " + (client.user?.username ?? "bot"));

      this._attachWsErrorHandlers();

      const botId = client.user?.id ?? "0";

      await this.settingsMgr.setBotId(botId);
      await this.lastfm.setBotId(botId);
      this.dashboard.setBotId(botId);
      this.trackOptions.setBotId(botId);

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

      this.gatewayHandler.onReady();
      } catch (e) {
        logger.error("[Ready] Fatal error in Ready handler:", e);
      }
    });

    this.revoice = FluxerRevoice.getInstance(client);

    this.playerContext = {
      client:   this.client,
      config,
      nodelink: config.nodelink,
      moonlink: null,
      revoice:  this.revoice,
    };
    this.players = new PlayerManager(settings, commands, {
      config,
      player: this.playerContext,
      dashboard: this.dashboard,
      locale: this.locale,
      timers: this.T,
      trackOptions: this.trackOptions,
    });
    this.players.observedVoiceUsers = this.observedVoiceUsers;
    this.players.voiceCache = this.voiceCache;
    this.players._lastfm = this.lastfm;

    const ALONE_CHECK_INTERVAL = this.T.aloneCheckInterval;
    setInterval(() => {
      for (const [mapKey, player] of this.players.playerMap) {
        let channelId;
        try {
          const guildId = player._guildId;
          if (!guildId) continue;

          if (player._isJoining) continue;

          channelId   = player._channelId ?? mapKey;
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

          let hasHuman = this.voiceCache.hasHumansInChannel(cleanGuildId, cleanChanId);

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
                      if (stateUserId) {
                        this.voiceCache.updateUser({ guildId: cleanGuildId, userId: stateUserId, channelId: cleanChanId, isBot: false });
                      }
                      break;
                    }
                  }
                }
              }
            } catch (_) {}
          }

          if (!hasHuman) {
            try {
              const room = player.connection?.room;
              if (room?.isConnected && room.remoteParticipants && room.remoteParticipants.size > 0) {
                hasHuman = true;
                logger.aloneCheck(`[AloneCheck] Found ${room.remoteParticipants.size} LiveKit remote participant(s) in ${channelId}`);
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

    const self = this;
    this.players.checkVoiceChannels = function (message) {
      const userId  = message?.author?.id   ?? message?.message?.author?.id;
      const guildId =
          message?.channel?.guildId ??
          message?.channel?.guild?.id ??
          message?.channel?.server_id ??
          message?.channel?.serverId ??
          message?.message?.guildId ??
          message?.message?.guild?.id ??
          message?.message?.channel?.guildId ??
          message?.message?.channel?.guild?.id ??
          message?.message?.channel?.server_id ??
          message?.message?.channel?.serverId;

      logger.voice(`[checkVC] userId=${userId} guildId=${guildId}`);
      logger.voice(`[checkVC] channel keys: ${Object.keys(message?.channel ?? {}).join(",")}`);
      logger.voice(`[checkVC] voiceCache humans=${self.voiceCache.observedVoiceUsersSize} bots=${self.voiceCache.observedVoiceBotsSize}`);

      if (!userId || !guildId) {
        logger.voice(`[checkVC] BAIL — missing userId or guildId`);
        return null;
      }

      const cleanGuild = String(guildId).replace(/\D/g, "");

      const seed = (channelId) => {
        if (!self.voiceCache.hasHumanUser(userId, cleanGuild)) {
          self.voiceCache.updateUser({ guildId: cleanGuild, userId, channelId, isBot: false });
        }
        return self.voiceCache.getUserChannel(cleanGuild, userId) ?? channelId;
      };

      const observed = self.voiceCache.getUserLocation(cleanGuild, userId);
      logger.voice(`[checkVC] observed=${JSON.stringify(observed)} cleanGuild=${cleanGuild}`);
      if (observed && observed.channelId) {
        logger.voice(`[checkVC] HIT voiceCache → ${observed.channelId}`);
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
        const loc = self.voiceCache.getHumanUser(userId);
        if (loc && String(loc.guildId ?? "").replace(/\D/g, "") === cleanGuild) {
          logger.voice(`[checkVC] HIT voiceCache scan → ${loc.channelId}`);
          return loc.channelId;
        }
      } catch (e) { logger.voice(`[checkVC] last-resort error: ${e.message}`); }

      logger.voice(`[checkVC] MISS — returning null`);
      return null;
    };

    const __dirname = import.meta.dirname;
    try {
      this.comHash     = childProcess.execSync("git rev-parse --short HEAD", { cwd: __dirname, timeout: 3000 }).toString().trim();
      this.comHashLong = childProcess.execSync("git rev-parse HEAD",         { cwd: __dirname, timeout: 3000 }).toString().trim();
    } catch {
      logger.warn("[Git] comhash error");
      this.comHash     = "Newest";
      this.comHashLong = null;
    }

    this.comLink = "https://github.com/remix-bot/fluxer/commit/" + (this.comHashLong ?? "");

    const loader    = new CommandLoader(commands, this);
    const dir       = path.join(__dirname, "commands");
    logger.commands("Started loading commands.");
    loader.loadFromDir(dir)
        .then(() => logger.commands("Commands loaded."))
        .catch(e => logger.error("Failed to load commands:", e));

    logger.commands("Loading Modules.");
    this.loadedModules = new Map();
    try {
      this.modules = JSON.parse(fs.readFileSync("./storage/modules.json"));
    } catch (e) {
      const reason = e.code === "ENOENT"
          ? "storage/modules.json not found."
          : `storage/modules.json is malformed JSON: ${e.message}`;
      console.error(`[Startup] WARN: ${reason} — starting with no modules.`);
      this.modules = [];
    }
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

    client.login(config.token).catch(e => {
      logger.error("[Startup] Login failed:", e.message);
      process.exit(1);
    });
  }

  /**
   * Attach error handlers on all @fluxerjs/ws shard WebSockets.
   *
   * When the Fluxer gateway's underlying WebSocket closes (e.g. network
   * blip, server restart), @fluxerjs/ws throws a "WebSocket error" from
   * its internal error handler.  Without an .on("error") listener on the
   * WS object itself, this escalates to Node's uncaughtException handler,
   * producing a noisy stack trace even though the bot recovers
   * automatically via gateway reconnection.
   *
   * By attaching .on("error") handlers here, we catch the error at the
   * source, log a single clean line, and prevent it from reaching
   * uncaughtException.
   */
  _attachWsErrorHandlers() {
    try {
      const wsManager = this.client?.ws;
      if (!wsManager) return;

      const attachToSocket = (wsObj, label) => {
        if (!wsObj) return;
        if (wsObj._fluxerErrorHandled) return;
        wsObj._fluxerErrorHandled = true;

        if (typeof wsObj.on === "function") {
          wsObj.on("error", (err) => {
            logger.warn(`[WS] ${label} transport error (auto-recovering): ${err?.message ?? err}`);
          });
        }
        if (typeof wsObj.addEventListener === "function") {
          wsObj.addEventListener("error", (event) => {
            const err = event?.error ?? event?.message ?? event;
            logger.warn(`[WS] ${label} transport error (auto-recovering): ${err?.message ?? err}`);
          });
        }
      };

      if (wsManager.shards && typeof wsManager.shards.forEach === "function") {
        wsManager.shards.forEach((shard, id) => {
          attachToSocket(shard?.ws, `Shard ${id}`);
        });
      }

      if (wsManager.ws) {
        attachToSocket(wsManager.ws, "Gateway");
      }

      if (typeof wsManager.on === "function" && !wsManager._fluxerErrorHandled) {
        attachToSocket(wsManager, "WSManager");
      }

      if (typeof wsManager.on === "function" && !wsManager._shardCreateHandled) {
        wsManager._shardCreateHandled = true;
        wsManager.on("shardCreate", (shard) => {
          if (shard?.ws) {
            attachToSocket(shard.ws, `Shard ${shard.id ?? "?"}`);
          }
        });
      }

      logger.player("[WS] Proactive error handlers attached to gateway sockets.");
    } catch (e) {
      logger.warn("[WS] Failed to attach WS error handlers:", e.message);
    }
  }

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

  /**
   * Spawn a player for a voice channel without requiring a user message.
   * Used by the 24/7 settings command and the leave command's auto-rejoin.
   *
   * @param {string} guildId   — The guild ID
   * @param {string} channelId — The voice channel ID to join
   * @returns {Promise<Player>} The created player
   */
  async _spawnPlayer(guildId, channelId) {
    const cleanGuildId   = String(guildId).replace(/\D/g, "");
    const cleanChannelId = String(channelId).replace(/\D/g, "");

    if (!cleanChannelId) throw new Error("_spawnPlayer: invalid channelId");

    const existing = this.players.playerMap.get(cleanChannelId)
        ?? this.players.getPlayerByGuildAndChannel(cleanGuildId, cleanChannelId);
    if (existing) return existing;

    if (!this.moonlink) throw new Error("Audio node not ready yet — try again in a moment");

    const channel = this.client?.channels?.get?.(cleanChannelId);
    if (!channel) throw new Error("Channel not found");
    if (channel.type !== 2) throw new Error("Not a voice channel");

    if (this.players._pendingJoins?.has?.(cleanChannelId)) {
      throw new Error("Join already in progress for this channel");
    }

    const Player = (await import("./src/Player.mjs")).default;

    const player = new Player(this.config.token, {
      client:             this.client,
      config:             this.config,
      nodelink:           this.config.nodelink,
      moonlink:           this.moonlink ?? null,
      revoice:            this.revoice ?? null,
      settingsMgr:        this.settingsMgr ?? this.settings ?? null,
      observedVoiceUsers: this.observedVoiceUsers ?? null,
      voiceCache:          this.voiceCache ?? null,
      locale:             this.locale ?? null,
      trackOptions:       this.trackOptions ?? null,
    });

    player._home247Channel = cleanChannelId;

    this.players.setupEvents(player, {
      channelId: cleanChannelId,
      guildId:   cleanGuildId,
    });

    player.on("autoleave", () => {
      const mode = player._get247Mode();
      if (mode === "auto" || mode === "on") {
        logger.inactivity(`[_spawnPlayer] autoleave suppressed for 24/7 ${mode} channel ${cleanChannelId} (guild ${cleanGuildId})`);
        return;
      }
      if (player._hasHumansInChannel()) {
        logger.inactivity(`[_spawnPlayer] autoleave suppressed — humans in channel ${cleanChannelId}`);
        return;
      }
      if (player.queue?.getCurrent() || !player.queue?.isEmpty()) {
        logger.inactivity(`[_spawnPlayer] autoleave suppressed — queue has songs in channel ${cleanChannelId}`);
        return;
      }

      const activeChId = String(player._channelId ?? cleanChannelId).replace(/\D/g, "") || cleanChannelId;
      const homeChId   = String(player._home247Channel ?? activeChId).replace(/\D/g, "") || activeChId;
      this.players.playerMap.delete(activeChId);
      this.players._unindexPlayer?.(cleanGuildId, activeChId);
      const pendingScrobble = this.players._pendingScrobbleTimers?.get(cleanChannelId);
      if (pendingScrobble) { clearTimeout(pendingScrobble.timer); this.players._pendingScrobbleTimers.delete(cleanChannelId); }
      if (activeChId !== cleanChannelId) this.players.playerMap.delete(cleanChannelId);
      if (homeChId !== activeChId) this.players.playerMap.delete(homeChId);
      player.destroy();
    });

    player.on("message", async (m) => {
      try {
        const serverSettings = this.settingsMgr?.getServer?.(cleanGuildId);
        const raw = serverSettings?.get?.("songAnnouncements");
        const disabled = raw === false || raw === 0 ||
            ["false","0","no","off","disable"].includes(String(raw).toLowerCase().trim());
        if (disabled) return;

        let ch = player.textChannel;
        if (!ch || typeof ch.send !== "function") {
          const savedAnnChId = serverSettings?.get?.("announcementChannelId");
          if (savedAnnChId) {
            ch = this.client?.channels?.get?.(String(savedAnnChId).replace(/\D/g, "")) ?? null;
          }
        }
        if (!ch || typeof ch.send !== "function") {
          const guild = this.client?.guilds?.get?.(cleanGuildId);
          if (guild?.systemChannelId) {
            ch = guild.channels?.get?.(guild.systemChannelId) ?? null;
          }
        }
        if (!ch || typeof ch.send !== "function") {
          const guild = this.client?.guilds?.get?.(cleanGuildId);
          if (guild?.channels) {
            for (const c of (guild.channels.values?.() ?? [])) {
              if (c.isTextBased?.() || c.type === 0 || c.type === "GUILD_TEXT") {
                ch = c;
                break;
              }
            }
          }
        }
        if (!ch || typeof ch.send !== "function") return;

        if (!player.textChannel) player.textChannel = ch;

        ch.send(typeof m === "object" && Array.isArray(m.embeds) ? m : mkEmbed(m)).catch(err => {
          if (err.code === 'MISSING_PERMISSIONS' || err.statusCode === 403) {
            logger.warn(`[_spawnPlayer] Cannot send announcement in channel ${ch.id} — missing permissions`);
          }
        });
      } catch (_) {}
    });

    if (this.players._pendingJoins) {
      this.players._pendingJoins.add(cleanChannelId);
    }

    try {
      await player.join(cleanChannelId);

      this.players.playerMap.set(cleanChannelId, player);
      this.players._indexPlayer(cleanGuildId, cleanChannelId);
      if (this.players._pendingJoins) {
        this.players._pendingJoins.delete(cleanChannelId);
      }

      const savedVol = this.settingsMgr?.getServer?.(cleanGuildId)?.get?.("volume");
      if (savedVol !== undefined && savedVol !== null) {
        const vol = Number(savedVol);
        if (!isNaN(vol)) player.setVolume(vol / 100);
      }

      logger.player(`[_spawnPlayer] Spawned player for channel ${cleanChannelId} in guild ${cleanGuildId}`);
      return player;
    } catch (err) {
      if (this.players._pendingJoins) {
        this.players._pendingJoins.delete(cleanChannelId);
      }
      this.players.playerMap.delete(cleanChannelId);
      try { player.destroy(); } catch (_) {}
      logger.warn(`[_spawnPlayer] Failed to spawn player for channel ${cleanChannelId}:`, err.message);
      throw err;
    }
  }

  async leaveChannel(channelId, guildId, message, force = false) {
    const cleanId = String(channelId).replace(/\D/g, "");
    const cleanGuildId = String(guildId).replace(/\D/g, "");
    const set     = this.settingsMgr.getServer(guildId);
    const raw     = set.get("stay_247");

    const channels = (!raw || raw === "none")
        ? new Set()
        : Array.isArray(raw)
            ? new Set(raw.map(id => String(id).replace(/\D/g, "")).filter(Boolean))
            : new Set([String(raw).replace(/\D/g, "")]);

    const channelMode = channels.has(cleanId) ? get247ChannelMode(set, cleanId) : "off";

    if (channels.has(cleanId) && !force) {
      if (channelMode === "auto") {
        if (message) {
          const prefix = (() => { try { return set.get("prefix") ?? "%"; } catch (_) { return "%"; } })();
          const guildIdForLocale = message?.channel?.channel?.guildId ?? message?.guildId ?? cleanGuildId;
          message.replyEmbed(
              this.locale.translate(guildIdForLocale, "responses.leave.autoRejoinHint", {
                channel: cleanId,
                prefix
              })
          );
        }
        return false;
      }
    }

    if (channels.has(cleanId)) {
      channels.delete(cleanId);
      set.set("stay_247", channels.size > 0 ? [...channels] : "none");
      remove247ChannelMode(set, cleanId, channels);
    }

    this.markIntentionalLeave(cleanId);

    const player = this.players.playerMap.get(cleanId);
    if (player) {
      this.players.playerMap.delete(cleanId);
      this.players._unindexPlayer(player._guildId, cleanId);
      const pendingScrobble = this.players._pendingScrobbleTimers?.get(cleanId);
      if (pendingScrobble) { clearTimeout(pendingScrobble.timer); this.players._pendingScrobbleTimers.delete(cleanId); }
      await player.leave().catch(() => {});
      player.destroy();
    }

    if (message) {
      const guildIdForLocale = message?.channel?.channel?.guildId ?? message?.guildId ?? cleanGuildId;
      message.replyEmbed(this.locale.translate(guildIdForLocale, "responses._common.successfullyLeft"));
    }

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

      if (guild.members?.has?.(user.id)) {
        isMember = true;
      }

      if (!isMember) {
        const cleanGuildId = String(guild.id).replace(/\D/g, "");
        const userLoc = this.voiceCache.getUserLocation(cleanGuildId, user.id);
        if (userLoc) isMember = true;
      }

      if (!isMember) {
        try {
          const member = await guild.members.fetch(user.id).catch(() => null);
          if (member) isMember = true;
        } catch (_) { /* not a member or fetch failed */ }
      }

      if (!isMember) continue;

      const allChannels = guild.channels?.cache
        ? [...guild.channels.cache.values()].map(c => Dashboard.convertChannel(c)).filter(c => !c.isCategory)
        : [];
      const channelIds = guild.channels?.cache
        ? [...guild.channels.cache.keys()]
        : [];

      shared.push({
        name:   guild.name,
        id:     guild.id,
        icon:   guild.icon
            ? `https://cdn.fluxer.app/icons/${guild.id}/${guild.icon}.webp`
            : null,
        description: guild.description ?? null,
        ownerId: guild.ownerId ?? null,
        channels: allChannels,
        channelIds: channelIds,
        voiceChannels: allChannels.filter(c => c.isVoice),
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

}

const remix = new Remix();

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
  process.exit(1);
});
process.on("uncaughtExceptionMonitor", (err, origin) => {
  logger.error("[Error_Handling] Uncaught Exception/Catch (MONITOR)");
  logger.error("Error:", err, origin);
});

const saveAndExit = async () => {
  logger.recovery("\n[Shutdown] Cleaning up before exit...");
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

process.on("SIGPIPE", () => {});
