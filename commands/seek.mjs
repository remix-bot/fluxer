/**
 * @file seek.mjs — Seek to a specific position in the current track
 * @module commands.seek
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";
import { Utils } from "../src/Utils.mjs";
import { ERROR_COLOR } from "../src/constants/UI.mjs";

export const command = new CommandBuilder()
  .setName("seek")
  .setDescription("Seek to a specific position in the current track.", "commands.seek")
  .setCategory("music")
  .addTextOption(o =>
    o.setName("position")
      .setDescription("Position to seek to (e.g. 1:30, 90, or 1:30:00 for hours)")
      .setRequired(true)
  );

/**
 * Execute the seek command.
 * @param {import("../src/MessageHandler.mjs").Message} msg - The incoming message
 * @param {Map<string, {value: *}>} data - Slash-command options map
 * @returns {Promise<void>}
 */
export async function run(msg, data) {
  const positionInput = data.get("position")?.value;

  const p = await this.getPlayer(msg, true, true, false);
  if (!p) return;

  if (!p.queue?.getCurrent()) {
    return msg.reply({ embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.seek.nothingPlaying"))] });
  }

  if (p._paused) {
    return msg.reply({ embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.seek.paused"))] });
  }

  let seekMs = Utils.parseDuration(positionInput);
  if (!seekMs || seekMs < 0) {
    return msg.reply({ embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.seek.invalidFormat"))] });
  }

  const trackDuration = p._getTrackDurationMs(p.queue.getCurrent());

  if (trackDuration > 0 && seekMs >= trackDuration) {
    const maxStr = Utils.prettifyMS(trackDuration);
    return msg.reply({ embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.seek.exceedsDuration", { duration: maxStr }))] });
  }

  try {
    const result = await p.seekToPosition(seekMs);
    if (result) {
      const seekStr = Utils.prettifyMS(seekMs);
      return msg.reply({ embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.seek.seeked", { position: seekStr }))] });
    } else {
      return msg.reply({ embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.seek.notSupported"))] });
    }
  } catch (err) {
    return msg.reply({ embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.seek.failed", { error: err.message }))] });
  }
}
