/** @module src/PlayerManager @description Manages all Player instances. Handles player lifecycle (spawn, join, leave, destroy), voice channel resolution, dashboard events, and autoleave suppression for 24/7 channels. */

import Player from "./Player.mjs";
import { Utils, cleanId } from "./Utils.mjs";
import { logger } from "./constants/Logger.mjs";
import { get247ChannelMode } from "./constants/Helpers247.mjs";
import { EmbedBuilder, PermissionFlags } from "@fluxerjs/core";
import { getVoiceManager } from "@fluxerjs/voice";
import { getGlobalColor, getMessageGuildId } from "./MessageHandler.mjs";
import { Dashboard } from "./dashboard/Dashboard.mjs";
import { hasHumansInChannel, iterateVoiceStates } from "./constants/VoiceStateResolver.mjs";


/** @private @param {Player} player @param {object|null} [fallbackChannel=null] @returns {string} Cleaned guild ID. */
function getPlayerGuildId(player, fallbackChannel = null) {
  return cleanId(
    player?._guildId ??
    fallbackChannel?.guildId ??
    fallbackChannel?.guild?.id ??
    fallbackChannel?.server_id ??
    fallbackChannel?.serverId
  );
}

/** @private @param {Player} player @param {string|null} [fallbackChannelId=null] @returns {string} Cleaned channel ID. */
function getPlayerChannelId(player, fallbackChannelId = null) {
  return cleanId(player?._channelId ?? player?._home247Channel ?? fallbackChannelId);
}

/** @private Check whether the bot has required voice permissions in a channel. @param {object} client @param {string} channelId @returns {boolean} True if the bot can connect, speak, and use VAD. */
function botHasVoicePermissions(client, channelId) {
  try {
    const channel = client?.channels?.get?.(channelId);
    if (!channel) return true;
    const me = channel.guild?.members?.me;
    if (!me) return true;
    const perms = me.permissionsIn?.(channel);
    if (!perms) return true;
    if (perms.has(PermissionFlags.Administrator)) return true;
    return perms.has(PermissionFlags.Connect)
        && perms.has(PermissionFlags.Speak)
        && perms.has(PermissionFlags.UseVad);
  } catch (e) {
    logger.warn("[PlayerManager] botHasVoicePermissions check failed:", e?.message);
    return true;
  }
}

/** @private Classify a join error into a known error code for user-facing messages. @param {Error} err @param {object} [client=null] @param {string} [channelId=null] @returns {string|null} Error code ('PERMISSION'|'NOT_FOUND'|'TIMEOUT'|'SESSION_RACE') or null. */
function sanitizeJoinError(err, client = null, channelId = null) {
  const msg = String(err?.message ?? err ?? "");
  if (msg.includes("401") || msg.includes("Unauthorized")) {
    if (client && channelId && !botHasVoicePermissions(client, channelId)) {
      return "PERMISSION";
    }
    return "SESSION_RACE";
  }
  if (msg.includes("permission") || msg.includes("Permission")) {
    if (client && channelId && !botHasVoicePermissions(client, channelId)) {
      return "PERMISSION";
    }
    return "SESSION_RACE";
  }
  if (msg.includes("not found") || msg.includes("Unknown channel")) {
    return "NOT_FOUND";
  }
  if (msg.includes("timeout") || msg.includes("timed out")) {
    return "TIMEOUT";
  }
  return null;
}

/** @class PlayerManager @description Manages all Player instances. Handles player lifecycle (spawn, join, leave, destroy), voice channel resolution, dashboard events, and autoleave suppression for 24/7 channels. */
export class PlayerManager {
  /** @type {RemoteSettingsManager} */
  settings;

  /** @type {CommandHandler} */
  commands;

  /** @type {Map<string, Player>} Player instances keyed by channel ID. */
  playerMap = new Map();

  /** @private @type {Map<string, Set<string>>} Guild ID → Set of channel IDs (for fast guild-player lookup). */
  _guildPlayerIndex = new Map();

  /** @private @type {Set<string>} Channel IDs currently being joined. */
  _pendingJoins = new Set();

  /** @private @type {Map<string, {timer: setTimeout, songUrl: string, startedAtMs: number}>} */
  _pendingScrobbleTimers = new Map();

  /** @type {object} Full bot config. */
  config;

  /** @type {object} Player-specific config (lavalink reference). */
  playerConfig;

  /** @type {Locale|null} */
  locale = null;

  /** @type {Dashboard|null} */
  dashboard = null;

  /**
   * Create a new PlayerManager.
   * @param {RemoteSettingsManager} settings - The settings manager.
   * @param {CommandHandler} commands - The command handler.
   * @param {object} config - Configuration object.
   * @param {object} config.config - Full bot config.
   * @param {object} config.player - Player-specific config (lavalink, etc.).
   * @param {Dashboard} [config.dashboard] - Dashboard instance.
   * @param {Locale} [config.locale] - Locale manager.
   * @param {object} [config.timers] - Timer configuration.
   * @param {TrackOptionsManager} [config.trackOptions] - Track options manager.
   */
  constructor(settings, commands, config) {
    this.commands     = commands;
    this.settings     = settings;
    this.config       = config.config;
    this.playerConfig = config.player;
    this.dashboard    = config.dashboard ?? null;
    this.locale       = config.locale ?? null;
    this.timers       = config.timers ?? {};
    this._lastfm      = null;
    this.trackOptions = config.trackOptions ?? null;
  }

