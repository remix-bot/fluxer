/**
 * @module commands/shuffle
 * @description Randomly re-order the tracks in the playback queue.
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { Utils } from "../src/utils/Utils.mjs";

/**
 * @type {CommandBuilder}
 * @description Command definition for the shuffle command.
 */
export const command = new CommandBuilder()
  .setName("shuffle")
  .setDescription("Re-orders the queue randomly.", "commands.shuffle")
  .setCategory("music");

/**
 * Run handler for the shuffle command.
 * Shuffles the queue and sends a confirmation embed.
 *
 * @param {object} message - The command message wrapper.
 * @returns {Promise<void>}
 */
export async function run(message) {
  const p = await this.getPlayer(message, false, true, false);
  if (!p) return;

  if (p.isEmpty()) {
    const embed = new EmbedBuilder()
      .setColor(0xe9196c)
      .setDescription(this.t(message, "responses._common.nothingPlaying"));
    return message.reply({ embeds: [embed] });
  }

  p.queue.shuffle();
  p.emit("update", "queue");

  const totalTracks = p.queue.size();
  const pluralStr   = totalTracks === 1 ? this.t(message, "responses.play.trackSingle") : this.t(message, "responses.play.trackPlural");
  const nextTrack   = p.queue.data?.[0];
  const nextTitle   = nextTrack?.title ? Utils.truncate(nextTrack.title, 40) : null;
  const rawAuthor   = nextTrack ? (nextTrack.artist || (typeof nextTrack.author === "object" ? nextTrack.author?.name : nextTrack.author)) : null;
  const prefix      = this.handler.getPrefix(message.message?.guildId ?? message.channel?.guildId) || "%";

  let desc = `**${this.t(message, "responses.shuffle.shuffledSummary", { count: totalTracks, plural: pluralStr })}**`;
  if (nextTitle) {
    const authorStr = rawAuthor ? ` • ${rawAuthor}` : "";
    desc += `\n\n▶️ **${this.t(message, "responses.shuffle.newUpNext")}:**\n${nextTitle}${authorStr}`;
  }

  const embed = new EmbedBuilder()
    .setColor(0xe9196c)
    .setAuthor({ name: `🔀 ${this.t(message, "responses.shuffle.shuffledTitle")}` })
    .setDescription(desc)
    .setFooter({ text: `${prefix}queue to view full order` });

  if (nextTrack?.thumbnail) {
    embed.setThumbnail(nextTrack.thumbnail);
  }

  message.reply({ embeds: [embed] }).catch(() => {});
}
