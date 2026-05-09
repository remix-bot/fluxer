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

/** Build a rich embed with fields for the 24/7 status panel */
function richEmbed(fields, opts = {}) {
  const b = new EmbedBuilder().setColor(getGlobalColor());
  if (opts.title) b.setTitle(opts.title);
  if (opts.description) b.setDescription(opts.description);
  if (opts.footer) b.setFooter({ text: opts.footer });
  if (opts.iconURL) b.setAuthor({ name: opts.title || "\u200b", iconURL: opts.iconURL });
  for (const f of fields) {
    b.addField(f.name, f.value, f.inline ?? false);
  }
  return { embeds: [b] };
}

// ── Constants ─────────────────────────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── 24/7 helpers ──────────────────────────────────────────────────────────────

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
  // Fallback: guild-wide mode (legacy)
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
  // Also update guild-wide mode for backward compat with older code
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
  // Update guild-wide mode to match the first remaining channel, or "off"
  if (currentChannels.size === 0) {
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
  // Only keep valid Fluxer IDs — strip anything that isn't
  // a proper channel ID (e.g. garbage from DB corruption).
  const arr = [...channels].filter(id => id && isValidFluxerId(id));
  set.set("stay_247", arr.length > 0 ? arr : "none");
}

function modeLabel(mode) {
  return mode === "auto" ? "🔄 Auto" : mode === "on" ? "✅ On" : "❌ Off";
}

function modeEmoji(mode) {
  return mode === "auto" ? "🔄" : mode === "on" ? "✅" : "❌";
}

function modeColor(mode) {
  return mode === "auto" ? 0xF59E0B : mode === "on" ? 0x10B981 : 0xEF4444;
}