  /** @private Index a player by guild and channel ID for fast lookups. @param {string} guildId @param {string} channelId */
  _indexPlayer(guildId, channelId) {
    const gId = cleanId(guildId);
    const cId = cleanId(channelId);
    if (!gId || !cId) return;
    let set = this._guildPlayerIndex.get(gId);
    if (!set) { set = new Set(); this._guildPlayerIndex.set(gId, set); }
    set.add(cId);
  }

  /** @private Remove a player from the guild-player index. @param {string} guildId @param {string} channelId */
  _unindexPlayer(guildId, channelId) {
    const gId = cleanId(guildId);
    const cId = cleanId(channelId);
    if (!gId) return;
    const set = this._guildPlayerIndex.get(gId);
    if (set) {
      set.delete(cId);
      if (set.size === 0) this._guildPlayerIndex.delete(gId);
    }
  }

  /** Get all active (non-destroyed) players for a guild. @param {string} guildId @returns {Array<[string, Player]>} Array of [channelId, Player] pairs. */
  getGuildPlayers(guildId) {
    const gId = cleanId(guildId);
    const set = this._guildPlayerIndex.get(gId);
    if (!set) return [];
    const result = [];
    for (const channelId of set) {
      const player = this.playerMap.get(channelId);
      if (!player || player._destroyed) {
        set.delete(channelId);
        continue;
      }
      result.push([channelId, player]);
    }
    return result;
  }

  /** Find a player by both guild and channel. @param {string} guildId @param {string} channelId @returns {Player|null} */
 getPlayerByGuildAndChannel(guildId, channelId) {
    const cId = cleanId(channelId);
    const players = this.getGuildPlayers(guildId);
    for (const [mapChannelId, player] of players) {
      if (getPlayerChannelId(player, mapChannelId) === cId) return player;
    }
    return null;
  }

  /** Find a player by its channel ID across all guilds. @param {string} channelId @returns {Player|null} */
 getPlayerByChannelId(channelId) {
    const cId = cleanId(channelId);
    for (const [, channelSet] of this._guildPlayerIndex) {
      for (const mapChannelId of channelSet) {
        const player = this.playerMap.get(mapChannelId);
        if (player && getPlayerChannelId(player, mapChannelId) === cId) return player;
      }
    }
    return null;
  }

