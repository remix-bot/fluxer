import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";
import { Utils } from "../src/Utils.mjs";
import { FLUXERLIST, buildVoteLink } from "../src/constants/API.mjs";

// Auto-remove timer for reaction navigation: 60 seconds
const EMOJI_REMOVE_TIMEOUT = 60_000;

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

// ── Helpers ────────────────────────────────────────────────────────────────────

function notConfigured(prefix) {
  return {
    embeds: [new EmbedBuilder()
      .setColor("#ff0000")
      .setDescription(`FluxerList integration is not configured on this bot. Ask the bot owner to add a FluxerList API key to the config.`)]
  };
}

function noResourceId(type, prefix) {
  return {
    embeds: [new EmbedBuilder()
      .setColor("#ff0000")
      .setDescription(`No ${type} ID configured. Provide it with \`${prefix}vote check ${type} <id-or-slug>\` or set it in config.json.`)]
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
function buildVotersEmbed(voters, total, page, limit, type, resourceId, expired = false) {
  const totalPages = Math.max(1, Math.ceil(total / limit));

  const lines = voters.map((v, i) => {
    const rank = (page - 1) * limit + i + 1;
    const num = String(rank).padStart(2, " ");
    const username = v.username || `User#${v.fluxerId}`;
    const dateStr = v.votedAt
      ? new Date(v.votedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
      : "Unknown";
    return `\`${num}.\` **${username}** — voted ${dateStr}`;
  });

  const desc = lines.length > 0
    ? lines.join("\n").slice(0, 4096)
    : "No voters found on this page.";

  const title = type === "server" ? "Server Voters" : "Bot Voters";
  const footerText = expired
    ? "Controls expired"
    : totalPages > 1
      ? `Page ${page}/${totalPages} of ${Utils.formatNumber(total)} voters \u2022 Use \u25C0\u25B6 to navigate`
      : `${Utils.formatNumber(total)} voter${total !== 1 ? "s" : ""} total`;

  const embed = new EmbedBuilder()
    .setColor(getGlobalColor())
    .setTitle(`${title}`)
    .setDescription(desc)
    .setFooter({ text: footerText });

  return { embeds: [embed] };
}

// ── Run ────────────────────────────────────────────────────────────────────────

export async function run(msg, data) {
  const fluxerlist = this.fluxerlist;
  const prefix = this.handler?.getPrefix?.(msg.message?.guildId) ?? "%";
  const action = data.get("action")?.value ?? "info";
  const type = data.get("type")?.value ?? "bot";
  const resourceId = data.get("id")?.value || null;
  const page = data.get("page")?.value ?? 1;

  switch (action) {
    // ── Info — Show vote link & FluxerList info ────────────────────────────────
    case "info": {
      const resolvedType = type || "bot";
      const id = resourceId || (resolvedType === "server" ? fluxerlist?.serverId : fluxerlist?.botId);

      if (!id) {
        return msg.reply({
          embeds: [new EmbedBuilder()
            .setColor(getGlobalColor())
            .setTitle("FluxerList Vote")
            .setDescription([
              `Vote for this bot/server on [FluxerList](${FLUXERLIST.SITE_URL})!`,
              ``,
              `FluxerList is a server and bot listing platform where users can vote to help grow the community.`,
              ``,
              `**Commands:**`,
              `\`${prefix}vote info\` \u2014 Show this info & vote link`,
              `\`${prefix}vote info server\` \u2014 Show vote link for a server`,
              `\`${prefix}vote check\` \u2014 Check who voted (owner-only)`,
              `\`${prefix}vote voters\` \u2014 View the voter list (owner-only)`,
            ].join("\n"))]
        });
      }

      // Use slug for website links (slugs work on the website; numeric IDs don't)
      const slug = resourceId || (resolvedType === "server" ? fluxerlist?.serverSlug : fluxerlist?.botSlug);
      const voteUrl = slug ? buildVoteLink(resolvedType, slug) : null;
      const label = resolvedType === "server" ? "Server" : "Bot";

      const descLines = [
        `Support this ${label.toLowerCase()} by voting on FluxerList!`,
        ``,
      ];

      if (voteUrl) {
        descLines.push(`**[Vote & View Profile](${voteUrl})**`, ``);
      } else {
        descLines.push(`Visit [FluxerList](${FLUXERLIST.SITE_URL}) to find and vote for this ${label.toLowerCase()}.`, ``);
      }

      descLines.push(`Your votes help this ${label.toLowerCase()} grow and reach more users.`);

      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle(`Vote on FluxerList`)
        .setDescription(descLines.join("\n"));

      return msg.reply({ embeds: [embed] });
    }

    // ── Check / Voters — Show voter list ───────────────────────────────────────
    case "check":
    case "voters": {
      if (!fluxerlist || !fluxerlist.enabled) return msg.reply(notConfigured(prefix));

      const resolvedType = type || "bot";
      const id = resourceId || (resolvedType === "server" ? fluxerlist.serverId : fluxerlist.botId);

      if (!id) return msg.reply(noResourceId(resolvedType, prefix));

      // Fetch the first page
      let voterData;
      try {
        voterData = await fluxerlist.getVoters(resolvedType, id, { page, limit: 20 });
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder()
            .setColor("#ff0000")
            .setDescription(`Failed to fetch voters: ${err.message}`)]
        });
      }

      // No voters at all
      if (voterData.total === 0) {
        return msg.reply({
          embeds: [new EmbedBuilder()
            .setColor(getGlobalColor())
            .setDescription(`No one has voted for this ${resolvedType} yet. Share the vote link to get started!`)]
        });
      }

      const totalPages = Math.max(1, Math.ceil(voterData.total / 20));

      // Single page — no navigation needed
      if (totalPages <= 1) {
        const embed = buildVotersEmbed(voterData.voters, voterData.total, voterData.page, 20, resolvedType, id);
        return msg.reply(embed);
      }

      // Multi-page — add emoji navigation
      let currentPage = voterData.page;

      const buildPage = (pageIdx, expired = false) => {
        return buildVotersEmbed(voterData.voters, voterData.total, pageIdx, 20, resolvedType, id, expired);
      };

      const replyMsg = await msg.reply(buildPage(currentPage));
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
            try { await replyMsg.message.removeReaction(emoji); } catch {}
          }
        }
      };

      let emojiTimeout;
      const resetTimer = () => {
        clearTimeout(emojiTimeout);
        emojiTimeout = setTimeout(async () => {
          unobserve?.();
          await clearReactions();
          await replyMsg.edit(buildPage(currentPage, true)).catch(() => {});
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

        // Fetch the new page data
        try {
          voterData = await fluxerlist.getVoters(resolvedType, id, { page: currentPage, limit: 20 });
        } catch {
          /* keep previous data */
        }

        await replyMsg.edit(buildPage(currentPage)).catch(() => {});
      });

      resetTimer();
      break;
    }

    default:
      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(getGlobalColor())
          .setDescription([
            `**FluxerList Vote Commands:**`,
            ``,
            `\`${prefix}vote\` \u2014 Show vote info & link`,
            `\`${prefix}vote info\` \u2014 Show voting info & vote link`,
            `\`${prefix}vote check\` \u2014 Check who voted (owner-only)`,
            `\`${prefix}vote voters\` \u2014 View the voter list (owner-only)`,
            ``,
            `**Options:**`,
            `\`${prefix}vote check server\` \u2014 Check voters for a server`,
            `\`${prefix}vote check bot\` \u2014 Check voters for a bot`,
          ].join("\n"))]
      });
  }
}
