/**
 * @module commands/top
 * @description Display the most played tracks and top artists for the server or global network with pagination.
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { GuildStats } from "../src/music/GuildStats.mjs";
import { cleanId, Utils } from "../src/utils/Utils.mjs";
import { getGlobalColor, QueuePaginator } from "../src/ui/index.mjs";

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
      .setDescription("Filter timeframe: week, month, all, or global.", "options.top.timeframe")
      .setRequired(false)
  )
  .addNumberOption((o) =>
    o
      .setName("page")
      .setDescription("Page number to jump to.", "options.top.page")
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

  let requestedPage = data?.get?.("page")?.value;
  let rawTimeframe = data?.get?.("timeframe")?.value;

  if (!rawTimeframe || !requestedPage) {
    const rawTokens = (message.message?.content || message.content || "")
      .trim()
      .split(/\s+/)
      .slice(1);

    for (const token of rawTokens) {
      const lower = token.toLowerCase();
      const num = parseInt(lower, 10);
      if (!isNaN(num) && num > 0 && !requestedPage) {
        requestedPage = num;
      } else if (!rawTimeframe) {
        if (["global", "network", "week", "w", "7d", "all", "alltime", "total", "month", "m", "30d"].includes(lower)) {
          rawTimeframe = lower;
        }
      }
    }
  }

  const isGlobal = rawTimeframe === "global" || rawTimeframe === "network";
  let timeframe = "month";
  if (isGlobal) {
    timeframe = "global";
  } else if (rawTimeframe === "week" || rawTimeframe === "w" || rawTimeframe === "7d") {
    timeframe = "week";
  } else if (rawTimeframe === "all" || rawTimeframe === "alltime" || rawTimeframe === "total") {
    timeframe = "all";
  }

  const { tracks, topArtist } = isGlobal
    ? await GuildStats.getGlobalTopTracks(MAX_TRACKS)
    : await GuildStats.getTopTracks(guildId, timeframe, MAX_TRACKS);

  const authorName = isGlobal
    ? `🌐 ${this.t(message, "responses.top.globalAuthor")}`
    : `🏆 ${this.t(message, "responses.top.topAuthor")}`;

  const timeframeLabel = isGlobal
    ? "Global"
    : (timeframe === "week"
      ? this.t(message, "responses.top.timeframeWeek")
      : (timeframe === "all" ? this.t(message, "responses.top.timeframeAll") : this.t(message, "responses.top.timeframeMonth")));

  const titleName = isGlobal
    ? this.t(message, "responses.top.globalTitle")
    : this.t(message, "responses.top.topTitle", { timeframe: timeframeLabel });

  const baseFooter = isGlobal
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
  const parsedPage = Number(requestedPage);
  const startPage = Math.max(1, Math.min((!parsedPage || isNaN(parsedPage)) ? 1 : Math.floor(parsedPage), totalPages));

  const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
  const playsLabel = this.t(message, "responses.top.plays");

  const buildEmbed = (page) => {
    const safePage = (isNaN(page) || page < 1) ? 1 : Math.min(Math.floor(page), totalPages);
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
    if (topArtist && safePage === 1) {
      desc += `\n\n⭐ **Top Artist:** **${topArtist.name}** (\`${topArtist.count} ${playsLabel}\`)`;
    }

    const footerText = totalPages > 1
      ? `${this.t(message, "responses.top.pageFooter", { page: safePage, totalPages, timeframe: timeframeLabel })} • ${baseFooter}`
      : baseFooter;

    return new EmbedBuilder()
      .setColor(getGlobalColor())
      .setAuthor({ name: authorName })
      .setTitle(titleName)
      .setDescription(desc)
      .setFooter({ text: footerText });
  };

  if (totalPages <= 1) {
    return message.reply({ embeds: [buildEmbed(1)] });
  }

  new QueuePaginator(message, this.messages, this.client)
    .setTimeout(SESSION_MS)
    .send(buildEmbed, totalPages, startPage)
    .catch(() => {});
}