  /** Bind dashboard update and message-sending events on a player. @param {Player} player @param {object} [context={}] @returns {Player} The same player, with events bound. */
  setupEvents(player, context = {}) {
    if (!player || player._dashboardEventsBound) return player;

    Object.defineProperty(player, "_dashboardEventsBound", {
      value: true,
      configurable: true,
      enumerable: false,
      writable: true,
    });

    const emit = (type, data) => {
      if (!this.dashboard?.enabled) return;
      this.dashboard.updatePlayer({ type, data }, player);
    };

    const emitGlobal = (type) => {
      if (!this.dashboard?.enabled) return;
      this.dashboard.playerUpdate({ type }, player);
    };

    const sendUserUpdates = (eventType) => {
      if (!this.dashboard?.enabled) return;
      const channelId = getPlayerChannelId(player, context.channelId);
      const channel = player.client?.channels?.get(channelId);
      const guild = player.client?.guilds?.get(cleanId(player._guildId ?? context.guildId));
      if (!guild) return;
      const voiceStates = guild.voice_states ?? guild.voiceStates ?? null;
      if (!voiceStates) return;
      const entries = Array.isArray(voiceStates)
        ? voiceStates
        : typeof voiceStates.values === "function"
          ? [...voiceStates.values()]
          : Object.values(voiceStates);
      for (const state of entries) {
        if (!state?.channelId && !state?.channel_id) continue;
        const stateChannelId = cleanId(state.channelId ?? state.channel_id);
        if (stateChannelId !== channelId) continue;
        const member = guild.members?.get?.(state.userId ?? state.user_id);
        if (!member?.user || member.user?.bot) continue;
        emit(eventType, member.user.id);
        this.dashboard.userUpdate({
          type: eventType,
          guildId: cleanId(player._guildId ?? context.guildId),
          channelId,
        }, member.user);
      }
    };

    player.on("roomfetched", () => {
      emitGlobal("init");
      sendUserUpdates("join");
    });

    player.on("startplay", (song) => {
      emit("startplay", Dashboard.convertVideo(song ?? player.queue?.current));
      emit("streamStartPlay", Date.now());
      this.dashboard.playerUpdate({ type: "startplay" }, player);

      if (this._lastfm?.enabled && song) {
        this._handleLastFmStartPlay(player, song);
      }
    });

    player.on("stopplay", () => {
      emit("stopplay", null);
      this.dashboard.playerUpdate({ type: "stopplay" }, player);
    });

    player.on("playback", (playing) => {
      const elapsedMs = player._pausedAt
          ? (player._pausedAt.getTime?.() ?? Number(player._pausedAt)) -
            (player.startedPlaying?.getTime?.() ?? Number(player.startedPlaying ?? 0))
          : Date.now() - (player.startedPlaying?.getTime?.() ?? Number(player.startedPlaying ?? 0));
      const type = playing ? "resume" : "pause";
      emit(type, { elapsedTime: Math.max(0, elapsedMs) });
      this.dashboard.playerUpdate({ type }, player);
    });

    player.on("volume", (volume) => {
      emit("volume", volume);
      this.dashboard.playerUpdate({ type: "volume" }, player);
    });

    player.on("filter", (filter) => {
      emit("filter", filter);
    });

    player.on("update", (scope) => {
      this.dashboard.playerUpdate({ type: "update" }, player);
    });

    player.on("autoleave", () => {
      sendUserUpdates("leave");
      emitGlobal("close");
      emit("stopplay", null);
    });

    player.on("leave", () => {
      sendUserUpdates("leave");
      emitGlobal("close");
      emit("stopplay", null);
    });

    player.queue?.on("queue", (queueEvent) => {
      const serialised = { type: queueEvent.type };
      switch (queueEvent.type) {
        case "add":
          serialised.data = {
            append: queueEvent.data?.append,
            data: Dashboard.convertVideo(queueEvent.data?.data),
          };
          break;
        case "addMany":
          serialised.data = {
            append: queueEvent.data?.append,
            tracks: (queueEvent.data?.tracks ?? []).map(v => Dashboard.convertVideo(v)),
          };
          break;
        case "remove":
          serialised.data = {
            index: queueEvent.data?.index,
            removed: Dashboard.convertVideo(queueEvent.data?.removed),
            old: (queueEvent.data?.old ?? []).map(v => Dashboard.convertVideo(v)),
            new: (queueEvent.data?.new ?? []).map(v => Dashboard.convertVideo(v)),
          };
          break;
        case "move":
          serialised.data = {
            from: queueEvent.data?.from,
            to: queueEvent.data?.to,
            track: Dashboard.convertVideo(queueEvent.data?.track),
          };
          break;
        case "shuffle":
          serialised.data = (queueEvent.data ?? []).map(v => Dashboard.convertVideo(v));
          break;
        case "update":
          serialised.data = {
            current: Dashboard.convertVideo(queueEvent.data?.current),
            old: Dashboard.convertVideo(queueEvent.data?.old),
            loop: queueEvent.data?.loop,
          };
          break;
        default:
          serialised.data = queueEvent.data;
          break;
      }

      emit("queue", serialised);
      this.dashboard.playerUpdate({ type: "queue" }, player);
    });

    return player;
  }

  /** @private Translate a locale key for a message context. @param {object} message @param {string} key @param {object} [replacements={}] @returns {string} */
  _t(message, key, replacements = {}) {
    if (!this.locale) return key;
    const guildId = getMessageGuildId(message);
    return this.locale.translate(guildId, key, replacements);
  }

  /** Detect which voice channel the message author is in. @async @param {object} message @param {object} settings @returns {Promise<{channelId: string|null, alreadyInVoice: boolean, hasHumans: boolean}>} */
  async checkVoiceChannels(message, settings) {
    const guildId = message?.guildId ?? message?.channel?.guildId ?? getMessageGuildId(message);
    const userId  = message?.author?.id ?? message?.member?.user?.id;
    const cleanGuildId = cleanId(guildId);
    if (!guildId || !userId) return { channelId: null, alreadyInVoice: false, hasHumans: false };

    const guild = this.commands?.client?.guilds?.get?.(cleanGuildId);


    if (this.voiceCache) {
      const observed = this.voiceCache.getUserLocation(cleanGuildId, userId);
      if (observed && observed.channelId) {
        const alreadyInVoice = this.playerMap.has(cleanId(observed.channelId));
        const hasHumans = this.voiceCache.hasHumansInChannel(cleanGuildId, cleanId(observed.channelId));
        return { channelId: observed.channelId, alreadyInVoice, hasHumans };
      }
    }


    let channelId = message?.member?.voice?.channelId ?? null;


    if (!channelId && guild) {
      for (const vs of iterateVoiceStates(guild)) {
        if (vs.userId === String(userId) && !vs.isBot) {
          channelId = vs.channelId;
          break;
        }
      }
    }


    if (!channelId) {
      try {
        const vm = getVoiceManager(this.commands?.client);
        channelId = vm?.getVoiceChannelId?.(guildId, userId) ?? null;
      } catch (e) {
        logger.warn("[PlayerManager] VoiceManager lookup failed:", e?.message);
      }
    }


    if (!channelId && this.voiceCache) {
      const loc = this.voiceCache.getHumanUser(userId);
      if (loc && cleanId(loc.guildId) === cleanGuildId) {
        channelId = loc.channelId;
      }
    }

    if (!channelId) return { channelId: null, alreadyInVoice: false, hasHumans: false };

    const alreadyInVoice = this.playerMap.has(cleanId(channelId));

    const hasHumansResult = hasHumansInChannel({
      guildId: cleanGuildId,
      channelId: cleanId(channelId),
      client: this.commands?.client,
      voiceCache: this.voiceCache,
      observedVoiceUsers: this.observedVoiceUsers,
      room: this.playerMap.get(cleanId(channelId))?.connection?.room,
      botId: this.commands?.client?.user?.id,
    });

    return { channelId, alreadyInVoice, hasHumans: hasHumansResult };
  }

