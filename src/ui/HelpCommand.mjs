/**
 * @module src/ui/HelpCommand
 * @description The rich tabbed help command (Home / Music / Utilities /
 * Support) rendered through RichPaginator, with full i18n support and
 * interception of plain-text help aliases.
 */

import { RichPaginator } from "./Paginators.mjs";

/** @type {number} Maximum commands listed per page in the help paginator. */
const HELP_CMDS_PER_PAGE = 10;
/** @type {number} Help paginator session timeout in milliseconds. */
const HELP_SESSION_MS    = 30 * 1000;

/** @type {object[]} Tab definitions for the rich help. */
const HELP_TABS = [
  {
    key:        "home",
    emoji:      "🏠",
    titleKey:   "cmdHandler.help.tabHome",
    headerKey:  "cmdHandler.help.tabHomeHeader",
    static:     true,
  },
  {
    key:        "music",
    emoji:      "🎵",
    titleKey:   "cmdHandler.help.tabMusic",
    headerKey:  "cmdHandler.help.tabMusicHeader",
    categories: ["music"],
  },
  {
    key:        "util",
    emoji:      "🔧",
    titleKey:   "cmdHandler.help.tabUtil",
    headerKey:  "cmdHandler.help.tabUtilHeader",
    categories: ["util", "default"],
  },
  {
    key:        "support",
    emoji:      "ℹ️",
    titleKey:   "cmdHandler.help.tabSupport",
    headerKey:  "cmdHandler.help.tabSupportHeader",
    static:     true,
  },
];

/**
 * @private Build paginated content for a help category tab using localized strings.
 * @param {object} tab
 * @param {Array} allCmds
 * @param {string} prefix
 * @param {string|null} guildId
 * @param {import('../commands/CommandHandler.mjs').CommandHandler} commandHandler
 * @returns {string[]}
 */
function _helpBuildCategoryPages(tab, allCmds, prefix, guildId, commandHandler) {
  const cmds = allCmds
      .filter(cmd => {
        if (cmd.requirements?.some(r => r.ownerOnly)) return false;
        return tab.categories?.includes(cmd.category ?? "default");
      })
      .sort((a, b) => a.name.localeCompare(b.name));

  if (cmds.length === 0) {
    return [commandHandler.t(guildId, "cmdHandler.help.noCommands")];
  }

  const pages = [];
  for (let i = 0; i < cmds.length; i += HELP_CMDS_PER_PAGE) {
    const slice = cmds.slice(i, i + HELP_CMDS_PER_PAGE);
    let   page  = "";
    slice.forEach((cmd) => {
      const translated = commandHandler.t(guildId, "commands." + cmd.name);
      const d = (translated && translated !== "commands." + cmd.name ? translated : (cmd.description || "No description.")).split("\n")[0];
      page += `\`${prefix}${cmd.name}\` — ${d}\n`;
    });
    page += commandHandler.t(guildId, "cmdHandler.help.learnMore");
    if (cmds.length > HELP_CMDS_PER_PAGE) {
      page += commandHandler.t(guildId, "cmdHandler.help.subpageTip");
    }
    pages.push(page);
  }
  return pages;
}

/**
 * @class HelpCommand
 * @description Rich paginated help command with tabbed navigation.
 */
export class HelpCommand {
  /**
   * @param {import('../commands/CommandHandler.mjs').CommandHandler} commandHandler
   * @param {import('./MessageHandler.mjs').MessageHandler} messageHandler
   * @param {Function} getSettingsFn
   */
  constructor(commandHandler, messageHandler, getSettingsFn) {
    this._commands = commandHandler;
    this._messages = messageHandler;
    this._getSettings = getSettingsFn;
  }

