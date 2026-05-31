import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";
import runnables from "../settings/runnables.mjs";

function embed(desc, opts = {}) {
  const b = new EmbedBuilder().setColor(getGlobalColor()).setDescription(desc);
  if (opts.title) b.setTitle(opts.title);
  if (opts.iconURL) b.setAuthor({ name: opts.title || "\u200b", iconURL: opts.iconURL });
  return { embeds: [b] };
}

/** Build a rich embed with fields for the 24/7 status panel.
 *  Instead, we build the base embed with EmbedBuilder, call .toJSON()
 *  to get the raw object, then attach a `fields` array directly.
 */
function richEmbed(fields, opts = {}) {
  const b = new EmbedBuilder().setColor(getGlobalColor());
  if (opts.title) b.setTitle(opts.title);
  if (opts.description) b.setDescription(opts.description);
  if (opts.footer) b.setFooter({ text: opts.footer });
  if (opts.iconURL) b.setAuthor({ name: opts.title || "\u200b", iconURL: opts.iconURL });
  const raw = b.toJSON();
  raw.fields = fields.map(f => ({
    name: f.name,
    value: f.value,
    inline: f.inline ?? false,
  }));
  return { embeds: [raw] };
}

const SHORTCUTS = {
  prefix: "prefix",
  pfx:    "prefix",
  "247":  "stay_247",
};

/** Aliases accepted for boolean settings */
const BOOL_TRUE  = new Set(["true",  "1", "yes", "on",  "enable",  "enabled"]);
const BOOL_FALSE = new Set(["false", "0", "no",  "off", "disable", "disabled"]);

/** Settings whose values should be displayed as booleans */
const BOOL_SETTINGS = new Set(["songAnnouncements"]);

/** Valid locale codes — populated from Locale instance at runtime */
let VALID_LOCALES = new Set(["en"]);

/** Volume constraints */
const VOLUME_MIN = 1;
const VOLUME_MAX = 200;
const MAX_247_CHANNELS = 10;

/** Extract clean numeric channel ID from any format */
function cleanId(raw) {
  return String(raw).replace(/\D/g, "");
}

/**
 * Validate that a value looks like a real Fluxer ID.
 * Fluxer IDs are large numeric snowflakes (typically 17-20 digits).
 * We accept >= 15 digits to be safe, but reject anything shorter
 * (which would be garbage like "3", "42", "move", etc.).
 */
function isValidFluxerId(id) {
  const cleaned = String(id).replace(/\D/g, "");
  return cleaned.length >= 15 && cleaned.length <= 22;
}

/** Parse "true/false" and their aliases → boolean | null */
function parseBool(str) {
  const s = String(str).toLowerCase().trim();
  if (BOOL_TRUE.has(s))  return true;
  if (BOOL_FALSE.has(s)) return false;
  return null;
}

/** Format a setting value for display */
function displayValue(key, value) {
  if (BOOL_SETTINGS.has(key)) return value ? "✅ enabled" : "❌ disabled";
  if (value === null || value === undefined || value === "none") return "none";
  return `\`${value}\``;
}

/** Resolve guild ID from a message context */
function getGuildId(message) {
  return message.message?.guildId
    ?? message.message?.guild?.id
    ?? message.channel?.guildId
    ?? message.channel?.guild?.id
    ?? message.channel?.server_id
    ?? message.channel?.serverId
    ?? null;
}

/** Resolve guild name from a message context */
function getGuildName(message) {
  return message.message?.guild?.name ?? message.channel?.guild?.name ?? "this server";
}

/**
 * Get the 24/7 mode for a specific channel.
 * Reads from the per-channel map (stay_247_modes) first,
 * falls back to the guild-wide stay_247_mode for backward compat.
 *
 * @param {ServerSettings} set
 * @param {string} channelId  Clean channel ID
 * @returns {string} "on" | "auto" | "off"
 */
function get247ChannelMode(set, channelId) {
  const modes = set.get("stay_247_modes");
  if (modes && typeof modes === "object" && !Array.isArray(modes)) {
    const perChannel = modes[channelId];
    if (perChannel === "on" || perChannel === "auto" || perChannel === "off") return perChannel;
  }
  const guildMode = set.get("stay_247_mode") ?? "off";
  return guildMode;
}

