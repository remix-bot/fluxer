/**
 * @module src/ui/MessageHandler
 * @description Central message/reaction plumbing: message-create events,
 * reaction observers, permission checks, and the reply/send/edit embed API
 * used by every command.
 */

import { Client, Events, EmbedBuilder, PermissionFlags } from "@fluxerjs/core";
import { logger } from "../core/Logger.mjs";
import { Utils } from "../utils/Utils.mjs";
import { Message, Channel } from "./Wrappers.mjs";
import { getGlobalColor } from "./Embeds.mjs";
import {
  REQUIRED_BOT_PERMISSIONS,
  CRITICAL_PERMISSIONS,
  OPTIONAL_PERMISSIONS,
} from "./Permissions.mjs";

/**
 * @class MessageHandler
 * @description Handles message creation, reaction observation, permission
 * checking, and the shared reply/send/embed API.
 */
export class MessageHandler {
  /** @type {Client} */
  client;
  /** @type {Map<string, object>} Message ID → reaction observer data. */
  observedReactions;
  /** @type {Map<string, Array>} Channel ID → user message observer callbacks. */
  observedChannels;
  /** @type {object|null} Locale manager instance. */
  locale;

  /**
   * @param {Client} client - The Fluxer client.
   */
  constructor(client) {
    this.client = client;

    this.observedReactions = new Map();
    this.observedChannels = new Map();

    this.setupEvents();

    this.client.on(Events.MessageCreate, (m) => {
      if (!this.observedChannels.has(m.channelId)) return;
      const data = this.observedChannels.get(m.channelId);
      const d = data.filter(e => e.id === m.author.id);
      if (d.length === 0) return;
      d.forEach(e => e.cb(new Message(m, this)));
    });
  }

  /** @param {object} locale */
  setLocale(locale) { this.locale = locale; }

  /**
   * Translate a locale key.
   * @param {string} guildId
   * @param {string} key
   * @param {object} [replacements={}]
   * @returns {string}
   */
  t(guildId, key, replacements = {}) {
    if (!this.locale) return key;
    return this.locale.translate(guildId, key, replacements);
  }

  /**
   * @private Register reaction add/remove event listeners.
   */
  setupEvents() {
    const reactionUpdate = (payload) => {
      const { userId, messageId, emoji } = payload;
      const emojiId = emoji?.name ?? emoji?.id ?? emoji;
      const event = { user_id: userId, emoji_id: emojiId };

      if (!this.observedReactions.has(messageId)) return;
      if (event.user_id === this.client.user?.id) return;
      const observer = this.observedReactions.get(messageId);
      if (!observer.reactions.includes(event.emoji_id)) return;
      if (observer.user && observer.user !== event.user_id) return;

      const wrappedMsg = observer.msg ? new Message(observer.msg, this) : null;
      observer.cb(event, wrappedMsg);
    };
    this.client.on(Events.MessageReactionAdd, (payload) => reactionUpdate(payload));
    this.client.on(Events.MessageReactionRemove, (payload) => reactionUpdate(payload));
  }

  /**
   * Return the permission keys the bot is missing in a channel.
   * @param {string[]} permissions
   * @param {object} channel
   * @returns {string[]}
   */
  checkPermissions(permissions, channel) {
    if (!channel?.guild) return [];
    const me = channel.guild.members?.me ?? null;
    if (!me) {
      logger.warn("[MessageHandler] Cannot check permissions — guild.members.me is null");
      return [];
    }
    const perms = channel.permissionsFor?.(me) ?? null;
    if (!perms) {
      logger.warn("[MessageHandler] Cannot check permissions — channel.permissionsFor() unavailable");
      return [];
    }
    return permissions.filter(p => !perms.has(PermissionFlags[p] ?? p));
  }

  /**
   * Check all REQUIRED_BOT_PERMISSIONS and split into critical vs optional.
   * @param {object} channel
   * @returns {{missing: string[], criticalMissing: string[], optionalMissing: string[]}}
   */
  checkAllBotPermissions(channel) {
    const allKeys = [...REQUIRED_BOT_PERMISSIONS.keys()];
    const missing = this.checkPermissions(allKeys, channel);
    return {
      missing,
      criticalMissing: missing.filter(p => CRITICAL_PERMISSIONS.includes(p)),
      optionalMissing: missing.filter(p => OPTIONAL_PERMISSIONS.includes(p)),
    };
  }

