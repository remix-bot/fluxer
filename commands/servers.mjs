/**
 * @file servers.mjs — List servers the bot is currently in (owner-only)
 * @module commands.servers
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";
import { EMOJI_REMOVE_TIMEOUT } from "../src/constants/UI.mjs";

export const command = new CommandBuilder()
    .setName("servers")
    .setDescription("Fetch a list of servers the bot is in")
    .setRequirement(r => r.setOwnerOnly(true))
    .setCategory("util");


/**
 * Execute the servers command.
 * @param {import("../src/MessageHandler.mjs").Message} msg - The incoming message
 * @returns {Promise<void>}
 */
export async function run(msg) {
  const guilds = [...this.client.guilds.values()];

  if (guilds.length === 0) {
    const emptyEmbed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle(this.t(msg, "responses.servers.title", { count: 0 }))
        .setDescription(this.t(msg, "responses.servers.noServers"))
        ;
    return msg.reply({ embeds: [emptyEmbed] });
  }

  const MAX_DESC = 4096;
  const pages = [];

  let currentLines = [];
  let currentLen   = 0;

  for (let i = 0; i < guilds.length; i++) {
    const g = guilds[i];
    let name = g.name || "unknown";
    if (name.length > 40) name = name.slice(0, 37) + "...";
    const line = `${i + 1}. **${name}** (\`${g.id}\`)`;
    const addedLen = line.length + (currentLines.length ? 1 : 0);

    if (currentLen + addedLen > MAX_DESC - 20 && currentLines.length > 0) {
      pages.push(currentLines.join("\n"));
      currentLines = [];
      currentLen   = 0;
    }
    currentLines.push(line);
    currentLen += addedLen;
  }
  if (currentLines.length) pages.push(currentLines.join("\n"));

  const totalPages = pages.length;

  let currentPage = 0;

  const buildPageContent = (pageIdx, expired = false) => {
    const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle(this.t(msg, "responses.servers.pageTitle", { count: guilds.length, page: pageIdx + 1, total: totalPages }))
        .setDescription(pages[pageIdx])
        .setFooter({
          text: expired
              ? this.t(msg, "responses._common.controlsExpired")
              : totalPages > 1
                  ? this.t(msg, "responses._common.navigateHint")
                  : this.t(msg, "responses.servers.listComplete")
        })
        ;

    return { embeds: [embed] };
  };

  const replyMsg = await msg.reply(buildPageContent(0));

  if (!replyMsg?.message) return;
  if (totalPages <= 1) return;

  const navEmojis = ["⬅️", "➡️"];
  let unobserve = null;
  let emojiTimeout = null;

  for (const emoji of navEmojis) {
    await replyMsg.message.react(emoji).catch(() => {});
  }

  const clearReactions = async () => {
    try {
      await replyMsg.message.removeAllReactions();
    } catch (e) {
      for (const emoji of navEmojis) {
        try {
          await replyMsg.message.removeReaction(emoji);
        } catch(e) {  }
      }
    }
  };

  const resetTimer = () => {
    clearTimeout(emojiTimeout);
    emojiTimeout = setTimeout(async () => {
      if (unobserve) unobserve();
      await clearReactions();
      await replyMsg.edit(buildPageContent(currentPage, true)).catch(() => {});
    }, EMOJI_REMOVE_TIMEOUT);
  };

  unobserve = replyMsg.onReaction(navEmojis, async (e) => {
    resetTimer();

    if (e.emoji_id === "⬅️") {
      currentPage = currentPage > 0 ? currentPage - 1 : totalPages - 1;
    } else if (e.emoji_id === "➡️") {
      currentPage = currentPage < totalPages - 1 ? currentPage + 1 : 0;
    }

    await replyMsg.edit(buildPageContent(currentPage)).catch(() => {});
  });

  resetTimer();
}
