import { CommandBuilder } from "../src/CommandHandler.mjs";

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
  const index = data.get("index")?.value;
  if (index == null) return message.reply("Please provide a valid queue position.");
  const res = p.remove(index - 1);
  message.replyEmbed(res);
}
