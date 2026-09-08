/**
 * @module src/commands/CommandHandler
 * @description The command dispatcher: parses incoming messages, matches
 * commands and aliases, validates options/flags, enforces permissions and
 * per-user cooldowns, and emits "run" events consumed by the CommandLoader.
 */

import { EventEmitter } from "node:events";
import { PermissionFlags } from "@fluxerjs/core";
import { logger } from "../core/Logger.mjs";
import { Utils } from "../utils/Utils.mjs";
import { Message, REQUIRED_BOT_PERMISSIONS } from "../ui/index.mjs";
import { Option, Flag } from "./Option.mjs";
import { HelpHandler } from "./HelpHandler.mjs";
import { PrefixManager } from "./PrefixManager.mjs";

/** @type {string[]} Option types whose quoted values may span multiple tokens. */
const QUOTABLE_TYPES = ["string", "text", "channel", "voiceChannel"];

/**
 * @class CommandHandler
 * @description Main command dispatcher.
 * @extends {EventEmitter}
 *
 * Events:
 * - `"command"` — emitted with `{ command, message }` when a command starts.
 * - `"run"` — emitted with the fully parsed run payload (see processCommand).
 */
export class CommandHandler extends EventEmitter {
  /** @type {Function|null} Custom handler when the bot is pinged. */
  onPing = null;
  /** @type {boolean} Whether the bot responds to pings as a prefix. */
  pingPrefix = true;
  /** @type {string[]} Bot owner user IDs. */
  owners = [];

  /** @type {import('../ui/MessageHandler.mjs').MessageHandler} */
  messages;
  client;
  /** @type {PrefixManager} */
  prefixes;
  /** @type {HelpHandler} */
  helpHandler;

  /** @type {string[]} All registered command aliases. */
  commandNames = [];
  /** @type {import('./CommandBuilder.mjs').CommandBuilder[]} Registered commands. */
  commands = [];

  /** @type {object|null} Locale manager. */
  locale = null;

  invalidFlagError = "Invalid flag `$invalidFlag`. It doesn't match any options on this command.\n`$previousCmd $invalidFlag`";
  textWrapError = "Malformed string `$value`: Missing a closing quote character (`$quote`) after the desired string.";

  /** @private @type {Map<string, number>} Per-user last command timestamps for cooldown enforcement. */
  _cmdCooldowns = new Map();
  /** @private @type {number} Cooldown duration in ms between commands per non-owner user. */
  _cmdCooldownMs = 1500;

  /**
   * @param {import('../ui/MessageHandler.mjs').MessageHandler} handler
   * @param {string} [prefix="%"]
   */
  constructor(handler, prefix = "%") {
    super();
    this.messages = handler;
    this.client = handler.client;
    this.prefix = prefix;
    this.helpHandler = new HelpHandler(this);
    this.helpCommand = "help";
    this.replyHandler = (message, msg) => {
      msg.reply(this.format(message, msg.channel.channel.guildId));
    };
    this.messages.onMessage(this.messageHandler.bind(this));
  }

  /** Get the command prefix for a guild. @param {string} guildId @returns {string} */
  getPrefix(guildId) { return this.prefixes.getPrefix(guildId); }
  /** Enable or disable ping-as-prefix. @param {boolean} bool */
  setPingPrefix(bool) { this.pingPrefix = bool; }
  /** @param {PrefixManager} manager */
  setPrefixManager(manager) { this.prefixes = manager; }
  /** @param {HelpHandler} handler */
  setHelpHandler(handler) { this.helpHandler = handler; }
  /** @param {object} locale */
  setLocale(locale) { this.locale = locale; }

  /**
   * Translate a locale key.
   * @param {string} guildId
   * @param {string} key
   * @param {object} [replacements={}]
   * @returns {string}
   */
  t(guildId, key, replacements = {}) {
    if (!this.locale) return key;
    return this.locale.translate(guildId, key, replacements);
  }

