import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

export const command = new CommandBuilder()
  .setName("login")
  .setDescription("Confirm a login of your account on the website", "commands.login")
  .setCategory("util")
  .addStringOption(o =>
    o.setName("id")
      .setDescription("The id you got from logging in at the dashboard.", "options.login.id")
      .setRequired(true));

export async function run(msg, data) {
  const code = data.get("id").value;

  if (!this.dashboard?.enabled) {
    const embed = new EmbedBuilder().setColor(getGlobalColor()).setDescription("❌ The dashboard is not enabled on this bot.").toJSON();
    return msg.replyEmbed({ embeds: [embed] });
  }

  const error = await this.dashboard.confirmLogin(msg.author.id, code);
  const desc = (error === null)
    ? "✅ Login succeeded! You can continue to the webpage now."
    : "❌ Login failed! Reason: `" + error + "`. If this is an error and the issue persists, please contact a team member through the server in my description.";

  const embed = new EmbedBuilder().setColor(getGlobalColor()).setDescription(desc).toJSON();
  msg.replyEmbed({ embeds: [embed] });
}
