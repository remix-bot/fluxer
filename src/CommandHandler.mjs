import { pathToFileURL } from "node:url";
import { logger } from "./constants/Logger.mjs";
import { Utils } from "./Utils.mjs";
import { EventEmitter } from "node:events";
import { Message, MessageHandler, PageBuilder } from "./MessageHandler.mjs";
import { Client, PermissionFlags } from "@fluxerjs/core";
import { SettingsManager } from "./Settings.mjs";
import path from "node:path";
import * as fs from "node:fs";

export class CommandBuilder {
  constructor() {
    this.name = null;
    this.description = null;
    this.id = null;
    this.aliases = [];
    /** @type {CommandBuilder[]} */
    this.subcommands = [];
    /** @type {Option[]} */
    this.options = [];
    /** @type {CommandRequirement[]} */
    this.requirements = [];
    this.category = "default";
    this.examples = [];

    this.uid = Utils.uid();

    this.subcommandError = "Invalid subcommand. Try one of the following options: `$previousCmd <$cmdlist>`";
    /** @type {CommandBuilder} */
    this.parent = null;
  }
  setName(n) { this.name = n; this.aliases.push(n.toLowerCase()); return this; }
  setDescription(d) { this.description = d; return this; }
  setId(id) { this.id = id; return this; }
  get command() { return (this.parent) ? this.parent.command + " " + this.name : this.name; }
  setRequirement(config) { let req = config(new CommandRequirement()); this.requirements.push(req); return this; }
  addSubcommand(config) { let sub = config(new CommandBuilder()); sub.parent = this; this.subcommands.push(sub); return this; }
  addStringOption(config, flag = false) { this.options.push(config(Option.create("string", flag))); return this; }
  addNumberOption(config, flag = false) { this.options.push(config(Option.create("number", flag))); return this; }
  addBooleanOption(config, flag = false) { this.options.push(config(Option.create("boolean", flag))); return this; }
  addChannelOption(config, flag = false) { this.options.push(config(Option.create("channel", flag))); return this; }
  addUserOption(config, flag = false) { this.options.push(config(Option.create("user", flag))); return this; }
  addTextOption(config) {
    if (this.options.findIndex(e => e.type === "text") !== -1) throw new Error("There can only be 1 text option.");
    this.options.push(config(new Option("text")));
    return this;
  }
  addChoiceOption(config, flag = false) { this.options.push(config(Option.create("choice", flag))); return this; }
  addAlias(alias) { if (this.aliases.findIndex(e => e === alias.toLowerCase()) !== -1) return this; this.aliases.push(alias.toLowerCase()); return this; }
  addAliases(...aliases) { aliases.forEach((a) => this.addAlias(a)); return this; }
  setCategory(cat) { this.category = cat; return this; }
  addExamples(...examples) { this.examples.push(...examples); return this; }
}

export class CommandRequirement {
  ownerOnly = false;
  constructor() {
    this.permissions = [];
    this.permissionError = "You don't have the needed permissions to run this command!";
    return this;
  }
  setOwnerOnly(bool) { this.ownerOnly = bool; return this; }
  /**
   * @param {string} p Fluxer permission string (ManageChannels", "ManageGuild")
   */
  addPermission(p) { this.permissions.push(p); return this; }
  addPermissions(...p) { this.permissions.push(...p); return this; }
  getPermissions() { return (this.ownerOnly) ? [...this.permissions, "Owner-only command"] : this.permissions; }
  setPermissionError(e) { this.permissionError = e; return this; }
}

export class Option {
  // Fluxer uses channel mentions: <#id> and user mentions <@id>
  channelRegex = /^<#(?<id>\d+)>/;
  userRegex = /^<@!?(?<id>\d+)>/;
  idRegex = /^(?<id>\d+)/;

  /** @type {Function} */
  dynamicDefault;

  constructor(type = "string") {
    this.name = null;
    this.description = null;
    this.required = false;
    this.id = null;
    this.uid = Utils.uid();
    this.type = type;
    this.tError = null;
    this.aliases = [null];
    this.choices = [];
    this.translations = {};
    this.defaultValue = null;
    this.dynamicDefault = null;
  }

  static create(type, flag = false) {
    return (!flag) ? new Option(type) : new Flag(type);
  }

