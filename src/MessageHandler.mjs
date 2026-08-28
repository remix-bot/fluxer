/** @module src/MessageHandler @description Message creation, reaction observation, permission checking, pagination, and command help display. */

import { Client, Events, EmbedBuilder, PermissionFlags } from "@fluxerjs/core";
import { logger } from "./constants/Logger.mjs";
import { Utils } from "./Utils.mjs";

/** @type {Map<string, {name: string, desc: string}>} @description Required bot permissions with human-readable names and descriptions. */
export const REQUIRED_BOT_PERMISSIONS = Object.freeze(new Map([
  ["ViewChannel",    { name: "View Channels",          desc: "See channels and read their content" }],
  ["SendMessages",   { name: "Send Messages",          desc: "Respond to commands and send messages" }],
  ["EmbedLinks",     { name: "Embed Links",            desc: "Send rich embed messages (bot responses, now playing, etc.)" }],
  ["AddReactions",   { name: "Add Reactions",          desc: "Add pagination reactions (help pages, queue, etc.)" }],
  ["ReadMessageHistory", { name: "Read Message History", desc: "Read previous messages for context" }],
  ["ManageMessages", { name: "Manage Messages",         desc: "Pin messages, clean up bot responses" }],
  ["AttachFiles",    { name: "Attach Files",            desc: "Send files and thumbnails" }],
  ["Connect",        { name: "Connect (Join Voice)",    desc: "Join voice channels to play music" }],
  ["Speak",          { name: "Speak",                  desc: "Stream audio in voice channels" }],
]));

/** @type {string[]} @description Permission keys that are strictly required for the bot to function. */
export const CRITICAL_PERMISSIONS = ["ViewChannel", "SendMessages", "EmbedLinks", "Connect", "Speak"];

/** @type {string[]} @description Permission keys that are optional but improve the user experience. */
export const OPTIONAL_PERMISSIONS = ["AddReactions", "ReadMessageHistory", "ManageMessages", "AttachFiles"];

