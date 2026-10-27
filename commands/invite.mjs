/**
 * @module commands/invite
 * @description Display the bot invite link and support server information.
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/ui/index.mjs";

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
    const botUser = this.client?.user;
    const botIcon = botUser?.displayAvatarURL?.() || null;

    const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setAuthor({
            name: this.t(message, "responses.invite.title"),
            iconURL: botIcon
        })
        .setTitle(this.t(message, "responses.invite.addRemixTitle"))
        .setDescription(this.t(message, "responses.invite.description"))
        .setFooter({ text: this.t(message, "responses.invite.footer") });

    if (botIcon) embed.setThumbnail(botIcon);

    await message.reply({
        embeds: [embed]
    }).catch(() => {});
}
