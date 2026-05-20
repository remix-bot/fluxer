import { Client, Events, EmbedBuilder, PermissionFlags } from "@fluxerjs/core";
import { logger } from "./constants/Logger.mjs";
import { Utils } from "./Utils.mjs";

/**
 * All permissions the bot needs to function correctly, mapped to
 * human-readable names and explanations.
 * Ordered by importance — text perms first, then voice perms.
 *
 * @type {ReadonlyMap<string, { name: string, desc: string }>}
 */
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

/** Permission flag keys that are absolutely critical — bot cannot work without these. */
export const CRITICAL_PERMISSIONS = ["ViewChannel", "SendMessages", "EmbedLinks", "Connect", "Speak"];

/** Permission flag keys that are nice-to-have but bot can partially work without. */
export const OPTIONAL_PERMISSIONS = ["AddReactions", "ReadMessageHistory", "ManageMessages", "AttachFiles"];

/** Parse a color value from config — accepts hex string "0xe9196c", "#e9196c", or number */
export function parseColor(value, fallback = 0xe9196c) {
  if (!value) return fallback;
  if (typeof value === "number") return value;
  const cleaned = String(value).replace(/^#/, "").replace(/^0x/i, "");
  const n = parseInt(cleaned, 16);
  return isNaN(n) ? fallback : n;
}

/** Global embed color — set once at startup from config */
let _globalColor = 0xe9196c;
export function setGlobalColor(value) { _globalColor = parseColor(value); }
export function getGlobalColor()      { return _globalColor; }

export class MessageHandler {
  /**
   * Fluxer.js client instance
   * @type {Client}
   * @public
   */
  client;
  observedReactions;
  /** @type {Map<string, string[]>} */
  observedChannels;
  /** @type {import('./constants/Locale.mjs').Locale} */
  locale;

  /**
   * @param {Client} client
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

  /** @param {import('./constants/Locale.mjs').Locale} locale */
  setLocale(locale) { this.locale = locale; }

  /**
   * Translate a locale key for a given guild.
   * @param {string} guildId
   * @param {string} key
   * @param {Object} [replacements={}]
   * @returns {string}
   */
  t(guildId, key, replacements = {}) {
    if (!this.locale) return key;
    return this.locale.translate(guildId, key, replacements);
  }

  setupEvents() {
    const reactionUpdate = (reaction, user) => {
      const messageId = reaction.message?.id ?? reaction.messageId;
      const emoji = reaction.emoji?.name ?? reaction.emoji?.id ?? reaction.emoji;
      const event = { user_id: user.id, emoji_id: emoji };

      if (!this.observedReactions.has(messageId)) return;
      if (event.user_id === this.client.user?.id) return;
      const observer = this.observedReactions.get(messageId);
      if (!observer.reactions.includes(event.emoji_id)) return;
      if (observer.user && observer.user !== user.id) return;

      const wrappedMsg = reaction.message ? new Message(reaction.message, this) : null;
      observer.cb(event, wrappedMsg);
    };
    this.client.on(Events.MessageReactionAdd, (reaction, user) => reactionUpdate(reaction, user));
    this.client.on(Events.MessageReactionRemove, (reaction, user) => reactionUpdate(reaction, user));
  }

  /**
   * Checks if the bot has the specified permissions in a specific channel.
   *
   * @param {string[]} permissions An array of permission flag keys to check for.
   * @param {BaseChannel} channel The channel to check the permissions in.
   * @returns {string[]} Missing permission flag keys.
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
   * Check ALL required bot permissions in a channel.
   * Returns an object with critical vs optional missing permissions
   * so the caller can decide how severe the problem is.
   *
   * @param {BaseChannel} channel The channel to check.
   * @returns {{ missing: string[], criticalMissing: string[], optionalMissing: string[] }}
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
   * Build a rich permission-error embed listing all missing permissions
   * with human-readable names and explanations.
   *
   * @param {string[]} missingKeys Permission flag keys that are missing.
   * @param {string} [guildId] Guild ID for locale translation.
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
      embed.setTitle("Missing Permissions — Bot Cannot Work Properly");
      embed.setDescription(
          "The bot is missing **critical permissions** it needs to function. " +
          "Please ask a server administrator to grant them.\n\n" +
          criticalItems.join("\n")
      );
    } else if (optionalItems.length > 0) {
      embed.setTitle("Missing Optional Permissions");
      embed.setDescription(
          "Some features may not work without these permissions, but the bot can still play music.\n\n" +
          optionalItems.join("\n")
      );
      embed.setColor(0xFFA500);
    }

    embed.setFooter({
      text: "Re-invite the bot with correct permissions using the invite link, " +
            "or edit the bot's role in Server Settings → Roles."
    });

    return embed;
  }

  /**
   * @param {string[]} permissions Permissions to check for.
   * @param {FluxerMessage} message The message to reply to in case of missing permissions.
   * @returns {Promise<boolean>} If all permissions are given.
   */
  async assertPermissions(permissions, message) {
    const guild = message.guild ?? await message.client?.guilds?.resolve?.(message.guildId);
    if (guild && !guild.members?.me) {
      try { await guild.members.fetchMe(); } catch (_) { /* fetch failed, checkPermissions will warn */ }
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
        await message.reply("I need the following permissions: **" + names.join("**, **") + "**. Please ask a server admin to grant them.", { ping: false });
      } catch (_) { /* completely blocked */ }
    }
    return false;
  }

  /**
   * @callback MessageListener
   * @param {Message} message
   */
  /**
   * Listen for new messages
   * @param {MessageListener} listener
   */
  onMessage(listener) {
    this.client.on(Events.MessageCreate, (msg) => {
      listener(new Message(msg, this));
    });
  }

  /**
   * Get a cached message by id.
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
   * Either gets a message from cache or fetches it.
   * @param {string} id message id
   * @param {string} channelId channel id
   * @returns {Promise<Message>}
   */
  async getOrFetch(id, channelId) {
    const cached = this.get(id);
    if (cached) return cached;
    const channel = await this.client.channels.fetch(channelId);
    const raw = typeof channel.fetchMessage === "function"
        ? await channel.fetchMessage(id)
        : await channel.messages?.fetch?.(id);
    return raw ? new Message(raw, this) : null;
  }

  /**
   * Get a cached channel by id.
   * @param {string} id channel id
   * @returns {Channel}
   */
  getChannel(id) {
    const c = this.client.channels.get(id);
    return new Channel(c, this);
  }

  /**
   * @param {string} id
   * @returns {Promise<Channel>}
   */
  async getOrFetchChannel(id) {
    const c = this.getChannel(id);
    if (c?.channel) return c;
    return new Channel(await this.client.channels.fetch(id), this);
  }

  observeReactions(msg, reactions, cb, user) {
    this.observedReactions.set(msg.id, {
      reactions: reactions,
      user: (user) ? user.id : null,
      cb
    });
    return msg.id;
  }
  unobserveReactions(i) {
    return this.observedReactions.delete(i);
  }

  /**
   * @param {string} userId
   * @param {BaseChannel} channel
   * @param {MessageListener} callback
   * @returns {string}
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
  unobserveUserMessagesChannel(oid) {
    const [userId, channelId, nonce] = oid.split(";");
    const current = (this.observedChannels.get(channelId) || []);
    const idx = current.findIndex(e => e.id === userId && e.nonce === nonce);
    if (idx === -1) return;
    current.splice(idx, 1);
    if (current.length === 0) return this.observedChannels.delete(channelId);
    this.observedChannels.set(channelId, current);
  }

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

  #createEmbed(text, message, options = {}) {
    return {
      content: options.content ?? undefined,
      embeds: [this.#embedify(text, options)],
    };
  }

  /**
   * @param {FluxerMessage} replyingTo
   * @param {string|Object} message
   * @param {boolean} mention
   * @returns {Promise<Message>}
   */
  async reply(replyingTo, message, mention = false) {
    if (!(await this.assertPermissions(["SendMessages", "EmbedLinks"], replyingTo))) return null;
    let opts;
    if (typeof message === "string") {
      opts = this.#createEmbed(message, replyingTo);
    } else {
      opts = { ...message };
    }
    return new Message(await replyingTo.reply(opts, { ping: false }), this);
  }

  /**
   * @param {FluxerMessage} replyingTo
   * @param {string|Object} message
   * @param {Object} options
   * @returns {Promise<Message>}
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
    let payload = this.#createEmbed(content, replyingTo, options.embed);
    if (typeof message === "object") {
      const { embedText, ...rest } = message;
      payload = { ...payload, ...rest };
    }
    return new Message(await replyingTo.reply(payload, { ping: false }), this);
  }

  /**
   * @param {BaseChannel} channel
   * @param {string|Object} message
   * @returns {Promise<Message>}
   */
  async sendMessage(channel, message) {
    if (this.checkPermissions(["SendMessages", "EmbedLinks"], channel).length !== 0) {
      logger.warn("[MessageHandler] Missing SendMessages/EmbedLinks permission in channel", channel.id);
      return null;
    }
    let opts;
    if (typeof message === "string") {
      opts = this.#createEmbed(message, channel);
    } else {
      opts = message;
    }
    return new Message(await channel.send(opts), this);
  }

  /**
   * @param {BaseChannel} channel
   * @param {string|Object} content
   * @param {Object} embedOptions
   * @returns {Promise<Message>}
   */
  async sendEmbed(channel, content, embedOptions = {}) {
    if (this.checkPermissions(["SendMessages", "EmbedLinks"], channel).length !== 0) {
      return this.sendMessage(channel, typeof content === "string" ? content : content?.embedText ?? "");
    }
    if (typeof content === "object" && Array.isArray(content.embeds)) {
      return new Message(await channel.send(content), this);
    }
    const text = (typeof content === "object") ? content.embedText : content;
    const payload = this.#createEmbed(text, channel, embedOptions);
    if (typeof content === "object") {
      const { embedText, ...rest } = content;
      Object.assign(payload, rest);
    }
    return new Message(await channel.send(payload), this);
  }

  /**
   * @param {FluxerMessage} message
   * @param {string|Object} content
   * @param {Object} embedOptions
   * @returns {Promise<Message>}
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
   * Initialize paginated messages.
   * @param {PageBuilder} builder
   * @param {Message} msg
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
   * @param {string} channelId
   * @returns {Promise<import("@fluxerjs/voice").VoiceConnectionLike>}
   */
  async joinChannel(channelId) {
    const { joinVoiceChannel } = await import("@fluxerjs/voice");
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !("guildId" in channel)) throw new Error("Cannot join a non-guild voice channel.");
    return joinVoiceChannel(this.client, channel);
  }
}

