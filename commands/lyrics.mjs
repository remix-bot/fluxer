import { CommandBuilder } from "../src/CommandHandler.mjs";
import { logger } from "../src/constants/Logger.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";
import { Utils } from "../src/Utils.mjs";

export const command = new CommandBuilder()
    .setName("lyrics")
    .setDescription("Display synced lyrics from NodeLink", "commands.lyrics")
    .addAliases("lyric", "ly")
    .setCategory("music");

const LOADING_FRAMES     = ["◐", "◓", "◑", "◒"];
const EMOJI_REMOVE_TIMEOUT = 60_000;
const SESSION_MS           = 180_000;

export async function run(message) {
  const p = await this.getPlayer(message, false, false, false);
  if (!p) return;

  const current = p.queue.getCurrent();
  if (!current) {
    const embed = new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(message, "responses.lyrics.nothingPlaying"));
    return message.reply({ embeds: [embed] });
  }

  // Animated loading spinner
  let frame = 0;
  const loadingMsg = await message.reply({ embeds: [
    new EmbedBuilder().setColor(getGlobalColor())
      .setDescription(`${LOADING_FRAMES[0]} ` + this.t(message, "responses.lyrics.searching", { title: Utils.truncate(current.title, 40) }))
      
  ] });

  const loadingInterval = setInterval(() => {
    frame = (frame + 1) % LOADING_FRAMES.length;
    loadingMsg.edit({ embeds: [
      new EmbedBuilder().setColor(getGlobalColor())
      .setDescription(`${LOADING_FRAMES[frame]} ` + this.t(message, "responses.lyrics.searching", { title: Utils.truncate(current.title, 40) }))
        
    ] }).catch(() => {});
  }, 800);

  try {
    const result = await p.lyrics();

    clearInterval(loadingInterval);

    if (!result || !result.text) {
      return loadingMsg.edit({ embeds: [
        new EmbedBuilder().setColor(getGlobalColor())
          .setDescription(
            this.t(message, "responses.lyrics.noLyrics", { title: Utils.truncate(current.title, 40) })
          )
      ] });
    }

    try { await loadingMsg.message.delete(); } catch {}

    const syncIndicator = result.synced ? this.t(message, "responses.lyrics.syncedBadge") : "";
    const displayTitle  = Utils.cleanTitle(current.title);
    const artist        = current.artists?.[0]?.name || current.author?.name || "Unknown Artist";
    const lines         = result.text.split("\n").filter(l => l.trim());
    const totalLines    = lines.length;

    const LINES_PER_PAGE = 25;
    const MAX_DESC       = 4096;
    let totalPages       = Math.ceil(totalLines / LINES_PER_PAGE);

    // Build page payloads — each is the raw lyric lines for that page
    const pages = [];
    for (let i = 0; i < totalLines; i += LINES_PER_PAGE) {
      pages.push(lines.slice(i, i + LINES_PER_PAGE).join("\n"));
    }

    // ── Re-check: if a page's content + header + code block exceeds 4096, re-split
    //    into smaller chunks so setDescription never throws RangeError. ──────────
    const CODE_WRAP = 13; // "```\n" (4) + "\n```" (5) + header-ish overhead
    {
      const reshaped = [];
      for (const pageText of pages) {
        const headerLine = `by *${artist}*${syncIndicator}`;
        const overhead   = headerLine.length + 1 + 1 + CODE_WRAP; // header + blank + ``` + ```
        const budget     = MAX_DESC - overhead;
        if (pageText.length <= budget) {
          reshaped.push(pageText);
        } else {
          // Split this page's text into chunks that fit
          const pageLines = pageText.split("\n");
          let chunk = "";
          for (const ln of pageLines) {
            if (chunk.length + ln.length + 1 > budget) {
              if (chunk) reshaped.push(chunk);
              chunk = ln;
            } else {
              chunk += (chunk ? "\n" : "") + ln;
            }
          }
          if (chunk) reshaped.push(chunk);
        }
      }
      pages.length = 0;
      pages.push(...reshaped);
      totalPages = pages.length;
    }

    // ── Single page — no pagination needed ────────────────────────────────────
    if (totalPages === 1) {
      const headerLine = `by *${artist}*${syncIndicator}`;
      const descBody   = pages[0];
      const singleDesc = [headerLine, "", "```", descBody, "```"].join("\n");

      const singleEmbed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle(`🎵 ${Utils.truncate(displayTitle, 50)}`)
        .setDescription(singleDesc.slice(0, MAX_DESC))
        .setFooter({ text: this.t(message, "responses.lyrics.nodeLinkFooter", { lines: totalLines }) });
      if (current.thumbnail) singleEmbed.setThumbnail(current.thumbnail);
      return message.reply({ embeds: [singleEmbed] });
    }

    // ── Multi-page ────────────────────────────────────────────────────────────
    let currentPage      = 0;
    let emojiRemoveTimeout;

    const buildContent = (pageIdx, expired = false) => {
      const headerLine = `by *${artist}*${syncIndicator} • Page ${pageIdx + 1}/${totalPages}`;
      const descBody   = pages[pageIdx];
      const desc       = [headerLine, "", "```", descBody, "```"].join("\n");

      const b = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle(`🎵 ${Utils.truncate(displayTitle, 50)}`)
        .setDescription(desc.slice(0, MAX_DESC))
        .setFooter({ text: expired
          ? this.t(message, "responses.lyrics.controlsExpired", { lines: totalLines })
          : this.t(message, "responses.lyrics.nodeLinkFooter", { lines: totalLines }) });
      if (current.thumbnail) b.setThumbnail(current.thumbnail);
      return { embeds: [b] };
    };

    const msg = await message.reply(buildContent(0));
    if (!msg?.message) return;

    const emojis = ["⬅️", "➡️"];
    for (const emoji of emojis) {
      await msg.message.react(emoji).catch(() => {});
    }

    const clearReactions = async () => {
      try {
        await msg.message.removeAllReactions();
      } catch {
        for (const emoji of emojis) {
          await msg.message.removeReaction(emoji).catch(() => {});
        }
      }
    };

    const resetEmojiTimer = () => {
      clearTimeout(emojiRemoveTimeout);
      emojiRemoveTimeout = setTimeout(async () => {
        await clearReactions();
        msg.edit(buildContent(currentPage, true)).catch(() => {});
      }, EMOJI_REMOVE_TIMEOUT);
    };

    const unobserve = msg.onReaction(emojis, async (e) => {
      resetEmojiTimer();
      if (e.emoji_id === "⬅️") {
        currentPage = currentPage > 0 ? currentPage - 1 : totalPages - 1;
      } else if (e.emoji_id === "➡️") {
        currentPage = currentPage < totalPages - 1 ? currentPage + 1 : 0;
      }
      msg.edit(buildContent(currentPage)).catch(() => {});
    });

    resetEmojiTimer();

    // Full session close after SESSION_MS
    setTimeout(() => {
      clearTimeout(emojiRemoveTimeout);
      unobserve();
      const closedHeader = `by *${artist}*${syncIndicator} • Page ${currentPage + 1}/${totalPages}`;
      const closedDesc   = [closedHeader, "", "```", pages[currentPage], "```"].join("\n");
      const closedEmbed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle(`🎵 ${Utils.truncate(displayTitle, 50)}`)
        .setDescription(closedDesc.slice(0, MAX_DESC))
        .setFooter({ text: this.t(message, "responses.lyrics.sessionClosed", { lines: totalLines }) });
      if (current.thumbnail) closedEmbed.setThumbnail(current.thumbnail);
      msg.edit({ embeds: [closedEmbed] }).catch(() => {});
    }, SESSION_MS);

  } catch (err) {
    clearInterval(loadingInterval);
    logger.error("[Lyrics Command] Error:", err);
    loadingMsg.edit({ embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(message, "responses.lyrics.error", { error: Utils.truncate(err.message, 100) }))] }).catch(() => {});
  }
}