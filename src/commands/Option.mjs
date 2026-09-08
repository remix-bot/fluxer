/**
 * @module src/commands/Option
 * @description Command option model — typed inputs (string, number, boolean,
 * channel, user, choice, text) with validation, formatting and flag support.
 */

import { Utils } from "../utils/Utils.mjs";

/**
 * @class Option
 * @description Represents a single command option with validation and
 * user-friendly error formatting. Options are positional; Flags (dashed
 * `-name` arguments) share the same base class.
 */
export class Option {
  /** @type {number} Maximum choices before switching to compact format. */
  static THRESHOLD = 10;
  /** @type {number} Number of choice columns per line in compact format. */
  static COLS_PER_LINE = 5;

  /**
   * Format choice values in a compact multi-column layout.
   * @param {string[]} choices
   * @param {number} [perLine=Option.COLS_PER_LINE]
   * @returns {string}
   */
  static formatChoicesCompact(choices, perLine = Option.COLS_PER_LINE) {
    const lines = [];
    for (let i = 0; i < choices.length; i += perLine) {
      lines.push(choices.slice(i, i + perLine).map(c => '`' + c + '`').join(' · '));
    }
    return lines.join('\n');
  }

  /**
   * Format choice values inline, switching to compact layout above the threshold.
   * @param {string[]} choices
   * @returns {string}
   */
  static formatChoicesInline(choices) {
    if (choices.length <= Option.THRESHOLD) {
      return '`' + choices.join('`, `') + '`';
    }
    return Option.formatChoicesCompact(choices, 6);
  }

  /**
   * Format choice values for a usage string, truncating with "…" if over max.
   * @param {string[]} choices
   * @param {number} [max=6]
   * @returns {string}
   */
  static formatChoicesUsage(choices, max = 6) {
    if (choices.length <= max) return choices.join(' | ');
    return choices.slice(0, max).join(' | ') + ' | ...';
  }

  /** @type {RegExp} Matches a channel mention like `<#123456>`. */
  channelRegex = /^<#(?<id>\d+)>/;
  /** @type {RegExp} Matches a user mention like `<@123>` or `<@!123>`. */
  userRegex = /^<@!?(?<id>\d+)>/;
  /** @type {RegExp} Matches a leading numeric ID. */
  idRegex = /^(?<id>\d+)/;

  /** @type {Function|null} Dynamic default value resolver. */
  dynamicDefault;

  /**
   * @param {string} [type="string"] One of: string, number, boolean, channel,
   * voiceChannel, user, choice, text.
   */
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

  /**
   * Factory to create an Option or Flag instance.
   * @param {string} type
   * @param {boolean} [flag=false]
   * @returns {Option|Flag}
   */
  static create(type, flag = false) {
    return (!flag) ? new Option(type) : new Flag(type);
  }

  /** @param {string} n @returns {Option} */
  setName(n) { this.name = n; this.aliases[0] = n; return this; }
  /** @param {string} d @returns {Option} */
  setDescription(d) { this.description = d; return this; }
  /** @param {boolean} r @returns {Option} */
  setRequired(r) { this.required = r; return this; }
  /** @param {string} id @returns {Option} */
  setId(id) { this.id = id; return this; }
  /** @param {string} t @returns {Option} */
  setType(t) { this.type = t; return this; }

  /**
   * Add flag aliases (e.g. "v" for "-v").
   * @param {...string} a
   * @returns {Option}
   */
  addFlagAliases(...a) { this.aliases.push(...a); return this; }

  /**
   * Add a single valid choice value (choice options only).
   * @param {string} c
   * @returns {Option}
   * @throws {Error} If option type is not "choice".
   */
  addChoice(c) {
    if (this.type !== "choice") throw new Error(".addChoice is only available for choice options!");
    this.choices.push(c);
    return this;
  }

