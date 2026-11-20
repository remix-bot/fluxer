/**
 * @module commands/top
 * @description Display the most played tracks and top artists for the server or global network.
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { GuildStats } from "../src/music/GuildStats.mjs";
import { cleanId, Utils } from "../src/utils/Utils.mjs";
import { getGlobalColor } from "../src/ui/index.mjs";

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
    (message.message?.content || message.content || "").split(/\s+/)[1] ??
    ""
  ).trim().toLowerCase();

  const isGlobal = rawArg === "global" || rawArg === "network";
  let timeframe = "month";
  if (isGlobal) {
    timeframe = "global";
  } else if (rawArg === "week" || rawArg === "w" || rawArg === "7d") {
    timeframe = "week";
  } else if (rawArg === "all" || rawArg === "alltime" || rawArg === "total") {
    timeframe = "all";
  }

  const { tracks, topArtist } = isGlobal
    ? GuildStats.getGlobalTopTracks(10)
    : GuildStats.getTopTracks(guildId, timeframe, 10);

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

  const footerText = isGlobal
    ? this.t(message, "responses.top.globalFooter", { prefix })
    : this.t(message, "responses.top.topFooter", { prefix });

  if (!tracks || tracks.length === 0) {
    const emptyEmbed = new EmbedBuilder()
      .setColor(getGlobalColor())
      .setAuthor({ name: authorName })
      .setTitle(titleName)
      .setDescription(this.t(message, "responses.top.noData", { prefix }))
      .setFooter({ text: footerText });
    return message.reply({ embeds: [emptyEmbed] });
  }

  const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
  const playsLabel = this.t(message, "responses.top.plays");

  const lines = tracks.map((t, i) => {
    const medal = medals[i] || `\`#${i + 1}\``;
    const cleanTitle = Utils.truncate(t.title, 40);
    const cleanArtist = Utils.truncate(t.artist, 30);
    return `${medal} **${cleanTitle}**\n   ↳ *${cleanArtist}* • \`${t.count} ${playsLabel}\``;
  });

  let desc = lines.join("\n\n");
  if (topArtist) {
    desc += `\n\n⭐ **Top Artist:** **${topArtist.name}** (\`${topArtist.count} ${playsLabel}\`)`;
  }

  const embed = new EmbedBuilder()
    .setColor(getGlobalColor())
    .setAuthor({ name: authorName })
    .setTitle(titleName)
    .setDescription(desc)
    .setFooter({ text: footerText });

  return message.reply({ embeds: [embed] });
}
