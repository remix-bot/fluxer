/**
 * @module commands/move
 * @description Move a track from one position to another in the queue.
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/ui/index.mjs";

/** @type {CommandBuilder} @description Command definition for the move command. */
export const command = new CommandBuilder()
  .setName("move")
  .setDescription("Move a track from one position to another in the queue.", "commands.move")
  .setCategory("music")
  .addAliases("mv", "m")
  .addNumberOption(o =>
    o.setName("from")
      .setDescription("The current position of the track in the queue. You can view the indices with the 'list' command.", "options.move.from")
      .setRequired(true)
  )
  .addNumberOption(o =>
    o.setName("to")
      .setDescription("The target position to move the track to in the queue.", "options.move.to")
      .setRequired(true)
  );

/**
 * @async
 * Run handler for the move command.
 * Moves a track in the queue from one position to another.
 * @param {object} message - The command message wrapper.
 * @param {object} data - Parsed command data containing from/to positions.
 * @returns {Promise<void>}
 */
export async function run(message, data) {
  const p = await this.getPlayer(message, false, false, false);
  if (!p) return;
  const from = data.get("from")?.value;
  const to = data.get("to")?.value;
  if (from === null || from === undefined || from < 1) return message.replyEmbed("Source position must be 1 or greater.").catch(() => {});
  if (to === null || to === undefined || to < 1) return message.replyEmbed("Target position must be 1 or greater.").catch(() => {});

  const queueData = p.queue?.data ?? [];
  const track = queueData[from - 1];
  const res = p.move(from, to);
  if (typeof res === "string" && !res.startsWith("Moved")) {
    return message.replyEmbed(res).catch(() => {});
  }

  const embed = new EmbedBuilder()
    .setColor(getGlobalColor())
    .setAuthor({ name: "🔀 Track Reordered" })
    .setTitle(track?.title?.slice(0, 256) || "Reordered Track")
    .setDescription(`Moved from position **#${from}** ➔ **#${to}** in the queue.`)
    .setFooter({ text: to === 1 ? "Now playing next after the current song • %np" : "%list to view updated queue" });

  if (track?.thumbnail) embed.setThumbnail(track.thumbnail);
  message.reply({ embeds: [embed] }).catch(() => {});
}