  setName(n) { this.name = n; this.aliases[0] = n; return this; }
  setDescription(d) { this.description = d; return this; }
  setRequired(r) { this.required = r; return this; }
  setId(id) { this.id = id; return this; }
  setType(t) { this.type = t; return this; }
  addFlagAliases(...a) { this.aliases.push(...a); return this; }
  addChoice(c) { if (this.type !== "choice") throw new Error(".addChoice is only available for choice options!"); this.choices.push(c); return this; }
  addChoices(...cs) { if (this.type !== "choice") throw new Error(".addChoices is only available for choice options!"); cs.forEach(c => this.addChoice(c)); return this; }
  setDefault(value) { this.defaultValue = value; return this; }
  setDynamicDefault(callback) { this.dynamicDefault = callback; return this; }

  empty(i) {
    if (i === undefined || i === null) return true;
    return (!i && !(String(i).includes("0")));
  }

  /**
   * @param {string} i
   * @param {Client} client
   * @param {import("@fluxerjs/core").Message} msg
   * @param {string} [type]
   * @returns {boolean}
   */
  validateInput(i, client, msg, type) {
    switch (type || this.type) {
      case "text":
      case "string":
        return !!i;
      case "number":
        return !isNaN(i) && !isNaN(parseFloat(i));
      case "boolean":
        return i === "0" || i === "1" || i?.toLowerCase() === "true" || i?.toLowerCase() === "false";
      case "choice":
        return this.choices.includes(i);
      case "user":
        return this.userRegex.test(i) || this.idRegex.test(i);
      case "channel":
        if (i === undefined) return false;
        return this.channelRegex.test(i) || this.idRegex.test(i) || client.channels.cache.some(c => c.name === i);
      case "voiceChannel": {
        if (!i) return false;
        const results = this.channelRegex.exec(i) ?? this.idRegex.exec(i);
        const guildId = msg?.channel?.guildId ?? msg?.guildId;

        // dry-run eval mode
        if (guildId === "eval") return (results) ? results.groups["id"] : i;

        const voiceTypes = [2, 13]; // GuildVoice and GuildStageVoice
        const byName = msg?.guild?.channels?.cache?.find(c => c.name === i && voiceTypes.includes(c.type));
        const cObj = results
            ? client.channels.cache.get(results.groups["id"])
            : (byName ?? null);
        return cObj ? voiceTypes.includes(cObj.type) : false;
      }
    }
  }

  /**
   * @param {string} i
   * @param {Client} client
   * @param {import("@fluxerjs/core").Message} msg
   * @param {string} [type]
   * @returns {string|number|boolean}
   */
  formatInput(i, client, msg, type) {
    switch (type || this.type) {
      case "text":
      case "string":
        return i;
      case "number":
        return parseFloat(i);
      case "boolean":
        return i?.toLowerCase() === "true" || i === "1";
      case "choice":
        return i;
      case "user": {
        const rs = this.userRegex.exec(i) ?? this.idRegex.exec(i);
        return rs?.groups["id"] ?? null;
      }
      case "channel": {
        const results = this.channelRegex.exec(i) ?? this.idRegex.exec(i);
        const channel = client.channels.cache.find(c => c.name === i);
        return results ? results.groups["id"] : (channel ? channel.id : null);
      }
      case "voiceChannel": {
        const r = this.channelRegex.exec(i) ?? this.idRegex.exec(i);
        const guildId = msg?.channel?.guildId ?? msg?.guildId;
        if (guildId === "eval") return r ? r.groups["id"] : (i || null);
        const voiceTypes = [2, 13];
        const c = msg?.guild?.channels?.cache?.find(c => c.name === i && voiceTypes.includes(c.type));
        return r ? r.groups["id"] : (c ? c.id : null);
      }
    }
  }

  get typeError() {
    if (this.tError) return this.tError;
    switch (this.type) {
      case "choice":
        return "Invalid value '$currValue'. The option `" + this.name + "` has to be one of the following options: \n- " + this.choices.join("\n- ") + "\nSchematic: `$previousCmd <" + this.type + ">`";
      case "voiceChannel":
      case "channel":
        return "Invalid value '$currValue'. The option `" + this.name + "` has to be a channel mention, id, or name.\nSchematic: `$previousCmd <" + this.type + ">`";
      default:
        return "Invalid value '$currValue'. The option `" + this.name + "` has to be of type `" + this.type + "`.\nSchematic: `$previousCmd <" + this.type + ">`";
    }
  }
  set typeError(e) { this.tError = e; }
}

