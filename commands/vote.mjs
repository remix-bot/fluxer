/**
 * @file vote.mjs — Skip-vote system — start a vote to skip the current track
 * @module commands.vote
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";
import { Utils } from "../src/Utils.mjs";
import { FLUXERLIST, buildVoteLink } from "../src/constants/API.mjs";
import { ERROR_COLOR, EMOJI_REMOVE_TIMEOUT } from "../src/constants/UI.mjs";


export const command = new CommandBuilder()
  .setName("vote")
  .setDescription("View voting info or check voters for your server/bot on FluxerList", "commands.vote")
  .setCategory("util")
  .addAliases("voters")
  .addChoiceOption(o =>
    o.setName("action")
      .setDescription("The action to perform: info, check, voters", "options.vote.action")
      .addChoices("info", "check", "voters")
      .setRequired(false)
  )
  .addChoiceOption(o =>
    o.setName("type")
      .setDescription("Resource type: server or bot", "options.vote.type")
      .addChoices("server", "bot")
      .setRequired(false)
  )
  .addStringOption(o =>
    o.setName("id")
      .setDescription("The server or bot ID or slug (uses config default if not provided)")
      .setRequired(false)
  )
  .addNumberOption(o =>
    o.setName("page")
      .setDescription("Page number for voter list pagination")
      .setRequired(false)
  );

function notConfigured(prefix, t, guildId) {
  return {
    embeds: [new EmbedBuilder()
      .setColor(ERROR_COLOR)
      .setDescription(t(guildId, "responses.vote.notConfigured"))]
  };
}

function noResourceId(type, prefix, t, guildId) {
  return {
    embeds: [new EmbedBuilder()
      .setColor(ERROR_COLOR)
      .setDescription(t(guildId, "responses.vote.noResourceId", { type, prefix }))]
  };
}

/**
 * Build a paginated voter list embed.
 * @param {Array<{ username: string, fluxerId: number, votedAt: string }>} voters
 * @param {number} total
 * @param {number} page
 * @param {number} limit
 * @param {"server"|"bot"} type
 * @param {string} resourceId
 * @param {boolean} expired - Whether the navigation controls have expired
 * @returns {object} Embed payload
 */
