import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

export const command = new CommandBuilder()
  .setName("remove")
  .setDescription("Remove a specific song from the queue.", "commands.remove")
  .setCategory("music")
  .addNumberOption(opt =>
    opt.setName("index")
      .setDescription("The position of the song in the queue. You can view the indices with the 'list' command", "options.remove.index")
      .setRequired(true));

export async function run(message, data) {
  const p = await this.getPlayer(message, false, false, false);
  if (!p) return;
  const res = p.remove(data.options[0].value);
  const embed = new EmbedBuilder()
    .setColor(getGlobalColor())
    .setDescription(res)
    .toJSON();
  message.replyEmbed({ embeds: [embed] });
}