export class Channel {
  /**
   * The actual underlying fluxer.js channel instance
   * @type {import("@fluxerjs/core").BaseChannel}
   */
  channel;
  /** @type {MessageHandler} */
  handler;

  /**
   * @param {import("@fluxerjs/core").BaseChannel} channel
   * @param {MessageHandler} handler
   */
  constructor(channel, handler) {
    this.channel = channel;
    this.handler = handler;
  }

  /** @type {Guild} */
  get server() {
    return this.channel?.guild ?? null;
  }
  /** @type {Guild} */
  get guild() {
    return this.channel?.guild ?? null;
  }
  /** @type {boolean} */
  get isVoice() {
    return this.channel?.isVoiceBased?.() ?? false;
  }
  /** @type {string} */
  get id() {
    return this.channel?.id;
  }
  /** @type {string} */
  get guildId() {
    return this.channel?.guildId ?? null;
  }
  /** @type {string} */
  get serverId() {
    return this.guildId;
  }

  /**
   * @param {MessageListener} callback
   * @param {User} user
   * @returns {Function}
   */
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

  /**
   * @param {string|Object} content
   * @returns {Promise<Message>}
   */
  sendMessage(content) {
    return this.handler.sendMessage(this.channel, content);
  }

  /**
   * @param {string|Object} content
   * @returns {Promise<Message>}
   */
  send(content) {
    return this.handler.sendMessage(this.channel, content);
  }