export class Flag extends Option {
  constructor(type = "string") {
    if (type === "text") throw new Error("Flags can't be of type 'text'!");
    super(type);
  }
}

export class PrefixManager {
  /** @type {SettingsManager} */
  settings;
  constructor(settings) { this.settings = settings; }
  getPrefix(guildId) { return this.settings.getServer(guildId).get("prefix"); }
}

export class HelpHandler {
  /** @type {CommandHandler} */
  commands;
  commandsPerPage = 5;

  paginationHandler = (msg, helpHandler, cmds) => {
    let form = "Available Commands (page $currentPage/$maxPage): \n\n$content";
    form += "\n\nRun `$prefix$helpCmd <command>` to learn more about it. You can also include subcommands.\n";
    form += "For example: `$prefix$helpCmd settings get`\n\n";
    form += "Tip: Use the arrows beneath this message to turn pages, or specify the required page by using `$prefix$helpCmd <page number>`";

    const contents = cmds.map((cmd, i) => {
      return (i + 1) + ". **" + cmd.name + "**: " + (cmd.description || "").split("\n")[0];
    });

    const pages = new PageBuilder(contents)
        .setForm(helpHandler.commands.format(form, msg.message.guildId))
        .setMaxLines(helpHandler.commandsPerPage);

    helpHandler.commands.messages.initPagination(pages, msg);
    return null;
  }

  customHelpHandler = null;

  constructor(commands) { this.commands = commands; }

  static capitalise(string) {
    if (string.length < 1) return string;
    if (string.length === 1) return string.toUpperCase();
    return string.charAt(0).toUpperCase() + string.slice(1);
  }

  userCommands(cmds) {
    return (cmds || this.commands.commands).filter(c =>
        c.requirements.findIndex(r => r.ownerOnly) === -1
    );
  }

  pageNumber() {
    return Math.ceil(this.commands.commands.length / this.commandsPerPage);
  }

  help(message) {
    if (this.customHelpHandler) return this.customHelpHandler(message);
    if (this.paginationHandler) return this.genHelp(null, message, true);
    return this.getHelpPage(0, message);
  }

  getHelpPage(n, msg, cmds = null) {
    if (!cmds) cmds = this.commands.commands;
    if (!(this.commandsPerPage < cmds.length)) return this.genHelp(null, msg, false, cmds);
    let offset = this.commandsPerPage * n;
    const commands = cmds.slice(offset, offset + this.commandsPerPage);
    let max = Math.ceil(cmds.length / this.commandsPerPage);
    return this.genHelp({ curr: n + 1, max, offset }, msg, false, commands);
  }

  genHelp(page, msg, paginate = false, cmds = null) {
    cmds = this.userCommands(cmds);
    if (this.paginationHandler && msg && paginate) return this.paginationHandler(msg, this, cmds);

    let p = (page) ? ` (page ${page.curr}/${page.max})` : "";
    const indexOffset = (page) ? page.offset : 0;
    let content = "Available Commands" + p + ": \n\n";
    if (page && page.curr !== 1) content += (indexOffset) + ". [...]\n";
    cmds.forEach((cmd, i) => { content += (i + 1 + indexOffset) + ". **" + cmd.name + "**: " + cmd.description + "\n"; });
    if (page && page.curr !== page.max) content += (cmds.length + indexOffset) + ". [...]\n";
    content += "\nRun `$prefix$helpCmd <command>` to learn more about it. You can also include subcommands.\n";
    content += "For example: `$prefix$helpCmd command subcommandName`";
    if (page) content += "\n\nTip: Turn pages by using `$prefix$helpCmd <page number>`";

    return this.commands.format(content, msg.message.guildId);
  }

  commandDescription(command) { return command.description; }

  commandUsage(cmd, msg) {
    if (cmd.subcommands.length > 0) {
      return this.commands.format("$prefix" + cmd.command, msg.message.guildId) + " <" + cmd.subcommands.map(e => e.name).join(" | ") + "> [...]";
    }
    let options = this.commands.format("$prefix" + cmd.command, msg.message.guildId);
    cmd.options.forEach(o => {
      if (o.type === "text") return;
      if (o instanceof Flag)
        return options += (o.type === "choice") ? "-" + o.aliases[0] + " <" + o.choices.join(" | ") + ">" : " -" + o.aliases[0] + " '" + o.type + "'";
      options += (o.type === "choice") ? " <" + o.choices.join(" |") + ">" : " '" + o.name + ": " + o.type + "'";
    });
    let o = cmd.options.find(e => e.type === "text");
    if (o) options += "'" + o.name + ": " + o.type + "'";
    return options.trim();
  }

