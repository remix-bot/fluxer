/**
 * @module commands/invite
 * @description Display the bot invite link and support server information.
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

/**
 * @type {CommandBuilder}
 * @description Command definition for the invite command.
 */
export const command = new CommandBuilder()
    .setName("invite")
    .setDescription("Get the invite link for Remix and the support server.", "commands.invite")
    .addAliases("addbot", "remix")
    .setCategory("util");

/**
 * Run handler for the invite command.
 * Sends an embed with the bot invite link and support server info.
 *
 * @param {object} message - The command message wrapper.
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
