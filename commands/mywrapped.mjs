/**
 * @module commands/mywrapped
 * @description View personal listening recap, personal top songs, favorite artist, and server DJ rank.
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { GuildStats } from "../src/music/GuildStats.mjs";
import { cleanId, Utils } from "../src/utils/Utils.mjs";
import { getGlobalColor, getMessageGuildId } from "../src/ui/index.mjs";

/** @type {CommandBuilder} */
export const command = new CommandBuilder()
  .setName("mywrapped")
  .setDescription("View your personal music listening recap, top tracks, and server DJ rank.", "commands.mywrapped")
  .addAliases("myrecap", "personalwrapped", "mytracks", "me", "djstats")
  .setCategory("music")
  .addTextOption((o) =>
    o
      .setName("target")
      .setDescription("The user whose listening recap you want to view.", "options.mywrapped.user")
      .setRequired(false)
  );

/**
 * Run handler for the mywrapped command.
 * @param {object} message
 * @param {object} [data]
 * @returns {Promise<void>}
 */
export async function run(message, data) {
  const guildId = cleanId(getMessageGuildId(message));
  const prefix = this.handler.getPrefix(guildId) || "%";

  const rawAuthor = message.message?.author ?? message.author;
  const authorId = cleanId(rawAuthor?.id ?? message.authorId ?? message.message?.authorId ?? "");

  const rawArg = (
    data?.get?.("target")?.value ??
    (message.message?.content || message.content || "")
      .trim()
      .split(/\s+/)
      .slice(1)
      .join(" ") ??
    ""
  ).trim();

  let targetId = authorId;
  let targetUser = rawAuthor;

  const mentionMatch = rawArg.match(/<@!?(\d+)>/) || rawArg.match(/\b\d{17,20}\b/);
  if (mentionMatch && mentionMatch[1]) {
    const parsedId = cleanId(mentionMatch[1]);
    if (parsedId && parsedId !== authorId) {
      targetId = parsedId;
      const resolved = this.client?.users?.resolve?.(targetId) ?? message.message?.guild?.members?.resolve?.(targetId)?.user;
      if (resolved) {
        targetUser = resolved;
      } else {
        targetUser = { id: targetId, username: `<@${targetId}>` };
      }
    }
  }

  const isSelf = targetId === authorId;
  const username = targetUser?.username ?? (isSelf ? "You" : `<@${targetId}>`);

  let stats = await GuildStats.getUserStats(guildId, targetId);
  let isGlobalFallback = false;

  if (!stats) {
    stats = await GuildStats.getUserStats("global", targetId);
    if (stats) {
      isGlobalFallback = true;
    }
  } else if (stats.isGlobalFallback) {
    isGlobalFallback = true;
  }

  if (!stats || stats.totalTracks === 0) {
    const noDataText = isSelf
      ? this.t(message, "responses.mywrapped.noDataSelf", { prefix })
      : this.t(message, "responses.mywrapped.noDataOther", { username, prefix });

    const emptyEmbed = new EmbedBuilder()
      .setColor(getGlobalColor())
      .setAuthor({
        name: isSelf
          ? `🎧 ${this.t(message, "responses.mywrapped.authorSelf")}`
          : `🎧 ${this.t(message, "responses.mywrapped.authorOther", { username })}`,
      })
      .setTitle(isSelf
        ? this.t(message, "responses.mywrapped.titleSelf")
        : this.t(message, "responses.mywrapped.titleOther", { username }))
      .setDescription(noDataText)
      .setFooter({ text: this.t(message, "responses.mywrapped.footer", { prefix }) });

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

  const djRankValue = this.t(message, "responses.mywrapped.djRankValue", {
    rank: stats.djRank,
    total: stats.totalDjs,
  });

  const fields = [
    {
      name: `⏱️ ${this.t(message, "responses.mywrapped.totalStreamed")}`,
      value: `**${stats.totalHours}** hours`,
      inline: true,
    },
    {
      name: `🎵 ${this.t(message, "responses.mywrapped.tracksQueued")}`,
      value: `**${stats.totalTracks.toLocaleString()}** tracks`,
      inline: true,
    },
    {
      name: `⏰ ${this.t(message, "responses.mywrapped.peakHour")}`,
      value: `**${stats.peakHour}**`,
      inline: true,
    },
    {
      name: `👑 ${this.t(message, "responses.mywrapped.djRank")}`,
      value: `**${djRankValue}**`,
      inline: true,
    },
  ];

  if (stats.topArtist) {
    fields.push({
      name: `⭐ ${this.t(message, "responses.mywrapped.topArtist")}`,
      value: `**${stats.topArtist.name}** (\`${stats.topArtist.count} ${playsLabel}\`)`,
      inline: true,
    });
  }

  fields.push({
    name: `🏆 ${this.t(message, "responses.mywrapped.topSongs")}`,
    value: topSongsText,
    inline: false,
  });

  let footerText = this.t(message, "responses.mywrapped.footer", { prefix });
  if (isGlobalFallback) {
    footerText = `${this.t(message, "responses.mywrapped.globalNotice")} • ${footerText}`;
  }

  const embed = new EmbedBuilder()
    .setColor(getGlobalColor())
    .setAuthor({
      name: isSelf
        ? `🎧 ${this.t(message, "responses.mywrapped.authorSelf")}`
        : `🎧 ${this.t(message, "responses.mywrapped.authorOther", { username })}`,
    })
    .setTitle(isSelf
      ? this.t(message, "responses.mywrapped.titleSelf")
      : this.t(message, "responses.mywrapped.titleOther", { username }))
    .addFields(...fields)
    .setFooter({ text: footerText });

  const avatarUrl = typeof targetUser?.avatarURL === "function"
    ? targetUser.avatarURL()
    : (targetUser?.avatar ? `https://cdn.discordapp.com/avatars/${targetId}/${targetUser.avatar}.png` : null);

  if (avatarUrl) {
    embed.setThumbnail(avatarUrl);
  }

  return message.reply({ embeds: [embed] });
}