  /**
   * @param {string|Object} content
   * @param {Object} embedOptions
   * @returns {Promise<Message>}
   */
  sendEmbed(content, embedOptions = {}) {
    return this.handler.sendEmbed(this.channel, content, embedOptions);
  }

  /**
   * @returns {Promise<import("@fluxerjs/voice").VoiceConnection>}
   */
  join() {
    if (!this.isVoice) throw new Error("Cannot join a text channel. Attempting to 'join' into channel `" + this.channel?.id + "`");
    return this.handler.joinChannel(this.channel.id);
  }
}

export class Message {
  /**
   * The actual underlying message instance
   * @type {import("@fluxerjs/core").Message}
   */
  message;
  /** @type {MessageHandler} */
  handler;

  constructor(message, handler) {
    this.message = message;
    this.handler = handler;
  }

  /** @type {string} */
  get content() {
    return this.message.content;
  }
  /** @type {string} */
  get id() {
    return this.message.id;
  }
  /** @type {User} */
  get author() {
    return this.message.author;
  }
  /** @type {string} */
  get authorId() {
    return this.message.author?.id;
  }
  /** @type {GuildMember|null} */
  get member() {
    return this.message.member ?? null;
  }
  /** @type {Channel} */
  get channel() {
    return this.handler.getChannel(this.message.channelId);
  }

