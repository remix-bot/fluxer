/**
 * @module commands/settings
 * @description Server settings management with subcommands (get/set/reset/help) and shortcut aliases (prefix, 247).
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor, cleanId, getMessageGuildId } from "../src/MessageHandler.mjs";
import { logger } from "../src/constants/Logger.mjs";
import runnables from "../settings/runnables.mjs";

/**
 * Command alias to setting key mapping.
 * @type {Object.<string, string>}
 */
const SHORTCUTS = {
  prefix: "prefix",
  pfx:    "prefix",
  "247":  "stay_247",
};

/** @private @type {Set<string>} Strings that evaluate to boolean true. */
const BOOL_TRUE  = new Set(["true",  "1", "yes", "on",  "enable", "enabled"]);
/** @private @type {Set<string>} Strings that evaluate to boolean false. */
const BOOL_FALSE = new Set(["false", "0", "no",  "off", "disable", "disabled"]);
/** @private @type {Set<string>} Setting keys that use boolean display formatting. */
const BOOL_SETTINGS = new Set(["songAnnouncements"]);

/** @private @type {Set<string>} Available locale codes, populated at load time. */
let VALID_LOCALES = new Set(["en"]);

/** @private @type {number} Minimum allowed volume value. */
const VOLUME_MIN = 1;
/** @private @type {number} Maximum allowed volume value. */
const VOLUME_MAX = 200;
/** @private @type {number} Maximum prefix length in characters. */
const PREFIX_MAX = 5;
/** @private @type {number} Maximum number of 24/7 channels per guild. */
const MAX_247_CHANNELS = 1;

/**
 * Check whether a string looks like a valid Fluxer ID (Snowflake-like).
 * @param {string} id - The ID to validate.
 * @returns {boolean} True if the ID is 15-22 characters after cleaning.
 */
function isValidFluxerId(id) {
  const cleaned = cleanId(id);
  return cleaned.length >= 15 && cleaned.length <= 22;
}

/**
 * Parse a string into a boolean, or return null if unrecognised.
 * @param {string} str - The string to parse.
 * @returns {boolean|null} True, false, or null if not a boolean string.
 */
function parseBool(str) {
  const s = String(str).toLowerCase().trim();
  if (BOOL_TRUE.has(s))  return true;
  if (BOOL_FALSE.has(s)) return false;
  return null;
}

/**
 * Format a setting value for display in embed messages.
 * @param {string} key - The setting key.
 * @param {*} value - The setting value.
 * @returns {string} Formatted display string.
 */
function displayValue(key, value) {
  if (BOOL_SETTINGS.has(key)) return value ? "\u2705 enabled" : "\u274c disabled";
  if (value === null || value === undefined || value === "none") return "none";
  return "`" + value + "`";
}

/**
 * @private
 * Get the display name of the guild from a message object.
 * @param {object} message - The command message wrapper.
 * @returns {string} The guild name, or a fallback string.
 */
function getGuildName(message) {
  return message.message?.guild?.name ?? message.channel?.guild?.name ?? "this server";
}

/**
 * @private
 * Create a simple embed payload with global color, description, and optional title/footer.
 * @param {string} desc - The embed description text.
 * @param {object} [opts={}] - Optional overrides for title, iconURL, and footer.
 * @returns {object} Embed payload for message.reply().
 */
function embed(desc, opts = {}) {
  const b = new EmbedBuilder().setColor(getGlobalColor()).setDescription(desc);
  if (opts.title) b.setTitle(opts.title);
  if (opts.iconURL) b.setAuthor({ name: opts.title || "\u200b", iconURL: opts.iconURL });
  if (opts.footer) b.setFooter({ text: opts.footer });
  return { embeds: [b] };
}

/**
 * Parse the stay_247 setting into a Set of validated channel IDs.
 * @param {ServerSettings} set - The guild settings instance.
 * @returns {Set<string>} Set of cleaned, valid channel IDs.
 */
function get247Channels(set) {
  const raw = set.get("stay_247");
  if (!raw || raw === "none") return new Set();
  if (typeof raw === "string") {
    const id = cleanId(raw);
    return (id && isValidFluxerId(id)) ? new Set([id]) : new Set();
  }
  if (Array.isArray(raw)) {
    return new Set(raw.map(id => cleanId(id)).filter(id => id && isValidFluxerId(id)));
  }
  return new Set();
}

