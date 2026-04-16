/**
 * PlayerManager.mjs — Manages voice channel players across servers
 */

import Player from "./Player.mjs";
import { CommandHandler } from "./CommandHandler.mjs";
import { SettingsManager } from "./Settings.mjs";
import { logger } from "./constants/Logger.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "./MessageHandler.mjs";
import { getVoiceManager } from "@fluxerjs/voice";

/** Helper — build a plain embed payload from a description string */
function mkEmbed(desc) {
  return { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(desc).toJSON()] };
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

  /** @type {Map<string, Object>} */
  observedVoiceUsers = null;

  /** @type {import('@fluxerjs/core').Client} */
  client = null;

  /**
   * @param {SettingsManager} settings
   * @param {CommandHandler} commands
   * @param {Object} config
   */
  constructor(settings, commands, config) {
    this.commands     = commands;
    this.settings     = settings;
    this.config       = config.config;
    this.playerConfig = config.player;
    // Fix: Ensure we get the client from commands or config
    this.client       = commands.client || config.player?.client || config.config?.client;
  }

  /**
   * Attempt to detect the voice channel a user is currently in.
   * Now async to support API fallback when cache is empty after reboot.
   * @param {Message} message
   * @returns {Promise<string|null>} Voice channel ID or null
   */
  async checkVoiceChannels(message) {
    if (!message) return null;

    const userId   = message.author?.id ?? message.message?.author?.id;
    const guildId  = message.channel?.server_id  ??
        message.channel?.serverId   ??
        message.channel?.guild?.id  ??
        message.message?.server_id  ??
        message.message?.serverId   ??
        message.message?.guildId;

    if (!userId || !guildId) {
      logger.voiceState(`[checkVoiceChannels] Missing userId or guildId`);
      return null;
    }

    logger.voiceState(`[checkVoiceChannels] Checking for user ${userId} in guild ${guildId}`);

    // Helper to seed observedVoiceUsers cache
    const seed = (channelId) => {
      if (!this.observedVoiceUsers) return channelId;
      if (!this.observedVoiceUsers.has(userId)) {
        this.observedVoiceUsers.set(userId, { channelId, guildId });
        logger.voiceState(`[checkVoiceChannels] Seeded cache: ${userId} -> ${channelId}`);
      }
      return this.observedVoiceUsers.get(userId)?.channelId ?? channelId;
    };

    // 1. Check observedVoiceUsers cache first (populated by GuildCreate)
    if (this.observedVoiceUsers) {
      const observed = this.observedVoiceUsers.get(userId);
      if (observed && observed.guildId === guildId) {
        logger.voiceState(`[checkVoiceChannels] Found in cache: ${observed.channelId}`);
        return observed.channelId;
      }
    }

    // 2. Try VoiceManager
    try {
      const vm        = getVoiceManager(this.client);
      const channelId = vm?.getVoiceChannelId?.(guildId, userId);
      if (channelId) {
        logger.voiceState(`[checkVoiceChannels] Found via VoiceManager: ${channelId}`);
        return seed(channelId);
      }
    } catch (e) {
      logger.voiceState(`[checkVoiceChannels] VoiceManager failed: ${e.message}`);
    }

    // 3. Try message member voice (if available)
    const memberVoice =
        message?.member?.voice?.channelId ??
        message?.member?.voice?.channel?.id ??
        message?.message?.member?.voice?.channelId ??
        null;
    if (memberVoice) {
      logger.voiceState(`[checkVoiceChannels] Found via message.member.voice: ${memberVoice}`);
      return seed(memberVoice);
    }

    // 4. Check guild voice states cache
    try {
      const guild       = this.client?.guilds?.cache?.get(guildId);
      if (!guild) {
        logger.voiceState(`[checkVoiceChannels] Guild ${guildId} not in cache`);
      } else {
        const voiceStates = guild?.voice_states ?? guild?.voiceStates?.cache ?? guild?.voiceStates ?? null;
        if (voiceStates) {
          const entries = Array.isArray(voiceStates)
              ? voiceStates
              : typeof voiceStates.values === "function"
                  ? [...voiceStates.values()]
                  : Object.values(voiceStates);

          logger.voiceState(`[checkVoiceChannels] Checking ${entries.length} voice states in cache`);

          for (const state of entries) {
            const sid  = state.userId ?? state.user_id ?? state.id;
            const sch  = state.channelId ?? state.channel_id;
            const sgid = state.guildId   ?? state.guild_id ?? guildId;
            if (sid === userId && sgid === guildId && sch) {
              logger.voiceState(`[checkVoiceChannels] Found in guild cache: ${sch}`);
              return seed(sch);
            }
          }
        }
      }
    } catch (e) {
      logger.voiceState(`[checkVoiceChannels] Guild cache check failed: ${e.message}`);
    }

    // 5. CRITICAL FIX: Fetch fresh member data from API when cache misses
    try {
      const guild = this.client?.guilds?.cache?.get(guildId);
      if (guild?.members?.fetch) {
        logger.voiceState(`[checkVoiceChannels] Fetching member ${userId} from API...`);
        const member = await guild.members.fetch(userId);
        const voiceChannelId = member?.voice?.channelId ?? member?.voice?.channel?.id ?? null;
        if (voiceChannelId) {
          logger.voiceState(`[checkVoiceChannels] API returned voice channel: ${voiceChannelId}`);
          return seed(voiceChannelId);
        } else {
          logger.voiceState(`[checkVoiceChannels] API returned no voice channel for user`);
        }
      } else {
        logger.voiceState(`[checkVoiceChannels] Cannot fetch members - no fetch method`);
      }
    } catch (err) {
      logger.voiceState(`[checkVoiceChannels] API fetch failed: ${err.message}`);
    }

    logger.voiceState(`[checkVoiceChannels] Could not find voice channel for ${userId}`);
    return null;
  }

  /**
   * Get or create a player for the user's voice channel.
   * @param {Message} message
   * @param {boolean} [promptJoin=true]
   * @param {boolean} [verifyUser=true]
   * @param {boolean} [shouldJoin=false]
   * @returns {Promise<Player|null>}
   */
  async getPlayer(message, promptJoin = true, verifyUser = true, shouldJoin = false) {
    const serverId = message.channel?.server_id ??
        message.channel?.serverId  ??
        message.message?.server_id ??
        message.message?.serverId;

    // Added await here
    const userChannelId = await this.checkVoiceChannels(message);

    if (userChannelId) {
      const player = this.playerMap.get(userChannelId);
      if (player) {
        player.textChannel = message.channel;
        return player;
      }
    }

    const serverPlayers = serverId
        ? [...this.playerMap.entries()].filter(([chId]) => {
          const ch = this.commands.client?.channels?.get(chId) ??
              this.commands.client?.channels?.cache?.get(chId);
          return ch?.guildId === serverId || ch?.server_id === serverId || ch?.serverId === serverId;
        })
        : [];

    if (serverPlayers.length > 0) {
      const channelList = serverPlayers.map(([chId]) => `<#${chId}>`).join(" or ");

      if (!userChannelId) {
        if (promptJoin) {
          message.replyEmbed(mkEmbed(`⚠️ Please join a voice channel to use this command.`));
        }
        return null;
      }

      const match = serverPlayers.find(([chId]) => chId === userChannelId);
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
          return this.settings.getServer(serverId)?.get("prefix") ?? "%";
        } catch (_) { return "%"; }
      })();
      if (promptJoin) {
        message.replyEmbed(mkEmbed(`⚠️ I'm already playing in ${channelList}. Join that channel or use \`${prefix}play\` to start music in your channel.`));
      }
      return null;
    }

    if (!userChannelId) {
      if (shouldJoin) {
        return this.promptVC(message);
      }
      if (promptJoin) {
        message.replyEmbed(mkEmbed("⚠️ Please join a voice channel first."));
      }
      return null;
    }

    if (shouldJoin) {
      return new Promise((resolve) => {
        this.initPlayer(message, userChannelId, (p) => resolve(p));
      });
    }

    return null;
  }

  /**
   * Prompt the user to select a voice channel.
   * @param {Message} msg
   * @returns {Promise<Player|false>}
   */
  async promptVC(msg) {
    const autoDetected = await this.checkVoiceChannels(msg);
    if (autoDetected) {
      return new Promise(resolve => this.initPlayer(msg, autoDetected, (p) => resolve(p)));
    }

    const serverId   = msg.channel?.server_id ?? msg.channel?.serverId;
    const allChannels = serverId
        ? [...(this.commands.client?.channels?.values?.() ??
            this.commands.client?.channels?.cache?.values?.() ?? [])]
            .filter(c => {
              const cServerId = c.server_id ?? c.serverId;
              return cServerId === serverId && c.channel_type === "VoiceChannel";
            })
        : [];

    const reactions  = ["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣"];
    const channelArr = allChannels.slice(0, 9);

    let channelSelection = "";
    if (channelArr.length > 0) {
      channelSelection = "Please select one of the following channels by clicking on the reactions below\n\n";
      channelArr.forEach((c, i) => { channelSelection += `${i + 1}. <#${c._id ?? c.id}>\n`; });
    }

    const selectionMsg = await msg.replyEmbed(mkEmbed(
        (channelSelection ? channelSelection + "\n**..or**" : "Please") +
        " send a message with the voice channel! (Mention/Id/Name)\nSend 'x' to cancel."
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
        msg.replyEmbed(mkEmbed("⏱️ Voice selection timed out."));
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
          m.replyEmbed(mkEmbed("Cancelled!"));
          resolve(false);
          return;
        }
        if (!this.commands.validateInput("voiceChannel", m.content, m)) {
          m.replyEmbed(mkEmbed("Invalid voice channel. Try again or type `x`."));
          return;
        }
        const channel = this.commands.formatInput("voiceChannel", m.content, m);
        clearTimeout(timeout);
        cleanup();
        this.initPlayer(m, channel, (p) => resolve(p));
      }, msg.author);
    });
  }

  /**
   * Make the player leave its current voice channel.
   * @param {Message} msg
   * @param {string} [cid]
   */
  async leave(msg, cid) {
    if (!cid) {
      const serverId = msg.channel?.server_id ?? msg.channel?.serverId ??
          msg.message?.server_id ?? msg.message?.serverId;
      if (serverId) {
        cid = [...this.playerMap.keys()].find((id) => {
          const ch = this.commands.client?.channels?.get(id) ??
              this.commands.client?.channels?.cache?.get(id);
          return ch?.guildId === serverId || ch?.server_id === serverId || ch?.serverId === serverId;
        });
      }
    }

    const player = cid ? this.playerMap.get(cid) : null;
    if (!player) return msg.replyEmbed(mkEmbed("I'm not in a voice channel."));

    this.playerMap.delete(cid);
    await msg.replyEmbed(mkEmbed("✅ Successfully Left"));
    await player.leave();
    player.destroy();
  }

  /**
   * Create and register a new Player for the given voice channel.
   * @param {Message} message
   * @param {string} cid - Voice channel ID
   * @param {Function} [cb]
   */
  initPlayer(message, cid, cb = () => {}) {
    const channel = this.commands.client?.channels?.get(cid) ??
        this.commands.client?.channels?.cache?.get(cid);

    if (!channel) {
      return message.replyEmbed(mkEmbed(
          `Couldn't find the channel \`${cid}\`\nUse the help command to learn more about this.`
      ));
    }

    const isVoice = channel.channel_type === "VoiceChannel" ||
        channel.type          === "VoiceChannel" ||
        channel.type          === 2;

    if (!isVoice) {
      return message.replyEmbed(mkEmbed("❌ Please join a **voice channel** first before using this command!"));
    }

    if (this.playerMap.has(cid)) {
      const existing = this.playerMap.get(cid);
      existing.textChannel = message.channel;
      cb(existing);
      return message.replyEmbed(mkEmbed(`Already joined <#${cid}>.`));
    }

    const player = new Player(this.config.token, {
      ...this.playerConfig,
      client:             this.commands.client,
      config:             this.config,
      nodelink:           this.config.nodelink,
      moonlink:           this.playerConfig?.moonlink ?? null,
      settingsMgr:        this.settings,
      observedVoiceUsers: this.observedVoiceUsers ?? null,
    });

    player.textChannel = message.channel;

    player.on("autoleave", () => {
      const ch       = player.textChannel;
      const serverId = ch?.server_id ?? ch?.serverId ?? ch?.guild?.id;
      const is247 = (() => {
        try {
          const raw = this.settings.getServer(serverId)?.get("stay_247");
          return raw && raw !== "none";
        } catch (_) { return false; }
      })();
      const prefix = (() => {
        try {
          return this.settings.getServer(serverId)?.get("prefix") ?? "%";
        } catch (_) { return "%"; }
      })();
      const desc = is247
          ? `Left channel <#${cid}> because of inactivity.`
          : `Left channel <#${cid}> because of inactivity.\nIf you want me to stay in voice, use \`${prefix}247 on/auto\``;
      ch?.sendEmbed(mkEmbed(desc));
      this.playerMap.delete(cid);
      player.destroy();
    });

    player.on("leave", () => {});

    player.on("message", (m) => {
      const ch       = player.textChannel;
      const serverId = ch?.server_id ?? ch?.serverId ?? ch?.guild?.id;
      const raw      = this.settings.getServer(serverId)?.get("songAnnouncements");
      const disabled = raw === false || raw === 0 ||
          ["false","0","no","off","disable"].includes(String(raw).toLowerCase().trim());
      if (disabled) return;
      ch?.sendEmbed(typeof m === "object" && Array.isArray(m.embeds) ? m : mkEmbed(m));
    });

    this.playerMap.set(cid, player);

    (async () => {
      const statusMsg = await message.replyEmbed(mkEmbed("⏳ Joining Channel..."));
      try {
        await player.join(cid);
        await statusMsg.editEmbed(mkEmbed(`✅ Successfully joined <#${cid}>`));

        const serverId = message.channel?.server_id ?? message.channel?.serverId;
        if (serverId) {
          const savedVol = this.settings.getServer(serverId)?.get("volume");
          if (savedVol !== undefined && savedVol !== null) {
            const vol = Number(savedVol);
            if (!isNaN(vol)) player.setVolume(vol / 100);
          }
        }

        cb(player);
      } catch (err) {
        await statusMsg.editEmbed(mkEmbed(`❌ Failed to join: ${err.message}`)).catch(() => {});
        this.playerMap.delete(cid);
        player.destroy();
      }
    })();
  }
}