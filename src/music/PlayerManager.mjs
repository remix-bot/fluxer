/**
 * @module src/music/PlayerManager
 * @description Manages all Player instances. Handles player lifecycle (spawn,
 * join, leave, destroy), voice channel resolution, dashboard events, and
 * autoleave suppression for 24/7 channels.
 *
 * Base class: class fields, constructor, the guild/channel player index,
 * lookups and getPlayer. Dashboard event wiring and Last.fm scrobble
 * scheduling live in PlayerEventsMixin.mjs; voice-channel detection, channel
 * prompt, leave and player spawn/join live in PlayerLifecycleMixin.mjs.
 * Both mixins are applied to the class at the bottom of this file.
 */

import Player from "./player/index.mjs";
import { Utils, cleanId } from "../utils/Utils.mjs";
import { logger } from "../core/Logger.mjs";
import { getMessageGuildId } from "../ui/index.mjs";
import { applyMixins } from "../utils/mixins.mjs";
import PlayerEventsMixin, { getPlayerChannelId } from "./PlayerEventsMixin.mjs";
import PlayerLifecycleMixin from "./PlayerLifecycleMixin.mjs";


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

}

// Attach the split-out concerns: dashboard event wiring (PlayerEventsMixin)
// and voice-channel detection / player lifecycle (PlayerLifecycleMixin).
applyMixins(PlayerManager, PlayerEventsMixin, PlayerLifecycleMixin);
