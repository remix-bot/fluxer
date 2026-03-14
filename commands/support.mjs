import { CommandBuilder } from "../src/CommandHandler.mjs";

export const command = new CommandBuilder()
  .setName("support")
  .setDescription("The support server for Remix. Feel free to ask help, report bugs or just chat :)", "commands.support")
  .addAliases("server")
  .setCategory("util");

export function run(msg) {
  // TODO: update the user IDs below to your Fluxer user IDs
  msg.replyEmbed("Support Server \n\nFor anything regarding Remix, just head over to our server: \n[Remix HQ](https://fluxer.gg/HcQsKi25)\n\nOther\n\nIf you don't want to join, feel free to contact the team members listed in the server.");
}
