/**
 * @module dashboard/Serializers
 * @description Static data-conversion helpers for {@link Dashboard}: turn
 * users, videos/tracks, channels, guilds, players and commands into
 * dashboard-safe plain objects.
 *
 * This plain object is attached to the Dashboard class as static methods via
 * `Object.assign(Dashboard, Serializers)` at the bottom of Dashboard.mjs, so
 * `Dashboard.convertChannel(...)`, `Dashboard.convertPlayer(...)`, etc. keep
 * working for external callers.
 */

import { Dashboard } from "./Dashboard.mjs";
import { Utils, cleanId } from "../utils/Utils.mjs";
import { logger } from "../core/Logger.mjs";
import { iterateVoiceStates } from "../voice/VoiceStateResolver.mjs";

/**
 * @type {object}
 * @description Serializers — attached to Dashboard as static methods.
 */
const Serializers = {
  /**
   * Convert a user object to a dashboard-safe plain object.
   * @static
   * @param {object} user - The user.
   * @returns {{ id: string, username: string, displayName: string, avatar: { url: string } }}
   */
  convertUser(user) {
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
  },

  /**
   * Convert a video/track object to a dashboard-safe plain object.
   * @static
   * @param {object} vid - The video/track object from the player queue.
   * @returns {object|null} Sanitised video data, or null if input is falsy.
   */
  convertVideo(vid) {
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
  },

  /**
   * Convert a channel to a dashboard-safe plain object, including
   * voice participant info for voice channels.
   * @static
   * @param {object} channel - The channel.
   * @returns {object} Sanitised channel data.
   */
  convertChannel(channel) {
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
  },

  /**
   * Convert a guild (server) to a dashboard-safe plain object with channels.
   * @static
   * @param {object} guild - The guild.
   * @returns {object} Sanitised server data including channels and voice channels.
   */
  convertServer(guild) {
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
  },

  /**
   * Convert a guild to a lightweight summary object (no channels).
   * @static
   * @param {object} guild - The guild.
   * @returns {{ name: string, id: string, icon: string|null, description: string|null, ownerId: string|null }}
   */
  convertServerSummary(guild) {
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
  },

  /**
   * Convert a Player instance to a dashboard-safe serialisable object.
   * Includes queue, users, channel, and server info.
   * @static
   * @param {object} player - The Player instance.
   * @returns {object} Sanitised player data.
   */
  convertPlayer(player) {
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
  },

  /**
   * Convert a command option to a dashboard-safe plain object.
   * @static
   * @param {object} opt - The command option.
   * @returns {object} Sanitised option data.
   */
  convertOption(opt) {
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
  },

  /**
   * Convert a command (and its subcommands/options) to a dashboard-safe plain object.
   * @static
   * @param {object} com - The command object.
   * @param {object} commands - The CommandHandler instance (for usage generation).
   * @returns {object} Sanitised command data.
   */
  convertCommand(com, commands) {
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
  },
};

export default Serializers;
export { Serializers };
