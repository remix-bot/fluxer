/**
 * @module commands/pitch
 * @description Adjust real-time audio pitch (0.5× to 2.0×) using timescale DSP filters.
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/ui/index.mjs";
import { Utils } from "../src/utils/Utils.mjs";

/**
 * @type {CommandBuilder}
 * @description Command definition for the pitch command.
 */
export const command = new CommandBuilder()
    .setName("pitch")
    .setDescription("Adjust the audio pitch of the current track (0.5× to 2.0×).", "commands.pitch")
    .setCategory("music")
    .addNumberOption(o =>
        o.setName("pitch")
            .setDescription("Audio pitch multiplier between 0.5 and 2.0 (e.g. 1.25). Omit to reset to 1.0×.")
            .setRequired(false)
    )
    .addAliases("semitone", "tune");

/**
 * Run handler for the pitch command.
 *
 * @param {object} message - The command message wrapper.
 * @param {object} data - Parsed command data.
 * @returns {Promise<void>}
 */
export async function run(message, data) {
  const p = await this.getPlayer(message, false, false, false);
  if (!p) return;

  const rawPitch = data.get("pitch")?.value;
  const embed = new EmbedBuilder().setColor(getGlobalColor());

  if (rawPitch === null || rawPitch === undefined || isNaN(Number(rawPitch))) {
    const currentTimescale = p.activeFilterPayload?.timescale;
    const currentPitch = currentTimescale?.pitch ?? 1.0;
    if (currentPitch !== 1.0) {
      const existingPayload = { ...(p.activeFilterPayload || {}) };
      delete existingPayload.timescale;
      await p.applyFilter(existingPayload, Object.keys(existingPayload).length > 0 ? p.activeFilter : null);
      embed.setDescription("🎵 Audio pitch reset to normal **1.0×**.");
    } else {
      embed.setDescription(`🎵 Current audio pitch: **1.0×**.\nUse \`%pitch <0.5-2.0>\` to change pitch.`);
    }
    return message.reply({ embeds: [embed] }).catch(() => {});
  }

  const pitch = Utils.clamp(Number(rawPitch), 0.5, 2.0);

  const existingTimescale = p.activeFilterPayload?.timescale || {};
  const newTimescale = {
    ...existingTimescale,
    speed: existingTimescale.speed ?? 1.0,
    pitch,
    rate: 1.0,
  };

  const payload = {
    ...(p.activeFilterPayload || {}),
    timescale: newTimescale,
  };

  const filterMeta = {
    key: `pitch_${pitch}`,
    label: `${pitch}× Pitch`,
    emoji: pitch > 1 ? "🐿️" : "🗣️",
  };

  const res = await p.applyFilter(payload, filterMeta);
  if (!res.ok) {
    embed.setDescription(`❌ Failed to adjust pitch: ${res.reason || "Unknown error"}`);
    return message.reply({ embeds: [embed] }).catch(() => {});
  }

  embed.setDescription(`🎵 Audio pitch set to **${pitch}×**.`);
  message.reply({ embeds: [embed] }).catch(() => {});
}
