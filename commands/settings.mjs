/**
 * @module commands/settings
 * @description Server settings management with subcommands (get/set/reset/help) and
 * shortcut aliases (prefix, 247). The helpers live in commands/settings/ (utils,
 * channels247, setters); the command factory and run() dispatch stay here.
 */


import { CommandBuilder } from "../src/commands/index.mjs";
import { getMessageGuildId } from "../src/ui/index.mjs";
// kept verbatim from the original file (unused there as well):
import { logger } from "../src/core/Logger.mjs";
import {
  SHORTCUTS, BOOL_SETTINGS, VALID_LOCALES, setValidLocales,
  VOLUME_MIN, VOLUME_MAX,
  displayValue, getGuildName, embed, prettifySettingLabel,
} from "./settings/utils.mjs";
import { get247Channels, build247Panel } from "./settings/channels247.mjs";
import { applySet, handleShortcut } from "./settings/setters.mjs";

/**
 * @type {Function}
 * @description Factory that builds the settings CommandBuilder and registers shortcut commands.
 * Called at load time with `this` bound to the bot instance.
 * @returns {CommandBuilder} The main settings command builder.
 */
export const command = function() {
  if (this.locale) {
    setValidLocales(this.locale.availableLocales());
  }

  if (this.loader) {
    for (const [alias, settingKey] of Object.entries(SHORTCUTS)) {
      const builder = new CommandBuilder()
          .setName(alias)
          .setDescription("Shortcut for `" + settingKey + "`. Usage: $prefix" + alias + " [value]")
          .setId("shortcut_" + alias)
          .setCategory("util")
          .setRequirement(e => e.addPermission("ManageGuild"))
          .addTextOption(o =>
              o.setName("value")
                  .setDescription("New value for " + settingKey)
                  .setRequired(false)
          );
      this.loader.commands.addCommand(builder);
      this.loader.runnables.set(builder.uid, run);
    }
  }

  const settingKeys = this.settingsMgr.getPublicKeys();

  return new CommandBuilder()
      .setName("settings")
      .setDescription("Change/Get settings in the current server.", "commands.settings")
      .addExamples(
          "$prefixsettings get",
          "$prefixsettings get prefix",
          "$prefixsettings set prefix %",
          "$prefixsettings set songAnnouncements off",
          "$prefixsettings set stay_247 on",
          "$prefixsettings set volume 80",
          "$prefixsettings reset prefix",
          "$prefixsettings help"
      )
      .setCategory("util")
      .setRequirement(e => e.addPermission("ManageGuild"))

      .addSubcommand(cmd =>
          cmd.setName("set")
              .setId("setSettings")
              .setDescription("Set the value of a specific setting.", "subcommands.settings.set")
              .addChoiceOption(c =>
                  c.addChoices(...settingKeys)
                      .setName("setting")
                      .setDescription("Which setting to change.", "options.settings.set.setting")
                      .setRequired(true)
              )
              .addTextOption(c =>
                  c.setName("value")
                      .setDescription("The new value.", "options.settings.set.value")
                      .setRequired(true)
              )
      )

      .addSubcommand(cmd =>
          cmd.setName("get")
              .setDescription("Get a setting's value, or list all settings.", "subcommands.settings.get")
              .setId("getSettings")
              .addChoiceOption(c =>
                  c.addChoices(...settingKeys)
                      .setName("setting")
                      .setDescription("Omit to list all settings.", "options.settings.get.setting")
                      .setRequired(false)
              )
      )

      .addSubcommand(cmd =>
          cmd.setName("reset")
              .setDescription("Reset a setting to its default value.", "subcommands.settings.reset")
              .setId("resetSettings")
              .addChoiceOption(c =>
                  c.addChoices(...settingKeys)
                      .setName("setting")
                      .setDescription("Which setting to reset.", "options.settings.reset.setting")
                      .setRequired(true)
              )
      )

      .addSubcommand(cmd =>
          cmd.setName("help")
              .setDescription("Show help for the settings system.", "subcommands.settings.help")
              .setId("helpSettings")
              .addChoiceOption(c =>
                  c.addChoices(...settingKeys)
                      .setName("setting")
                      .setDescription("Omit to see all available settings.", "options.settings.help.setting")
                      .setRequired(false)
              )
      );
};

/**
 * @async
 * Run handler for the settings command.
 * Dispatches to the appropriate subcommand (set/get/reset/help) or shortcut handler.
 * @param {object} message - The command message wrapper.
 * @param {object} data - Parsed command data containing the subcommand and its options.
 * @returns {Promise<void>}
 */
