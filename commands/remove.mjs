/**
 * @file remove.mjs — Remove a specific song from the queue by position
 * @module commands.remove
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";

export const command = new CommandBuilder()
  .setName("remove")
  .setDescription("Remove a specific song from the queue.", "commands.remove")
  .setCategory("music")
  .addNumberOption(opt =>
    opt.setName("index")
      .setDescription("The position of the song in the queue. You can view the indices with the 'list' command", "options.remove.index")
      .setRequired(true));

/**
 * Execute the remove command.
 * @param {import("../src/MessageHandler.mjs").Message} message - The incoming message
 * @param {Map<string, {value: *}>>} data - Slash-command options map
 * @returns {Promise<void>}
 */
export async function run(message, data) {
  const p = await this.getPlayer(message, false, false, false);
  if (!p) return;
  const index = data.get("index")?.value;
  if (index == null || index < 1) return message.replyEmbed("Queue position must be 1 or greater.").catch(() => {});
  const res = p.remove(index - 1);
  message.replyEmbed(res).catch(() => {});
}