function modeDescription(mode, prefix) {
  if (mode === "on")  return `Stays connected permanently. Won't rejoin after \`${prefix}leave\`.`;
  if (mode === "auto") return `Stays connected & auto-rejoins after \`${prefix}leave\` or disconnect.`;
  return "24/7 disabled — leaves after inactivity.";
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
 * Build a rich 24/7 status panel with per-channel details.
 * Shows each saved channel with its mode, player status, and member count.
 * Uses color-coded sections and a clean visual layout.
 */
function build247StatusPanel(set, ctx, message) {
  const channels = [...get247Channels(set)];
  const prefix = (() => {
    try { return set.get("prefix") ?? "%"; } catch (_) { return "%"; }
  })();

  if (channels.length === 0) {
    return richEmbed([
      {
        name: "Getting Started",
        value:
          "Join a voice channel and run one of:\n" +
          `• \`${prefix}247 on\` — stay permanently, no auto-rejoin\n` +
          `• \`${prefix}247 auto\` — stay + auto-rejoin after leave/disconnect\n\n` +
          "Each channel in your server can have its own 24/7 mode.",
        inline: false,
      },
    ], {
      title: "♾️ 24/7 Mode",
      description: "No voice channels are saved for 24/7.",
      footer: `${prefix}247 on | ${prefix}247 auto | ${prefix}247 off`,
    });
  }

  const fields = [];
  const guildId = getGuildId(message);

  for (let i = 0; i < channels.length; i++) {
    const chId = channels[i];
    const mode = get247ChannelMode(set, chId);
    const chName = resolveChannelName(ctx.client, chId);
    const displayName = chName ? `**${chName}** <#${chId}>` : `<#${chId}>`;

    // Player status
    let statusLine = "⚪ Not connected";
    let trackLine = "";
    let memberInfo = "";
    try {
      const player = ctx.players?.playerMap?.get(chId);
      if (player && !player._destroyed) {
        const currentTrack = player.queue?.getCurrent?.();
        if (currentTrack) {
          const title = currentTrack.title ?? currentTrack.uri ?? "Unknown";
          statusLine = "🟢 Playing";
          trackLine = `\n🎵 **${title.length > 45 ? title.slice(0, 42) + "..." : title}**`;
        } else {
          statusLine = "🟡 Connected";
          trackLine = "\nWaiting for music...";
        }

        // Count members in the channel
        if (guildId && ctx.observedVoiceUsers) {
          let humans = 0;
          for (const [, info] of ctx.observedVoiceUsers) {
            if (String(info.channelId).replace(/\D/g, "") === chId &&
                String(info.guildId).replace(/\D/g, "") === String(guildId).replace(/\D/g, "")) {
              humans++;
            }
          }
          memberInfo = humans > 0 ? ` 👤 ${humans}` : " 👤 0";
        }
      }
    } catch (_) {}

    fields.push({
      name: `${modeEmoji(mode)} ${displayName}`,
      value:
        `**Mode:** ${modeLabel(mode)} — ${modeDescription(mode, prefix)}\n` +
        `${statusLine}${memberInfo}${trackLine}`,
      inline: false,
    });
  }

  // Summary bar
  const onCount   = channels.filter(id => get247ChannelMode(set, id) === "on").length;
  const autoCount = channels.filter(id => get247ChannelMode(set, id) === "auto").length;
  const modeSummary = [];
  if (onCount > 0) modeSummary.push(`✅ ${onCount} on`);
  if (autoCount > 0) modeSummary.push(`🔄 ${autoCount} auto`);
  if (modeSummary.length === 0) modeSummary.push("❌ all off");

  const summaryLine = channels.length === 1
    ? "1 channel saved"
    : `${channels.length} channels saved`;

  return richEmbed(fields, {
    title: "♾️ 24/7 Mode",
    description: `**${summaryLine}** — ${modeSummary.join(" · ")}`,
    footer: `${prefix}247 on | ${prefix}247 auto | ${prefix}247 off`,
  });
}

/**
 * Build a rich embed for the %247 on/auto confirmation.
 * Uses color coding based on the mode selected.
 */
function build247EnabledPanel(set, channelId, mode, joined, ctx, guildId) {
  const channels = [...get247Channels(set)];
  const modeStr = mode === "auto" ? "🔄 Auto" : "✅ On";
  const prefix = (() => {
    try { return set.get("prefix") ?? "%"; } catch (_) { return "%"; }
  })();
  const chName = resolveChannelName(ctx.client, channelId);
  const displayName = chName ? `**${chName}** <#${channelId}>` : `<#${channelId}>`;

  const fields = [];

  // Primary channel that was just set
  const connectStatus = joined
    ? "🟢 **Bot joined and connected!**"
    : "🟡 Mode updated (player was already active)";

  fields.push({
    name: `${modeEmoji(mode)} ${displayName}`,
    value: `**Mode:** ${modeStr}\n${modeDescription(mode, prefix)}\n${connectStatus}`,
    inline: false,
  });

  // Show other saved channels if any
  const otherChannels = channels.filter(id => id !== channelId);
  if (otherChannels.length > 0) {
    const otherLines = otherChannels.map(id => {
      const m = get247ChannelMode(set, id);
      const name = resolveChannelName(ctx.client, id);
      const label = name ? `${name}` : `<#${id}>`;
      return `${modeEmoji(m)} ${label} — ${modeLabel(m)}`;
    });
    fields.push({
      name: `📋 Other Channels (${otherChannels.length})`,
      value: otherLines.join("\n"),
      inline: false,
    });
  }

  const summary = channels.length === 1
    ? "1 channel saved"
    : `${channels.length} channels saved`;

  // Use the mode's color for the embed
  const b = new EmbedBuilder();
  b.setColor(modeColor(mode));
  b.setTitle(`♾️ 24/7 ${modeStr}`);
  b.setDescription(`**${summary}** for this server`);
  b.setFooter({ text: `${prefix}247 off to disable for a channel` });
  for (const f of fields) b.addField(f.name, f.value, f.inline ?? false);
  return { embeds: [b] };
}

/**
 * Build a rich embed for the %247 off confirmation.
 */
function build247DisabledPanel(set, channelId, guildId) {
  const channels = [...get247Channels(set)];
  const prefix = (() => {
    try { return set.get("prefix") ?? "%"; } catch (_) { return "%"; }
  })();

  const fields = [];

  // The channel that was removed
  fields.push({
    name: `❌ <#${channelId}>`,
    value: "24/7 mode **disabled** — bot has left this channel.",
    inline: false,
  });

  // Show remaining saved channels if any
  if (channels.length > 0) {
    const remainingLines = channels.map(id => {
      const m = get247ChannelMode(set, id);
      return `${modeEmoji(m)} <#${id}> — ${modeLabel(m)}`;
    });
    fields.push({
      name: `📋 Remaining (${channels.length})`,
      value: remainingLines.join("\n"),
      inline: false,
    });
  } else {
    fields.push({
      name: "📋 No Channels Saved",
      value:
        "All 24/7 channels have been removed.\n" +
        "The bot will leave voice after inactivity.",
      inline: false,
    });
  }

  const summary = channels.length === 0
    ? "No channels saved"
    : `${channels.length} channel${channels.length !== 1 ? "s" : ""} remaining`;

  return richEmbed(fields, {
    title: "♾️ 24/7 Disabled",
    description: `**${summary}**`,
    footer: `${prefix}247 on | ${prefix}247 auto to re-enable`,
  });
}

function format247Status(set) {
  const channels = get247Channels(set);
  if (channels.size === 0) return "❌ Disabled";
  if (channels.size === 1) {
    const chId = [...channels][0];
    const mode = get247ChannelMode(set, chId);
    return `${modeLabel(mode)} — <#${chId}>`;
  }
  const parts = [...channels].map(id => {
    const mode = get247ChannelMode(set, id);
    return `<#${id}> (${modeLabel(mode)})`;
  });
  return `${channels.size} channels: ${parts.join(", ")}`;
}

function format247Summary(set) {
  const channels = [...get247Channels(set)];
  if (channels.length === 0) {
    return [
      "**24/7 Mode**",
      "Status: ❌ Disabled",
      "Saved channels: none"
    ].join("\n");
  }

  const lines = ["**24/7 Mode**"];
  for (const id of channels) {
    const mode = get247ChannelMode(set, id);
    lines.push(`• <#${id}> — ${modeLabel(mode)}`);
  }
  return lines.join("\n");
}

function prettifySettingLabel(key) {
  const custom = {
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
  return custom[key] ?? key.replace(/_/g, " ");
}

async function handle247(ctx, message, value) {
  const set     = ctx.getSettings(message);
  const guildId = getGuildId(message);
  const mode    = value.toLowerCase().trim();

  // Normalise legacy true/false
  const resolved = mode === "true" ? "auto" : mode === "false" ? "off" : mode;

  if (!["off", "on", "auto"].includes(resolved)) {
    return message.reply(embed(
        ctx.t(message, "responses.settings.invalid247", { value })
    ));
  }

  // ── OFF ───────────────────────────────────────────────────────────────────
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
      return message.reply(build247DisabledPanel(set, id, guildId));
    }

    // Not in a channel — disable all for this guild
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
    const prefix = (() => {
      try { return set.get("prefix") ?? "%"; } catch (_) { return "%"; }
    })();
    return message.reply(richEmbed([{
      name: "❌ All Channels",
      value: "24/7 mode **disabled** for all channels in this server.\nThe bot will leave voice after inactivity.",
      inline: false,
    }], {
      title: "♾️ 24/7 Disabled",
      description: "No channels saved",
      footer: `${prefix}247 on | ${prefix}247 auto to re-enable`,
    }));
  }

  // ── ON / AUTO ─────────────────────────────────────────────────────────────
  if (!guildId) return message.reply(embed(ctx.t(message, "responses.settings.noServer")));

  const channelId = ctx.players.checkVoiceChannels(message);
  if (!channelId) {
    return message.reply(embed(
        ctx.t(message, "responses.settings.noVoice247", { mode: resolved })
    ));
  }

  const id       = cleanId(channelId);
  const channels = get247Channels(set);
  channels.add(id);
  save247Channels(set, channels);
  // Per-channel mode: each channel gets its own on/auto setting
  set247ChannelMode(set, id, resolved);

  const playerExists = ctx.players.playerMap.has(id) ||
      [...ctx.players.playerMap.values()].some(p =>
        cleanId(p?._channelId ?? "") === id && cleanId(p?._guildId ?? "") === cleanId(guildId)
      );

  if (playerExists) {
    return message.reply(build247EnabledPanel(set, id, resolved, false, ctx, guildId));
  }

  try {
    await ctx._spawnPlayer(guildId, id);
    return message.reply(build247EnabledPanel(set, id, resolved, true, ctx, guildId));
  } catch (e) {
    // Show error in a rich panel
    const channels2 = [...get247Channels(set)];
    const otherChannels = channels2.filter(ch => ch !== id);
    const prefix = (() => {
      try { return set.get("prefix") ?? "%"; } catch (_) { return "%"; }
    })();
    const chName = resolveChannelName(ctx.client, id);
    const displayName = chName ? `**${chName}** <#${id}>` : `<#${id}>`;
    const fields = [
      {
        name: `⚠️ ${displayName}`,
        value: `**Mode:** ${modeLabel(resolved)} — saved, but failed to join\nError: \`${e.message}\``,
        inline: false,
      },
    ];
    if (otherChannels.length > 0) {
      const otherLines = otherChannels.map(ch => {
        const m = get247ChannelMode(set, ch);
        const name2 = resolveChannelName(ctx.client, ch);
        const label = name2 ? name2 : `<#${ch}>`;
        return `${modeEmoji(m)} ${label} — ${modeLabel(m)}`;
      });
      fields.push({
        name: `📋 Other Channels (${otherChannels.length})`,
        value: otherLines.join("\n"),
        inline: false,
      });
    }
    return message.reply(richEmbed(fields, {
      title: "♾️ 24/7 — Join Failed",
      description: `The channel was saved but the bot couldn't connect. Try \`${prefix}join\` or \`${prefix}play\` later.`,
      footer: `${prefix}247 off to remove a failed channel`,
    }));
  }
}

