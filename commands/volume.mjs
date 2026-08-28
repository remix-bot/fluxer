/**
 * @module commands/volume
 * @description Get or change the playback volume for the current voice channel.
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";
import { MAX_VOLUME } from "../src/constants/UI.mjs";


/**
 * @type {CommandBuilder}
 * @description Command definition for the volume command.
 */
export const command = new CommandBuilder()
    .setName("volume")
    .setDescription("Get or change the current volume.", "commands.volume")
    .setCategory("music")
    .addNumberOption(o =>
        o.setName("volume")
            .setDescription(`New volume in % (0–${MAX_VOLUME}). Omit to see the current volume.`)
            .setRequired(false)
    )
    .addAliases("v", "vol");

/**
 * Run handler for the volume command.
 * Displays the current volume or sets it to a new value.
 *
 * @param {object} message - The command message wrapper.
 * @param {object} data - Parsed command data containing the volume option.
 * @returns {Promise<void>}
 */
export async function run(message, data) {
  const p = await this.getPlayer(message, false, false, false);
  if (!p) return;

  const volOption = data.get("volume");
  const raw       = volOption?.value;

  const embed = new EmbedBuilder().setColor(getGlobalColor());

  if (!volOption || raw === null || raw === undefined || isNaN(Number(raw))) {
    const current = Math.round((p.preferredVolume ?? 1) * 100);
    embed.setDescription(this.t(message, "responses.volume.current", { volume: current }));
  } else {
    const pct = Number(raw);
    if (pct < 0 || pct > MAX_VOLUME) {
      embed.setDescription(this.t(message, "responses.volume.outOfRange", { max: MAX_VOLUME }));
    } else {
      p.setVolume(pct / 100);
      embed.setDescription(this.t(message, "responses.volume.changed", { volume: pct }));
    }
  }

  message.reply({ embeds: [embed] }).catch(() => {});
}
