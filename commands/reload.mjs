/**
 * @module commands/reload
 * @description Owner-only command to hot-reload commands, source modules, or audio modules at runtime.
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * @type {CommandBuilder}
 * @description Command definition for the reload command (owner-only).
 */
export const command = new CommandBuilder()
    .setName("reload")
    .setDescription("Reload commands, src modules, or audio modules. Leave blank to see all targets.")
    .setCategory("util")
    .addStringOption(o =>
        o.setName("target")
            .setDescription("Command/module name, or: all | commands | src | audio")
            .setRequired(false)
    )
    .setRequirement(r => r.setOwnerOnly(true));


const __dirname = path.dirname(new URL(import.meta.url).pathname);
const ROOT      = path.resolve(__dirname, "..");

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

  command.subcommands.forEach(sub => ctx.runnables.delete(sub.uid));
  ctx.handler.removeCommand(command);
  ctx.runnables.delete(command.uid);
  ctx.commandFiles.delete(command.uid);

  const url   = pathToFileURL(file).href + "?t=" + Date.now();
  const cData = await import(url);

  const raw     = cData.command ?? cData.default?.command;
  const builder = typeof raw === "function" ? raw.call(ctx) : raw;
  if (!builder) return { ok: false, msg: ctx.t(msg, "responses.reload.noBuilder", { name }) };

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
 * Reload a single source module by re-importing its file.
 * @private
 * @async
 * @param {object} ctx - The bot (Remix) instance context.
 * @param {object} msg - The command message wrapper.
 * @param {string} filePath - Absolute path to the module file.
 * @param {string} label - Human-readable label for error messages.
 * @returns {Promise<{ ok: boolean, msg: string }>} Result with success status and message.
 */
async function reloadModule(ctx, msg, filePath, label) {
  if (!fs.existsSync(filePath))
    return { ok: false, msg: ctx.t(msg, "responses.reload.fileNotFound", { label }) };
  try {
    await import(pathToFileURL(filePath).href + "?t=" + Date.now());
    return { ok: true, msg: ctx.t(msg, "responses.reload.reloaded", { name: label }) };
  } catch (e) {
    return { ok: false, msg: ctx.t(msg, "responses.reload.moduleError", { label, error: e.message }) };
  }
}

/**
 * List all JS/MJS module files in a subdirectory.
 * @private
 * @param {string} subdir - The subdirectory name relative to project root.
 * @returns {Array<{ file: string, label: string }>} Array of file info objects.
 */
function allModuleFiles(subdir) {
  const dir = path.join(ROOT, subdir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
      .filter(f => f.endsWith(".mjs") || f.endsWith(".js"))
      .map(f => ({ file: path.join(dir, f), label: `${subdir}/${f}` }));
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
 * @param {object} msg - The command message wrapper.
 * @param {object[]} results - Array of { ok, msg } result objects.
 * @param {string} label - Category label for the title.
 * @returns {Promise<void>}
 */
async function showResults(msg, results, label) {
  const ok  = results.filter(r => r.ok).length;
  const bad = results.filter(r => !r.ok).length;
  const header = `✅ **${ok}** reloaded · ❌ **${bad}** failed`;
  await showPaged(msg, `🔄 Reload — ${label}`, [header, "", ...results.map(r => r.msg)]);
}

/**
 * Run handler for the reload command.
 * Reloads commands, src modules, or audio modules based on the target option.
 *
 * @param {object} msg - The command message wrapper.
 * @param {object} data - Parsed command data containing the target option.
 * @returns {Promise<void>}
 */
export async function run(msg, data) {
  const target = (data.get("target")?.value ?? "").trim().toLowerCase();

  if (!target) {
    const cmdLines = this.handler.commands.map(c => `📦 \`${c.name}\` *(command)*`);
    const srcLines = allModuleFiles("src").map(m => `🔧 \`${m.label}\` *(src)*`);
    const audLines = allModuleFiles("audio").map(m => `🎵 \`${m.label}\` *(audio)*`);

    const lines = [
      this.t(msg, "responses.reload.runHint"),
      this.t(msg, "responses.reload.batchKeywords"),
      "",
      ...cmdLines,
      ...srcLines,
      ...audLines,
    ];

    return showPaged(msg, this.t(msg, "responses.reload.availableTargetsTitle"), lines);
  }

  if (target === "commands") {
    const results = [];
    for (const c of [...this.handler.commands]) {
      results.push(await reloadCommand(this, msg, c.name));
    }
    return showResults(msg, results, "Commands");
  }

  if (target === "src") {
    const results = await Promise.all(
        allModuleFiles("src").map(m => reloadModule(this, msg, m.file, m.label))
    );
    return showResults(msg, results, "src/");
  }

  if (target === "audio") {
    const results = await Promise.all(
        allModuleFiles("audio").map(m => reloadModule(this, msg, m.file, m.label))
    );
    return showResults(msg, results, "audio/");
  }

  if (target === "all") {
    const results = [];
    for (const c of [...this.handler.commands]) {
      results.push(await reloadCommand(this, msg, c.name));
    }
    for (const m of allModuleFiles("src")) {
      results.push(await reloadModule(this, msg, m.file, m.label));
    }
    for (const m of allModuleFiles("audio")) {
      results.push(await reloadModule(this, msg, m.file, m.label));
    }
    return showResults(msg, results, "Everything");
  }

  if (this.handler.commands.some(c => c.name === target)) {
    const res = await reloadCommand(this, msg, target);
    return msg.reply(res.msg);
  }

  const allMods = [...allModuleFiles("src"), ...allModuleFiles("audio")];
  const mod = allMods.find(m =>
      m.label.toLowerCase() === target ||
      path.basename(m.file).replace(/\.m?js$/, "").toLowerCase() === target
  );

  if (mod) {
    const res = await reloadModule(this, msg, mod.file, mod.label);
    return msg.reply(res.msg);
  }

  return msg.reply(
      this.t(msg, "responses.reload.unknownTarget", { target })
  );
}
