import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

const MAX_VOLUME = 200;

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

export async function run(message, data) {
  const p = await this.getPlayer(message, false, false, false);
  if (!p) return;

  const volOption = data.get("volume");
  const raw       = volOption?.value;

  const embed = new EmbedBuilder().setColor(getGlobalColor());

  if (!volOption || raw == null || isNaN(Number(raw))) {
    const current = Math.round((p.preferredVolume ?? 1) * 100);
    embed.setDescription(`🔊 Current volume: \`${current}%\``);
  } else {
    const pct = Number(raw);
    if (pct < 0 || pct > MAX_VOLUME) {
      embed.setDescription(`❌ Volume must be between \`0\` and \`${MAX_VOLUME}%\`.`);
    } else {
      p.setVolume(pct / 100);
      embed.setDescription(`🔊 Volume changed to \`${pct}%\` for this session.`);
    }
  }

  message.replyEmbed({ embeds: [embed.toJSON()] });
}