  /**
   * Register the help command, intercept invalid command replies, and
   * intercept help aliases so the rich help takes priority.
   */
  register() {
    if (this._registered) return;
    this._registered = true;

    const HELP_ALIASES = ["help", "h", "commands"];

    this._commands.helpCommand = "\x00help";
    const _fmt = this._commands.format.bind(this._commands);
    this._commands.format = (text, guildId) =>
        _fmt(text, guildId).replace(/\x00help/g, "help");

    const _reply = this._commands.replyHandler.bind(this._commands);
    this._commands.replyHandler = (message, msg) => {
      const content = msg?.content ?? msg?.message?.content ?? "";
      const guildId = msg?.channel?.channel?.guildId ?? msg?.message?.guildId;
      const prefix  = this._commands.getPrefix(guildId);
      const botId   = this._commands.client.user?.id;
      const ping     = `<@${botId}>`;
      const pingBang = `<@!${botId}>`;
      let body = null;
      if (content.startsWith(prefix))       body = content.slice(prefix.length).trim();
      else if (content.startsWith(pingBang)) body = content.slice(pingBang.length).trim();
      else if (content.startsWith(ping))     body = content.slice(ping.length).trim();
      if (body !== null) {
        const first = body.split(/\s+/)[0]?.toLowerCase();
        if (HELP_ALIASES.includes(first)) return;
      }
      return _reply(message, msg);
    };

    const evict = () => {
      for (const alias of HELP_ALIASES) {
        const i = this._commands.commandNames.indexOf(alias);
        if (i !== -1) this._commands.commandNames.splice(i, 1);
      }
      const ci = this._commands.commands.findIndex(c =>
          c.aliases.some(a => HELP_ALIASES.includes(a.toLowerCase()))
      );
      if (ci !== -1) this._commands.commands.splice(ci, 1);
    };
    evict();
    const _add = this._commands.addCommand.bind(this._commands);
    this._commands.addCommand = (builder) => {
      const r = _add(builder);
      if (builder.aliases.some(a => HELP_ALIASES.includes(a.toLowerCase()))) evict();
      return r;
    };

    this._messages.onMessage((msg) => {
      if (!msg?.content) return;
      const content = msg.content.trim();
      const guildId = msg.channel?.channel?.guildId ?? msg.message?.guildId;
      const prefix  = this._commands.getPrefix(guildId);
      const botId   = this._commands.client.user?.id;
      const ping     = `<@${botId}>`;
      const pingBang = `<@!${botId}>`;
      let body = null;
      if (content.startsWith(prefix))       body = content.slice(prefix.length).trim();
      else if (content.startsWith(pingBang)) body = content.slice(pingBang.length).trim();
      else if (content.startsWith(ping))     body = content.slice(ping.length).trim();
      if (body === null) return;

      const args    = body.split(/\s+/).map(s => s.trim()).filter(Boolean);
      const cmdName = (args[0] ?? "").toLowerCase();
      if (!HELP_ALIASES.includes(cmdName)) return;

      this._handle(msg, args.slice(1), prefix);
    });
  }

  /**
   * @private Handle a help invocation: show command detail or paginated overview.
   * @param {import('./Wrappers.mjs').Message} msg
   * @param {string[]} args
   * @param {string} prefix
   */
  _handle(msg, args, prefix) {
    const allCmds = this._commands.commands;
    const query   = (args[0] ?? "").trim();
    const guildId = msg.channel?.channel?.guildId ?? msg.message?.guildId;

    if (query && isNaN(Number(query))) {
      let currCmd = null;
      for (const word of [query, ...args.slice(1)]) {
        const pool = currCmd ? currCmd.subcommands : allCmds;
        const found = pool.find(c =>
            c.aliases.some(a => a.toLowerCase() === word.toLowerCase())
        );
        if (!found) {
          msg.reply(this._commands.t(guildId, "cmdHandler.help.unknownCommand", { command: word, prefix }));
          return;
        }
        currCmd = found;
      }
      if (currCmd) {
        msg.reply(this._commands.helpHandler.getCommandHelp(currCmd, msg));
      }
      return;
    }

    const startTab = query
        ? Math.max(0, Math.min(HELP_TABS.length - 1, parseInt(query) - 1))
        : 0;

    const paginator = new RichPaginator(msg, this._messages)
        .setTimeout(HELP_SESSION_MS)
        .setStartTab(startTab);

    for (const tab of HELP_TABS) {
      const title  = this._commands.t(guildId, tab.titleKey);
      const header = this._commands.t(guildId, tab.headerKey);
      if (tab.static) {
        const contentKey = tab.key === "home"
            ? "cmdHandler.help.homeContent"
            : "cmdHandler.help.supportContent";
        const content = this._commands.t(guildId, contentKey);
        paginator.addTab({ emoji: tab.emoji, title, header, content });
      } else {
        const pages = _helpBuildCategoryPages(tab, allCmds, prefix, guildId, this._commands);
        paginator.addTab({ emoji: tab.emoji, title, header, pages });
      }
    }

    paginator.send();
  }
}
