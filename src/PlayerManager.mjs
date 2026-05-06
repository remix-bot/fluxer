/**
 * PlayerManager.mjs — Manages voice channel players across servers
 *
 * Updated for moonlink.js: passes the MoonlinkManager instance into every
 * new Player so it can resolve tracks and retrieve session IDs.
 */

import Player from "./Player.mjs";
import { CommandHandler } from "./CommandHandler.mjs";
import { Message } from "./MessageHandler.mjs";
import { SettingsManager } from "./Settings.mjs";
import { Utils } from "./Utils.mjs";
import { logger } from "./constants/Logger.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getVoiceManager } from "@fluxerjs/voice";
import { getGlobalColor } from "./MessageHandler.mjs";

/** Helper — build a plain embed payload from a description string */
function mkEmbed(desc) {
  return { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(desc)] };
}

function cleanId(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function getMessageGuildId(message) {
  return message?.channel?.guildId ??
    message?.channel?.guild?.id ??
    message?.message?.guildId ??
    message?.message?.guild?.id ??
    message?.channel?.server_id ??
    message?.channel?.serverId ??
    message?.message?.server_id ??
    message?.message?.serverId ??
    null;
}

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

export class PlayerManager {
  /** @type {SettingsManager} */
  settings;

  /** @type {CommandHandler} */
  commands;

  /** @type {Map<string, Player>} */
  playerMap = new Map();

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
    this.spawnPlayer  = config.spawnPlayer ?? null;   // RecoveryManager.spawnPlayer — for 24/7 rejoin on autoleave
    this.timers       = config.timers ?? {};
  }

  /**
   * Forward player lifecycle/state events to the dashboard pub/sub channels.
   * This keeps the event bridge in one place so both regular joins and
   * background-spawned players can reuse it.
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

    const sendDashboardUpdate = (event, details = {}) => {
      if (!this.dashboard?.enabled) return;

      const payload = {
        event,
        guildId: cleanId(player._guildId ?? context.guildId),
        channelId: getPlayerChannelId(player, context.channelId),
        ...details,
      };

      this.dashboard.playerUpdate(payload, player);
      this.dashboard.updatePlayer(payload, player);
    };

    // Broadcast user list changes to the global :users channel when
    // someone joins or leaves the player's voice channel.
    const sendUserUpdates = (event) => {
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
        const details = {
          event,
          guildId: cleanId(player._guildId ?? context.guildId),
          channelId,
        };
        this.dashboard.userUpdate(details, member.user);
      }
    };

    player.on("roomfetched", () => {
      sendDashboardUpdate("roomfetched", { state: "connected" });
      sendUserUpdates("roomfetched");
    });

    player.on("startplay", () => {
      sendDashboardUpdate("startplay", { state: "playing" });
    });

    player.on("stopplay", () => {
      sendDashboardUpdate("stopplay", { state: "idle" });
    });

    player.on("playback", (playing) => {
      sendDashboardUpdate("playback", {
        state: playing ? "playing" : "paused",
        playing: !!playing,
      });
    });

    player.on("volume", (volume) => {
      sendDashboardUpdate("volume", { volume });
    });

    player.on("filter", (filter) => {
      sendDashboardUpdate("filter", { filter });
    });

    player.on("update", (scope) => {
      sendDashboardUpdate("update", { scope });
    });

    player.on("message", (message) => {
      sendDashboardUpdate("message", {
        message: typeof message === "string" ? message : null,
      });
    });

    player.on("autoleave", () => {
      sendUserUpdates("autoleave");
      sendDashboardUpdate("autoleave", {
        state: "disconnected",
        reason: "inactivity",
      });
    });

    player.on("leave", () => {
      sendUserUpdates("leave");
      sendDashboardUpdate("leave", {
        state: "disconnected",
        reason: "manual",
      });
    });

    player.queue?.on("queue", (queueEvent) => {
      sendDashboardUpdate("queue", { queueEvent });
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

  // ═══════════════════════════════════════════════════════════════════════════
  // Voice Channel Detection
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Attempt to detect the voice channel a user is currently in.
   * @param {Message} message
   * @returns {string|null} Voice channel ID or null
   */
  checkVoiceChannels(message) {
    if (!message) return null;

    const userId = message.author?.id ?? message.message?.author?.id;
    const guildId = getMessageGuildId(message);

    if (!userId) return null;
    if (!guildId) return null;

    const cleanGuild = cleanId(guildId);
    const seedObserved = (channelId) => {
      const cleanChannelId = cleanId(channelId);
      if (!cleanChannelId) return null;
      if (!this.observedVoiceUsers?.has(userId)) {
        this.observedVoiceUsers?.set(userId, { channelId: cleanChannelId, guildId: cleanGuild });
      }
      return cleanId(this.observedVoiceUsers?.get(userId)?.channelId) || cleanChannelId;
    };

    const observed = this.observedVoiceUsers?.get?.(userId);
    if (cleanId(observed?.guildId) === cleanGuild) {
      const observedChannelId = cleanId(observed?.channelId);
      if (observedChannelId) return observedChannelId;
    }

    try {
      const vm = getVoiceManager(this.commands.client);
      const voiceChannelId = vm?.getVoiceChannelId?.(guildId, userId);
      const seeded = seedObserved(voiceChannelId);
      if (seeded) return seeded;
    } catch (_) {}

    const memberVoiceChannelId =
      message?.member?.voice?.channelId ??
      message?.message?.member?.voice?.channelId ??
      null;
    {
      const seeded = seedObserved(memberVoiceChannelId);
      if (seeded) return seeded;
    }

    try {
      const guild =
        this.commands.client?.guilds?.get?.(guildId) ??
        this.commands.client?.guilds?.get?.(cleanGuild);
      const voiceStates = guild?.voice_states ?? guild?.voiceStates ?? null;
      if (voiceStates) {
        if (!Array.isArray(voiceStates) && typeof voiceStates === "object") {
          const direct = voiceStates[userId];
          const directChannelId =
            typeof direct === "string"
              ? direct
              : direct?.channelId ?? direct?.channel_id ?? null;
          const seeded = seedObserved(directChannelId);
          if (seeded) return seeded;
        }

        const entries = Array.isArray(voiceStates)
          ? voiceStates
          : typeof voiceStates.values === "function"
            ? voiceStates.values()
            : Object.values(voiceStates);

        for (const state of entries) {
          const stateUserId = state?.userId ?? state?.user_id ?? state?.id;
          const stateGuildId = cleanId(state?.guildId ?? state?.guild_id ?? guildId);
          if (stateUserId !== userId || stateGuildId !== cleanGuild) continue;
          const seeded = seedObserved(state?.channelId ?? state?.channel_id);
          if (seeded) return seeded;
        }
      }
    } catch (_) {}

    const liveGuildPlayers = [...this.playerMap.entries()].filter(([channelId, player]) => {
      const fallbackChannel =
        this.commands.client?.channels?.get?.(channelId) ??
        null;
      return getPlayerGuildId(player, fallbackChannel) === cleanGuild;
    });
    if (liveGuildPlayers.length === 1) {
      return getPlayerChannelId(liveGuildPlayers[0][1], liveGuildPlayers[0][0]) || cleanId(liveGuildPlayers[0][0]);
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Player Retrieval
  // ═══════════════════════════════════════════════════════════════════════════

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

    const userChannelId = this.checkVoiceChannels(message);
    const cleanUserChannelId = cleanId(userChannelId);

    if (cleanUserChannelId) {
      const player = this.playerMap.get(cleanUserChannelId)
          ?? [...this.playerMap.values()].find(p =>
            getPlayerChannelId(p) === cleanUserChannelId
          );
      if (player) {
        player.textChannel = message.channel;
        return player;
      }
    }

    const serverPlayers = cleanGuildId
        ? [...this.playerMap.entries()].filter(([, player]) => {
          return getPlayerGuildId(player) === cleanGuildId;
        })
        : [];

    if (serverPlayers.length > 0) {
      const channelList = serverPlayers.map(([chId]) => `<#${chId}>`).join(" or ");

      if (!userChannelId) {
        // verifyUser=false: allow controlling the bot without being in voice
        // (e.g. volume, clear, remove — admin-style controls).
        if (!verifyUser) {
          const first = serverPlayers[0];
          first[1].textChannel = message.channel;
          return first[1];
        }
        message.reply(mkEmbed(this._t(message, "responses._common.noVoiceStrict")));
        return null;
      }

      const match = serverPlayers.find(([, player]) =>
        String(player?._channelId ?? "").replace(/\D/g, "") === cleanUserChannelId
      );
      if (match) {
        match[1].textChannel = message.channel;
        return match[1];
      }

      // User is in a different channel than existing players.
      if (shouldJoin) {
        return new Promise((resolve) => {
          this.initPlayer(message, userChannelId, (p) => resolve(p));
        });
      }

      const prefix = (() => {
        try {
          return this.settings.getServer(guildId)?.get("prefix") ?? "%";
        } catch (_) { return "%"; }
      })();
      message.reply(mkEmbed(this._t(message, "responses._common.alreadyInChannel", { channels: channelList, prefix })));
      return null;
    }

    if (!userChannelId) {
      if (shouldJoin) {
        // Auto-detect failed — fall back to interactive channel selection prompt
        return this.promptVC(message);
      }
      message.reply(mkEmbed(this._t(message, "responses._common.noVoiceChannel")));
      return null;
    }

    if (shouldJoin) {
      return new Promise((resolve) => {
        this.initPlayer(message, userChannelId, (p) => resolve(p));
      });
    }

    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Channel Selection Prompt
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Prompt the user to select a voice channel.
   * @param {Message} msg
   * @returns {Promise<string|false>}
   */
  async promptVC(msg) {
    const autoDetected = this.checkVoiceChannels(msg);
    if (autoDetected) {
      return new Promise(resolve => this.initPlayer(msg, autoDetected, (p) => resolve(p)));
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
    const selectionMsg = await msg.reply(mkEmbed(
        (channelSelection ? channelSelection + "\n**..or** " + hint : "Please " + hint)
    ));

    return new Promise(resolve => {
      let unsubscribeReactions;
      let unsubscribeMessages;

      const cleanup = () => {
        unsubscribeMessages?.();
        unsubscribeReactions?.();
      };

      const timeout = setTimeout(() => {
        cleanup();
        msg.reply(mkEmbed(this._t(msg, "responses._common.voiceSelectionTimedOut")));
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
              this.initPlayer(msg, cid, (p) => resolve(p));
            },
            msg.author
        );
      }

      unsubscribeMessages = msg.channel.onMessageUser((m) => {
        const content = m.content?.toLowerCase() ?? "";
        if (content === "x") {
          clearTimeout(timeout);
          cleanup();
          m.reply(mkEmbed(this._t(m, "voice.join.cancelled")));
          resolve(false);
          return;
        }
        if (!this.commands.validateInput("voiceChannel", m.content, m)) {
          m.reply(mkEmbed(this._t(m, "responses._common.voiceSelectionInvalid")));
          return;
        }
        const channel = this.commands.formatInput("voiceChannel", m.content, m);
        clearTimeout(timeout);
        cleanup();
        this.initPlayer(m, channel, (p) => resolve(p));
      }, msg.author);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Leave
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Make the player leave its current voice channel.
   * @param {Message} msg
   * @param {string} [cid]
   */
  async leave(msg, cid) {
    if (!cid) {
      const guildId = getMessageGuildId(msg);
      if (guildId) {
        const matchedEntry = [...this.playerMap.entries()].find(([, player]) =>
          getPlayerGuildId(player) === cleanId(guildId)
        );
        cid = getPlayerChannelId(matchedEntry?.[1], matchedEntry?.[0]) || matchedEntry?.[0] || null;
      }
    }

    const cleanChannelId = cleanId(cid);
    const player = cleanChannelId
      ? this.playerMap.get(cleanChannelId) ??
        [...this.playerMap.values()].find((entry) => getPlayerChannelId(entry) === cleanChannelId)
      : null;
    if (!player) return msg.reply(mkEmbed(this._t(msg, "responses._common.notInVoice")));

    const activeChannelId = getPlayerChannelId(player, cleanChannelId) || cleanChannelId;
    this.playerMap.delete(activeChannelId);
    if (activeChannelId !== cleanChannelId) this.playerMap.delete(cleanChannelId);
    await msg.reply(mkEmbed(this._t(msg, "responses._common.successfullyLeft")));
    await player.leave();
    player.destroy();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Player Initialisation
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Create and register a new Player for the given voice channel.
   * @param {Message} message
   * @param {string} cid - Voice channel ID
   * @param {Function} [cb]
   */
  initPlayer(message, cid, cb = () => {}) {
    const channel = this.commands.client?.channels?.get(cid);

    if (!channel) {
      return message.reply(mkEmbed(
          this._t(message, "responses.join.channelNotFound", { channel: cid })
      ));
    }

    const isVoice = channel.type === 2;

    if (!isVoice) {
      return message.reply(mkEmbed(this._t(message, "responses._common.voiceChannelRequired")));
    }

    const cleanChannelId = cleanId(cid);
    const existing = this.playerMap.get(cleanChannelId)
      ?? [...this.playerMap.values()].find((entry) => getPlayerChannelId(entry) === cleanChannelId);
    if (existing) {
      existing.textChannel = message.channel;
      cb(existing);
      return message.reply(mkEmbed(this._t(message, "responses.join.alreadyJoined", { channel: cid })));
    }

    const player = new Player(this.config.token, {
      ...this.playerConfig,
      client:             this.commands.client,
      config:             this.config,
      nodelink:           this.config.nodelink,
      moonlink:           this.playerConfig?.moonlink ?? null,
      settingsMgr:        this.settings,
      observedVoiceUsers: this.observedVoiceUsers ?? null,
      locale:             this.locale ?? null,
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

      // Check 24/7 settings for this channel
      const raw247 = (() => {
        try { return this.settings.getServer(guildId)?.get("stay_247"); } catch (_) { return null; }
      })();
      const mode247 = (() => {
        try { return this.settings.getServer(guildId)?.get("stay_247_mode") ?? "off"; } catch (_) { return "off"; }
      })();
      const isIn247List = (() => {
        if (!raw247 || raw247 === "none") return false;
        const channels = Array.isArray(raw247)
            ? raw247.map(id => String(id).replace(/\D/g, "")).filter(Boolean)
            : [String(raw247).replace(/\D/g, "")].filter(Boolean);
        return channels.includes(homeChannelId) || channels.includes(activeChannelId);
      })();

      // Remove player from map and destroy
      this.playerMap.delete(activeChannelId);
      if (activeChannelId !== cleanChannelId) this.playerMap.delete(cleanChannelId);
      if (homeChannelId !== activeChannelId) this.playerMap.delete(homeChannelId);
      player.destroy();

      if (isIn247List && (mode247 === "on" || mode247 === "auto")) {
        // 24/7 is active — rejoin after a short delay (same as RecoveryManager.spawnPlayer autoleave)
        const delay = this.timers?.rejoin247Delay ?? 3000;
        if (this.spawnPlayer) {
          logger.recovery(`[AutoLeave] 24/7 rejoin scheduled for ${homeChannelId} in ${delay}ms`);
          setTimeout(() => {
            this.spawnPlayer(guildId, homeChannelId, 0, null, "initplayer-autoleave").catch(e =>
              logger.warn("[AutoLeave] 24/7 rejoin failed for", homeChannelId, e.message)
            );
          }, delay);
        }
      } else {
        // Not 24/7 — send inactivity message
        const prefix = (() => {
          try { return this.settings.getServer(guildId)?.get("prefix") ?? "%"; } catch (_) { return "%"; }
        })();
        const desc = this.locale?.translate(guildId, "responses.join.autoLeaveInactive247", { channel: `<#${activeChannelId}>`, prefix })
          ?? `Left channel <#${activeChannelId}> because of inactivity.\nIf you want me to stay in voice, use \`${prefix}247 on/auto\``;
        ch?.send(mkEmbed(desc));
      }
    });

    player.on("leave", () => {});

    player.on("message", (m) => {
      const ch       = player.textChannel;
      const guildId = cleanId(player._guildId ?? ch?.guildId ?? ch?.guild?.id ?? getMessageGuildId({ channel: ch }));
      const raw      = this.settings.getServer(guildId)?.get("songAnnouncements");
      const disabled = raw === false || raw === 0 ||
          ["false","0","no","off","disable"].includes(String(raw).toLowerCase().trim());
      if (disabled) return;
      ch?.send(typeof m === "object" && Array.isArray(m.embeds) ? m : mkEmbed(m));
    });

    this.playerMap.set(cleanChannelId, player);

    (async () => {
      const statusMsg = await message.reply(mkEmbed(this._t(message, "responses.join.joining")));
      try {
        await player.join(cid);
        await statusMsg.edit(mkEmbed(this._t(message, "responses.join.joined", { channel: cid })));

        const guildId = cleanId(channel.guildId ?? getMessageGuildId(message));
        if (guildId) {
          const savedVol = this.settings.getServer(guildId)?.get("volume");
          if (savedVol !== undefined && savedVol !== null) {
            const vol = Number(savedVol);
            if (!isNaN(vol)) player.setVolume(vol / 100);
          }
        }

        cb(player);
      } catch (err) {
        await statusMsg.edit(mkEmbed(this._t(message, "responses.join.joinFailed", { error: err.message }))).catch(() => {});
        this.playerMap.delete(cleanChannelId);
        player.destroy();
      }
    })();
  }

}
