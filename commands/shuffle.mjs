/**
 * @file shuffle.mjs — Shuffle the current queue
 * @module commands.shuffle
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

export const command = new CommandBuilder()
  .setName("shuffle")
  .setDescription("Re-orders the queue randomly.", "commands.shuffle")
  .setCategory("music");

/**
 * Execute the shuffle command.
 * @param {import("../src/MessageHandler.mjs").Message} message - The incoming message
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
