import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";
import runnables from "../settings/runnables.mjs";

function embed(desc, opts = {}) {
  const b = new EmbedBuilder().setColor(getGlobalColor()).setDescription(desc);
  if (opts.title) b.setTitle(opts.title);
  if (opts.iconURL) b.setAuthor({ name: opts.title || "\u200b", iconURL: opts.iconURL });
  return { embeds: [b.toJSON()] };
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

/** Valid locale codes */
const VALID_LOCALES = new Set(["en", "ar-SA", "ckb", "de-DE", "pt-BR"]);

/** Volume constraints */
const VOLUME_MIN = 1;
const VOLUME_MAX = 200;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract clean numeric channel ID from any format */
function cleanId(raw) {
  return String(raw).replace(/\D/g, "");
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
  return message.message?.guild?.id ?? message.channel?.guild?.id ?? null;
}

/** Resolve guild name from a message context */
function getGuildName(message) {
  return message.message?.guild?.name ?? message.channel?.guild?.name ?? "this server";
}

// ── 24/7 helpers ──────────────────────────────────────────────────────────────

function get247Channels(set) {
  const raw = set.get("stay_247");
  if (!raw || raw === "none") return new Set();
  if (typeof raw === "string") {
    const id = cleanId(raw);
    return id ? new Set([id]) : new Set();
  }
  if (Array.isArray(raw)) {
    return new Set(raw.map(id => cleanId(id)).filter(Boolean));
  }
  return new Set();
}

function save247Channels(set, channels) {
  const arr = [...channels];
  set.set("stay_247", arr.length > 0 ? arr : "none");
}

function format247Status(set) {
  const channels = get247Channels(set);
  const mode     = set.get("stay_247_mode") ?? "off";
  if (channels.size === 0) return "❌ disabled";
  const channelList = [...channels].map(id => `<#${id}>`).join(", ");
  const modeLabel = mode === "auto" ? "🔄 auto" : mode === "on" ? "✅ on" : "❌ off";
  return `${modeLabel} — ${channelList}`;
}

async function handle247(ctx, message, value) {
  const set     = ctx.getSettings(message);
  const guildId = getGuildId(message);
  const mode    = value.toLowerCase().trim();

  // Normalise legacy true/false
  const resolved = mode === "true" ? "auto" : mode === "false" ? "off" : mode;

  if (!["off", "on", "auto"].includes(resolved)) {
    return message.replyEmbed(embed(
        `❌ Invalid value \`${value}\` for 24/7 mode.\n\n` +
        `**Valid options:**\n` +
        `• \`off\` — bot leaves after inactivity\n` +
        `• \`on\` — bot stays, but won't rejoin after restart or force-kick\n` +
        `• \`auto\` — bot stays and always rejoins after restart or force-kick`
    ));
  }

  // ── OFF ───────────────────────────────────────────────────────────────────
  if (resolved === "off") {
    if (!guildId) return message.replyEmbed(embed("❌ Could not detect your server."));

    const channelId = ctx.players.checkVoiceChannels(message);
    const channels  = get247Channels(set);

    if (channelId) {
      const id = cleanId(channelId);
      channels.delete(id);
      save247Channels(set, channels);
      ctx.markIntentionalLeave?.(id);
      const player = ctx.players.playerMap.get(id);
      if (player) {
        ctx.players.playerMap.delete(id);
        await player.leave().catch(() => {});
        player.destroy();
      }
      if (channels.size === 0) set.set("stay_247_mode", "off");
      return message.replyEmbed(embed(`✅ 24/7 mode **disabled** for <#${id}>. Bot has left.`));
    }

    // Not in a channel — disable all for this guild
    save247Channels(set, new Set());
    set.set("stay_247_mode", "off");
    for (const [chId, player] of [...ctx.players.playerMap.entries()]) {
      const ch = ctx.handler.client.channels.cache.get(chId);
      if (ch?.guild?.id === guildId || ch?.guildId === guildId) {
        ctx.markIntentionalLeave?.(chId);
        ctx.players.playerMap.delete(chId);
        await player.leave().catch(() => {});
        player.destroy();
      }
    }
    return message.replyEmbed(embed("✅ 24/7 mode **disabled** for all channels in this server."));
  }

  // ── ON / AUTO ─────────────────────────────────────────────────────────────
  if (!guildId) return message.replyEmbed(embed("❌ Could not detect your server."));

  const channelId = ctx.players.checkVoiceChannels(message);
  if (!channelId) {
    return message.replyEmbed(embed(
        `❌ You're not in a voice channel. Join one first, then run \`%247 ${resolved}\` again.`
    ));
  }

  const id       = cleanId(channelId);
  const channels = get247Channels(set);
  channels.add(id);
  save247Channels(set, channels);
  set.set("stay_247_mode", resolved);

  const modeLabel = resolved === "auto"
      ? "**auto** (stays and rejoins automatically)"
      : "**on** (stays but won't rejoin if kicked)";

  if (ctx.players.playerMap.has(id)) {
    return message.replyEmbed(embed(`✅ 24/7 mode set to ${modeLabel} for <#${id}>.`));
  }

  try {
    await ctx._spawnPlayer(guildId, id);
    return message.replyEmbed(embed(`✅ 24/7 mode set to ${modeLabel} for <#${id}>. Bot joined!`));
  } catch (e) {
    return message.replyEmbed(embed(`✅ 24/7 mode saved, but failed to join: ${e.message}`));
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
      return (
          `❌ \`${key}\` must be a boolean.\n` +
          `Accepted: \`true\`, \`false\`, \`on\`, \`off\`, \`enable\`, \`disable\``
      );
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
      return `❌ Volume must be a number between **${VOLUME_MIN}** and **${VOLUME_MAX}**.`;
    }
    set.set(key, num);
    return null;
  }

  // Locale
  if (key === "locale") {
    if (!VALID_LOCALES.has(rawValue)) {
      return (
          `❌ \`${rawValue}\` is not a supported locale.\n` +
          `Available locales: ${[...VALID_LOCALES].map(l => `\`${l}\``).join(", ")}`
      );
    }
    set.set(key, rawValue);
    return null;
  }

  // Prefix
  if (key === "prefix") {
    if (!rawValue || rawValue.length > 5) {
      return `❌ Prefix must be between **1** and **5** characters.`;
    }
    if (/\s/.test(rawValue)) {
      return `❌ Prefix cannot contain spaces.`;
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

  // GET (no value provided)
  if (valueTokens.length === 0) {
    if (settingKey === "stay_247") {
      return message.replyEmbed(embed(`24/7 mode: ${format247Status(set)}`));
    }
    const val = set.get(settingKey);
    return message.replyEmbed(embed(`\`${settingKey}\` → ${displayValue(settingKey, val)}`));
  }

  // SET
  const rawValue = valueTokens.join(" ");
  const err = await applySet(ctx, message, set, settingKey, rawValue);
  if (err) return message.replyEmbed(embed(err));

  // handle247 replies on its own
  if (settingKey !== "stay_247") {
    const val = set.get(settingKey);
    return message.replyEmbed(embed(`✅ \`${settingKey}\` set to ${displayValue(settingKey, val)}`));
  }
}

