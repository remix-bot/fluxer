/**
 * @module src/commands/HelpHandler
 * @description Text-based help generation: paginated command lists, per-command
 * usage/aliases/options rendering. Used as the default help renderer behind
 * `%help <n>` (the rich tabbed help lives in src/ui/HelpCommand.mjs).
 */

import { PageBuilder } from "../ui/Paginators.mjs";
import { Option, Flag } from "./Option.mjs";

/**
 * @class HelpHandler
 * @description Generates paginated help text for commands.
 */
export class HelpHandler {
  /** @type {import('./CommandHandler.mjs').CommandHandler} */
  commands;
  /** @type {number} Commands per help page. */
  commandsPerPage = 5;

  /**
   * Default pagination handler that builds paginated help pages.
   * @param {object} msg - Message wrapper with message data.
   * @param {HelpHandler} helpHandler
   * @param {Array} cmds
   * @returns {string|null}
   */
  paginationHandler = (msg, helpHandler, cmds) => {
    const guildId = msg.message.guildId;
    let form = this.commands.t(guildId, "cmdHandler.help.pageStructure");

    const contents = cmds.map((cmd, i) => {
      return (i + 1) + ". **" + cmd.name + "**: " + (cmd.description || "").split("\n")[0];
    });

    const pages = new PageBuilder(contents)
        .setForm(helpHandler.commands.format(form, msg.message.guildId))
        .setMaxLines(helpHandler.commandsPerPage);

    helpHandler.commands.messages.initPagination(pages, msg);
    return null;
  }

  /** @type {Function|null} Custom help handler function override. */
  customHelpHandler = null;

  /** @param {import('./CommandHandler.mjs').CommandHandler} commands */
  constructor(commands) { this.commands = commands; }

  /**
   * @param {string} string
   * @returns {string} Capitalised first letter.
   */
  static capitalise(string) {
    if (string.length < 1) return string;
    if (string.length === 1) return string.toUpperCase();
    return string.charAt(0).toUpperCase() + string.slice(1);
  }

  /**
   * @param {Array} [cmds]
   * @returns {Array} Non-owner-only commands.
   */
  userCommands(cmds) {
    return (cmds || this.commands.commands).filter(c =>
        c.requirements.findIndex(r => r.ownerOnly) === -1
    );
  }

  /** @returns {number} Total number of help pages. */
  pageNumber() {
    return Math.ceil(this.commands.commands.length / this.commandsPerPage);
  }

  /**
   * Entry point for help rendering.
   * @param {object} message
   * @returns {string|null}
   */
  help(message) {
    if (this.customHelpHandler) return this.customHelpHandler(message);
    if (this.paginationHandler) return this.genHelp(null, message, true);
    return this.getHelpPage(0, message);
  }

  /**
   * @param {number} n - 0-based page index.
   * @param {object} msg
   * @param {Array} [cmds=null]
   * @returns {string}
   */
  getHelpPage(n, msg, cmds = null) {
    if (!cmds) cmds = this.commands.commands;
    if (!(this.commandsPerPage < cmds.length)) return this.genHelp(null, msg, false, cmds);
    let offset = this.commandsPerPage * n;
    const commands = cmds.slice(offset, offset + this.commandsPerPage);
    let max = Math.ceil(cmds.length / this.commandsPerPage);
    return this.genHelp({ curr: n + 1, max, offset }, msg, false, commands);
  }

  /**
   * @param {object|null} page
   * @param {object} msg
   * @param {boolean} [paginate=false]
   * @param {Array} [cmds=null]
   * @returns {string}
   */
  genHelp(page, msg, paginate = false, cmds = null) {
    cmds = this.userCommands(cmds);
    if (this.paginationHandler && msg && paginate) return this.paginationHandler(msg, this, cmds);

    const guildId = msg.message.guildId;
    let p = (page) ? ` (page ${page.curr}/${page.max})` : "";
    const indexOffset = (page) ? page.offset : 0;
    let content = this.commands.t(guildId, "cmdHandler.help.availableCommands", { $page: p }) + "\n\n";
    if (page && page.curr !== 1) content += (indexOffset) + this.commands.t(guildId, "cmdHandler.help.ellipsis") + "\n";
    cmds.forEach((cmd, i) => { content += (i + 1 + indexOffset) + ". **" + cmd.name + "**: " + cmd.description + "\n"; });
    if (page && page.curr !== page.max) content += (cmds.length + indexOffset) + this.commands.t(guildId, "cmdHandler.help.ellipsis") + "\n";
    content += this.commands.format(this.commands.t(guildId, "cmdHandler.help.runHelp"), guildId);
    if (page) content += this.commands.format(this.commands.t(guildId, "cmdHandler.help.pageTip"), guildId);

    return this.commands.format(content, guildId);
  }

