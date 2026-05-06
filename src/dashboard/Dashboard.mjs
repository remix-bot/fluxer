import { Remix } from "../../index.mjs";
import { CommandBuilder, CommandHandler, Option } from "../CommandHandler.mjs";
import Player from "../Player.mjs";
import { Utils } from "../Utils.mjs";
import { RedisHandler } from "./RedisHandler.mjs";

/**
 * Fluxer OAuth2 configuration (standard OAuth2 authorization code flow).
 * @typedef {Object} FluxerOAuth2Config
 * @property {string} id         OAuth2 client ID
 * @property {string} secret     OAuth2 client secret
 * @property {string} redirectUri Redirect URI registered on the Fluxer app
 * @property {string} [apiBase]   Fluxer API base URL (default: https://api.fluxer.app)
 */

/** Default Fluxer API endpoints derived from the Fluxer platform docs */
const FLUXER_API_DEFAULTS = {
  apiBase: "https://api.fluxer.app/v1",
  tokenEndpoint: "https://api.fluxer.app/v1/oauth2/token",
  authorizeEndpoint: "https://fluxer.app/oauth2/authorize",
  userinfoEndpoint: "https://api.fluxer.app/v1/users/@me",
};

export class Dashboard {
  enabled = false;

  // Rate limiter for token exchange — prevents abuse of the OAuth2 code→token endpoint.
  // Tracks recent exchange timestamps per IP/request and rejects if exceeded.
  _tokenExchangeTimestamps = [];
  _tokenExchangeMaxPerWindow = 10; // max exchanges
  _tokenExchangeWindowMs = 60_000; // per 60s window

