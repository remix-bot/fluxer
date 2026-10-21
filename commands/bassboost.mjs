/**
 * @module commands/bassboost
 * @description Quick equalizer bass boost filter with low, medium, and hard presets.
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/ui/index.mjs";

export const BASSBOOST_PRESETS = {
  low: {
    label: "Low",
    equalizer: [
      { band: 0, gain: 0.25 },
      { band: 1, gain: 0.20 },
      { band: 2, gain: 0.15 },
      { band: 3, gain: 0.10 },
    ],
  },
  medium: {
    label: "Medium",
    equalizer: [
      { band: 0,  gain:  0.60 },
      { band: 1,  gain:  0.70 },
      { band: 2,  gain:  0.50 },
      { band: 3,  gain:  0.25 },
      { band: 4,  gain:  0.00 },
      { band: 5,  gain: -0.25 },
      { band: 6,  gain: -0.45 },
      { band: 7,  gain: -0.55 },
      { band: 8,  gain: -0.60 },
    ],
  },
  hard: {
    label: "Hard",
    equalizer: [
      { band: 0,  gain:  1.00 },
      { band: 1,  gain:  1.10 },
      { band: 2,  gain:  0.80 },
      { band: 3,  gain:  0.50 },
      { band: 4,  gain:  0.25 },
      { band: 5,  gain: -0.20 },
      { band: 6,  gain: -0.45 },
      { band: 7,  gain: -0.65 },
      { band: 8,  gain: -0.80 },
    ],
  },
};

/**
 * @type {CommandBuilder}
 * @description Command definition for the bassboost command.
 */
export const command = new CommandBuilder()
    .setName("bassboost")
    .setDescription("Apply a low, medium, or hard bass boost equalizer effect.", "commands.bassboost")
    .setCategory("music")
    .addStringOption(o =>
        o.setName("level")
            .setDescription("Bass boost level: 'low', 'medium', 'hard', or 'off'.")
            .setRequired(false)
            .addChoices(
                { name: "low", value: "low" },
                { name: "medium", value: "medium" },
                { name: "hard", value: "hard" },
                { name: "off", value: "off" }
            )
    )
    .addAliases("bb", "bass");

/**
 * Run handler for the bassboost command.
 *
 * @param {object} message - The command message wrapper.
 * @param {object} data - Parsed command data.
 * @returns {Promise<void>}
 */
export async function run(message, data) {
  const p = await this.getPlayer(message, false, false, false);
  if (!p) return;

  const levelArg = data.get("level")?.value?.toLowerCase() || "medium";

  const embed = new EmbedBuilder().setColor(getGlobalColor());

  if (levelArg === "off" || levelArg === "none" || levelArg === "reset") {
    await p.applyFilter({}, null);
    embed.setDescription("🔇 Bass boost disabled — restored original audio balance.");
    return message.reply({ embeds: [embed] }).catch(() => {});
  }

  const preset = BASSBOOST_PRESETS[levelArg] || BASSBOOST_PRESETS.medium;
  const filterMeta = {
    key: `bassboost_${levelArg}`,
    label: `Bass Boost (${preset.label})`,
    emoji: "🔊",
  };

  const res = await p.applyFilter({ equalizer: preset.equalizer }, filterMeta);
  if (!res.ok) {
    embed.setDescription(`❌ Failed to apply bass boost: ${res.reason || "Unknown error"}`);
    return message.reply({ embeds: [embed] }).catch(() => {});
  }

  embed.setDescription(`🔊 Applied **Bass Boost (${preset.label})**! Real-time equalizer active.`);
  message.reply({ embeds: [embed] }).catch(() => {});
}