/**
 * Set the 24/7 mode for a specific channel.
 *
 * @param {ServerSettings} set
 * @param {string} channelId  Clean channel ID
 * @param {string} mode      "on" | "auto" | "off"
 */
function set247ChannelMode(set, channelId, mode) {
  let modes = set.get("stay_247_modes");
  if (!modes || typeof modes !== "object" || Array.isArray(modes)) modes = {};
  modes[channelId] = mode;
  set.set("stay_247_modes", modes);
  set.set("stay_247_mode", mode);
}

/**
 * Remove a channel from the per-channel modes map.
 * If no channels remain, clears stay_247_modes entirely.
 *
 * @param {ServerSettings} set
 * @param {string} channelId  Clean channel ID
 * @param {Set} currentChannels  Current set of all 247 channels for this guild
 */
function remove247ChannelMode(set, channelId, currentChannels) {
  let modes = set.get("stay_247_modes");
  if (!modes || typeof modes !== "object" || Array.isArray(modes)) return;
  delete modes[channelId];
  set.set("stay_247_modes", modes);
  if (!currentChannels || currentChannels.size === 0) {
    set.set("stay_247_mode", "off");
  } else {
    const firstChannel = [...currentChannels][0];
    set.set("stay_247_mode", modes[firstChannel] ?? "auto");
  }
}

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

function save247Channels(set, channels) {
  const arr = [...channels].filter(id => id && isValidFluxerId(id));
  set.set("stay_247", arr.length > 0 ? arr : "none");
}

function modeLabel(mode, t, guildId) {
  if (t && guildId) {
    if (mode === "auto") return t(guildId, "responses.settings.247Panel.modeAuto");
    if (mode === "on")   return t(guildId, "responses.settings.247Panel.modeOn");
    return t(guildId, "responses.settings.247Panel.modeOff");
  }
  return mode === "auto" ? "🔄 Auto" : mode === "on" ? "✅ On" : "❌ Off";
}

function modeEmoji(mode) {
  return mode === "auto" ? "🔄" : mode === "on" ? "✅" : "❌";
}

function modeColor(mode) {
  return mode === "auto" ? 0xF59E0B : mode === "on" ? 0x10B981 : 0xEF4444;
}

/** Resolve a channel name from cache, falling back to mention */
function resolveChannelName(client, channelId) {
  try {
    const ch = client?.channels?.get?.(channelId);
    if (ch?.name) return ch.name;
  } catch (_) {}
  return null;
}

/**
 * Build a simple 24/7 status panel.
 * Shows each saved channel with its mode — clean and minimal.
 * @param {object} set - ServerSettings
 * @param {object} ctx - Bot context (Remix instance)
 * @param {object} message - Message object
 * @param {Function} [t] - Locale translate function (guildId, key, data)
 * @param {string} [guildId] - Guild ID for locale
 */
function build247StatusPanel(set, ctx, message, t, guildId) {
  const channels = [...get247Channels(set)];
  const prefix = ctx.handler.getPrefix(guildId);
  const locale = (key, data = {}) => t ? t(guildId, key, { ...data, prefix }) : key;

  if (channels.length === 0) {
    return richEmbed([
      {
        name: locale("responses.settings.247Panel.gettingStarted"),
        value: locale("responses.settings.247Panel.gettingStartedValue"),
        inline: false,
      },
    ], {
      title: locale("responses.settings.247Panel.title"),
      description: locale("responses.settings.247Panel.noChannelsSaved"),
      footer: locale("responses.settings.247Panel.footer"),
    });
  }

  const lines = channels.map(chId => {
    const mode = get247ChannelMode(set, chId);
    const chName = resolveChannelName(ctx.client, chId);
    const label = chName ? `${chName}` : ``;
    return `${modeEmoji(mode)} ${label} <#${chId}> — ${modeLabel(mode, t, guildId)}`;
  });

  const onCount   = channels.filter(id => get247ChannelMode(set, id) === "on").length;
  const autoCount = channels.filter(id => get247ChannelMode(set, id) === "auto").length;
  const summaryParts = [];
  if (onCount > 0) summaryParts.push(locale("responses.settings.247Panel.summaryOn", { count: onCount }));
  if (autoCount > 0) summaryParts.push(locale("responses.settings.247Panel.summaryAuto", { count: autoCount }));

  const channelsKey = channels.length === 1
      ? "responses.settings.247Panel.channelsSaved_one"
      : "responses.settings.247Panel.channelsSaved_other";

  return richEmbed([{
    name: locale(channelsKey, { count: channels.length }),
    value: lines.join("\n"),
    inline: false,
  }], {
    title: locale("responses.settings.247Panel.title"),
    description: summaryParts.join(" · "),
    footer: locale("responses.settings.247Panel.footer"),
  });
}

