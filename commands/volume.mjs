/**
 * @module commands/volume
 * @description Get or change the playback volume for the current voice channel.
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { MAX_VOLUME } from "../src/utils/UI.mjs";

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
  const prefix    = this.handler.getPrefix(message.message?.guildId ?? message.channel?.guildId) || "%";

  const makeVolumeBar = (pct) => {
    const bars = Math.min(15, Math.max(0, Math.round(pct / 10)));
    return "█".repeat(bars) + "░".repeat(15 - bars);
  };

  if (!volOption || raw === null || raw === undefined || isNaN(Number(raw))) {
    const current = Math.round((p.preferredVolume ?? 1) * 100);
    const bar = makeVolumeBar(current);

    const embed = new EmbedBuilder()
      .setColor(0xe9196c)
      .setAuthor({ name: `🔊 ${this.t(message, "responses.volume.currentVolume")}` })
      .setTitle(`\`${current}%\``)
      .setDescription(`\`0%\` ${bar} \`${MAX_VOLUME}%\`\n\n${this.t(message, "responses.volume.current", { volume: current })}`)
      .setFooter({ text: this.t(message, "responses.volume.volumeHint", { prefix }) });

    return message.reply({ embeds: [embed] }).catch(() => {});
  }

  const pct = Number(raw);
  if (pct < 0 || pct > MAX_VOLUME) {
    const embed = new EmbedBuilder()
      .setColor(0xe9196c)
      .setDescription(this.t(message, "responses.volume.outOfRange", { max: MAX_VOLUME }));
    return message.reply({ embeds: [embed] }).catch(() => {});
  }

  p.setVolume(pct / 100);
  const bar = makeVolumeBar(pct);

  const embed = new EmbedBuilder()
    .setColor(0xe9196c)
    .setAuthor({ name: `🔊 ${this.t(message, "responses.volume.volumeAdjusted")}` })
    .setTitle(`\`${pct}%\``)
    .setDescription(`\`0%\` ${bar} \`${MAX_VOLUME}%\`\n\n${this.t(message, "responses.volume.changed", { volume: pct })}`)
    .setFooter({ text: this.t(message, "responses.volume.volumeHint", { prefix }) });

  message.reply({ embeds: [embed] }).catch(() => {});
}
