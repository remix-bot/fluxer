/**
 * @module commands/clear
 * @description Remove all songs from the playback queue.
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

/**
 * @type {CommandBuilder}
 * @description Command definition for the clear command.
 */
export const command = new CommandBuilder()
  .setName("clear")
  .setDescription("Remove all songs from the queue.", "commands.clear")
  .addAliases("c")
  .setCategory("music");

/**
 * Run handler for the clear command.
 * Clears the entire queue and sends a confirmation embed.
 *
 * @param {object} msg - The command message wrapper.
 * @returns {Promise<void>}
 */
export async function run(msg) {
  const p = await this.getPlayer(msg, false, false, false);
  if (!p) return;
  p.clear();
  const embed = new EmbedBuilder()
    .setColor(getGlobalColor())
    .setDescription(this.t(msg, "responses.clear.cleared"))
    ;
  msg.reply({ embeds: [embed] }).catch(() => {});
}
