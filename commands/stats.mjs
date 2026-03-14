import { CommandBuilder } from "../src/CommandHandler.mjs";
import { Utils } from "../src/Utils.mjs";

export const command = new CommandBuilder()
  .setName("stats")
  .setDescription("Display stats about the bot like the uptime.", "commands.stats")
  .addAliases("info")
  .setCategory("util");

export async function run(message) {
  const reason = this.config.restart ? "🪛 Cause for last restart: `" + this.config.restart + "`\n" : "";
  const version = "🏦 Build: [`" + this.comHash + "`](" + this.comLink + ") 🔗";
  const time = Utils.prettifyMS(Math.round(process.uptime()) * 1000);
  const footer = this.config.customStatsFooter || "";
  const guildCount = this.client.guilds.cache.size;
  const playerCount = this.players.playerMap.size;
  const users = this.config.fetchUsers ? `\n👤 User Count: \`${this.client.users.cache.size}\`` : "";

  const start = Date.now();
  const msg = await message.channel.sendEmbed(
    `__**Stats:**__\n\n📂 Server Count: \`${guildCount}\`${users}\n📣 Player Count: \`${playerCount}\`\n🏓 Ping: \`...\`\n⌛ Uptime: \`${time}\`\n${reason}${version}${footer}`
  );
  const ping = Date.now() - start;
  msg.editEmbed(
    `__**Stats:**__\n\n📂 Server Count: \`${guildCount}\`${users}\n📣 Player Count: \`${playerCount}\`\n🏓 Ping: \`${ping}ms\`\n⌛ Uptime: \`${time}\`\n${reason}${version}${footer}`
  );
}
