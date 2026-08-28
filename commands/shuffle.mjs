/**
 * @module commands/shuffle
 * @description Randomly re-order the tracks in the playback queue.
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

/**
 * @type {CommandBuilder}
 * @description Command definition for the shuffle command.
 */
export const command = new CommandBuilder()
  .setName("shuffle")
  .setDescription("Re-orders the queue randomly.", "commands.shuffle")
  .setCategory("music");

/**
 * Run handler for the shuffle command.
 * Shuffles the queue and sends a confirmation embed.
 *
 * @param {object} message - The command message wrapper.
 * @returns {Promise<void>}
 */
export async function run(message) {
  const p = await this.getPlayer(message, false, true, false);
  if (!p) return;
  const res = p.shuffle();
  const embed = new EmbedBuilder()
    .setColor(getGlobalColor())
    .setDescription(res)
    ;
  message.reply({ embeds: [embed] }).catch(() => {});
}
