/**
 * @file trackopt.mjs — Manage per-track options — auto-seek start position and end-time timer
 * @module commands.trackopt
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";
import { Utils } from "../src/Utils.mjs";
import { logger } from "../src/constants/Logger.mjs";
import { ERROR_COLOR } from "../src/constants/UI.mjs";

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

/**
 * Execute the trackopt command.
 * @param {import("../src/MessageHandler.mjs").Message} msg - The incoming message
 * @param {Map<string, {value: *}>>} data - Slash-command options map
 * @returns {Promise<void>}
 */
export async function run(msg, data) {
  const trackOpts = this.trackOptions;
  if (!trackOpts) {
    return msg.reply({ embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.trackopt.notAvailable"))] });
  }

  const subCommand = data.command.name || data.commandId || "get";

  const p = await this.getPlayer(msg, true, true, false);
  if (!p) return;

  const current = p.queue?.getCurrent();
  if (!current && subCommand !== "list") {
    return msg.reply({ embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.trackopt.nothingPlaying"))] });
  }

  const userId = msg.message?.author?.id ?? msg.author?.id;
  if (!userId) {
    return msg.reply({ embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses._common.noVoiceChannel"))] });
  }

  const prefix = this.handler.getPrefix(msg.message?.guildId);

  if (subCommand === "set") {
    const timesRaw = data.get("times")?.value;
    if (!timesRaw) {
      return msg.reply({ embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.trackopt.invalidFormat"))] });
    }

    const parts = timesRaw.trim().split(/\s+/);
    const aliasRaw = extractAlias(parts);

    const startMs = Utils.parseDuration(parts[0]);
    if (!startMs || startMs < 0) {
      return msg.reply({ embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.trackopt.invalidFormat"))] });
    }

    let endMs = 0;
    if (parts.length > 1) {
      endMs = Utils.parseDuration(parts[1]);
      if (!endMs || endMs <= 0) {
        return msg.reply({ embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.trackopt.invalidFormat"))] });
      }
      if (endMs <= startMs) {
        return msg.reply({ embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.trackopt.invalidEndAfterStart"))] });
      }
    }

    const trackDuration = p._getTrackDurationMs(current);
    if (trackDuration > 0) {
      if (startMs >= trackDuration) {
        return msg.reply({ embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.trackopt.startExceedsDuration", { duration: Utils.prettifyMS(trackDuration) }))] });
      }
      if (endMs > 0 && endMs > trackDuration) {
        return msg.reply({ embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.trackopt.endExceedsDuration", { duration: Utils.prettifyMS(trackDuration) }))] });
      }
    }

    const result = await trackOpts.set(userId, current, startMs, endMs, aliasRaw);
    if (!result) {
      return msg.reply({ embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.trackopt.saveFailed"))] });
    }

    if (result.alias === DEFAULT_ALIAS && p.connection && !p._paused && startMs > 0) {
      try {
        await p.applyTrackOption({ startMs, endMs, alias: result.alias, userId });
      } catch (applyErr) {
        logger.warn("[trackopt] Auto-apply after set failed:", applyErr.message);
      }
    }

    const endLabel = endMs > 0 ? Utils.prettifyMS(endMs) : "full track";
    let desc;
    if (result.alias === DEFAULT_ALIAS) {
      desc = this.t(msg, "responses.trackopt.saved", { title: current.title, aliasLabel: "", start: Utils.prettifyMS(startMs), end: endLabel });
    } else {
      desc = this.t(msg, "responses.trackopt.savedAlias", { title: current.title, alias: result.alias, start: Utils.prettifyMS(startMs), end: endLabel, prefix });
    }

    return msg.reply({ embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(desc)] });
  }

  if (subCommand === "get") {
    const rows = await trackOpts.getAllForTrack(userId, current);
    if (!rows || rows.length === 0) {
      return msg.reply({ embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.trackopt.notSet", { title: current.title }))] });
    }

    let desc = this.t(msg, "responses.trackopt.current", { title: current.title, count: rows.length }) + "\n\n";
    for (const row of rows) {
      const aliasLabel = row.alias === DEFAULT_ALIAS ? "default" : row.alias;
      const endStr = row.end_ms > 0 ? Utils.prettifyMS(row.end_ms) : "end";
      const autoTag = row.alias === DEFAULT_ALIAS ? " ← auto" : "";
      desc += this.t(msg, "responses.trackopt.currentEntry", { alias: aliasLabel, start: Utils.prettifyMS(row.start_ms), end: endStr, autoTag }) + "\n";
    }

    return msg.reply({ embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(desc)] });
  }

  if (subCommand === "play") {
    const aliasRaw = data.get("alias")?.value;
    if (!aliasRaw) {
      return msg.reply({ embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.trackopt.provideAlias", { prefix }))] });
    }

    const safeAlias = aliasRaw.toLowerCase().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
    if (!safeAlias) {
      return msg.reply({ embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.trackopt.invalidAlias"))] });
    }

    const result = await trackOpts.get(userId, current, safeAlias);
    if (!result) {
      const allAliases = await trackOpts.getAllForTrack(userId, current);
      if (allAliases.length > 0) {
        const names = allAliases.map(r => r.alias === DEFAULT_ALIAS ? "default" : r.alias).join(", ");
        return msg.reply({ embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.trackopt.aliasNotFound", { alias: safeAlias, title: current.title, names }))] });
      }
      return msg.reply({ embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.trackopt.notFound", { title: current.title }))] });
    }

    if (!p.connection || p._paused) {
      return msg.reply({ embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.trackopt.mustBePlaying"))] });
    }

    try {
      const applied = await p.applyTrackOption(result);
      if (!applied) {
        return msg.reply({ embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.trackopt.applyFailed", { error: "Unknown error" }))] });
      }

      const aliasLabel = safeAlias === DEFAULT_ALIAS ? "default" : safeAlias;
      const endStr = result.endMs > 0 ? Utils.prettifyMS(result.endMs) : "end";
      return msg.reply({ embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.trackopt.applied", { alias: aliasLabel, start: Utils.prettifyMS(result.startMs), end: endStr }))] });
    } catch (e) {
      return msg.reply({ embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.trackopt.applyFailed", { error: e.message }))] });
    }
  }

  if (subCommand === "remove") {
    const aliasRaw = data.get("alias")?.value;
    const removed = await trackOpts.remove(userId, current, aliasRaw || null);
    if (!removed) {
      return msg.reply({ embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.trackopt.notFound", { title: current.title }))] });
    }
    if (p._activeTrackOpt) {
      const removeDefault = !aliasRaw || aliasRaw.toLowerCase() === DEFAULT_ALIAS;
      const activeIsDefault = p._activeTrackOpt.alias === DEFAULT_ALIAS;
      if (removeDefault && activeIsDefault) {
        p._activeTrackOpt = null;
        p._clearTrackEndTimer();
      } else if (aliasRaw && p._activeTrackOpt.alias === aliasRaw.toLowerCase()) {
        p._activeTrackOpt = null;
        p._clearTrackEndTimer();
      }
    }
    if (aliasRaw) {
      return msg.reply({ embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.trackopt.removedAlias", { alias: aliasRaw, title: current.title }))] });
    }
    return msg.reply({ embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.trackopt.removedAll", { title: current.title }))] });
  }

  if (subCommand === "list") {
    const rows = await trackOpts.list(userId);
    if (!rows || rows.length === 0) {
      return msg.reply({ embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.trackopt.listEmpty", { prefix }))] });
    }

    let desc = this.t(msg, "responses.trackopt.listTitle", { count: rows.length }) + "\n\n";
    let lastTrack = "";
    for (const row of rows) {
      const title = row.track_title || row.track_identifier;
      const aliasLabel = row.alias === DEFAULT_ALIAS ? "default" : row.alias;
      const endStr = row.end_ms > 0 ? Utils.prettifyMS(row.end_ms) : "end";
      if (title !== lastTrack) {
        if (lastTrack) desc += "\n";
        desc += `🎵 **${title}**\n`;
        lastTrack = title;
      }
      const autoTag = row.alias === DEFAULT_ALIAS ? " ← auto" : "";
      desc += `  • ${aliasLabel}: ${Utils.prettifyMS(row.start_ms)} → ${endStr}${autoTag}\n`;
    }
    desc += "\n" + this.t(msg, "responses.trackopt.listHint", { prefix });

    return msg.reply({ embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(desc)] });
  }
}
