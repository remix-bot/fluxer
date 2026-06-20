/**
 * @file PlayerManager.mjs — PlayerManager — creates, caches, and routes Player instances per voice channel across all guilds
 * @module src.PlayerManager
 */

/**
 * PlayerManager.mjs — Manages voice channel players across servers
 *
 * Updated for moonlink.js: passes the MoonlinkManager instance into every
 * new Player so it can resolve tracks and retrieve session IDs.
 */

import Player from "./Player.mjs";
import { Utils, cleanId } from "./Utils.mjs";
import { logger } from "./constants/Logger.mjs";
import { get247ChannelMode } from "./constants/Helpers247.mjs";
import { EmbedBuilder, PermissionFlags } from "@fluxerjs/core";
import { getVoiceManager } from "@fluxerjs/voice";
import { getGlobalColor, getMessageGuildId } from "./MessageHandler.mjs";
import { Dashboard } from "./dashboard/Dashboard.mjs";
import { hasHumansInChannel, iterateVoiceStates } from "./constants/VoiceStateResolver.mjs";


function getPlayerGuildId(player, fallbackChannel = null) {
  return cleanId(
    player?._guildId ??
    fallbackChannel?.guildId ??
    fallbackChannel?.guild?.id ??
    fallbackChannel?.server_id ??
    fallbackChannel?.serverId
  );
}

function getPlayerChannelId(player, fallbackChannelId = null) {
  return cleanId(player?._channelId ?? player?._home247Channel ?? fallbackChannelId);
}

/**
 * Check whether the bot actually has the Connect permission on a specific
 * voice channel. This uses @fluxerjs/core's PermissionFlags to test the
 * bitfield directly, rather than relying on gateway error messages which
 * conflate real permission denials with stale-session 401s.
 *
 * @param {import('@fluxerjs/core').Client} client
 * @param {string} channelId
 * @returns {boolean} true if the bot has Connect (and Speak) on the channel
 */
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
        && perms.has(PermissionFlags.UseVAD);
  } catch (e) {
    logger.warn("[PlayerManager] botHasVoicePermissions check failed:", e?.message);
    return true;
  }
}

/**
 * Sanitize raw voice-join error messages into user-friendly text.
 *
 * IMPORTANT: A 401/"permission" error from the gateway does NOT always mean
 * the bot lacks the Connect permission. The Fluxer gateway can also return 401
 * when the bot's previous voice session hasn't been cleaned up yet (stale
 * session race). In that case the bot DOES have Connect — it's a transient
 * error, not a real permission denial.
 *
 * To tell the difference, we check the actual channel permissions using
 * botHasVoicePermissions(). If the bot HAS Connect but got 401, it's a
 * stale session ("SESSION_RACE"), not a real permission error ("PERMISSION").
 */
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

/**
 * PlayerManager class.
 */
export class PlayerManager {
  /** @type {SettingsManager} */
  settings;

  /** @type {CommandHandler} */
  commands;

  /** @type {Map<string, Player>} Keyed by cleaned channel ID */
  playerMap = new Map();

  /** @type {Map<string, Set<string>>} Reverse index: guildId → Set<channelId> for O(1) guild lookups */
  _guildPlayerIndex = new Map();

  /** @type {Set<string>} Channel IDs currently being joined (not yet in playerMap) */
  _pendingJoins = new Set();

  /** @type {Map<string, {timer, songUrl, startedAtMs}>} Pending scrobble timers keyed by channel ID.
   *  Prevents duplicate scrobbles when startplay fires multiple times. */
  _pendingScrobbleTimers = new Map();

  /** @type {Object} */
  config;

  /** @type {Object} */
  playerConfig;

  /** @type {import("./constants/Locale.mjs").Locale|null} */
  locale = null;

  /** @type {import("./dashboard/Dashboard.mjs").Dashboard|null} */
  dashboard = null;

  /**
   * @param {SettingsManager} settings
   * @param {CommandHandler} commands
   * @param {Object} config
   * @param {Object} config.config  - Parsed config.json
   * @param {Object} config.player  - Config data passed to new Player instances
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

  /**
   * Add a channel to the guild→player reverse index.
   * Called after a successful player join.
   * @param {string} guildId
   * @param {string} channelId
   */
  _indexPlayer(guildId, channelId) {
    const gId = cleanId(guildId);
    const cId = cleanId(channelId);
    if (!gId || !cId) return;
    let set = this._guildPlayerIndex.get(gId);
    if (!set) { set = new Set(); this._guildPlayerIndex.set(gId, set); }
    set.add(cId);
  }

  /**
   * Remove a channel from the guild→player reverse index.
   * Called on player leave/destroy.
   * @param {string} guildId
   * @param {string} channelId
   */
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

