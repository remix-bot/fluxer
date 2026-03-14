import { CommandBuilder } from "../src/CommandHandler.mjs";
import runnables from "../settings/runnables.mjs";

export const command = function() {
  return new CommandBuilder()
    .setName("settings")
    .setDescription("Change/Get settings in the current server.", "commands.settings")
    .addAliases("s")
    .addExamples("$prefixsettings get", "$prefixsettings get locale", "$prefixsettings set locale de-DE")
    .setCategory("util")
    .addRequirement(e => e.addPermission("ManageGuild"))
    .addSubcommand(cmd =>
      cmd.setName("set")
        .setId("setSettings")
        .setDescription("Set the value of a specific setting.", "subcommands.settings.set")
        .addChoiceOption(c =>
          c.addChoices(...Object.keys(this.settingsMgr.defaults))
            .setName("setting")
            .setDescription("The name of the setting you want to set.", "options.settings.set.setting")
            .setRequired(true)
        ).addTextOption(c =>
          c.setName("value")
            .setDescription("The new value.", "options.settings.set.value")
            .setRequired(true))
    ).addSubcommand(cmd =>
      cmd.setName("get")
        .setDescription("Get the value of a specific setting or the settings of the server.", "subcommands.settings.get")
        .setId("getSettings")
        .addChoiceOption(c =>
          c.addChoices(...Object.keys(this.settingsMgr.defaults))
            .setName("setting")
            .setDescription("Get the current value of a setting.", "options.settings.get.setting")
            .setRequired(false)
        )
    ).addSubcommand(cmd =>
      cmd.setName("reset")
        .setDescription("Reset a setting to its default value.", "subcommands.settings.reset")
        .setId("reset")
        .addChoiceOption(c =>
          c.addChoices(...Object.keys(this.settingsMgr.defaults))
            .setName("setting")
            .setDescription("The setting to reset.", "options.settings.reset.setting")
            .setRequired(true)
        )
    ).addSubcommand(cmd =>
      cmd.setName("help")
        .setDescription("Display help for the settings system.", "subcommands.settings.help")
        .setId("help")
        .addChoiceOption(c =>
          c.addChoices(...Object.keys(this.settingsMgr.defaults))
            .setName("setting")
            .setDescription("Optional setting to explain.", "options.settings.help.setting")
            .setRequired(false)
        )
    );
};

export function run(message, data) {
  const set = this.getSettings(message);
  const cmd = data.commandId;
  const setting = data.get("setting")?.value;
  switch (cmd) {
    case "setSettings": {
      let failed = false;
      if (runnables[setting]) {
        failed = runnables[setting].call(this, data.get("value").value, { msg: message, d: data });
      }
      if (failed) return message.replyEmbed(failed);
      set.set(setting, data.get("value").value);
      message.replyEmbed("Settings changed!");
      break;
    }
    case "getSettings": {
      if (setting) return message.replyEmbed(`\`${setting}\` is set to \`${set.get(setting)}\``);
      const d = set.getAll();
      let msg = "The settings for this server (" + (message.message?.guild?.name ?? "this server") + ") are as following: \n\n";
      for (const key in d) { msg += "- " + key + ": `" + d[key] + "`\n"; }
      message.replyEmbed(msg.trim(), false, {
        title: "Settings",
        icon_url: message.message?.guild?.iconURL?.() ?? null
      });
      break;
    }
    case "reset": {
      set.reset(setting);
      message.replyEmbed("`" + setting + "` has been reset to `" + set.get(setting) + "`.");
      break;
    }
    case "help": {
      if (!setting) {
        const m = `# Settings\n\nSettings are server-wide. To be able to change them, you need the \`ManageGuild\` permission.\nThey allow you to customise things like Remix' command prefix or certain behaviour in voice channels.\n\nYou can view the current server settings by using the \`$prefixsettings get\` command.\n\nTo display more information about an individual option, use \`$prefixsettings help <option name>\`\n\nAvailable options are: \`${Object.keys(this.settingsMgr.defaults).join("`, `")}\``.replaceAll("$prefix", set.get("prefix"));
        message.replyEmbed(m);
        return;
      }
      const description = this.settingsMgr.descriptions[setting];
      let m = "## Settings: " + setting + "\n\n";
      m += description + "\n\n";
      m += "Current value: `" + set.get(setting) + "`";
      message.replyEmbed(m);
      break;
    }
  }
}
