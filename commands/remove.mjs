/**
 * @module commands/remove
 * @description Remove a specific track from the queue by its position.
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";

/** @type {CommandBuilder} @description Command definition for the remove command. */
export const command = new CommandBuilder()
  .setName("remove")
  .setDescription("Remove a specific song from the queue.", "commands.remove")
  .setCategory("music")
  .addNumberOption(opt =>
    opt.setName("index")
      .setDescription("The position of the song in the queue. You can view the indices with the 'list' command", "options.remove.index")
      .setRequired(true));

/**
 * @async
 * Run handler for the remove command.
 * Removes a track at the specified 1-based index from the queue.
 * @param {object} message - The command message wrapper.
 * @param {object} data - Parsed command data containing the index option.
 * @returns {Promise<void>}
 */
export async function run(message, data) {
  const p = await this.getPlayer(message, false, false, false);
  if (!p) return;
  const index = data.get("index")?.value;
  if (index === null || index === undefined || index < 1) return message.replyEmbed("Queue position must be 1 or greater.").catch(() => {});
  const res = p.remove(index - 1);
  message.replyEmbed(res).catch(() => {});
}