  /** Get or spawn a player for the message's voice channel. @async @param {object} message @param {boolean} [promptJoin=true] @param {boolean} [verifyUser=true] @param {boolean} [shouldJoin=false] @returns {Promise<Player|null>} */
 async getPlayer(message, promptJoin = true, verifyUser = true, shouldJoin = false) {
    const guildId = getMessageGuildId(message);
    const cleanGuildId = cleanId(guildId);

    const { channelId: userChannelId } = await this.checkVoiceChannels(message);
    const cleanUserChannelId = cleanId(userChannelId);

    if (cleanUserChannelId) {
      const player = this.playerMap.get(cleanUserChannelId)
          ?? this.getPlayerByGuildAndChannel(cleanGuildId, cleanUserChannelId);
      if (player) {
        player.textChannel = message.channel?.channel ?? message.channel;
        try {
          const textChannelId = message?.channel?.id ?? message?.channel?.channel?.id ?? null;
          if (guildId && textChannelId) {
            this.settings.getServer(guildId)?.set("announcementChannelId", textChannelId);
          }
        } catch(e) {
          logger.warn("[PlayerManager] Failed to save announcement channel ID:", e?.message);
        }
        return player;
      }
      if (this._pendingJoins.has(cleanUserChannelId)) {
        return null;
      }
    }

    const serverPlayers = cleanGuildId
        ? this.getGuildPlayers(cleanGuildId)
        : [];

    if (serverPlayers.length > 0) {
      const channelList = serverPlayers.map(([chId]) => `<#${chId}>`).join(" or ");

      if (!userChannelId) {
        if (!verifyUser) {
          const first = serverPlayers[0];
          first[1].textChannel = message.channel?.channel ?? message.channel;
          return first[1];
        }
        message.reply(this._t(message, "responses._common.noVoiceStrict"));
        return null;
      }

      const match = serverPlayers.find(([, player]) =>
        getPlayerChannelId(player) === cleanUserChannelId
      );
      if (match) {
        match[1].textChannel = message.channel?.channel ?? message.channel;
        try {
          const textChannelId = message?.channel?.id ?? message?.channel?.channel?.id ?? null;
          if (cleanGuildId && textChannelId) {
            this.settings.getServer(cleanGuildId)?.set("announcementChannelId", textChannelId);
          }
        } catch(e) {
          logger.warn("[PlayerManager] Failed to save announcement channel ID:", e?.message);
        }
        return match[1];
      }

      if (shouldJoin) {
        return this.initPlayer(message, userChannelId);
      }

      const prefix = this.commands.getPrefix(guildId);
      message.reply(this._t(message, "responses._common.alreadyInChannel", { channels: channelList, prefix }));
      return null;
    }

    if (!userChannelId) {
      if (shouldJoin) {
        return this.promptVC(message);
      }
      message.reply(this._t(message, "responses._common.noVoiceChannel"));
      return null;
    }

    if (shouldJoin) {
      return this.initPlayer(message, userChannelId);
    }

    return null;
  }

