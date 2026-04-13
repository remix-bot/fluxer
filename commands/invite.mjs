import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

export const command = new CommandBuilder()
    .setName("invite")
    .setDescription("Get the invite link for Remix and the support server.", "commands.invite")
    .addAliases("addbot", "remix")
    .setCategory("util");

export async function run(message) {
    const description =
        "Add Remix to your server directly from [FluxerList](<https://fluxerlist.com/bots/remix>).\n\n" +
        "Join our community at [fluxer.gg/remix](https://fluxer.gg/remix) for support, updates, and direct feedback.";

    const botUser = message.handler.client.user;

    const botIcon = botUser?.displayAvatarURL?.() || null;

    const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setAuthor({
            name: "Invite Remix",
            iconURL: botIcon
        })
        .setDescription(description)
        .toJSON();

    await message.replyEmbed({
        embeds: [embed]
    });
}