// ── Per-setting validation & apply ───────────────────────────────────────────

/**
 * Validate and save a setting value.
 * @returns {string|null} Error message string, or null on success.
 *   For stay_247, replies directly and always returns null.
 */
async function applySet(ctx, message, set, key, rawValue) {
  // Boolean settings
  if (BOOL_SETTINGS.has(key)) {
    const bool = parseBool(rawValue);
    if (bool === null) {
      return ctx.t(message, "responses.settings.mustBeBool", { setting: key });
    }
    set.set(key, bool);
    return null;
  }

  // 24/7 mode — replies on its own
  if (key === "stay_247") {
    await handle247(ctx, message, rawValue);
    return null;
  }

  // Volume
  if (key === "volume") {
    const num = parseInt(rawValue, 10);
    if (isNaN(num) || num < VOLUME_MIN || num > VOLUME_MAX) {
      return ctx.t(message, "responses.settings.volumeRange");
    }
    set.set(key, num);
    return null;
  }

  // Locale
  if (key === "locale") {
    if (!VALID_LOCALES.has(rawValue)) {
      return ctx.t(message, "responses.settings.invalidLocale", {
          locale: rawValue,
          locales: [...VALID_LOCALES].map(l => `\`${l}\``).join(", ")
      });
    }
    set.set(key, rawValue);
    // Invalidate locale cache so the new locale takes effect immediately
    // without requiring a bot reboot.
    const guildId = getGuildId(message);
    if (guildId) ctx.locale.invalidateCache(guildId);
    return null;
  }

  // Prefix
  if (key === "prefix") {
    if (!rawValue || rawValue.length > 5) {
      return ctx.t(message, "responses.settings.prefixLength");
    }
    if (/\s/.test(rawValue)) {
      return ctx.t(message, "responses.settings.prefixSpaces");
    }
  }

  // General: run the runnable hook if present
  if (runnables[key]) {
    const err = runnables[key].call(ctx, rawValue, { msg: message });
    if (err) return `❌ ${err}`;
  }

  set.set(key, rawValue);
  return null;
}

