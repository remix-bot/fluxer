/**
 * @module commands/pitch
 * @description Adjust real-time audio pitch (0.5× to 2.0×) using timescale DSP filters.
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { Utils } from "../src/utils/Utils.mjs";

/**
 * @type {CommandBuilder}
 * @description Command definition for the pitch command.
 */
export const command = new CommandBuilder()
    .setName("pitch")
    .setDescription("Adjust the pitch of the current track (0.5× to 2.0×).", "commands.pitch")
    .setCategory("music")
    .addNumberOption(o =>
        o.setName("multiplier")
            .setDescription("Pitch multiplier between 0.5 and 2.0 (e.g. 1.25). Omit to reset to 1.0×.", "options.pitch.multiplier")
            .setRequired(false)
    )
    .addAliases("key");

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

  const current = p.queue?.getCurrent();
  const rawPitch = data.get("multiplier")?.value;
  const prefix = this.handler?.getPrefix?.(message.message?.guildId ?? message.guild?.id) ?? "%";
  const embed = new EmbedBuilder().setColor(0xe9196c);

  if (rawPitch === null || rawPitch === undefined || isNaN(Number(rawPitch))) {
    const currentTimescale = p.activeFilterPayload?.timescale;
    const currentPitch = currentTimescale?.pitch ?? 1.0;
    if (currentPitch !== 1.0) {
      const existingPayload = { ...(p.activeFilterPayload || {}) };
      delete existingPayload.timescale;
      await p.applyFilter(existingPayload, Object.keys(existingPayload).length > 0 ? p.activeFilter : null);
      embed.setAuthor({ name: `🎵 ${this.t(message, "responses.pitch.pitchTitle")}` })
        .setTitle("1.0× Normal")
        .setDescription(this.t(message, "responses.pitch.reset"))
        .setFooter({ text: this.t(message, "responses.pitch.resetHint", { prefix }) });
    } else {
      embed.setAuthor({ name: `🎵 ${this.t(message, "responses.pitch.pitchTitle")}` })
        .setTitle("1.0× Normal")
        .setDescription(this.t(message, "responses.pitch.current", { pitch: "1.0", prefix }))
        .setFooter({ text: this.t(message, "responses.pitch.resetHint", { prefix }) });
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
    embed.setDescription(this.t(message, "responses.pitch.failed", { reason: res.reason || "Unknown error" }));
    return message.reply({ embeds: [embed] }).catch(() => {});
  }

  let desc = this.t(message, "responses.pitch.set", { pitch });
  if (current?.title) {
    const rawAuthor = current.artist || (typeof current.author === "object" ? current.author?.name : current.author);
    const authorStr = rawAuthor ? ` • ${rawAuthor}` : "";
    desc += `\n**${Utils.truncate(current.title, 45)}**${authorStr}`;
  }

  embed.setAuthor({ name: `🎵 ${this.t(message, "responses.pitch.pitchTitle")}` })
    .setTitle(this.t(message, "responses.pitch.pitchMultiplier", { pitch }))
    .setDescription(desc)
    .setFooter({ text: this.t(message, "responses.pitch.resetHint", { prefix }) });

  if (current?.thumbnail) embed.setThumbnail(current.thumbnail);

  message.reply({ embeds: [embed] }).catch(() => {});
}
