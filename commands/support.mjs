/**
 * @file support.mjs — Show support server invite link
 * @module commands.support
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

export const command = new CommandBuilder()
  .setName("support")
  .setDescription("The support server for Remix. Feel free to ask help, report bugs or just chat :)", "commands.support")
  .addAliases("server")
  .setCategory("util");

/**
 * run function.
 * @param {{*}} msg
 * @returns {*}
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
