/**
 * @file resume.mjs — Resume paused playback
 * @module commands.resume
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

export const command = new CommandBuilder()
  .setName("resume")
  .setDescription("Resume the playback in your voice channel", "commands.resume")
  .setCategory("music");

/**
 * Execute the resume command.
 * @param {import("../src/MessageHandler.mjs").Message} message - The incoming message
 * @returns {Promise<void>}
 */
export async function run(message) {
  const p = await this.getPlayer(message, false, true, false);
  if (!p) return;
  const res = p.resume();
  const embed = new EmbedBuilder()
    .setColor(getGlobalColor())
    .setDescription(res)
    ;
  message.reply({ embeds: [embed] }).catch(() => {});
}
