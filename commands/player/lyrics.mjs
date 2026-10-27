/**
 * @module commands/player/lyrics
 * @description Embedded lyrics viewer for the player panel (verbatim body of
 * the original "lyrics" reaction case): paginated lyric pages with navigation
 * reactions, control-expiry timer and close handling. Session-scoped mutable
 * state lives in the shared `session` object ({activeLyricsMsg, unobserve,
 * emojiTimeout}) so the panel's closeSession can clean it up.
 */

import { Utils } from "../../src/utils/Utils.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../../src/ui/index.mjs";
import { EMOJI_REMOVE_TIMEOUT } from "../../src/utils/UI.mjs";
import { logger } from "../../src/core/Logger.mjs";

/**
 * Remove navigation reactions from a lyrics message.
 * @param {object} lyricsMsg - The wrapped lyrics message with a .message property.
 * @returns {Promise<void>}
 */
export async function clearLyricsReactions(lyricsMsg) {
  if (!lyricsMsg?.message) return;
  try {
    await lyricsMsg.message.removeAllReactions();
  } catch (e) {
    for (const emoji of ["⬅️", "➡️", "❌"]) {
      try {
          await lyricsMsg.message.removeReaction(emoji);
      } catch(e) { logger.warn("[Player] Error:", e?.message); }
    }
  }
}

/**
 * Open (or reopen) the lyrics viewer for the player's current track.
 *
 * Mirrors the original `case "lyrics":` flow exactly: announces fetching,
 * tears down a previous viewer, fetches lyrics from the player, renders
 * paginated content, wires navigation/close reactions with the shared
 * emoji-expiry timer, and returns the final reply string. Every exit path
 * corresponds to `shouldUpdate = true` in the original switch, so the caller
 * always refreshes the panel afterwards.
 *
 * @param {object} bot - The bot instance (locale translation via bot.t).
 * @param {object} msg - The command message wrapper.
 * @param {object} player - The guild player (player.lyrics(), queue).
 * @param {function} refresh - Panel refresh callback ({ message }) => void.
 * @param {object} session - Shared viewer state: { activeLyricsMsg, unobserve, emojiTimeout }.
 * @returns {Promise<string>} The reply message text to surface on the panel.
 */
export async function openLyricsViewer(bot, msg, player, refresh, session) {
  let reply = bot.t(msg, "responses.player.fetchingLyrics");
  refresh({ message: reply });

  try {
    if (session.unobserve) {
      session.unobserve();
      clearTimeout(session.emojiTimeout);
      if (session.activeLyricsMsg) await clearLyricsReactions(session.activeLyricsMsg);
    }

    const lyricsResult = await player.lyrics();
    if (!lyricsResult) {
      return bot.t(msg, "responses.player.noLyricsFound");
    }

    const syncBadge = lyricsResult.synced ? " ⏱️ Synced" : "";
    const lines = lyricsResult.text.split('\n');
    const totalLines = lines.length;
    const LINES_PER_PAGE = 25;
    const totalPages = Math.ceil(totalLines / LINES_PER_PAGE);

    const pages = [];
    for (let i = 0; i < totalLines; i += LINES_PER_PAGE) {
      pages.push(lines.slice(i, i + LINES_PER_PAGE).join('\n'));
    }

    let currentPage = 0;

    const buildLyricsContent = (pageIdx, expired = false, closed = false) => {
      const current = player.queue.getCurrent();
      const rawTitle = current?.title?.replace(/\(Official.*?\)/gi, '').trim() ?? 'Unknown Track';
      const title = Utils.truncate(rawTitle, 50);
      const artist = current?.artist || (typeof current?.author === "object" ? current?.author?.name : current?.author) || "";
      const lyricsSource = lyricsResult.source || "Lyrics";
      const footerText = closed
          ? `👋 Lyrics closed • ${lyricsSource} • ${totalLines} lines`
          : expired
              ? `⌛ Controls expired • ${lyricsSource} • ${totalLines} lines`
              : `${lyricsSource} • ${totalLines} lines total${lyricsResult.synced ? ' • Synced' : ''}`;
      const headerLine = artist ? `by **${artist}**${syncBadge} • Page ${pageIdx + 1}/${totalPages}` : `Page ${pageIdx + 1}/${totalPages}${syncBadge}`;
      const desc = [
        headerLine,
        "",
        "```",
        pages[pageIdx],
        totalPages > 1 && !expired && !closed ? "\n\n💡 ⬅️ ➡️ Navigate • ❌ Close" : "",
        "```"
      ].join("\n");

      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setAuthor({ name: bot.t(msg, "responses.lyrics.lyricsAuthor") })
        .setTitle(title)
        .setDescription(desc)
        .setFooter({ text: footerText });

      if (current?.thumbnail) {
        embed.setThumbnail(current.thumbnail);
      }

      return { embeds: [embed] };
    };

    session.activeLyricsMsg = await msg.reply(buildLyricsContent(0));

    if (session.activeLyricsMsg?.message && totalPages > 1) {
      const navEmojis = ["⬅️", "➡️", "❌"];
      for (const emoji of navEmojis) {
        await session.activeLyricsMsg.message.react(emoji).catch(() => {});
      }

      const resetLyricsTimer = () => {
        clearTimeout(session.emojiTimeout);
        session.emojiTimeout = setTimeout(async () => {
          await clearLyricsReactions(session.activeLyricsMsg);
          await session.activeLyricsMsg.edit(buildLyricsContent(currentPage, true, false)).catch(() => {});
        }, EMOJI_REMOVE_TIMEOUT);
      };

      session.unobserve = session.activeLyricsMsg.onReaction(navEmojis, async (e) => {
        if (e.emoji_id === "❌") {
          session.unobserve();
          clearTimeout(session.emojiTimeout);
          await clearLyricsReactions(session.activeLyricsMsg);
          await session.activeLyricsMsg.edit(buildLyricsContent(currentPage, false, true)).catch(() => {});
          return;
        }

        resetLyricsTimer();

        if (e.emoji_id === "⬅️") {
          currentPage = currentPage > 0 ? currentPage - 1 : totalPages - 1;
        } else if (e.emoji_id === "➡️") {
          currentPage = currentPage < totalPages - 1 ? currentPage + 1 : 0;
        }

        await session.activeLyricsMsg.edit(buildLyricsContent(currentPage));
      });

      resetLyricsTimer();
    } else if (session.activeLyricsMsg?.message) {
      await session.activeLyricsMsg.message.react("❌").catch(() => {});

      const resetLyricsTimer = () => {
        clearTimeout(session.emojiTimeout);
        session.emojiTimeout = setTimeout(async () => {
          await clearLyricsReactions(session.activeLyricsMsg);
          await session.activeLyricsMsg.edit(buildLyricsContent(0, true, false)).catch(() => {});
        }, EMOJI_REMOVE_TIMEOUT);
      };

      session.unobserve = session.activeLyricsMsg.onReaction(["❌"], async (e) => {
        if (e.emoji_id === "❌") {
          session.unobserve();
          clearTimeout(session.emojiTimeout);
          await clearLyricsReactions(session.activeLyricsMsg);
          await session.activeLyricsMsg.edit(buildLyricsContent(0, false, true)).catch(() => {});
        }
      });

      resetLyricsTimer();
    }

    return bot.t(msg, "responses.player.lyricsDisplayed", { lines: totalLines, pages: totalPages });

  } catch (err) {
    return bot.t(msg, "responses.player.lyricsError", { error: Utils.truncate(err.message, 50) });
  }
}
