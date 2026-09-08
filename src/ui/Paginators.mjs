/**
 * @module src/ui/Paginators
 * @description Pagination primitives: PageBuilder (line splitting with a
 * template form), RichPaginator (multi-tab embeds) and QueuePaginator
 * (two-arrow embed paging).
 */

import { EmbedBuilder } from "@fluxerjs/core";
import { logger } from "../core/Logger.mjs";
import { Message } from "./Wrappers.mjs";
import { getGlobalColor } from "./Embeds.mjs";

/**
 * @class PageBuilder
 * @description Splits content into pages with template-based formatting
 * ($maxPage / $currentPage / $content placeholders).
 */
export class PageBuilder {
  /** @type {string} Template form string. */
  form = "";
  /** @type {number} Maximum lines per page. */
  maxLinesPerPage = 2;
  /** @type {Array|string[]} Content lines or array items. */
  content = [];
  /** @type {boolean} Whether pages have been created. */
  initiated = false;
  /** @type {Array<Array>} Created page arrays. */
  pages = [];

  /**
   * @param {string|Array} content - String to split by newlines or an array of items.
   */
  constructor(content) {
    if (!Array.isArray(content)) {
      this.content = content.split("\n");
      return;
    }
    this.content = content;
  }

  /**
   * Set the template form string.
   * @param {string} form
   * @returns {PageBuilder}
   */
  setForm(form) {
    this.form = form;
    this.initiated = false;
    return this;
  }

  /**
   * Set the maximum lines per page.
   * @param {number} [maxLinesPerPage=2]
   * @returns {PageBuilder}
   */
  setMaxLines(maxLinesPerPage = 2) {
    this.maxLinesPerPage = maxLinesPerPage;
    this.initiated = false;
    return this;
  }

  /**
   * Create page arrays from content. Lazily initialized.
   * @returns {Array<Array>}
   */
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
   * Get a formatted page string by index (0-based).
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
   * Get raw page content by index (0-based) without template formatting.
   * @param {number} n
   * @returns {string|null}
   */
  getContent(n) {
    const pages = this.createPages();
    if (!pages[n]) return null;
    return pages[n].join("\n");
  }

  /**
   * Get the total number of pages.
   * @returns {number}
   */
  size() {
    return this.pages.length;
  }
}

/**
 * @class RichPaginator
 * @description Multi-tab paginated embed with tab and arrow navigation via
 * reactions. Closes the session after an inactivity timeout.
 */
export class RichPaginator {
  /**
   * @param {Message} msg
   * @param {import('./MessageHandler.mjs').MessageHandler} handler
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

  /** @param {number} ms @returns {RichPaginator} */
  setTimeout(ms) { this._timeout = ms; return this; }
  /** @param {number} color @returns {RichPaginator} */
  setColor(color) { this._color = color; return this; }
  /** @param {number} idx @returns {RichPaginator} */
  setStartTab(idx) { this._state.tab = idx; return this; }
  /** @param {string} prev @param {string} next @returns {RichPaginator} */
  setPrevNext(prev, next) { this._prev = prev; this._next = next; return this; }

  /**
   * Add a tab to the paginator.
   * @param {object} tab
   * @param {string} tab.emoji
   * @param {string} tab.title
   * @param {string} tab.header
   * @param {string} [tab.content]
   * @param {string[]} [tab.pages]
   * @returns {RichPaginator}
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

  /**
   * @private Build an embed for a given tab and sub-page.
   * @param {number} tabIdx
   * @param {number} pageIdx
   * @returns {EmbedBuilder}
   */
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

  /**
   * @async Send the paginated embed and start observing reactions.
   * @returns {Promise<object|null>} The raw sent message.
   */
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
        if (String(e?.message ?? e).includes("Message wasn't found") || e?.code === 10008) return;
        logger.warn("[RichPaginator] removeAllReactions failed:", e?.message ?? e);
      }
      for (const emoji of allReactions) {
        try {
          await rawMsg.removeReaction(emoji);
        } catch(e) {
          if (String(e?.message ?? e).includes("Message wasn't found") || e?.code === 10008) return;
          logger.warn("[MessageHandler] Error:", e?.message);
        }
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

/**
 * @class QueuePaginator
 * @description Simple two-arrow paginator for queue embeds with page count.
 */
export class QueuePaginator {
  /**
   * @param {Message} msg
   * @param {import('./MessageHandler.mjs').MessageHandler} handler
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

  /** @param {number} ms @returns {QueuePaginator} */
  setTimeout(ms) { this._timeout = ms; return this; }
  /** @param {string} prev @param {string} next @returns {QueuePaginator} */
  setPrevNext(prev, next) { this._prev = prev; this._next = next; return this; }

  /**
   * @async Send the paginated embed and observe arrow reactions.
   * @param {Function} buildEmbed - Function that takes a 1-based page number and returns an EmbedBuilder.
   * @param {number} totalPages
   * @param {number} [startPage=1]
   * @returns {Promise<object|null>} The raw sent message.
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

    /** @private Clear all reactions on the paginator message. */
    const clearReactions = async () => {
      try {
        await rawMsg.removeAllReactions();
      } catch (e) {
        // Message deleted — nothing left to clean up.
        if (String(e?.message ?? e).includes("Message wasn't found") || e?.code === 10008) return;
        for (const emoji of [prev, next]) {
          try {
            await rawMsg.removeReaction(emoji);
          } catch(e) {
            if (String(e?.message ?? e).includes("Message wasn't found") || e?.code === 10008) return;
            logger.warn("[MessageHandler] Error:", e?.message);
          }
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
