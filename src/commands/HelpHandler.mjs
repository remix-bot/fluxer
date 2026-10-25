/**
 * @module src/commands/HelpHandler
 * @description Text-based help generation: paginated command lists, per-command
 * usage/aliases/options rendering. Used as the default help renderer behind
 * `%help <n>` (the rich tabbed help lives in src/ui/HelpCommand.mjs).
 */

import { PageBuilder } from "../ui/Paginators.mjs";
import { Option, Flag } from "./Option.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../ui/index.mjs";

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
   * Generate detailed help embed for a single command.
   * @param {import('./CommandBuilder.mjs').CommandBuilder} command
   * @param {object} msg
   * @returns {object} Object with embeds array containing the EmbedBuilder.
   */
  getCommandHelp(command, msg) {
    const guildId = msg.message?.guildId ?? msg.channel?.guildId;
    const prefix = this.commands.getPrefix(guildId);
    const category = command.category ? command.category.toLowerCase() : "general";

    const embed = new EmbedBuilder()
      .setColor(getGlobalColor())
      .setAuthor({ name: `Command Help • ${prefix}${command.name}` })
      .setTitle(HelpHandler.capitalise(command.name))
      .setDescription(this.commandDescription(command, msg) || "No description provided.")
      .addFields({
        name: `💻 ${this.commands.t(guildId, "cmdHandler.help.usage")}`,
        value: `\`${this.commandUsage(command, msg)}\``,
        inline: false
      });

    if (command.examples.length > 0) {
      embed.addFields({
        name: `💡 ${this.commands.t(guildId, "cmdHandler.help.examples")}`,
        value: command.examples.map(e => `\`${this.commands.format(e, guildId)}\``).join("\n"),
        inline: false
      });
    }

    if (command.aliases.length > 1) {
      embed.addFields({
        name: `🏷️ ${this.commands.t(guildId, "cmdHandler.help.aliases")}`,
        value: command.aliases.map(a => `\`${a}\``).join(", "),
        inline: true
      });
    }

    if (command.subcommands.length > 0) {
      const subs = command.subcommands.map(s => {
        const optCount = s.options.length > 0 ? ` (\`${s.options.length} options\`)` : "";
        return `• **${s.name}**: ${(this.commandDescription(s, msg) || "").split("\n")[0]}${optCount}`;
      }).join("\n");
      embed.addFields({
        name: `📂 ${this.commands.t(guildId, "cmdHandler.help.subcommands")}`,
        value: subs.slice(0, 1024),
        inline: false
      });
    } else if (command.options.length > 0) {
      const optLines = command.options.map(o => {
        const optional = o.required ? "" : " *(optional)*";
        const flag = (o instanceof Flag) ? "-" : "";
        const desc = (o.description || "").split("\n")[0];
        if (o.type === "choice") {
          const choiceDisplay = Option.formatChoicesInline(o.choices);
          return `• **${flag}${o.name}**${optional}: ${desc}\n  └ Values: \`${choiceDisplay}\``;
        }
        return `• **${flag}${o.name}**${optional}: ${desc}`;
      }).join("\n");
      embed.addFields({
        name: `⚙️ ${this.commands.t(guildId, "cmdHandler.help.arguments")}`,
        value: optLines.slice(0, 1024),
        inline: false
      });
    }

    if (command.requirements.length > 0) {
      const perms = command.requirements.map(r =>
        r.getPermissions().map(e => this.commands.t(guildId, "cmdHandler.help.permission", { $permission: e })).join(", ")
      ).filter(Boolean).join(", ");
      if (perms) {
        embed.addFields({
          name: `🔒 ${this.commands.t(guildId, "cmdHandler.help.requirements")}`,
          value: perms.slice(0, 1024),
          inline: false
        });
      }
    }

    embed.setFooter({ text: `Type ${prefix}help for full command list • Category: ${category}` });

    return { embeds: [embed] };
  }
}
