/**
 * @file clear command — Remove all songs from the queue
 * @module commands/clear
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

export const command = new CommandBuilder()
  .setName("clear")
  .setDescription("Remove all songs from the queue.", "commands.clear")
  .addAliases("c")
  .setCategory("music");

/**
 * Execute the clear command.
 * @param {import("../src/MessageHandler.mjs").Message} msg - The incoming message
 * @param {Map<string, {value: *}>} data - Slash-command options map
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
