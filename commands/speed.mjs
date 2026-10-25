/**
 * @module commands/speed
 * @description Adjust real-time playback speed (0.5× to 2.0×) using timescale DSP filters.
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
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

  const current = p.queue?.getCurrent();
  const rawRate = data.get("rate")?.value;
  const prefix = this.handler?.getPrefix?.(message.message?.guildId ?? message.guild?.id) ?? "%";
  const embed = new EmbedBuilder().setColor(0xe9196c);

  if (rawRate === null || rawRate === undefined || isNaN(Number(rawRate))) {
    const currentTimescale = p.activeFilterPayload?.timescale;
    const currentSpeed = currentTimescale?.speed ?? 1.0;
    if (currentSpeed !== 1.0) {
      const existingPayload = { ...(p.activeFilterPayload || {}) };
      delete existingPayload.timescale;
      await p.applyFilter(existingPayload, Object.keys(existingPayload).length > 0 ? p.activeFilter : null);
      embed.setAuthor({ name: `⏩ ${this.t(message, "responses.speed.speedTitle")}` })
        .setTitle("1.0× Normal")
        .setDescription(this.t(message, "responses.speed.reset"))
        .setFooter({ text: this.t(message, "responses.speed.resetHint", { prefix }) });
    } else {
      embed.setAuthor({ name: `⏩ ${this.t(message, "responses.speed.speedTitle")}` })
        .setTitle("1.0× Normal")
        .setDescription(this.t(message, "responses.speed.current", { speed: "1.0", prefix }))
        .setFooter({ text: this.t(message, "responses.speed.resetHint", { prefix }) });
    }
    return message.reply({ embeds: [embed] }).catch(() => {});
  }

  const speed = Utils.clamp(Number(rawRate), 0.5, 2.0);

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
    emoji: speed > 1 ? "⚡" : "🐢",
  };

  const res = await p.applyFilter(payload, filterMeta);
  if (!res.ok) {
    embed.setDescription(this.t(message, "responses.speed.failed", { reason: res.reason || "Unknown error" }));
    return message.reply({ embeds: [embed] }).catch(() => {});
  }

  let desc = this.t(message, "responses.speed.applied", { speed });
  if (current?.title) {
    const rawAuthor = current.artist || (typeof current.author === "object" ? current.author?.name : current.author);
    const authorStr = rawAuthor ? ` • ${rawAuthor}` : "";
    desc += `\n**${Utils.truncate(current.title, 45)}**${authorStr}`;
  }

  embed.setAuthor({ name: `⏩ ${this.t(message, "responses.speed.speedTitle")}` })
    .setTitle(this.t(message, "responses.speed.speedMultiplier", { speed }))
    .setDescription(desc)
    .setFooter({ text: this.t(message, "responses.speed.resetHint", { prefix }) });

  if (current?.thumbnail) embed.setThumbnail(current.thumbnail);

  message.reply({ embeds: [embed] }).catch(() => {});
}
