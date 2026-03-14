import { CommandBuilder } from "../src/CommandHandler.mjs";

export const command = new CommandBuilder()
  .setName("resume")
  .setDescription("Resume the playback in your voice channel", "commands.resume");

export async function run(message) {
  const p = await this.getPlayer(message);
  if (!p) return;
  const res = p.resume() || `✅ The song has been resumed!`;
  message.channel.sendEmbed(res);
}