  getCommandHelp(command, msg) {
    let content = `${HelpHandler.capitalise(command.name)}\n`;
    content += this.commandDescription(command, msg) + "\n\n";
    content += "Usage: \n💻 `" + this.commandUsage(command, msg) + "`\n\n";
    if (command.examples.length > 0)
      content += "Example(s): \n- `" + command.examples.map(e => this.commands.format(e, msg.message.guildId)).join("`\n- `") + "`\n\n";
    if (command.aliases.length > 1) {
      content += "Aliases: \n";
      command.aliases.forEach(alias => { content += "- " + alias + "\n"; });
      content += "\n";
    }
    if (command.subcommands.length > 0) {
      content += "Subcommands: \n";
      command.subcommands.forEach(s => {
        content += "- " + s.name + ": " + (this.commandDescription(s, msg) || "").split("\n")[0] + ((s.options.length > 0) ? "; (`" + s.options.length + " option(s)`)" : "") + "\n";
      });
      content += "\n";
    } else if (command.options.length > 0) {
      content += "Arguments: \n";
      command.options.forEach(o => {
        const optional = ((o.required) ? "" : "?");
        const flag = (o instanceof Flag) ? "-" : "";
        if (o.type === "choice") {
          content += "- **" + flag + o.name + "**" + optional + ": " + (o.description || "").split("\n")[0] + ";\n  - Allowed values: `" + o.choices.join("`, `") + "`\n  - Aliases: `" + o.aliases.join("`, `") + "`\n";
        } else {
          content += "- **" + flag + o.name + "**" + optional + ": " + (o.description || "").split("\n")[0] + "\n  - Aliases: `" + o.aliases.join("`, `") + "`\n";
        }
        content += "\n";
      });
      content += "\n";
    }
    if (command.requirements.length > 0) {
      content += "Requirements: \n";
      command.requirements.forEach(r => {
        content += "- " + r.getPermissions().map(e => "Permission `" + e + "`").join("\n- ");
      });
    }
    return content.trim();
  }
}

export class CommandHandler extends EventEmitter {
  onPing = null;
  pingPrefix = true;
  owners = [];

  /** @type {MessageHandler} */
  messages;
  /** @type {Client} */
  client;
  /** @type {PrefixManager} */
  prefixes;
  /** @type {HelpHandler} */
  helpHandler;

  commandNames = [];
  /** @type {CommandBuilder[]} */
  commands = [];

  invalidFlagError = "Invalid flag `$invalidFlag`. It doesn't match any options on this command.\n`$previousCmd $invalidFlag`";
  textWrapError = "Malformed string `$value`: Missing a closing quote character (`$quote`) after the desired string.";

  constructor(handler, prefix = "!") {
    super();
    this.messages = handler;
    this.client = handler.client;
    this.prefix = prefix;
    this.helpHandler = new HelpHandler(this);
    this.helpCommand = "help";
    this.replyHandler = (message, msg) => {
      msg.replyEmbed(this.format(message, msg.channel.channel.guildId));
    };
    this.messages.onMessage(this.messageHandler.bind(this));
  }

  getPrefix(guildId) { return this.prefixes.getPrefix(guildId); }
  setPingPrefix(bool) { this.pingPrefix = bool; }
  setPrefixManager(manager) { this.prefixes = manager; }
  setHelpHandler(handler) { this.helpHandler = handler; }

  format(text, guildId) {
    const prefix = (!guildId) ? this.prefix : this.getPrefix(guildId);
    return text
        .replace(/\$prefix/gi, prefix)
        .replace(/\$helpCmd/gi, this.helpCommand);
  }

  removeCommand(command) {
    command.aliases.forEach(a => {
      const idx = this.commandNames.indexOf(a);
      if (idx !== -1) this.commandNames.splice(idx, 1);
    });
    const idx = this.commands.findIndex(c => c.uid === command.uid);
    if (idx !== -1) this.commands.splice(idx, 1);
  }

