import { Remix } from "../../index.mjs";
import { CommandBuilder, CommandHandler, Option } from "../CommandHandler.mjs";
import Player from "../Player.mjs";
import { Utils } from "../Utils.mjs";
import { DatabaseManager } from "./DatabaseManager.mjs";
import { RedisHandler } from "./RedisHandler.mjs";

export class Dashboard {
  enabled = false;
  expiryTime = 1000 * 60 * 60 * 6;
  /**
   * @param {Remix} remix
   * @param {Object} opts
   * @param {boolean} opts.enabled Whether the Dashboard is enabled and connections should be attempted
   * @param {Object} opts.redis Connection options passed directly to redis createClient
   * @param {Object} opts.mysql mysql2 pool options
   */
  constructor(remix, opts) {
    this.enabled = opts?.enabled;
    this.remix = remix;

    if (!this.enabled) return this;

    this.db = new DatabaseManager(opts.mysql);

    this.redis = new RedisHandler(opts.redis);
    this.redis.setRequestHandler(async (data) => {
      switch (data.type) {
        case "fetchPlayers":
          return [...this.remix.players.playerMap.values()].map(p => Dashboard.convertPlayer(p));

        case "user": {
          const user = await this.remix.client.users.fetch(data.key).catch(() => null);
          if (!user) return { error: "User not found" };
          return Dashboard.convertUser(user);
        }

        case "sharedServers":
          return await this.remix.getSharedServers(await this.remix.client.users.fetch(data.key).catch(() => null));

        case "server": {
          try {
            const guild = this.remix.client.guilds.cache.get(data.key);
            if (!guild) return { error: "Server not found" };
            const member = await guild.members.fetch(data.accessor).catch(() => null);
            const server = Dashboard.convertServer(guild);
            if (member) {
              server.channels = server.channels.filter(c => {
                const ch = guild.channels.cache.get(c.id);
                return ch ? ch.permissionsFor(member)?.has("ViewChannel") : false;
              });
            }
            return server;
          } catch (e) {
            const id = Utils.uid();
            console.log(e, id);
            return { error: "An error occurred. Id: " + id };
          }
        }

        case "commands":
          return this.remix.handler.commands.map(c => Dashboard.convertCommand(c, this.remix.handler));

        case "function":
          return await this.runFunction(data.params);
      }
    });
  }

  /**
   * @param {Object} params
   * @param {string} params.func
   * @param {any} params.data
   * @returns {Promise<any>}
   */
  async runFunction(params) {
    var user;
    if (!!params.data.user) {
      try {
        user = await this.remix.client.users.fetch(params.data.user);
      } catch (e) {
        console.log(e);
        return { error: "Invalid User" };
      }
    }
    switch (params.func) {
      case "join": {
        var voiceChannel, textChannel;
        try {
          voiceChannel = await this.remix.client.channels.fetch(params.data.channel);
          textChannel = await this.remix.client.channels.fetch(params.data.text);
        } catch (e) {
          console.log(e);
          return { error: "Invalid Channel" };
        }
        if (!user) return { error: "Invalid user" };
        if (this.remix.players.playerMap.has(voiceChannel.id)) return { message: "Already Connected" };
        const fakeMsg = { channel: { channel: textChannel, guildId: voiceChannel.guildId }, message: { guildId: voiceChannel.guildId } };
        this.remix.players.initPlayer(fakeMsg, voiceChannel.id);
        return { message: "Joining" };
      }

      case "pausePlayback": {
        var player = this._getPlayerById(params.data.player);
        if (!player) return { error: "Player not found" };
        var msg = player.pause() || "Paused successfully";
        return { message: msg };
      }

      case "resumePlayback": {
        var player = this._getPlayerById(params.data.player);
        if (!player) return { error: "Player not found" };
        var msg = player.resume() || "Resumed successfully";
        return { message: msg };
      }

      case "skip": {
        var player = this._getPlayerById(params.data.player);
        if (!player) return { error: "Player not found" };
        var msg = player.skip() || "Skipped song";
        return { message: msg };
      }

      case "volume": {
        var player = this._getPlayerById(params.data.player);
        if (!player) return { error: "Player not found" };
        var msg = player.setVolume(params.data.volume);
        return { message: msg };
      }

      case "addToQueue": {
        var player = this._getPlayerById(params.data.player);
        if (!player) return { error: "Player not found" };
        if (!user) return { error: "Invalid user" };
        var type = params.data.type;
        var query = params.data.query;
        if (type === "radio") {
          const radio = this.remix.config.radio.find(e => e.name === query);
          if (!radio) return { error: "Invalid radio station" };
          player.playRadio(radio);
          return { message: "Adding radio station" };
        }
        player.play(query);
        return { message: "Adding to queue" };
      }

      case "testConnection": {
        return { success: true };
      }
    }
  }

  /**
   * Find a player by its channel ID (key in playerMap)
   * @param {string} id
   * @returns {Player|null}
   */
  _getPlayerById(id) {
    return this.remix.players.playerMap.get(id)
      ?? [...this.remix.players.playerMap.values()].find(p => p._channelId === id || p._guildId === id)
      ?? null;
  }

  // ── Static converters ─────────────────────────────────────────────────────

