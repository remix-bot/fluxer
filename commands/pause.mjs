import { CommandBuilder } from "../src/CommandHandler.mjs";

export const command = new CommandBuilder()
  .setName("pause")
  .setDescription("Pause the playback in your voice channel", "commands.pause");

export async function run(message) {
  const p = await this.getPlayer(message);
  if (!p) return;
  const res = p.pause() || `✅ The song has been paused!`;
  message.channel.sendEmbed(res);
}