  /**
   * Build an EmbedBuilder showing missing permissions.
   * @param {string[]} missingKeys
   * @param {string} guildId
   * @returns {EmbedBuilder}
   */
  buildPermissionEmbed(missingKeys, guildId) {
    const criticalItems = [];
    const optionalItems = [];

    for (const key of missingKeys) {
      const info = REQUIRED_BOT_PERMISSIONS.get(key);
      const isCritical = CRITICAL_PERMISSIONS.includes(key);
      const line = info
          ? `**${info.name}** — ${info.desc}`
          : `**${key}**`;
      if (isCritical) {
        criticalItems.push("❌ " + line);
      } else {
        optionalItems.push("⚠️ " + line);
      }
    }

    const embed = new EmbedBuilder().setColor(0xFF4444);

    if (criticalItems.length > 0) {
      embed.setTitle(this.t(guildId, "responses.messages.missingCriticalPermsTitle"));
      embed.setDescription(
          this.t(guildId, "responses.messages.missingCriticalPermsDesc") + "\n\n" +
          criticalItems.join("\n")
      );
    } else if (optionalItems.length > 0) {
      embed.setTitle(this.t(guildId, "responses.messages.missingOptionalPermsTitle"));
      embed.setDescription(
          this.t(guildId, "responses.messages.missingOptionalPermsDesc") + "\n\n" +
          optionalItems.join("\n")
      );
      embed.setColor(0xFFA500);
    }

    embed.setFooter({
      text: this.t(guildId, "responses.messages.permFooter")
    });

    return embed;
  }

  /**
   * Check permissions; send a DM or embed if missing.
   * @async
   * @param {string[]} permissions
   * @param {object} message
   * @returns {Promise<boolean>}
   */
  async assertPermissions(permissions, message) {
    const guild = message.guild ?? await message.client?.guilds?.resolve?.(message.guildId);
    if (guild && !guild.members?.me) {
      try { await guild.members.fetchMe(); } catch (e) { logger.warn("[MessageHandler] fetchMe failed:", e?.message); }
    }
    const missing = this.checkPermissions(permissions, message.channel ?? message.channel?.channel);
    if (missing.length === 0) return true;

    if (missing.includes("SendMessages")) {
      try {
        const dm = await message.author.createDM();
        dm.send({
          embeds: [this.#embedify(this.t(message.guildId, "pagination.error.perms.messages", { channel: "<#" + message.channelId + ">" }))]
        });
      } catch (e) {
        logger.warn("[MessageHandler] Error sending message in DMs (" + message.author.id + "):", e.message);
      }
      return false;
    }

    const permEmbed = this.buildPermissionEmbed(missing, message.guildId);
    try {
      await message.reply({ embeds: [permEmbed] }, { ping: false });
    } catch (e) {
      logger.warn("[MessageHandler] Failed to send permission embed:", e.message);
      try {
        const names = missing.map(k => REQUIRED_BOT_PERMISSIONS.get(k)?.name ?? k);
        await message.reply(this.t(message.guildId, "responses.messages.needPermsFallback", { perms: names.join("** **") }), { ping: false });
      } catch (e) { logger.warn("[MessageHandler] Fallback permission reply failed:", e?.message); }
    }
    return false;
  }

  /**
   * Register a listener for all incoming messages.
   * @param {Function} listener
   */
  onMessage(listener) {
    this.client.on(Events.MessageCreate, (msg) => {
      listener(new Message(msg, this));
    });
  }

  /**
   * Get a wrapped Message from cache by ID.
   * @param {string} id
   * @returns {Message|null}
   */
  get(id) {
    for (const channel of this.client.channels.values()) {
      const msg = channel.messages?.get?.(id) ?? null;
      if (msg) return new Message(msg, this);
    }
    return null;
  }

  /**
   * @async Get a message from cache or fetch it from the API.
   * @param {string} id
   * @param {string} channelId
   * @returns {Promise<Message|null>}
   */
  async getOrFetch(id, channelId) {
    const cached = this.get(id);
    if (cached) return cached;
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel) return null;
    const raw = await channel.messages?.fetch?.(id);
    return raw ? new Message(raw, this) : null;
  }

  /**
   * Get a wrapped Channel by ID.
   * @param {string} id
   * @returns {Channel}
   */
  getChannel(id) {
    const c = this.client.channels.get(id);
    return new Channel(c, this);
  }

  /**
   * @async Get a channel from cache or fetch from the API.
   * @param {string} id
   * @returns {Promise<Channel>}
   */
  async getOrFetchChannel(id) {
    const c = this.getChannel(id);
    if (c?.channel) return c;
    const raw = await this.client.channels.fetch(id).catch(() => undefined);
    return new Channel(raw, this);
  }

  /**
   * Start observing reactions on a message.
   * @param {object} msg
   * @param {string[]} reactions
   * @param {Function} cb
   * @param {object} [user]
   * @returns {string} Observation ID.
   */
  observeReactions(msg, reactions, cb, user) {
    this.observedReactions.set(msg.id, {
      reactions: reactions,
      user: (user) ? user.id : null,
      cb,
      msg,
    });
    return msg.id;
  }

