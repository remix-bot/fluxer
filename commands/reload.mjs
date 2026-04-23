import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

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

function embed(desc) {
  return { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(desc).toJSON()] };
}

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const ROOT      = path.resolve(__dirname, "..");

// ── Reload a single command ───────────────────────────────────────────────────
async function reloadCommand(ctx, name) {
  if (name === "index")
    return { ok: false, msg: "❌ `index.mjs` cannot be hot-reloaded — do a full restart." };

  const command = ctx.handler.commands.find(c => c.name === name);
  if (!command) return { ok: false, msg: `❌ Unknown command \`${name}\`` };

  const file = ctx.commandFiles.get(command.uid);
  if (!file)  return { ok: false, msg: `❌ No file tracked for \`${name}\`` };

  // Unregister old
  command.subcommands.forEach(sub => ctx.runnables.delete(sub.uid));
  ctx.handler.removeCommand(command);
  ctx.runnables.delete(command.uid);
  ctx.commandFiles.delete(command.uid);

  // Re-import with cache-buster — use pathToFileURL so Windows drive letters and
  // spaces in paths are handled correctly (plain "file://" + path breaks on Windows).
  const url   = pathToFileURL(file).href + "?t=" + Date.now();
  const cData = await import(url);

  const raw     = cData.command ?? cData.default?.command;
  const builder = typeof raw === "function" ? raw.call(ctx) : raw;
  if (!builder) return { ok: false, msg: `❌ No builder returned from \`${name}\`` };

  const runFn     = cData.run ?? cData.default?.run;
  const exportDef = cData.exportDef ?? cData.export ?? cData.default?.exportDef ?? cData.default?.export;
  if (exportDef) ctx[exportDef.name] = exportDef.object;

  ctx.handler.addCommand(builder);
  ctx.commandFiles.set(builder.uid, file);
  if (runFn) {
    ctx.runnables.set(builder.uid, runFn);
    builder.subcommands.forEach(sub => ctx.runnables.set(sub.uid, runFn));
  }

  return { ok: true, msg: `✅ \`${name}\`` };
}

// ── Reload a src/ or audio/ module ───────────────────────────────────────────
async function reloadModule(ctx, filePath, label) {
  if (!fs.existsSync(filePath))
    return { ok: false, msg: `❌ File not found: \`${label}\`` };
  try {
    await import(pathToFileURL(filePath).href + "?t=" + Date.now());
    return { ok: true, msg: `✅ \`${label}\`` };
  } catch (e) {
    return { ok: false, msg: `❌ \`${label}\`: ${e.message}` };
  }
}

// ── List all module files in a subdirectory ───────────────────────────────────
function allModuleFiles(subdir) {
  const dir = path.join(ROOT, subdir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
      .filter(f => f.endsWith(".mjs") || f.endsWith(".js"))
      .map(f => ({ file: path.join(dir, f), label: `${subdir}/${f}` }));
}

// ── Paginated embed helper ────────────────────────────────────────────────────
async function showPaged(msg, title, lines, pageSize = 14) {
  const pages = [];
  for (let i = 0; i < lines.length; i += pageSize)
    pages.push(lines.slice(i, i + pageSize));

  if (pages.length === 0) pages.push(["*(nothing)*"]);

  const arrows = ["⬅️", "➡️"];
  const curr   = { n: 0 };

  const mkEmbed = (n) => ({
    embeds: [
      new EmbedBuilder()
          .setColor(getGlobalColor())
          .setTitle(title)
          .setDescription(pages[n].join("\n") + (pages.length > 1 ? `\n\nPage **${n + 1}** / **${pages.length}**` : ""))
          .toJSON()
    ]
  });

  const m = await msg.replyEmbed(mkEmbed(0));
  if (!m || pages.length <= 1) return;

  m.message.react(arrows[0]).catch(() => {});
  m.message.react(arrows[1]).catch(() => {});

  const unsub = m.onReaction(arrows, (e) => {
    if (e.emoji_id === arrows[0]) curr.n = Math.max(0, curr.n - 1);
    else curr.n = Math.min(pages.length - 1, curr.n + 1);
    m.editEmbed(mkEmbed(curr.n)).catch(() => {});
  });

  setTimeout(() => { unsub?.(); }, 5 * 60_000);
}

// ── Batch results → paginated display ────────────────────────────────────────
async function showResults(msg, results, label) {
  const ok  = results.filter(r => r.ok).length;
  const bad = results.filter(r => !r.ok).length;
  const header = `✅ **${ok}** reloaded · ❌ **${bad}** failed`;
  await showPaged(msg, `🔄 Reload — ${label}`, [header, "", ...results.map(r => r.msg)]);
}

// ── Main ──────────────────────────────────────────────────────────────────────
export async function run(msg, data) {
  const target = (data.get("target")?.value ?? "").trim().toLowerCase();

  // No target — show paginated list of everything reloadable
  if (!target) {
    const cmdLines = this.handler.commands.map(c => `📦 \`${c.name}\` *(command)*`);
    const srcLines = allModuleFiles("src").map(m => `🔧 \`${m.label}\` *(src)*`);
    const audLines = allModuleFiles("audio").map(m => `🎵 \`${m.label}\` *(audio)*`);

    const lines = [
      "Run `%reload <target>` or use a batch keyword:",
      "`all` · `commands` · `src` · `audio`",
      "",
      ...cmdLines,
      ...srcLines,
      ...audLines,
    ];

    return showPaged(msg, "🔄 Reload — Available Targets", lines);
  }

  // Batch keywords
  if (target === "commands") {
    const results = await Promise.all(
        this.handler.commands.map(c => reloadCommand(this, c.name))
    );
    return showResults(msg, results, "Commands");
  }

  if (target === "src") {
    const results = await Promise.all(
        allModuleFiles("src").map(m => reloadModule(this, m.file, m.label))
    );
    return showResults(msg, results, "src/");
  }

  if (target === "audio") {
    const results = await Promise.all(
        allModuleFiles("audio").map(m => reloadModule(this, m.file, m.label))
    );
    return showResults(msg, results, "audio/");
  }

  if (target === "all") {
    const results = await Promise.all([
      ...this.handler.commands.map(c => reloadCommand(this, c.name)),
      ...allModuleFiles("src").map(m => reloadModule(this, m.file, m.label)),
      ...allModuleFiles("audio").map(m => reloadModule(this, m.file, m.label)),
    ]);
    return showResults(msg, results, "Everything");
  }

  // Single command by name
  if (this.handler.commands.some(c => c.name === target)) {
    const res = await reloadCommand(this, target);
    return msg.replyEmbed(embed(res.msg));
  }

  // Single src/ or audio/ module by filename (with or without extension/subdir)
  const allMods = [...allModuleFiles("src"), ...allModuleFiles("audio")];
  const mod = allMods.find(m =>
      m.label.toLowerCase() === target ||
      path.basename(m.file).replace(/\.m?js$/, "").toLowerCase() === target
  );

  if (mod) {
    const res = await reloadModule(this, mod.file, mod.label);
    return msg.replyEmbed(embed(res.msg));
  }

  return msg.replyEmbed(embed(
      `❌ Unknown target \`${target}\`.\nRun \`%reload\` with no arguments to see all reloadable targets.`
  ));
}
