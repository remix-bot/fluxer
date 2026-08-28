/**
 * @module index
 * @description Entry point for the Fluxer music bot. Creates the {@link Remix} instance,
 * sets up process-level error handlers, and registers signal-based graceful shutdown.
 */

import * as fs from "fs";
import path from "path";
import { initLogger, logger, _wsErrorCooldown } from "./src/constants/Logger.mjs";
import { Client, Events, EmbedBuilder } from "@fluxerjs/core";
import { get247ChannelMode, remove247ChannelMode } from "./src/constants/Helpers247.mjs";
import { CommandHandler, CommandLoader, PrefixManager } from "./src/CommandHandler.mjs";
import { MessageHandler, PageBuilder, HelpCommand, setGlobalColor, getGlobalColor } from "./src/MessageHandler.mjs";
import { cleanId } from "./src/Utils.mjs";
import { RemoteSettingsManager } from "./src/Settings.mjs";
import { PlayerManager } from "./src/PlayerManager.mjs";
import childProcess from "node:child_process";
import { getVoiceManager } from "@fluxerjs/voice";
import { LavalinkManager } from "./src/LavalinkManager.mjs";
import { Dashboard } from "./src/dashboard/Dashboard.mjs";
import { Locale } from "./src/constants/Locale.mjs";
import { VoiceStateCache } from "./src/constants/VoiceStateCache.mjs";
import { GatewayHandler } from "./src/GatewayHandler.mjs";
import { LastFmManager } from "./src/LastFmManager.mjs";
import { FluxerListManager } from "./src/FluxerListManager.mjs";
import { TrackOptionsManager } from "./src/TrackOptionsManager.mjs";

/**
 * Create a Map-like view object that proxies bot voice-state lookups
 * through the VoiceStateCache's bot-specific methods.
 * @param {object} voiceCache - The {@link VoiceStateCache} instance.
 * @returns {Map} A Map-like object with `size`, `get`, `set`, `has`, `delete`,
 *   `forEach`, and iterator methods backed by the voice cache.
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


/**
 * @class
 * @description Main bot class. Orchestrates client, settings, players, lavalink,
 * gateway events, commands, and 24/7 voice channel management.
 */
export class Remix {
  /**
   * Bootstrap the entire bot: load config, create Discord client, initialise
   * settings/commands/players/dashboard, set up event handlers, load modules,
   * and log in to Discord.
   */
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

    this.locale = new Locale(typeof config.prefix === "string" && config.prefix ? config.prefix : "%");
    this.locale.load();

    this.dashboard = new Dashboard(this, {
      enabled: config.dashboard?.enabled,
      redis: config.dashboard?.redis,
      mysql: config.mysql,
    });

    const presenceContents = config.presenceContents ?? [];
    const presenceInterval = config.presenceInterval ?? 30_000;

    const buildRuntimePresence = (entry) => {
      const isObj = typeof entry === "object" && entry !== null;
      const customStatus = {};
      if (isObj) {
        if (entry.text)       customStatus.text     = entry.text;
        if (entry.emoji_name) customStatus.emojiName = entry.emoji_name;
        if (entry.emoji_id)   customStatus.emojiId   = entry.emoji_id;
      } else {
        customStatus.text = String(entry);
      }

      const update = { status: "online", afk: false, customStatus };

      if (isObj && entry.activity) {
        update.activities = [{
          name: entry.activity.name ?? "music",
          type: entry.activity.type ?? 0,
          url:  entry.activity.url  ?? undefined,
        }];
      }

      return update;
    };
    let presenceRotationIndex = presenceContents.length > 1 ? 1 : 0;
    let presenceRotationStarted = false;
    let wsHandlerRearmStarted = false;

    const timers = config.timers ?? {};
    this.T = {
      aloneCheckInterval:  timers.aloneCheckInterval  ?? 60_000,
      aloneCheckDebounce:  timers.aloneCheckDebounce  ?? 500,
      rejoin247Delay:      timers.rejoin247Delay       ?? 3_000,
      leave247RejoinDelay: timers.leave247RejoinDelay  ?? 5_000,
      intentionalLeaveTTL: timers.intentionalLeaveTTL  ?? 10_000,
    };