/**
 * Build a simple embed for the $prefix247 on/auto confirmation.
 * @param {object} set - ServerSettings
 * @param {string} channelId - Clean channel ID
 * @param {string} mode - "on" | "auto"
 * @param {boolean} joined - Whether the bot joined
 * @param {object} ctx - Bot context
 * @param {string} guildId - Guild ID
 * @param {Function} [t] - Locale translate function
 */
function build247EnabledPanel(set, channelId, mode, joined, ctx, guildId, t) {
  const channels = [...get247Channels(set)];
  const modeStr = modeLabel(mode, t, guildId);
  const prefix = ctx.handler.getPrefix(guildId);
  const locale = (key, data = {}) => t ? t(guildId, key, { ...data, prefix }) : key;
  const chName = resolveChannelName(ctx.client, channelId);
  const label = chName ? `**${chName}** <#${channelId}>` : `<#${channelId}>`;

  const lines = channels.map(id => {
    const m = get247ChannelMode(set, id);
    const n = resolveChannelName(ctx.client, id);
    const l = n ? `${n}` : `<#${id}>`;
    const marker = id === channelId ? locale("responses.settings.247Panel.currentMarker") : "";
    return `${modeEmoji(m)} ${l} <#${id}> — ${modeLabel(m, t, guildId)}${marker}`;
  });

  const channelsKey = channels.length === 1
      ? "responses.settings.247Panel.channelsSaved_one"
      : "responses.settings.247Panel.channelsSaved_other";
  const summary = locale(channelsKey, { count: channels.length });

  const b = new EmbedBuilder();
  b.setColor(modeColor(mode));
  b.setTitle(locale("responses.settings.247Panel.enabledTitle", { mode: modeStr }));
  b.setDescription(locale("responses.settings.247Panel.enabledDescription", { channel: label, mode: modeStr, summary }));
  b.setFooter({ text: locale("responses.settings.247Panel.enabledFooter") });
  const raw = b.toJSON();
  raw.fields = [{
    name: locale("responses.settings.247Panel.savedChannels"),
    value: lines.join("\n"),
    inline: false,
  }];
  return { embeds: [raw] };
}

/**
 * Build a simple embed for the $prefix247 off confirmation.
 * @param {object} set - ServerSettings
 * @param {string} channelId - Clean channel ID
 * @param {string} guildId - Guild ID
 * @param {Function} [t] - Locale translate function
 */
function build247DisabledPanel(set, channelId, guildId, t, ctx) {
  const channels = [...get247Channels(set)];
  const prefix = ctx.handler.getPrefix(guildId);
  const locale = (key, data = {}) => t ? t(guildId, key, { ...data, prefix }) : key;

  if (channels.length === 0) {
    return richEmbed([{
      name: locale("responses.settings.247Panel.noChannelsSavedField"),
      value: locale("responses.settings.247Panel.allChannelsRemoved"),
      inline: false,
    }], {
      title: locale("responses.settings.247Panel.disabledTitle"),
      footer: locale("responses.settings.247Panel.reenableFooter"),
    });
  }

  const lines = channels.map(id => {
    const m = get247ChannelMode(set, id);
    const l = `<#${id}>`;
    return `${modeEmoji(m)} ${l} — ${modeLabel(m, t, guildId)}`;
  });

  const channelsKey = channels.length === 1
      ? "responses.settings.247Panel.channelsRemaining_one"
      : "responses.settings.247Panel.channelsRemaining_other";

  return richEmbed([{
    name: locale(channelsKey, { count: channels.length }),
    value: lines.join("\n"),
    inline: false,
  }], {
    title: locale("responses.settings.247Panel.disabledTitle"),
    description: locale("responses.settings.247Panel.channelRemoved", { channel: channelId }),
    footer: locale("responses.settings.247Panel.reenableFooter"),
  });
}

