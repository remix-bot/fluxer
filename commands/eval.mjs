import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";
import { inspect } from "node:util";

const EMOJI_REMOVE_TIMEOUT = 60000;

/**
 * Matches any key that *contains* one of these strings (case-insensitive).
 */
const RESTRICTED = [
  "token",
  "config",
  "key",
  "clientsecret",
  "clientid",
  "password",
  "secret",
  "authorization",
  "mysql",
  "nodelink",
  "_nl",
  "credential",
  "apikey",
  "webhook",
];

const SCAN_DEPTH = 6;

function hasSensitive(obj, level = 0, visited = new WeakSet()) {
  if (level >= SCAN_DEPTH || typeof obj !== "object" || obj === null) return false;
  if (visited.has(obj)) return false;
  visited.add(obj);
  for (const key in obj) {
    if (RESTRICTED.some(r => key.toLowerCase().includes(r))) return true;
    if (typeof obj[key] === "object" && hasSensitive(obj[key], level + 1, visited)) return true;
  }
  return false;
}

function removeSensitive(obj, level = 0, visited = new WeakSet()) {
  if (level >= SCAN_DEPTH || typeof obj !== "object" || obj === null) return obj;
  if (visited.has(obj)) return "[Circular]";
  visited.add(obj);

  const isArray = Array.isArray(obj);
  const newObj = isArray ? [...obj] : { ...obj };
  let modified = false;

  for (const key in newObj) {
    const isSensitive = !isArray && RESTRICTED.some(r => key.toLowerCase().includes(r));

    if (isSensitive) {
      newObj[key] = "[REDACTED]";
      modified = true;
    } else if (typeof newObj[key] === "object" && newObj[key] !== null) {
      const cleaned = removeSensitive(newObj[key], level + 1, visited);
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
    output = typeof value === "string" ? value : inspect(value, { depth: 4, compact: false, maxArrayLength: 50, maxStringLength: 500, breakLength: 80 });
  } catch (err) {
    output = `[Inspection Error]: ${err.message}`;
  }

  return output
      .replace(/`/g, "`\u200b")
      .replace(/@/g, "@\u200b") || "undefined";
}

function isSingleExpression(code) {
  const trimmed = code.trim();

  if (!trimmed) return false;

  if (/^(if|for|while|do|switch|try|catch|finally|with)\s*[\({]/.test(trimmed)) return false;

  if (/^\s*(const|let|var|function\s|class\s)/.test(trimmed)) return false;

  const stripped = trimmed
      .replace(/'(?:[^'\\]|\\.)*'/g, '""')
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '""');
  if (stripped.includes(";")) return false;

  const withoutChains = trimmed.replace(/\.\s*\n/g, ".");
  if (withoutChains.includes("\n")) return false;

  return true;
}

/**
 * Executes the code and returns the raw data instead of a formatted string,
 * so we can paginate it inside Embeds later.
 */
async function runEval(expression, context) {
  const start = Date.now();
  let result, isError = false, type = "undefined";

  try {
    const code = isSingleExpression(expression)
        ? `return (${expression});`
        : expression;

    result = await eval(`(async function() { ${code} })`).call(context);
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

  const context = Object.assign({
    message: msg?.message,
    msg,
    guilds:   this.client?.guilds,
    channels: this.client?.channels,
    users:    this.client?.users,
    players:  this.players,
    settings: this.settingsMgr,
  }, this);

  const { output, isError, type, elapsed } = await runEval(expression, context);

  const chunkSize = 3800;
  const chunks = [];
  for (let i = 0; i < output.length; i += chunkSize) {
    chunks.push(output.slice(i, i + chunkSize));
  }

  const totalPages = chunks.length;
  let currentPage = 0;

  const buildPageContent = (pageIdx, expired = false) => {
    const title = isError
        ? this.t(msg, "responses.eval.resultTitleError")
        : this.t(msg, "responses.eval.resultTitleSuccess");

    const typeLabel = this.t(msg, "responses.eval.typeLabel");
    const timeLabel = this.t(msg, "responses.eval.timeLabel");
    const desc = `**${typeLabel}** \`${type}\` • **${timeLabel}** \`${elapsed}ms\`\n\`\`\`js\n${chunks[pageIdx]}\n\`\`\``.slice(0, 4096);

    let footerText = this.t(msg, "responses.eval.pageLabel", { page: pageIdx + 1, total: totalPages });
    if (expired) footerText = this.t(msg, "responses.eval.controlsExpired");
    else if (totalPages > 1) footerText += " " + this.t(msg, "responses.eval.navigateHint");
    else footerText += " " + this.t(msg, "responses.eval.deleteHint");

    const embed = new EmbedBuilder()
        .setColor(isError ? "#ff0000" : getGlobalColor())
        .setTitle(title)
        .setDescription(desc)
        .setFooter({ text: footerText })
    ;

    return { embeds: [embed] };
  };

  const replyMsg = await msg.reply(buildPageContent(0));
  if (!replyMsg?.message) return;

  const navEmojis = totalPages > 1 ? ["⬅️", "➡️", "❌"] : ["❌"];
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
        } catch (_) {}
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
    if (e.emoji_id === "❌") {
      clearTimeout(emojiTimeout);
      if (unobserve) unobserve();
      await replyMsg.message.delete().catch(() => {});
      return;
    }

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