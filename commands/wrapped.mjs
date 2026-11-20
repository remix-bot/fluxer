/**
 * @module commands/wrapped
 * @description Generate community music recap and statistics for the server or global network.
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { GuildStats } from "../src/music/GuildStats.mjs";
import { cleanId, Utils } from "../src/utils/Utils.mjs";
import { getGlobalColor } from "../src/ui/index.mjs";

/** @type {CommandBuilder} */
export const command = new CommandBuilder()
  .setName("wrapped")
  .setDescription("Generate a community music recap and listening statistics.", "commands.wrapped")
  .addAliases("recap", "summary")
  .setCategory("music")
  .addTextOption((o) =>
    o
      .setName("scope")
      .setDescription("Recap scope: server or global.", "options.wrapped.scope")
      .setRequired(false)
  );

/**
 * Run handler for the wrapped command.
 * @param {object} message
 * @param {object} [data]
 * @returns {Promise<void>}
 */
export async function run(message, data) {
  const guildId = cleanId(message.message?.guildId ?? message.channel?.guildId);
  const prefix = this.handler.getPrefix(guildId) || "%";

  const rawArg = (
    data?.get?.("scope")?.value ??
    (message.message?.content || message.content || "").split(/\s+/)[1] ??
    ""
  ).trim().toLowerCase();

  const isGlobal = rawArg === "global" || rawArg === "all" || rawArg === "network";

  if (isGlobal) {
    const serverCount = this.client?.guilds?.size ?? 1300;
    const stats = GuildStats.getGlobalWrapped(serverCount);

    if (!stats) {
      const emptyEmbed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setAuthor({ name: `🌐 ${this.t(message, "responses.wrapped.globalAuthor")}` })
        .setTitle(this.t(message, "responses.wrapped.globalTitle"))
        .setDescription(this.t(message, "responses.top.noData", { prefix }))
        .setFooter({ text: this.t(message, "responses.wrapped.globalFooter", { prefix }) });
      return message.reply({ embeds: [emptyEmbed] });
    }

    const playsLabel = this.t(message, "responses.top.plays");
    const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];

    let topSongsText = "";
    if (stats.topTracks && stats.topTracks.length > 0) {
      topSongsText = stats.topTracks
        .map((t, i) => `${medals[i] || "•"} **${Utils.truncate(t.title, 35)}** — *${Utils.truncate(t.artist, 25)}* (\`${t.count} ${playsLabel}\`)`)
        .join("\n");
    } else {
      topSongsText = "_No track history recorded yet._";
    }

    const embed = new EmbedBuilder()
      .setColor(getGlobalColor())
      .setAuthor({ name: `🌐 ${this.t(message, "responses.wrapped.globalAuthor")}` })
      .setTitle(this.t(message, "responses.wrapped.globalTitle"))
      .addFields(
        {
          name: `⏱️ ${this.t(message, "responses.wrapped.totalStreamed")}`,
          value: `**${stats.totalHours}** hours`,
          inline: true,
        },
        {
          name: `🎵 ${this.t(message, "responses.wrapped.tracksQueued")}`,
          value: `**${stats.totalTracks.toLocaleString()}** tracks`,
          inline: true,
        },
        {
          name: `⏰ ${this.t(message, "responses.wrapped.peakHour")}`,
          value: `**${stats.peakHour}**`,
          inline: true,
        },
        {
          name: `🌍 ${this.t(message, "responses.wrapped.activeServers")}`,
          value: `**${stats.totalGuilds.toLocaleString()}** servers`,
          inline: false,
        },
        {
          name: `🏆 ${this.t(message, "responses.wrapped.topSongs")}`,
          value: topSongsText,
          inline: false,
        }
      )
      .setFooter({ text: this.t(message, "responses.wrapped.globalFooter", { prefix }) });

    return message.reply({ embeds: [embed] });
  }

  const stats = GuildStats.getWrapped(guildId);

  if (!stats) {
    const emptyEmbed = new EmbedBuilder()
      .setColor(getGlobalColor())
      .setAuthor({ name: `🎧 ${this.t(message, "responses.wrapped.wrappedAuthor")}` })
      .setTitle(this.t(message, "responses.wrapped.wrappedTitle"))
      .setDescription(this.t(message, "responses.top.noData", { prefix }))
      .setFooter({ text: this.t(message, "responses.wrapped.wrappedFooter", { prefix }) });
    return message.reply({ embeds: [emptyEmbed] });
  }

  const playsLabel = this.t(message, "responses.top.plays");
  const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];

  let topSongsText = "";
  if (stats.topTracks && stats.topTracks.length > 0) {
    topSongsText = stats.topTracks
      .map((t, i) => `${medals[i] || "•"} **${Utils.truncate(t.title, 35)}** — *${Utils.truncate(t.artist, 25)}* (\`${t.count} ${playsLabel}\`)`)
      .join("\n");
  } else {
    topSongsText = "_No track history recorded yet._";
  }

  const djMention = stats.topUserId ? `<@${stats.topUserId}> (\`${stats.topUserPlays} ${playsLabel}\`)` : "N/A";

  const embed = new EmbedBuilder()
    .setColor(getGlobalColor())
    .setAuthor({ name: `🎧 ${this.t(message, "responses.wrapped.wrappedAuthor")}` })
    .setTitle(this.t(message, "responses.wrapped.wrappedTitle"))
    .addFields(
      {
        name: `⏱️ ${this.t(message, "responses.wrapped.totalStreamed")}`,
        value: `**${stats.totalHours}** hours`,
        inline: true,
      },
      {
        name: `🎵 ${this.t(message, "responses.wrapped.tracksQueued")}`,
        value: `**${stats.totalTracks.toLocaleString()}** tracks`,
        inline: true,
      },
      {
        name: `⏰ ${this.t(message, "responses.wrapped.peakHour")}`,
        value: `**${stats.peakHour}**`,
        inline: true,
      },
      {
        name: `👑 ${this.t(message, "responses.wrapped.topDJ")}`,
        value: djMention,
        inline: false,
      },
      {
        name: `🏆 ${this.t(message, "responses.wrapped.topSongs")}`,
        value: topSongsText,
        inline: false,
      }
    )
    .setFooter({ text: this.t(message, "responses.wrapped.wrappedFooter", { prefix }) });

  return message.reply({ embeds: [embed] });
}
