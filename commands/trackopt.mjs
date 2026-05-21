import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

export const command = new CommandBuilder()
  .setName("trackopt")
  .setDescription("Set custom start/end times for tracks. Like iTunes used to have — great for album compilations and hidden tracks.", "commands.trackopt")
  .setCategory("music")
  .addSubcommand(s =>
    s.setName("set")
      .setId("trackopt_set")
      .setDescription("Set a custom start and/or end time for the current track")
      .addTextOption(o =>
        o.setName("times")
          .setDescription("Start and optional end time, e.g. '0:30' or '0:30 3:45'")
          .setRequired(true)
      )
  )
  .addSubcommand(s =>
    s.setName("get")
      .setId("trackopt_get")
      .setDescription("View your custom start/end time for the current track")
  )
  .addSubcommand(s =>
    s.setName("remove")
      .setId("trackopt_remove")
      .setDescription("Remove your custom start/end time for the current track")
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
      return msg.reply({ embeds: [new EmbedBuilder().setColor("#ff0000").setDescription("❌ Provide start and optional end time. Usage: `%trackopt set 0:30` or `%trackopt set 0:30 3:45`")] });
    }

    const parts = timesRaw.trim().split(/\s+/);
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

    const result = await trackOpts.set(userId, current, startMs, endMs);
    if (!result) {
      return msg.reply({ embeds: [new EmbedBuilder().setColor("#ff0000").setDescription("❌ Failed to save track option.")] });
    }

    let desc = `✅ Track option saved for **${current.title}**\n`;
    desc += `▶️ Start: **${formatMs(startMs)}**`;
    if (endMs > 0) desc += ` | ⏹️ End: **${formatMs(endMs)}**`;
    else desc += ` | ⏹️ End: **full track**`;
    desc += `\n\nThis will apply automatically whenever this track plays in a channel you're in.`;

    return msg.reply({ embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(desc)] });
  }

  if (subCommand === "get") {
    const result = await trackOpts.get(userId, current);
    if (!result) {
      return msg.reply({ embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(`No custom times set for **${current.title}**.`)] });
    }

    let desc = `📎 Track option for **${current.title}**\n`;
    desc += `▶️ Start: **${formatMs(result.startMs)}**`;
    if (result.endMs > 0) desc += ` | ⏹️ End: **${formatMs(result.endMs)}**`;
    else desc += ` | ⏹️ End: **full track**`;

    return msg.reply({ embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(desc)] });
  }

  if (subCommand === "remove") {
    const removed = await trackOpts.remove(userId, current);
    if (!removed) {
      return msg.reply({ embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(`No custom times found for **${current.title}**.`)] });
    }
    return msg.reply({ embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(`🗑️ Removed track option for **${current.title}**.`)] });
  }

  if (subCommand === "list") {
    const rows = await trackOpts.list(userId);
    if (!rows || rows.length === 0) {
      return msg.reply({ embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription("📭 You have no saved track options. Use `%trackopt set <start> [end]` to add one!")] });
    }

    let desc = `📋 **Your Track Options** (${rows.length})\n\n`;
    for (const row of rows) {
      const title = row.track_title || row.track_identifier;
      const endStr = row.end_ms > 0 ? formatMs(row.end_ms) : "end";
      desc += `• **${title}** — ${formatMs(row.start_ms)} → ${endStr}\n`;
    }
    desc += `\nUse \`%trackopt remove\` while a track is playing to delete its option.`;

    return msg.reply({ embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(desc)] });
  }
}