  messageHandler(msg) {
    if (!msg || !msg.content) return;
    const trimmed = msg.content.trim();
    if (/^<@!?\d+>$/.test(trimmed)) {
      // Only respond if the bot itself was pinged
      const botId = this.client.user?.id;
      if (botId && (trimmed === `<@${botId}>` || trimmed === `<@!${botId}>`)) {
        return this.onPing?.(msg);
      }
      return;
    }
    const guildId = msg.channel?.channel?.guildId ?? msg.message?.guildId;
    const prefix = this.getPrefix(guildId);
    const ping = `<@${this.client.user?.id}>`;
    const pingBang = `<@!${this.client.user?.id}>`;
    if (!(msg.content.startsWith(prefix) || msg.content.startsWith(ping) || msg.content.startsWith(pingBang))) return;

    const len = msg.content.startsWith(prefix) ? prefix.length : (msg.content.startsWith(pingBang) ? pingBang.length : ping.length);
    const args = msg.content.slice(len).replace(/\u00A0/gi, " ").trim().split(" ").map(e => e.trim());

    if (!args[0]) return;

    if (args[0] === this.helpCommand) {
      if (!args[1]) {
        const res = this.helpHandler.help(msg);
        return (typeof res === "string") ? this.replyHandler(res, msg) : undefined;
      }
      if (args.length > 1 && Utils.isNumber(args[1])) {
        const pageNumber = parseInt(args[1]);
        if (pageNumber < 1 || pageNumber > this.helpHandler.pageNumber()) return this.replyHandler("`" + pageNumber + "` is not a valid page number!", msg);
        return this.replyHandler(this.helpHandler.getHelpPage(pageNumber - 1, msg), msg);
      }
      if (args.length <= 2) {
        let idx = this.commands.findIndex(e => e.aliases.some(al => al.toLowerCase() === args[1].toLowerCase()));
        if (idx === -1) return this.replyHandler("Unknown command `$prefix" + args[1] + "`!", msg);
        return this.replyHandler(this.helpHandler.getCommandHelp(this.commands[idx], msg), msg);
      }
      let currCmd = null;
      let prefix2 = "";
      for (let i = 0; i < args.slice(1).length; i++) {
        let a = args.slice(1)[i];
        let curr = (currCmd) ? currCmd.subcommands : this.commands;
        let idx = curr.findIndex(e => e.aliases.some(al => al.toLowerCase() === a.toLowerCase()));
        if (idx === -1) return this.replyHandler("Unknown command `$prefix" + prefix2 + a + "`!", msg);
        currCmd = curr[idx];
        prefix2 += a + " ";
      }
      return this.replyHandler(this.helpHandler.getCommandHelp(currCmd, msg), msg);
    }

    if (!this.commandNames.includes(args[0].toLowerCase())) {
      this.replyHandler("Unknown Command. Use `$prefix$helpCmd` to view all possible commands.", msg);
      return;
    }
    return this.processCommand(this.commands.find(e => e.aliases.includes(args[0].toLowerCase())), args, msg);
  }

