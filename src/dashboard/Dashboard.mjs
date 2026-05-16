import { CommandBuilder, CommandHandler, Option } from "../CommandHandler.mjs";
import Player from "../Player.mjs";
import { Utils } from "../Utils.mjs";
import { DatabaseManager } from "./DatabaseManager.mjs";
import { RedisHandler } from "./RedisHandler.mjs";
import { logger } from "../constants/Logger.mjs";

export class Dashboard {
  enabled = false;
  expiryTime = 1000 * 60 * 60 * 6; // 6 hours — login code expiry

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

    // DatabaseManager for login code verification (optional — only needed if
    // the backend uses the bot-based login flow instead of Fluxer OAuth2)
    if (opts.mysql) {
      this.db = new DatabaseManager(opts.mysql);
    }

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
            const channels = await guild.fetchChannels(); // execute before converting the guild, see caching
            const server = Dashboard.convertServer(guild);
            if (member) {
              server.channels = server.channels.filter(c => {
                const ch = channels.find(cl => c.id === cl.id);
                return ch ? ch.permissionsFor?.(member)?.has?.("ViewChannel") ?? true : true;
              });
              server.voiceChannels = server.voiceChannels.filter(c => {
                if (c.type !== 2) return false;
                const ch = channels.find(cl => c.id === cl.id);
                return ch ? ch.permissionsFor?.(member)?.has?.("ViewChannel") ?? true : true;
              });
            }
            return server;
          } catch (e) {
            const id = Utils.uid();
            logger.dashboard("[Dashboard] Server error:", id, e);
            return { error: "An error occurred. Id: " + id };
          }
        }

        case "allServers": {
          const guilds = await this.remix.client.user.fetchGuilds();
          return guilds.map(g => Dashboard.convertServer(g));
        }

        case "commands":
          return this.remix.handler.commands.map(c =>
              Dashboard.convertCommand(c, this.remix.handler)
          );

        case "function":
          return await this.runFunction(data.params);
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Dashboard Function Dispatch
  // ═══════════════════════════════════════════════════════════════════════════

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
          // Fluxer.js uses channels.get() for cached lookup and channels.fetch()
          // for REST fetch. Try fetch first (more reliable for uncached channels),
          // fall back to get (cache-only).
          const chMgr = this.remix.client.channels;
          if (typeof chMgr.fetch === "function") {
            voiceChannel = await chMgr.fetch(params.data.channel);
            if (params.data.text) textChannel = await chMgr.fetch(params.data.text);
          } else {
            voiceChannel = chMgr.get(params.data.channel);
            if (params.data.text) textChannel = chMgr.get(params.data.text);
          }
          if (!voiceChannel) return { error: "Voice channel not found" };

          // Validate textChannel: if it's a voice channel (type === 2) or missing,
          // find a suitable text channel from the guild instead
          const isText = (ch) => ch && (ch.type === 0 || ch.type === 5 || ch.type === 13 ||
              (typeof ch.isText === "function" && ch.isText()));

          if (!isText(textChannel)) {
            // Auto-pick a text channel from the guild
            const guild = this.remix.client.guilds.get(voiceChannel.guildId);
            if (guild?.channels) {
              const channelValues = typeof guild.channels.values === "function"
                  ? [...guild.channels.values()]
                  : Array.isArray(guild.channels) ? guild.channels : Object.values(guild.channels);
              // Prefer system channel, then first text channel
              const sysCh = guild.systemChannelId
                  ? channelValues.find(c => (c.id ?? c._id) === guild.systemChannelId && isText(c))
                  : null;
              textChannel = sysCh ?? channelValues.find(c => isText(c)) ?? null;
            }
            if (!textChannel) {
              logger.dashboard("[Dashboard] No text channel found for guild", voiceChannel.guildId, "— voice channel will be used as fallback");
              textChannel = voiceChannel; // last resort — _sendToTextChannel will handle it
            }
          }
        } catch (e) {
          logger.dashboard("[Dashboard] Error:", e);
          return { error: "Invalid Channel" };
        }
        // Verify the user has permission to join the voice channel
        const authErr = await this._authorizeUserInGuild(user, voiceChannel.guildId);
        if (authErr) return { error: authErr };
        if (this.remix.players.playerMap.has(voiceChannel.id)) {
          // Bot is already in this channel — just add the user to the player's
          // user list so the backend PlayerManager and SocketHandler can track
          // them for real-time updates and multi-user dashboard support.
          const existingPlayer = this.remix.players.playerMap.get(voiceChannel.id);
          if (existingPlayer && user && !existingPlayer._dashboardUsers) {
            existingPlayer._dashboardUsers = [];
          }
          if (existingPlayer && user && !existingPlayer._dashboardUsers.includes(String(user.id))) {
            existingPlayer._dashboardUsers.push(String(user.id));
            // Publish a "join" event on the player's per-channel Redis topic
            // so the backend PlayerManager adds this user to the player's users
            // list and the SocketHandler subscribes them.
            try {
              const pubChannel = this.remix.redis?.publisher ?? this.remix.redis;
              if (pubChannel && typeof pubChannel.publish === "function") {
                pubChannel.publish("fluxer:player_" + voiceChannel.id, JSON.stringify({
                  type: "join",
                  data: String(user.id)
                }));
              }
            } catch (_) { /* non-critical */ }
          }
          return { message: "Already Connected" };
        }
        // Build a minimal fake message that satisfies PlayerManager.initPlayer().
        // player.textChannel is set to message.channel, so it MUST be the real
        // textChannel object (which has .send()) — not a wrapper.  Without this,
        // ch?.send throws "not a function" when announceSong fires.
        const fakeMsg = {
          channel: textChannel,
          message: { guildId: voiceChannel.guildId },
          reply: async () => ({ edit: async () => {}, catch: () => {} }),
        };
        this.remix.players.initPlayer(fakeMsg, voiceChannel.id);
        // Track this dashboard user on the player for multi-user support
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
        if (isNaN(vol) || vol < 0 || vol > 150) return { error: "Volume must be between 0 and 150" };
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
        // Sanitize: reject obviously malicious patterns
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
        // Return the user's current voice channel (if any)
        if (!user) return { channel: null };
        const userId = String(user.id).replace(/\D/g, "");
        // Check observedVoiceUsers first (most reliable for Fluxer)
        if (this.remix.observedVoiceUsers) {
          for (const [mapUserId, info] of this.remix.observedVoiceUsers) {
            if (String(mapUserId).replace(/\D/g, "") === userId && info.channelId) {
              const ch = this.remix.client.channels.get(info.channelId);
              return {
                channelId: info.channelId,
                channel: ch ? Dashboard.convertChannel(ch) : { id: info.channelId, name: "Unknown" },
                guildId: info.guildId ?? ch?.guildId ?? null,
              };
            }
          }
        }
        // Fallback: check all guilds for the user's voice state
        const guilds = this.remix.client.guilds;
        const guildValues = guilds && typeof guilds.values === "function"
            ? [...guilds.values()] : guilds ? Object.values(guilds) : [];
        for (const guild of guildValues) {
          if (!guild?.voice_states) continue;
          const vs = Array.isArray(guild.voice_states) ? guild.voice_states :
              typeof guild.voice_states.values === "function" ? [...guild.voice_states.values()] : Object.values(guild.voice_states);
          for (const state of vs) {
            const stateUserId = String(state?.userId ?? state?.user_id ?? "").replace(/\D/g, "");
            if (stateUserId === userId && state.channelId) {
              const ch = this.remix.client.channels.get(state.channelId);
              return {
                channelId: state.channelId,
                channel: ch ? Dashboard.convertChannel(ch) : { id: state.channelId, name: "Unknown" },
                guildId: guild.id,
              };
            }
          }
        }
        return { channel: null };
      }

      case "leave": {
        const player = this._getPlayerById(params.data.channel);
        if (!player) return { error: "Player not found" };
        const authErr = await this._authorizeUserInGuild(user, player._guildId);
        if (authErr) return { error: authErr };
        // Remove this user from the dashboard users list
        if (player._dashboardUsers && user) {
          const idx = player._dashboardUsers.indexOf(String(user.id));
          if (idx !== -1) player._dashboardUsers.splice(idx, 1);
        }
        // If there are still dashboard users connected, don't destroy the player
        // — just remove this user. The player stays active for other users.
        if (player._dashboardUsers && player._dashboardUsers.length > 0) {
          // Publish a leave event for this user on the player channel
          try {
            const pubChannel = this.remix.redis?.publisher ?? this.remix.redis;
            if (pubChannel && typeof pubChannel.publish === "function") {
              pubChannel.publish("fluxer:player_" + params.data.channel, JSON.stringify({
                type: "leave",
                data: String(user.id)
              }));
            }
          } catch (_) { /* non-critical */ }
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

  // ── Authorization helpers ──────────────────────────────────────────────

  /**
   * Check if a user is a bot owner, or is in the same voice channel as the player.
   * @param {import("@fluxerjs/core").User|null} user
   * @param {Player} player
   * @returns {string|null} Error message, or null if authorized
   */
  _authorizePlayerControl(user, player) {
    if (user && this.remix.handler?.owners?.includes?.(user.id)) return null;
    if (!user) return "User not provided";

    const cleanUserId = String(user.id).replace(/\D/g, "");
    const cleanChanId = String(player._channelId ?? "").replace(/\D/g, "");
    if (!cleanChanId) return "Player has no active channel";

    const observed = this.remix.observedVoiceUsers;
    if (observed) {
      for (const [mapUserId, info] of observed) {
        if (String(mapUserId).replace(/\D/g, "") === cleanUserId) {
          const infoChannelId = String(info.channelId ?? "").replace(/\D/g, "");
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

  // ── Static converters ─────────────────────────────────────────────────────

  /**
   * @param {import("@fluxerjs/core").User} user
   */
  static convertUser(user) {
    // Build avatar URL using fluxerusercontent.com CDN pattern
    // user.avatar is the avatar hash string; user.id is the user ID
    let avatarUrl = "";
    if (user.avatar) {
      avatarUrl = `https://fluxerusercontent.com/avatars/${user.id}/${user.avatar}.webp`;
    } else if (typeof user.displayAvatarURL === "function") {
      try { avatarUrl = user.displayAvatarURL() ?? ""; } catch (_) {}
    } else if (typeof user.avatarURL === "function") {
      try { avatarUrl = user.avatarURL() ?? ""; } catch (_) {}
    }
    // Fallback to default avatar if no custom avatar
    if (!avatarUrl && user.discriminator) {
      avatarUrl = `https://fluxerusercontent.com/embed/avatars/${parseInt(user.discriminator || "0") % 5}.png`;
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
    const isVoice = channel.isVoice?.() ?? (type === 2) ?? false;
    // Discord channel types: 0=text, 1=DM, 2=voice, 3=group DM, 4=category,
    // 5=announcement, 13=stage, 15=form, 16=forum, 17=media
    const isCategory = type === 4;
    const isText = !isVoice && !isCategory && (
        type === 0 || type === 5 || type === 13 ||
        (typeof channel.isText === "function" && channel.isText())
    );
    let voiceParticipants = [];
    if (isVoice) {
      const guild = channel?.guild ?? channel?.client?.guilds?.get(channel?.guildId);
      if (guild?.voice_states) {
        const vs = Array.isArray(guild.voice_states) ? guild.voice_states :
            typeof guild.voice_states.values === "function" ? [...guild.voice_states.values()] : Object.values(guild.voice_states);
        for (const state of vs) {
          const scId = String(state?.channelId ?? state?.channel_id ?? "").replace(/\D/g, "");
          const chId = String(channel?.id ?? "").replace(/\D/g, "");
          if (scId === chId) {
            const user = guild.members?.get?.(state?.userId ?? state?.user_id)?.user;
            if (user && !user.bot) voiceParticipants.push(Dashboard.convertUser(user));
          }
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
        .filter(c => !c.isCategory); // exclude categories — they are not joinable

    // Build icon URL using fluxerusercontent.com CDN pattern
    // guild.icon is the icon hash string; guild.id is the server ID
    let iconUrl = null;
    if (guild.icon) {
      iconUrl = `https://fluxerusercontent.com/icons/${guild.id}/${guild.icon}.webp`;
    } else if (typeof guild.iconURL === "function") {
      try { iconUrl = guild.iconURL() ?? null; } catch (_) { iconUrl = null; }
    }

    return {
      name: guild.name,
      id: guild.id,
      icon: iconUrl,
      channelIds,
      description: guild.description ?? null,
      ownerId: guild.ownerId,
      channels: allChannels,
      // Frontend expects voiceChannels array for server list display
      voiceChannels: allChannels.filter(c => c.isVoice),
    };
  }

  /**
   * Lightweight server summary for player payloads.
   * @param {import("@fluxerjs/core").Guild} guild
   */
  static convertServerSummary(guild) {
    // Build icon URL using fluxerusercontent.com CDN pattern
    let iconUrl = null;
    if (guild.icon) {
      iconUrl = `https://fluxerusercontent.com/icons/${guild.id}/${guild.icon}.webp`;
    } else if (typeof guild.iconURL === "function") {
      try { iconUrl = guild.iconURL() ?? null; } catch (_) { iconUrl = null; }
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
    const cleanChannelId = channelId ? String(channelId).replace(/\D/g, "") : "";
    const cleanGuildId = player._guildId ? String(player._guildId).replace(/\D/g, "") : "";

    return {
      loop: (player.queue.loop ? 1 : 0) + (player.queue.songLoop ? 2 : 0),
      paused: player._paused,
      volume: (player.preferredVolume ?? 1) * 100,
      queue: {
        current: Dashboard.convertVideo(player.queue.current),
        data: (player.queue.data ?? []).map(v => Dashboard.convertVideo(v)),
      },
      users: (() => {
        if (!channel) return player._dashboardUsers ?? [];
        const g = channel?.guild ?? channel?.client?.guilds?.get(channel?.guildId);
        const ids = [];
        const seen = new Set();
        if (g?.voice_states) {
          const vs = Array.isArray(g.voice_states) ? g.voice_states :
              typeof g.voice_states.values === "function" ? [...g.voice_states.values()] : Object.values(g.voice_states);
          for (const state of vs) {
            const scId = String(state?.channelId ?? state?.channel_id ?? "").replace(/\D/g, "");
            const chId = String(channel?.id ?? "").replace(/\D/g, "");
            if (scId === chId) {
              const memberId = String(state?.userId ?? state?.user_id ?? "");
              if (memberId) { ids.push(memberId); seen.add(memberId); }
            }
          }
        }
        // Fallback: observedVoiceUsers (seeded from READY/GUILD_CREATE).
        // After a bot reload, guild.voice_states may only contain the bot's
        // own voice state, while observedVoiceUsers has ALL humans who were
        // already in voice when the bot reconnected.
        const ovu = player._observedVoiceUsers;
        if (ovu && cleanChannelId && cleanGuildId) {
          for (const [mapUserId, info] of ovu) {
            if (seen.has(mapUserId)) continue;
            const infoCh = String(info.channelId ?? "").replace(/\D/g, "");
            const infoG  = String(info.guildId   ?? "").replace(/\D/g, "");
            if (infoCh === cleanChannelId && infoG === cleanGuildId) {
              // Skip the bot itself
              const botId = player.client?.user?.id;
              if (botId && String(mapUserId) === String(botId)) continue;
              ids.push(String(mapUserId));
              seen.add(mapUserId);
            }
          }
        }
        // Merge dashboard users (connected via web UI but not necessarily in Discord voice)
        if (player._dashboardUsers) {
          for (const du of player._dashboardUsers) {
            if (!ids.includes(du)) ids.push(du);
          }
        }
        return ids;
      })(),
      channel: channel ? Dashboard.convertChannel(channel) : null,
      // Use lightweight server summary to avoid serializing hundreds of channels
      // per player update. The frontend should fetch full server details via
      // the "server" request type when needed.
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

  // ═══════════════════════════════════════════════════════════════════════════
  // Pub/Sub broadcast helpers
  //
  // CRITICAL: The backend (backend-master) expects standard message
  // formats on both the global :players channel and the per-player
  // :player_{channelId} channel.  The formats are:
  //
  //   Global (:players):
  //     { type: "init", player: serialisedPlayer }   — when bot joins a VC
  //     { type: "close", player: serialisedPlayer }  — when bot leaves a VC
  //
  //   Per-player (:player_{channelId}):
  //     { type: "startplay",  data: serialisedVideo }
  //     { type: "streamStartPlay", data: timestamp }
  //     { type: "stopplay",   data: null }
  //     { type: "pause",      data: { elapsedTime: ms } }
  //     { type: "resume",     data: { elapsedTime: ms } }
  //     { type: "volume",     data: number }
  //     { type: "queue",      data: serialisedQueueEvent }
  //     { type: "join",       data: userId }
  //     { type: "leave",      data: userId }
  // ═══════════════════════════════════════════════════════════════════════════

  // Debounce map for playerUpdate — prevents flooding Redis with rapid updates.
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

    // For "init" and "close" events, send immediately (no debounce) — the
    // backend relies on these for player lifecycle management.
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

    // All other events are debounced to avoid flooding Redis.
    if (this._playerUpdateTimers.has(key)) {
      clearTimeout(this._playerUpdateTimers.get(key));
    }
    this._playerUpdateTimers.set(key, setTimeout(() => {
      this._playerUpdateTimers.delete(key);
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

  // ═══════════════════════════════════════════════════════════════════════════
  // Login Confirmation (for backend-based DM code verification flow)
  // ═══════════════════════════════════════════════════════════════════════════

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
      res = await this.db.execute("SELECT * FROM login_codes WHERE user=?", [user]);
    } catch (e) {
      const id = Utils.uid();
      logger.dashboard("[Dashboard] MySQL error, id:", id, e);
      return "An error occurred, please contact an administrator if this happens again. Error id: `" + id + "`";
    }

    if (res.length === 0) return "If this is a valid code, it was not created for your account.";

    for (let i = 0; i < res.length; i++) {
      if (await this.db.compareHash(code, res[i].token)) {
        if (Date.now() - this.expiryTime > (new Date(res[i].createdAt)).getTime()) {
          return "Login token expired";
        }
        await this.db.execute("UPDATE login_codes SET verified=true WHERE id=?", [res[i].id]);
        return null; // success
      }
    }

    return "Invalid code.";
  }
}