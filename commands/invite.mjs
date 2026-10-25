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
        .setTitle("Add Remix to Your Server")
        .setDescription(
            "High-fidelity 24/7 Music Bot supporting YouTube, Spotify, SoundCloud, Apple Music & Deezer.\n\n" +
            "💎 **48kHz Hi-Fi Audio** • 🎛️ **30+ Filters** • ⚡ **Dynamic Normalizer** • 📻 **Live Web Radio**\n\n" +
            "**Quick Links:**\n" +
            "• [➕ **Add Remix to Server**](https://fluxerlist.com/bots/remix)\n" +
            "• [💬 **Join Support Community**](https://fluxer.gg/remix)"
        )
        .setFooter({ text: "Remix • Free & Open-Source Music" });

    if (botIcon) embed.setThumbnail(botIcon);

    await message.reply({
        embeds: [embed]
    }).catch(() => {});
}