  processCommand(cmd, args, msg, previous = false, external = false) {
    // Guard first — cmd could be undefined if called from an edge case
    if (!cmd) return logger.warn("[CommandHandler.processCommand] Invalid case: `cmd` falsy.");
    if (cmd.requirements.length > 0 && !external) {
      if (!this.assertRequirements(cmd, msg)) return;
    }
    if (previous === false) previous = this.format("$prefix" + cmd.name, msg.channel?.channel?.guildId);
    if (!external) this.emit("command", { command: cmd, message: msg });

    if (cmd.subcommands.length !== 0) {
      const idx = cmd.subcommands.findIndex(el => {
        if (!args[1]) return false;
        return el.name.toLowerCase() === args[1].toLowerCase();
      });
      if (idx === -1) {
        const list = cmd.subcommands.map(s => s.name).join(" | ");
        const e = "Invalid subcommand. Try one of the following options: `$previousCmd <$cmdlist>`".replace(/\$previousCmd/gi, previous).replace(/\$cmdList/gi, list);
        return (!external) ? this.replyHandler(e, msg) : e;
      }
      return this.processCommand(cmd.subcommands[idx], args.slice(1), msg, previous + this.format(" " + cmd.subcommands[idx].name), external);
    }

    const opts = [];
    const texts = [];

    const collectArguments = (index, currVal, as) => {
      const lastChar = currVal.charAt(currVal.length - 1);
      if (lastChar === '"') return { args: as, index };
      const a = args[++index];
      if (!a) return null;
      as.push(a);
      return collectArguments(index, a, as);
    };

    const options = cmd.options.slice().sort((a, b) => {
      const aText = (a.type === "text") ? 1 : 2;
      const bText = (b.type === "text") ? 1 : 2;
      return aText - bText;
    });

    const STRING_TYPES = ["string", "text", "channel", "voiceChannel"];
    const usedOptions = [];
    let usedArgumentCount = 0;

    for (let i = 0, argIndex = 1; i < options.length; i++) {
      if (options[i] instanceof Flag) i++;
      const o = options[i];
      if (o?.type === "text") { texts.push(o); continue; }
      if ((args[argIndex] || "").startsWith("-")) {
        const flagName = args[argIndex].slice(1);
        const op = cmd.options.find(e => e.aliases.includes(flagName));
        if (!op) {
          const error = this.invalidFlagError.replace(/\$previousCmd/gi, previous).replace(/\$invalidFlag/gi, "-" + flagName);
          return (!external) ? this.replyHandler(error, msg) : error;
        }
        previous += " " + args[argIndex];
        let value = args[++argIndex];
        if ((value || "").startsWith('"') && (STRING_TYPES.includes(op.type))) {
          const data = collectArguments(argIndex, value, [value]);
          if (!data) return this.replyHandler(this.textWrapError.replace(/\$value/gi, args.slice(argIndex).join(" ")).replace(/\$quote/gi, args[argIndex].charAt(0)), msg);
          argIndex += data.index - argIndex;
          value = data.args.join(" ").slice(1, data.args.join(" ").length - 1);
        }
        argIndex++;
        i--;
        const valid = op.validateInput(value, this.client, msg.message);
        if (!valid && (op.required || !op.empty(value))) {
          const e = op.typeError.replace(/\$previousCmd/gi, previous).replace(/\$currValue/gi, value);
          return (!external) ? this.replyHandler(e, msg) : e;
        }
        usedArgumentCount += 2;
        previous += " " + value;
        opts.push({ value: op.formatInput(value, this.client, msg.message), name: op.name, id: op.id, uid: op.uid });
        usedOptions.push(op.uid);
        continue;
      }

      if (!o) continue;
      if (opts.findIndex(op => op.uid === o.uid) !== -1) continue;
      let value = args[argIndex];
      if ((args[argIndex] || "").startsWith('"') && (STRING_TYPES.includes(o.type))) {
        const data = collectArguments(argIndex, args[argIndex], [args[argIndex]]);
        if (!data) return this.replyHandler(this.textWrapError.replace(/\$value/gi, args.slice(argIndex).join(" ")).replace(/\$quote/gi, args[argIndex].charAt(0)), msg);
        argIndex += data.index - argIndex;
        value = data.args.join(" ");
        value = value.slice(1, value.length - 1);
      }
      let valid = o.validateInput(value, this.client, msg.message);
      if (!valid && o.dynamicDefault) {
        value = o.dynamicDefault(this.client, msg);
        valid = o.validateInput(value, this.client, msg.message);
      }
      if (!valid && (o.required || !o.empty(value))) {
        const e = o.typeError.replace(/\$previousCmd/gi, previous).replace(/\$currValue/gi, value);
        return (!external) ? this.replyHandler(e, msg) : e;
      }
      if (o.empty(value)) value = o.defaultValue;
      opts.push({ value: o.formatInput(value, this.client, msg.message), name: o.name, id: o.id, uid: o.uid });
      usedOptions.push(o.uid);
      previous += " " + value;
      argIndex++;
      usedArgumentCount++;
    }

    if (texts.length > 0) {
      let o = texts[0];
      let text = args.slice(usedArgumentCount + 1).join(" ");
      if (o.required && !o.validateInput(text, this.client, msg.message)) {
        let e = o.typeError.replace(/\$previousCmd/gi, previous).replace(/\$currValue/gi, text);
        return (!external) ? this.replyHandler(e, msg) : e;
      }
      const quote = (['"', "'"].includes(text.charAt(0))) ? text.charAt(0) : null;
      if (quote && text.charAt(text.length - 1) === quote) text = text.slice(1, text.length - 1);
      opts.push({ name: o.name, value: text, id: o.id, uid: o.uid });
      usedOptions.push(o.uid);
    }

    options.filter(o => !usedOptions.includes(o.uid)).forEach(o => {
      if (!o.defaultValue) return;
      opts.push({ name: o.name, value: o.defaultValue, id: o.id, uid: o.uid });
    });

    const commandRunData = {
      command: cmd,
      commandId: cmd.id,
      options: opts,
      message: msg,
      get: function (oName) { return this.options.find(o => o.name === oName); },
      getById: function (id) { return this.options.find(o => o.id === id); }
    };
    if (!external) this.emit("run", commandRunData);
    return commandRunData;
  }