  /**
   * @param {Remix} remix
   * @param {Object} opts
   * @param {boolean} opts.enabled Whether the Dashboard is enabled and connections should be attempted
   * @param {Object} opts.redis Connection options passed directly to redis createClient
   * @param {FluxerOAuth2Config} [opts.fluxer] Fluxer OAuth2 credentials
   */
  constructor(remix, opts) {
    this.enabled = opts?.enabled;
    this.remix = remix;

    // Fluxer OAuth2 config
    const fluxer = opts?.fluxer ?? {};
    this.fluxer = {
      clientId:     fluxer.id,
      clientSecret: fluxer.secret,
      redirectUri:  fluxer.redirectUri,
      apiBase:      fluxer.apiBase  ?? FLUXER_API_DEFAULTS.apiBase,
      tokenEndpoint:    fluxer.tokenEndpoint    ?? FLUXER_API_DEFAULTS.tokenEndpoint,
      authorizeEndpoint: fluxer.authorizeEndpoint ?? FLUXER_API_DEFAULTS.authorizeEndpoint,
      userinfoEndpoint:  fluxer.userinfoEndpoint  ?? FLUXER_API_DEFAULTS.userinfoEndpoint,
    };

    if (!this.enabled) return this;

    this.redis = new RedisHandler(opts.redis);
    this.redis.setRequestHandler(async (data) => {
      switch (data.type) {
        // ── Existing request types ─────────────────────────────────────────────

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
            const guild = this.remix.client.guilds.get(data.key);
            if (!guild) return { error: "Server not found" };
            const member = await guild.members.fetch(data.accessor).catch(() => null);
            const server = Dashboard.convertServer(guild);
            if (member) {
              server.channels = server.channels.filter(c => {
                const ch = guild.channels.get(c.id);
                return ch ? ch.permissionsFor(member)?.has("ViewChannel") : false;
              });
            }
            return server;
          } catch (e) {
            const id = Utils.uid();
            console.log("[Dashboard] Server error:", id, e);
            return { error: "An error occurred. Id: " + id };
          }
        }

        case "commands":
          return this.remix.handler.commands.map(c =>
            Dashboard.convertCommand(c, this.remix.handler)
          );

        case "function":
          return await this.runFunction(data.params);

        // ── Fluxer OAuth2 request types ─────────────────────────────────────────

        case "fluxerAuthorizeUrl": {
          // Returns the full OAuth2 authorize URL for the dashboard frontend to redirect to
          const scopes = (data.scopes ?? ["identify"]).join(" ");
          const state = data.state ?? Utils.uid();
          const url = new URL(this.fluxer.authorizeEndpoint);
          url.searchParams.set("client_id", this.fluxer.clientId);
          url.searchParams.set("redirect_uri", this.fluxer.redirectUri);
          url.searchParams.set("response_type", "code");
          url.searchParams.set("scope", scopes);
          url.searchParams.set("state", state);
          return { url: url.toString(), state };
        }

        case "fluxerVerify": {
          // Backend sends a Fluxer access token — bot verifies it and returns user info.
          // The bot calls the Fluxer API's /users/@me with the access token to
          // confirm the user's identity, then cross-references with the bot's
          // internal user cache to confirm the user is known.
          const accessToken = data.accessToken;
          if (!accessToken) return { error: "Missing access token" };
          return await this.verifyFluxerToken(accessToken);
        }

        case "fluxerToken": {
          // Backend sends an authorization code — bot exchanges it for tokens.
          // Rate-limited to prevent token exchange abuse.
          const code = data.code;
          if (!code) return { error: "Missing authorization code" };
          return await this.rateLimitedExchange(code);
        }
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Fluxer OAuth2 Methods
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Verify a Fluxer OAuth2 access token by calling the Fluxer /users/@me endpoint.
   * Returns the user object from the Fluxer API, plus a `knownToBot` flag
   * indicating whether this user is cached in the bot's client.
   *
   * @param {string} accessToken
   * @returns {Promise<Object>} User data or error
   */
  async verifyFluxerToken(accessToken) {
    try {
      const res = await fetch(this.fluxer.userinfoEndpoint, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.log("[Dashboard] Fluxer token verification failed:", res.status, body);
        return { error: "Invalid or expired access token", status: res.status };
      }

      const fluxerUser = await res.json();
      if (!fluxerUser?.id) {
        return { error: "Fluxer API returned no user ID" };
      }

      // Cross-reference with the bot's cached users to check if this user
      // shares any servers with the bot (i.e. is a potential dashboard user).
      let botUser = null;
      try {
        botUser = await this.remix.client.users.fetch(fluxerUser.id).catch(() => null);
      } catch (_) {}

      return {
        id:            fluxerUser.id,
        username:      fluxerUser.username,
        displayName:   fluxerUser.displayName ?? fluxerUser.globalName ?? fluxerUser.username,
        avatar: {
          url: fluxerUser.avatar
            ? `https://cdn.fluxer.app/avatars/${fluxerUser.id}/${fluxerUser.avatar}.webp`
            : null,
        },
        knownToBot:    !!botUser,
        botUser:        botUser ? Dashboard.convertUser(botUser) : null,
      };
    } catch (e) {
      console.log("[Dashboard] Fluxer verify error:", e.message);
      return { error: "Failed to verify with Fluxer API: " + e.message };
    }
  }

  /**
   * Exchange an OAuth2 authorization code for access/refresh tokens.
   * This calls the Fluxer token endpoint directly.
   *
   * @param {string} code Authorization code from the OAuth2 redirect
   * @returns {Promise<Object>} Token data or error
   */
  /**
   * Rate-limited wrapper around exchangeFluxerCode.
   * Allows a maximum of _tokenExchangeMaxPerWindow exchanges per sliding window.
   * @param {string} code Authorization code
   * @returns {Promise<Object>} Token data or error
   */
  async rateLimitedExchange(code) {
    const now = Date.now();
    // Prune timestamps outside the current window
    this._tokenExchangeTimestamps = this._tokenExchangeTimestamps.filter(
      ts => now - ts < this._tokenExchangeWindowMs
    );
    if (this._tokenExchangeTimestamps.length >= this._tokenExchangeMaxPerWindow) {
      console.log("[Dashboard] Token exchange rate limit hit");
      return { error: "Rate limit exceeded. Try again later." };
    }
    this._tokenExchangeTimestamps.push(now);
    return await this.exchangeFluxerCode(code);
  }

  /**
   * Exchange an OAuth2 authorization code for access/refresh tokens.
   * This calls the Fluxer token endpoint directly.
   *
   * @param {string} code Authorization code from the OAuth2 redirect
   * @returns {Promise<Object>} Token data or error
   */
  async exchangeFluxerCode(code) {
    try {
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.fluxer.redirectUri,
        client_id: this.fluxer.clientId,
        client_secret: this.fluxer.clientSecret,
      });

      const res = await fetch(this.fluxer.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });

      if (!res.ok) {
        const errorBody = await res.text().catch(() => "");
        console.log("[Dashboard] Fluxer token exchange failed:", res.status, errorBody);
        return { error: "Token exchange failed", status: res.status };
      }

      const tokens = await res.json();
      if (!tokens.access_token) {
        return { error: "No access_token in response" };
      }

      return {
        accessToken:  tokens.access_token,
        tokenType:   tokens.token_type ?? "Bearer",
        expiresIn:   tokens.expires_in ?? null,
        refreshToken: tokens.refresh_token ?? null,
        scope:        tokens.scope ?? null,
      };
    } catch (e) {
      console.log("[Dashboard] Fluxer token exchange error:", e.message);
      return { error: "Failed to exchange code: " + e.message };
    }
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
        if (!user) return { error: "Invalid user" };
        let voiceChannel, textChannel;
        try {
          voiceChannel = await this.remix.client.channels.fetch(params.data.channel);
          textChannel = await this.remix.client.channels.fetch(params.data.text);
        } catch (e) {
          console.log(e);
          return { error: "Invalid Channel" };
        }
        // Verify the user has permission to join the voice channel
        const authErr = await this._authorizeUserInGuild(user, voiceChannel.guildId);
        if (authErr) return { error: authErr };
        if (this.remix.players.playerMap.has(voiceChannel.id)) return { message: "Already Connected" };
        const fakeMsg = { channel: { channel: textChannel, guildId: voiceChannel.guildId }, message: { guildId: voiceChannel.guildId } };
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
        // Sanitize: reject obviously malicious patterns (JavaScript URLs, data URIs)
        if (/^(javascript|data|vbscript):/i.test(query.trim())) {
          return { error: "Invalid query protocol" };
        }
        player.play(query);
        return { message: "Adding to queue" };
      }

      case "testConnection": {
        return { success: true };
      }

      default:
        return { error: "Unknown function: " + (params.func ?? "(none)") };
    }
  }

  // ── Authorization helpers ──────────────────────────────────────────────

  /**
   * Check if a user is a bot owner, or is in the same voice channel as the player.
   * Bot owners are always allowed. Otherwise the user must be physically in the
   * player's voice channel to control it.
   *
   * @param {import("fluxer.js").User|null} user
   * @param {Player} player
   * @returns {string|null} Error message, or null if authorized
   */
  _authorizePlayerControl(user, player) {
    // Bot owners bypass all checks
    if (user && this.remix.handler?.owners?.includes?.(user.id)) return null;

    if (!user) return "User not provided";

    const cleanUserId = String(user.id).replace(/\D/g, "");
    const cleanChanId = String(player._channelId ?? "").replace(/\D/g, "");
    if (!cleanChanId) return "Player has no active channel";

    // Check observed voice users — the authoritative voice state map.
    // Map key is userId, value is { channelId, guildId }.
    const observed = this.remix.observedVoiceUsers;
    if (observed) {
      for (const [mapUserId, info] of observed) {
        if (String(mapUserId).replace(/\D/g, "") === cleanUserId) {
          const infoChannelId = String(info.channelId ?? "").replace(/\D/g, "");
          if (infoChannelId === cleanChanId) return null; // authorized
        }
      }
    }

    return "You must be in the same voice channel as the bot to control playback";
  }

  /**
   * Verify the user has permission to perform an action in the target guild.
   * Bot owners are always allowed. Otherwise the user must be a member of the guild.
   *
   * @param {import("fluxer.js").User} user
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
   * @typedef APIUser
   * @property {string} id
   * @property {string} username
   * @property {string} displayName
   * @property {Object} avatar
   * @property {string} avatar.url
   */
  /**
   * @param {import("fluxer.js").User} user
   * @returns {APIUser}
   */
  static convertUser(user) {
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName ?? user.globalName ?? user.username,
      avatar: {
        url: user.displayAvatarURL() ?? user.defaultAvatarURL,
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
   * @param {import("fluxer.js").GuildChannel} channel
   */
  static convertChannel(channel) {
    const isVoice = channel.isVoiceBased?.() ?? false;
    // Collect voice members for voice channels
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
   * @param {import("fluxer.js").Guild} guild
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
      icon: typeof guild.iconURL === "function" ? guild.iconURL() : null,
      channelIds,
      description: guild.description ?? null,
      ownerId: guild.ownerId,
      channels: channelValues.map(Dashboard.convertChannel),
    };
  }

  /**
   * Lightweight server summary for player payloads.
   * Unlike convertServer(), this omits the full channels array to keep
   * per-player Redis messages small (especially for large guilds).
   * @param {import("fluxer.js").Guild} guild
   */
  static convertServerSummary(guild) {
    return {
      name: guild.name,
      id: guild.id,
      icon: typeof guild.iconURL === "function" ? guild.iconURL() : null,
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

  // ── Pub/Sub broadcast helpers ─────────────────────────────────────────────

  // Debounce map for playerUpdate — prevents flooding Redis with rapid updates.
  _playerUpdateTimers = new Map();

  /**
   * Global player update (broadcast to all dashboard listeners)
   * Debounced: rapid successive calls for the same player are coalesced
   * into a single publish every 500ms.
   * @param {Object} details
   * @param {Player} player
   */
  playerUpdate(details, player) {
    if (!this.enabled) return;
    const key = player._channelId ?? player._guildId ?? "unknown";
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
        console.log("[Dashboard] playerUpdate error:", e.message);
      }
    }, 500));
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
   * @param {import("fluxer.js").User} user
   */
  userUpdate(details, user) {
    if (!this.enabled) return;
    const channel = this.redis.platform + ":users";
    this.redis.send(channel, JSON.stringify({
      ...details,
      user: Dashboard.convertUser(user),
    }));
  }

  updateUser(details, user) {
    if (!this.enabled) return;
    const channel = this.redis.platform + ":user_" + user.id;
    this.redis.send(channel, JSON.stringify(details));
  }
}
