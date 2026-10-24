/**
 * @module commands/clear
 * @description Remove all songs from the playback queue.
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/ui/index.mjs";

/**
 * @type {CommandBuilder}
 * @description Command definition for the clear command.
 */
export const command = new CommandBuilder()
  .setName("clear")
  .setDescription("Remove all songs, or a slice of songs, from the queue.", "commands.clear")
  .addAliases("c")
  .setCategory("music")
  .addNumberOption(o =>
    o.setName("from")
      .setDescription("Starting queue position to clear from (optional, 1-based).")
      .setRequired(false)
  )
  .addNumberOption(o =>
    o.setName("to")
      .setDescription("Ending queue position to clear to (optional, 1-based).")
      .setRequired(false)
  );

/**
 * Run handler for the clear command.
 * Clears the entire queue, or a specified range of tracks, and sends a confirmation embed.
 *
 * @param {object} msg - The command message wrapper.
 * @param {object} [data] - Parsed options.
 * @returns {Promise<void>}
 */
export async function run(msg, data) {
  const p = await this.getPlayer(msg, false, false, false);
  if (!p) return;

  const rawFrom = data?.get?.("from")?.value;
  const rawTo = data?.get?.("to")?.value;
  const fromVal = (typeof rawFrom === "number" && Number.isFinite(rawFrom)) ? rawFrom : null;
  const toVal = (typeof rawTo === "number" && Number.isFinite(rawTo)) ? rawTo : null;

  if (fromVal !== null) {
    if (fromVal < 1) return msg.replyEmbed("Queue position must be 1 or greater.").catch(() => {});
    const startIdx = Math.floor(fromVal) - 1;
    const endIdx = (toVal !== null && toVal >= 1) ? Math.floor(toVal) - 1 : startIdx;
    const res = p.removeRange(startIdx, endIdx);
    return msg.replyEmbed(res).catch(() => {});
  }

  p.clear();
  const embed = new EmbedBuilder()
    .setColor(getGlobalColor())
    .setDescription(this.t(msg, "responses.clear.cleared"))
    ;
  msg.reply({ embeds: [embed] }).catch(() => {});
}
