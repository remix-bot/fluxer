/**
 * @module commands/support
 * @description Displays a link and invitation to the bot's support server.
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

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
  const embed = new EmbedBuilder()
    .setColor(getGlobalColor())
    .setTitle(this.t(msg, "responses.support.title"))
    .setDescription(
      this.t(msg, "responses.support.description")
    )
    ;
  msg.reply({ embeds: [embed] }).catch(() => {});
}