  /**
   * Get all [channelId, Player] entries for a guild.
   * Uses the reverse index for O(1) guild lookup instead of O(n) scan.
   * @param {string} guildId
   * @returns {Array<[string, Player]>}
   */
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

  /**
   * Find a player by guildId and channelId using the reverse index.
   * @param {string} guildId
   * @param {string} channelId
   * @returns {Player|null}
   */
  getPlayerByGuildAndChannel(guildId, channelId) {
    const cId = cleanId(channelId);
    const players = this.getGuildPlayers(guildId);
    for (const [mapChannelId, player] of players) {
      if (getPlayerChannelId(player, mapChannelId) === cId) return player;
    }
    return null;
  }

  /**
   * Find a player by channelId alone (scans guild index first, then fallback).
   * @param {string} channelId
   * @returns {Player|null}
   */
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

  /**
   * Forward player lifecycle/state events to the dashboard pub/sub channels.
   *
   * IMPORTANT: Events are sent in standard { type, data } format so
   * the backend (backend-master) PlayerManager can parse them correctly.
   *
   * Two channels are used:
   *   {platform}:players         — global, for init/close lifecycle events
   *   {platform}:player_{id}     — per-player, for playback/queue/volume events
   *
   * @param {Player} player
   * @param {Object} [context]
   * @param {string|null} [context.channelId]
   * @param {string|null} [context.guildId]
   * @returns {Player}
   */
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

  /**
   * Translate a locale key using the message's guild locale.
   * @param {Object} message
   * @param {string} key
   * @param {Object} [replacements={}]
   * @returns {string}
   */
  _t(message, key, replacements = {}) {
    if (!this.locale) return key;
    const guildId = getMessageGuildId(message);
    return this.locale.translate(guildId, key, replacements);
  }

  /**
   * Attempt to detect the voice channel a user is currently in.
   * @param {Message} message
   * @param {Object} [settings]
   * @returns {Promise<{channelId: string|null, alreadyInVoice: boolean, hasHumans: boolean}>}
   */
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

  /**
   * Get or create a player for the user's voice channel.
   * @param {Message} message
   * @param {boolean} [promptJoin=true]
   * @param {boolean} [verifyUser=true]
   * @param {boolean} [shouldJoin=false]
   * @returns {Promise<Player|null>}
   */
  async getPlayer(message, promptJoin = true, verifyUser = true, shouldJoin = false) {
    const guildId = getMessageGuildId(message);
    const cleanGuildId = cleanId(guildId);

    const { channelId: userChannelId } = await this.checkVoiceChannels(message);
    const cleanUserChannelId = cleanId(userChannelId);

    if (cleanUserChannelId) {
      const player = this.playerMap.get(cleanUserChannelId)
          ?? this.getPlayerByGuildAndChannel(cleanGuildId, cleanUserChannelId);
      if (player) {
        player.textChannel = message.channel;
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
          first[1].textChannel = message.channel;
          return first[1];
        }
        message.reply(this._t(message, "responses._common.noVoiceStrict"));
        return null;
      }

      const match = serverPlayers.find(([, player]) =>
        getPlayerChannelId(player) === cleanUserChannelId
      );
      if (match) {
        match[1].textChannel = message.channel;
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

  /**
   * Prompt the user to select a voice channel.
   * @param {Message} msg
   * @returns {Promise<string|false>}
   */
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

  /**
   * Make the player leave its current voice channel.
   * @param {Message} msg
   * @param {string} [cid]
   */
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

  /**
   * Restore saved volume for a player from server settings.
   * @param {Player} player
   * @param {string} guildId
   */
  _restorePlayerVolume(player, guildId) {
    const savedVol = this.settings?.getServer?.(guildId)?.get?.("volume");
    if (savedVol !== undefined && savedVol !== null) {
      const vol = Number(savedVol);
      if (!isNaN(vol)) player.setVolume(vol / 100);
    }
  }

  /**
   * Create and register a new Player for the given voice channel.
   * @param {Message} message
   * @param {string} cid - Voice channel ID
   * @returns {Promise<Player|null>}
   */
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
      existing.textChannel = message.channel;
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
      nodelink:           this.config.nodelink,
      moonlink:           this.playerConfig?.moonlink ?? null,
      revoice:            this.playerConfig?.revoice ?? null,
      settingsMgr:        this.settings,
      getPrefix:          (guildId) => this.commands.getPrefix(guildId),
      observedVoiceUsers: this.observedVoiceUsers ?? null,
      voiceCache:          this.voiceCache ?? null,
      locale:             this.locale ?? null,
      trackOptions:       this.trackOptions ?? null,
    });