  /**
   * Add multiple valid choice values (choice options only).
   * @param {...string} cs
   * @returns {Option}
   * @throws {Error} If option type is not "choice".
   */
  addChoices(...cs) {
    if (this.type !== "choice") throw new Error(".addChoices is only available for choice options!");
    cs.forEach(c => this.addChoice(c));
    return this;
  }

  /**
   * Set the default value used when the option is omitted.
   * @param {*} value
   * @returns {Option}
   */
  setDefault(value) { this.defaultValue = value; return this; }

  /**
   * Set a dynamic default resolver function (called with (client, msg)).
   * @param {Function} callback
   * @returns {Option}
   */
  setDynamicDefault(callback) { this.dynamicDefault = callback; return this; }

  /**
   * Check whether a value is considered empty/omitted.
   * @param {*} i
   * @returns {boolean}
   */
  empty(i) {
    if (i === undefined || i === null) return true;
    return (!i && !(String(i).includes("0")));
  }

  /**
   * Validate an input value for this option type.
   * @param {*} i
   * @param {object} client
   * @param {object} msg
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
        return this.channelRegex.test(i) || this.idRegex.test(i) || client.channels.some(c => c.name === i);
      case "voiceChannel": {
        if (!i) return false;
        const results = this.channelRegex.exec(i) ?? this.idRegex.exec(i);
        const voiceTypes = [2, 13];
        const byName = msg?.guild?.channels?.find(c => c.name === i && voiceTypes.includes(c.type));
        const cObj = results
            ? client.channels.get(results.groups["id"])
            : (byName ?? null);
        return cObj ? voiceTypes.includes(cObj.type) : false;
      }
    }
  }

  /**
   * Format/parse an input value into its canonical form (IDs for mentions,
   * numbers for numeric options, booleans for bools).
   * @param {*} i
   * @param {object} client
   * @param {object} msg
   * @param {string} [type]
   * @returns {*}
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
        const channel = client.channels.find(c => c.name === i);
        return results ? results.groups["id"] : (channel ? channel.id : null);
      }
      case "voiceChannel": {
        const r = this.channelRegex.exec(i) ?? this.idRegex.exec(i);
        const guildId = msg?.channel?.guildId ?? msg?.guildId;
        if (guildId === "eval") return r ? r.groups["id"] : (i || null);
        const voiceTypes = [2, 13];
        const c = msg?.guild?.channels?.find(c => c.name === i && voiceTypes.includes(c.type));
        return r ? r.groups["id"] : (c ? c.id : null);
      }
    }
  }

  /**
   * Generate a type-error message template for this option.
   * @returns {string}
   */
  get typeError() {
    if (this.tError) return this.tError;
    switch (this.type) {
      case "choice": {
        const choiceStr = this.choices.length > Option.THRESHOLD
          ? Option.formatChoicesCompact(this.choices)
          : this.choices.map(c => '- ' + c).join('\n');
        return "Invalid value '$currValue'. The option `" + this.name + "` has to be one of the following: \n" + choiceStr + "\nSchematic: `$previousCmd <" + this.type + ">`";
      }
      case "voiceChannel":
      case "channel":
        return "Invalid value '$currValue'. The option `" + this.name + "` has to be a channel mention, id, or name.\nSchematic: `$previousCmd <" + this.type + ">`";
      default:
        return "Invalid value '$currValue'. The option `" + this.name + "` has to be of type `" + this.type + "`.\nSchematic: `$previousCmd <" + this.type + ">`";
    }
  }

  /** @param {string} e */
  set typeError(e) { this.tError = e; }
}

/**
 * @class Flag
 * @description A dashed (`-name`) option. Flags cannot be of type "text".
 * @extends Option
 */
export class Flag extends Option {
  /**
   * @param {string} [type="string"]
   * @throws {Error} If type is "text".
   */
  constructor(type = "string") {
    if (type === "text") throw new Error("Flags can't be of type 'text'!");
    super(type);
  }
}
