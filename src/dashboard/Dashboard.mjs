/**
 * @file Dashboard.mjs — Dashboard — web dashboard backend with player status API, guild listing, and bot statistics endpoints
 * @module src.dashboard.Dashboard
 */

import { CommandBuilder, CommandHandler, Option } from "../CommandHandler.mjs";
import { PermissionFlags } from "@fluxerjs/core";
import Player from "../Player.mjs";
import { Utils, cleanId } from "../Utils.mjs";
import { DatabaseManager } from "./DatabaseManager.mjs";
import { RedisHandler } from "./RedisHandler.mjs";
import { logger } from "../constants/Logger.mjs";
import { iterateVoiceStates } from "../constants/VoiceStateResolver.mjs";

/**
 * Dashboard class.
 */
export class Dashboard {
  enabled = false;
  expiryTime = 1000 * 60 * 60 * 6;

  /**
   * @param {Remix} remix
   * @param {Object} opts
   * @param {boolean} opts.enabled Whether the Dashboard is enabled and connections should be attempted
   * @param {Object} opts.redis Connection options passed directly to redis createClient
   * @param {Object} [opts.mysql] MySQL connection config for login code verification
   */
  constructor(remix, opts) {
    this.enabled = opts?.enabled;
    this.remix = remix;

    if (!this.enabled) return this;

    if (opts.mysql) {
      this.db = new DatabaseManager(opts.mysql);
    }

    this.redis = new RedisHandler(opts.redis);
    this.redis.setRequestHandler(async (data) => {
      switch (data.type) {
        case "fetchPlayers":
          return [...this.remix.players.playerMap.values()]
              .filter(p => !p._destroyed)
              .map(p => { try { return Dashboard.convertPlayer(p); } catch(e) { logger.warn("[Dashboard] convertPlayer error:", e?.message); return null; } })
              .filter(Boolean);

        case "user": {
          const user = await this.remix.client.users.fetch(data.key).catch(() => null);
          if (!user) return { error: "User not found" };
          return Dashboard.convertUser(user);
        }

        case "sharedServers": {
          const sharedUser = await this.remix.client.users.fetch(data.key).catch(() => null);
          if (!sharedUser) return { error: "User not found" };
          return await this.remix.getSharedServers(sharedUser);
        }

        case "server": {
          try {
            const guild = await this.remix.client.guilds.fetch(data.key);
            if (!guild) return { error: "Server not found" };
            const member = await guild.members.fetch(data.accessor).catch(() => null);
            const channels = await guild.fetchChannels();
            const server = Dashboard.convertServer(guild);
            if (!member) {
              return { error: "You are not a member of this server" };
            }
            server.channels = server.channels.filter(c => {
              const ch = channels.find(cl => c.id === cl.id);
              return ch ? ch.permissionsFor?.(member)?.has?.(PermissionFlags.ViewChannel) ?? true : true;
            });
            server.voiceChannels = server.voiceChannels.filter(c => {
              if (c.type !== 2) return false;
              const ch = channels.find(cl => c.id === cl.id);
              return ch ? ch.permissionsFor?.(member)?.has?.(PermissionFlags.ViewChannel) ?? true : true;
            });
            return server;
          } catch (e) {
            const id = Utils.uid();
            logger.dashboard("[Dashboard] Server error:", id, e);
            return { error: "An error occurred. Id: " + id };
          }
        }

        case "allServers": {
          let guilds;
          try {
            guilds = await this.remix.client.user.fetchGuilds();
          } catch (e) {
            const id = Utils.uid();
            logger.dashboard("[Dashboard] allServers error:", id, e);
            return [];
          }
          let result = guilds.map(g => Dashboard.convertServer(g));
          if (data.accessor) {
            try {
              const accessorUser = await this.remix.client.users.fetch(data.accessor).catch(() => null);
              if (accessorUser) {
                const shared = await this.remix.getSharedServers(accessorUser);
                const sharedIds = new Set(shared.map(s => s.id));
                result = result.filter(g => sharedIds.has(g.id));
              }
            } catch(e) { logger.warn("[Dashboard] allServers accessor check:", e?.message); }
          }
          return result;
        }

        case "commands": {
          try {
            return this.remix.handler.commands.map(c =>
                Dashboard.convertCommand(c, this.remix.handler)
            );
          } catch (e) {
            logger.dashboard("[Dashboard] commands error:", e.message);
            return [];
          }
        }

        case "function":
          return await this.runFunction(data.params);

        default:
          return { error: "Unknown request type: " + (data.type ?? "(none)") };
      }
    });
  }


