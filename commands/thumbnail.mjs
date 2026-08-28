/**
 * @module commands/thumbnail
 * @description Display the thumbnail artwork of the currently playing track.
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

/** @type {CommandBuilder} @description Command definition for the thumbnail command. */
export const command = new CommandBuilder()
    .setName("thumbnail")
    .setDescription("Request the thumbnail of the currently playing song.", "commands.thumbnail")
    .addAliases("thumb")
    .setCategory("music");

/**
 * @async
 * Run handler for the thumbnail command.
 * Fetches and displays the thumbnail of the currently playing track.
 * @param {object} msg - The command message wrapper.
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