/** Parse a color value (hex string, number) into an integer. @param {string|number} value @param {number} [fallback=0xe9196c] @returns {number} */
export function parseColor(value, fallback = 0xe9196c) {
  if (!value) return fallback;
  if (typeof value === "number") return value;
  const cleaned = String(value).replace(/^#/, "").replace(/^0x/i, "");
  const n = parseInt(cleaned, 16);
  return isNaN(n) ? fallback : n;
}

/** @private */
let _globalColor = 0xe9196c;
/** Set the global embed color. @param {string|number} value */
export function setGlobalColor(value) { _globalColor = parseColor(value); }
/** @returns {number} The current global embed color. */
export function getGlobalColor()      { return _globalColor; }

/** Re-export of {@link cleanId} from Utils for convenience. @type {function} */
export { cleanId } from "./Utils.mjs";

/** Extract the guild ID from various message wrapper shapes. @param {object} message @returns {string|null} */
export function getMessageGuildId(message) {
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

/** @class MessageHandler @description Handles message creation, reaction observation, permission checking, and pagination. */
export class MessageHandler {
  /** @type {Client} */
  client;
  /** @type {Map<string, object>} Message ID → reaction observer data. */
  observedReactions;
  /** @type {Map<string, Array>} Channel ID → user message observer callbacks. */
  observedChannels;
  /** @type {object|null} Locale manager instance. */
  locale;

  /** @param {Client} client - The Discord client. */
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

  /** Set the locale manager. @param {object} locale */
  setLocale(locale) { this.locale = locale; }

  /** Translate a locale key. @param {string} guildId @param {string} key @param {object} [replacements={}] @returns {string} */
  t(guildId, key, replacements = {}) {
    if (!this.locale) return key;
    return this.locale.translate(guildId, key, replacements);
  }

  /** @private Register reaction add/remove event listeners. */
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

  /** Return the permission keys the bot is missing in a channel. @param {string[]} permissions @param {object} channel @returns {string[]} Missing permission keys. */
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

  /** Check all REQUIRED_BOT_PERMISSIONS and split into critical vs optional. @param {object} channel @returns {{missing: string[], criticalMissing: string[], optionalMissing: string[]}} */
  checkAllBotPermissions(channel) {
    const allKeys = [...REQUIRED_BOT_PERMISSIONS.keys()];
    const missing = this.checkPermissions(allKeys, channel);
    return {
      missing,
      criticalMissing: missing.filter(p => CRITICAL_PERMISSIONS.includes(p)),
      optionalMissing: missing.filter(p => OPTIONAL_PERMISSIONS.includes(p)),
    };
  }

  /** Build an EmbedBuilder showing missing permissions. @param {string[]} missingKeys @param {string} guildId @returns {EmbedBuilder} */
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

  /** Check permissions; send a DM or embed if missing. @async @param {string[]} permissions @param {object} message @returns {Promise<boolean>} */
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

  /** Register a listener for all incoming messages. @param {Function} listener */
  onMessage(listener) {
    this.client.on(Events.MessageCreate, (msg) => {
      listener(new Message(msg, this));
    });
  }

  /** Get a wrapped Message from cache by ID. @param {string} id @returns {Message|null} */
  get(id) {
    for (const channel of this.client.channels.values()) {
      const msg = channel.messages?.get?.(id) ?? null;
      if (msg) return new Message(msg, this);
    }
    return null;
  }

  /** @async Get a message from cache or fetch it from the API. @param {string} id @param {string} channelId @returns {Promise<Message|null>} */
  async getOrFetch(id, channelId) {
    const cached = this.get(id);
    if (cached) return cached;
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel) return null;
    const raw = await channel.messages?.fetch?.(id);
    return raw ? new Message(raw, this) : null;
  }

  /** Get a wrapped Channel by ID. @param {string} id @returns {Channel} */
  getChannel(id) {
    const c = this.client.channels.get(id);
    return new Channel(c, this);
  }

  /** @async Get a channel from cache or fetch from the API. @param {string} id @returns {Promise<Channel>} */
  async getOrFetchChannel(id) {
    const c = this.getChannel(id);
    if (c?.channel) return c;
    const raw = await this.client.channels.fetch(id).catch(() => undefined);
    return new Channel(raw, this);
  }

  /** Start observing reactions on a message. @param {object} msg @param {string[]} reactions @param {Function} cb @param {object} [user] @returns {string} Observation ID. */
  observeReactions(msg, reactions, cb, user) {
    this.observedReactions.set(msg.id, {
      reactions: reactions,
      user: (user) ? user.id : null,
      cb,
      msg,
    });
    return msg.id;
  }
  /** Stop observing reactions. @param {string} i - Observation ID. @returns {boolean} */
  unobserveReactions(i) {
    return this.observedReactions.delete(i);
  }

  /** Observe messages from a specific user in a channel. @param {string} userId @param {object} channel @param {Function} callback @returns {string} Observation ID. */
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
  /** @private Stop observing a user's messages in a channel. @param {string} oid */
  unobserveUserMessagesChannel(oid) {
    const [userId, channelId, nonce] = oid.split(";");
    const current = (this.observedChannels.get(channelId) || []);
    const idx = current.findIndex(e => e.id === userId && e.nonce === nonce);
    if (idx === -1) return;
    current.splice(idx, 1);
    if (current.length === 0) return this.observedChannels.delete(channelId);
    this.observedChannels.set(channelId, current);
  }

  /** @private Build an EmbedBuilder from text with optional title, thumbnail, and icon. @param {string} [text=""] @param {object} [options={}] @param {string} [options.color] @param {string} [options.title] @param {string} [options.thumbnail] @param {string} [options.icon_url] @returns {EmbedBuilder} */
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

  /** @private Create a message payload object with an embed. @param {string} text @param {object} [options={}] @returns {{content: *, embeds: EmbedBuilder[]}} */
  #createEmbed(text, options = {}) {
    return {
      content: options.content ?? undefined,
      embeds: [this.#embedify(text, options)],
    };
  }

  /** @async Reply to a message with permission checks. @param {object} replyingTo @param {string|object} message @param {boolean} [mention=false] @returns {Promise<Message|null>} */
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

  /** @async Reply with an embed. @param {object} replyingTo @param {string|object} message @param {object} [options={}] @returns {Promise<Message|null>} */
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

  /** @async Send a message to a channel. @param {object} channel @param {string|object} message @returns {Promise<Message|null>} */
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

  /** @async Send an embed to a channel. @param {object} channel @param {string|object} content @param {object} [embedOptions={}] @returns {Promise<Message|null>} */
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

  /** @async Edit an existing message embed with retry on 502/503/504. @param {object} message @param {string|object} content @param {object} [embedOptions={}] @returns {Promise<Message|null>} */
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

  /** @async Create a paginated message with arrow reactions. @param {PageBuilder} builder @param {Message} msg @returns {Promise<void>} */
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

  /** @async Join a voice channel using VoiceManager. @param {string} channelId @returns {Promise<object>} @throws {Error} If channel not found or not a guild channel. */
  async joinChannel(channelId) {
    const { getVoiceManager } = await import("@fluxerjs/voice");
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel) throw new Error("Voice channel not found.");
    if (!("guildId" in channel)) throw new Error("Cannot join a non-guild voice channel.");
    const vm = getVoiceManager(this.client);
    if (!vm) throw new Error("VoiceManager not available.");
    return vm.join(channel);
  }
}