export async function run(message, data) {
  const set     = this.getSettings(message);
  const cmd     = data.commandId || "getSettings";
  const guildId = message.channel?.guildId ?? message.message?.guildId;
  const t247    = this.locale?.translate?.bind(this.locale);

  if (cmd?.startsWith("shortcut_")) {
    const alias      = cmd.replace("shortcut_", "");
    const settingKey = SHORTCUTS[alias];
    const raw        = (message.content ?? message.message?.content ?? "").trim();
    const prefix     = this.handler.getPrefix(guildId);
    const body       = raw.startsWith(prefix) ? raw.slice(prefix.length).trim() : raw;
    const tokens     = body.split(/\s+/).slice(1);
    return handleShortcut(this, message, settingKey, tokens);
  }

  const raw    = (message.content ?? message.message?.content ?? "").trim();
  const prefix = this.handler.getPrefix(guildId);
  const body   = raw.startsWith(prefix) ? raw.slice(prefix.length).trim() : raw;
  const args   = body.split(/\s+/);
  const inlineShortcut = SHORTCUTS[args[1]?.toLowerCase()];
  if (inlineShortcut) {
    return handleShortcut(this, message, inlineShortcut, args.slice(2));
  }

  const settingKey = data.get("setting")?.value;

  if (cmd === "setSettings") {
    const rawValue = data.get("value")?.value;

    if (!this.settingsMgr.isOption(settingKey)) {
      const available = this.settingsMgr.getPublicKeys().join("`, `");
      return message.reply(embed(
          this.t(message, "responses.settings.unknownSetting", { setting: settingKey }) + "\n" + this.t(message, "responses.settings.availableSettings", { settings: available })
      ));
    }

    const err = await applySet(this, message, set, settingKey, rawValue);
    if (err) return message.reply(embed(err));

    if (settingKey === "stay_247") return;

    const newVal = set.get(settingKey);
    const label  = prettifySettingLabel(settingKey, t247, guildId);
    return message.reply(embed(this.t(message, "responses.settings.setSuccess", { label, value: displayValue(settingKey, newVal) })));
  }

  if (cmd === "getSettings") {
    if (settingKey) {
      if (settingKey === "stay_247") {
        const channels = get247Channels(set);
        return message.reply(build247Panel(set, this, guildId, channels.size > 0));
      }
      const val   = set.get(settingKey);
      const desc  = this.settingsMgr.descriptions?.[settingKey];
      const resolvedDesc = desc ? desc.replace(/\$prefix/gi, prefix) : null;
      const label = prettifySettingLabel(settingKey, t247, guildId);
      let reply = "**" + label + "**\nValue: " + displayValue(settingKey, val);
      if (resolvedDesc) reply += "\n\n*" + resolvedDesc + "*";
      return message.reply(embed(reply));
    }

    const d         = set.getAll();
    const guildName = getGuildName(message);
    const rawGuild  = message.message?.guild;
    const iconUrl   = rawGuild?.icon
        ? "https://cdn.fluxer.app/icons/" + rawGuild.id + "/" + rawGuild.icon + ".webp"
        : null;

    const channels = get247Channels(set);
    const lines = this.settingsMgr.getPublicKeys()
        .map(k => {
          if (k === "stay_247") {
            return "\u2022 **24/7 mode** " + String.fromCharCode(8212) + " " + (channels.size > 0
                ? channels.size + " channel(s)"
                : "\u274c disabled");
          }
          const label = prettifySettingLabel(k, t247, guildId);
          return "\u2022 **" + label + "** " + String.fromCharCode(8212) + " " + displayValue(k, d[k]);
        });

    return message.reply(embed(
        this.t(message, "responses.settings.serverHeader", { name: guildName }) + "\n\n" + lines.join("\n") + "\n\n" +
        this.t(message, "responses.settings.shortcutsHint", { prefix }),
        { title: this.t(message, "responses.settings.serverTitle"), iconURL: iconUrl }
    ));
  }

  if (cmd === "resetSettings") {
    if (!this.settingsMgr.isOption(settingKey)) {
      return message.reply(embed(this.t(message, "responses.settings.unknownSetting", { setting: settingKey })));
    }
    set.reset(settingKey);
    if (settingKey === "locale") {
      const gid = getMessageGuildId(message);
      if (gid) this.locale.invalidateCache(gid);
    }
    const def   = set.get(settingKey);
    const label = prettifySettingLabel(settingKey, t247, guildId);
    return message.reply(embed(
        this.t(message, "responses.settings.resetSuccess", { setting: label, value: displayValue(settingKey, def) })
    ));
  }

  if (cmd === "helpSettings") {
    if (!settingKey) {
      const keys    = this.settingsMgr.getPublicKeys();
      const keyList = keys.map(k => "`" + k + "`").join(", ");
      return message.reply(embed(
          this.t(message, "responses.settings.helpTitle") + "\n\n" +
          this.t(message, "responses.settings.helpAvailable", { settings: keyList }) + "\n\n" +
          this.t(message, "responses.settings.helpSubcommands", { prefix }) + "\n\n" +
          this.t(message, "responses.settings.helpShortcuts", { prefix }),
          { title: "\u2699\ufe0f Settings Help" }
      ));
    }

    const rawDescription = this.settingsMgr.descriptions?.[settingKey] ?? this.t(message, "responses.settings.noDescription");
    const description = rawDescription.replace(/\$prefix/gi, prefix);
    const currentVal  = set.get(settingKey);
    const defaultVal  = this.settingsMgr.defaults?.[settingKey];

    let extra = "";
    if (settingKey === "locale") {
      extra = "\n**Valid values:** " + [...VALID_LOCALES].map(l => "`" + l + "`").join(", ");
    } else if (settingKey === "volume") {
      extra = "\n**Valid range:** " + VOLUME_MIN + "\u2013" + VOLUME_MAX;
    } else if (BOOL_SETTINGS.has(settingKey)) {
      extra = "\n**Valid values:** `true`, `false`, `on`, `off`";
    } else if (settingKey === "stay_247") {
      extra = "\n**Usage:** Join a voice channel and use `247` to toggle.\n\nThe bot stays in that channel and auto-rejoins if disconnected.";
    }

    const label = prettifySettingLabel(settingKey, t247, guildId);
    return message.reply(embed(
        "**\u2699\ufe0f Setting: `" + settingKey + "`**\n\n" +
        description + extra + "\n\n" +
        "**Current value:** " + displayValue(settingKey, currentVal) + "\n" +
        "**Default:** " + displayValue(settingKey, defaultVal),
        { title: "\u2699\ufe0f " + settingKey }
    ));
  }
}
