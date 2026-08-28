/**
 * @module commands/resume
 * @description Resume paused playback in the current voice channel.
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

/**
 * @type {CommandBuilder}
 * @description Command definition for the resume command.
 */
export const command = new CommandBuilder()
  .setName("resume")
  .setDescription("Resume the playback in your voice channel", "commands.resume")
  .setCategory("music");

/**
 * Run handler for the resume command.
 * Resumes playback and sends a confirmation embed.
 *
 * @param {object} message - The command message wrapper.
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