/** @class Channel @description Wrapper around a Discord channel object providing helpers for sending messages and observing users. */
export class Channel {
  /** @type {object} The raw channel object. */
  channel;
  /** @type {MessageHandler} */
  handler;

  /** @param {object} channel @param {MessageHandler} handler */
  constructor(channel, handler) {
    this.channel = channel;
    this.handler = handler;
  }

  /** @returns {object|null} The guild this channel belongs to. */
  get server() {
    return this.channel?.guild ?? null;
  }
  /** @returns {object|null} Alias for server (guild). */
  get guild() {
    return this.channel?.guild ?? null;
  }
  /** @returns {boolean} Whether this channel is a voice channel. */
  get isVoice() {
    return this.channel?.isVoiceBased?.() ?? false;
  }
  /** @returns {string} The channel ID. */
  get id() {
    return this.channel?.id;
  }
  /** @returns {string|null} The guild ID. */
  get guildId() {
    return this.channel?.guildId ?? null;
  }
  /** @returns {string|null} Alias for guildId. */
  get serverId() {
    return this.guildId;
  }

  /** Observe messages from a specific user in this channel. @param {Function} callback @param {object} user @returns {Function} Unobserve function. */
  onMessageUser(callback, user) {
    const resolvedUserId = user?.id
        ?? user?._id
        ?? user?.user?.id
        ?? null;
    const resolvedChannel = this.channel ?? null;
    if (!resolvedUserId || !resolvedChannel?.id) {
      return () => {};
    }
    const oid = this.handler.observeUserMessagesChannel(resolvedUserId, resolvedChannel, callback);
    return () => {
      this.handler.unobserveUserMessagesChannel(oid);
    };
  }

  /** Send a message to this channel. @param {string|object} content @returns {Promise<Message|null>} */
  sendMessage(content) {
    return this.handler.sendMessage(this.channel, content);
  }

  /** Alias for sendMessage. @param {string|object} content @returns {Promise<Message|null>} */
  send(content) {
    return this.handler.sendMessage(this.channel, content);
  }

  /** Send an embed to this channel. @param {string|object} content @param {object} [embedOptions={}] @returns {Promise<Message|null>} */
  sendEmbed(content, embedOptions = {}) {
    return this.handler.sendEmbed(this.channel, content, embedOptions);
  }

  /** Join this voice channel. @async @returns {Promise<object>} @throws {Error} If not a voice channel. */
  join() {
    if (!this.isVoice) throw new Error("Cannot join a text channel. Attempting to 'join' into channel `" + this.channel?.id + "`");
    return this.handler.joinChannel(this.channel.id);
  }
}

/** @class Message @description Wrapper around a Discord message providing helpers for replying, editing, and reaction observation. */
export class Message {
  /** @type {object} */
  message;
  /** @type {MessageHandler} */
  handler;

  /** @param {object} message @param {MessageHandler} handler */
  constructor(message, handler) {
    this.message = message;
    this.handler = handler;
  }

  /** @returns {string} The raw message content. */
  get content() {
    return this.message.content;
  }
  /** @returns {string} The message ID. */
  get id() {
    return this.message.id;
  }
  /** @returns {object} The author object. */
  get author() {
    return this.message.author;
  }
  /** @returns {string} The author's user ID. */
  get authorId() {
    return this.message.author?.id;
  }
  /** @returns {object|null} The guild member, if available. */
  get member() {
    return this.message.member ?? null;
  }
  /** @returns {Channel} The wrapped channel this message was sent in. */
  get channel() {
    return this.handler.getChannel(this.message.channelId);
  }