  /** Prompt the user to select a voice channel via reactions or text input. @async @param {object} msg @returns {Promise<Player|false>} */
  async promptVC(msg) {
    const { channelId: autoDetected } = await this.checkVoiceChannels(msg);
    if (autoDetected) {
      return this.initPlayer(msg, autoDetected);
    }

    const guildId = getMessageGuildId(msg);
    const cleanGuildId = cleanId(guildId);
    const allChannels = cleanGuildId
        ? [...(this.commands.client?.channels?.values?.() ?? [])]
            .filter(c => {
              const channelGuildId = cleanId(c.guildId ?? c.guild?.id ?? c.server_id ?? c.serverId);
              const isVoice = c.type === 2;
              return channelGuildId === cleanGuildId && isVoice;
            })
        : [];

    const reactions  = ["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣"];
    const channelArr = allChannels.slice(0, 9);

    let channelSelection = "";
    if (channelArr.length > 0) {
      channelSelection = this._t(msg, "responses._common.voiceSelectionPrompt") + "\n\n";
      channelArr.forEach((c, i) => { channelSelection += `${i + 1}. <#${c._id ?? c.id}>\n`; });
    }

    const hint = this._t(msg, "responses._common.voiceSelectionHint");
    const selectionMsg = await msg.reply(
        (channelSelection ? channelSelection + "\n**..or** " + hint : "Please " + hint)
    );

    return new Promise(resolve => {
      let unsubscribeReactions;
      let unsubscribeMessages;
      const promptUser = msg.author ?? msg.message?.author ?? null;

      const cleanup = () => {
        unsubscribeMessages?.();
        unsubscribeReactions?.();
      };

      const timeout = setTimeout(() => {
        cleanup();
        msg.reply(this._t(msg, "responses._common.voiceSelectionTimedOut"));
        resolve(false);
      }, 30_000);

      if (typeof selectionMsg?.onReaction === "function" && channelArr.length > 0) {
        unsubscribeReactions = selectionMsg.onReaction(
            reactions.slice(0, channelArr.length),
            (e) => {
              const idx     = reactions.indexOf(e.emoji_id ?? e.emoji?.id ?? e.emoji);
              const channel = channelArr[idx];
              if (!channel) return;
              clearTimeout(timeout);
              cleanup();
              const cid = channel._id ?? channel.id;
              this.initPlayer(msg, cid).then(p => resolve(p));
            },
            promptUser
        );
      }

      unsubscribeMessages = msg.channel.onMessageUser((m) => {
        const content = m.content?.toLowerCase() ?? "";
        if (content === "x") {
          clearTimeout(timeout);
          cleanup();
          m.reply(this._t(m, "voice.join.cancelled"));
          resolve(false);
          return;
        }
        if (!this.commands.validateInput("voiceChannel", m.content, m)) {
          m.reply(this._t(m, "responses._common.voiceSelectionInvalid"));
          return;
        }
        const channel = this.commands.formatInput("voiceChannel", m.content, m);
        clearTimeout(timeout);
        cleanup();
        this.initPlayer(m, channel).then(p => resolve(p));
      }, promptUser);
    });
  }

  /** Leave a voice channel, destroy the player, and send a confirmation. @async @param {object} msg @param {string} [cid] @returns {Promise<void>} */
  async leave(msg, cid) {
    if (!cid) {
      const guildId = getMessageGuildId(msg);
      if (guildId) {
        const guildPlayers = this.getGuildPlayers(cleanId(guildId));
        if (guildPlayers.length > 0) {
          const [, firstPlayer] = guildPlayers[0];
          cid = getPlayerChannelId(firstPlayer, guildPlayers[0][0]) || guildPlayers[0][0];
        }
      }
    }

    const cleanChannelId = cleanId(cid);
    const player = cleanChannelId
      ? this.playerMap.get(cleanChannelId) ??
        this.getPlayerByChannelId(cleanChannelId)
      : null;
    if (!player) return msg.reply(this._t(msg, "responses._common.notInVoice"));

    const activeChannelId = getPlayerChannelId(player, cleanChannelId) || cleanChannelId;
    this.playerMap.delete(activeChannelId);
    this._unindexPlayer(player._guildId, activeChannelId);
    const pendingScrobble = this._pendingScrobbleTimers.get(activeChannelId);
    if (pendingScrobble) { clearTimeout(pendingScrobble.timer); this._pendingScrobbleTimers.delete(activeChannelId); }
    if (activeChannelId !== cleanChannelId) this.playerMap.delete(cleanChannelId);
    try {
      await player.leave();
    } catch (e) {
      logger.warn("[PlayerManager] leave() error (non-fatal):", e.message);
    }
    player.destroy();
    await msg.reply(this._t(msg, "responses._common.successfullyLeft"));
  }

  /** @private Restore saved volume for a player from guild settings. @param {Player} player @param {string} guildId */
  _restorePlayerVolume(player, guildId) {
    const savedVol = this.settings?.getServer?.(guildId)?.get?.("volume");
    if (savedVol !== undefined && savedVol !== null) {
      const vol = Number(savedVol);
      if (!isNaN(vol)) player.setVolume(vol / 100);
    }
  }