// ── Shortcut handler (%prefix, %pfx, %247) ───────────────────────────────────

async function handleShortcut(ctx, message, settingKey, valueTokens) {
  const set = ctx.getSettings(message);

  // GET (no value provided) — show rich 24/7 panel
  if (valueTokens.length === 0) {
    if (settingKey === "stay_247") {
      return message.reply(build247StatusPanel(set, ctx, message));
    }
    const val = set.get(settingKey);
    return message.reply(embed(`\`${settingKey}\` → ${displayValue(settingKey, val)}`));
  }

  // SET
  const rawValue = valueTokens.join(" ");
  const err = await applySet(ctx, message, set, settingKey, rawValue);
  if (err) return message.reply(embed(err));

  // handle247 replies on its own
  if (settingKey !== "stay_247") {
    const val = set.get(settingKey);
    return message.reply(embed(ctx.t(message, "responses.settings.setSuccess", { label: settingKey, value: displayValue(settingKey, val) })));
  }
}

// ── Command definition ────────────────────────────────────────────────────────

export const command = function() {
  // Populate valid locales from the Locale instance so the list stays
  // in sync when new locale files are added to storage/locales/bot/.
  if (this.locale) {
    VALID_LOCALES = this.locale.availableLocales();
  }

  if (this.loader) {
    for (const [alias, settingKey] of Object.entries(SHORTCUTS)) {
      const builder = new CommandBuilder()
          .setName(alias)
          .setDescription(`Shortcut for \`${settingKey}\`. Usage: %${alias} [value]`)
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

// ── Command runner ────────────────────────────────────────────────────────────

export async function run(message, data) {
  const set = this.getSettings(message);
  const cmd = data.commandId || "getSettings";

  // ── Shortcut commands (%prefix, %pfx, %247) ───────────────────────────────
  if (cmd?.startsWith("shortcut_")) {
    const alias      = cmd.replace("shortcut_", "");
    const settingKey = SHORTCUTS[alias];
    const raw        = (message.content ?? message.message?.content ?? "").trim();
    const prefix     = set.get("prefix") ?? "%";
    const body       = raw.startsWith(prefix) ? raw.slice(prefix.length).trim() : raw;
    const tokens     = body.split(/\s+/).slice(1);
    return handleShortcut(this, message, settingKey, tokens);
  }

  // ── Inline shortcut: %settings <alias> [value] ────────────────────────────
  const raw    = (message.content ?? message.message?.content ?? "").trim();
  const prefix = set.get("prefix") ?? "%";
  const body   = raw.startsWith(prefix) ? raw.slice(prefix.length).trim() : raw;
  const args   = body.split(/\s+/);
  const inlineShortcut = SHORTCUTS[args[1]?.toLowerCase()];
  if (inlineShortcut) {
    return handleShortcut(this, message, inlineShortcut, args.slice(2));
  }

  const settingKey = data.get("setting")?.value;

  // ── set ───────────────────────────────────────────────────────────────────
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

    if (settingKey === "stay_247") return; // handle247 replied already

    const newVal = set.get(settingKey);
    return message.reply(embed(this.t(message, "responses.settings.setSuccess", { label: prettifySettingLabel(settingKey), value: displayValue(settingKey, newVal) })));
  }

  // ── get ───────────────────────────────────────────────────────────────────
  if (cmd === "getSettings") {
    if (settingKey) {
      if (settingKey === "stay_247") {
        return message.reply(build247StatusPanel(set, this, message));
      }
      const val = set.get(settingKey);
      const description = this.settingsMgr.descriptions?.[settingKey];
      let reply = `**${prettifySettingLabel(settingKey)}**\nValue: ${displayValue(settingKey, val)}`;
      if (description) reply += `\n\n*${description}*`;
      return message.reply(embed(reply));
    }

    // List all settings
    const d         = set.getAll();
    const guildName = getGuildName(message);
    // Use the Fluxer CDN raw property pattern (guild.icon is a hash string, not a URL).
    // guild.iconURL() is a method that does not exist on @fluxerjs/core Guild objects.
    const rawGuild  = message.message?.guild;
    const iconUrl   = rawGuild?.icon
        ? `https://cdn.fluxer.app/icons/${rawGuild.id}/${rawGuild.icon}.webp`
        : null;

    const lines = Object.entries(d)
        .filter(([k]) => k !== "stay_247_mode") // surfaced inline with stay_247
        .map(([k]) => {
          if (k === "stay_247") {
            return `• **24/7 mode** — ${format247Status(set)}`;
          }
          return `• **${prettifySettingLabel(k)}** — ${displayValue(k, d[k])}`;
        });

    return message.reply(embed(
        this.t(message, "responses.settings.serverHeader", { name: guildName }) + "\n\n" + lines.join("\n") + "\n\n" +
        this.t(message, "responses.settings.shortcutsHint", { prefix }),
        { title: this.t(message, "responses.settings.serverTitle"), iconURL: iconUrl }
    ));
  }

  // ── reset ─────────────────────────────────────────────────────────────────
  if (cmd === "resetSettings") {
    if (!this.settingsMgr.isOption(settingKey)) {
      return message.reply(embed(this.t(message, "responses.settings.unknownSetting", { setting: settingKey })));
    }
    set.reset(settingKey);
    // Invalidate locale cache if the locale setting was reset
    if (settingKey === "locale") {
      const guildId = getGuildId(message);
      if (guildId) this.locale.invalidateCache(guildId);
    }
    const def = set.get(settingKey);
    return message.reply(embed(
        this.t(message, "responses.settings.resetSuccess", { setting: settingKey, value: displayValue(settingKey, def) })
    ));
  }

  // ── help ──────────────────────────────────────────────────────────────────
  if (cmd === "helpSettings") {
    const pfx = set.get("prefix") ?? "%";

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

    const description = this.settingsMgr.descriptions?.[settingKey] ?? "No description available.";
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
        `**Current value:** ${settingKey === "stay_247" ? format247Status(set) : displayValue(settingKey, currentVal)}\n` +
        `**Default:** ${displayValue(settingKey, defaultVal)}`,
        { title: `⚙️ ${settingKey}` }
    ));
  }
}