  /** Observe reactions on this message. @param {string[]} reactions @param {Function} callback @param {object} [user=null] @returns {Function} Unobserve function. */
  onReaction(reactions, callback, user = null) {
    const oid = this.handler.observeReactions(this.message, reactions, callback, user);
    return () => {
      this.handler.unobserveReactions(oid);
    };
  }

  /** Reply to this message. @param {string|object} content @param {boolean} [mention=false] @returns {Promise<Message|null>} */
  reply(content, mention = false) {
    return this.handler.reply(this.message, content, mention);
  }

  /** Reply to this message with an embed. @param {string|object} content @param {boolean} [mention=false] @param {object} [embedOptions={}] @returns {Promise<Message|null>} */
  replyEmbed(content, mention = false, embedOptions = {}) {
    return this.handler.replyEmbed(this.message, content, {
      mention,
      embed: embedOptions
    });
  }

  /** Edit this message's embed. @param {string|object} content @param {object} [embedOptions={}] @returns {Promise<Message|null>} */
  editEmbed(content, embedOptions = {}) {
    return this.handler.editEmbed(this.message, content, embedOptions);
  }

  /** Alias for editEmbed. @param {string|object} content @param {object} [embedOptions={}] @returns {Promise<Message|null>} */
  edit(content, embedOptions = {}) {
    return this.handler.editEmbed(this.message, content, embedOptions);
  }
}

/** @class PageBuilder @description Splits content into pages with template-based formatting. */
export class PageBuilder {
  /** @type {string} Template form string with $maxPage, $currentPage, $content placeholders. */
  form = "";
  /** @type {number} Maximum lines per page. */
  maxLinesPerPage = 2;
  /** @type {Array|string[]} Content lines or array items. */
  content = [];
  /** @type {boolean} Whether pages have been created. */
  initiated = false;
  /** @type {Array<Array>} Created page arrays. */
  pages = [];

  /** @param {string|Array} content - String to split by newlines or an array of items. */
  constructor(content) {
    if (!Array.isArray(content)) {
      this.content = content.split("\n");
      return;
    }
    this.content = content;
  }

  /** Set the template form string with $maxPage, $currentPage, $content placeholders. @param {string} form @returns {PageBuilder} */
  setForm(form) {
    this.form = form;
    this.initiated = false;
    return this;
  }

  /** Set the maximum lines per page. @param {number} [maxLinesPerPage=2] @returns {PageBuilder} */
  setMaxLines(maxLinesPerPage = 2) {
    this.maxLinesPerPage = maxLinesPerPage;
    this.initiated = false;
    return this;
  }

  /** Create page arrays from content. Lazily initialized; returns cached pages if already created. @returns {Array<Array>} */
  createPages() {
    if (this.initiated) return this.pages;

    const lines = this.content;
    const pages = [];
    for (let i = 0; i < lines.length; i++) {
      const n = Math.floor(i / this.maxLinesPerPage);
      if (!pages[n]) pages[n] = [];
      pages[n].push(lines[i]);
    }

    this.pages = pages;
    this.initiated = true;
    return pages;
  }

  /** Get a formatted page string by index (0-based). @param {number} n @returns {string|null} */
  getPage(n) {
    const pages = this.createPages();
    if (!pages[n]) return null;
    return this.form
        .replace(/\$maxPage/gi, pages.length)
        .replace(/\$currentPage/gi, n + 1)
        .replace(/\$currPage/gi, n + 1)
        .replace(/\$content/gi, pages[n].join("\n"));
  }

  /** Get raw page content by index (0-based) without template formatting. @param {number} n @returns {string|null} */
  getContent(n) {
    const pages = this.createPages();
    if (!pages[n]) return null;
    return pages[n].join("\n");
  }

  /** Get the total number of pages. @returns {number} */
  size() {
    return this.pages.length;
  }
}

/** @class RichPaginator @description Multi-tab paginated embed with tab and arrow navigation via reactions. */
export class RichPaginator {
  /** @param {Message} msg @param {MessageHandler} handler */
  constructor(msg, handler) {
    this._msg     = msg;
    this._handler = handler;
    this._tabs    = [];
    this._prev    = "⬅️";
    this._next    = "➡️";
    this._timeout = 5 * 60 * 1000;
    this._color   = getGlobalColor();
    this._state   = { tab: 0, page: 0 };
  }