  /**
   * Checks requirements using fluxerjs permission API.
   */
  assertRequirements(cmd, msg) {
    const authorId = msg.message?.author?.id;
    const isOwner = this.owners.includes(authorId);

    for (let i = 0; i < cmd.requirements.length; i++) {
      let req = cmd.requirements[i];
      if (req.ownerOnly && !isOwner) return false;
      if (req.permissions.length > 0 && !isOwner) {
        const guild = msg.message?.guild ?? null;
        if (!guild) continue;

        const member = guild.members.get(authorId) ?? null;
        if (member?.permissions) {
          // cached — check directly
          const missing = req.permissions.filter(p => !member.permissions.has(PermissionFlags[p] ?? p));
          if (missing.length > 0) {
            this.replyHandler(req.permissionError, msg);
            return false;
          }
        } else {
          // not cached — fetch async and re-run
          // guild.fetchMember(id) is a Fluxer shorthand; guild.members.fetch(id) is the
          // standard compatible form. Try both so either API name works.
          const fetchPromise = typeof guild.fetchMember === "function"
              ? guild.fetchMember(authorId)
              : typeof guild.members?.fetch === "function"
                  ? guild.members.fetch(authorId)
                  : Promise.reject(new Error("No member fetch API available"));
          fetchPromise.then(member => {
            const missing = req.permissions.filter(p => !member.permissions.has(PermissionFlags[p] ?? p));
            if (missing.length > 0) {
              this.replyHandler(req.permissionError, msg);
            } else {
              // Re-parse args the same way messageHandler does so quoted args survive.
              const guildId2 = msg.channel?.channel?.guildId ?? msg.message?.guildId;
              const prefix2  = this.getPrefix(guildId2);
              const rawContent = msg.message.content;
              const len2 = rawContent.startsWith(prefix2) ? prefix2.length : 0;
              const args = rawContent.slice(len2).replace(/\u00A0/gi, " ").trim().split(" ").map(e => e.trim());
              // Pass external=true to skip re-checking requirements and avoid
              // re-entering the fetch loop if the member is still not cached.
              this.processCommand(cmd, args, msg, false, true);
            }
          }).catch(() => this.replyHandler(req.permissionError, msg));
          return false;
        }
      }
    }
    return true;
  }

  validateInput(type, i, m) { return (new Option()).validateInput(i, this.client, m, type); }
  formatInput(type, i, m) { return (new Option()).formatInput(i, this.client, m, type); }

  addCommand(builder) {
    this.commandNames.push(...builder.aliases);
    this.commands.push(builder);
    this.commands.sort((a, b) => {
      let A = a.name.toUpperCase();
      let B = b.name.toUpperCase();
      return (A < B) ? -1 : (A > B) ? 1 : 0;
    });
    return this.commands;
  }
}

export class CommandLoader {
  /** @type {CommandHandler} */
  commands;
  /** @type {Map<string, string>} */
  commandFiles = new Map();
  /** @type {Map<string, Function>} */
  runnables = new Map();
  context;

  constructor(commands, context) {
    this.commands = commands;
    this.context = context;
    this.context.loader ??= this;
    // expose loader helpers on context so reload.js can use them
    this.context.commandFiles = this.commandFiles;
    this.context.runnables = this.runnables;

    this.commands.on("run", (data) => {
      if (!this.runnables.has(data.command.uid)) return;
      const runFc = this.runnables.get(data.command.uid);
      try {
        const result = runFc.call(this.context, data.message, data);
        if (result && typeof result.catch === "function") {
          result.catch(e => {
            const id = Utils.uid();
            logger.error("Error running command; error id #" + id, e);
            data.message.replyEmbed("An error occurred. Error id: `#" + id + "`");
          });
        }
      } catch (e) {
        const id = Utils.uid();
        logger.error("Error running command; error id #" + id, e);
        data.message.replyEmbed("An error occurred. Error id: `#" + id + "`");
      }
    });
  }

  /**
   * Normalise both ESM named-export shape and legacy default-export shape.
   * Named ESM:  export const command;  export function run;  export const exportDef
   * Legacy CJS: module.exports = { command, run, export }
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