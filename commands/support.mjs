import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

export const command = new CommandBuilder()
  .setName("support")
  .setDescription("The support server for Remix. Feel free to ask help, report bugs or just chat :)", "commands.support")
  .addAliases("server")
  .setCategory("util");

export function run(msg) {
  const embed = new EmbedBuilder()
    .setColor(getGlobalColor())
    .setTitle("💬 Support")
    .setDescription(
      "For anything regarding Remix, head over to our server:\n" +
      "[Remix HQ](https://fluxer.gg/remix)\n\n" +
      "If you don't want to join, feel free to contact the team members listed in the server."
    )
    .toJSON();
  msg.replyEmbed({ embeds: [embed] });
}
