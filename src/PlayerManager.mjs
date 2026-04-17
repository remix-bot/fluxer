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
import { getGlobalColor } from "./MessageHandler.mjs";

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

    const userId   = message.author?.id;
    const serverId =
        message.channel?.server_id  ??
        message.channel?.serverId   ??
        message.channel?.guild?.id  ??
        message.channel?.guildId    ??
        message.message?.server_id  ??
        message.message?.serverId   ??
        message.message?.guildId;

    if (!userId) return null;

    const cleanServer = serverId ? String(serverId).replace(/\D/g, "") : null;

    // Fallback: find any existing player in this server
    if (cleanServer) {
      for (const [channelId] of this.playerMap) {
        const channel = this.commands.client?.channels?.get(channelId) ??
            this.commands.client?.channels?.cache?.get(channelId);
        const chGuild = String(channel?.guildId ?? channel?.server_id ?? channel?.serverId ?? "").replace(/\D/g, "");
        if (chGuild === cleanServer) {
          return channelId;
        }
      }
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
    const serverId =
        message.channel?.server_id  ??
        message.channel?.serverId   ??
        message.channel?.guild?.id  ??
        message.channel?.guildId    ??
        message.message?.server_id  ??
        message.message?.serverId   ??
        message.message?.guildId;

    const cleanServerId = serverId ? String(serverId).replace(/\D/g, "") : null;

    const userChannelId = this.checkVoiceChannels(message);

    if (userChannelId) {
      const player = this.playerMap.get(userChannelId);
      if (player) {
        player.textChannel = message.channel;
        return player;
      }
    }

    const serverPlayers = cleanServerId
        ? [...this.playerMap.entries()].filter(([chId]) => {
          const ch = this.commands.client?.channels?.get(chId) ??
              this.commands.client?.channels?.cache?.get(chId);
          const chGuild = String(ch?.guildId ?? ch?.server_id ?? ch?.serverId ?? "").replace(/\D/g, "");
          return chGuild === cleanServerId;
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
        message.replyEmbed(mkEmbed(`⚠️ You need to join a voice channel to use this command.`));
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
      message.replyEmbed(mkEmbed(`⚠️ I'm already playing in ${channelList}. Join that channel or use \`${prefix}play\` to start music in your channel.`));
      return null;
    }

    if (!userChannelId) {
      if (shouldJoin) {
        // Auto-detect failed — fall back to interactive channel selection prompt
        return this.promptVC(message);
      }
      message.replyEmbed(mkEmbed("⚠️ Please join a voice channel first."));
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