/**
 * Save a Set of channel IDs back to the stay_247 setting.
 * Writes 'none' if the set is empty.
 * @param {ServerSettings} set - The guild settings instance.
 * @param {Set<string>} channels - The channel IDs to save.
 */
function save247Channels(set, channels) {
  const arr = [...channels].filter(id => id && isValidFluxerId(id));
  set.set("stay_247", arr.length > 0 ? arr : "none");
}

/**
 * @private
 * Resolve a channel ID to a human-readable channel name from the client cache.
 * @param {import('@fluxerjs/core').Client} client - The Discord/Fluxer client.
 * @param {string} channelId - The channel ID to look up.
 * @returns {string|null} The channel name, or null if not found.
 */
function resolveChannelName(client, channelId) {
  try {
    const ch = client?.channels?.get?.(channelId);
    if (ch?.name) return ch.name;
  } catch (_) {}
  return null;
}

/**
 * @private
 * Create a translation function bound to the given context and guild.
 * @param {object} ctx - The bot (Remix) context.
 * @param {string} guildId - The guild ID for localization.
 * @returns {Function} A translation function with signature (key, data?) => string.
 */
function tWrap(ctx, guildId) {
  const tFn = ctx.locale?.translate?.bind(ctx.locale);
  return (key, data = {}) => tFn ? tFn(guildId, key, data) : key;
}

/**
 * @private
 * Get a human-readable label for a setting key, using locale translations when available.
 * @param {string} key - The setting key.
 * @param {Function|null} t - Translation function (guildId, key, data) => string.
 * @param {string} guildId - The guild ID for localization.
 * @returns {string} The pretty-printed setting label.
 */
function prettifySettingLabel(key, t, guildId) {
  const localeMap = {
    songAnnouncements: "responses.settings.labelSongAnnouncements",
    prefix: "responses.settings.labelPrefix",
    pfx: "responses.settings.labelPfp",
    locale: "responses.settings.labelLocale",
    stay_247: "responses.settings.label247",
    volume: "responses.settings.labelVolume",
  };
  if (localeMap[key] && t && guildId) return t(guildId, localeMap[key]);
  const fallback = {
    songAnnouncements: "Song announcements",
    prefix: "Prefix",
    pfp: "Bot avatar style",
    locale: "Locale",
    stay_247: "24/7 mode",
    volume: "Default volume",
  };
  return fallback[key] ?? key.replace(/_/g, " ");
}

/**
 * Build an embed payload showing the current 24/7 status for the guild.
 * @param {ServerSettings} set - The guild settings instance.
 * @param {object} ctx - The bot (Remix) context.
 * @param {string} guildId - The guild ID.
 * @param {string|null} channelId - The channel ID (for active indicator), or null.
 * @returns {object} Embed payload object for message.reply().
 */
function build247Panel(set, ctx, guildId, channelId) {
  const channels = [...get247Channels(set)];
  const prefix = ctx.handler.getPrefix(guildId);

  if (channels.length > 0) {
    const lines = channels.map(id => {
      const name = resolveChannelName(ctx.client, id);
      const isActive = id === channelId;
      return (isActive ? "\u25b6 " : "\u2022 ") + (name ? "**" + name + "** " : "") + "<#" + id + ">";
    });
    return embed(
      channels.length === 1 && channelId
        ? "\u2705 24/7 is now **enabled** in <#" + channelId + ">\n\n" +
          "The bot will stay connected and auto-rejoin if disconnected."
        : "\u2705 24/7 active in " + channels.length + " channel(s):\n\n" + lines.join("\n"),
      { title: "\u2705 24/7 Mode" }
    );
  }

  return embed(
    "\u274c 24/7 is **disabled**\n\n" +
    "The bot will leave voice channels when idle.\n\n" +
    "Join a voice channel and use `" + prefix + "247` to enable.",
    { title: "\u274c 24/7 Mode" }
  );
}

/**
 * Disable 24/7 mode for a specific channel.
 * Removes the channel from stay_247, marks intentional leave, and destroys the player.
 * @param {object} ctx - The bot (Remix) context.
 * @param {ServerSettings} set - The guild settings instance.
 * @param {string} guildId - The guild ID.
 * @param {string} channelId - The channel ID to disable.
 * @returns {Promise<void>}
 */
