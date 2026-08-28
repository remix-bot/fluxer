/**
 * @module commands/pause
 * @description Pause the currently playing track.
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

/** @type {CommandBuilder} @description Command definition for the pause command. */
export const command = new CommandBuilder()
  .setName("pause")
  .setDescription("Pause the playback in your voice channel", "commands.pause")
  .setCategory("music");

/**
 * @async
 * Run handler for the pause command.
 * Pauses playback in the user's voice channel.
 * @param {object} message - The command message wrapper.
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