  /** Create a new Player, join the voice channel, and set up events. @async @param {object} message @param {string} cid @returns {Promise<Player|null>} The spawned player, or null on failure. */
  async initPlayer(message, cid) {
    const channel = this.commands.client?.channels?.get(cid);

    if (!channel) {
      message.reply(
          this._t(message, "responses.join.channelNotFound", { channel: cid })
      );
      return null;
    }

    const isVoice = channel.type === 2;

    if (!isVoice) {
      message.reply(this._t(message, "responses._common.voiceChannelRequired"));
      return null;
    }

    if (!botHasVoicePermissions(this.commands?.client, cid)) {
      message.reply(
          this._t(message, "responses.join.joinFailedPerms", { channel: `<#${cleanId(cid)}>` })
      );
      return null;
    }

    const cleanChannelId = cleanId(cid);
    const existing = this.playerMap.get(cleanChannelId)
      ?? this.getPlayerByChannelId(cleanChannelId);
    if (existing) {
      existing.textChannel = message.channel?.channel ?? message.channel;
      try {
        const textChannelId = message?.channel?.id ?? message?.channel?.channel?.id ?? null;
        const existingGuildId = getMessageGuildId(message);
        if (existingGuildId && textChannelId) {
          this.settings.getServer(existingGuildId)?.set("announcementChannelId", textChannelId);
        }
      } catch(e) {
        logger.warn("[PlayerManager] Failed to save announcement channel ID:", e?.message);
      }
      message.reply(this._t(message, "responses.join.alreadyJoined", { channel: cid }));
      return existing;
    }
    if (this._pendingJoins.has(cleanChannelId)) {
      message.reply(this._t(message, "responses.join.joining"));
      return null;
    }
    this._pendingJoins.add(cleanChannelId);

    const player = new Player(this.config.token, {
      ...this.playerConfig,
      client:             this.commands.client,
      config:             this.config,
      lavalink:           this.playerConfig?.lavalink ?? null,
      settingsMgr:        this.settings,
      getPrefix:          (guildId) => this.commands.getPrefix(guildId),
      observedVoiceUsers: this.observedVoiceUsers ?? null,
      voiceCache:          this.voiceCache ?? null,
      locale:             this.locale ?? null,
      trackOptions:       this.trackOptions ?? null,
    });

    player.textChannel = message.channel?.channel ?? message.channel;
    try {
      const textChannelId = message?.channel?.id ?? message?.channel?.channel?.id ?? null;
      const newGuildId = getMessageGuildId(message);
      if (newGuildId && textChannelId) {
        this.settings.getServer(newGuildId)?.set("announcementChannelId", textChannelId);
      }
    } catch(e) {
      logger.warn("[PlayerManager] Failed to save announcement channel ID:", e?.message);
    }
    this.setupEvents(player, {
      channelId: cleanChannelId,
      guildId: cleanId(channel.guildId ?? getMessageGuildId(message)),
    });

    player.on("autoleave", () => {
      const activeChannelId = getPlayerChannelId(player, cleanChannelId) || cleanChannelId;
      const homeChannelId = cleanId(player._home247Channel) || activeChannelId;
      const ch       = player.textChannel;
      const guildId = cleanId(player._guildId ?? ch?.guildId ?? ch?.guild?.id ?? getMessageGuildId({ channel: ch }));

      const raw247 = (() => {
        try { return this.settings.getServer(guildId)?.get("stay_247"); } catch (e) { logger.warn("[PlayerManager] Failed to read 24/7 setting:", e?.message); return null; }
      })();
      const isIn247List = (() => {
        if (!raw247 || raw247 === "none") return false;
        const channels = Array.isArray(raw247)
            ? raw247.map(id => cleanId(id)).filter(Boolean)
            : [cleanId(raw247)].filter(Boolean);
        return channels.includes(homeChannelId) || channels.includes(activeChannelId);
      })();

      const matchChannel = isIn247List
          ? (channels247list => channels247list.includes(homeChannelId) ? homeChannelId : activeChannelId)(
              Array.isArray(raw247) ? raw247.map(id => cleanId(id)) : [cleanId(raw247)]
            )
          : null;
      const mode247 = matchChannel
          ? get247ChannelMode(this.settings.getServer(guildId), matchChannel)
          : "off";

      if (mode247 === "on") {
        logger.inactivity(`[PlayerManager] autoleave suppressed for 24/7 channel ${activeChannelId} (guild ${guildId})`);
        return;
      }
      if (player._hasHumansInChannel()) {
        logger.inactivity(`[PlayerManager] autoleave suppressed — humans still in channel ${activeChannelId} (guild ${guildId})`);
        return;
      }
      if (player.queue?.getCurrent() || !player.queue?.isEmpty()) {
        logger.inactivity(`[PlayerManager] autoleave suppressed — queue has songs in channel ${activeChannelId} (guild ${guildId})`);
        return;
      }

      this.playerMap.delete(activeChannelId);
      this._unindexPlayer(player._guildId, activeChannelId);
      const pendingScrobble = this._pendingScrobbleTimers.get(activeChannelId);
      if (pendingScrobble) { clearTimeout(pendingScrobble.timer); this._pendingScrobbleTimers.delete(activeChannelId); }
      if (activeChannelId !== cleanChannelId) this.playerMap.delete(cleanChannelId);
      if (homeChannelId !== activeChannelId) this.playerMap.delete(homeChannelId);
      player.destroy();

      const prefix = this.commands.getPrefix(guildId);

      const desc = this.locale?.translate(guildId, "responses.join.autoLeaveInactive", { channel: `<#${activeChannelId}>`, prefix })
          ?? `Left channel <#${activeChannelId}> because of inactivity.\nIf you want me to stay in voice, use \`${prefix}247\``;
      const autoleaveChMgr = this.commands?.client?.channels ?? null;
      let leaveCh = (ch && typeof ch === "object" && typeof ch.send !== "function" && ch.id &&
          autoleaveChMgr && typeof autoleaveChMgr.send === "function")
        ? (() => { const t = { id: ch.id, type: ch.type }; t.send = (o) => autoleaveChMgr.send(ch.id, o); return t; })()
        : ch;
      if (typeof leaveCh?.send === "function") {
        leaveCh.send({ embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(desc)], allowedMentions: { parse: [] } }).catch(err => {
          if (err.code === 'MISSING_PERMISSIONS' || err.statusCode === 403) {
            logger.warn(`[PlayerManager] Cannot send autoleave message in channel ${leaveCh.id} — missing permissions`);
          }
        });
      }
    });

