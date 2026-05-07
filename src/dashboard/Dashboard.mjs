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
          try {
            const sharedUser = await this.remix.client.users.fetch(data.key).catch(() => null);
            if (!sharedUser) {
              logger.dashboard("[Dashboard] sharedServers: user not found for key:", data.key);
              return { error: "User not found" };
            }
            logger.dashboard("[Dashboard] sharedServers: fetching for user", sharedUser.id, sharedUser.username);
            const result = await this.remix.getSharedServers(sharedUser);
            logger.dashboard("[Dashboard] sharedServers: returning", Array.isArray(result) ? result.length + " servers" : JSON.stringify(result));
            return result;
          } catch (e) {
            const id = Utils.uid();
            logger.dashboard("[Dashboard] sharedServers error:", id, e);
            return { error: "Failed to fetch shared servers. Id: " + id };
          }
        }

        case "allServers": {
          // Returns ALL guilds the bot is in, without checking if a specific
          // user is a member. Used by the backend's OAuth2 fast path — the
          // backend fetches the user's guild IDs from the Fluxer API and
          // filters on its side, avoiding expensive per-guild member checks
          // on the bot.
          try {
            const guilds = [...this.remix.client.guilds.values()];
            logger.dashboard("[Dashboard] allServers: returning", guilds.length, "bot guilds");
            return guilds.map(guild => Dashboard.convertServerForList(guild));
          } catch (e) {
            const id = Utils.uid();
            logger.dashboard("[Dashboard] allServers error:", id, e);
            return { error: "Failed to fetch all servers. Id: " + id };
          }
        }

        case "server": {
          try {
            const guild = this.remix.client.guilds.get(data.key);
            if (!guild) return { error: "Server not found" };
            const member = await guild.members.fetch(data.accessor).catch(() => null);
            const server = Dashboard.convertServer(guild);
            if (member) {
              server.channels = server.channels.filter(c => {
                const ch = guild.channels.get(c.id);
                if (!ch) return false;
                // @fluxerjs/core GuildChannel objects do NOT expose a
                // permissionsFor() method like discord.js does.  If the method
                // exists, use it; otherwise the user is already verified as a
                // guild member so showing all channels is safe.
                if (typeof ch.permissionsFor === "function") {
                  try {
                    const perms = ch.permissionsFor(member);
                    return perms ? perms.has("ViewChannel") : false;
                  } catch (_) {
                    return true; // permission check failed — show channel anyway
                  }
                }
                return true;
              });
            }
            return server;
          } catch (e) {
            const id = Utils.uid();
            logger.dashboard("[Dashboard] Server error:", id, e);
            return { error: "An error occurred. Id: " + id };
          }
        }

        case "commands":
          return this.remix.handler.commands.map(c =>
              Dashboard.convertCommand(c, this.remix.handler)
          );

        case "function":
          return await this.runFunction(data.params);

        default:
          logger.dashboard("[Dashboard] Unknown request type:", data.type);
          return { error: "Unknown request type: " + (data.type ?? "(none)") };
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
          // Try fetch first (REST), fall back to cache
          voiceChannel = await this.remix.client.channels.fetch(params.data.channel).catch(() =>
            this.remix.client.channels.get(params.data.channel)
          );
          textChannel = await this.remix.client.channels.fetch(params.data.text).catch(() =>
            this.remix.client.channels.get(params.data.text)
          );
        } catch (e) {
          logger.dashboard("[Dashboard] join: channel lookup error:", e);
          return { error: "Invalid Channel" };
        }
        if (!voiceChannel) return { error: "Voice channel not found" };
        if (!textChannel) {
          // If text channel is missing, create a minimal stub so initPlayer can still work.
          // The text channel is only used for song announcements — missing it is non-fatal.
          logger.dashboard("[Dashboard] join: text channel not found, using stub");
          textChannel = { id: params.data.text, guildId: voiceChannel.guildId };
        }
        // Verify the user has permission to join the voice channel
        const authErr = await this._authorizeUserInGuild(user, voiceChannel.guildId);
        if (authErr) return { error: authErr };
        if (this.remix.players.playerMap.has(voiceChannel.id)) return { message: "Already Connected" };
        // Build a minimal fake message that satisfies PlayerManager.initPlayer().
        // The reply() returns a mock with edit() so initPlayer's statusMsg.edit
        // calls don't crash (Fluxer doesn't expose message edit from dashboards).
        const fakeMsg = {
          channel: { channel: textChannel, guildId: voiceChannel.guildId },
          message: { guildId: voiceChannel.guildId },
          reply: async () => ({ edit: async () => {}, catch: () => {} }),
        };
        this.remix.players.initPlayer(fakeMsg, voiceChannel.id);
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

      case "leave": {
        const player = this._getPlayerById(params.data.channel);
        if (!player) return { error: "Player not found" };
        const authErr = await this._authorizeUserInGuild(user, player._guildId);
        if (authErr) return { error: authErr };
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
   * Check if a user is authorized to control the player.
   * Authorization is granted if:
   *   1. User is a bot owner, OR
   *   2. User is in the same voice channel as the bot, OR
   *   3. User is a member of the same guild as the player (dashboard control)
   *
   * The third case is important for dashboard users who control the bot
   * remotely — they may not be in the voice channel themselves but still
   * need to control playback from the web interface.
   *
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

    // Check if user is in the same voice channel as the bot
    const observed = this.remix.observedVoiceUsers;
    if (observed) {
      for (const [mapUserId, info] of observed) {
        if (String(mapUserId).replace(/\D/g, "") === cleanUserId) {
          const infoChannelId = String(info.channelId ?? "").replace(/\D/g, "");
          if (infoChannelId === cleanChanId) return null;
        }
      }
    }

    // Dashboard control: if the user is a member of the same guild as
    // the player, allow control. This enables web dashboard users who
    // aren't in the voice channel to still control playback.
    const guildId = player._guildId;
    if (guildId) {
      const cleanGuildId = String(guildId).replace(/\D/g, "");
      const guild = this.remix.client?.guilds?.get?.(guildId) ??
          this.remix.client?.guilds?.get?.(cleanGuildId);
      if (guild?.members?.has?.(cleanUserId)) {
        return null;
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
    // Build avatar URL — @fluxerjs/core may expose displayAvatarURL() or
    // may just have a raw hash in user.avatar.  Handle both cases.
    let avatarUrl = null;
    try {
      if (typeof user.displayAvatarURL === "function") {
        avatarUrl = user.displayAvatarURL();
      }
    } catch (_) { /* not available */ }
    if (!avatarUrl && user.avatar) {
      const hash = String(typeof user.avatar === "object" ? (user.avatar.hash ?? user.avatar) : user.avatar);
      if (hash && hash !== "[object Object]") {
        const ext = hash.startsWith("a_") ? ".gif" : ".webp";
        avatarUrl = `https://cdn.fluxer.app/avatars/${user.id}/${hash}${ext}?size=128`;
      }
    }
    if (!avatarUrl && typeof user.defaultAvatarURL === "string") {
      avatarUrl = user.defaultAvatarURL;
    }
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName ?? user.globalName ?? user.username,
      avatar: { url: avatarUrl },
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
    // @fluxerjs/core exposes isVoice() on channels, not isVoiceBased().
    // Fall back to checking the type field if the method is unavailable.
    let isVoice = false;
    if (typeof channel.isVoice === "function") {
      isVoice = channel.isVoice();
    } else if (typeof channel.isVoiceBased === "function") {
      isVoice = channel.isVoiceBased();
    } else if (channel.isVoiceBased === true) {
      isVoice = true;
    } else {
      const t = channel.type;
      isVoice = t === 2 || t === 13 || t === "GUILD_VOICE" || t === "GUILD_STAGE_VOICE";
    }
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
      isVoice,
      voiceParticipants,
      mature: channel.nsfw ?? false,
      serverId: channel.guildId,
    };
  }

  /**
   * Build the CDN URL for a guild icon from the icon hash.
   * @fluxerjs/core Guild objects expose `icon` as a hash string (e.g. "a_b1234")
   * but do NOT expose an `iconURL()` method. Construct the URL manually.
   * @param {import("@fluxerjs/core").Guild} guild
   * @returns {string|null}
   */
  static guildIconURL(guild, size = 128) {
    if (!guild?.icon) return null;
    // guild.icon may be "hash" or "a_hash" (animated prefix)
    const hash = String(guild.icon);
    const ext = hash.startsWith("a_") ? ".gif" : ".webp";
    return `https://cdn.fluxer.app/icons/${guild.id}/${hash}${ext}?size=${size}`;
  }

  /**
   * Convert a guild into a server-list item with voice channels.
   * Used by both `allServers` and `getSharedServers` — keeps the
   * response format consistent and avoids duplicating the channel
   * extraction logic.
   *
   * @param {import("@fluxerjs/core").Guild} guild
   * @returns {{name: string, id: string, icon: string|null, description: string|null, ownerId: string|null, voiceChannels: Object[]}}
   */
  static convertServerForList(guild) {
    // ── Extract voice channels safely ────────────────────────────────────
    // guild.channels may be a Collection (Map) or an array depending on
    // the @fluxerjs/core version. Normalise to an array first.
    let channelArray = [];
    try {
      const ch = guild.channels;
      if (Array.isArray(ch)) {
        channelArray = ch;
      } else if (ch && typeof ch.values === "function") {
        channelArray = [...ch.values()];
      } else if (ch && typeof ch.forEach === "function") {
        ch.forEach(c => channelArray.push(c));
      }
    } catch (e) {
      logger.dashboard("[Dashboard] convertServerForList: channel extraction error:", e.message);
    }

    const voiceChannels = channelArray
        .filter(c => {
          // @fluxerjs/core exposes isVoice() on channels.
          // Fall back to isVoiceBased() or type field check.
          if (typeof c.isVoice === "function") return c.isVoice();
          if (typeof c.isVoiceBased === "function") return c.isVoiceBased();
          if (c.isVoiceBased === true) return true;
          // Fluxer API voice channel types: 2 = voice, 13 = stage
          const t = c.type;
          return t === 2 || t === 13 || t === "GUILD_VOICE" || t === "GUILD_STAGE_VOICE";
        })
        .map(c => {
          // Build voice participants list for this channel
          const voiceParticipants = [];
          try {
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
          } catch (e) {
            // Voice participants are optional — don't fail the whole response
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
        });

    return {
      name:   guild.name,
      id:     guild.id,
      icon:   Dashboard.guildIconURL(guild),
      description: guild.description ?? null,
      ownerId: guild.ownerId ?? null,
      voiceChannels,
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

    return {
      name: guild.name,
      id: guild.id,
      icon: Dashboard.guildIconURL(guild),
      channelIds,
      description: guild.description ?? null,
      ownerId: guild.ownerId,
      channels: channelValues.map(Dashboard.convertChannel),
    };
  }

  /**
   * Lightweight server summary for player payloads.
   * @param {import("@fluxerjs/core").Guild} guild
   */
  static convertServerSummary(guild) {
    return {
      name: guild.name,
      id: guild.id,
      icon: Dashboard.guildIconURL(guild),
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

    return {
      loop: (player.queue.loop ? 1 : 0) + (player.queue.songLoop ? 2 : 0),
      paused: player._paused,
      volume: (player.preferredVolume ?? 1) * 100,
      queue: {
        current: Dashboard.convertVideo(player.queue.current),
        data: (player.queue.data ?? []).map(v => Dashboard.convertVideo(v)),
      },
      users: (() => {
        if (!channel) return [];
        const g = channel?.guild ?? channel?.client?.guilds?.get(channel?.guildId);
        if (!g?.voice_states) return [];
        const vs = Array.isArray(g.voice_states) ? g.voice_states :
            typeof g.voice_states.values === "function" ? [...g.voice_states.values()] : Object.values(g.voice_states);
        const ids = [];
        for (const state of vs) {
          const scId = String(state?.channelId ?? state?.channel_id ?? "").replace(/\D/g, "");
          const chId = String(channel?.id ?? "").replace(/\D/g, "");
          if (scId === chId) {
            const memberId = String(state?.userId ?? state?.user_id ?? "");
            if (memberId) ids.push(memberId);
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
  // CRITICAL: The backend (backend-master) expects Stoat-compatible message
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
   * This method accepts details in that Stoat-compatible format directly.
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
