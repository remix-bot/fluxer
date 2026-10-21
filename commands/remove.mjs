/**
 * @module commands/remove
 * @description Remove a specific track from the queue by its position.
 */

import { CommandBuilder } from "../src/commands/index.mjs";

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
  if (!raw) return message.replyEmbed("Please provide a queue position or range (e.g. `3` or `3-6`).").catch(() => {});

  const rangeMatch = raw.match(/^(\d+)\s*[-–—to:]+\s*(\d+)$/i) || raw.match(/^(\d+)\s+(\d+)$/);
  if (rangeMatch) {
    const from = parseInt(rangeMatch[1], 10);
    const to = parseInt(rangeMatch[2], 10);
    if (from < 1 || to < 1) return message.replyEmbed("Queue positions must be 1 or greater.").catch(() => {});
    const res = p.removeRange(from - 1, to - 1);
    return message.replyEmbed(res).catch(() => {});
  }

  const single = parseInt(raw, 10);
  if (isNaN(single) || single < 1) return message.replyEmbed("Queue position must be 1 or greater.").catch(() => {});
  const res = p.remove(single - 1);
  message.replyEmbed(res).catch(() => {});
}
