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
  const guilds = [...this.client.guilds.cache.values()];

  // Fallback if the bot is in 0 servers
  if (guilds.length === 0) {
    const emptyEmbed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle("🌐 Servers (0)")
        .setDescription("_No servers found._")
        .toJSON();
    return msg.replyEmbed({ embeds: [emptyEmbed] });
  }

  const itemsPerPage = 50;
  const totalPages = Math.ceil(guilds.length / itemsPerPage);
  const pages = [];

  // Build the content for each page
  for (let i = 0; i < guilds.length; i += itemsPerPage) {
    const chunk = guilds.slice(i, i + itemsPerPage);
    const list = chunk.map((g, index) => `${i + index + 1}. **${g.name}** (\`${g.id}\`)`).join("\n");
    pages.push(list);
  }

  let currentPage = 0;

  // Helper function to generate the embed for a specific page
  const buildPageContent = (pageIdx, expired = false) => {
    const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle(`🌐 Servers (${guilds.length}) - Page ${pageIdx + 1}/${totalPages}`)
        .setDescription(pages[pageIdx])
        .setFooter({
          text: expired
              ? "⌛ Controls expired"
              : totalPages > 1
                  ? "💡 ⬅️ ➡️ Navigate"
                  : "List complete"
        })
        .toJSON();

    return { embeds: [embed] };
  };

  // Send the initial message using the framework's wrapper
  const replyMsg = await msg.replyEmbed(buildPageContent(0));

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
      await replyMsg.editEmbed(buildPageContent(currentPage, true)).catch(() => {});
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
    await replyMsg.editEmbed(buildPageContent(currentPage)).catch(() => {});
  });

  // Start the initial countdown
  resetTimer();
}