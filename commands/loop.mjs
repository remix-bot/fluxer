/**
 * @file loop.mjs — Toggle loop mode for the queue or current track
 * @module commands.loop
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

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
 * Execute the loop command.
 * @param {import("../src/MessageHandler.mjs").Message} message - The incoming message
 * @param {Map<string, {value: *}>} data - Slash-command options map
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
