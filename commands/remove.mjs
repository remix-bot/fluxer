/**
 * @module commands/remove
 * @description Remove a specific track from the queue by its position.
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/ui/index.mjs";

/** @type {CommandBuilder} @description Command definition for the remove command. */
export const command = new CommandBuilder()
  .setName("remove")
  .setDescription("Remove a specific song or range of songs (e.g. `3` or `3-6`) from the queue.", "commands.remove")
  .setCategory("music")
  .addTextOption(opt =>
    opt.setName("position")
      .setDescription("The position or range of the song(s) to remove (e.g. `3` or `3-6`).", "options.remove.index")
      .setRequired(true));

/**
 * @async
 * Run handler for the remove command.
 * Removes a track or range of tracks at the specified 1-based indices from the queue.
 * @param {object} message - The command message wrapper.
 * @param {object} data - Parsed command data containing the position option.
 * @returns {Promise<void>}
 */
export async function run(message, data) {
  const p = await this.getPlayer(message, false, false, false);
  if (!p) return;
  const raw = String(data.get("position")?.value ?? "").trim();
  const prefix = this.handler?.getPrefix?.(message.message?.guildId ?? message.channel?.guildId) ?? "%";
  if (!raw) return message.replyEmbed("Please provide a queue position or range (e.g. `3` or `3-6`).").catch(() => {});

  const rangeMatch = raw.match(/^(\d+)\s*[-–—to:]+\s*(\d+)$/i) || raw.match(/^(\d+)\s+(\d+)$/);
  if (rangeMatch) {
    const from = parseInt(rangeMatch[1], 10);
    const to = parseInt(rangeMatch[2], 10);
    if (from < 1 || to < 1) return message.replyEmbed("Queue positions must be 1 or greater.").catch(() => {});
    const res = p.removeRange(from - 1, to - 1);
    if (typeof res === "string" && !res.includes("Successfully")) {
      return message.replyEmbed(res).catch(() => {});
    }
    const remaining = p.queue?.size() ?? 0;
    const count = Math.abs(to - from) + 1;
    const embed = new EmbedBuilder()
      .setColor(getGlobalColor())
      .setAuthor({ name: this.t(message, "responses.remove.removedAuthor") })
      .setTitle(this.t(message, "responses.remove.removedRangeTitle", { count }))
      .setDescription(this.t(message, "responses.remove.removedRangeDesc", { from: Math.min(from, to), to: Math.max(from, to) }))
      .setFooter({ text: this.t(message, "responses.remove.remainingFooter", { count: remaining, plural: remaining === 1 ? "" : "s", prefix }) });
    return message.reply({ embeds: [embed] }).catch(() => {});
  }

  const single = parseInt(raw, 10);
  if (isNaN(single) || single < 1) return message.replyEmbed("Queue position must be 1 or greater.").catch(() => {});
  const queueData = p.queue?.data ?? [];
  const track = queueData[single - 1];
  const res = p.remove(single - 1);
  if (typeof res === "string" && res.toLowerCase().includes("out of bounds")) {
    return message.replyEmbed(res).catch(() => {});
  }
  const remaining = p.queue?.size() ?? 0;
  const embed = new EmbedBuilder()
    .setColor(getGlobalColor())
    .setAuthor({ name: this.t(message, "responses.remove.removedAuthor") })
    .setTitle(track?.title?.slice(0, 256) || "Removed Track")
    .setDescription(this.t(message, "responses.remove.removedSingleDesc", { position: single }))
    .setFooter({ text: this.t(message, "responses.remove.remainingFooter", { count: remaining, plural: remaining === 1 ? "" : "s", prefix }) });
  if (track?.thumbnail) embed.setThumbnail(track.thumbnail);
  return message.reply({ embeds: [embed] }).catch(() => {});
}
