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
    const embed = new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.login.dashboardDisabled"));
    return msg.reply({ embeds: [embed] });
  }

  const error = await this.dashboard.confirmLogin(msg.author.id, code);
  const desc = (error === null)
    ? this.t(msg, "responses.login.success")
    : this.t(msg, "responses.login.failed", { error });

  const embed = new EmbedBuilder().setColor(getGlobalColor()).setDescription(desc);
  msg.reply({ embeds: [embed] });
}
