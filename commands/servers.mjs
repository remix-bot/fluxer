import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

export const command = new CommandBuilder()
    .setName("servers")
    .setDescription("Fetch a list of servers the bot is in")
    .setRequirement(r => r.setOwnerOnly(true))
    .setCategory("util");

// Auto-remove timer: 1 minute
const EMOJI_REMOVE_TIMEOUT = 60000;

export async function run(msg) {
  const guilds = [...this.client.guilds.values()];

  // Fallback if the bot is in 0 servers
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

  // Build pages dynamically — each page accumulates lines until it would
  // exceed the 4096-char description limit, then starts a new page.
  let currentLines = [];
  let currentLen   = 0;

  for (let i = 0; i < guilds.length; i++) {
    const g = guilds[i];
    let name = g.name || "unknown";
    if (name.length > 40) name = name.slice(0, 37) + "...";
    const line = `${i + 1}. **${name}** (\`${g.id}\`)`;
    const addedLen = line.length + (currentLines.length ? 1 : 0); // +1 for \n

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

  // Helper function to generate the embed for a specific page
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

  // Send the initial message using the framework's wrapper
  const replyMsg = await msg.reply(buildPageContent(0));

  // Safety check and single-page exit
  if (!replyMsg?.message) return;
  if (totalPages <= 1) return;

  const navEmojis = ["⬅️", "➡️"];
  let unobserve = null;
  let emojiTimeout = null;

  // Add reactions
  for (const emoji of navEmojis) {
    await replyMsg.message.react(emoji).catch(() => {});
  }

  // Helper: Clear all reactions (matches player.mjs fallback logic)
  const clearReactions = async () => {
    try {
      await replyMsg.message.removeAllReactions();
    } catch (e) {
      for (const emoji of navEmojis) {
        try {
          await replyMsg.message.removeReaction(emoji);
        } catch (_) {}
      }
    }
  };

  // Helper: Reset the expiration timer
  const resetTimer = () => {
    clearTimeout(emojiTimeout);
    emojiTimeout = setTimeout(async () => {
      if (unobserve) unobserve();
      await clearReactions();
      await replyMsg.edit(buildPageContent(currentPage, true)).catch(() => {});
    }, EMOJI_REMOVE_TIMEOUT);
  };

  // Start listening for reactions using the framework's native listener
  unobserve = replyMsg.onReaction(navEmojis, async (e) => {
    resetTimer(); // Reset the 1-minute timer when interacting

    if (e.emoji_id === "⬅️") {
      // Go backward (loops to the end if on the first page)
      currentPage = currentPage > 0 ? currentPage - 1 : totalPages - 1;
    } else if (e.emoji_id === "➡️") {
      // Go forward (loops to the beginning if on the last page)
      currentPage = currentPage < totalPages - 1 ? currentPage + 1 : 0;
    }

    // Update the embed using the framework's native edit method
    await replyMsg.edit(buildPageContent(currentPage)).catch(() => {});
  });

  // Start the initial countdown
  resetTimer();
}