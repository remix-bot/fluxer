/**
 * @module src/commands/CommandBuilder
 * @description Fluent builder for command definitions (name, description,
 * options, subcommands, aliases, requirements) plus the permission
 * requirement model.
 */

import { Utils } from "../utils/Utils.mjs";
import { Option } from "./Option.mjs";

/**
 * @class CommandRequirement
 * @description Permission and owner-only gating for a command.
 */
export class CommandRequirement {
  /** @type {boolean} Whether the command is restricted to bot owners. */
  ownerOnly = false;

  /** Create a new CommandRequirement with no permissions. */
  constructor() {
    this.permissions = [];
    this.permissionError = "You don't have the needed permissions to run this command!";
    return this;
  }

  /** @param {boolean} bool @returns {CommandRequirement} */
  setOwnerOnly(bool) { this.ownerOnly = bool; return this; }
  /** @param {string} p @returns {CommandRequirement} */
  addPermission(p) { this.permissions.push(p); return this; }
  /** @param {...string} p @returns {CommandRequirement} */
  addPermissions(...p) { this.permissions.push(...p); return this; }

  /**
   * @returns {string[]} The permission list (with an owner note appended when
   * the requirement is owner-only).
   */
  getPermissions() { return (this.ownerOnly) ? [...this.permissions, "Owner-only command"] : this.permissions; }
  /** @param {string} e @returns {CommandRequirement} */
  setPermissionError(e) { this.permissionError = e; return this; }
}

/**
 * @class CommandBuilder
 * @description Fluent builder for constructing command definitions with name,
 * description, options, subcommands, aliases, requirements and examples.
 */
export class CommandBuilder {
  /** Create a new CommandBuilder with default empty state. */
  constructor() {
    this.name = null;
    this.description = null;
    this.id = null;
    this.aliases = [];
    this.subcommands = [];
    this.options = [];
    this.requirements = [];
    this.category = "default";
    this.examples = [];

    this.uid = Utils.uid();

    this.subcommandError = "Invalid subcommand. Try one of the following options: `$previousCmd <$cmdlist>`";
    this.parent = null;
  }

  /** Set the command name and register it as the primary alias. @param {string} n @returns {CommandBuilder} */
  setName(n) { this.name = n; this.aliases.push(n.toLowerCase()); return this; }
  /** Set the command description. @param {string} d @returns {CommandBuilder} */
  setDescription(d) { this.description = d; return this; }
  /** Set the command ID. @param {string} id @returns {CommandBuilder} */
  setId(id) { this.id = id; return this; }

  /** @returns {string} Full command path including parent chain (e.g. "music play"). */
  get command() { return (this.parent) ? this.parent.command + " " + this.name : this.name; }

  /**
   * Add a permission/owner-only requirement via a callback.
   * @param {Function} config - Callback receiving a fresh {@link CommandRequirement}.
   * @returns {CommandBuilder}
   */
  setRequirement(config) { let req = config(new CommandRequirement()); this.requirements.push(req); return this; }

  /**
   * Add a subcommand builder via a callback.
   * @param {Function} config - Callback receiving a fresh {@link CommandBuilder}.
   * @returns {CommandBuilder}
   */
  addSubcommand(config) { let sub = config(new CommandBuilder()); sub.parent = this; this.subcommands.push(sub); return this; }

  /**
   * Add a string option.
   * @param {Function} config @param {boolean} [flag=false] @returns {CommandBuilder}
   */
  addStringOption(config, flag = false) { this.options.push(config(Option.create("string", flag))); return this; }
  /**
   * Add a number option.
   * @param {Function} config @param {boolean} [flag=false] @returns {CommandBuilder}
   */
  addNumberOption(config, flag = false) { this.options.push(config(Option.create("number", flag))); return this; }
  /**
   * Add a boolean option.
   * @param {Function} config @param {boolean} [flag=false] @returns {CommandBuilder}
   */
  addBooleanOption(config, flag = false) { this.options.push(config(Option.create("boolean", flag))); return this; }
  /**
   * Add a channel option.
   * @param {Function} config @param {boolean} [flag=false] @returns {CommandBuilder}
   */
  addChannelOption(config, flag = false) { this.options.push(config(Option.create("channel", flag))); return this; }
  /**
   * Add a voice-channel option.
   * @param {Function} config @param {boolean} [flag=false] @returns {CommandBuilder}
   */
  addVoiceChannelOption(config, flag = false) { this.options.push(config(Option.create("voiceChannel", flag))); return this; }
  /**
   * Add a user option.
   * @param {Function} config @param {boolean} [flag=false] @returns {CommandBuilder}
   */
  addUserOption(config, flag = false) { this.options.push(config(Option.create("user", flag))); return this; }

  /**
   * Add a text (remaining-args) option. Only one is allowed per command.
   * @param {Function} config
   * @returns {CommandBuilder}
   * @throws {Error} If a text option already exists.
   */
  addTextOption(config) {
    if (this.options.findIndex(e => e.type === "text") !== -1) throw new Error("There can only be 1 text option.");
    this.options.push(config(new Option("text")));
    return this;
  }

  /**
   * Add a choice (enum-like) option.
   * @param {Function} config @param {boolean} [flag=false] @returns {CommandBuilder}
   */
  addChoiceOption(config, flag = false) { this.options.push(config(Option.create("choice", flag))); return this; }

  /**
   * Add an alias (case-insensitive, duplicates ignored).
   * @param {string} alias
   * @returns {CommandBuilder}
   */
  addAlias(alias) {
    if (this.aliases.findIndex(e => e === alias.toLowerCase()) !== -1) return this;
    this.aliases.push(alias.toLowerCase());
    return this;
  }

  /**
   * Add multiple aliases.
   * @param {...string} aliases
   * @returns {CommandBuilder}
   */
  addAliases(...aliases) { aliases.forEach((a) => this.addAlias(a)); return this; }

  /** Set the command category (used by help grouping). @param {string} cat @returns {CommandBuilder} */
  setCategory(cat) { this.category = cat; return this; }

  /**
   * Add usage examples.
   * @param {...string} examples
   * @returns {CommandBuilder}
   */
  addExamples(...examples) { this.examples.push(...examples); return this; }
}
