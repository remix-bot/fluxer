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
    const embed = new EmbedBuilder().setColor(getGlobalColor()).setDescription("❌ There's nothing playing at the moment.").toJSON();
    return message.replyEmbed({ embeds: [embed] });
  }

  // Animated loading spinner
  let frame = 0;
  const loadingMsg = await message.replyEmbed({ embeds: [
    new EmbedBuilder().setColor(getGlobalColor())
      .setDescription(`${LOADING_FRAMES[0]} Searching lyrics for **${Utils.truncate(current.title, 40)}**...`)
      .toJSON()
  ] });

  const loadingInterval = setInterval(() => {
    frame = (frame + 1) % LOADING_FRAMES.length;
    loadingMsg.editEmbed({ embeds: [
      new EmbedBuilder().setColor(getGlobalColor())
        .setDescription(`${LOADING_FRAMES[frame]} Searching lyrics for **${Utils.truncate(current.title, 40)}**...`)
        .toJSON()
    ] }).catch(() => {});
  }, 800);

  try {
    const result = await p.lyrics();

    clearInterval(loadingInterval);

    if (!result || !result.text) {
      return loadingMsg.editEmbed({ embeds: [
        new EmbedBuilder().setColor(getGlobalColor())
          .setDescription(
            `❌ No lyrics available for **${Utils.truncate(current.title, 40)}**.\n\n` +
            `💡 NodeLink lyrics plugin may not have this track. Try a popular song!`
          ).toJSON()
      ] });
    }

    try { await loadingMsg.message.delete(); } catch {}

    const syncIndicator = result.synced ? " ⏱️ Synced" : "";
    const displayTitle  = Utils.cleanTitle(current.title);
    const artist        = current.artists?.[0]?.name || current.author?.name || "Unknown Artist";
    const lines         = result.text.split("\n").filter(l => l.trim());
    const totalLines    = lines.length;

    const LINES_PER_PAGE = 25;
    const totalPages     = Math.ceil(totalLines / LINES_PER_PAGE);

    // Single page — no pagination needed
    if (totalPages === 1) {
      const singleEmbed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle(`🎵 ${Utils.truncate(displayTitle, 50)}`)
        .setDescription([
          `by *${artist}*${syncIndicator}`,
          ``,
          "```",
          lines.join("\n"),
          "```"
        ].join("\n"))
        .setFooter({ text: `NodeLink • ${totalLines} lines` });
      if (current.thumbnail) singleEmbed.setThumbnail(current.thumbnail);
      return message.replyEmbed({ embeds: [singleEmbed.toJSON()] });
    }

    // Multi-page
    const pages = [];
    for (let i = 0; i < totalLines; i += LINES_PER_PAGE) {
      pages.push(lines.slice(i, i + LINES_PER_PAGE).join("\n"));
    }

    let currentPage      = 0;
    let emojiRemoveTimeout;

    const buildContent = (pageIdx, expired = false) => {
      const b = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle(`🎵 ${Utils.truncate(displayTitle, 50)}`)
        .setDescription([
          `by *${artist}*${syncIndicator} • Page ${pageIdx + 1}/${totalPages}`,
          ``,
          "```",
          pages[pageIdx],
          "```"
        ].join("\n"))
        .setFooter({ text: expired
          ? `⌛ Controls expired • NodeLink • ${totalLines} lines`
          : `NodeLink • ${totalLines} lines total` });
      if (current.thumbnail) b.setThumbnail(current.thumbnail);
      return { embeds: [b.toJSON()] };
    };

    const msg = await message.replyEmbed(buildContent(0));
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
        msg.editEmbed(buildContent(currentPage, true)).catch(() => {});
      }, EMOJI_REMOVE_TIMEOUT);
    };

    const unobserve = msg.onReaction(emojis, async (e) => {
      resetEmojiTimer();
      if (e.emoji_id === "⬅️") {
        currentPage = currentPage > 0 ? currentPage - 1 : totalPages - 1;
      } else if (e.emoji_id === "➡️") {
        currentPage = currentPage < totalPages - 1 ? currentPage + 1 : 0;
      }
      msg.editEmbed(buildContent(currentPage)).catch(() => {});
    });

    resetEmojiTimer();

    // Full session close after SESSION_MS
    setTimeout(() => {
      clearTimeout(emojiRemoveTimeout);
      unobserve();
      const closedEmbed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle(`🎵 ${Utils.truncate(displayTitle, 50)}`)
        .setDescription([
          `by *${artist}*${syncIndicator} • Page ${currentPage + 1}/${totalPages}`,
          ``,
          "```",
          pages[currentPage],
          "```"
        ].join("\n"))
        .setFooter({ text: `Session closed • NodeLink • ${totalLines} lines` });
      if (current.thumbnail) closedEmbed.setThumbnail(current.thumbnail);
      msg.editEmbed({ embeds: [closedEmbed.toJSON()] }).catch(() => {});
    }, SESSION_MS);

  } catch (err) {
    clearInterval(loadingInterval);
    logger.error("[Lyrics Command] Error:", err);
    loadingMsg.editEmbed({ embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(`❌ Error: ${Utils.truncate(err.message, 100)}`).toJSON()] }).catch(() => {});
  }
}