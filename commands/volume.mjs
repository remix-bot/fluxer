/**
 * @file volume.mjs — Set or view the playback volume
 * @module commands.volume
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";
import { MAX_VOLUME } from "../src/constants/UI.mjs";


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
 * Execute the volume command.
 * @param {import("../src/MessageHandler.mjs").Message} message - The incoming message
 * @param {Map<string, {value: *}>} data - Slash-command options map
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