  /**
   * @param {string[]} reactions
   * @param {function} callback
   * @param {User} [user]
   * @returns {function} unobserve
   */
  onReaction(reactions, callback, user = null) {
    const oid = this.handler.observeReactions(this.message, reactions, callback, user);
    return () => {
      this.handler.unobserveReactions(oid);
    };
  }

  /**
   * @param {string|Object} content
   * @param {boolean} mention
   * @returns {Promise<Message>}
   */
  reply(content, mention = false) {
    return this.handler.reply(this.message, content, mention);
  }

  /**
   * @param {string|Object} content
   * @param {boolean} mention
   * @param {Object} embedOptions
   * @returns {Promise<Message>}
   */
  replyEmbed(content, mention = false, embedOptions = {}) {
    return this.handler.replyEmbed(this.message, content, {
      mention,
      embed: embedOptions
    });
  }

  /**
   * @param {string|Object} content
   * @param {Object} embedOptions
   * @returns {Promise<Message>}
   */
  editEmbed(content, embedOptions = {}) {
    return this.handler.editEmbed(this.message, content, embedOptions);
  }

  /**
   * @param {string|Object} content
   * @param {Object} embedOptions
   * @returns {Promise<Message>}
   */
  edit(content, embedOptions = {}) {
    return this.handler.editEmbed(this.message, content, embedOptions);
  }
}

export class PageBuilder {
  form = "";
  maxLinesPerPage = 2;
  /** @type {string[]} */
  content = [];
  initiated = false;
  pages = [];

  /**
   * @param {string|string[]} content
   */
  constructor(content) {
    if (!Array.isArray(content)) {
      this.content = content.split("\n");
      return;
    }
    this.content = content;
  }

  setForm(form) {
    this.form = form;
    this.initiated = false;
    return this;
  }

  setMaxLines(maxLinesPerPage = 2) {
    this.maxLinesPerPage = maxLinesPerPage;
    this.initiated = false;
    return this;
  }

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

  /**
   * @param {number} n
   * @returns {string|null}
   */
  getPage(n) {
    const pages = this.createPages();
    if (!pages[n]) return null;
    return this.form
        .replace(/\$maxPage/gi, pages.length)
        .replace(/\$currentPage/gi, n + 1)
        .replace(/\$currPage/gi, n + 1)
        .replace(/\$content/gi, pages[n].join("\n"));
  }

  /**
   * @param {number} n
   * @returns {string|null}
   */
  getContent(n) {
    const pages = this.createPages();
    if (!pages[n]) return null;
    return pages[n].join("\n");
  }

  /** @returns {number} */
  size() {
    return this.pages.length;
  }
}