// ── Command definition ────────────────────────────────────────────────────────

export const command = function() {
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
  const cmd = data.commandId;

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
      return message.replyEmbed(embed(
          `❌ Unknown setting \`${settingKey}\`.\nAvailable: \`${available}\``
      ));
    }

    const err = await applySet(this, message, set, settingKey, rawValue);
    if (err) return message.replyEmbed(embed(err));

    if (settingKey === "stay_247") return; // handle247 replied already

    const newVal = set.get(settingKey);
    return message.replyEmbed(embed(`✅ \`${settingKey}\` set to ${displayValue(settingKey, newVal)}`));
  }

  // ── get ───────────────────────────────────────────────────────────────────
  if (cmd === "getSettings") {
    if (settingKey) {
      if (settingKey === "stay_247") {
        return message.replyEmbed(embed(`24/7 mode: ${format247Status(set)}`));
      }
      const val = set.get(settingKey);
      const description = this.settingsMgr.descriptions?.[settingKey];
      let reply = `**${settingKey}** → ${displayValue(settingKey, val)}`;
      if (description) reply += `\n\n*${description}*`;
      return message.replyEmbed(embed(reply));
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
            return `• **stay_247** — ${format247Status(set)}`;
          }
          return `• **${k}** — ${displayValue(k, d[k])}`;
        });

    return message.replyEmbed(embed(
        `Settings for **${guildName}**\n\n${lines.join("\n")}\n\n` +
        `Use \`${prefix}settings help <setting>\` to learn about any setting.`,
        { title: "⚙️ Server Settings", iconURL: iconUrl }
    ));
  }

  // ── reset ─────────────────────────────────────────────────────────────────
  if (cmd === "resetSettings") {
    if (!this.settingsMgr.isOption(settingKey)) {
      return message.replyEmbed(embed(`❌ Unknown setting \`${settingKey}\`.`));
    }
    set.reset(settingKey);
    const def = set.get(settingKey);
    return message.replyEmbed(embed(
        `🔄 \`${settingKey}\` has been reset to its default: ${displayValue(settingKey, def)}`
    ));
  }

  // ── help ──────────────────────────────────────────────────────────────────
  if (cmd === "helpSettings") {
    const pfx = set.get("prefix") ?? "%";

    if (!settingKey) {
      const keys    = Object.keys(this.settingsMgr.defaults);
      const keyList = keys.map(k => `\`${k}\``).join(", ");
      return message.replyEmbed(embed(
          `**⚙️ Settings Help**\n\n` +
          `**Available settings:** ${keyList}\n\n` +
          `**Subcommands:**\n` +
          `• \`${pfx}settings get\` — list all current values\n` +
          `• \`${pfx}settings get <setting>\` — view a single setting\n` +
          `• \`${pfx}settings set <setting> <value>\` — change a setting\n` +
          `• \`${pfx}settings reset <setting>\` — restore default value\n` +
          `• \`${pfx}settings help <setting>\` — describe a setting\n\n` +
          `**Shortcuts:** \`${pfx}prefix\`, \`${pfx}247\``,
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
      extra = `\n**Valid values:** \`off\`, \`on\`, \`auto\``;
    }

    return message.replyEmbed(embed(
        `**⚙️ Setting: \`${settingKey}\`**\n\n` +
        `${description}${extra}\n\n` +
        `**Current value:** ${displayValue(settingKey, currentVal)}\n` +
        `**Default:** ${displayValue(settingKey, defaultVal)}`,
        { title: `⚙️ ${settingKey}` }
    ));
  }
}