  /** Set the session timeout duration. @param {number} ms @returns {RichPaginator} */
  setTimeout(ms) { this._timeout = ms; return this; }

  /** Set the embed color. @param {number} color @returns {RichPaginator} */
  setColor(color) { this._color = color; return this; }

  /** Set the initially selected tab index. @param {number} idx @returns {RichPaginator} */
  setStartTab(idx) { this._state.tab = idx; return this; }

  /** Set the previous/next arrow emoji strings. @param {string} prev @param {string} next @returns {RichPaginator} */
  setPrevNext(prev, next) { this._prev = prev; this._next = next; return this; }

  /** Add a tab to the paginator. @param {object} tab @param {string} tab.emoji @param {string} tab.title @param {string} tab.header @param {string} [tab.content] @param {string[]} [tab.pages] @returns {RichPaginator} */
  addTab(tab) {
    this._tabs.push({
      emoji:  tab.emoji,
      title:  tab.title,
      header: tab.header,
      pages:  tab.pages ?? (tab.content != null ? [tab.content] : []),
    });
    return this;
  }

  /** @private Build an embed for a given tab and sub-page. @param {number} tabIdx @param {number} pageIdx @returns {EmbedBuilder} */
  _buildEmbed(tabIdx, pageIdx) {
    const tab        = this._tabs[tabIdx];
    const totalTabs  = this._tabs.length;
    const totalPages = Math.max(1, tab.pages.length);
    const safePage   = Math.max(0, Math.min(pageIdx, totalPages - 1));
    const content    = tab.pages[safePage] ?? "";

    const footerParts = [`Page ${tabIdx + 1}/${totalTabs}`];
    if (totalPages > 1) footerParts.push(`• Subpage ${safePage + 1}/${totalPages}`);

    return new EmbedBuilder()
        .setColor(this._color)
        .setAuthor({ name: tab.header })
        .setTitle(tab.title)
        .setDescription(content)
        .setFooter({ text: footerParts.join(" ") });
  }

  /** @async Send the paginated embed and start observing reactions. @returns {Promise<object|null>} The raw sent message. */
  async send() {
    if (this._tabs.length === 0) return null;

    const tabEmojis   = this._tabs.map(t => t.emoji);
    const allReactions = [...tabEmojis, this._prev, this._next];

    const nativeMsg = this._msg.message ?? this._msg;
    if (!nativeMsg?.reply) return null;

    const rawMsg = await nativeMsg.reply(
        { embeds: [this._buildEmbed(this._state.tab, this._state.page)] },
        { ping: false }
    ).catch(() => null);

    if (!rawMsg) return null;

    const guildId = (this._msg.channel?.guildId) ?? (this._msg.guildId) ?? null;

    for (const emoji of allReactions) {
      await rawMsg.react(emoji).catch(() => {});
    }

    const wrapped  = new Message(rawMsg, this._handler);
    const state    = this._state;
    const tabs     = this._tabs;
    const prev     = this._prev;
    const next     = this._next;
    const buildEmbed = this._buildEmbed.bind(this);

    const unobserve = wrapped.onReaction(allReactions, async (e) => {
      const emoji = e.emoji_id;

      if (emoji === prev || emoji === next) {
        const tab        = tabs[state.tab];
        const totalPages = Math.max(1, tab.pages.length);
        if (totalPages <= 1) return;
        state.page = emoji === prev
            ? (state.page - 1 + totalPages) % totalPages
            : (state.page + 1) % totalPages;
      } else {
        const idx = tabEmojis.indexOf(emoji);
        if (idx === -1 || idx === state.tab) return;
        state.tab  = idx;
        state.page = 0;
      }

      rawMsg.edit({ embeds: [buildEmbed(state.tab, state.page)] }).catch(() => {});
    });

    /** @private Clear all reactions on the paginator message. */
    const clearReactions = async () => {
      try {
        await rawMsg.removeAllReactions();
        return;
      } catch (e) {
        logger.warn("[RichPaginator] removeAllReactions failed:", e?.message ?? e);
      }
      for (const emoji of allReactions) {
        try {
          await rawMsg.removeReaction(emoji);
        } catch(e) { logger.warn("[MessageHandler] Error:", e?.message); }
      }
    };

    /** @private Close the pagination session, update footer, and clear reactions. */
    const closeSession = async () => {
      unobserve();
      const currentEmbed = buildEmbed(state.tab, state.page);
      if (!currentEmbed.footer) currentEmbed.footer = { text: "" };
      currentEmbed.footer.text += " • " + this._handler.t(guildId, "pagination.embed.sclosedTitle");
      rawMsg.edit({ embeds: [currentEmbed] }).catch(() => {});
      await clearReactions();
    };

    let timer = setTimeout(closeSession, this._timeout);

    /** @private Reset the inactivity timer. */
    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(closeSession, this._timeout);
    };

