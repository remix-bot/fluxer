/**
 * @module commands/speed
 * @description Adjust real-time playback speed (0.5× to 2.0×) using timescale DSP filters.
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/ui/index.mjs";
import { Utils } from "../src/utils/Utils.mjs";

/**
 * @type {CommandBuilder}
 * @description Command definition for the speed command.
 */
export const command = new CommandBuilder()
    .setName("speed")
    .setDescription("Adjust the playback speed of the current track (0.5× to 2.0×).", "commands.speed")
    .setCategory("music")
    .addNumberOption(o =>
        o.setName("rate")
            .setDescription("Playback speed multiplier between 0.5 and 2.0 (e.g. 1.25). Omit to reset to 1.0×.", "options.speed.rate")
            .setRequired(false)
    )
    .addAliases("rate", "tempo");

/**
 * Run handler for the speed command.
 *
 * @param {object} message - The command message wrapper.
 * @param {object} data - Parsed command data.
 * @returns {Promise<void>}
 */
export async function run(message, data) {
  const p = await this.getPlayer(message, false, false, false);
  if (!p) return;

  const rawRate = data.get("rate")?.value;
  const embed = new EmbedBuilder().setColor(getGlobalColor());

  if (rawRate === null || rawRate === undefined || isNaN(Number(rawRate))) {
    // Reset to 1.0 or show current speed
    const currentTimescale = p.activeFilterPayload?.timescale;
    const currentSpeed = currentTimescale?.speed ?? 1.0;
    if (currentSpeed !== 1.0) {
      // Reset
      const existingPayload = { ...(p.activeFilterPayload || {}) };
      delete existingPayload.timescale;
      await p.applyFilter(existingPayload, Object.keys(existingPayload).length > 0 ? p.activeFilter : null);
      embed.setDescription(this.t(message, "responses.speed.reset"));
    } else {
      const prefix = this.handler?.getPrefix?.(message.message?.guildId ?? message.guild?.id) ?? "%";
      embed.setDescription(this.t(message, "responses.speed.current", { speed: "1.0", prefix }));
    }
    return message.reply({ embeds: [embed] }).catch(() => {});
  }

  const speed = Utils.clamp(Number(rawRate), 0.5, 2.0);

  // Preserve other active filters if present, update only timescale speed
  const existingTimescale = p.activeFilterPayload?.timescale || {};
  const newTimescale = {
    ...existingTimescale,
    speed,
    pitch: existingTimescale.pitch ?? 1.0,
    rate: 1.0,
  };

  const payload = {
    ...(p.activeFilterPayload || {}),
    timescale: newTimescale,
  };

  const filterMeta = {
    key: `speed_${speed}`,
    label: `${speed}× Speed`,
    emoji: speed > 1 ? "⏩" : "🐢",
  };

  const res = await p.applyFilter(payload, filterMeta);
  if (!res.ok) {
    embed.setDescription(this.t(message, "responses.speed.failed", { reason: res.reason || "Unknown error" }));
    return message.reply({ embeds: [embed] }).catch(() => {});
  }

  embed.setDescription(this.t(message, "responses.speed.set", { emoji: speed > 1 ? "⏩" : "🐢", speed }));
  message.reply({ embeds: [embed] }).catch(() => {});
}
