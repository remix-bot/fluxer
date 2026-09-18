/**
 * @module commands/reload
 * @description Owner-only command to hot-reload commands at runtime.
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/ui/index.mjs";
import { pathToFileURL } from "node:url";

/**
 * @type {CommandBuilder}
 * @description Command definition for the reload command (owner-only).
 */
export const command = new CommandBuilder()
    .setName("reload")
    .setDescription("Reload commands. Leave blank to see all targets.")
    .setCategory("util")
    .addStringOption(o =>
        o.setName("target")
            .setDescription("Command name, or: all | commands")
            .setRequired(false)
    )
    .setRequirement(r => r.setOwnerOnly(true));


/**
 * Reload a single command by name, removing the old one and re-importing its file.
 * @private
 * @async
 * @param {object} ctx - The bot (Remix) instance context.
 * @param {object} msg - The command message wrapper.
 * @param {string} name - The command name to reload.
 * @returns {Promise<{ ok: boolean, msg: string }>} Result with success status and message.
 */
async function reloadCommand(ctx, msg, name) {
  if (name === "index")
    return { ok: false, msg: ctx.t(msg, "responses.reload.indexNoReload") };

  const command = ctx.handler.commands.find(c => c.name === name);
  if (!command) return { ok: false, msg: ctx.t(msg, "responses.reload.unknownCommand", { name }) };

  const file = ctx.commandFiles.get(command.uid);
  if (!file)  return { ok: false, msg: ctx.t(msg, "responses.reload.noFileTracked", { name }) };

  const oldRun = ctx.runnables.get(command.uid);

  command.subcommands.forEach(sub => ctx.runnables.delete(sub.uid));
  ctx.handler.removeCommand(command);
  ctx.runnables.delete(command.uid);
  ctx.commandFiles.delete(command.uid);

  const restore = () => {
    ctx.handler.addCommand(command);
    ctx.commandFiles.set(command.uid, file);
    if (oldRun) {
      ctx.runnables.set(command.uid, oldRun);
      command.subcommands.forEach(sub => ctx.runnables.set(sub.uid, oldRun));
    }
  };

  let cData;
  try {
    const url = pathToFileURL(file).href + "?t=" + Date.now();
    cData = await import(url);
  } catch (e) {
    restore();
    return { ok: false, msg: ctx.t(msg, "responses.reload.moduleError", { label: name, error: e.message }) };
  }

  const raw     = cData.command ?? cData.default?.command;
  const builder = typeof raw === "function" ? raw.call(ctx) : raw;
  if (!builder) {
    restore();
    return { ok: false, msg: ctx.t(msg, "responses.reload.noBuilder", { name }) };
  }

  const runFn     = cData.run ?? cData.default?.run;
  const exportDef = cData.exportDef ?? cData.export ?? cData.default?.exportDef ?? cData.default?.export;
  if (exportDef) ctx[exportDef.name] = exportDef.object;

  ctx.handler.addCommand(builder);
  ctx.commandFiles.set(builder.uid, file);
  if (runFn) {
    ctx.runnables.set(builder.uid, runFn);
    builder.subcommands.forEach(sub => ctx.runnables.set(sub.uid, runFn));
  }

  return { ok: true, msg: ctx.t(msg, "responses.reload.reloaded", { name }) };
}

/**
 * Display lines in a paginated embed with arrow navigation.
 * @private
 * @async
 * @param {object} msg - The command message wrapper.
 * @param {string} title - The embed title.
 * @param {string[]} lines - The lines of text to paginate.
 * @param {number} [pageSize=14] - Number of lines per page.
 * @returns {Promise<void>}
 */
async function showPaged(msg, title, lines, pageSize = 14) {
  const pages = [];
  for (let i = 0; i < lines.length; i += pageSize)
    pages.push(lines.slice(i, i + pageSize));

  if (pages.length === 0) pages.push(["*(nothing)*"]);

  const arrows = ["⬅️", "➡️"];
  const curr   = { n: 0 };

  const buildPageEmbed = (n) => ({
    embeds: [
      new EmbedBuilder()
          .setColor(getGlobalColor())
          .setTitle(title)
          .setDescription(pages[n].join("\n") + (pages.length > 1 ? `\n\nPage **${n + 1}** / **${pages.length}**` : ""))

    ]
  });

  const m = await msg.reply(buildPageEmbed(0));
  if (!m || pages.length <= 1) return;

  m.message.react(arrows[0]).catch(() => {});
  m.message.react(arrows[1]).catch(() => {});

  const unsub = m.onReaction(arrows, (e) => {
    if (e.emoji_id === arrows[0]) curr.n = Math.max(0, curr.n - 1);
    else curr.n = Math.min(pages.length - 1, curr.n + 1);
    m.edit(buildPageEmbed(curr.n)).catch(() => {});
  });

  setTimeout(() => { unsub?.(); }, 5 * 60_000);
}

/**
 * Display reload results in a paginated embed.
 * @private
 * @async
 * @param {object} ctx - The bot (Remix) instance context.
 * @param {object} msg - The command message wrapper.
 * @param {object[]} results - Array of { ok, msg } result objects.
 * @param {string} label - Category label for the title.
 * @returns {Promise<void>}
 */
async function showResults(ctx, msg, results, label) {
  const ok  = results.filter(r => r.ok).length;
  const bad = results.filter(r => !r.ok).length;
  const header = ctx.t(msg, "responses.reload.resultsHeader", { ok, bad });
  await showPaged(msg, `🔄 Reload — ${label}`, [header, "", ...results.map(r => r.msg)]);
}

/**
 * Run handler for the reload command.
 * Reloads commands based on the target option.
 *
 * @param {object} msg - The command message wrapper.
 * @param {object} data - Parsed command data containing the target option.
 * @returns {Promise<void>}
 */
export async function run(msg, data) {
  const target = (data.get("target")?.value ?? "").trim().toLowerCase();

  if (!target) {
    const cmdLines = this.handler.commands.map(c => `📦 \`${c.name}\` *(command)*`);

    const lines = [
      this.t(msg, "responses.reload.runHint"),
      this.t(msg, "responses.reload.batchKeywords"),
      "",
      ...cmdLines,
    ];

    return showPaged(msg, this.t(msg, "responses.reload.availableTargetsTitle"), lines);
  }

  if (target === "commands" || target === "all") {
    const results = [];
    for (const c of [...this.handler.commands]) {
      results.push(await reloadCommand(this, msg, c.name));
    }
    return showResults(this, msg, results, target === "all" ? "Everything" : "Commands");
  }

  if (this.handler.commands.some(c => c.name === target)) {
    const res = await reloadCommand(this, msg, target);
    return msg.reply(res.msg);
  }

  return msg.reply(
      this.t(msg, "responses.reload.unknownTarget", { target })
  );
}
