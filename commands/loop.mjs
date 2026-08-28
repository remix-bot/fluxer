/**
 * @module commands/loop
 * @description Toggle looping of the current song or the entire queue.
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

/** @type {CommandBuilder} @description Command definition for the loop command. */
export const command = new CommandBuilder()
    .setName("loop")
    .setDescription("Toggle the looping of your queue/song.", "commands.loop")
    .setCategory("music")
    .addChoiceOption(opt =>
        opt.setName("type")
            .addChoices("queue", "song")
            .setDescription("Specifies what loop should be toggled.", "options.loop.type")
            .setRequired(true));

/**
 * @async
 * Run handler for the loop command.
 * Toggles loop mode for the queue or the current song.
 * @param {object} message - The command message wrapper.
 * @param {object} data - Parsed command data containing the loop type option.
 * @returns {Promise<void>}
 */
export async function run(message, data) {
  const p = await this.getPlayer(message);
  if (!p) return;
  const res = p.loop(data.get("type").value);
  const embed = new EmbedBuilder()
    .setColor(getGlobalColor())
    .setDescription(res)
    ;
  message.reply({ embeds: [embed] }).catch(() => {});
}
