import { CommandBuilder } from "../src/CommandHandler.mjs";

export const command = new CommandBuilder()
  .setName("skip")
  .setDescription("Skip the current playing song.", "commands.skip");

export async function run(message) {
  const p = await this.getPlayer(message);
  if (!p) return;
  const res = p.skip() || `✅ Song skipped!`;
  message.channel.sendEmbed(res);
}
