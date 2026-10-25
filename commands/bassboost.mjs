/**
 * @module commands/bassboost
 * @description Quick equalizer bass boost filter with low, medium, and hard presets.
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { Utils } from "../src/utils/Utils.mjs";

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
    .addChoiceOption(o =>
        o.setName("level")
            .setDescription("Bass boost level: 'low', 'medium', 'hard', or 'off'.", "options.bassboost.level")
            .addChoices("low", "medium", "hard", "off")
            .setDefault("medium")
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

  const current = p.queue?.getCurrent();
  const levelArg = data.get("level")?.value?.toLowerCase() || "medium";
  const prefix = this.handler.getPrefix(message.message?.guildId ?? message.channel?.guildId) || "%";

  const embed = new EmbedBuilder().setColor(0xe9196c);

  if (levelArg === "off" || levelArg === "none" || levelArg === "reset") {
    await p.applyFilter({}, null);
    embed.setAuthor({ name: `🔊 ${this.t(message, "responses.bassboost.eqTitle")}` })
      .setTitle("⏹️ Bass Boost Off")
      .setDescription(this.t(message, "responses.bassboost.disabled"))
      .setFooter({ text: `${prefix}bassboost <low|medium|hard>` });
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
    embed.setDescription(this.t(message, "responses.bassboost.failed", { reason: res.reason || "Unknown error" }));
    return message.reply({ embeds: [embed] }).catch(() => {});
  }

  let desc = this.t(message, "responses.bassboost.applied", { level: preset.label });
  if (current?.title) {
    const rawAuthor = current.artist || (typeof current.author === "object" ? current.author?.name : current.author);
    const authorStr = rawAuthor ? ` • ${rawAuthor}` : "";
    desc += `\n**${Utils.truncate(current.title, 45)}**${authorStr}`;
  }

  const subBassText = this.t(message, "responses.bassboost.subBass") || "Sub-Bass";
  const midBassText = this.t(message, "responses.bassboost.midBass") || "Mid-Bass";
  const highText    = this.t(message, "responses.bassboost.high") || "High";

  const gainSub = levelArg === "hard" ? "+1.10 dB" : levelArg === "low" ? "+0.25 dB" : "+0.70 dB";
  const gainMid = levelArg === "hard" ? "+0.80 dB" : levelArg === "low" ? "+0.15 dB" : "+0.50 dB";
  const gainHigh = levelArg === "hard" ? "-0.80 dB" : levelArg === "low" ? "+0.00 dB" : "-0.65 dB";

  desc += `\n\n` + "`" + `${subBassText}: ${gainSub} │ ${midBassText}: ${gainMid} │ ${highText}: ${gainHigh}` + "`";

  embed
    .setAuthor({ name: `🔊 ${this.t(message, "responses.bassboost.eqTitle")}` })
    .setTitle(`Bass Boost: ${preset.label}`)
    .setDescription(desc)
    .setFooter({ text: this.t(message, "responses.bassboost.resetHint", { prefix }) });

  if (current?.thumbnail) {
    embed.setThumbnail(current.thumbnail);
  }

  message.reply({ embeds: [embed] }).catch(() => {});
}
