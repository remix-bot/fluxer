/**
 * @module src/ui/Wrappers
 * @description Message and Channel wrappers providing reply/edit/reaction
 * observation helpers on top of the raw @fluxerjs/core objects.
 */

/**
 * @class Channel
 * @description Wrapper around a raw channel object providing helpers for
 * sending messages and observing per-user messages.
 */
export class Channel {
  /** @type {object} The raw channel object. */
  channel;
  /** @type {import('./MessageHandler.mjs').MessageHandler} */
  handler;

  /**
   * @param {object} channel
   * @param {import('./MessageHandler.mjs').MessageHandler} handler
   */
  constructor(channel, handler) {
    this.channel = channel;
    this.handler = handler;
  }

  /** @returns {object|null} The guild this channel belongs to. */
  get server()  { return this.channel?.guild ?? null; }
  /** @returns {object|null} Alias for server (guild). */
  get guild()   { return this.channel?.guild ?? null; }
  /** @returns {boolean} Whether this channel is a voice channel. */
  get isVoice() { return this.channel?.isVoiceBased?.() ?? false; }
  /** @returns {string} The channel ID. */
  get id()      { return this.channel?.id; }
  /** @returns {string|null} The guild ID. */
  get guildId() { return this.channel?.guildId ?? null; }
  /** @returns {string|null} Alias for guildId. */
  get serverId() { return this.guildId; }

  /**
   * Observe messages from a specific user in this channel.
   * @param {Function} callback
   * @param {object} user
   * @returns {Function} Unobserve function.
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
   * Send a message to this channel.
   * @param {string|object} content
   * @returns {Promise<import('./Wrappers.mjs').Message|null>}
   */
  sendMessage(content) {
    return this.handler.sendMessage(this.channel, content);
  }

  /**
   * Alias for sendMessage.
   * @param {string|object} content
   * @returns {Promise<import('./Wrappers.mjs').Message|null>}
   */
  send(content) {
    return this.handler.sendMessage(this.channel, content);
  }

  /**
   * Send an embed to this channel.
   * @param {string|object} content
   * @param {object} [embedOptions={}]
   * @returns {Promise<import('./Wrappers.mjs').Message|null>}
   */
  sendEmbed(content, embedOptions = {}) {
    return this.handler.sendEmbed(this.channel, content, embedOptions);
  }

  /**
   * Join this voice channel.
   * @async
   * @returns {Promise<object>}
   * @throws {Error} If not a voice channel.
   */
  join() {
    if (!this.isVoice) throw new Error("Cannot join a text channel. Attempting to 'join' into channel `" + this.channel?.id + "`");
    return this.handler.joinChannel(this.channel.id);
  }
}

/**
 * @class Message
 * @description Wrapper around a raw message object providing helpers for
 * replying, editing, and reaction observation.
 */
export class Message {
  /** @type {object} */
  message;
  /** @type {import('./MessageHandler.mjs').MessageHandler} */
  handler;

  /**
   * @param {object} message
   * @param {import('./MessageHandler.mjs').MessageHandler} handler
   */
  constructor(message, handler) {
    this.message = message;
    this.handler = handler;
  }

  /** @returns {string} The raw message content. */
  get content()  { return this.message.content; }
  /** @returns {string} The message ID. */
  get id()       { return this.message.id; }
  /** @returns {object} The author object. */
  get author()   { return this.message.author; }
  /** @returns {string} The author's user ID. */
  get authorId() { return this.message.author?.id; }
  /** @returns {object|null} The guild member, if available. */
  get member()   { return this.message.member ?? null; }
  /** @returns {Channel} The wrapped channel this message was sent in. */
  get channel()  { return this.handler.getChannel(this.message.channelId); }

  /**
   * Observe reactions on this message.
   * @param {string[]} reactions
   * @param {Function} callback
   * @param {object} [user=null] - Restrict observation to one user.
   * @returns {Function} Unobserve function.
   */
  onReaction(reactions, callback, user = null) {
    const oid = this.handler.observeReactions(this.message, reactions, callback, user);
    return () => {
      this.handler.unobserveReactions(oid);
    };
  }

  /**
   * Reply to this message.
   * @param {string|object} content
   * @param {boolean} [mention=false]
   * @returns {Promise<Message|null>}
   */
  reply(content, mention = false) {
    return this.handler.reply(this.message, content, mention);
  }

  /**
   * Reply to this message with an embed.
   * @param {string|object} content
   * @param {boolean} [mention=false]
   * @param {object} [embedOptions={}]
   * @returns {Promise<Message|null>}
   */
  replyEmbed(content, mention = false, embedOptions = {}) {
    return this.handler.replyEmbed(this.message, content, {
      mention,
      embed: embedOptions
    });
  }

  /**
   * Edit this message's embed.
   * @param {string|object} content
   * @param {object} [embedOptions={}]
   * @returns {Promise<Message|null>}
   */
  editEmbed(content, embedOptions = {}) {
    return this.handler.editEmbed(this.message, content, embedOptions);
  }

  /**
   * Alias for editEmbed.
   * @param {string|object} content
   * @param {object} [embedOptions={}]
   * @returns {Promise<Message|null>}
   */
  edit(content, embedOptions = {}) {
    return this.handler.editEmbed(this.message, content, embedOptions);
  }
}