async function disable247(ctx, set, guildId, channelId) {
  const id = cleanId(channelId);
  const channels = get247Channels(set);
  channels.delete(id);
  save247Channels(set, channels);
  ctx.markIntentionalLeave?.(id);
  const player = ctx.players.playerMap.get(id)
      ?? [...ctx.players.playerMap.values()].find(p =>
        cleanId(p?._channelId ?? "") === id &&
        cleanId(p?._guildId ?? "") === cleanId(guildId)
      );
  if (player) {
    const activeId = cleanId(player._channelId ?? id);
    ctx.players.playerMap.delete(activeId);
    if (activeId !== id) ctx.players.playerMap.delete(id);
    await player.leave().catch(() => {});
    player.destroy();
  }
}

/**
 * Enable 24/7 mode for a specific channel.
 * Enforces MAX_247_CHANNELS (1) by disabling any existing 24/7 channel first,
 * then saves the new channel and spawns a player if none exists.
 * @param {object} ctx - The bot (Remix) context.
 * @param {ServerSettings} set - The guild settings instance.
 * @param {string} guildId - The guild ID.
 * @param {string} channelId - The channel ID to enable.
 * @returns {Promise<void>}
 */
async function enable247(ctx, set, guildId, channelId) {
  const id = cleanId(channelId);
  const channels = get247Channels(set);
  if (channels.has(id)) return;

  // Platform only supports 1 voice channel per bot per guild.
  // If another channel already has 24/7, disable it first.
  if (channels.size >= MAX_247_CHANNELS) {
    for (const oldId of channels) {
      if (oldId !== id) {
        ctx.markIntentionalLeave?.(oldId);
        const oldPlayer = ctx.players.playerMap.get(oldId)
            ?? [...ctx.players.playerMap.values()].find(p =>
              cleanId(p?._channelId ?? "") === oldId &&
              cleanId(p?._guildId ?? "") === cleanId(guildId)
            );
        if (oldPlayer) {
          const activeId = cleanId(oldPlayer._channelId ?? oldId);
          ctx.players.playerMap.delete(activeId);
          if (activeId !== oldId) ctx.players.playerMap.delete(oldId);
          await oldPlayer.leave().catch(() => {});
          oldPlayer.destroy();
        }
        channels.delete(oldId);
      }
    }
  }

  channels.add(id);
  save247Channels(set, channels);
  const playerExists = ctx.players.playerMap.has(id) ||
      [...ctx.players.playerMap.values()].some(p =>
        cleanId(p?._channelId ?? "") === id && cleanId(p?._guildId ?? "") === cleanId(guildId)
      );
  if (!playerExists) {
    try { await ctx._spawnPlayer(guildId, id); } catch (_) {}
  }
}

/**
 * Handle the !247 toggle command. If the user is in a 24/7 channel, disable it;
 * otherwise, enable it for the user's current voice channel.
 * @param {object} ctx - The bot (Remix) context.
 * @param {object} message - The command message.
 * @param {ServerSettings} set - The guild settings instance.
 * @param {string} guildId - The guild ID.
 * @returns {Promise<void>}
 */
async function handle247Toggle(ctx, message, set, guildId) {
  const loc = tWrap(ctx, guildId);
  if (!guildId) return message.reply(embed(loc("responses.settings.noServer")));

  const { channelId: userChannelId } = await ctx.players.checkVoiceChannels(message);
  if (!userChannelId) {
    return message.reply(build247Panel(set, ctx, guildId, null));
  }

  const id = cleanId(userChannelId);
  const channels = get247Channels(set);

  if (channels.has(id)) {
    await disable247(ctx, set, guildId, userChannelId);
    return message.reply(build247Panel(set, ctx, guildId, id));
  }

  const result = await enable247(ctx, set, guildId, userChannelId);
  if (result?.max) {
    return message.reply(embed(
      loc("responses.settings.max247Channels", { max: MAX_247_CHANNELS, prefix: ctx.handler.getPrefix(guildId) })
    ));
  }

  return message.reply(build247Panel(set, ctx, guildId, id));
}

/**
 * Apply a new value to a setting, with type-specific validation.
 * @param {object} ctx - The bot (Remix) context.
 * @param {object} message - The command message.
 * @param {ServerSettings} set - The guild settings instance.
 * @param {string} key - The setting key.
 * @param {string} rawValue - The raw string value from the command.
 * @returns {Promise<string|null>} Error message string, or null on success.
 */