  /**
   * Replace $prefix and $helpCmd placeholders in text.
   * @param {string} text
   * @param {string} guildId
   * @returns {string}
   */
  format(text, guildId) {
    const prefix = (!guildId) ? this.prefix : this.getPrefix(guildId);
    return text
        .replace(/\$prefix/gi, prefix)
        .replace(/\$helpCmd/gi, this.helpCommand);
  }

  /**
   * Remove a command from the registry.
   * @param {import('./CommandBuilder.mjs').CommandBuilder} command
   */
  removeCommand(command) {
    command.aliases.forEach(a => {
      const idx = this.commandNames.indexOf(a);
      if (idx !== -1) this.commandNames.splice(idx, 1);
    });
    const idx = this.commands.findIndex(c => c.uid === command.uid);
    if (idx !== -1) this.commands.splice(idx, 1);
  }

  /**
   * @private Handle an incoming message and route it to command processing.
   * Handles bare pings, prefix detection, cooldowns and the built-in help.
   * @param {Message} msg
   */
  messageHandler(msg) {
    if (!msg || !msg.content) return;
    const trimmed = msg.content.trim();
    if (/^<@!?\d+>$/.test(trimmed)) {
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

    if (this._isCoolingDown(msg)) return;
    this._enforceCooldown(msg);

    const len = msg.content.startsWith(prefix) ? prefix.length : (msg.content.startsWith(pingBang) ? pingBang.length : ping.length);
    const args = msg.content.slice(len).replace(/\u00A0/gi, " ").trim().split(" ").map(e => e.trim());

    if (!args[0]) return;

    if (args[0] === this.helpCommand) {
      return this._handleHelpInvocation(args, guildId, msg);
    }

    if (!this.commandNames.includes(args[0].toLowerCase())) {
      this.replyHandler(this.t(guildId, "cmdHandler.command.invalid", { command: this.format("$prefix$helpCmd", guildId) }), msg);
      return;
    }
    return this.processCommand(this.commands.find(e => e.aliases.includes(args[0].toLowerCase())), args, msg);
  }

  /**
   * @private Apply the per-user cooldown gate: records the timestamp for the
   * invoking user and prunes the cooldown map when it grows too large.
   * Owners are exempt.
   * @param {Message} msg
   */
  _enforceCooldown(msg) {
    const userId = msg.message?.author?.id ?? msg.author?.id;
    if (!userId || this.owners.includes(userId)) return;

    const now  = Date.now();
    this._cmdCooldowns.set(userId, now);
    if (this._cmdCooldowns.size > 500) {
      const cutoff = now - this._cmdCooldownMs * 2;
      for (const [uid, ts] of this._cmdCooldowns) {
        if (ts < cutoff) this._cmdCooldowns.delete(uid);
      }
    }
  }

  /**
   * @private Cooldown gate — returns true when the user invoked a command too
   * recently and the message should be dropped (owners are exempt).
   * @param {Message} msg
   * @returns {boolean}
   */
  _isCoolingDown(msg) {
    const userId = msg.message?.author?.id ?? msg.author?.id;
    if (!userId || this.owners.includes(userId)) return false;
    const now  = Date.now();
    const last = this._cmdCooldowns.get(userId) ?? 0;
    return (now - last) < this._cmdCooldownMs;
  }

  /**
   * @private Built-in `%help` invocation handling (bare / page / command / subcommand path).
   * @param {string[]} args
   * @param {string} guildId
   * @param {Message} msg
   */
  _handleHelpInvocation(args, guildId, msg) {
    if (!args[1]) {
      const res = this.helpHandler.help(msg);
      return (typeof res === "string") ? this.replyHandler(res, msg) : undefined;
    }
    if (args.length > 1 && Utils.isNumber(args[1])) {
      const pageNumber = parseInt(args[1]);
      if (pageNumber < 1 || pageNumber > this.helpHandler.pageNumber()) {
        return this.replyHandler(this.t(guildId, "cmdHandler.page.invalid", { number: pageNumber }), msg);
      }
      return this.replyHandler(this.helpHandler.getHelpPage(pageNumber - 1, msg), msg);
    }
    if (args.length <= 2) {
      let idx = this.commands.findIndex(e => e.aliases.some(al => al.toLowerCase() === args[1].toLowerCase()));
      if (idx === -1) return this.replyHandler(this.t(guildId, "cmdHandler.command.invalid", { command: this.format("$prefix" + args[1], guildId) }), msg);
      return this.replyHandler(this.helpHandler.getCommandHelp(this.commands[idx], msg), msg);
    }
    let currCmd = null;
    let prefix2 = "";
    for (let i = 0; i < args.slice(1).length; i++) {
      let a = args.slice(1)[i];
      let curr = (currCmd) ? currCmd.subcommands : this.commands;
      let idx = curr.findIndex(e => e.aliases.some(al => al.toLowerCase() === a.toLowerCase()));
      if (idx === -1) return this.replyHandler(this.t(guildId, "cmdHandler.command.invalid", { command: this.format("$prefix" + prefix2 + a, guildId) }), msg);
      currCmd = curr[idx];
      prefix2 += a + " ";
    }
    return this.replyHandler(this.helpHandler.getCommandHelp(currCmd, msg), msg);
  }

  /**
   * Parse and execute a command with its options.
   * @param {import('./CommandBuilder.mjs').CommandBuilder} cmd
   * @param {string[]} args
   * @param {Message} msg
   * @param {string|boolean} [previous=false] - The command path so far (for error messages).
   * @param {boolean} [external=false] - When true, errors are returned instead of replied.
   * @returns {object|undefined} The command run payload.
   */
  processCommand(cmd, args, msg, previous = false, external = false) {
    if (!cmd) return logger.warn("[CommandHandler.processCommand] Invalid case: `cmd` falsy.");

    if (!external) {
      const channel = msg.channel?.channel ?? msg.channel;
      if (channel?.guild) {
        const botPermResult = this.messages.checkAllBotPermissions(channel);
        if (botPermResult.criticalMissing.length > 0) {
          const permEmbed = this.messages.buildPermissionEmbed(botPermResult.missing, channel.guildId);
          try {
            msg.message?.reply?.({ embeds: [permEmbed] }, { ping: false });
          } catch (_) {
            try {
              const names = botPermResult.missing.map(k => REQUIRED_BOT_PERMISSIONS.get(k)?.name ?? k);
              msg.message?.reply?.("I'm missing critical permissions: **" + names.join("**, **") + "**. Ask an admin to fix this.", { ping: false });
            } catch (__) { logger.warn("[CommandHandler] Fallback perm reply failed"); }
          }
          return;
        }
      }
    }

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
        const subGuildId = msg.channel?.channel?.guildId ?? msg.message?.guildId;
        const e = this.t(subGuildId, "cmdBuilder.subcommand.invalid").replace(/\$previousCmd/gi, previous).replace(/\$cmdList/gi, list);
        return (!external) ? this.replyHandler(e, msg) : e;
      }
      return this.processCommand(cmd.subcommands[idx], args.slice(1), msg, previous + this.format(" " + cmd.subcommands[idx].name), external);
    }