    const origHandler = wrapped.handler.observedReactions.get(rawMsg.id);
    if (origHandler) {
      const origCb = origHandler.cb;
      origHandler.cb = (e, m) => { resetTimer(); origCb(e, m); };
    }

    return rawMsg;
  }
}

/** @class QueuePaginator @description Simple two-arrow paginator for queue embeds with page count. */
export class QueuePaginator {
  /** @param {Message} msg @param {MessageHandler} handler @param {Client} client */
  constructor(msg, handler, client) {
    this._msg     = msg;
    this._handler = handler;
    this._client  = client;
    this._timeout = 30 * 1000;
    this._prev    = "⬅️";
    this._next    = "➡️";
  }

  /** Set the session timeout duration. @param {number} ms @returns {QueuePaginator} */
  setTimeout(ms) { this._timeout = ms; return this; }

  /** Set the previous/next arrow emoji strings. @param {string} prev @param {string} next @returns {QueuePaginator} */
  setPrevNext(prev, next) { this._prev = prev; this._next = next; return this; }

  /** @async Send the paginated embed and observe arrow reactions. @param {Function} buildEmbed - Function that takes a page number and returns an EmbedBuilder. @param {number} totalPages @param {number} [startPage=1] @returns {Promise<object|null>} The raw sent message. */
  async send(buildEmbed, totalPages, startPage = 1) {
    const state   = { page: Math.max(1, Math.min(startPage, totalPages)) };
    const nativeMsg = this._msg.message ?? this._msg;
    if (!nativeMsg?.reply) return null;
    const rawMsg = await nativeMsg.reply(
        { embeds: [buildEmbed(state.page)] },
        { ping: false }
    ).catch(() => null);

    if (!rawMsg) return null;

    const guildId = (this._msg.channel?.guildId) ?? (this._msg.guildId) ?? null;

    if (totalPages <= 1) return rawMsg;

    const prev = this._prev;
    const next = this._next;

    await rawMsg.react(prev).catch(() => {});
    await rawMsg.react(next).catch(() => {});

    const client    = this._client;
    const channelId = rawMsg.channelId ?? rawMsg.channel_id ?? rawMsg.channel?.id;
    const msgId     = rawMsg.id;

    /** @private Clear all reactions on the paginator message. */
    const clearReactions = async () => {
      try {
        await rawMsg.removeAllReactions();
      } catch (e) {
        for (const emoji of [prev, next]) {
          try {
            await rawMsg.removeReaction(emoji);
          } catch(e) { logger.warn("[MessageHandler] Error:", e?.message); }
        }
      }
    };

    /** @private Close the pagination session, update footer, and clear reactions. */
    const closeSession = async () => {
      unobserve();
      const embed = buildEmbed(state.page);
      const closedLabel = this._handler.t(guildId, "pagination.embed.sclosedTitle");
      if (embed.footer && typeof embed.footer.text === "string") {
        embed.footer.text += " • " + closedLabel;
      } else {
        embed.footer = { text: closedLabel };
      }
      rawMsg.edit({ embeds: [embed] }).catch(() => {});
      await clearReactions();
    };

    let timer = setTimeout(closeSession, this._timeout);
    /** @private Reset the inactivity timer. */
    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(closeSession, this._timeout);
    };

    const wrapped  = new Message(rawMsg, this._handler);
    const unobserve = wrapped.onReaction([prev, next], (e) => {
      resetTimer();
      state.page = e.emoji_id === prev
          ? (state.page <= 1 ? totalPages : state.page - 1)
          : (state.page >= totalPages ? 1 : state.page + 1);
      rawMsg.edit({ embeds: [buildEmbed(state.page)] }).catch(() => {});
    });

