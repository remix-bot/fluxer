import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

export const command = new CommandBuilder()
  .setName("clear")
  .setDescription("Remove all songs from the queue.", "commands.clear")
  .addAliases("c")
  .setCategory("music");

export async function run(msg) {
  const p = await this.getPlayer(msg, false, false, false);
  if (!p) return;
  p.clear();
  const embed = new EmbedBuilder()
    .setColor(getGlobalColor())
    .setDescription("🗑️ Queue cleared.")
    .toJSON();
  msg.replyEmbed({ embeds: [embed] });
}
