import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

export const command = new CommandBuilder()
    .setName("invite")
    .setDescription("Get the invite link for Remix and the support server.", "commands.invite")
    .addAliases("addbot", "remix")
    .setCategory("util");

export async function run(message) {
    const description = this.t(message, "responses.invite.description");

    const botUser = message.handler.client.user;

    const botIcon = botUser?.displayAvatarURL?.() || null;

    const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setAuthor({
            name: this.t(message, "responses.invite.title"),
            iconURL: botIcon
        })
        .setDescription(description)
        ;

    await message.reply({
        embeds: [embed]
    });
}