    // `error === true` → internal invocation: the error reply was already
    // sent by _parseOptions and, exactly like the original monolith, the
    // command must NOT run (no "run" emission). A string is the external-
    // mode error, returned to the caller as before.
    const { opts, error } = this._parseOptions(cmd, args, msg, previous, external);
    if (error) return (error === true) ? undefined : error;

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
   * @private Parse positional options, flags, quoted values and text options.
   * @param {import('./CommandBuilder.mjs').CommandBuilder} cmd
   * @param {string[]} args
   * @param {Message} msg
   * @param {string} previous
   * @param {boolean} external
   * @returns {{opts: Array, error: *}} Parsed options or a handled error:
   * `null` on success; `true` when an internal (non-external) invocation
   * already sent its error reply and the caller must stop (the original
   * monolith exited processCommand directly at these points); the error
   * string for external invocations at the option/flag validation sites
   * (textWrap sites always reply, matching the original's always-reply quirk).
   */
  _parseOptions(cmd, args, msg, previous, external) {
    const opts = [];
    const texts = [];

    /**
     * Collect quoted arguments spanning multiple tokens.
     * @param {number} index
     * @param {string} currVal
     * @param {string[]} as
     * @returns {{args: string[], index: number}|null}
     */
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

    const usedOptions = [];
    let usedArgumentCount = 0;

    for (let i = 0, argIndex = 1; i < options.length; i++) {
      const o = options[i];
      if (o?.type === "text") { texts.push(o); continue; }
      if ((args[argIndex] || "").startsWith("-")) {
        const flagName = args[argIndex].slice(1);
        const op = cmd.options.find(e => e.aliases.includes(flagName));
        if (!op) {
          const flagGuildId = msg.channel?.channel?.guildId ?? msg.message?.guildId;
          const error = this.t(flagGuildId, "cmdHandler.invalidFlag").replace(/\$previousCmd/gi, previous).replace(/\$invalidFlag/gi, "-" + flagName);
          return { opts, error: (!external) ? (this.replyHandler(error, msg) ?? true) : error };
        }
        previous += " " + args[argIndex];
        let value = args[++argIndex];
        if ((value || "").startsWith('"') && (QUOTABLE_TYPES.includes(op.type))) {
          const data = collectArguments(argIndex, value, [value]);
          if (!data) {
            const twGuildId = msg.channel?.channel?.guildId ?? msg.message?.guildId;
            return { opts, error: (this.replyHandler(this._textWrapErrorMsg(twGuildId, args.slice(argIndex).join(" "), args[argIndex].charAt(0)), msg) ?? true) };
          }
          argIndex += data.index - argIndex;
          const _joined = data.args.join(" ");
          value = _joined.slice(1, _joined.length - 1);
        }
        argIndex++;
        i--;
        const valid = op.validateInput(value, this.client, msg.message);
        if (!valid && (op.required || !op.empty(value))) {
          const errGuildId = msg.channel?.channel?.guildId ?? msg.message?.guildId;
          const e = this._optionTypeError(errGuildId, op, value, previous);
          return { opts, error: (!external) ? (this.replyHandler(e, msg) ?? true) : e };
        }
        usedArgumentCount += 2;
        previous += " " + value;
        opts.push({ value: op.formatInput(value, this.client, msg.message), name: op.name, id: op.id, uid: op.uid });
        usedOptions.push(op.uid);
        continue;
      }

      if (!o) continue;
      if (o instanceof Flag) continue;
      if (opts.findIndex(op => op.uid === o.uid) !== -1) continue;
      let value = args[argIndex];
      if ((args[argIndex] || "").startsWith('"') && (QUOTABLE_TYPES.includes(o.type))) {
        const data = collectArguments(argIndex, args[argIndex], [args[argIndex]]);
        if (!data) {
          const twGuildId2 = msg.channel?.channel?.guildId ?? msg.message?.guildId;
          return { opts, error: (this.replyHandler(this._textWrapErrorMsg(twGuildId2, args.slice(argIndex).join(" "), args[argIndex].charAt(0)), msg) ?? true) };
        }
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
        const errGuildId2 = msg.channel?.channel?.guildId ?? msg.message?.guildId;
        const e = this._optionTypeError(errGuildId2, o, value, previous);
        return { opts, error: (!external) ? (this.replyHandler(e, msg) ?? true) : e };
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
        const textErrGuildId = msg.channel?.channel?.guildId ?? msg.message?.guildId;
        let e = this._optionTypeError(textErrGuildId, o, text, previous);
        return { opts, error: (!external) ? (this.replyHandler(e, msg) ?? true) : e };
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

    return { opts, error: null };
  }

  /**
   * Check whether the message author meets all command requirements
   * (owner-only, guild permissions). When member data must be fetched over
   * REST, re-invokes processCommand asynchronously once resolved.
   * @param {import('./CommandBuilder.mjs').CommandBuilder} cmd
   * @param {Message} msg
   * @returns {boolean}
   */
  assertRequirements(cmd, msg) {
    const authorId = msg.message?.author?.id;
    const isOwner = this.owners.includes(authorId);
    const permGuildId = msg.channel?.channel?.guildId ?? msg.message?.guildId;

    for (let i = 0; i < cmd.requirements.length; i++) {
      let req = cmd.requirements[i];
      if (req.ownerOnly && !isOwner) return false;
      if (req.permissions.length > 0 && !isOwner) {
        const guild = msg.message?.guild ?? null;
        if (!guild) {
          this.replyHandler(this.t(permGuildId, "cmdBuilder.requirement.permission"), msg);
          return false;
        }

        const member = guild.members.get(authorId) ?? null;
        if (member?.permissions) {
          const missing = req.permissions.filter(p => !member.permissions.has(PermissionFlags[p] ?? p));
          if (missing.length > 0) {
            this.replyHandler(this.t(permGuildId, "cmdBuilder.requirement.permission"), msg);
            return false;
          }
        } else {
          const fetchPromise = typeof guild.fetchMember === "function"
              ? guild.fetchMember(authorId)
              : typeof guild.members?.fetch === "function"
                  ? guild.members.fetch(authorId)
                  : Promise.reject(new Error("No member fetch API available"));
          fetchPromise.then(member => {
            const missing = req.permissions.filter(p => !member.permissions.has(PermissionFlags[p] ?? p));
            if (missing.length > 0) {
              this.replyHandler(this.t(permGuildId, "cmdBuilder.requirement.permission"), msg);
            } else {
              const guildId2 = msg.channel?.channel?.guildId ?? msg.message?.guildId;
              const prefix2  = this.getPrefix(guildId2);
              const rawContent = msg.message.content;
              const len2 = rawContent.startsWith(prefix2) ? prefix2.length : 0;
              const args = rawContent.slice(len2).replace(/\u00A0/gi, " ").trim().split(" ").map(e => e.trim());
              this.processCommand(cmd, args, msg, false, true);
            }
          }).catch(() => this.replyHandler(this.t(permGuildId, "cmdBuilder.requirement.permission"), msg));
          return false;
        }
      }
    }
    return true;
  }

  /**
   * Validate an input for a given option type.
   * @param {string} type
   * @param {*} i
   * @param {object} m
   * @returns {boolean}
   */
  validateInput(type, i, m) { return (new Option()).validateInput(i, this.client, m, type); }

  /**
   * Format an input for a given option type.
   * @param {string} type
   * @param {*} i
   * @param {object} m
   * @returns {*}
   */
  formatInput(type, i, m) { return (new Option()).formatInput(i, this.client, m, type); }

  /**
   * @private Build a type-error message for an option.
   * @param {string} guildId
   * @param {Option} option
   * @param {*} value
   * @param {string} previous
   * @returns {string}
   */
  _optionTypeError(guildId, option, value, previous) {
    if (option.tError) {
      return option.tError.replace(/\$previousCmd/gi, previous).replace(/\$currValue/gi, value);
    }
    const localeKey = option.type === 'choice' ? 'cmdBuilder.option.invalidChoice'
      : (option.type === 'channel' || option.type === 'voiceChannel') ? 'cmdBuilder.option.invalidChannel'
      : 'cmdBuilder.option.invalidType';
    const choiceStr = option.type === 'choice'
      ? (option.choices.length > Option.THRESHOLD ? Option.formatChoicesCompact(option.choices) : option.choices.map(c => '- ' + c).join('\n'))
      : '';
    return this.t(guildId, localeKey, {
      $currValue: value,
      $optionName: option.name,
      $type: option.type,
      $choices: choiceStr
    }).replace(/\$previousCmd/gi, previous);
  }

  /**
   * @private Build a text-wrap error message.
   * @param {string} guildId
   * @param {string} value
   * @param {string} quote
   * @returns {string}
   */
  _textWrapErrorMsg(guildId, value, quote) {
    return this.t(guildId, 'cmdHandler.textWrapError', { $value: value, $quote: quote });
  }

  /**
   * Register a command builder and sort the command list alphabetically.
   * @param {import('./CommandBuilder.mjs').CommandBuilder} builder
   * @returns {import('./CommandBuilder.mjs').CommandBuilder[]}
   */
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