    player.textChannel = message.channel;
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

      if (mode247 === "auto" || mode247 === "on") {
        logger.inactivity(`[PlayerManager] autoleave suppressed for 24/7 ${mode247} channel ${activeChannelId} (guild ${guildId})`);
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

      let desc;
      if (mode247 === "on") {
        desc = this.locale?.translate(guildId, "responses.join.autoLeave247On", { channel: `<#${activeChannelId}>`, prefix })
          ?? `Left channel <#${activeChannelId}> because of inactivity.\nI'll rejoin automatically when the bot restarts (${prefix}247 on mode).`;
      } else if (mode247 === "auto") {
        desc = this.locale?.translate(guildId, "responses.join.autoLeave247Auto", { channel: `<#${activeChannelId}>`, prefix })
          ?? `Left channel <#${activeChannelId}> — reconnecting automatically (${prefix}247 auto mode)...`;
      } else {
        desc = this.locale?.translate(guildId, "responses.join.autoLeaveInactive247", { channel: `<#${activeChannelId}>`, prefix })
          ?? `Left channel <#${activeChannelId}> because of inactivity.\nIf you want me to stay in voice, use \`${prefix}247 on/auto\``;
      }
      if (typeof ch?.send === "function") {
        ch.send({ embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(desc)], allowedMentions: { parse: [] } }).catch(err => {
          if (err.code === 'MISSING_PERMISSIONS' || err.statusCode === 403) {
            logger.warn(`[PlayerManager] Cannot send autoleave message in channel ${ch.id} — missing permissions`);
          }
        });
      }
    });

    player.on("message", (m) => {
      let ch       = player.textChannel;
      const guildId = cleanId(player._guildId ?? ch?.guildId ?? ch?.guild?.id ?? getMessageGuildId({ channel: ch }));

      const raw      = this.settings.getServer(guildId)?.get("songAnnouncements");
      const disabled = raw === false || raw === 0 ||
          ["false","0","no","off","disable"].includes(String(raw).toLowerCase().trim());
      if (disabled) return;

      if (!ch || typeof ch.send !== "function") {
        try {
          const serverSettings = this.settings.getServer(guildId);
          const savedAnnChId = serverSettings?.get?.("announcementChannelId");
          if (savedAnnChId) {
            ch = this.commands?.client?.channels?.get?.(cleanId(savedAnnChId)) ?? null;
          }
        } catch(e) {
          logger.warn("[PlayerManager] Failed to resolve announcement channel:", e?.message);
        }
      }
      if (!ch || typeof ch.send !== "function") {
        try {
          const guild = this.commands?.client?.guilds?.get?.(guildId);
          if (guild?.systemChannelId) {
            ch = guild.channels?.get?.(guild.systemChannelId) ?? null;
          }
        } catch(e) {
          logger.warn("[PlayerManager] Failed to resolve system channel:", e?.message);
        }
      }
      if (!ch || typeof ch.send !== "function") {
        try {
          const guild = this.commands?.client?.guilds?.get?.(guildId);
          if (guild?.channels) {
            for (const c of (guild.channels.values?.() ?? [])) {
              if (c.isTextBased?.() || c.type === 0 || c.type === "GUILD_TEXT") {
                ch = c;
                break;
              }
            }
          }
        } catch(e) {
          logger.warn("[PlayerManager] Failed to find fallback text channel:", e?.message);
        }
      }
      if (!ch || typeof ch.send !== "function") return;

      if (!player.textChannel) player.textChannel = ch;

      const payload = typeof m === "object" && Array.isArray(m.embeds)
        ? { ...m, allowedMentions: { parse: [] } }
        : { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(m)], allowedMentions: { parse: [] } };
      ch.send(payload).catch(err => {
        if (err.code === 'MISSING_PERMISSIONS' || err.statusCode === 403) {
          logger.warn(`[PlayerManager] Cannot send player message in channel ${ch.id} — missing permissions`);
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
          if (player._revoice && player._channelId) {
            try { player._revoice._leaveGateway(player._channelId, player._guildId ?? player._resolveGuildId()); } catch(e) { logger.warn("[PlayerManager] Failed to leave gateway during retry:", e?.message); }
            try { player._revoice.deleteConnection(player._channelId); } catch(e) { logger.warn("[PlayerManager] Failed to delete connection during retry:", e?.message); }
          }
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

  /**
   * Handle the "startplay" event for Last.fm: send now-playing notification
   * to all linked users in the voice channel, and schedule a deferred scrobble
   * after the track has played for long enough (50% duration or 4 min).
   *
   * @param {Player} player
   * @param {Object} song - Track object
   */
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
