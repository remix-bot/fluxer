/**
 * @module commands/support
 * @description Displays a link and invitation to the bot's support server.
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/ui/index.mjs";

/** @type {CommandBuilder} @description Command definition for the support command. */
export const command = new CommandBuilder()
  .setName("support")
  .setDescription("The support server for Remix. Feel free to ask help, report bugs or just chat :)", "commands.support")
  .addAliases("server")
  .setCategory("util");

/**
 * Run handler for the support command.
 * Sends an embed with the support server link.
 * @param {object} msg - The command message wrapper.
 * @returns {void}
 */
export function run(msg) {
  const botUser = this.client?.user;
  const botIcon = botUser?.displayAvatarURL?.() || null;

  const embed = new EmbedBuilder()
    .setColor(getGlobalColor())
    .setAuthor({
      name: "Remix Support Community",
      iconURL: botIcon
    })
    .setTitle(this.t(msg, "responses.support.title"))
    .setDescription(
      "Need help, want to report a bug, or suggest a new feature? Join our official community server:\n\n" +
      "🚀 **[Join Support Server (fluxer.gg/remix)](https://fluxer.gg/remix)**\n\n" +
      "🟢 **24/7 Community & Staff Assistance**\n" +
      "Feature requests, announcements, and audio troubleshooting guides."
    )
    .setFooter({ text: "Remix Support • fluxer.gg/remix" });

  if (botIcon) embed.setThumbnail(botIcon);
  msg.reply({ embeds: [embed] }).catch(() => {});
}