  /**
   * @typedef APIUser
   * @property {string} id
   * @property {string} username
   * @property {string} displayName
   * @property {Object} avatar
   * @property {string} avatar.url
   */
  /**
   * @param {import("discord.js").User} user
   * @returns {APIUser}
   */
  static convertUser(user) {
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName ?? user.globalName ?? user.username,
      avatar: {
        url: user.displayAvatarURL() ?? user.defaultAvatarURL
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
      typeof vid.duration === "object" && vid.duration?.seconds != null ? vid.duration.seconds * 1000 :
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
        url: vid.author?.url
      },
      thumbnail: vid.thumbnail
    };
  }

  /**
   * @param {import("discord.js").GuildChannel} channel
   */
  static convertChannel(channel) {
    const isVoice = channel.isVoiceBased?.() ?? false;
    // Collect voice members for voice channels
    const voiceParticipants = isVoice
      ? [...(channel.members?.values() ?? [])].map(m => Dashboard.convertUser(m.user))
      : [];

    return {
      name: channel.name,
      displayName: channel.name,
      id: channel.id,
      icon: null,
      description: channel.topic ?? null,
      isVoice,
      voiceParticipants,
      mature: channel.nsfw ?? false,
      serverId: channel.guildId
    };
  }

  /**
   * @param {import("discord.js").Guild} guild
   */
  static convertServer(guild) {
    // Defensively handle guild.channels — @fluxerjs/core may not always
    // populate .cache (e.g. during recovery or for partial guild objects),
    // or guild.channels itself may be a Map/Collection without a .cache
    // wrapper. Fallback to guild.channels directly if .cache is absent.
    const channelStore = guild.channels?.cache ?? guild.channels;
    const channelIds = channelStore && typeof channelStore.keys === "function"
        ? [...channelStore.keys()]
        : [];
    const channelValues = channelStore && typeof channelStore.values === "function"
        ? [...channelStore.values()]
        : [];

    return {
      name: guild.name,
      id: guild.id,
      icon: typeof guild.iconURL === "function" ? guild.iconURL() : null,
      channelIds,
      description: guild.description ?? null,
      ownerId: guild.ownerId,
      channels: channelValues.map(Dashboard.convertChannel),
    };
  }

  /**
   * @param {Player} player
   */
  static convertPlayer(player) {
    const channelId = player._channelId;
    const channel = channelId ? player.client?.channels?.cache?.get(channelId) : null;
    const guild = channel?.guild ?? (player._guildId ? player.client?.guilds?.cache?.get(player._guildId) : null);

    return {
      loop: (player.queue.loop ? 1 : 0) + (player.queue.songLoop ? 2 : 0),
      paused: player._paused,
      volume: (player.preferredVolume ?? 1) * 100,
      queue: {
        current: Dashboard.convertVideo(player.queue.current),
        data: (player.queue.data ?? []).map(v => Dashboard.convertVideo(v))
      },
      users: channel?.members ? [...channel.members.values()].map(m => m.id) : [],
      channel: channel ? Dashboard.convertChannel(channel) : null,
      server: guild ? Dashboard.convertServer(guild) : null,
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
      dynamicDefaultPresent: !!opt.dynamicDefault
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
        message: { guildId: null }
      }) ?? null,
      options: com.options.map(o => Dashboard.convertOption(o)),
    };
  }

  // ── Pub/Sub broadcast helpers ─────────────────────────────────────────────

  /**
   * Global player update (broadcast to all dashboard listeners)
   * @param {Object} details
   * @param {Player} player
   */
  playerUpdate(details, player) {
    if (!this.enabled) return;
    const serialised = Dashboard.convertPlayer(player);
    this.redis.send(this.redis.platform + ":players", JSON.stringify({
      ...details,
      player: serialised
    }));
  }

  /**
   * Per-player channel update
   * @param {Object} details
   * @param {Player} player
   */
  updatePlayer(details, player) {
    if (!this.enabled) return;
    const channel = this.redis.platform + ":player_" + player._channelId;
    this.redis.send(channel, JSON.stringify(details));
  }

  /**
   * Global user update
   * @param {Object} details
   * @param {import("discord.js").User} user
   */
  userUpdate(details, user) {
    if (!this.enabled) return;
    const channel = this.redis.platform + ":users";
    this.redis.send(channel, JSON.stringify({
      ...details,
      user: Dashboard.convertUser(user)
    }));
  }

  updateUser(details, user) {
    if (!this.enabled) return;
    const channel = this.redis.platform + ":user_" + user.id;
    this.redis.send(channel, JSON.stringify(details));
  }

  /**
   * Verify a dashboard login code for a user
   * @param {string} user  User ID
   * @param {string} code  Plaintext code to check
   * @returns {Promise<string|null>} null on success, error string on failure
   */
  async confirmLogin(user, code) {
    if (!this.enabled) return "Dashboard not enabled.";
    var res;
    try {
      res = await this.db.execute("SELECT * FROM login_codes WHERE user=?", [user]);
    } catch (e) {
      const id = Utils.uid();
      console.log("[Dashboard] MySQL error, id: ", id, e);
      return "An error occurred, please contact an administrator. Error id: `" + id + "`";
    }
    if (res.length === 0) return "If this is a valid code, it was not created for your account.";
    for (let i = 0; i < res.length; i++) {
      if ((await this.db.compareHash(code, res[i].token))) {
        if (Date.now() - this.expiryTime > (new Date(res[i].createdAt)).getTime()) return "Login token expired";
        await this.db.execute("UPDATE login_codes SET verified=true WHERE id=?", [res[i].id]);
        return null;
      }
    }
    return "Invalid code.";
  }
}
