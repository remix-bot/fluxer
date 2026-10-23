/**
 * @module src/commands/CommandLoader
 * @description Dynamically loads command modules from a directory, registers
 * their builders, and binds run handlers with error capture + error-id replies.
 */

import { pathToFileURL } from "node:url";
import path from "node:path";
import * as fs from "node:fs";
import { logger } from "../core/Logger.mjs";
import { Utils } from "../utils/Utils.mjs";

/**
 * @class CommandLoader
 * @description Loads command files from a directory, registers builders with
 * the CommandHandler, and dispatches "run" events to the matching run function.
 *
 * Command module shape (both shapes are accepted):
 * - `export const command` (builder or builder-factory), `export const run`
 * - default export object with the same keys
 * - optional `exportDef: { name, object }` registers a global on the context
 */
export class CommandLoader {
  /** @type {import('./CommandHandler.mjs').CommandHandler} */
  commands;
  /** @type {Map<string, string>} Command UID → file path. */
  commandFiles = new Map();
  /** @type {Map<string, Function>} Command UID → run function. */
  runnables = new Map();
  /** @type {object} Shared context (the bot instance). */
  context;

  /**
   * @param {import('./CommandHandler.mjs').CommandHandler} commands
   * @param {object} context - Bot context object (gets loader/runnables refs attached).
   */
  constructor(commands, context) {
    this.commands = commands;
    this.context = context;
    this.context.loader ??= this;
    this.context.commandFiles = this.commandFiles;
    this.context.runnables = this.runnables;

    this.commands.on("run", (data) => {
      if (!this.runnables.has(data.command.uid)) return;
      const runFc = this.runnables.get(data.command.uid);
      const sendErrorReply = (id) => {
        Promise.resolve(data.message.reply("An error occurred. Error id: `#" + id + "`"))
          .catch(err => logger.warn("[CommandHandler] Failed to send error-reply; error id #" + id + ":", err?.message));
      };
      try {
        const result = runFc.call(this.context, data.message, data);
        if (result && typeof result.catch === "function") {
          result.catch(e => {
            const id = Utils.uid();
            logger.error("Error running command; error id #" + id, e);
            sendErrorReply(id);
          });
        }
      } catch (e) {
        const id = Utils.uid();
        logger.error("Error running command; error id #" + id, e);
        sendErrorReply(id);
      }
    });
  }

  /**
   * Normalize a module export to `{ command, run, exportDef }`.
   * @param {object} cData
   * @returns {object}
   */
  canonData(cData) {
    if (cData.command !== undefined) {
      return {
        command:   cData.command,
        run:       cData.run,
        exportDef: cData.exportDef ?? cData.export ?? null
      };
    }
    const d = cData.default ?? cData;
    return {
      command:   d.command,
      run:       d.run,
      exportDef: d.exportDef ?? d.export ?? null
    };
  }

  /**
   * @async Load all command files from a directory.
   * @param {string} dir
   * @returns {Promise<undefined[]>}
   */
  loadFromDir(dir) {
    const files = fs.readdirSync(dir)
        .filter(f => !f.startsWith(".") && (f.endsWith(".js") || f.endsWith(".mjs")));

    return Promise.all(files.map(async commandFile => {
      const file = path.join(dir, commandFile);

      const cData = this.canonData(await import(pathToFileURL(file).href));

      const builder = (typeof cData.command === "function")
          ? cData.command.call(this.context)
          : cData.command;

      if (!builder) return logger.warn("No builder returned. Skipping '" + commandFile + "'");

      if (cData.exportDef)
        this.context[cData.exportDef.name] = cData.exportDef.object;

      this.commands.addCommand(builder);
      this.commandFiles.set(builder.uid, file);

      if (!cData.run) return;

      this.runnables.set(builder.uid, cData.run);
      builder.subcommands.forEach(sub => {
        this.runnables.set(sub.uid, cData.run);
      });
    }));
  }
}
