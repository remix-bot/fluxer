/**
 * @file thumbnail.mjs — Get the thumbnail image for the current or specified track
 * @module commands.thumbnail
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

export const command = new CommandBuilder()
    .setName("thumbnail")
    .setDescription("Request the thumbnail of the currently playing song.", "commands.thumbnail")
    .addAliases("thumb")
    .setCategory("music");

/**
 * Execute the thumbnail command.
 * @param {import("../src/MessageHandler.mjs").Message} msg - The incoming message
 * @returns {Promise<void>}
 */
export async function run(msg) {
  const p = await this.getPlayer(msg);
  if (!p) return;
  const data = await p.getThumbnail();

  const embed = new EmbedBuilder()
    .setColor(getGlobalColor())
    .setDescription(data.msg);
  if (data.image) embed.setImage(data.image);

  msg.reply({ embeds: [embed] }).catch(() => {});
}