    return rawMsg;
  }
}

/** @type {number} Maximum commands listed per page in the help paginator. */
const HELP_CMDS_PER_PAGE = 10;
/** @type {number} Help paginator session timeout in milliseconds. */
const HELP_SESSION_MS    = 30 * 1000;

const HELP_TABS = [
  {
    emoji:  "🏠",
    title:  "Home",
    header: "Home Page",
    static: true,
  },
  {
    emoji:      "🎵",
    title:      "Music",
    header:     "Music Commands",
    categories: ["music"],
  },
  {
    emoji:      "🔧",
    title:      "Utilities",
    header:     "Utility Commands",
    categories: ["util", "default"],
  },
  {
    emoji:  "ℹ️",
    title:  "Support",
    header: "Support Info",
    static: true,
  },
];

/** @private @param {string} prefix @returns {string} */
function _helpHomeContent(prefix) {
  return (
      "**Welcome to the Remix help page.**\n\n" +
      "Remix is an open-source music bot. It supports a variety of " +
      "streaming services and has many features.\n\n" +
      "We hope you enjoy using Remix!\n\n" +
      "To get started, just click on the reactions below to find out " +
      "more about the commands. In the case that reactions don't work " +
      "for you, there's also the possibility to look through them by " +
      `using \`${prefix}help <page number>\` :)\n\n` +
      `**Tip:** Click the tab emojis to switch sections.`
  );
}

/** @private @returns {string} */
function _helpSupportContent() {
  return (
      "If you need help with anything or encounter any issues, hop over to " +
      "our support server **[Remix HQ](https://fluxer.gg/remix)**!\n" +
      "Alternatively, you can write a dm to any of the following people:\n\n" +
      "- **Fantic**  (Community Manager)\n" +
      "- **Shadow**  (Lead Developer)\n" +
      "- **NoLogicAlan**  (Lead Developer)"
  );
}

/** @private Build paginated content for a help category tab. @param {object} tab @param {Array} allCmds @param {string} prefix @returns {string[]} */
function _helpBuildCategoryPages(tab, allCmds, prefix) {
  const cmds = allCmds
      .filter(cmd => {
        if (cmd.requirements?.some(r => r.ownerOnly)) return false;
        return tab.categories?.includes(cmd.category ?? "default");
      })
      .sort((a, b) => a.name.localeCompare(b.name));

  if (cmds.length === 0) return ["_No commands available._"];

  const pages = [];
  for (let i = 0; i < cmds.length; i += HELP_CMDS_PER_PAGE) {
    const slice = cmds.slice(i, i + HELP_CMDS_PER_PAGE);
    let   page  = "";
    slice.forEach((cmd, j) => {
      const d = (cmd.description || "No description.").split("\n")[0];
      page += `${i + j + 1}. **${cmd.name}**: ${d}\n`;
    });
    page += `\nTo learn more about a command, run \`${prefix}help <command name>\`!`;
    if (cmds.length > HELP_CMDS_PER_PAGE)
      page += `\n\n**Tip:** Use ⬅️ ➡️ to scroll between pages.`;
    pages.push(page);
  }
  return pages;
}

/** @class HelpCommand @description Rich paginated help command with tabbed navigation (Home, Music, Utilities, Support). */
export class HelpCommand {
  /** @param {CommandHandler} commandHandler @param {MessageHandler} messageHandler @param {Function} getSettingsFn */
  constructor(commandHandler, messageHandler, getSettingsFn) {
    this._commands = commandHandler;
    this._messages = messageHandler;
    this._getSettings = getSettingsFn;
  }

