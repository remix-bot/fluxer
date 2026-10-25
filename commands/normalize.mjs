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
    .addChoiceOption(o =>
        o.setName("state")
            .setDescription("Turn on/off or check status ('on', 'off', 'status'). Omit to toggle.", "options.normalize.state")
            .addChoices("on", "off", "status")
            .setRequired(false)
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

  const embed = new EmbedBuilder()
    .setColor(getGlobalColor())
    .setAuthor({ name: "🎚️ Dynamic Loudness Normalization" })
    .setTitle("EBU R128 Audio Leveling")
    .setFooter({ text: "Balances volume differences across YouTube, Spotify & SoundCloud" });

  const statusMsg = newState
      ? this.t(message, "responses.normalize.statusEnabled")
      : this.t(message, "responses.normalize.statusDisabled");
  const infoMsg = this.t(message, "responses.normalize.info");

  embed.setDescription(`${statusMsg}\n\n*${infoMsg}*`);

  if (p) {
    const current = p.queue?.getCurrent?.();
    if (current) {
      const source = detectTrackSource(current);
      const gain = calculateNormalizationGain(current);
      const gainDb = (20 * Math.log10(gain)).toFixed(1);
      const gainSign = gain >= 1 ? "+" : "";

      embed.addFields(
        { name: "Track Source", value: source || "Default", inline: true },
        { name: "Gain Offset", value: `${gainSign}${gainDb} dB (${(gain * 100).toFixed(0)}%)`, inline: true },
        { name: "Effective Volume", value: `${Math.round(p.getEffectiveVolume())}%`, inline: true }
      );
    }
  }

  message.reply({ embeds: [embed] }).catch(() => {});
}
