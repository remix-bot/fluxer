/**
 * @module commands/previous
 * @description Play the previous track from recent playback history (supports %prev, %back, %undo).
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { Utils } from "../src/utils/Utils.mjs";

/** @type {CommandBuilder} @description Command definition for the previous command. */
export const command = new CommandBuilder()
  .setName("previous")
  .setDescription("Play the previous track from playback history.", "commands.previous")
  .addAliases("prev", "back", "undo")
  .setCategory("music");

/**
 * @async
 * Run handler for the previous command.
 * Steps backward into the queue's circular playback history.
 * @param {object} message - The command message wrapper.
 * @returns {Promise<void>}
 */
export async function run(message) {
  const p = await this.getPlayer(message, true, true, false);
  if (!p) return;

  if (!p.queue?.history?.length) {
    const embed = new EmbedBuilder()
      .setColor(0xe9196c)
      .setDescription(this.t(message, "responses.previous.noHistory"));
    return message.reply({ embeds: [embed] });
  }

  const prevSong = await p.playPrevious();
  if (!prevSong) {
    const embed = new EmbedBuilder()
      .setColor(0xe9196c)
      .setDescription(this.t(message, "responses.previous.failed"));
    return message.reply({ embeds: [embed] });
  }

  const titleDisplay = prevSong.title ? Utils.truncate(prevSong.title, 50) : this.t(message, "responses.play.unknownTrack");
  const trackLink = prevSong.spotifyUrl || prevSong.url || "";
  const rawAuthor = prevSong.artist || (typeof prevSong.author === "object" ? prevSong.author?.name : prevSong.author);
  const thumb = prevSong.thumbnail || null;
  const historyRemaining = p.queue.history.length;

  let desc = trackLink ? `**[${titleDisplay}](${trackLink})**` : `**${titleDisplay}**`;
  if (rawAuthor) {
    desc += `\n${this.t(message, "responses.play.byAuthor", { author: rawAuthor })}`;
  }

  const embed = new EmbedBuilder()
    .setColor(0xe9196c)
    .setAuthor({ name: `⏮️ ${this.t(message, "responses.previous.author")}` })
    .setTitle(this.t(message, "responses.previous.title"))
    .setDescription(desc)
    .setFooter({ text: this.t(message, "responses.previous.footer", { count: historyRemaining }) });

  if (thumb) {
    embed.setThumbnail(thumb);
  }

  return message.reply({ embeds: [embed] });
}
