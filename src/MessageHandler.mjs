import { Client, Events } from "@fluxerjs/core";
import { Utils } from "./Utils.mjs";

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

  setupEvents() {
    const reactionUpdate = (reaction, user) => {
      // fluxerjs reaction events pass a MessageReaction and a User
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
   * @param {string[]} permissions An array of permissions to check for.
   * @param {BaseChannel} channel The channel to check the permissions in.
   * @returns {string[]} Missing permissions.
   */
  checkPermissions(permissions, channel) {
    if (!channel?.guild) return []; // DMs — no guild perms
    const me = channel.guild.members.me;
    if (!me) return permissions; // can't verify, assume missing
    const perms = channel.permissionsFor(me);
    return permissions.filter(p => !perms.has(p));
  }

  /**
   * @param {string[]} permissions Permissions to check for.
   * @param {FluxerMessage} message The message to reply to in case of missing permissions.
   * @returns {Promise<boolean>} If all permissions are given.
   */
  async assertPermissions(permissions, message) {
    const missing = this.checkPermissions(permissions, message.channel);
    if (missing.length === 0) return true;

    if (missing.includes("SendMessages")) {
      try {
        const dm = await message.author.createDM();
        dm.send({
          embeds: [this.#embedify("I am unable to send messages in <#" + message.channelId + ">. Please contact a server administrator and grant me the \"SendMessages\" permission.")]
        });
      } catch (e) {
        console.log("[MessageHandler] Error sending message in DMs (" + message.author.id + "): ", e);
      }
      return false;
    }

    this.replyEmbed(message, "I need the following permissions: `" + missing.join(",") + "`. Please contact a server administrator to address this.", { mention: true });
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
    // fluxerjs messages are per-channel; search across cached channels
    for (const channel of this.client.channels.cache.values()) {
      if (!channel.messages) continue;
      const msg = channel.messages.cache.get(id);
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
    return new Message(await channel.messages.fetch(id), this);
  }

  /**
   * Get a cached channel by id.
   * @param {string} id channel id
   * @returns {Channel}
   */
  getChannel(id) {
    const c = this.client.channels.cache.get(id);
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
    options = {
      color: 0xe9196c, // fluxerjs uses numeric color like discord.js
      ...options
    };
    return {
      description: "" + text,
      color: options.color,
      ...(options.title ? { title: options.title } : {}),
      ...(options.thumbnail ? { thumbnail: { url: options.thumbnail } } : {}),
      ...(options.icon_url ? { author: { name: options.title || "\u200b", icon_url: options.icon_url } } : {}),
    };
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
    if (!(await this.assertPermissions(["SendMessages"], replyingTo))) return null;
    const payload = (typeof message === "string")
      ? { content: message, reply: { messageReference: replyingTo.id, failIfNotExists: false } }
      : { ...message, reply: { messageReference: replyingTo.id, failIfNotExists: false } };
    return new Message(await replyingTo.channel.send(payload), this);
  }

  /**
   * @param {FluxerMessage} replyingTo
   * @param {string|Object} message
   * @param {Object} options
   * @returns {Promise<Message>}
   */
  async replyEmbed(replyingTo, message, options = {}) {
    options = {
      mention: false,
      embed: {},
      ...options
    };
    const content = (typeof message === "object") ? message.embedText : message;
    var payload = this.#createEmbed(content, replyingTo, options.embed);
    if (typeof message === "object") {
      const { embedText, ...rest } = message;
      payload = { ...payload, ...rest };
    }
    payload.reply = { messageReference: replyingTo.id, failIfNotExists: false };
    return new Message(await replyingTo.channel.send(payload), this);
  }

  /**
   * @param {BaseChannel} channel
   * @param {string|Object} message
   * @returns {Promise<Message>}
   */
  async sendMessage(channel, message) {
    if (this.checkPermissions(["SendMessages"], channel).length !== 0) {
      console.log("[MessageHandler] SendMessage: Missing SendMessages permission in `" + channel.id + "`");
      return;
    }
    return new Message(await channel.send(typeof message === "string" ? { content: message } : message), this);
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
    const text = (typeof content === "object") ? content.embedText : content;
    const embed = this.#embedify(text, embedOptions);
    let payload = { embeds: [embed] };
    if (typeof content === "object") {
      const { embedText, ...rest } = content;
      payload = { ...payload, ...rest };
    }
    return new Message(await message.edit(payload), this);
  }

  /**
   * Initialize paginated messages.
   * @param {PageBuilder} builder
   * @param {Message} msg
   */
  initPagination(builder, msg) {
    const pages = builder.createPages();
    if (pages.length === 0) return;

    const arrows = ["⬅️", "➡️"];
    const currPage = { n: 0 };

    const send = () => builder.getPage(currPage.n);

    msg.replyEmbed(send()).then((m) => {
      // Add reaction arrows
      m.message.react(arrows[0]).catch(() => {});
      m.message.react(arrows[1]).catch(() => {});

      const unobserve = m.onReaction(arrows, (e) => {
        if (e.emoji_id === arrows[0]) {
          currPage.n = Math.max(0, currPage.n - 1);
        } else {
          currPage.n = Math.min(pages.length - 1, currPage.n + 1);
        }
        m.editEmbed(send());
      });

      // Auto-close after 5 minutes
      setTimeout(() => {
        unobserve();
        m.editEmbed(send() + "\nSession closed - Changing pages **won't work** from here.");
      }, 5 * 60 * 1000);
    });
  }

  /**
   * @param {string} channelId
   * @returns {Promise<import("@fluxerjs/voice").VoiceConnection>}
   */
  async joinChannel(channelId) {
    const { joinVoiceChannel } = await import("@fluxerjs/voice");
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.guild) throw new Error("Cannot join a non-guild voice channel.");
    return joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
    });
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
    const oid = this.handler.observeUserMessagesChannel(user.id, this.channel, callback);
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
    if (!this.isVoice) throw "Cannot join a text channel. Attempting to 'join' into channel `" + this.channel?.id + "`";
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
    return this;
  }

  setMaxLines(maxLinesPerPage = 2) {
    this.maxLinesPerPage = maxLinesPerPage;
    return this;
  }

  createPages() {
    if (this.initiated) return this.pages;

    const lines = this.content;
    const pages = [];
    for (let i = 0, n = 0; i < lines.length; i++, (i % this.maxLinesPerPage === 0) ? n++ : n) {
      let line = lines[i];
      if (!pages[n]) pages[n] = [];
      pages[n].push(line);
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
