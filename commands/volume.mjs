import { CommandBuilder } from "../src/CommandHandler.mjs";

export const command = new CommandBuilder()
  .setName("volume")
  .setDescription("Change the current volume.", "commands.volume")
  .addNumberOption(o =>
    o.setName("volume")
      .setDescription("The new volume in percentages (e.g. `30` or `100`). If you go above 100% there might be quality loss.", "options.volume.volume")
      .setRequired(true)
  )
  .addAliases("v", "vol");

export async function run(message, data) {
  const p = await this.getPlayer(message);
  if (!p) return;
  const res = p.setVolume(data.get("volume").value / 100);
  message.channel.sendEmbed(res);
}
