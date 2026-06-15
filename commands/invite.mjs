/**
 * @file invite command — Get the bot invite link and support server invite
 * @module commands/invite
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

export const command = new CommandBuilder()
    .setName("invite")
    .setDescription("Get the invite link for Remix and the support server.", "commands.invite")
    .addAliases("addbot", "remix")
    .setCategory("util");

/**
 * Execute the invite command.
 * @param {import("../src/MessageHandler.mjs").Message} message - The incoming message
 * @param {Map<string, {value: *}>} data - Slash-command options map
 * @returns {Promise<void>}
 */
export async function run(message) {
    const description = this.t(message, "responses.invite.description");

    const botUser = this.client?.user;
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
    }).catch(() => {});
}