  /**
   * Stop observing reactions.
   * @param {string} i - Observation ID.
   * @returns {boolean}
   */
  unobserveReactions(i) {
    return this.observedReactions.delete(i);
  }

  /**
   * Observe messages from a specific user in a channel.
   * @param {string} userId
   * @param {object} channel
   * @param {Function} callback
   * @returns {string} Observation ID.
   */
  observeUserMessagesChannel(userId, channel, callback) {
    const current = (this.observedChannels.get(channel.id) || []);
    const nonce = Utils.uid();
    current.push({
      id: userId,
      nonce: nonce,
      cb: callback
    });
    this.observedChannels.set(channel.id, current);
    return userId + ";" + channel.id + ";" + nonce;
  }

  /**
   * @private Stop observing a user's messages in a channel.
   * @param {string} oid
   */
  unobserveUserMessagesChannel(oid) {
    const [userId, channelId, nonce] = oid.split(";");
    const current = (this.observedChannels.get(channelId) || []);
    const idx = current.findIndex(e => e.id === userId && e.nonce === nonce);
    if (idx === -1) return;
    current.splice(idx, 1);
    if (current.length === 0) return this.observedChannels.delete(channelId);
    this.observedChannels.set(channelId, current);
  }

  /**
   * @private Build an EmbedBuilder from text with optional title, thumbnail,
   * and author icon.
   * @param {string} [text=""]
   * @param {object} [options={}]
   * @param {string|number} [options.color]
   * @param {string} [options.title]
   * @param {string} [options.thumbnail]
   * @param {string} [options.icon_url]
   * @returns {EmbedBuilder}
   */
  #embedify(text = "", options = {}) {
    const color = options.color ?? getGlobalColor();
    const builder = new EmbedBuilder()
        .setDescription("" + text)
        .setColor(color);

    if (options.title) builder.setTitle(options.title);

    if (options.thumbnail && Utils.isValidUrl(options.thumbnail)) {
      builder.setThumbnail(options.thumbnail);
    }

    if (options.icon_url) {
      if (Utils.isValidUrl(options.icon_url)) {
        builder.setAuthor({ name: options.title || "\u200b", iconURL: options.icon_url });
      } else {
        builder.setAuthor({ name: options.title || "\u200b" });
      }
    }