function buildVotersEmbed(voters, total, page, limit, type, resourceId, expired = false, t, guildId) {
  const totalPages = Math.max(1, Math.ceil(total / limit));

  const lines = voters.map((v, i) => {
    const rank = (page - 1) * limit + i + 1;
    const num = String(rank).padStart(2, " ");
    const username = v.username || t(guildId, "responses.vote.unknownUser", { id: v.fluxerId });
    const dateStr = v.votedAt
      ? new Date(v.votedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
      : t(guildId, "responses.vote.unknownDate");
    return `\`${num}.\` **${username}** — ${t(guildId, "responses.vote.votedDate", { date: dateStr })}`;
  });

  const desc = lines.length > 0
    ? lines.join("\n").slice(0, 4096)
    : t(guildId, "responses.vote.noVotersOnPage");

  const title = type === "server" ? t(guildId, "responses.vote.serverVoters") : t(guildId, "responses.vote.botVoters");
  const footerText = expired
    ? t(guildId, "responses.vote.controlsExpired")
    : totalPages > 1
      ? t(guildId, "responses.vote.pageInfo", { page, totalPages, total: Utils.formatNumber(total) })
      : t(guildId, "responses.vote.voterTotal", { total: Utils.formatNumber(total) });

  const embed = new EmbedBuilder()
    .setColor(getGlobalColor())
    .setTitle(`${title}`)
    .setDescription(desc)
    .setFooter({ text: footerText });

  return { embeds: [embed] };
}

/**
 * Execute the vote command.
 * @param {import("../src/MessageHandler.mjs").Message} msg - The incoming message
 * @param {Map<string, {value: *}>>} data - Slash-command options map
 * @returns {Promise<void>}
 */
export async function run(msg, data) {
  const fluxerlist = this.fluxerlist;
  const prefix = this.handler.getPrefix(msg.message?.guildId);
  const action = data.get("action")?.value ?? "info";
  const type = data.get("type")?.value ?? "bot";
  const resourceId = data.get("id")?.value || null;
  const page = data.get("page")?.value ?? 1;
  const t = this.locale?.translate?.bind(this.locale);
  const guildId = msg.message?.guildId;

  switch (action) {
    case "info": {
      const resolvedType = type || "bot";
      const id = resourceId || (resolvedType === "server" ? fluxerlist?.serverId : fluxerlist?.botId);

      if (!id) {
        return msg.reply({
          embeds: [new EmbedBuilder()
            .setColor(getGlobalColor())
            .setTitle(this.t(msg, "responses.vote.infoTitle"))
            .setDescription(this.t(msg, "responses.vote.infoDescription", { siteUrl: FLUXERLIST.SITE_URL, prefix }))]
        });
      }

      const slug = resourceId || (resolvedType === "server" ? fluxerlist?.serverSlug : fluxerlist?.botSlug);
      const voteUrl = slug ? buildVoteLink(resolvedType, slug) : null;

      const descLines = [
        this.t(msg, "responses.vote.supportDesc", { type: resolvedType }),
        ``,
      ];

      if (voteUrl) {
        descLines.push(this.t(msg, "responses.vote.voteLink", { url: voteUrl }), ``);
      } else {
        descLines.push(this.t(msg, "responses.vote.findLink", { siteUrl: FLUXERLIST.SITE_URL, type: resolvedType }), ``);
      }

      descLines.push(this.t(msg, "responses.vote.helpGrow", { type: resolvedType }));

      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle(this.t(msg, "responses.vote.voteTitle"))
        .setDescription(descLines.join("\n"));

      return msg.reply({ embeds: [embed] });
    }

    case "check":
    case "voters": {
      if (!fluxerlist || !fluxerlist.enabled) return msg.reply(notConfigured(prefix, t, guildId));

      const resolvedType = type || "bot";
      const id = resourceId || (resolvedType === "server" ? fluxerlist.serverId : fluxerlist.botId);

      if (!id) return msg.reply(noResourceId(resolvedType, prefix, t, guildId));

      let voterData;
      try {
        voterData = await fluxerlist.getVoters(resolvedType, id, { page, limit: 20 });
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder()
            .setColor(ERROR_COLOR)
            .setDescription(this.t(msg, "responses.vote.fetchVotersFailed", { error: err.message }))]
        });
      }

      if (voterData.total === 0) {
        return msg.reply({
          embeds: [new EmbedBuilder()
            .setColor(getGlobalColor())
            .setDescription(this.t(msg, "responses.vote.noVotersYet", { type: resolvedType }))]
        });
      }

      const totalPages = Math.max(1, Math.ceil(voterData.total / 20));

      if (totalPages <= 1) {
        const embed = buildVotersEmbed(voterData.voters, voterData.total, voterData.page, 20, resolvedType, id, false, t, guildId);
        return msg.reply(embed);
      }

      let currentPage = voterData.page;

      const buildPage = (pageIdx, data, expired = false) => {
        return buildVotersEmbed(data.voters, data.total, pageIdx, 20, resolvedType, id, expired, t, guildId);
      };

      const replyMsg = await msg.reply(buildPage(currentPage, voterData));
      if (!replyMsg?.message) return;

      const navEmojis = ["\u25C0\uFE0F", "\u25B6\uFE0F", "\u274C"];
      for (const emoji of navEmojis) {
        await replyMsg.message.react(emoji).catch(() => {});
      }

      const clearReactions = async () => {
        try {
          await replyMsg.message.removeAllReactions();
        } catch {
          for (const emoji of navEmojis) {
            try { await replyMsg.message.removeReaction(emoji); } catch(e) {  }
          }
        }
      };

      let emojiTimeout = null;
      const resetTimer = () => {
        clearTimeout(emojiTimeout);
        emojiTimeout = setTimeout(async () => {
          unobserve?.();
          await clearReactions();
          await replyMsg.edit(buildPage(currentPage, voterData, true)).catch(() => {});
        }, EMOJI_REMOVE_TIMEOUT);
      };

      const unobserve = replyMsg.onReaction(navEmojis, async (e) => {
        if (e.emoji_id === "\u274C") {
          clearTimeout(emojiTimeout);
          unobserve?.();
          await replyMsg.message.delete().catch(() => {});
          return;
        }

        resetTimer();

        if (e.emoji_id === "\u25C0\uFE0F") {
          currentPage = currentPage > 1 ? currentPage - 1 : totalPages;
        } else if (e.emoji_id === "\u25B6\uFE0F") {
          currentPage = currentPage < totalPages ? currentPage + 1 : 1;
        }

        try {
          voterData = await fluxerlist.getVoters(resolvedType, id, { page: currentPage, limit: 20 });
        } catch {
          
        }

        await replyMsg.edit(buildPage(currentPage, voterData)).catch(() => {});
      });

      resetTimer();
      break;
    }

    default:
      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(getGlobalColor())
          .setDescription([
            this.t(msg, "responses.vote.defaultCommandsTitle"),
            ``,
            this.t(msg, "responses.vote.defaultCommandsList", { prefix }),
            ``,
            this.t(msg, "responses.vote.optionsTitle"),
            this.t(msg, "responses.vote.optionsList", { prefix }),
          ].join("\n"))]
      });
  }
}
