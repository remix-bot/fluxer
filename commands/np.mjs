/**
 * @file np.mjs — Show now-playing information for the current track
 * @module commands.np
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

export const command = new CommandBuilder()
    .setName("np")
    .setDescription("Request the name and url of the currently playing song.", "commands.np")
    .addAliases("current", "nowplaying");

/**
 * Execute the np command.
 * @param {import("../src/MessageHandler.mjs").Message} msg - The incoming message
 * @returns {Promise<void>}
 */
export async function run(msg) {
  const p = await this.getPlayer(msg);
  if (!p) return;

  const loadingEmbed = new EmbedBuilder()
    .setColor(getGlobalColor())
    .setDescription(this.t(msg, "responses.np.loading"))
    ;
  const loadingMsg = await msg.reply({ embeds: [loadingEmbed] });

  try {
    const data = await p.nowPlaying();
    if (!data?.msg) {
      loadingMsg.edit({ embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses._common.nothingPlaying"))] }).catch(() => {});
      return;
    }
    const embed = new EmbedBuilder()
      .setColor(getGlobalColor())
      .setDescription(data.msg);
    if (data.image) embed.setThumbnail(data.image);

    loadingMsg.edit({ embeds: [embed] }).catch(() => {});
  } catch (e) {
    loadingMsg.edit({ embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses._common.nothingPlaying"))] }).catch(() => {});
  }
}
