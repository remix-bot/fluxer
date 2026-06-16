/**
 * @file move.mjs — Move a track from one position to another in the queue
 * @module commands.move
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";

export const command = new CommandBuilder()
  .setName("move")
  .setDescription("Move a track from one position to another in the queue.", "commands.move")
  .setCategory("music")
  .addAliases("mv", "m")
  .addNumberOption(o =>
    o.setName("from")
      .setDescription("The current position of the track in the queue. You can view the indices with the 'list' command.", "options.move.from")
      .setRequired(true)
  )
  .addNumberOption(o =>
    o.setName("to")
      .setDescription("The target position to move the track to in the queue.", "options.move.to")
      .setRequired(true)
  );

/**
 * Execute the move command.
 * @param {import("../src/MessageHandler.mjs").Message} message - The incoming message
 * @param {Map<string, {value: *}>} data - Slash-command options map
 * @returns {Promise<void>}
 */
export async function run(message, data) {
  const p = await this.getPlayer(message, false, false, false);
  if (!p) return;
  const from = data.get("from")?.value;
  const to = data.get("to")?.value;
  if (from === null || from === undefined || from < 1) return message.replyEmbed("Source position must be 1 or greater.").catch(() => {});
  if (to === null || to === undefined || to < 1) return message.replyEmbed("Target position must be 1 or greater.").catch(() => {});
  const res = p.move(from, to);
  message.replyEmbed(res).catch(() => {});
}
