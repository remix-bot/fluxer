/**
 * @module src/core/Bot
 * @description The Remix bot class: config loading, client construction,
 * service wiring (settings, commands, players, gateway, dashboard, Last.fm,
 * FluxerList, track options), presence rotation, alone-check loop, and
 * WebSocket error guards. Channel/voice operations live in BotVoiceMixin.
 */

import * as fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { Client, Events } from "@fluxerjs/core";
import { getVoiceManager } from "@fluxerjs/voice";
import { initLogger, logger, _wsErrorCooldown } from "./Logger.mjs";
import { Locale } from "./Locale.mjs";
import { CommandHandler, CommandLoader, PrefixManager } from "../commands/index.mjs";
import { MessageHandler, HelpCommand, setGlobalColor } from "../ui/index.mjs";
import { cleanId } from "../utils/Utils.mjs";
import * as ShardingUtils from "../utils/ShardingUtils.mjs";
import { RemoteSettingsManager } from "../db/Settings.mjs";
import { PlayerManager } from "../music/PlayerManager.mjs";
import { LavalinkManager } from "../music/LavalinkManager.mjs";
import { Dashboard } from "../dashboard/Dashboard.mjs";
import { VoiceStateCache } from "../voice/VoiceStateCache.mjs";
import { GatewayHandler } from "../voice/gateway/GatewayHandler.mjs";
import { LastFmManager } from "../services/lastfm/LastFmManager.mjs";
import { FluxerListManager } from "../services/FluxerListManager.mjs";
import { TrackOptionsManager } from "../services/TrackOptionsManager.mjs";
import { applyMixins } from "../utils/mixins.mjs";
import BotVoiceMixin from "./BotVoiceMixin.mjs";

/**
 * Create a Map-like view object that proxies bot voice-state lookups through
 * the VoiceStateCache's bot-specific methods.
 * @param {VoiceStateCache} voiceCache
 * @returns {Map}
 */
function createBotView(voiceCache) {
  return {
    get size()            { return voiceCache.botLocations.size; },
    get(key)              { return voiceCache.botLocations.get(key); },
    set(key, val)         { return voiceCache.setBotUser(key, val); },
    has(key)              { return voiceCache.botLocations.has(key); },
    delete(key)           { return voiceCache.deleteBotUser(key); },
    forEach(fn)           { for (const [k, v] of voiceCache.iterateBotUsers()) fn(v, k, this); },
    *[Symbol.iterator]()  { yield* voiceCache.iterateBotUsers(); },
    *entries()            { yield* voiceCache.iterateBotUsers(); },
    *keys()               { for (const [k] of voiceCache.iterateBotUsers()) yield k; },
    *values()             { for (const [, v] of voiceCache.iterateBotUsers()) yield v; },
    get observedVoiceBotsSize() { return voiceCache.botLocations.size; },
  };
}

/**
 * Build a runtime presence update payload from a config entry (string or
 * object with text/emoji/activity).
 * @param {string|object} entry
 * @returns {object}
 */
function buildRuntimePresence(entry) {
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
}

/**
 * @class Remix
 * @description Main bot class. Orchestrates client, settings, players,
 * lavalink, gateway events, commands, and 24/7 voice channel management.
 */
class Remix {
  /**
   * Bootstrap the entire bot: load config, create the Fluxer client,
   * initialise settings/commands/players/dashboard, set up event handlers,
   * load modules, and log in.
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

    // Fluxer 3.0: ClientOptions.presence is the normalized PresenceUpdateOptions
    // shape (customStatus/emojiName/emojiId) — the 2.2 wire format
    // (custom_status) is no longer read here. buildRuntimePresence() outputs
    // exactly the normalized shape, so the initial presence reuses it.
    const client = new Client({
      waitForGuilds: true,
      cache: { guilds: false, channels: false, users: false, members: false },
      ...config["fluxer.js"],
      presence: presenceContents.length === 0 ? undefined : buildRuntimePresence(presenceContents[0]),
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
    /** Bot-level 24/7 rejoin timers (channelId → Timeout). Owned by Remix, not by Players. */
    this._247RejoinTimers = new Map();

    this.gatewayHandler = new GatewayHandler(this);
    this.gatewayHandler.setupEventHandlers();

    this.lastfm = new LastFmManager(config.lastfm, config.mysql);
    this.fluxerlist = new FluxerListManager(config.fluxerlist);
    this.trackOptions = new TrackOptionsManager(config.mysql);

    settings.on("ready", () => this._onSettingsReady());

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
    setInterval(() => this._runAloneCheck(), ALONE_CHECK_INTERVAL);

    this.players.checkVoiceChannels = (message) => this._checkVoiceChannelsImpl(message);

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
    const dir       = path.join(__dirname, "..", "..", "commands");
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

    // Fluxer.js 3.0 sharding (opt-in, root `shard.mjs`): a child forked by a
    // ShardingManager attaches the child-side ShardClientUtil BEFORE login —
    // it applies FLUXER_SHARD_IDS/FLUXER_SHARD_COUNT to the client options
    // and routes IDENTIFYs through the parent's shared per-IP budget — then
    // reports readiness so the supervisor's spawn() promise resolves.
    const startLogin = async () => {
      if (ShardingUtils.isShardedProcess()) {
        try {
          const { attachShardClientUtil } = await import("@fluxerjs/sharding");
          this.shardUtil = attachShardClientUtil(client);
          logger.player(
            `[Startup] Sharding child attached — ${ShardingUtils.describeSharding(client)}.`
          );
        } catch (e) {
          // Fatal: without the shard slice this child would identify as shard 0
          // like every other child and thrash the gateway sessions.
          logger.error(
            "[Startup] FATAL: running under a ShardingManager but the sharding attach failed:",
            e?.message
          );
          process.exit(1);
        }
      }
      await client.login(config.token);
      if (this.shardUtil) {
        try { this.shardUtil.notifyReady(); }
        catch (e) { logger.warn("[Startup] Sharding ready report failed:", e?.message); }
      }
    };
    startLogin().catch(e => {
      logger.error("[Startup] Login failed:", e?.message ?? e);
      process.exit(1);
    });
  }

  /**
   * Settings-ready handler: initialise the logger and normalise stay_247
   * values (single channel per guild, cleaned IDs).
   * @private
   */
  _onSettingsReady() {
    initLogger(this.config);
    logger.settings("[settings] Loaded from DB.");
    for (const [guildId, serverSettings] of this.settingsMgr.guilds) {
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
  }

  /**
   * Periodic alone-check: for every active player, when no humans remain in
   * the channel, either arm the inactivity timer (music still queued) or
   * emit autoleave.
   * @private
   */
  _runAloneCheck() {
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

      // Fluxer 3.0: the ws manager exposes shards via getShards() (2.2 used a
      // `shards` Map property) and a sharded child owns several of them —
      // attach to every shard connected in this process, not just shard 0.
      for (const [id, shard] of ShardingUtils.getLocalShards(this.client)) {
        attachToShard(shard, id);
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
}

// Attach channel/voice operations (spawn, leave, shared servers, helpers).
applyMixins(Remix, BotVoiceMixin);

export { Remix };
export default Remix;