  /**
   * Set the bot ID for multi-bot Redis namespace isolation.
   * Updates the Redis platform string so each bot uses its own channel namespace.
   */
  setBotId(botId) {
    if (!this.enabled || !this.redis) return;
    this.redis.platform = `fluxer_${botId}`;
  }


  /**
   * @param {Object} params
   * @param {string} params.func
   * @param {any} params.data
   * @returns {Promise<any>}
   */
  async runFunction(params) {
    let user;
    if (params.data?.user) {
      try {
        user = await this.remix.client.users.fetch(params.data.user);
      } catch (e) {
        logger.dashboard("[Dashboard] Error:", e);
        return { error: "Invalid User" };
      }
    }
    switch (params.func) {
      case "join": {
        if (!user) return { error: "Invalid user" };
        let voiceChannel, textChannel;
        try {
          const chMgr = this.remix.client.channels;
          if (typeof chMgr.fetch === "function") {
            voiceChannel = await chMgr.fetch(params.data.channel);
            if (params.data.text) textChannel = await chMgr.fetch(params.data.text);
          } else {
            voiceChannel = chMgr.get(params.data.channel);
            if (params.data.text) textChannel = chMgr.get(params.data.text);
          }
          if (!voiceChannel) return { error: "Voice channel not found" };

          const isText = (ch) => ch && (ch.type === 0 || ch.type === 5 || ch.type === 13 ||
              (typeof ch.isText === "function" && ch.isText()));

          if (!isText(textChannel)) {
            const guild = this.remix.client.guilds.get(voiceChannel.guildId);
            if (guild?.channels) {
              const channelValues = typeof guild.channels.values === "function"
                  ? [...guild.channels.values()]
                  : Array.isArray(guild.channels) ? guild.channels : Object.values(guild.channels);
              const sysCh = guild.systemChannelId
                  ? channelValues.find(c => (c.id ?? c._id) === guild.systemChannelId && isText(c))
                  : null;
              textChannel = sysCh ?? channelValues.find(c => isText(c)) ?? null;
            }
            if (!textChannel) {
              logger.dashboard("[Dashboard] No text channel found for guild", voiceChannel.guildId, "— voice channel will be used as fallback");
              textChannel = voiceChannel;
            }
          }
        } catch (e) {
          logger.dashboard("[Dashboard] Error:", e);
          return { error: "Invalid Channel" };
        }
        const authErr = await this._authorizeUserInGuild(user, voiceChannel.guildId);
        if (authErr) return { error: authErr };
        if (this.remix.players.playerMap.has(voiceChannel.id)) {
          const existingPlayer = this.remix.players.playerMap.get(voiceChannel.id);
          if (existingPlayer && user && !existingPlayer._dashboardUsers) {
            existingPlayer._dashboardUsers = [];
          }
          if (existingPlayer && user && !existingPlayer._dashboardUsers.includes(String(user.id))) {
            existingPlayer._dashboardUsers.push(String(user.id));
            try {
              const pubChannel = this.remix.redis?.publisher ?? this.remix.redis;
              if (pubChannel && typeof pubChannel.publish === "function") {
                pubChannel.publish("fluxer:player_" + voiceChannel.id, JSON.stringify({
                  type: "join",
                  data: String(user.id)
                }));
              }
            } catch (_) { logger.warn("[Dashboard] Error:", _.message); }
          }
          return { message: "Already Connected" };
        }
        const fakeMsg = {
          channel: textChannel,
          message: { guildId: voiceChannel.guildId },
          reply: async () => ({ edit: async () => {}, catch: () => {} }),
        };
        this.remix.players.initPlayer(fakeMsg, voiceChannel.id);
        const newPlayer = this.remix.players.playerMap.get(voiceChannel.id);
        if (newPlayer && user) {
          if (!newPlayer._dashboardUsers) newPlayer._dashboardUsers = [];
          if (!newPlayer._dashboardUsers.includes(String(user.id))) {
            newPlayer._dashboardUsers.push(String(user.id));
          }
        }
        return { message: "Joining" };
      }

      case "pausePlayback": {
        const player = this._getPlayerById(params.data.player);
        if (!player) return { error: "Player not found" };
        const authErr = this._authorizePlayerControl(user, player);
        if (authErr) return { error: authErr };
        const msg = player.pause() || "Paused successfully";
        return { message: msg };
      }

      case "resumePlayback": {
        const player = this._getPlayerById(params.data.player);
        if (!player) return { error: "Player not found" };
        const authErr = this._authorizePlayerControl(user, player);
        if (authErr) return { error: authErr };
        const msg = player.resume() || "Resumed successfully";
        return { message: msg };
      }

      case "skip": {
        const player = this._getPlayerById(params.data.player);
        if (!player) return { error: "Player not found" };
        const authErr = this._authorizePlayerControl(user, player);
        if (authErr) return { error: authErr };
        const msg = player.skip() || "Skipped song";
        return { message: msg };
      }

      case "volume": {
        const player = this._getPlayerById(params.data.player);
        if (!player) return { error: "Player not found" };
        const authErr = this._authorizePlayerControl(user, player);
        if (authErr) return { error: authErr };
        const vol = Number(params.data.volume);
        if (isNaN(vol) || vol < 0 || vol > 2) return {
          error: "Volume must be between 0 and 2" };
        const msg = player.setVolume(vol);
        return { message: msg };
      }

      case "addToQueue": {
        const player = this._getPlayerById(params.data.player);
        if (!player) return { error: "Player not found" };
        if (!user) return { error: "Invalid user" };
        const authErr = this._authorizePlayerControl(user, player);
        if (authErr) return { error: authErr };
        const type = params.data.type;
        const query = params.data.query;
        if (!query || typeof query !== "string") return { error: "Missing or invalid query" };
        if (query.length > 500) return { error: "Query too long (max 500 characters)" };
        if (type === "radio") {
          const radio = this.remix.config.radio.find(e => e.name === query);
          if (!radio) return { error: "Invalid radio station" };
          player.playRadio(radio);
          return { message: "Adding radio station" };
        }
        if (/^(javascript|data|vbscript):/i.test(query.trim())) {
          return { error: "Invalid query protocol" };
        }
        player.play(query);
        return { message: "Adding to queue" };
      }

      case "testConnection": {
        return { success: true };
      }

      case "voiceState": {
        if (!user) return { channel: null };
        const userId = cleanId(user.id);
        if (this.remix.voiceCache) {
          for (const [mapUserId, info] of this.remix.voiceCache) {
            if (cleanId(mapUserId) === userId && info.channelId) {
              const ch = this.remix.client.channels.get(info.channelId);
              return {
                channelId: info.channelId,
                channel: ch ? Dashboard.convertChannel(ch) : { id: info.channelId, name: "Unknown" },
                guildId: info.guildId ?? ch?.guildId ?? null,
              };
            }
          }
        }
        const guilds = this.remix.client.guilds;
        const guildValues = guilds && typeof guilds.values === "function"
            ? [...guilds.values()] : guilds ? Object.values(guilds) : [];
        for (const guild of guildValues) {
          for (const vs of iterateVoiceStates(guild)) {
            const stateUserId = cleanId(vs.userId);
            if (stateUserId === userId && vs.channelId) {
              const ch = this.remix.client.channels.get(vs.channelId);
              return {
                channelId: vs.channelId,
                channel: ch ? Dashboard.convertChannel(ch) : { id: vs.channelId, name: "Unknown" },
                guildId: guild.id,
              };
            }
          }
        }
        return { channel: null };
      }

      case "leave": {
        if (!user) return { error: "Invalid user" };
        const playerId = params.data.channel ?? params.data.player;
        const player = this._getPlayerById(playerId);
        if (!player) return { error: "Player not found" };
        const authErr = await this._authorizeUserInGuild(user, player._guildId);
        if (authErr) return { error: authErr };
        if (player._dashboardUsers && user) {
          const idx = player._dashboardUsers.indexOf(String(user.id));
          if (idx !== -1) player._dashboardUsers.splice(idx, 1);
        }
        if (player._dashboardUsers && player._dashboardUsers.length > 0) {
          try {
            const pubChannel = this.remix.dashboard?.redis?.client ?? this.remix.redis?.client;
            if (pubChannel && typeof pubChannel.publish === "function") {
              pubChannel.publish("fluxer:player_" + playerId, JSON.stringify({
                type: "leave",
                data: String(user.id)
              }));
            }
          } catch (_) { logger.warn("[Dashboard] Error:", _.message); }
          return { message: "Left channel" };
        }
        try {
          await player.leave();
          return { message: "Left channel" };
        } catch (e) {
          return { error: "Failed to leave: " + e.message };
        }
      }

      default:
        return { error: "Unknown function: " + (params.func ?? "(none)") };
    }
  }


