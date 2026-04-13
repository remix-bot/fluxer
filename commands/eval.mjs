import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";
import { inspect } from "node:util";

// Auto-remove timer: 1 minute
const EMOJI_REMOVE_TIMEOUT = 60000;

/**
 * List of keys that should be redacted from objects before displaying in Discord.
 */
const RESTRICTED = [
  "token",
  "config",
  "key",
  "clientSecret",
  "clientId",
  "password",
  "secret",
  "authorization"
];

function hasSensitive(obj, level = 0) {
  if (level >= 3 || typeof obj !== "object" || obj === null) return false;
  for (const key in obj) {
    if (RESTRICTED.some(r => key.toLowerCase().includes(r))) return true;
    if (typeof obj[key] === "object" && hasSensitive(obj[key], level + 1)) return true;
  }
  return false;
}

function removeSensitive(obj, level = 0) {
  if (level >= 3 || typeof obj !== "object" || obj === null) return obj;

  const isArray = Array.isArray(obj);
  const newObj = isArray ? [...obj] : { ...obj };
  let modified = false;

  for (const key in newObj) {
    const isSensitive = !isArray && RESTRICTED.some(r => key.toLowerCase().includes(r));

    if (isSensitive) {
      newObj[key] = "[REDACTED]";
      modified = true;
    } else if (typeof newObj[key] === "object" && newObj[key] !== null) {
      const cleaned = removeSensitive(newObj[key], level + 1);
      if (cleaned !== newObj[key]) {
        newObj[key] = cleaned;
        modified = true;
      }
    }
  }
  return modified ? newObj : obj;
}

async function clean(value) {
  if (value instanceof Promise) value = await value;

  if (typeof value === "object" && value !== null) {
    if (hasSensitive(value)) {
      value = removeSensitive(value);
    }
  }

  let output;
  try {
    output = typeof value === "string" ? value : inspect(value, { depth: 1, compact: false });
  } catch (err) {
    output = `[Inspection Error]: ${err.message}`;
  }

  return output
      .replace(/`/g, "`\u200b")
      .replace(/@/g, "@\u200b") || "undefined"; // Fallback if output is empty
}

/**
 * Executes the code and returns the raw data instead of a formatted string,
 * so we can paginate it inside Embeds later.
 */
async function runEval(expression, context) {
  const start = Date.now();
  let result, isError = false, type = "undefined";

  try {
    result = await eval(`(async function() { ${expression} })`).call(context);
    type = result === null ? "null" : typeof result;
  } catch (e) {
    result = e;
    isError = true;
    type = "error";
  }

  const elapsed = Date.now() - start;
  const output = await clean(result);

  return { output, isError, type, elapsed };
}

export const command = new CommandBuilder()
    .setName("eval")
    .setDescription("Evaluates JavaScript code (Owner Only).")
    .setRequirement(r => r.setOwnerOnly(true))
    .setCategory("util")
    .addTextOption(o =>
        o.setName("expression")
            .setDescription("The JavaScript expression to evaluate")
            .setRequired(true)
    );

export async function run(msg, data) {
  const expression = data.get("expression").value;
  const context = Object.assign({ message: msg }, this);

  // 1. Run the evaluation
  const { output, isError, type, elapsed } = await runEval(expression, context);

  // 2. Chunk the output to bypass Discord limits (Max embed description is 4096 chars)
  // We use 3800 to leave room for the header and markdown formatting
  const chunkSize = 3800;
  const chunks = [];
  for (let i = 0; i < output.length; i += chunkSize) {
    chunks.push(output.slice(i, i + chunkSize));
  }

  const totalPages = chunks.length;
  let currentPage = 0;

  // Helper to build the specific embed page
  const buildPageContent = (pageIdx, expired = false) => {
    const icon = isError ? "❌" : "✅";
    const title = `${icon} Eval Result`;

    // Embed description includes the metadata and the codeblock
    const desc = `**Type:** \`${type}\` • **Time:** \`${elapsed}ms\`\n\`\`\`js\n${chunks[pageIdx]}\n\`\`\``;

    // Customize footer based on state
    let footerText = `Page ${pageIdx + 1}/${totalPages}`;
    if (expired) footerText = "⌛ Controls expired";
    else if (totalPages > 1) footerText += " • ⬅️ ➡️ Navigate • ❌ Delete";
    else footerText += " • ❌ Delete";

    const embed = new EmbedBuilder()
        .setColor(isError ? "#ff0000" : getGlobalColor()) // Red if error, default otherwise
        .setTitle(title)
        .setDescription(desc)
        .setFooter({ text: footerText })
        .toJSON();

    return { embeds: [embed] };
  };

  // 3. Send the initial message using the wrapper
  const replyMsg = await msg.replyEmbed(buildPageContent(0));
  if (!replyMsg?.message) return;

  // 4. Setup React UI
  // If it's only 1 page, we just show the Delete button. Otherwise, add arrows.
  const navEmojis = totalPages > 1 ? ["⬅️", "➡️", "❌"] : ["❌"];
  let unobserve = null;
  let emojiTimeout = null;

  for (const emoji of navEmojis) {
    await replyMsg.message.react(emoji).catch(() => {});
  }

  // Helper: Clear reactions when time runs out
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

  // Helper: Reset inactivity timer
  const resetTimer = () => {
    clearTimeout(emojiTimeout);
    emojiTimeout = setTimeout(async () => {
      if (unobserve) unobserve();
      await clearReactions();
      await replyMsg.editEmbed(buildPageContent(currentPage, true)).catch(() => {});
    }, EMOJI_REMOVE_TIMEOUT);
  };

  // 5. Start listening for reactions
  unobserve = replyMsg.onReaction(navEmojis, async (e) => {
    // Handle specific actions
    if (e.emoji_id === "❌") {
      // Clean up and delete the message
      clearTimeout(emojiTimeout);
      if (unobserve) unobserve();
      await replyMsg.message.delete().catch(() => {});
      return; // Exit completely
    }

    resetTimer();

    if (e.emoji_id === "⬅️") {
      currentPage = currentPage > 0 ? currentPage - 1 : totalPages - 1;
    } else if (e.emoji_id === "➡️") {
      currentPage = currentPage < totalPages - 1 ? currentPage + 1 : 0;
    }

    // Update Embed
    await replyMsg.editEmbed(buildPageContent(currentPage)).catch(() => {});
  });

  resetTimer();
}