    const client = new Client({
      suppressIntentWarning: true,
      waitForGuilds: true,
      cache: { guilds: false, channels: false, users: false, members: false },
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
    this.locale.setPrefixResolver((guildId) => commands.getPrefix(guildId));

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

    this.lavalink = null;
    let lavalinkInitialised = false;

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
            .map(id => cleanId(id))
            .filter(id => id.length >= 15 && id.length <= 22);

        if (cleaned.length > 1) {
          // Only 1 channel per guild supported. Keep first, drop the rest.
          serverSettings.set("stay_247", cleaned.slice(0, 1));
          logger.settings(
            `[settings] Trimmed stay_247 for guild ${guildId}: had ${cleaned.length} channels, kept first 1.`
          );
          continue;
        }

        const needsSave = JSON.stringify(cleaned) !== JSON.stringify(val);
        if (needsSave || !Array.isArray(val)) {
          const newVal = cleaned.length > 0 ? cleaned : "none";
          serverSettings.set("stay_247", newVal);
          logger.settings(
            `[settings] Cleaned stay_247 for guild ${guildId}: ${JSON.stringify(val)} → ${JSON.stringify(newVal)}`
          );
        }
      }

    });

    client.on(Events.Ready, async () => {
      try {
      logger.player("Logged in as " + (client.user?.username ?? "bot"));

      this._attachWsErrorHandlers();

      if (!wsHandlerRearmStarted) {
        wsHandlerRearmStarted = true;
        setInterval(() => {
          this._attachWsErrorHandlers();
          this.gatewayHandler.attachRawListener();
        }, 5_000).unref?.();
      }

      const botId = client.user?.id ?? "0";

      await this.settingsMgr.setBotId(botId);
      await this.lastfm.setBotId(botId);
      this.dashboard.setBotId(botId);
      this.trackOptions.setBotId(botId);

      if (!lavalinkInitialised) {
        lavalinkInitialised = true;
        this.lavalink = new LavalinkManager(config.nodelink ?? {}, client, { id: botId, username: client.user?.username ?? "bot" });
        this.lavalink.on("ready", () => {
          logger.lavalink("[Lavalink] Session ready");
        });
        await this.lavalink.init();
        this.playerContext.lavalink = this.lavalink;
      }

      this.gatewayHandler.onReady();

      if (!presenceRotationStarted && presenceContents.length > 1) {
        presenceRotationStarted = true;
        setInterval(() => {
          try {
            const entry = presenceContents[presenceRotationIndex % presenceContents.length];
            client.user?.setPresence(buildRuntimePresence(entry));
            presenceRotationIndex = (presenceRotationIndex + 1) % presenceContents.length;
          } catch (e) {
            logger.warn("[Presence] Rotation update failed:", e?.message);
          }
        }, presenceInterval).unref?.();
      }
      } catch (e) {
        logger.error("[Ready] Fatal error in Ready handler:", e);
      }
    });

    client._remix = this;

    this.playerContext = {
      client:   this.client,
      config,
      lavalink: null,
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
      if (this.players.playerMap.size === 0) return;

      for (const [mapKey, player] of this.players.playerMap) {
        let channelId;
        try {
          if (player._destroyed || player._isJoining) continue;

          const guildId = player._guildId;
          if (!guildId) continue;

          channelId   = player._channelId ?? mapKey;
          const cleanChanId = cleanId(channelId);
          if (!cleanChanId) continue;

          const cleanGuildId = cleanId(guildId);

          if (player._is247Enabled()) continue;

          if (!player.connection) continue;

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
                  const stateChannel = cleanId(state?.channelId ?? state?.channel_id);
                  if (stateChannel === cleanChanId) {
                    const stateUserId = state?.userId ?? state?.user_id ?? state?.id;
                    const member = guild?.members?.get?.(stateUserId);
                    const isBot = member?.user?.bot ?? state?.member?.user?.bot ?? false;
                    if (!isBot) {
                      hasHuman = true;
                      break;
                    }
                  }
                }
              }
            } catch(e) { logger.warn("[AloneCheck] Voice state check error:", e?.message); }
          }

          if (!hasHuman) {
            try {
              const room = player.connection?.room;
              if (room?.isConnected && room.remoteParticipants && room.remoteParticipants.size > 0) {
                hasHuman = true;
              }
            } catch(e) { logger.warn("[AloneCheck] LiveKit check error:", e?.message); }
          }

          if (!hasHuman && !player._paused) {
            if (player.queue?.getCurrent() || !player.queue?.isEmpty()) {
              player._startInactivityTimer?.();
            } else {
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

    this.players.checkVoiceChannels = async (message) => {
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

      const _empty = { channelId: null, alreadyInVoice: false, hasHumans: false };

      if (!userId || !guildId) {
        logger.voice(`[checkVC] BAIL — missing userId or guildId`);
        return _empty;
      }

      const cleanGuild = cleanId(guildId);

      const makeResult = (channelId) => {
        const cId = cleanId(channelId);
        return {
          channelId: cId,
          alreadyInVoice: this.players.playerMap.has(cId),
          hasHumans: this.voiceCache.hasHumansInChannel(cleanGuild, cId),
        };
      };

      const seedCache = (channelId) => {
        if (!this.voiceCache.hasHumanUser(userId, cleanGuild)) {
          this.voiceCache.updateUser({ guildId: cleanGuild, userId, channelId, isBot: false });
        }
      };

      logger.voice(`[checkVC] userId=${userId} guildId=${guildId} cleanGuild=${cleanGuild}`);

      const observed = this.voiceCache.getUserLocation(cleanGuild, userId);
      if (observed && observed.channelId) {
        logger.voice(`[checkVC] HIT voiceCache → ${observed.channelId}`);
        return makeResult(observed.channelId);
      }

      try {
        const vm = getVoiceManager(client);
        const channelId = vm?.getVoiceChannelId?.(guildId, userId) ?? vm?.getVoiceChannelId?.(cleanGuild, userId);
        logger.voice(`[checkVC] vm.getVoiceChannelId → ${channelId}`);
        if (channelId) {
          seedCache(channelId);
          return makeResult(channelId);
        }
      } catch (e) { logger.voice(`[checkVC] vm error: ${e.message}`); }

      try {
        const guild = client.guilds.get(guildId) ?? client.guilds.get(cleanGuild);
        const voiceStates = guild?.voice_states ?? guild?.voiceStates ?? null;
        if (voiceStates) {
          const entries = Array.isArray(voiceStates)
              ? voiceStates
              : typeof voiceStates.values === "function"
                  ? [...voiceStates.values()]
                  : Object.values(voiceStates);
          for (const state of entries) {
            const sid = state?.userId ?? state?.user_id ?? state?.id;
            const sch = state?.channelId ?? state?.channel_id;
            if ((sid === userId || sid === cleanId(userId)) && sch) {
              logger.voice(`[checkVC] HIT guild.voice_states → ${sch}`);
              seedCache(sch);
              return makeResult(sch);
            }
          }
        }
      } catch (e) { logger.voice(`[checkVC] guild error: ${e.message}`); }

      try {
        const loc = this.voiceCache.getHumanUser(userId, cleanGuild);
        if (loc && loc.channelId) {
          logger.voice(`[checkVC] HIT voiceCache scan → ${loc.channelId}`);
          return makeResult(loc.channelId);
        }
      } catch (e) { logger.voice(`[checkVC] scan error: ${e.message}`); }

      try {
        const guild = client.guilds.get(guildId) ?? client.guilds.get(cleanGuild);
        if (guild && typeof guild.fetchMember === "function") {
          logger.voice(`[checkVC] Trying REST fetchMember fallback for user ${userId}`);
          const member = await guild.fetchMember(userId);
          const voiceState = member?.voice ?? member?.voiceState ?? null;
          const restChannelId = voiceState?.channelId ?? voiceState?.channel_id ?? null;
          if (restChannelId) {
            logger.voice(`[checkVC] HIT REST member.voice → ${restChannelId}`);
            seedCache(restChannelId);
            return makeResult(restChannelId);
          }
        }
      } catch (e) { logger.voice(`[checkVC] REST fallback error: ${e.message}`); }

      try {
        const guild = client.guilds.get(guildId) ?? client.guilds.get(cleanGuild);
        if (guild && typeof client.rest?.get === "function") {
          logger.voice(`[checkVC] Trying raw REST /guilds/${cleanGuild}/members/${userId}`);
          const memberData = await client.rest.get(`/guilds/${cleanGuild}/members/${userId}`);
          const restChannelId = memberData?.voice_state?.channel_id ?? memberData?.channel_id ?? null;
          if (restChannelId) {
            logger.voice(`[checkVC] HIT raw REST → ${restChannelId}`);
            seedCache(restChannelId);
            return makeResult(restChannelId);
          }
        }
      } catch (e) { logger.voice(`[checkVC] raw REST error: ${e.message}`); }

      logger.voice(`[checkVC] MISS — returning empty`);
      return _empty;
    };

    const __dirname = import.meta.dirname;
    try {
      this.comHash     = childProcess.execSync("git rev-parse --short HEAD", { cwd: __dirname, timeout: 3000 }).toString().trim();
      this.comHashLong = childProcess.execSync("git rev-parse HEAD",         { cwd: __dirname, timeout: 3000 }).toString().trim();
    } catch (e) {
      logger.warn("[Git] comhash error:", e?.message);
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
          const failed = results.length - succeeded;
          logger.commands(`Modules loaded (${succeeded} succeeded, ${failed} failed).`);
        });

    client.login(config.token).catch(e => {
      logger.error("[Startup] Login failed:", e.message);
      process.exit(1);
    });
  }

  /**
   * Attach proactive error handlers to WebSocket sockets/shards to prevent
   * unhandled crashes from WebSocket transport errors. Re-armed periodically.
   * @private
   */
  _attachWsErrorHandlers() {
    try {
      const wsManager = this.client?.ws;
      if (!wsManager) return;

      let attachedNew = false;

      const logWsError = (label, err) => {
        const now = Date.now();
        if (now - _wsErrorCooldown.lastLogged < _wsErrorCooldown.COOLDOWN_MS) return;
        _wsErrorCooldown.lastLogged = now;
        logger.warn(`[WS] ${label} transport error (auto-recovering): ${err?.message ?? err}`);
      };

      const attachToSocket = (wsObj, label) => {
        if (!wsObj) return;
        if (wsObj._fluxerErrorHandled) return;
        wsObj._fluxerErrorHandled = true;
        attachedNew = true;

        if (typeof wsObj.on === "function") {
          wsObj.on("error", (err) => logWsError(label, err));
        }
        if (typeof wsObj.addEventListener === "function") {
          wsObj.addEventListener("error", (event) => {
            if (typeof event.preventDefault === "function") event.preventDefault();
            const err = event?.error ?? event?.message ?? event;
            logWsError(label, err);
          });
        }
      };

      const attachToShard = (shard, id) => {
        if (!shard) return;
        if (shard._fluxerErrorHandled) return;
        shard._fluxerErrorHandled = true;
        attachedNew = true;
        shard.on("error", (err) => logWsError(`Shard ${id}`, err));
        if (shard.ws) attachToSocket(shard.ws, `Shard ${id} socket`);
      };

      if (wsManager.shards && typeof wsManager.shards.forEach === "function") {
        wsManager.shards.forEach((shard, id) => {
          attachToShard(shard, id);
        });
      }

      if (wsManager.ws) {
        attachToSocket(wsManager.ws, "Gateway");
      }

      if (typeof wsManager.on === "function" && !wsManager._fluxerErrorHandled) {
        wsManager._fluxerErrorHandled = true;
        attachedNew = true;
        wsManager.on("error", ({ shardId, error }) => {
          logWsError(`WSManager (shard ${shardId})`, error);
        });
      }

      if (typeof wsManager.on === "function" && !wsManager._shardCreateHandled) {
        wsManager._shardCreateHandled = true;
        attachedNew = true;
        wsManager.on("shardCreate", (shard) => {
          attachToShard(shard, shard.id ?? "?");
        });
      }

      if (attachedNew) {
        logger.player("[WS] Proactive error handlers attached to gateway sockets.");
      }
    } catch (e) {
      logger.warn("[WS] Failed to attach WS error handlers:", e.message);
    }
  }

  /**
   * Mark a channel leave as intentional (user-initiated) to prevent
   * the 24/7 auto-rejoin system from rejoining.
   * @param {string} channelId - The channel ID.
   * @param {number|null} [ttlMs=null] - Time-to-live in ms (default: config.timers.intentionalLeaveTTL or 10s).
   */
  markIntentionalLeave(channelId, ttlMs = null) {
    const cleanChId = cleanId(channelId);
    if (!cleanChId) return;
    if (ttlMs === null) ttlMs = this.config?.timers?.intentionalLeaveTTL ?? 10_000;
    const existing = this.intentionalLeaves.get(cleanChId);
    if (existing) clearTimeout(existing);
    this.intentionalLeaves.set(cleanChId, setTimeout(() => {
      this.intentionalLeaves.delete(cleanChId);
    }, ttlMs));
  }

  /**
   * Spawn a new Player for a channel. Used by 24/7 boot recovery and enable247.
   * Guards against duplicate players, missing channels, and pending joins.
   * @param {string} guildId - The guild ID.
   * @param {string} channelId - The target voice channel ID.
   * @returns {Promise<Player>} The spawned and connected player.
   * @throws {Error} If channel not found, not a voice channel, or join fails.
   */
  async _spawnPlayer(guildId, channelId) {
    const cleanGuildId   = cleanId(guildId);
    const cleanChannelId = cleanId(channelId);

    if (!cleanChannelId) throw new Error("_spawnPlayer: invalid channelId");

    const existing = this.players.playerMap.get(cleanChannelId)
        ?? this.players.getPlayerByGuildAndChannel(cleanGuildId, cleanChannelId);
    if (existing) return existing;

    if (!this.lavalink) throw new Error("Audio node not ready yet — try again in a moment");

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
      lavalink:           this.lavalink ?? null,
      settingsMgr:        this.settingsMgr ?? this.settings ?? null,
      getPrefix:          (guildId) => this.handler.getPrefix(guildId),
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
      if (mode === "on") {
        logger.inactivity(`[_spawnPlayer] autoleave suppressed for 24/7 channel ${cleanChannelId} (guild ${cleanGuildId})`);
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

      const activeChId = cleanId(player._channelId ?? cleanChannelId) || cleanChannelId;
      const homeChId   = cleanId(player._home247Channel ?? activeChId) || activeChId;
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

        const chMgr = this.client?.channels ?? null;
        const canPostById = (c) => !!c?.id && !!chMgr && typeof chMgr.send === "function";
        const asSendable = (c) => {
          if (!c || typeof c === "string" || typeof c.send === "function") return c;
          if (!canPostById(c)) return c;
          const target = { id: c.id, type: c.type };
          target.isTextBased = () => true;
          target.send = (options) => chMgr.send(c.id, options);
          return target;
        };
        const usable = (c) => !!c && typeof c === "object" &&
            (typeof c.send === "function" || canPostById(c));

        const _tc = player.textChannel;
        let ch = (_tc && typeof _tc === "object" && _tc.channel && typeof _tc.channel === "object")
          ? _tc.channel
          : _tc;
        if (!usable(ch)) {
          const savedAnnChId = serverSettings?.get?.("announcementChannelId");
          if (savedAnnChId) {
            ch = this.client?.channels?.get?.(cleanId(savedAnnChId)) ?? null;
          }
        }
        if (!usable(ch)) {
          const guild = this.client?.guilds?.get?.(cleanGuildId);
          if (guild?.systemChannelId) {
            ch = guild.channels?.get?.(guild.systemChannelId) ?? null;
          }
        }
        if (!usable(ch)) {
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
        if (!usable(ch)) return;

        ch = asSendable(ch);
        if (!player.textChannel) player.textChannel = ch;

        const payload = typeof m === "object" && Array.isArray(m.embeds)
          ? { ...m, allowedMentions: { parse: [] } }
          : { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(m)], allowedMentions: { parse: [] } };
        ch.send(payload).catch(err => {
          if (err.code === 'MISSING_PERMISSIONS' || err.statusCode === 403) {
            logger.warn(`[_spawnPlayer] Cannot send announcement in channel ${ch.id} — missing permissions`);
          } else {
            logger.warn(`[_spawnPlayer] Failed to send announcement in channel ${ch.id}:`, err?.message ?? err);
          }
        });
      } catch(e) {
        logger.warn("[Player] Song announcement error:", e?.message);
      }
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
      try { player.destroy(); } catch(e) { logger.warn("[_spawnPlayer] Cleanup destroy error:", e?.message); }
      logger.warn(`[_spawnPlayer] Failed to spawn player for channel ${cleanChannelId}:`, err.message);
      throw err;
    }
  }

  /**
   * Leave a voice channel programmatically. Removes 24/7 if active,
   * destroys the player, and optionally sends a confirmation message.
   * @param {string} channelId - The channel ID to leave.
   * @param {string} guildId - The guild ID.
   * @param {object} [message=null] - Optional message for reply confirmation.
   * @param {boolean} [force=false] - Whether to force-leave regardless of 24/7 status.
   * @returns {Promise<boolean>} True on success.
   */
  async leaveChannel(channelId, guildId, message, force = false) {
    const cleanChId = cleanId(channelId);
    const cleanGuildId = cleanId(guildId);
    const set     = this.settingsMgr.getServer(cleanGuildId);
    const raw     = set?.get("stay_247");

    const channels = (!raw || raw === "none")
        ? new Set()
        : Array.isArray(raw)
            ? new Set(raw.map(id => cleanId(id)).filter(Boolean))
            : new Set([cleanId(raw)]);

    if (channels.has(cleanChId)) {
      channels.delete(cleanChId);
      set.set("stay_247", channels.size > 0 ? [...channels] : "none");
      remove247ChannelMode(set, cleanChId, channels);
    }

    this.markIntentionalLeave(cleanChId);

    const player = this.players.playerMap.get(cleanChId);
    if (player) {
      this.players.playerMap.delete(cleanChId);
      this.players._unindexPlayer(player._guildId, cleanChId);
      const pendingScrobble = this.players._pendingScrobbleTimers?.get(cleanChId);
      if (pendingScrobble) { clearTimeout(pendingScrobble.timer); this.players._pendingScrobbleTimers.delete(cleanChId); }
      await player.leave().catch(() => {});
      player.destroy();
    }

    if (message) {
      const guildIdForLocale = message?.channel?.channel?.guildId ?? message?.guildId ?? cleanGuildId;
      message.replyEmbed(this.locale.translate(guildIdForLocale, "responses._common.successfullyLeft"));
    }

    return true;
  }

  /**
   * Get the server settings for the guild associated with a message.
   * @param {object} message - The incoming message wrapper.
   * @returns {object} The {@link ServerSettings} for the guild, or a fallback.
   */
  getSettings(message) {
    const guildId = message?.channel?.channel?.guildId ?? message?.guildId ?? null;
    return this.settingsMgr.getServer(guildId);
  }

  /**
   * Shorthand to translate a locale key for the guild of a given message.
   * @param {object} message - The message wrapper (used to resolve guild ID).
   * @param {string} key - The locale key.
   * @param {object} [data={}] - Interpolation data.
   * @returns {string} The localised string.
   */
  t(message, key, data = {}) {
    const guildId = message?.channel?.channel?.guildId
        ?? message?.message?.guildId
        ?? message?.guildId
        ?? null;
    return this.locale.translate(guildId, key, data);
  }

  /**
   * Get or create a player for the given message context.
   * Delegates to {@link PlayerManager.getPlayer}.
   * @param {object} message - The message wrapper.
   * @param {boolean} promptJoin - Whether to prompt the user to join a voice channel.
   * @param {boolean} verifyUser - Whether to verify the user is in a voice channel.
   * @param {boolean} shouldJoin - Whether to auto-join the voice channel.
   * @returns {Promise<object>} The Player instance.
   */
  getPlayer(message, promptJoin, verifyUser, shouldJoin) {
    return this.players.getPlayer(message, promptJoin, verifyUser, shouldJoin);
  }

  /**
   * Get all servers the bot and the given user share (i.e. the user is a member).
   * Used by the dashboard to determine which servers a user can manage.
   * @async
   * @param {object} user - The Discord user.
   * @returns {Promise<Array<object>>} Array of server summary objects with channels.
   */
  async getSharedServers(user) {
    if (!user) return [];

    const shared = [];

    for (const guild of this.client.guilds?.values?.() ?? []) {
      let isMember = false;

      if (guild.members?.has?.(user.id)) {
        isMember = true;
      }

      if (!isMember) {
        const cleanGuildId = cleanId(guild.id);
        const userLoc = this.voiceCache.getUserLocation(cleanGuildId, user.id);
        if (userLoc) isMember = true;
      }

      if (!isMember) {
        try {
          const member = await guild.members.fetch(user.id).catch(() => null);
          if (member) isMember = true;
        } catch (e) { logger.warn(`[getSharedServers] Member fetch error for ${user.id}:`, e?.message); }
      }

      if (!isMember) continue;

      const guildChannels = guild.channels
        ? [...guild.channels.values()]
        : [];
      const allChannels = guildChannels
        .map(c => Dashboard.convertChannel(c))
        .filter(c => !c.isCategory);
      const channelIds = guildChannels.map(c => c.id);

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

  /**
   * Create and attach a paginated message to the given message.
   * @param {string} form - The form/locale key for the page title.
   * @param {string} content - The full content to paginate.
   * @param {object} msg - The message wrapper.
   * @param {number} linesPerPage - Maximum lines per page.
   */
  pagination(form, content, msg, linesPerPage) {
    this.messages.initPagination(
        new PageBuilder(content).setForm(form).setMaxLines(linesPerPage),
        msg
    );
  }

}

const remix = new Remix();

/**
 * Check whether an error is a known-ignorable WebSocket transport crash
 * from the fluxer.js ws or undici internals.
 * @param {Error} err - The error to check.
 * @returns {boolean} True if the error should be silently recovered.
 */
const isIgnorableWsCrash = (err) => {
  const message = String(err?.message ?? err ?? "");
  const stack = String(err?.stack ?? "");
  return message === "WebSocket error" &&
      (
        stack.includes("@fluxerjs/ws/dist/index.mjs") ||
        stack.includes("node:internal/deps/undici/undici")
      );
};

/**
 * Check whether an error is the benign LiveKit "AudioSource is closed" race.
 * Happens when a track is skipped/stopped while @fluxerjs/voice's internal
 * WebM demuxer still has queued frames to push into the just-closed audio
 * source. Harmless by itself — but if it ever surfaces as a synchronous
 * uncaughtException it must NOT take the whole bot down.
 * @param {Error} err - The error to check.
 * @returns {boolean} True if the error is the audio stop-race.
 */
const isBenignAudioStopRace = (err) =>
  String(err?.message ?? err ?? "").includes("AudioSource is closed");

let _lastWsCrashLog = 0;
let _lastAudioRaceLog = 0;
const WS_CRASH_LOG_COOLDOWN = 30_000;

process.on("unhandledRejection", (reason, p) => {
  if (reason?.message?.includes("AudioSource is closed")) return;
  logger.error("[Error_Handling] Unhandled Rejection/Catch");
  logger.error("Reason:", reason, p);
});
process.on("uncaughtException", (err, origin) => {
  if (isIgnorableWsCrash(err)) {
    const now = Date.now();
    if (now - _lastWsCrashLog > WS_CRASH_LOG_COOLDOWN) {
      _lastWsCrashLog = now;
      logger.warn("[Error_Handling] Suppressed recoverable websocket transport crash (will not re-log for 30s).");
    }
    return;
  }
  if (isBenignAudioStopRace(err)) {
    const now = Date.now();
    if (now - _lastAudioRaceLog > WS_CRASH_LOG_COOLDOWN) {
      _lastAudioRaceLog = now;
      logger.warn("[Error_Handling] Suppressed benign audio stop-race (AudioSource is closed) — track was skipped/stopped mid-frame.");
    }
    return;
  }
  logger.error("[Error_Handling] Uncaught Exception/Catch");
  logger.error("Error:", err, origin);
  process.exit(1);
});
process.on("uncaughtExceptionMonitor", (err, origin) => {
  if (isIgnorableWsCrash(err)) return;
  if (isBenignAudioStopRace(err)) return;
  logger.error("[Error_Handling] Uncaught Exception/Catch (MONITOR)");
  logger.error("Error:", err, origin);
});

/**
 * Graceful shutdown handler: destroys all active players, closes
 * Lavalink, Redis, and Dashboard DB connections, then exits.
 * @async
 * @returns {Promise<void>}
 */
const saveAndExit = async () => {
  logger.recovery("\n[Shutdown] Cleaning up before exit...");
  try {
    if (remix.players?.playerMap) {
      for (const [channelId, player] of remix.players.playerMap) {
        try { player.destroy(); } catch (e) { logger.warn("[Shutdown] Player destroy error:", e?.message); }
      }
      remix.players.playerMap.clear();
    }
  } catch (e) {
    logger.warn("[Shutdown] Player cleanup error:", e?.message);
  }
  try {
    if (remix.lavalink) {
      remix.lavalink.destroy();
    }
  } catch (e) {
    logger.warn("[Shutdown] Lavalink cleanup error:", e?.message);
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

process.on("SIGPIPE", () => {});