  /**
   * Check if a user is a bot owner, or is in the same voice channel as the player.
   * @param {import("@fluxerjs/core").User|null} user
   * @param {Player} player
   * @returns {string|null} Error message, or null if authorized
   */
  _authorizePlayerControl(user, player) {
    if (user && this.remix.handler?.owners?.includes?.(user.id)) return null;
    if (!user) return "User not provided";

    const cleanUserId = cleanId(user.id);
    const cleanChanId = cleanId(player._channelId);
    if (!cleanChanId) return "Player has no active channel";

    const observed = this.remix.voiceCache;
    if (observed) {
      const guildId = cleanId(player._guildId);
      const userLoc = observed.get(cleanUserId, guildId || undefined);
      if (userLoc) {
        const infoChannelId = cleanId(userLoc.channelId);
        if (infoChannelId === cleanChanId) return null;
      }
      for (const [mapUserId, info] of observed) {
        if (cleanId(mapUserId) === cleanUserId) {
          const infoChannelId = cleanId(info.channelId);
          if (infoChannelId === cleanChanId) return null;
        }
      }
    }

    return "You must be in the same voice channel as the bot to control playback";
  }

  /**
   * Verify the user has permission to perform an action in the target guild.
   * @param {import("@fluxerjs/core").User} user
   * @param {string} guildId
   * @returns {Promise<string|null>} Error message, or null if authorized
   */
  async _authorizeUserInGuild(user, guildId) {
    if (this.remix.handler?.owners?.includes?.(user.id)) return null;

    try {
      const guild = this.remix.client.guilds.get(guildId);
      if (!guild) return "Server not found";
      const member = await guild.members.fetch(user.id).catch(() => null);
      if (!member) return "You are not a member of this server";
      return null;
    } catch (e) {
      return "Failed to verify membership: " + e.message;
    }
  }

