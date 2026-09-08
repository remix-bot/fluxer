/**
 * @module dashboard/RpcHandlersMixin
 * @description Remote-control concern for {@link Dashboard}: the dashboard RPC
 * "function" dispatch (runFunction — join / pausePlayback / resumePlayback / skip /
 * volume / addToQueue / testConnection / voiceState / leave), the login-code
 * verification (confirmLogin) and the authorization / player-lookup helpers.
 *
 * These methods are applied onto the Dashboard class prototype via
 * {@link applyMixins} — `this` is a Dashboard instance.
 */

import { Dashboard } from "./Dashboard.mjs";
import { Utils, cleanId } from "../utils/Utils.mjs";
import { logger } from "../core/Logger.mjs";
import { iterateVoiceStates } from "../voice/VoiceStateResolver.mjs";

/**
 * @type {object}
 * @description RPC handlers mixin — applied to Dashboard.
 */
const RpcHandlersMixin = {
  /**
   * Execute a remote dashboard function (e.g. join, pause, volume).
   * @async
   * @param {object} params - Function call parameters.
   * @param {string} params.func - The function name to execute.
   * @param {object} [params.data] - Additional data for the function.
   * @param {string} [params.data.user] - The user ID making the request.
   * @returns {Promise<object>} Result object with `message` or `error`.
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
            voiceChannel = await chMgr.fetch(params.data.channel).catch(() => null);
            if (params.data.text) textChannel = await chMgr.fetch(params.data.text).catch(() => null);
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
            } catch (e) { logger.warn("[Dashboard] Error:", e?.message); }
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
          } catch (e) { logger.warn("[Dashboard] Error:", e?.message); }
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
  },

  /**
   * Verify that the given user is allowed to control the given player.
   * Bot owners bypass the check; otherwise the user must be in the same voice channel.
   * @private
   * @param {object} user - The user attempting to control the player.
   * @param {object} player - The Player instance to control.
   * @returns {string|null} An error message if unauthorized, or null if authorized.
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
  },

  /**
   * Verify that the given user is a member of the specified guild.
   * Bot owners bypass the check.
   * @private
   * @async
   * @param {object} user - The user to verify.
   * @param {string} guildId - The guild ID to check membership in.
   * @returns {Promise<string|null>} An error message if not a member, or null if authorized.
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
  },

  /**
   * Look up a player by channel ID, guild ID, or player ID.
   * @private
   * @param {string} id - Channel ID, guild ID, or player ID.
   * @returns {object|null} The matching Player instance, or null.
   */
  _getPlayerById(id) {
    return this.remix.players.playerMap.get(id)
        ?? [...this.remix.players.playerMap.values()].find(
            p => p._channelId === id || p._guildId === id
        )
        ?? null;
  },

  /**
   * Verify a dashboard login code for a user.
   * @async
   * @param {string} user - The user ID.
   * @param {string} code - The login code to verify.
   * @returns {Promise<string|null>} An error message if verification fails, or null on success.
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
  },
};

export default RpcHandlersMixin;
export { RpcHandlersMixin };
