/**
 * @file pause.mjs — Pause the current playback
 * @module commands.pause
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

export const command = new CommandBuilder()
  .setName("pause")
  .setDescription("Pause the playback in your voice channel", "commands.pause")
  .setCategory("music");

/**
 * Execute the pause command.
 * @param {import("../src/MessageHandler.mjs").Message} message - The incoming message
 * @returns {Promise<void>}
 */
export async function run(message) {
  const p = await this.getPlayer(message);
  if (!p) return;
  const res = p.pause();
  const embed = new EmbedBuilder()
    .setColor(getGlobalColor())
    .setDescription(res)
    ;
  message.reply({ embeds: [embed] }).catch(() => {});
}