function format247Status(set, t, guildId) {
  const channels = get247Channels(set);
  if (channels.size === 0) return t ? t(guildId, "responses.settings.247Panel.modeOff") : "❌ Disabled";
  if (channels.size === 1) {
    const chId = [...channels][0];
    const mode = get247ChannelMode(set, chId);
    return `${modeLabel(mode, t, guildId)} — <#${chId}>`;
  }
  const parts = [...channels].map(id => {
    const mode = get247ChannelMode(set, id);
    return `<#${id}> (${modeLabel(mode, t, guildId)})`;
  });
  return `${channels.size} channels: ${parts.join(", ")}`;
}

function format247Summary(set, t, guildId, ctx) {
  const channels = [...get247Channels(set)];
  const prefix = ctx.handler.getPrefix(guildId);
  const locale = (key, data = {}) => t ? t(guildId, key, { ...data, prefix }) : key;

  if (channels.length === 0) {
    return [
      `**24/7 Mode**`,
      `Status: ${locale("responses.settings.247Panel.modeOff")}`,
      "Saved channels: none"
    ].join("\n");
  }

  const lines = ["**24/7 Mode**"];
  for (const id of channels) {
    const mode = get247ChannelMode(set, id);
    lines.push(`• <#${id}> — ${modeLabel(mode, t, guildId)}`);
  }
  return lines.join("\n");
}

function prettifySettingLabel(key, t, guildId) {
  const localeMap = {
    songAnnouncements: "responses.settings.labelSongAnnouncements",
    prefix: "responses.settings.labelPrefix",
    pfx: "responses.settings.labelPfp",
    locale: "responses.settings.labelLocale",
    stay_247: "responses.settings.label247",
    volume: "responses.settings.labelVolume",
    announcementChannelId: "responses.settings.labelAnnouncementChannel",
    restrictVolume: "responses.settings.labelRestrictVolume",
    autojoin_channel: "responses.settings.labelAutojoinChannel"
  };
  if (localeMap[key] && t && guildId) return t(guildId, localeMap[key]);
  const fallback = {
    songAnnouncements: "Song announcements",
    prefix: "Prefix",
    pfx: "Bot avatar style",
    locale: "Locale",
    stay_247: "24/7 mode",
    volume: "Default volume",
    announcementChannelId: "Announcement channel",
    restrictVolume: "Restrict volume",
    autojoin_channel: "Autojoin channel"
  };
  return fallback[key] ?? key.replace(/_/g, " ");
}