  /**
   * Find a player by its channel ID (key in playerMap)
   * @param {string} id
   * @returns {Player|null}
   */
  _getPlayerById(id) {
    return this.remix.players.playerMap.get(id)
        ?? [...this.remix.players.playerMap.values()].find(
            p => p._channelId === id || p._guildId === id
        )
        ?? null;
  }


  /**
   * @param {import("@fluxerjs/core").User} user
   */
  static convertUser(user) {
    let avatarUrl = "";
    if (user.avatar) {
      avatarUrl = `https://fluxerusercontent.com/avatars/${user.id}/${user.avatar}.webp`;
    } else if (typeof user.displayAvatarURL === "function") {
      try { avatarUrl = user.displayAvatarURL() ?? ""; } catch(e) { logger.warn("[Dashboard] displayAvatarURL:", e?.message); }
    } else if (typeof user.avatarURL === "function") {
      try { avatarUrl = user.avatarURL() ?? ""; } catch(e) { logger.warn("[Dashboard] avatarURL:", e?.message); }
    }
    if (!avatarUrl) {
      avatarUrl = `https://fluxerusercontent.com/embed/avatars/${parseInt(user.id?.slice(-4) ?? "0") % 5}.png`;
    }
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName ?? user.globalName ?? user.username,
      avatar: {
        url: avatarUrl,
      },
    };
  }

  /**
   * @param {Object} vid Track object stored in the fluxer Queue
   */
  static convertVideo(vid) {
    if (!vid) return null;
    const durationMs =
        typeof vid.duration === "number" ? vid.duration :
            typeof vid.duration === "object" && vid.duration?.seconds !== null ? vid.duration.seconds * 1000 :
                0;
    return {
      title: vid.title,
      url: vid.type === "radio" ? vid.author?.url : vid.url,
      videoId: vid.videoId,
      type: vid.type,
      duration: vid.type === "radio" ? "--:--" : Utils.prettifyMS(durationMs),
      description: vid.description,
      artist: {
        name: vid.author?.name ?? vid.artist,
        url: vid.author?.url,
      },
      thumbnail: vid.thumbnail,
    };
  }

  /**
   * @param {import("@fluxerjs/core").GuildChannel} channel
   */
  static convertChannel(channel) {
    const type = channel.type ?? 0;
    const isVoice = channel.isVoice?.() || type === 2;
    const isCategory = type === 4;
    const isText = !isVoice && !isCategory && (
        type === 0 || type === 5 || type === 13 ||
        (typeof channel.isText === "function" && channel.isText())
    );
    let voiceParticipants = [];
    if (isVoice) {
      const guild = channel?.guild ?? channel?.client?.guilds?.get(channel?.guildId);
      for (const vs of iterateVoiceStates(guild)) {
        const scId = cleanId(vs.channelId);
        const chId = cleanId(channel?.id);
        if (scId === chId) {
          const user = guild?.members?.get?.(vs.userId)?.user;
          if (user && !user.bot) voiceParticipants.push(Dashboard.convertUser(user));
        }
      }
    }

    return {
      name: channel.name,
      displayName: channel.name,
      id: channel.id,
      icon: null,
      description: channel.topic ?? null,
      type,
      isVoice,
      isCategory,
      isText,
      parentId: channel.parentId ?? channel.parent_id ?? null,
      voiceParticipants,
      mature: channel.nsfw ?? false,
      serverId: channel.guildId,
    };
  }

  /**
   * @param {import("@fluxerjs/core").Guild} guild
   */
  static convertServer(guild) {
    const channelStore = guild.channels;
    const channelIds = channelStore && typeof channelStore.keys === "function"
        ? [...channelStore.keys()]
        : [];
    const channelValues = channelStore && typeof channelStore.values === "function"
        ? [...channelStore.values()]
        : [];
    const allChannels = channelValues
        .map(Dashboard.convertChannel)
        .filter(c => !c.isCategory);

    let iconUrl = null;
    if (guild.icon) {
      iconUrl = `https://fluxerusercontent.com/icons/${guild.id}/${guild.icon}.webp`;
    } else if (typeof guild.iconURL === "function") {
      try { iconUrl = guild.iconURL() ?? null; } catch (e) { logger.warn("[Dashboard] iconURL error:", e?.message); iconUrl = null; }
    }

    return {
      name: guild.name,
      id: guild.id,
      icon: iconUrl,
      channelIds,
      description: guild.description ?? null,
      ownerId: guild.ownerId,
      channels: allChannels,
      voiceChannels: allChannels.filter(c => c.isVoice),
    };
  }

  /**
   * Lightweight server summary for player payloads.
   * @param {import("@fluxerjs/core").Guild} guild
   */
  static convertServerSummary(guild) {
    let iconUrl = null;
    if (guild.icon) {
      iconUrl = `https://fluxerusercontent.com/icons/${guild.id}/${guild.icon}.webp`;
    } else if (typeof guild.iconURL === "function") {
      try { iconUrl = guild.iconURL() ?? null; } catch (e) { logger.warn("[Dashboard] iconURL error:", e?.message); iconUrl = null; }
    }
    return {
      name: guild.name,
      id: guild.id,
      icon: iconUrl,
      description: guild.description ?? null,
      ownerId: guild.ownerId,
    };
  }

  /**
   * @param {Player} player
   */
  static convertPlayer(player) {
    const channelId = player._channelId;
    const channel = channelId ? player.client?.channels?.get(channelId) : null;
    const guild = channel?.guild ?? (player._guildId ? player.client?.guilds?.get(player._guildId) : null);
    const cleanChannelId = channelId ? cleanId(channelId) : "";
    const cleanGuildId = player._guildId ? cleanId(player._guildId) : "";

    const queue = player.queue ?? { loop: false, songLoop: false, current: null, data: [] };

    return {
      loop: (queue.loop ? 1 : 0) + (queue.songLoop ? 2 : 0),
      paused: !!player._paused,
      volume: Number.isFinite(player.preferredVolume) ? player.preferredVolume * 100 : 100,
      queue: {
        current: Dashboard.convertVideo(queue.current),
        data: Array.isArray(queue.data) ? queue.data.slice(0, 500).map(v => Dashboard.convertVideo(v)) : [],
      },
      users: (() => {
        if (!channel) return player._dashboardUsers ?? [];
        const g = channel?.guild ?? channel?.client?.guilds?.get(channel?.guildId);
        const ids = [];
        const seen = new Set();
        for (const vs of iterateVoiceStates(g)) {
          const scId = cleanId(vs.channelId);
          const chId = cleanId(channel?.id);
          if (scId === chId) {
            const memberId = vs.userId;
            if (memberId) { ids.push(memberId); seen.add(memberId); }
          }
        }
        const vc = player._voiceCache ?? player._observedVoiceUsers;
        if (vc && cleanChannelId && cleanGuildId) {
          if (typeof vc.getHumansInChannel === "function") {
            const channelHumans = vc.getHumansInChannel(cleanGuildId, cleanChannelId);
            for (const hid of channelHumans) {
              if (seen.has(hid)) continue;
              const botId = player.client?.user?.id;
              if (botId && String(hid) === String(botId)) continue;
              ids.push(String(hid));
              seen.add(hid);
            }
          } else {
            for (const [mapUserId, info] of vc) {
              if (seen.has(mapUserId)) continue;
              const infoCh = cleanId(info.channelId);
              const infoG = cleanId(info.guildId);
              if (infoCh === cleanChannelId && infoG === cleanGuildId) {
                const botId = player.client?.user?.id;
                if (botId && String(mapUserId) === String(botId)) continue;
                ids.push(String(mapUserId));
                seen.add(mapUserId);
              }
            }
          }
        }
        if (player._dashboardUsers) {
          for (const du of player._dashboardUsers) {
            if (!seen.has(du)) { ids.push(du); seen.add(du); }
          }
        }
        return ids;
      })(),
      channel: channel ? Dashboard.convertChannel(channel) : null,
      server: guild ? Dashboard.convertServerSummary(guild) : null,
    };
  }

  /**
   * @param {Option} opt
   */
  static convertOption(opt) {
    return {
      type: opt.type,
      name: opt.name,
      choices: opt.choices,
      description: opt.description,
      required: opt.required,
      uid: opt.uid,
      defaultValue: opt.defaultValue,
      dynamicDefaultPresent: !!opt.dynamicDefault,
    };
  }

  /**
   * @param {CommandBuilder} com
   * @param {CommandHandler} commands
   */
  static convertCommand(com, commands) {
    return {
      name: com.name,
      description: com.description,
      uid: com.uid,
      aliases: com.aliases,
      subcommands: com.subcommands.map(c => Dashboard.convertCommand(c, commands)),
      category: com.category,
      examples: com.examples,
      usage: commands.helpHandler?.commandUsage?.(com, {
        message: { guildId: null },
      }) ?? null,
      options: com.options.map(o => Dashboard.convertOption(o)),
    };
  }


  _playerUpdateTimers = new Map();

  /**
   * Global player update (broadcast to all dashboard listeners on {platform}:players).
   *
   * Used for two purposes:
   *  1. Lifecycle events: { type: "init" } / { type: "close" } — the backend
   *     PlayerManager uses these to add/remove Player objects.
   *  2. Full state broadcast: any other type — the full serialised player is
   *     included so dashboard frontends can update their UI.
   *
   * Debounced: rapid successive calls for the same player are coalesced
   * into a single publish every 500ms.
   *
   * @param {Object} details Must include a `type` field (e.g. "init", "close",
   *        "startplay", "stopplay", etc.) and may include a `data` field.
   * @param {Player} player
   */
  playerUpdate(details, player) {
    if (!this.enabled) return;
    const key = player._channelId ?? player._guildId ?? "unknown";

    if (details.type === "init" || details.type === "close") {
      try {
        const serialised = Dashboard.convertPlayer(player);
        this.redis.send(this.redis.platform + ":players", JSON.stringify({
          type: details.type,
          player: serialised,
        }));
      } catch (e) {
        logger.dashboard("[Dashboard] playerUpdate error:", e.message);
      }
      return;
    }

    if (this._playerUpdateTimers.has(key)) {
      clearTimeout(this._playerUpdateTimers.get(key));
    }
    this._playerUpdateTimers.set(key, setTimeout(() => {
      this._playerUpdateTimers.delete(key);
      if (player._destroyed) return;
      try {
        const serialised = Dashboard.convertPlayer(player);
        this.redis.send(this.redis.platform + ":players", JSON.stringify({
          ...details,
          player: serialised,
        }));
      } catch (e) {
        logger.dashboard("[Dashboard] playerUpdate error:", e.message);
      }
    }, 500));
  }

  /**
   * Per-player channel update (sent to {platform}:player_{channelId}).
   *
   * The backend PlayerManager.setupEvents() expects messages in the format:
   *   { type: "<eventType>", data: <payload> }
   *
   * This method accepts details in that standard format directly.
   *
   * @param {Object} details Must include `type` and optionally `data`.
   *   Examples:
   *     { type: "startplay", data: convertVideo(song) }
   *     { type: "pause", data: { elapsedTime: 12345 } }
   *     { type: "queue", data: serialisedQueueEvent }
   *     { type: "join", data: userId }
   * @param {Player} player
   */
  updatePlayer(details, player) {
    if (!this.enabled) return;
    const channel = this.redis.platform + ":player_" + player._channelId;
    this.redis.send(channel, JSON.stringify(details));
  }

  /**
   * Global user update (sent to {platform}:users).
   * @param {Object} details
   * @param {import("@fluxerjs/core").User} user
   */
  userUpdate(details, user) {
    if (!this.enabled) return;
    const channel = this.redis.platform + ":users";
    this.redis.send(channel, JSON.stringify({
      ...details,
      user: Dashboard.convertUser(user),
    }));
  }

  /**
   * Per-user channel update (sent to {platform}:user_{userId}).
   * @param {Object} details
   * @param {import("@fluxerjs/core").User} user
   */
  updateUser(details, user) {
    if (!this.enabled) return;
    const channel = this.redis.platform + ":user_" + user.id;
    this.redis.send(channel, JSON.stringify(details));
  }


  /**
   * Verify a login code submitted by a user via DM.
   * The backend stores the code in MySQL; this method compares the supplied
   * code against the stored (bcrypt-hashed) value.
   *
   * @param {string} user User ID
   * @param {string} code Plain-text code supplied by the user
   * @returns {Promise<string|null>} null on success, error message on failure
   */
  async confirmLogin(user, code) {
    if (!this.enabled) return "Dashboard not enabled.";
    if (!this.db) return "Dashboard database not configured.";

    let res;
    try {
      res = await this.db.execute("SELECT * FROM login_codes WHERE user=? AND (verified IS NULL OR verified !== true)", [user]);
    } catch (e) {
      const id = Utils.uid();
      logger.dashboard("[Dashboard] MySQL error, id:", id, e);
      return "An error occurred, please contact an administrator if this happens again. Error id: `" + id + "`";
    }

    if (res.length === 0) return "If this is a valid code, it was not created for your account.";

    for (let i = 0; i < res.length; i++) {
      if (res[i].verified) continue;
      if (await this.db.compareHash(code, res[i].token)) {
        if (Date.now() - this.expiryTime > (new Date(res[i].createdAt)).getTime()) {
          return "Login token expired";
        }
        await this.db.execute("UPDATE login_codes SET verified=true WHERE id=?", [res[i].id]);
        return null;
      }
    }

    return "Invalid code.";
  }
}