async function applySet(ctx, message, set, key, rawValue) {
  if (BOOL_SETTINGS.has(key)) {
    const bool = parseBool(rawValue);
    if (bool === null) {
      return ctx.t(message, "responses.settings.mustBeBool", { setting: key });
    }
    set.set(key, bool);
    return null;
  }

  if (key === "volume") {
    const num = parseInt(rawValue, 10);
    if (isNaN(num) || num < VOLUME_MIN || num > VOLUME_MAX) {
      return ctx.t(message, "responses.settings.volumeRange");
    }
    set.set(key, num);
    return null;
  }

  if (key === "locale") {
    if (!VALID_LOCALES.has(rawValue)) {
      return ctx.t(message, "responses.settings.invalidLocale", {
          locale: rawValue,
          locales: [...VALID_LOCALES].map(l => "`" + l + "`").join(", ")
      });
    }
    set.set(key, rawValue);
    const gid = getMessageGuildId(message);
    if (gid) ctx.locale.invalidateCache(gid);
    return null;
  }

  if (key === "prefix") {
    if (!rawValue || rawValue.length > PREFIX_MAX) {
      return ctx.t(message, "responses.settings.prefixLength");
    }
    if (/\s/.test(rawValue)) {
      return ctx.t(message, "responses.settings.prefixSpaces");
    }
  }

  if (runnables[key]) {
    const err = runnables[key].call(ctx, rawValue, { msg: message });
    if (err) return "\u274c " + err;
  }

  set.set(key, rawValue);
  return null;
}

/**
 * @private
 * @async
 * Handle a settings shortcut command (e.g. `prefix`, `247`).
 * Dispatches to 24/7 toggle, value display, or value set depending on arguments.
 * @param {object} ctx - The bot (Remix) context.
 * @param {object} message - The command message.
 * @param {string} settingKey - The resolved setting key.
 * @param {string[]} valueTokens - Remaining argument tokens after the shortcut alias.
 * @returns {Promise<void>}
 */
async function handleShortcut(ctx, message, settingKey, valueTokens) {
  const set     = ctx.getSettings(message);
  const guildId = getMessageGuildId(message);
  const t247    = ctx.locale?.translate?.bind(ctx.locale);

  if (valueTokens.length === 0) {
    if (settingKey === "stay_247") {
      return handle247Toggle(ctx, message, set, guildId);
    }
    const val   = set.get(settingKey);
    const label = prettifySettingLabel(settingKey, t247, guildId);
    return message.reply(embed("**" + label + "**\nValue: " + displayValue(settingKey, val)));
  }

  const rawValue = valueTokens.join(" ");

  if (settingKey === "stay_247") {
    const mode = rawValue.toLowerCase().trim();
    if (mode === "off" || mode === "false" || mode === "disable" || mode === "0") {
      const loc = tWrap(ctx, guildId);
      if (!guildId) return message.reply(embed(loc("responses.settings.noServer")));
      const { channelId } = await ctx.players.checkVoiceChannels(message);
      if (channelId) {
        await disable247(ctx, set, guildId, channelId);
        return message.reply(build247Panel(set, ctx, guildId, cleanId(channelId)));
      }
      for (const [chId, player] of [...ctx.players.playerMap.entries()]) {
        if (cleanId(player?._guildId ?? "") === cleanId(guildId)) {
          const activeId = cleanId(player._channelId ?? chId);
          ctx.markIntentionalLeave?.(activeId);
          ctx.players.playerMap.delete(activeId);
          if (activeId !== chId) ctx.players.playerMap.delete(chId);
          await player.leave().catch(() => {});
          player.destroy();
        }
      }
      save247Channels(set, new Set());
      return message.reply(build247Panel(set, ctx, guildId, null));
    }
    return handle247Toggle(ctx, message, set, guildId);
  }

  const err = await applySet(ctx, message, set, settingKey, rawValue);
  if (err) return message.reply(embed(err));

  const val   = set.get(settingKey);
  const label = prettifySettingLabel(settingKey, t247, guildId);
  return message.reply(embed(ctx.t(message, "responses.settings.setSuccess", { label, value: displayValue(settingKey, val) })));
}

/**
 * @type {Function}
 * @description Factory that builds the settings CommandBuilder and registers shortcut commands.
 * Called at load time with `this` bound to the bot instance.
 * @returns {CommandBuilder} The main settings command builder.
 */
export const command = function() {
  if (this.locale) {
    VALID_LOCALES = this.locale.availableLocales();
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