async function handle247(ctx, message, value) {
  const set     = ctx.getSettings(message);
  const guildId = getGuildId(message);
  const mode    = value.toLowerCase().trim();

  const resolved = mode === "true" ? "auto" : mode === "false" ? "off" : mode;

  if (!["off", "on", "auto"].includes(resolved)) {
    return message.reply(embed(
        ctx.t(message, "responses.settings.invalid247", { value, prefix: ctx.handler.getPrefix(guildId) })
    ));
  }

  if (resolved === "off") {
    if (!guildId) return message.reply(embed(ctx.t(message, "responses.settings.noServer")));

    const channelId = ctx.players.checkVoiceChannels(message);
    const channels  = get247Channels(set);

    if (channelId) {
      const id = cleanId(channelId);
      channels.delete(id);
      save247Channels(set, channels);
      remove247ChannelMode(set, id, channels);
      ctx.markIntentionalLeave?.(id);
      const player = ctx.players.playerMap.get(id)
          ?? [...ctx.players.playerMap.values()].find(p =>
            cleanId(p?._channelId ?? "") === id &&
            cleanId(p?._guildId ?? "") === cleanId(guildId)
          );
      if (player) {
        const activeChannelId = cleanId(player._channelId ?? id);
        ctx.players.playerMap.delete(activeChannelId);
        if (activeChannelId !== id) ctx.players.playerMap.delete(id);
        await player.leave().catch(() => {});
        player.destroy();
      }
      const t247 = ctx.locale?.translate?.bind(ctx.locale);
    return message.reply(build247DisabledPanel(set, id, guildId, t247, ctx));
    }

    save247Channels(set, new Set());
    set.set("stay_247_mode", "off");
    set.set("stay_247_modes", {});
    for (const [chId, player] of [...ctx.players.playerMap.entries()]) {
      if (cleanId(player?._guildId ?? "") === cleanId(guildId)) {
        const activeChannelId = cleanId(player._channelId ?? chId);
        ctx.markIntentionalLeave?.(activeChannelId);
        ctx.players.playerMap.delete(activeChannelId);
        if (activeChannelId !== chId) ctx.players.playerMap.delete(chId);
        await player.leave().catch(() => {});
        player.destroy();
      }
    }
    const prefix = ctx.handler.getPrefix(guildId);
    const t247 = ctx.locale?.translate?.bind(ctx.locale);
    const loc = (key, data = {}) => t247 ? t247(guildId, key, { ...data, prefix }) : key;
    return message.reply(richEmbed([{
      name: loc("responses.settings.247Panel.allChannelsLabel"),
      value: loc("responses.settings.247Panel.allChannelsDisabled"),
      inline: false,
    }], {
      title: loc("responses.settings.247Panel.disabledTitle"),
      description: loc("responses.settings.247Panel.noChannelsSavedShort"),
      footer: loc("responses.settings.247Panel.reenableFooter"),
    }));
  }

  if (!guildId) return message.reply(embed(ctx.t(message, "responses.settings.noServer")));

  const userChannelId = ctx.players.checkVoiceChannels(message);
  if (!userChannelId) {
    return message.reply(embed(
        ctx.t(message, "responses.settings.noVoice247", { mode: resolved, prefix: ctx.handler.getPrefix(guildId) })
    ));
  }

  const id       = cleanId(userChannelId);
  const channels = get247Channels(set);
  if (!channels.has(id) && channels.size >= MAX_247_CHANNELS) {
    return message.reply(embed(
        ctx.t(message, "responses.settings.max247Channels", { max: MAX_247_CHANNELS, prefix: ctx.handler.getPrefix(guildId) })
    ));
  }
  channels.add(id);
  set247ChannelMode(set, id, resolved);

  save247Channels(set, channels);

  const playerExists = ctx.players.playerMap.has(id) ||
      [...ctx.players.playerMap.values()].some(p =>
        cleanId(p?._channelId ?? "") === id && cleanId(p?._guildId ?? "") === cleanId(guildId)
      );

  if (playerExists) {
    const t247 = ctx.locale?.translate?.bind(ctx.locale);
    return message.reply(build247EnabledPanel(set, id, resolved, false, ctx, guildId, t247));
  }

  try {
    await ctx._spawnPlayer(guildId, id);
    const t247 = ctx.locale?.translate?.bind(ctx.locale);
    return message.reply(build247EnabledPanel(set, id, resolved, true, ctx, guildId, t247));
  } catch (e) {
    const prefix = ctx.handler.getPrefix(guildId);
    const t247 = ctx.locale?.translate?.bind(ctx.locale);
    const loc = (key, data = {}) => t247 ? t247(guildId, key, { ...data, prefix }) : key;
    return message.reply(embed(
        loc("responses.settings.247Panel.joinFailed", { mode: modeLabel(resolved, t247, guildId), channel: id, error: e.message })
    ));
  }
}

