import Player from "./Player.mjs";
import { CommandHandler } from "./CommandHandler.mjs";
import { Message } from "./MessageHandler.mjs";
import { SettingsManager } from "./Settings.mjs";
import { getVoiceManager } from "@fluxerjs/voice";

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
   * @param {Object} config.config The parsed config.json
   * @param {Object} config.player Config data passed to new player objects
   */
  constructor(settings, commands, config) {
    this.commands = commands;
    this.settings = settings;
    this.config = config.config;
    this.playerConfig = config.player;
  }

  /**
   * Prompts the user to select a voice channel and returns its id after connecting.
   * @param {Message} msg
   * @returns {Promise<string|false|null>}
   */
  promptVC(msg) {
    return new Promise(async res => {
      // In fluxerjs, DM channels don't have guilds
      if (!msg.channel?.guild) {
        return this.initPlayer(msg, msg.channel.id, (p) => res(msg.channel.id));
      }

      const channels = msg.channel.guild?.channels?.cache?.filter(c => c.isVoiceBased()) ?? [];
      const reactions = ["🥇", "🥈", "🥉", "🥇", "🥈", "🥉", "🥇", "🥈", "🥉"];
      const channelArr = [...channels.values()];

      var channelSelection = "";
      if (channelArr.length !== 0) {
        channelSelection = "Please select one of the following channels by clicking on the reactions below\n\n";
        channelArr.slice(0, 9).forEach((c, i) => {
          channelSelection += (i + 1) + ". <#" + c.id + ">\n";
        });
      }

      const m = await msg.replyEmbed(
        ((channelSelection) ? channelSelection + "\n**..or**" : "Please") + " send a message with the voice channel! (Mention/Id/Name)\nSend 'x' to cancel."
      );

      var unsubscribeMessages;
      const unsubscribeReactions = m.onReaction(reactions.slice(0, Math.min(channelArr.length, 9)), (e) => {
        const idx = reactions.findIndex(r => r === e.emoji_id);
        const c = channelArr[idx];
        if (!c) return;
        this.initPlayer(msg, c.id, (p) => res(c.id));
        unsubscribeMessages?.();
        unsubscribeReactions();
      }, msg.author);

      unsubscribeMessages = msg.channel.onMessageUser((m) => {
        if (m.content.toLowerCase() === "x") {
          unsubscribeMessages();
          unsubscribeReactions();
          m.replyEmbed("Cancelled!");
          return res(false);
        }
        if (!this.commands.validateInput("voiceChannel", m.content, m)) {
          return m.replyEmbed("Invalid voice channel. Please try again and check capitalization! (`x` to cancel)");
        }
        const channel = this.commands.formatInput("voiceChannel", m.content, m);
        unsubscribeMessages();
        unsubscribeReactions();
        this.initPlayer(m, channel, (p) => res(channel));
      }, msg.author);
    });
  }

  /**
   * Searches the channels of the current guild and returns the voice channel the user is in.
   * Uses @fluxerjs/voice VoiceManager which tracks VOICE_STATE_UPDATE events reliably.
   * @param {Message} message
   * @returns {string|null} channelId
   */
  checkVoiceChannels(message) {
    if (!message) return null;
    const userId = message.author?.id;
    const guild = message.channel?.guild ?? message.message?.guild;
    if (!guild || !userId) return null;

    // Primary: use @fluxerjs/voice VoiceManager — it listens to VOICE_STATE_UPDATE
    // and tracks guild_id -> user_id -> channel_id reliably
    try {
      const voiceManager = getVoiceManager(this.commands.client);
      if (voiceManager) {
        const channelId = voiceManager.getVoiceChannelId(guild.id, userId);
        if (channelId) return channelId;
      }
    } catch (_) {}

    // Fallback: check guild voice states cache (may not be populated in fluxerjs)
    const voiceState = guild.voiceStates?.cache?.get(userId);
    return voiceState?.channelId ?? null;
  }

  /**
   * Returns the current player instance for the message author.
   * @param {Message} message
   * @param {boolean} [promptJoin=true]
   * @param {boolean} [verifyUser=true]
   * @returns {Promise<Player|null|false>}
   */
  async getPlayer(message, promptJoin = true, verifyUser = true) {
    const userId = message.author?.id;
    var cid = this.checkVoiceChannels(message);
    var player = this.playerMap.get(cid);

    if (!player && cid) {
      player = await (new Promise((res) => {
        this.initPlayer(message, cid, (p) => res(p));
      }));
      return player;
    }

    if (!cid || !player) {
      if (!promptJoin) {
        message.replyEmbed("It doesn't look like we're in the same voice channel.");
        return false;
      }
      var success = await this.promptVC(message);
      if (!success) return null;
      cid = success;
    }

    player = this.playerMap.get(cid);
    return player;
  }

  /**
   * @param {Message} msg
   * @param {string} cid
   * @returns {Promise<undefined>}
   */
  async leave(msg, cid) {
    const p = this.playerMap.get(cid);
    if (!p) return;
    this.playerMap.delete(cid);
    // Start leave and send message in parallel
    const [left] = await Promise.all([
      p.leave(),
      msg.replyEmbed("✅ Successfully Left")
    ]);
    p.destroy();
  }

  /**
   * @param {Message} message
   * @param {string} cid
   * @param {Function} [cb]
   */
  initPlayer(message, cid, cb = () => {}) {
    const channel = this.commands.client.channels.cache.get(cid);
    if (!channel) {
      return message.replyEmbed("Couldn't find the channel `" + cid + "`\nUse the help command to learn more about this.");
    }
    if (this.playerMap.has(cid)) {
      cb(this.playerMap.get(cid));
      return message.replyEmbed("Already joined <#" + cid + ">.");
    }
    const p = new Player(this.config.token, {
      ...this.playerConfig,
      messageChannel: message.channel
    });
    p.on("autoleave", () => {
      message.channel.sendEmbed("Left channel <#" + cid + "> because of inactivity.");
      this.playerMap.delete(cid);
      p.destroy();
    });
    p.on("leave", () => {
      // cleanup if needed
    });
    p.on("message", (m) => {
      const guildId = message.channel?.guild?.id ?? message.message?.guildId;
      if (this.settings.getServer(guildId).get("songAnnouncements") === "false") return;
      message.channel.sendEmbed(m);
    });
    this.playerMap.set(cid, p);
    message.replyEmbed("Joining Channel...").then(async m => {
      await p.join(cid);
      m.editEmbed(`✅ Successfully joined <#${cid}>`);
      cb(p);
    });
  }
}