  /** Register the help command, intercept invalid command replies, and intercept help aliases. */
  register() {
    if (this._registered) return;
    this._registered = true;

    const HELP_ALIASES = ["help", "h", "commands"];

    this._commands.helpCommand = "\x00help";
    const _fmt = this._commands.format.bind(this._commands);
    this._commands.format = (text, guildId) =>
        _fmt(text, guildId).replace(/\x00help/g, "help");

    const _reply = this._commands.replyHandler.bind(this._commands);
    this._commands.replyHandler = (message, msg) => {
      if (typeof message === "string" && message.toLowerCase().includes("unknown command")) {
        const content = msg?.content ?? msg?.message?.content ?? "";
        const guildId = msg?.channel?.channel?.guildId ?? msg?.message?.guildId;
        const prefix  = this._commands.getPrefix(guildId);
        const botId   = this._commands.client.user?.id;
        const ping     = `<@${botId}>`;
        const pingBang = `<@!${botId}>`;
        let body = null;
        if (content.startsWith(prefix))       body = content.slice(prefix.length).trim();
        else if (content.startsWith(pingBang)) body = content.slice(pingBang.length).trim();
        else if (content.startsWith(ping))     body = content.slice(ping.length).trim();
        if (body !== null) {
          const first = body.split(/\s+/)[0]?.toLowerCase();
          if (HELP_ALIASES.includes(first)) return;
        }
      }
      return _reply(message, msg);
    };

    const evict = () => {
      for (const alias of HELP_ALIASES) {
        const i = this._commands.commandNames.indexOf(alias);
        if (i !== -1) this._commands.commandNames.splice(i, 1);
      }
      const ci = this._commands.commands.findIndex(c =>
          c.aliases.some(a => HELP_ALIASES.includes(a.toLowerCase()))
      );
      if (ci !== -1) this._commands.commands.splice(ci, 1);
    };
    evict();
    const _add = this._commands.addCommand.bind(this._commands);
    this._commands.addCommand = (builder) => {
      const r = _add(builder);
      if (builder.aliases.some(a => HELP_ALIASES.includes(a.toLowerCase()))) evict();
      return r;
    };

    this._messages.onMessage((msg) => {
      if (!msg?.content) return;
      const content = msg.content.trim();
      const guildId = msg.channel?.channel?.guildId ?? msg.message?.guildId;
      const prefix  = this._commands.getPrefix(guildId);
      const botId   = this._commands.client.user?.id;
      const ping     = `<@${botId}>`;
      const pingBang = `<@!${botId}>`;
      let body = null;
      if (content.startsWith(prefix))       body = content.slice(prefix.length).trim();
      else if (content.startsWith(pingBang)) body = content.slice(pingBang.length).trim();
      else if (content.startsWith(ping))     body = content.slice(ping.length).trim();
      if (body === null) return;

      const args    = body.split(/\s+/).map(s => s.trim()).filter(Boolean);
      const cmdName = (args[0] ?? "").toLowerCase();
      if (!HELP_ALIASES.includes(cmdName)) return;

      this._handle(msg, args.slice(1), prefix);
    });
  }

  /** @private Handle a help invocation: show command detail or paginated overview. @param {Message} msg @param {string[]} args @param {string} prefix */
  _handle(msg, args, prefix) {
    const allCmds = this._commands.commands;
    const query   = (args[0] ?? "").trim();

    if (query && isNaN(Number(query))) {
      let currCmd = null;
      for (const word of [query, ...args.slice(1)]) {
        const pool = currCmd ? currCmd.subcommands : allCmds;
        const found = pool.find(c =>
            c.aliases.some(a => a.toLowerCase() === word.toLowerCase())
        );
        if (!found) {
          const guildId = msg.channel?.channel?.guildId ?? msg.message?.guildId;
          msg.reply(this._commands.t(guildId, "cmdHandler.help.unknownCommand", { command: word, prefix }));
          return;
        }
        currCmd = found;
      }
      if (currCmd) {
        msg.reply(this._commands.helpHandler.getCommandHelp(currCmd, msg));
      }
      return;
    }

    const startTab = query
        ? Math.max(0, Math.min(HELP_TABS.length - 1, parseInt(query) - 1))
        : 0;

    const paginator = new RichPaginator(msg, this._messages)
        .setTimeout(HELP_SESSION_MS)
        .setStartTab(startTab);

    for (const tab of HELP_TABS) {
      if (tab.static) {
        const content = tab.title === "Home"
            ? _helpHomeContent(prefix)
            : _helpSupportContent();
        paginator.addTab({ emoji: tab.emoji, title: tab.title, header: tab.header, content });
      } else {
        const pages = _helpBuildCategoryPages(tab, allCmds, prefix);
        paginator.addTab({ emoji: tab.emoji, title: tab.title, header: tab.header, pages });
      }
    }

    paginator.send();
  }
}
