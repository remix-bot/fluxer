import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";
import { logger } from "../src/constants/Logger.mjs";

const DEFAULT_ALIAS = "default";

export const command = new CommandBuilder()
  .setName("trackopt")
  .setDescription("Set custom start/end times for tracks. Supports named aliases — save multiple trims per track for different sections.", "commands.trackopt")
  .setCategory("music")
  .addSubcommand(s =>
    s.setName("set")
      .setId("trackopt_set")
      .setDescription("Set a custom start/end time for the current track. Add alias:name for multiple trims.")
      .addTextOption(o =>
        o.setName("times")
          .setDescription("Start [end] [alias:name], e.g. '0:30 3:45' or '0:30 3:45 alias:hidden'")
          .setRequired(true)
      )
  )
  .addSubcommand(s =>
    s.setName("get")
      .setId("trackopt_get")
      .setDescription("View your custom start/end times for the current track")
  )
  .addSubcommand(s =>
    s.setName("play")
      .setId("trackopt_play")
      .setDescription("Apply a named alias trim to the currently playing track")
      .addTextOption(o =>
        o.setName("alias")
          .setDescription("Name of the alias to play (e.g. 'hidden', 'outro')")
          .setRequired(true)
      )
  )
  .addSubcommand(s =>
    s.setName("remove")
      .setId("trackopt_remove")
      .setDescription("Remove a custom trim for the current track. Specify alias or leave empty for all.")
      .addTextOption(o =>
        o.setName("alias")
          .setDescription("Alias name to remove, or leave empty to remove all trims for this track")
          .setRequired(false)
      )
  )
  .addSubcommand(s =>
    s.setName("list")
      .setId("trackopt_list")
      .setDescription("List all your saved track options")
  )
  .addAlias("to");

function parseTimeInput(str) {
  if (!str || typeof str !== "string") return null;
  str = str.trim();
  if (/^\d+$/.test(str)) return parseInt(str, 10) * 1000;
  const parts = str.split(":").map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    if (seconds >= 60) return null;
    return (minutes * 60 + seconds) * 1000;
  }
  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    if (minutes >= 60 || seconds >= 60) return null;
    return (hours * 3600 + minutes * 60 + seconds) * 1000;
  }
  return null;
}

function formatMs(ms) {
  if (ms == null || ms < 0) return "0:00";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function extractAlias(parts) {
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].toLowerCase().startsWith("alias:")) {
      const aliasVal = parts[i].slice(6);
      parts.splice(i, 1);
      return aliasVal;
    }
  }
  return DEFAULT_ALIAS;
}

