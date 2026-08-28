/**
 * @module commands/np
 * @description Display the currently playing track name and URL.
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

/** @type {CommandBuilder} @description Command definition for the np (now playing) command. */
export const command = new CommandBuilder()
    .setName("np")
    .setDescription("Request the name and url of the currently playing song.", "commands.np")
    .addAliases("current", "nowplaying")
    .setCategory("music");

/**
 * @async
 * Run handler for the np command.
 * Fetches and displays the now-playing status with track title and thumbnail.
 * @param {object} msg - The command message wrapper.
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