    player.on("message", (m) => {
      const unwrapChannel = (c) =>
        (c && typeof c === "object" && c.channel && typeof c.channel === "object") ? c.channel : c;

      const chMgr = this.commands?.client?.channels ?? null;
      const canPostById = (c) => !!c?.id && !!chMgr && typeof chMgr.send === "function";
      const asSendable = (c) => {
        if (!c || typeof c === "string" || typeof c.send === "function") return c;
        if (!canPostById(c)) return c;
        const target = { id: c.id, type: c.type };
        target.isTextBased = () => true;
        target.send = (options) => chMgr.send(c.id, options);
        return target;
      };

      const isTextChannel = (c) => {
        c = unwrapChannel(c);
        if (!c) return false;
        if (c.type === undefined || c.type === null) return false;
        const voiceTypes = [2, 13, "GUILD_VOICE", "GUILD_STAGE_VOICE", "STAGE", "voice", "stage"];
        if (voiceTypes.includes(c.type)) return canPostById(c);
        if (typeof c.isTextBased === "function") return c.isTextBased();
        const textTypes = [0, 5, 10, 11, 12, "GUILD_TEXT", "GUILD_ANNOUNCEMENT", "text"];
        if (textTypes.includes(c.type)) return true;
        logger.warn(`[PlayerManager] isTextChannel: unknown channel type=${c.type} id=${c.id}, rejecting`);
        return false;
      };

      let ch       = asSendable(unwrapChannel(player.textChannel));
      const guildId = cleanId(player._guildId ?? ch?.guildId ?? ch?.guild?.id ?? getMessageGuildId({ channel: ch }));

      const raw      = this.settings.getServer(guildId)?.get("songAnnouncements");
      const disabled = raw === false || raw === 0 ||
          ["false","0","no","off","disable"].includes(String(raw).toLowerCase().trim());
      if (disabled) return;

      if (!isTextChannel(ch)) {
        try {
          const serverSettings = this.settings.getServer(guildId);
          const savedAnnChId = serverSettings?.get?.("announcementChannelId");
          if (savedAnnChId) {
            const resolved = this.commands?.client?.channels?.get?.(cleanId(savedAnnChId)) ?? null;
            if (isTextChannel(resolved)) ch = asSendable(resolved);
          }
        } catch(e) {
          logger.warn("[PlayerManager] Failed to resolve announcement channel:", e?.message);
        }
      }
      if (!isTextChannel(ch)) {
        try {
          const guild = this.commands?.client?.guilds?.get?.(guildId);
          if (guild?.systemChannelId) {
            const resolved = guild.channels?.get?.(guild.systemChannelId) ?? null;
            if (isTextChannel(resolved)) ch = asSendable(resolved);
          }
        } catch(e) {
          logger.warn("[PlayerManager] Failed to resolve system channel:", e?.message);
        }
      }
      if (!isTextChannel(ch)) {
        try {
          const guild = this.commands?.client?.guilds?.get?.(guildId);
          if (guild?.channels) {
            for (const c of (guild.channels.values?.() ?? [])) {
              if (isTextChannel(c)) {
                ch = asSendable(c);
                break;
              }
            }
          }
        } catch(e) {
          logger.warn("[PlayerManager] Failed to find fallback text channel:", e?.message);
        }
      }
      if (!isTextChannel(ch)) {
        logger.warn(`[PlayerManager] Could not resolve any text channel to send now-playing announcement (guild ${guildId})`);
        return;
      }

      if (!player.textChannel || !isTextChannel(player.textChannel)) player.textChannel = ch;

      const payload = typeof m === "object" && Array.isArray(m.embeds)
        ? { ...m, allowedMentions: { parse: [] } }
        : { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(m)], allowedMentions: { parse: [] } };
      ch = asSendable(ch);
      ch.send(payload).catch(err => {
        if (err.code === 'MISSING_PERMISSIONS' || err.statusCode === 403) {
          logger.warn(`[PlayerManager] Cannot send player message in channel ${ch.id} — missing permissions`);
        } else {
          logger.warn(`[PlayerManager] Failed to send player message in channel ${ch.id}:`, err?.message ?? err);
        }
      });
    });

    const statusMsg = await message.reply(this._t(message, "responses.join.joining"));
    try {
      await player.join(cid);

      this.playerMap.set(cleanChannelId, player);
      this._indexPlayer(channel.guildId ?? getMessageGuildId(message), cleanChannelId);
      this._pendingJoins.delete(cleanChannelId);

      await statusMsg.edit(this._t(message, "responses.join.joined", { channel: cid }));

      const guildId = cleanId(channel.guildId ?? getMessageGuildId(message));
      this._restorePlayerVolume(player, guildId);

      return player;
    } catch (err) {
      this._pendingJoins.delete(cleanChannelId);

      const errCode = sanitizeJoinError(err, this.commands?.client, cleanChannelId);
      let errorMsg;
      if (errCode === "SESSION_RACE") {
        logger.warn(`[PlayerManager] Stale voice session detected for channel ${cleanChannelId}, retrying in 2s...`);
        try {
          await new Promise(r => setTimeout(r, 2_000));
          await player.join(cid);

          this.playerMap.set(cleanChannelId, player);
          this._indexPlayer(channel.guildId ?? getMessageGuildId(message), cleanChannelId);
          await statusMsg.edit(this._t(message, "responses.join.joined", { channel: cid }));

          const retryGuildId = cleanId(channel.guildId ?? getMessageGuildId(message));
          this._restorePlayerVolume(player, retryGuildId);
          return player;
        } catch (retryErr) {
          logger.warn(`[PlayerManager] Retry also failed for channel ${cleanChannelId}: ${retryErr.message}`);
          errorMsg = this._t(message, "responses.join.joinFailedGeneric");
        }
      } else if (errCode === "PERMISSION") {
        errorMsg = this._t(message, "responses.join.joinFailedPerms", { channel: `<#${cleanChannelId}>` });
      } else if (errCode === "NOT_FOUND") {
        errorMsg = this._t(message, "responses.join.joinFailedNotFound");
      } else if (errCode === "TIMEOUT") {
        errorMsg = this._t(message, "responses.join.joinFailed");
      } else {
        errorMsg = this._t(message, "responses.join.joinFailed", { error: err.message });
      }
      await statusMsg.edit(errorMsg).catch(() => {});
      this.playerMap.delete(cleanChannelId);
      this._unindexPlayer(channel.guildId ?? getMessageGuildId(message), cleanChannelId);
      player.destroy();
      return null;
    }
  }

  /** @private Handle Last.fm now-playing update and schedule scrobble timer. @param {Player} player @param {object} song */
  _handleLastFmStartPlay(player, song) {
    const lastfm = this._lastfm;
    if (!lastfm?.enabled) return;

    const guildId = cleanId(player._guildId);
    if (!guildId) return;

    const channelId = getPlayerChannelId(player);
    const humanUserIds = [];

    if (this.voiceCache) {
      const users = this.voiceCache.getHumansInChannel(guildId, channelId);
      humanUserIds.push(...users);
    } else if (this.observedVoiceUsers) {
      for (const [uid, info] of this.observedVoiceUsers) {
        if (cleanId(info.guildId) === guildId && cleanId(info.channelId) === channelId) {
          humanUserIds.push(uid);
        }
      }
    }

    const guild = player.client?.guilds?.get(guildId);
    if (guild) {
      const voiceStates = guild.voice_states ?? guild.voiceStates ?? null;
      if (voiceStates) {
        const entries = Array.isArray(voiceStates)
          ? voiceStates
          : typeof voiceStates.values === "function"
            ? [...voiceStates.values()]
            : Object.values(voiceStates ?? {});
        for (const state of entries) {
          const uid = state?.userId ?? state?.user_id;
          const chId = cleanId(state?.channelId ?? state?.channel_id);
          if (uid && chId === channelId) {
            const member = guild.members?.get?.(uid);
            if (member?.user?.bot) continue;
            if (!humanUserIds.includes(uid)) humanUserIds.push(uid);
          }
        }
      }
    }

    const startedAtMs = player.startedPlaying;

    const pendingKey = channelId;
    const existing = this._pendingScrobbleTimers.get(pendingKey);
    if (existing) {
      clearTimeout(existing.timer);
      this._pendingScrobbleTimers.delete(pendingKey);
    }

    for (const userId of humanUserIds) {
      lastfm.updateNowPlaying(userId, song).catch(() => {});
    }

    const durationMs = (() => {
      const d = song.duration;
      if (!d) return null;
      if (typeof d === "object" && d.seconds) return d.seconds * 1000;
      if (typeof d === "number") return d;
      return null;
    })();

    if (durationMs && durationMs >= 30_000) {
      const thresholdMs = Math.min(
        durationMs * lastfm.scrobbleThreshold,
        lastfm.scrobbleMinMs
      );
      if (thresholdMs <= 600_000) {
        const timer = setTimeout(() => {
          this._pendingScrobbleTimers.delete(pendingKey);
          const current = player.queue?.getCurrent();
          if (!current || player._destroyed || player.leaving) return;
          if (current.title !== song.title || current.url !== song.url) return;
          if (player._paused) return;

          const playedMs = Date.now() - (player.startedPlaying ?? startedAtMs ?? Date.now());
          if (lastfm.shouldScrobble(song, playedMs)) {
            for (const userId of humanUserIds) {
              lastfm.scrobble(userId, song, startedAtMs).catch(() => {});
            }
          }
        }, thresholdMs);

        this._pendingScrobbleTimers.set(pendingKey, { timer, songUrl: song.url, startedAtMs });
      }
    }
  }

}