/**
 * RichPaginator — tabbed embed pagination with reaction controls.
 *
 * Usage:
 *   new RichPaginator(msg, handler)
 *     .setTimeout(5 * 60 * 1000)
 *     .addTab({ emoji: "🏠", title: "Home", header: "Home Page", content: "..." })
 *     .addTab({ emoji: "🎵", title: "Music", header: "Music Commands", pages: ["page1", "page2"] })
 *     .setPrevNext("⬅️", "➡️")
 *     .send();
 */
export class RichPaginator {
  /**
   * @param {Message} msg
   * @param {MessageHandler} handler
   */
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

  /** @param {number} ms */
  setTimeout(ms) { this._timeout = ms; return this; }

  /** @param {number} color */
  setColor(color) { this._color = color; return this; }

  /** @param {string} startTab index (0-based) */
  setStartTab(idx) { this._state.tab = idx; return this; }

  /** @param {string} prev @param {string} next */
  setPrevNext(prev, next) { this._prev = prev; this._next = next; return this; }

  /**
   * Add a tab.
   * @param {{ emoji: string, title: string, header: string, content?: string, pages?: string[] }} tab
   *   content — single static string (no pagination)
   *   pages   — array of strings, one per page (enables prev/next)
   */
  addTab(tab) {
    this._tabs.push({
      emoji:  tab.emoji,
      title:  tab.title,
      header: tab.header,
      pages:  tab.pages ?? (tab.content != null ? [tab.content] : []),
    });
    return this;
  }

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
        } catch (_) {}
      }
    };

    const closeSession = async () => {
      unobserve();
      const currentEmbed = buildEmbed(state.tab, state.page);
      if (!currentEmbed.footer) currentEmbed.footer = { text: "" };
      currentEmbed.footer.text += " • " + this._handler.t(guildId, "pagination.embed.sclosedTitle");
      rawMsg.edit({ embeds: [currentEmbed] }).catch(() => {});
      await clearReactions();
    };

    let timer = setTimeout(closeSession, this._timeout);

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

/**
 * QueuePaginator — rich embed pagination for the queue/list command.
 *
 * Usage:
 *   new QueuePaginator(msg, handler, client)
 *     .setTimeout(30_000)
 *     .setColor(0xe9196c)
 *     .send(buildEmbedFn, totalPages, startPage);
 *
 * buildEmbedFn(page) must return a raw embed object { color, author, title, description, footer }
 */
export class QueuePaginator {
  /**
   * @param {Message} msg
   * @param {MessageHandler} handler
   * @param {Client} client
   */
  constructor(msg, handler, client) {
    this._msg     = msg;
    this._handler = handler;
    this._client  = client;
    this._timeout = 30 * 1000;
    this._prev    = "⬅️";
    this._next    = "➡️";
  }

  /** @param {number} ms */
  setTimeout(ms) { this._timeout = ms; return this; }

  /** @param {string} prev @param {string} next */
  setPrevNext(prev, next) { this._prev = prev; this._next = next; return this; }

  /**
   * @param {function(page: number): object} buildEmbed  - returns a raw embed object
   * @param {number} totalPages
   * @param {number} [startPage=1]
   */
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

    const clearReactions = async () => {
      try {
        await rawMsg.removeAllReactions();
      } catch (_) {
        for (const emoji of [prev, next]) {
          try {
            await rawMsg.removeReaction(emoji);
          } catch (_) {}
        }
      }
    };

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

const HELP_CMDS_PER_PAGE = 10;
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

export class HelpCommand {
  /**
   * @param {import("./CommandHandler.mjs").CommandHandler} commandHandler
   * @param {MessageHandler} messageHandler
   * @param {function(msg: Message): import("./Settings.mjs").SettingsManager} getSettingsFn
   *   Called with a Message to retrieve that guild's settings.
   *   In index.mjs this is: (msg) => this.getSettings(msg)
   */
  constructor(commandHandler, messageHandler, getSettingsFn) {
    this._commands = commandHandler;
    this._messages = messageHandler;
    this._getSettings = getSettingsFn;
  }

  /**
   * Registers the help command with the CommandHandler and intercepts
   * incoming messages whose first word is "help", "h", or "commands".
   *
   * Call once during bot startup, after commands have been loaded.
   */
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