    return builder;
  }

  /**
   * @private Create a message payload object with an embed.
   * @param {string} text
   * @param {object} [options={}]
   * @returns {{content: *, embeds: EmbedBuilder[]}}
   */
  #createEmbed(text, options = {}) {
    return {
      content: options.content ?? undefined,
      embeds: [this.#embedify(text, options)],
    };
  }

  /**
   * @async Reply to a message with permission checks.
   * @param {object} replyingTo
   * @param {string|object} message
   * @param {boolean} [mention=false]
   * @returns {Promise<Message|null>}
   */
  async reply(replyingTo, message, mention = false) {
    if (!(await this.assertPermissions(["SendMessages", "EmbedLinks"], replyingTo))) return null;
    let opts;
    if (typeof message === "string") {
      opts = this.#createEmbed(message);
    } else {
      opts = { ...message };
    }
    return new Message(await replyingTo.reply(opts, { ping: false }), this);
  }

  /**
   * @async Reply with an embed.
   * @param {object} replyingTo
   * @param {string|object} message
   * @param {object} [options={}]
   * @returns {Promise<Message|null>}
   */
  async replyEmbed(replyingTo, message, options = {}) {
    if (!(await this.assertPermissions(["SendMessages", "EmbedLinks"], replyingTo))) return null;

    if (typeof message === "object" && Array.isArray(message.embeds)) {
      return new Message(await replyingTo.reply(message, { ping: false }), this);
    }

    options = {
      mention: false,
      embed: {},
      ...options
    };
    const content = (typeof message === "object") ? message.embedText : message;
    let payload = this.#createEmbed(content, options.embed);
    if (typeof message === "object") {
      const { embedText, ...rest } = message;
      payload = { ...payload, ...rest };
    }
    return new Message(await replyingTo.reply(payload, { ping: false }), this);
  }

  /**
   * @async Send a message to a channel.
   * @param {object} channel
   * @param {string|object} message
   * @returns {Promise<Message|null>}
   */
  async sendMessage(channel, message) {
    if (this.checkPermissions(["SendMessages", "EmbedLinks"], channel).length !== 0) {
      logger.warn("[MessageHandler] Missing SendMessages/EmbedLinks permission in channel", channel.id);
      return null;
    }
    let opts;
    if (typeof message === "string") {
      opts = this.#createEmbed(message);
    } else {
      opts = message;
    }
    return new Message(await channel.send(opts), this);
  }

  /**
   * @async Send an embed to a channel.
   * @param {object} channel
   * @param {string|object} content
   * @param {object} [embedOptions={}]
   * @returns {Promise<Message|null>}
   */
  async sendEmbed(channel, content, embedOptions = {}) {
    if (this.checkPermissions(["SendMessages", "EmbedLinks"], channel).length !== 0) {
      return this.sendMessage(channel, typeof content === "string" ? content : content?.embedText ?? "");
    }
    if (typeof content === "object" && Array.isArray(content.embeds)) {
      return new Message(await channel.send(content), this);
    }
    const text = (typeof content === "object") ? content.embedText : content;
    const payload = this.#createEmbed(text, embedOptions);
    if (typeof content === "object") {
      const { embedText, ...rest } = content;
      Object.assign(payload, rest);
    }
    return new Message(await channel.send(payload), this);
  }

  /**
   * @async Edit an existing message embed with retry on 502/503/504.
   * @param {object} message
   * @param {string|object} content
   * @param {object} [embedOptions={}]
   * @returns {Promise<Message|null>}
   */
  async editEmbed(message, content, embedOptions = {}) {
    const RETRYABLE = new Set([502, 503, 504]);
    const MAX_ATTEMPTS = 3;
    const RETRY_DELAY_MS = 1500;

    let payload;
    if (typeof content === "object" && Array.isArray(content.embeds)) {
      payload = content;
    } else {
      const text  = (typeof content === "object") ? content.embedText : content;
      const embed = this.#embedify(text, embedOptions);
      payload     = { embeds: [embed] };
      if (typeof content === "object") {
        const { embedText, ...rest } = content;
        payload = { ...payload, ...rest };
      }
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return new Message(await message.edit(payload), this);
      } catch (err) {
        if (err.code === "UNKNOWN_MESSAGE" || err.code === 10008) {
          logger.warn("[MessageHandler] editEmbed: Message no longer exists, skipping edit.");
          return null;
        }

        if (RETRYABLE.has(err.statusCode) && attempt < MAX_ATTEMPTS) {
          logger.warn(`[MessageHandler] editEmbed: ${err.statusCode} on attempt ${attempt}/${MAX_ATTEMPTS}, retrying in ${RETRY_DELAY_MS}ms…`);
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
          continue;
        }

        throw err;
      }
    }
  }

  /**
   * @async Create a paginated message with arrow reactions.
   * @param {import('./Paginators.mjs').PageBuilder} builder
   * @param {Message} msg
   * @returns {Promise<void>}
   */
  async initPagination(builder, msg) {
    const pages = builder.createPages();
    if (pages.length === 0) return;

    const arrows   = ["⬅️", "➡️"];
    const currPage = { n: 0 };
    const send     = () => builder.getPage(currPage.n);

    const m = await msg.reply(send());
    if (!m) return;

    m.message.react(arrows[0]).catch(() => {});
    m.message.react(arrows[1]).catch(() => {});

    const unobserve = m.onReaction(arrows, (e) => {
      if (e.emoji_id === arrows[0]) {
        currPage.n = Math.max(0, currPage.n - 1);
      } else {
        currPage.n = Math.min(pages.length - 1, currPage.n + 1);
      }
      m.edit(send()).catch(() => {});
    });

    const guildId = msg.message?.guildId ?? null;
    setTimeout(() => {
      unobserve();
      m.edit(this.t(guildId, "pagination.embed.sclosedContent", { content: send() })).catch(() => {});
    }, 5 * 60 * 1000);
  }

  /**
   * @async Join a voice channel using VoiceManager.
   * @param {string} channelId
   * @returns {Promise<object>}
   * @throws {Error} If channel not found or not a guild channel.
   */
  async joinChannel(channelId) {
    const { getVoiceManager } = await import("@fluxerjs/voice");
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel) throw new Error("Voice channel not found.");

    const isGuildChannel = channel.isGuild?.() ?? ("guildId" in channel);
    if (!isGuildChannel) throw new Error("Cannot join a non-guild voice channel.");
    const vm = getVoiceManager(this.client);
    if (!vm) throw new Error("VoiceManager not available.");
    const voiceConn = await vm.join(channel);

    const deafen = () => {
      try {
        vm.updateVoiceState(channel.id, { self_deaf: true, self_mute: false });
      } catch (_) { /* best effort */ }
    };
    deafen();
    if (typeof voiceConn?.on === "function") voiceConn.on("requestVoiceStateSync", deafen);
    return voiceConn;
  }
}
