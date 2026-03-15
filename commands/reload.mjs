import { CommandBuilder } from "../src/CommandHandler.mjs";
import fs from "node:fs";
import path from "node:path";

export const command = new CommandBuilder()
  .setName("reload")
  .setDescription("Reload a specified command.")
  .addStringOption(o =>
    o.setName("command")
      .setDescription("The name of the root command that should be reloaded.")
      .setRequired(true)
  )
  .setRequirement(r => r.setOwnerOnly(true));

export async function run(msg, data) {
  const com = data.get("command").value;

  if (com === "scandir") {
    // Scanning for new commands is handled at startup; a full restart is needed for new files
    return msg.replyEmbed("Use a full restart to pick up new command files.");
  }

  const command = this.handler.commands.find(c => c.name === com);
  if (!command) return msg.replyEmbed("Unknown Command `" + com + "`");

  // Remove all references to the command and its subcommands
  command.subcommands.forEach(sub => { this.runnables.delete(sub.uid); });
  this.handler.removeCommand(command);
  this.runnables.delete(command.uid);

  const file = this.commandFiles.get(command.uid);
  this.commandFiles.delete(command.uid);

  // ESM modules are cached by URL. Bust the cache with a query param timestamp.
  const fileUrl = new URL("file://" + file + "?t=" + Date.now()).href;
  const cData = await import(fileUrl);

  // Support both named exports (new ESM style) and default export (old CJS-compat style)
  const builder = (typeof (cData.command ?? cData.default?.command) === "function")
    ? (cData.command ?? cData.default?.command).call(this)
    : (cData.command ?? cData.default?.command);

  if (!builder) return msg.replyEmbed("No command builder returned from `" + com + "`");

  const runFn = cData.run ?? cData.default?.run;
  const exportDef = cData.exportDef ?? cData.export ?? cData.default?.exportDef ?? cData.default?.export;

  if (exportDef) this[exportDef.name] = exportDef.object;

  this.handler.addCommand(builder);
  this.commandFiles.set(builder.uid, file);

  if (runFn) {
    this.runnables.set(builder.uid, runFn);
    builder.subcommands.forEach(sub => { this.runnables.set(sub.uid, runFn); });
  }

  msg.replyEmbed("✅ Successfully reloaded `" + com + "`!");
}
