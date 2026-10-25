/**
 * @module commands/trackopt
 * @description Set custom start/end times for tracks with named alias support.
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/ui/index.mjs";
import { Utils } from "../src/utils/Utils.mjs";
import { logger } from "../src/core/Logger.mjs";
import { ERROR_COLOR } from "../src/utils/UI.mjs";

/** @private @type {string} The default alias name for non-named track options. */
const DEFAULT_ALIAS = "default";

/** @type {CommandBuilder} @description Command definition for the trackopt command with subcommands. */
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

/**
 * @private
 * Build a text-based ASCII timeline representation of the cut window.
 * @param {number} startMs - Start time in milliseconds.
 * @param {number} endMs - End time in milliseconds.
 * @param {number} totalMs - Total track duration in milliseconds.
 * @returns {string} Formatted timeline string.
 */
function buildTimelineBar(startMs, endMs, totalMs) {
  if (!totalMs || totalMs <= 0) return `\`${Utils.prettifyMS(startMs)}\` ➔ \`${endMs > 0 ? Utils.prettifyMS(endMs) : "end"}\``;
  const totalSlots = 18;
  const startSlot = Math.min(totalSlots - 1, Math.floor((startMs / totalMs) * totalSlots));
  const effectiveEnd = endMs > 0 ? endMs : totalMs;
  const endSlot = Math.min(totalSlots, Math.max(startSlot + 1, Math.ceil((effectiveEnd / totalMs) * totalSlots)));

  let bar = "";
  for (let i = 0; i < totalSlots; i++) {
    if (i < startSlot) bar += "─";
    else if (i >= startSlot && i < endSlot) bar += "■";
    else bar += "─";
  }
  return `\`${Utils.prettifyMS(startMs)}\` \`[${bar}]\` \`${Utils.prettifyMS(effectiveEnd)}\``;
}

/**
 * @private
 * Extract an alias:name token from a parts array, mutating the array in place.
 * @param {string[]} parts - Mutable array of token strings.
 * @returns {string} The extracted alias value, or DEFAULT_ALIAS if not found.
 */
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
 * @async
 * Run handler for the trackopt command.
 * Dispatches to set/get/play/remove/list subcommands for custom track trim options.
 * @param {object} msg - The command message wrapper.
 * @param {object} data - Parsed command data containing subcommand and its options.
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
    const timeline = buildTimelineBar(startMs, endMs, trackDuration);
    const setEmbed = new EmbedBuilder()
      .setColor(getGlobalColor())
      .setAuthor({ name: "✂️ Custom Track Trim Saved" })
      .setTitle(current.title?.slice(0, 256) || "Track Trim")
      .setDescription(
        result.alias === DEFAULT_ALIAS
          ? this.t(msg, "responses.trackopt.saved", { title: current.title, aliasLabel: "", start: Utils.prettifyMS(startMs), end: endLabel })
          : this.t(msg, "responses.trackopt.savedAlias", { title: current.title, alias: result.alias, start: Utils.prettifyMS(startMs), end: endLabel, prefix })
      )
      .addFields(
        { name: "Playback Window", value: timeline, inline: false },
        { name: "Alias", value: `\`${result.alias}\``, inline: true },
        { name: "Active Trim", value: `${Utils.prettifyMS(startMs)} ➔ ${endLabel}`, inline: true }
      );

    if (current.thumbnail) setEmbed.setThumbnail(current.thumbnail);
    if (result.alias !== DEFAULT_ALIAS) {
      setEmbed.setFooter({ text: `Play this cut anytime with: ${prefix}trackopt play ${result.alias}` });
    }

    return msg.reply({ embeds: [setEmbed] });
  }

  if (subCommand === "get") {
    const rows = await trackOpts.getAllForTrack(userId, current);
    if (!rows || rows.length === 0) {
      return msg.reply({ embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.trackopt.notSet", { title: current.title }))] });
    }

    const trackDuration = p._getTrackDurationMs(current);
    const getEmbed = new EmbedBuilder()
      .setColor(getGlobalColor())
      .setAuthor({ name: "✂️ Saved Track Trims" })
      .setTitle(current.title?.slice(0, 256) || "Track Trims")
      .setFooter({ text: `${rows.length} trim profile${rows.length === 1 ? "" : "s"} saved • Apply with ${prefix}trackopt play <alias>` });

    if (current.thumbnail) getEmbed.setThumbnail(current.thumbnail);

    for (const row of rows.slice(0, 10)) {
      const aliasLabel = row.alias === DEFAULT_ALIAS ? "default (auto-apply)" : row.alias;
      const endStr = row.end_ms > 0 ? Utils.prettifyMS(row.end_ms) : "end";
      const timeline = buildTimelineBar(row.start_ms, row.end_ms, trackDuration);
      getEmbed.addFields({
        name: `🏷️ ${aliasLabel}`,
        value: `${timeline}\n${Utils.prettifyMS(row.start_ms)} ➔ ${endStr}`,
        inline: false
      });
    }

    return msg.reply({ embeds: [getEmbed] });
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
      const trackDuration = p._getTrackDurationMs(current);
      const timeline = buildTimelineBar(result.startMs, result.endMs, trackDuration);

      const playEmbed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setAuthor({ name: "✂️ Track Trim Applied" })
        .setTitle(current.title?.slice(0, 256) || "Track Trim")
        .setDescription(this.t(msg, "responses.trackopt.applied", { alias: aliasLabel, start: Utils.prettifyMS(result.startMs), end: endStr }))
        .addFields({ name: "Active Cut Range", value: timeline, inline: false });

      if (current.thumbnail) playEmbed.setThumbnail(current.thumbnail);

      return msg.reply({ embeds: [playEmbed] });
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
