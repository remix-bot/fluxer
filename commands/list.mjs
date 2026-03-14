import { CommandBuilder } from "../src/CommandHandler.mjs";

export const command = new CommandBuilder()
  .setName("list")
  .setDescription("List the songs in the queue of your current voice channel.", "commands.list")
  .addAliases("queue", "q");

export async function run(message) {
  const p = await this.getPlayer(message);
  if (!p) return;
  const messages = p.list().split("\n");
  this.pagination(
    "Current Queue:\n```\n" + ((messages.length === 1) ? "" : messages[0] + "\n\n") + "$content\n```\nPage $currPage/$maxPage",
    (messages.length === 1) ? messages : messages.slice(1),
    message,
    6
  );
}