  /**
   * Get the description of a command.
   * @param {import('./CommandBuilder.mjs').CommandBuilder} command
   * @returns {string}
   */
  commandDescription(command) { return command.description; }

  /**
   * Build a usage string for a command including options and flags.
   * @param {import('./CommandBuilder.mjs').CommandBuilder} cmd
   * @param {object} msg
   * @returns {string}
   */
  commandUsage(cmd, msg) {
    if (cmd.subcommands.length > 0) {
      return this.commands.format("$prefix" + cmd.command, msg.message.guildId) + " <" + cmd.subcommands.map(e => e.name).join(" | ") + "> [...]";
    }
    let options = this.commands.format("$prefix" + cmd.command, msg.message.guildId);
    cmd.options.forEach(o => {
      if (o.type === "text") return;
      if (o instanceof Flag)
        return options += (o.type === "choice") ? "-" + o.aliases[0] + " <" + Option.formatChoicesUsage(o.choices) + ">" : " -" + o.aliases[0] + " '" + o.type + "'";
      options += (o.type === "choice") ? " <" + Option.formatChoicesUsage(o.choices) + ">" : " '" + o.name + ": " + o.type + "'";
    });
    let o = cmd.options.find(e => e.type === "text");
    if (o) options += "'" + o.name + ": " + o.type + "'";
    return options.trim();
  }

  /**
   * Generate detailed help text for a single command.
   * @param {import('./CommandBuilder.mjs').CommandBuilder} command
   * @param {object} msg
   * @returns {string}
   */
  getCommandHelp(command, msg) {
    const guildId = msg.message.guildId;
    let content = `${HelpHandler.capitalise(command.name)}\n`;
    content += this.commandDescription(command, msg) + "\n\n";
    content += this.commands.t(guildId, "cmdHandler.help.usage") + "\n💻 `" + this.commandUsage(command, msg) + "`\n\n";
    if (command.examples.length > 0)
      content += this.commands.t(guildId, "cmdHandler.help.examples") + "\n- `" + command.examples.map(e => this.commands.format(e, guildId)).join("`\n- `") + "`\n\n";
    if (command.aliases.length > 1) {
      content += this.commands.t(guildId, "cmdHandler.help.aliases") + "\n";
      command.aliases.forEach(alias => { content += "- " + alias + "\n"; });
      content += "\n";
    }
    if (command.subcommands.length > 0) {
      content += this.commands.t(guildId, "cmdHandler.help.subcommands") + "\n";
      command.subcommands.forEach(s => {
        const optCount = s.options.length > 0 ? "; (`" + this.commands.t(guildId, "cmdHandler.help.optionCount", { $count: s.options.length }) + "`)" : "";
        content += "- " + s.name + ": " + (this.commandDescription(s, msg) || "").split("\n")[0] + optCount + "\n";
      });
      content += "\n";
    } else if (command.options.length > 0) {
      content += this.commands.t(guildId, "cmdHandler.help.arguments") + "\n";
      command.options.forEach(o => {
        const optional = ((o.required) ? "" : "?");
        const flag = (o instanceof Flag) ? "-" : "";
        if (o.type === "choice") {
          const choiceDisplay = Option.formatChoicesInline(o.choices);
          const aliasDisplay = o.aliases.filter(a => a !== null).join('`, `');
          content += "- **" + flag + o.name + "**" + optional + ": " + (o.description || "").split("\n")[0] + ";\n  - " + this.commands.t(guildId, "cmdHandler.help.allowedValues") + choiceDisplay + "\n  - " + this.commands.t(guildId, "cmdHandler.help.aliasesLabel") + "`" + aliasDisplay + "`\n";
        } else {
          content += "- **" + flag + o.name + "**" + optional + ": " + (o.description || "").split("\n")[0] + "\n  - " + this.commands.t(guildId, "cmdHandler.help.aliasesLabel") + "`" + o.aliases.join("`, `") + "`\n";
        }
        content += "\n";
      });
      content += "\n";
    }
    if (command.requirements.length > 0) {
      content += this.commands.t(guildId, "cmdHandler.help.requirements") + "\n";
      command.requirements.forEach(r => {
        content += "- " + r.getPermissions().map(e => this.commands.t(guildId, "cmdHandler.help.permission", { $permission: e })).join("\n- ");
      });
    }
    return content.trim();
  }
}
