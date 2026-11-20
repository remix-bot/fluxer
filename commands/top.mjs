/**
 * @module commands/top
 * @description Display the most played tracks and top artists for the server or global network with pagination.
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { GuildStats } from "../src/music/GuildStats.mjs";
import { cleanId, Utils } from "../src/utils/Utils.mjs";
import { getGlobalColor } from "../src/ui/index.mjs";
import { run as runMyWrapped } from "./mywrapped.mjs";

const PAGE_SIZE = 10;
const MAX_TRACKS = 50;
const SESSION_MS = 60 * 1000;

/** @type {CommandBuilder} */
export const command = new CommandBuilder()
  .setName("top")
  .setDescription("View the most played songs and top artists in this server.", "commands.top")
  .addAliases("leaderboard", "chart", "toptracks")
  .setCategory("music")
  .addTextOption((o) =>
    o
      .setName("timeframe")
      .setDescription("Filter timeframe: week, month, all, or global, or page number.", "options.top.timeframe")
      .setRequired(false)
  );

/**
 * Run handler for the top command.
 * @param {object} message
 * @param {object} [data]
 * @returns {Promise<void>}
 */
export async function run(message, data) {
  const guildId = cleanId(message.message?.guildId ?? message.channel?.guildId);
  const prefix = this.handler.getPrefix(guildId) || "%";

  const rawArg = (
    data?.get?.("timeframe")?.value ??
    (message.message?.content || message.content || "")
      .trim()
      .split(/\s+/)
      .slice(1)
      .join(" ") ??
    ""
  ).trim().toLowerCase();

  const tokens = rawArg.split(/\s+/).filter(Boolean);

  if (tokens.includes("me") || tokens.includes("self") || tokens.includes("my")) {
    return runMyWrapped.call(this, message, data);
  }

  let isGlobal = false;
  let timeframe = "month";
  let targetPage = 1;

  for (const token of tokens) {
    const num = parseInt(token, 10);
    if (!isNaN(num) && num > 0) {
      targetPage = num;
    } else if (token === "global" || token === "network") {
      isGlobal = true;
      timeframe = "global";
    } else if (token === "week" || token === "w" || token === "7d") {
      timeframe = "week";
    } else if (token === "all" || token === "alltime" || token === "total") {
      timeframe = "all";
    } else if (token === "month" || token === "m" || token === "30d") {
      timeframe = "month";
    }
  }

  let { tracks, topArtist } = isGlobal
    ? await GuildStats.getGlobalTopTracks(MAX_TRACKS)
    : await GuildStats.getTopTracks(guildId, timeframe, MAX_TRACKS);

  let fallbackGlobal = false;
  if ((!tracks || tracks.length === 0) && !isGlobal) {
    const globalRes = await GuildStats.getGlobalTopTracks(MAX_TRACKS);
    if (globalRes?.tracks && globalRes.tracks.length > 0) {
      tracks = globalRes.tracks;
      topArtist = globalRes.topArtist;
      fallbackGlobal = true;
    }
  }

  const authorName = (isGlobal || fallbackGlobal)
    ? `🌐 ${this.t(message, "responses.top.globalAuthor")}`
    : `🏆 ${this.t(message, "responses.top.topAuthor")}`;

  const timeframeLabel = (isGlobal || fallbackGlobal)
    ? "Global"
    : (timeframe === "week"
      ? this.t(message, "responses.top.timeframeWeek")
      : (timeframe === "all" ? this.t(message, "responses.top.timeframeAll") : this.t(message, "responses.top.timeframeMonth")));

  const titleName = (isGlobal || fallbackGlobal)
    ? this.t(message, "responses.top.globalTitle")
    : this.t(message, "responses.top.topTitle", { timeframe: timeframeLabel });

  const baseFooter = (isGlobal || fallbackGlobal)
    ? this.t(message, "responses.top.globalFooter", { prefix })
    : this.t(message, "responses.top.topFooter", { prefix });

  if (!tracks || tracks.length === 0) {
    const emptyEmbed = new EmbedBuilder()
      .setColor(getGlobalColor())
      .setAuthor({ name: authorName })
      .setTitle(titleName)
      .setDescription(this.t(message, "responses.top.noData", { prefix }))
      .setFooter({ text: baseFooter });
    return message.reply({ embeds: [emptyEmbed] });
  }

  const totalPages = Math.max(1, Math.ceil(tracks.length / PAGE_SIZE));
  let currentPage = Math.max(1, Math.min(targetPage, totalPages));

  const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
  const playsLabel = this.t(message, "responses.top.plays");

  const buildEmbed = (page, expired = false) => {
    const safePage = Math.max(1, Math.min(page, totalPages));
    const startIdx = (safePage - 1) * PAGE_SIZE;
    const pageTracks = tracks.slice(startIdx, startIdx + PAGE_SIZE);

    const lines = pageTracks.map((t, idx) => {
      const rank = startIdx + idx + 1;
      const rankBadge = rank <= 10 ? medals[rank - 1] : `\`#${rank}\``;
      const cleanTitle = Utils.truncate(t.title, 40);
      const cleanArtist = Utils.truncate(t.artist, 30);
      return `${rankBadge} **${cleanTitle}**\n   ↳ *${cleanArtist}* • \`${t.count} ${playsLabel}\``;
    });

    let desc = lines.join("\n\n");
    if (fallbackGlobal && safePage === 1) {
      const note = this.t(message, "responses.top.serverFallbackNote");
      if (note) {
        desc = `${note}\n\n${desc}`;
      }
    }

    if (topArtist && safePage === 1) {
      desc += `\n\n⭐ **Top Artist:** **${topArtist.name}** (\`${topArtist.count} ${playsLabel}\`)`;
    }

    let footerText = totalPages > 1
      ? `${this.t(message, "responses.top.pageFooter", { page: safePage, totalPages, timeframe: timeframeLabel })} • ${baseFooter}`
      : baseFooter;

    if (expired) {
      const closedLabel = this.handler?.locale?.translate(guildId, "pagination.embed.sclosedTitle") || "Session Closed";
      footerText += ` • ${closedLabel}`;
    }

    return new EmbedBuilder()
      .setColor(getGlobalColor())
      .setAuthor({ name: authorName })
      .setTitle(titleName)
      .setDescription(desc)
      .setFooter({ text: footerText });
  };

  const msg = await message.reply({ embeds: [buildEmbed(currentPage)] });
  if (!msg || totalPages <= 1) return;

  const rawMsg = msg.message ?? msg;
  if (!rawMsg?.react) return;

  const emojis = ["⬅️", "➡️"];
  for (const emoji of emojis) {
    await rawMsg.react(emoji).catch(() => {});
  }

  const clearReactions = async () => {
    try {
      await rawMsg.removeAllReactions();
    } catch {
      for (const emoji of emojis) {
        await rawMsg.removeReaction(emoji).catch(() => {});
      }
    }
  };

  let timer = null;
  const resetTimer = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      if (typeof unobserve === "function") unobserve();
      await clearReactions().catch(() => {});
      msg.edit({ embeds: [buildEmbed(currentPage, true)] }).catch(() => {});
    }, SESSION_MS);
  };

  const unobserve = msg.onReaction(emojis, async (e) => {
    resetTimer();
    const emoji = e.emoji_id;
    if (emoji === "⬅️") {
      currentPage = currentPage <= 1 ? totalPages : currentPage - 1;
    } else if (emoji === "➡️") {
      currentPage = currentPage >= totalPages ? 1 : currentPage + 1;
    }
    msg.edit({ embeds: [buildEmbed(currentPage)] }).catch(() => {});
  });

  resetTimer();
}
