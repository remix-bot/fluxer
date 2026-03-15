import { CommandBuilder } from "../src/CommandHandler.mjs";

export const command = new CommandBuilder()
  .setName("servers")
  .setDescription("Fetch a list of servers the bot is in")
  .setRequirement(r => r.setOwnerOnly(true));

export function run(msg) {
  const m = [...this.client.guilds.cache.values()].map(e => "\"" + e.name).join("\"\n");
  this.pagination("```js\n$content\n```\n\nPage $currPage/$maxPage", m, msg, 10);
}