/**
 * Validate and save a setting value.
 * @returns {string|null} Error message string, or null on success.
 *   For stay_247, replies directly and always returns null.
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

  if (key === "stay_247") {
    await handle247(ctx, message, rawValue);
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
          locales: [...VALID_LOCALES].map(l => `\`${l}\``).join(", ")
      });
    }
    set.set(key, rawValue);
    const guildId = getGuildId(message);
    if (guildId) ctx.locale.invalidateCache(guildId);
    return null;
  }

  if (key === "prefix") {
    if (!rawValue || rawValue.length > 5) {
      return ctx.t(message, "responses.settings.prefixLength");
    }
    if (/\s/.test(rawValue)) {
      return ctx.t(message, "responses.settings.prefixSpaces");
    }
  }

  if (runnables[key]) {
    const err = runnables[key].call(ctx, rawValue, { msg: message });
    if (err) return `❌ ${err}`;
  }

  set.set(key, rawValue);
  return null;
}

async function handleShortcut(ctx, message, settingKey, valueTokens) {
  const set = ctx.getSettings(message);

  if (valueTokens.length === 0) {
    if (settingKey === "stay_247") {
      const t247 = ctx.locale?.translate?.bind(ctx.locale);
      return message.reply(build247StatusPanel(set, ctx, message, t247, getGuildId(message)));
    }
    const val = set.get(settingKey);
    return message.reply(embed(`\`${settingKey}\` → ${displayValue(settingKey, val)}`));
  }

  const rawValue = valueTokens.join(" ");
  const err = await applySet(ctx, message, set, settingKey, rawValue);
  if (err) return message.reply(embed(err));

  if (settingKey !== "stay_247") {
    const val = set.get(settingKey);
    return message.reply(embed(ctx.t(message, "responses.settings.setSuccess", { label: settingKey, value: displayValue(settingKey, val) })));
  }
}

export const command = function() {
  if (this.locale) {
    VALID_LOCALES = this.locale.availableLocales();
  }

  if (this.loader) {
    for (const [alias, settingKey] of Object.entries(SHORTCUTS)) {
      const builder = new CommandBuilder()
          .setName(alias)
          .setDescription(`Shortcut for \`${settingKey}\`. Usage: $prefix${alias} [value]`)
          .setId(`shortcut_${alias}`)
          .setCategory("util")
          .setRequirement(e => e.addPermission("ManageGuild"))
          .addTextOption(o =>
              o.setName("value")
                  .setDescription(`New value for ${settingKey}`)
                  .setRequired(false)
          );
      this.loader.commands.addCommand(builder);
      this.loader.runnables.set(builder.uid, run);
    }
  }

  const settingKeys = Object.keys(this.settingsMgr.defaults);

  return new CommandBuilder()
      .setName("settings")
      .setDescription("Change/Get settings in the current server.", "commands.settings")
      .addExamples(
          "$prefixsettings get",
          "$prefixsettings get prefix",
          "$prefixsettings set prefix !",
          "$prefixsettings set locale de-DE",
          "$prefixsettings set songAnnouncements off",
          "$prefixsettings set stay_247 auto",
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
              .setDescription("Show help for the settings system, or explain a specific setting.", "subcommands.settings.help")
              .setId("helpSettings")
              .addChoiceOption(c =>
                  c.addChoices(...settingKeys)
                      .setName("setting")
                      .setDescription("Omit to see all available settings.", "options.settings.help.setting")
                      .setRequired(false)
              )
      );
};

export async function run(message, data) {
  const set = this.getSettings(message);
  const cmd = data.commandId || "getSettings";
  const guildId = message.channel?.guildId ?? message.message?.guildId;

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
      const available = Object.keys(this.settingsMgr.defaults).join("`, `");
      return message.reply(embed(
          this.t(message, "responses.settings.unknownSetting", { setting: settingKey }) + "\n" + this.t(message, "responses.settings.availableSettings", { settings: available })
      ));
    }

    const err = await applySet(this, message, set, settingKey, rawValue);
    if (err) return message.reply(embed(err));

    if (settingKey === "stay_247") return;

    const newVal = set.get(settingKey);
    return message.reply(embed(this.t(message, "responses.settings.setSuccess", { label: prettifySettingLabel(settingKey), value: displayValue(settingKey, newVal) })));
  }

  if (cmd === "getSettings") {
    if (settingKey) {
      if (settingKey === "stay_247") {
        const t247 = this.locale?.translate?.bind(this.locale);
        return message.reply(build247StatusPanel(set, this, message, t247, getGuildId(message)));
      }
      const val = set.get(settingKey);
      const description = this.settingsMgr.descriptions?.[settingKey];
      const prefix = ctx.handler.getPrefix(guildId);
      const resolvedDesc = description ? description.replace(/\$prefix/gi, prefix) : null;
      let reply = `**${prettifySettingLabel(settingKey)}**\nValue: ${displayValue(settingKey, val)}`;
      if (resolvedDesc) reply += `\n\n*${resolvedDesc}*`;
      return message.reply(embed(reply));
    }

    const d         = set.getAll();
    const guildName = getGuildName(message);
    const rawGuild  = message.message?.guild;
    const iconUrl   = rawGuild?.icon
        ? `https://cdn.fluxer.app/icons/${rawGuild.id}/${rawGuild.icon}.webp`
        : null;

    const lines = Object.entries(d)
        .filter(([k]) => k !== "stay_247_mode")
        .map(([k]) => {
          if (k === "stay_247") {
            return `• **24/7 mode** — ${format247Status(set, this.locale?.translate?.bind(this.locale), getGuildId(message))}`;
          }
          return `• **${prettifySettingLabel(k)}** — ${displayValue(k, d[k])}`;
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
      const guildId = getGuildId(message);
      if (guildId) this.locale.invalidateCache(guildId);
    }
    const def = set.get(settingKey);
    return message.reply(embed(
        this.t(message, "responses.settings.resetSuccess", { setting: settingKey, value: displayValue(settingKey, def) })
    ));
  }

  if (cmd === "helpSettings") {
    const pfx = this.handler.getPrefix(guildId);

    if (!settingKey) {
      const keys    = Object.keys(this.settingsMgr.defaults);
      const keyList = keys.map(k => `\`${k}\``).join(", ");
      return message.reply(embed(
          this.t(message, "responses.settings.helpTitle") + "\n\n" +
          this.t(message, "responses.settings.helpAvailable", { settings: keyList }) + "\n\n" +
          this.t(message, "responses.settings.helpSubcommands", { prefix: pfx }) + "\n\n" +
          this.t(message, "responses.settings.helpShortcuts", { prefix: pfx }),
          { title: "⚙️ Settings Help" }
      ));
    }

    const rawDescription = this.settingsMgr.descriptions?.[settingKey] ?? this.t(message, "responses.settings.noDescription");
    const description = rawDescription.replace(/\$prefix/gi, pfx);
    const currentVal  = set.get(settingKey);
    const defaultVal  = this.settingsMgr.defaults?.[settingKey];

    let extra = "";
    if (settingKey === "locale") {
      extra = `\n**Valid values:** ${[...VALID_LOCALES].map(l => `\`${l}\``).join(", ")}`;
    } else if (settingKey === "volume") {
      extra = `\n**Valid range:** ${VOLUME_MIN}–${VOLUME_MAX}`;
    } else if (BOOL_SETTINGS.has(settingKey)) {
      extra = `\n**Valid values:** \`true\`, \`false\`, \`on\`, \`off\``;
    } else if (settingKey === "stay_247") {
      extra = `\n**Valid values:** \`off\`, \`on\`, \`auto\`\n\n**Modes:**\n• \`on\` — Stays connected permanently. Won't rejoin after \`${pfx}leave\`.\n• \`auto\` — Stays connected & auto-rejoins after \`${pfx}leave\` or disconnect.\n• \`off\` — Leaves after inactivity.\n\n**Multi-Voice:** You can save multiple voice channels in the same server. Each channel has its own mode.`;
    }

    return message.reply(embed(
        `**⚙️ Setting: \`${settingKey}\`**\n\n` +
        `${description}${extra}\n\n` +
        `**Current value:** ${settingKey === "stay_247" ? format247Status(set, this.locale?.translate?.bind(this.locale), getGuildId(message)) : displayValue(settingKey, currentVal)}\n` +
        `**Default:** ${displayValue(settingKey, defaultVal)}`,
        { title: `⚙️ ${settingKey}` }
    ));
  }
}