export async function run(msg, data) {
  const trackOpts = this.trackOptions;
  if (!trackOpts) {
    return msg.reply({ embeds: [new EmbedBuilder().setColor("#ff0000").setDescription("❌ Track options feature is not available.")] });
  }

  const subCommand = data.command.name || data.commandId || "get";

  const p = await this.getPlayer(msg, true, true, false);
  if (!p) return;

  const current = p.queue?.getCurrent();
  if (!current && subCommand !== "list") {
    return msg.reply({ embeds: [new EmbedBuilder().setColor("#ff0000").setDescription("❌ There's nothing playing at the moment!")] });
  }

  const userId = msg.message?.author?.id ?? msg.author?.id;
  if (!userId) {
    return msg.reply({ embeds: [new EmbedBuilder().setColor("#ff0000").setDescription("❌ Could not identify your user.")] });
  }

  if (subCommand === "set") {
    const timesRaw = data.get("times")?.value;
    if (!timesRaw) {
      return msg.reply({ embeds: [new EmbedBuilder().setColor("#ff0000").setDescription("❌ Provide start and optional end time. Usage: `%trackopt set 0:30` or `%trackopt set 0:30 3:45 alias:hidden`")] });
    }

    const parts = timesRaw.trim().split(/\s+/);
    const aliasRaw = extractAlias(parts);

    const startMs = parseTimeInput(parts[0]);
    if (startMs === null || startMs < 0) {
      return msg.reply({ embeds: [new EmbedBuilder().setColor("#ff0000").setDescription("❌ Invalid start time format. Use `mm:ss`, `hh:mm:ss`, or seconds.")] });
    }

    let endMs = 0;
    if (parts.length > 1) {
      endMs = parseTimeInput(parts[1]);
      if (endMs === null || endMs <= 0) {
        return msg.reply({ embeds: [new EmbedBuilder().setColor("#ff0000").setDescription("❌ Invalid end time format. Use `mm:ss`, `hh:mm:ss`, or seconds.")] });
      }
      if (endMs <= startMs) {
        return msg.reply({ embeds: [new EmbedBuilder().setColor("#ff0000").setDescription("❌ End time must be after start time.")] });
      }
    }

    const trackDuration = p._getTrackDurationMs(current);
    if (trackDuration > 0) {
      if (startMs >= trackDuration) {
        return msg.reply({ embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(`❌ Start time exceeds track duration (**${formatMs(trackDuration)}**).`)] });
      }
      if (endMs > 0 && endMs > trackDuration) {
        return msg.reply({ embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(`❌ End time exceeds track duration (**${formatMs(trackDuration)}**).`)] });
      }
    }

    const result = await trackOpts.set(userId, current, startMs, endMs, aliasRaw);
    if (!result) {
      return msg.reply({ embeds: [new EmbedBuilder().setColor("#ff0000").setDescription("❌ Failed to save track option.")] });
    }

    const aliasLabel = result.alias === DEFAULT_ALIAS ? "" : ` [${result.alias}]`;
    let desc = `✅ Track option saved for **${current.title}**${aliasLabel}\n`;
    desc += `▶️ Start: **${formatMs(startMs)}**`;
    if (endMs > 0) desc += ` | ⏹️ End: **${formatMs(endMs)}**`;
    else desc += ` | ⏹️ End: **full track**`;
    if (result.alias === DEFAULT_ALIAS) {
      desc += `\n\nThis will apply automatically whenever this track plays in a channel you're in.`;
    } else {
      desc += `\n\nUse \`%trackopt play ${result.alias}\` to apply this trim while the track is playing.`;
    }

    return msg.reply({ embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(desc)] });
  }

  if (subCommand === "get") {
    const rows = await trackOpts.getAllForTrack(userId, current);
    if (!rows || rows.length === 0) {
      return msg.reply({ embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(`No custom times set for **${current.title}**.`)] });
    }

    let desc = `📎 Track options for **${current.title}** (${rows.length})\n\n`;
    for (const row of rows) {
      const aliasLabel = row.alias === DEFAULT_ALIAS ? "default" : row.alias;
      const endStr = row.end_ms > 0 ? formatMs(row.end_ms) : "end";
      const autoTag = row.alias === DEFAULT_ALIAS ? " ← auto" : "";
      desc += `• **${aliasLabel}** — ${formatMs(row.start_ms)} → ${endStr}${autoTag}\n`;
    }

    return msg.reply({ embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(desc)] });
  }

  if (subCommand === "play") {
    const aliasRaw = data.get("alias")?.value;
    if (!aliasRaw) {
      return msg.reply({ embeds: [new EmbedBuilder().setColor("#ff0000").setDescription("❌ Provide an alias name. Usage: `%trackopt play hidden`")] });
    }

    const safeAlias = aliasRaw.toLowerCase().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
    if (!safeAlias) {
      return msg.reply({ embeds: [new EmbedBuilder().setColor("#ff0000").setDescription("❌ Invalid alias name. Use letters, numbers, hyphens, or underscores.")] });
    }

    const result = await trackOpts.get(userId, current, safeAlias);
    if (!result) {
      const allAliases = await trackOpts.getAllForTrack(userId, current);
      if (allAliases.length > 0) {
        const names = allAliases.map(r => r.alias === DEFAULT_ALIAS ? "default" : r.alias).join(", ");
        return msg.reply({ embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(`❌ No alias **${safeAlias}** found for **${current.title}**.\nYour aliases: ${names}`)] });
      }
      return msg.reply({ embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(`❌ No alias **${safeAlias}** found for **${current.title}**.`)] });
    }

    if (!p.connection || p._paused) {
      return msg.reply({ embeds: [new EmbedBuilder().setColor("#ff0000").setDescription("❌ The player must be actively playing to apply an alias.")] });
    }

    try {
      const applied = p.applyTrackOption(result);
      if (!applied) {
        return msg.reply({ embeds: [new EmbedBuilder().setColor("#ff0000").setDescription("❌ Failed to apply alias.")] });
      }

      const aliasLabel = safeAlias === DEFAULT_ALIAS ? "default" : safeAlias;
      const endStr = result.endMs > 0 ? formatMs(result.endMs) : "end";
      return msg.reply({ embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(`✂️ Applied alias **${aliasLabel}** — ${formatMs(result.startMs)} → ${endStr}`)] });
    } catch (e) {
      return msg.reply({ embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(`❌ Failed to apply alias: ${e.message}`)] });
    }
  }

  if (subCommand === "remove") {
    const aliasRaw = data.get("alias")?.value;
    const removed = await trackOpts.remove(userId, current, aliasRaw || null);
    if (!removed) {
      const aliasLabel = aliasRaw ? ` **${aliasRaw}**` : "";
      return msg.reply({ embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(`No custom times found${aliasLabel} for **${current.title}**.`)] });
    }
    if (aliasRaw) {
      return msg.reply({ embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(`🗑️ Removed alias **${aliasRaw}** for **${current.title}**.`)] });
    }
    return msg.reply({ embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(`🗑️ Removed all track options for **${current.title}**.`)] });
  }

  if (subCommand === "list") {
    const rows = await trackOpts.list(userId);
    if (!rows || rows.length === 0) {
      return msg.reply({ embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription("📭 You have no saved track options. Use `%trackopt set <start> [end]` to add one!")] });
    }

    let desc = `📋 **Your Track Options** (${rows.length})\n\n`;
    let lastTrack = "";
    for (const row of rows) {
      const title = row.track_title || row.track_identifier;
      const aliasLabel = row.alias === DEFAULT_ALIAS ? "default" : row.alias;
      const endStr = row.end_ms > 0 ? formatMs(row.end_ms) : "end";
      if (title !== lastTrack) {
        if (lastTrack) desc += "\n";
        desc += `🎵 **${title}**\n`;
        lastTrack = title;
      }
      const autoTag = row.alias === DEFAULT_ALIAS ? " ← auto" : "";
      desc += `  • ${aliasLabel}: ${formatMs(row.start_ms)} → ${endStr}${autoTag}\n`;
    }
    desc += `\nUse \`%trackopt play <alias>\` to apply a named trim, or \`%trackopt remove [alias]\` to delete one.`;

    return msg.reply({ embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(desc)] });
  }
}
