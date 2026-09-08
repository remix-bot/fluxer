/**
 * @module dashboard/Dashboard
 * @description Web dashboard backend controller. Manages Redis pub/sub communication
 * with the dashboard frontend, handles remote function calls (join, play, pause, etc.),
 * and provides static data-conversion helpers for bot entities.
 *
 * Base class of the dashboard split: class fields, construction (including the
 * Redis request-routing switch), the Redis/MySQL lifecycle, setBotId and the
 * player/user update broadcasts. The remote RPC handler methods (runFunction,
 * confirmLogin, authorization helpers) live in RpcHandlersMixin.mjs and the static
 * conversion helpers in Serializers.mjs — both are attached at the bottom of this file.
 */

import { CommandBuilder, CommandHandler, Option } from "../commands/index.mjs";
import { PermissionFlags } from "@fluxerjs/core";
import Player from "../music/player/index.mjs";
import { Utils, cleanId } from "../utils/Utils.mjs";
import { DatabaseManager } from "../db/DatabaseManager.mjs";
import { RedisHandler } from "./RedisHandler.mjs";
import { logger } from "../core/Logger.mjs";
import { iterateVoiceStates } from "../voice/VoiceStateResolver.mjs";
import { applyMixins } from "../utils/mixins.mjs";
import RpcHandlersMixin from "./RpcHandlersMixin.mjs";
import Serializers from "./Serializers.mjs";

/**
 * @class
 * @description Orchestrates the web dashboard: wires up Redis request/response handling,
 * converts bot data for the frontend, and exposes remote control functions.
 */
class Dashboard {
  /** @type {boolean} Whether the dashboard is enabled. */
  enabled = false;
  /** @type {number} Login code expiry time in milliseconds (default 6 hours). */
  expiryTime = 1000 * 60 * 60 * 6;

  /** @private */
  _playerUpdateTimers = new Map();

  /**
   * Create a new Dashboard instance.
   * @param {object} remix - The main bot (Remix) instance.
   * @param {object} opts - Dashboard options.
   * @param {boolean} [opts.enabled] - Whether the dashboard is enabled.
   * @param {object} [opts.redis] - Redis connection options.
   * @param {object} [opts.mysql] - MySQL connection options for the dashboard database.
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
            const guild = await this.remix.client.guilds.fetch(data.key).catch(() => null);
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
   * Set the bot ID for the Redis platform prefix.
   * @param {string} botId - The bot's user ID.
   */
  setBotId(botId) {
    if (!this.enabled || !this.redis) return;
    this.redis.platform = `fluxer`;
    this.redis.readyMessage();
  }

  /**
   * Broadcast a player state update to the dashboard via Redis.
   * Debounces non-init/close updates by 500ms.
   * @param {object} details - The update payload (e.g. `{ type: 'song' }`).
   * @param {object} player - The Player instance that changed.
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
   * Send a lightweight update to the player-specific Redis channel.
   * @param {object} details - The update payload.
   * @param {object} player - The Player instance.
   */
  updatePlayer(details, player) {
    if (!this.enabled) return;
    const channel = this.redis.platform + ":player_" + player._channelId;
    this.redis.send(channel, JSON.stringify(details));
  }

  /**
   * Broadcast a user update to the global users Redis channel.
   * @param {object} details - The update payload.
   * @param {object} user - The user.
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
   * Send a lightweight update to the user-specific Redis channel.
   * @param {object} details - The update payload.
   * @param {object} user - The user.
   */
  updateUser(details, user) {
    if (!this.enabled) return;
    const channel = this.redis.platform + ":user_" + user.id;
    this.redis.send(channel, JSON.stringify(details));
  }
}

// Attach the split-out concerns: the remote RPC handler methods (runFunction,
// confirmLogin and the authorization helpers) from RpcHandlersMixin.
applyMixins(Dashboard, RpcHandlersMixin);

// Re-attach the static conversion helpers (convertUser, convertChannel,
// convertPlayer, …) so external `Dashboard.convertX(...)` call sites keep working.
Object.assign(Dashboard, Serializers);

export { Dashboard };
