/**
 * @module commands/normalize
 * @description Toggle dynamic volume normalization & ReplayGain leveling (EBU R128 standard).
 * Prevents ear-blasting volume differences between YouTube, Spotify, and SoundCloud.
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/ui/index.mjs";
import { calculateNormalizationGain, detectTrackSource } from "../src/music/audio/VolumeNormalizer.mjs";

/**
 * @type {CommandBuilder}
 * @description Command definition for the normalize command.
 */
export const command = new CommandBuilder()
    .setName("normalize")
    .setDescription("Toggle dynamic volume normalization (ReplayGain leveling) across music sources.", "commands.normalize")
    .setCategory("music")
    .addStringOption(o =>
        o.setName("state")
            .setDescription("Turn on/off or check status ('on', 'off', 'status'). Omit to toggle.")
            .setRequired(false)
            .addChoices(
                { name: "on", value: "on" },
                { name: "off", value: "off" },
                { name: "status", value: "status" }
            )
    )
    .addAliases("replaygain", "volumenormalize", "norm");

/**
 * Run handler for the normalize command.
 *
 * @param {object} message - The command message wrapper.
 * @param {object} data - Parsed command data.
 * @returns {Promise<void>}
 */
export async function run(message, data) {
  const p = await this.getPlayer(message, false, false, false);
  const guildSettings = this.getSettings ? this.getSettings(message) : null;
  const currentSetting = guildSettings?.get ? (guildSettings.get("normalize") ?? true) : true;

  const stateArg = data.get("state")?.value?.toLowerCase();
  let newState;

  if (stateArg === "status") {
    newState = currentSetting;
  } else if (stateArg === "on" || stateArg === "enable" || stateArg === "true") {
    newState = true;
  } else if (stateArg === "off" || stateArg === "disable" || stateArg === "false") {
    newState = false;
  } else {
    // Toggle
    newState = !currentSetting;
  }

  if (stateArg !== "status") {
    if (guildSettings?.set) {
      guildSettings.set("normalize", newState);
    }
    if (p) {
      p.volumeNormalization = newState;
      if (p._voiceConn) {
        try {
          p._voiceConn.setVolume(p.getEffectiveVolume());
        } catch (_) {}
      }
    }
  }

  const embed = new EmbedBuilder().setColor(getGlobalColor());
  const statusEmoji = newState ? "🔊" : "🔇";
  const statusText = newState ? "**Enabled**" : "**Disabled**";

  let desc = `${statusEmoji} Volume normalization (ReplayGain) is currently ${statusText} for this server.\n\n` +
      `*When enabled, playback loudness is dynamically leveled to the international -14 LUFS standard so quiet acoustic songs and loud EDM/SoundCloud tracks play at a balanced listening volume.*`;

  if (p) {
    const current = p.queue?.getCurrent?.();
    if (current) {
      const source = detectTrackSource(current);
      const gain = calculateNormalizationGain(current);
      const gainDb = (20 * Math.log10(gain)).toFixed(1);
      const gainSign = gain >= 1 ? "+" : "";
      desc += `\n\n**Current Track Info:**\n` +
          `• Source: \`${source}\`\n` +
          `• Gain adjustment: \`${gainSign}${gainDb} dB\` (${(gain * 100).toFixed(0)}%)\n` +
          `• Effective volume: \`${Math.round(p.getEffectiveVolume())}%\``;
    }
  }

  message.reply({ embeds: [embed.setDescription(desc)] }).catch(() => {});
}
