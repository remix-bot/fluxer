/**
 * @module commands/pause
 * @description Pause the currently playing track.
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { Utils } from "../src/utils/Utils.mjs";

/** @type {CommandBuilder} @description Command definition for the pause command. */
export const command = new CommandBuilder()
  .setName("pause")
  .setDescription("Pause the playback in your voice channel", "commands.pause")
  .setCategory("music");

/**
 * @async
 * Run handler for the pause command.
 * Pauses playback in the user's voice channel.
 * @param {object} message - The command message wrapper.
 * @returns {Promise<void>}
 */
export async function run(message) {
  const p = await this.getPlayer(message);
  if (!p) return;

  const current = p.queue.getCurrent();
  if (!p.connection || !current) {
    const embed = new EmbedBuilder().setColor(0xe9196c).setDescription(this.t(message, "responses._common.nothingPlaying"));
    return message.reply({ embeds: [embed] });
  }

  const prefix = this.handler.getPrefix(message.message?.guildId ?? message.channel?.guildId) || "%";

  if (p._paused) {
    const embed = new EmbedBuilder()
      .setColor(0xe9196c)
      .setAuthor({ name: `⏸️ ${this.t(message, "responses.pause.pausedTitle")}` })
      .setDescription(this.t(message, "responses.pause.alreadyPaused"))
      .setFooter({ text: this.t(message, "responses.pause.resumeHint", { prefix }) });
    return message.reply({ embeds: [embed] });
  }

  p.pause();
  p._autoPausedEmpty = false;
  p._serverMutedAutoPaused = false;
  const elapsed = p.getCurrentElapsedDuration();
  const trackUrl = current.spotifyUrl || current.url || null;
  const rawAuthor = current.artist || (typeof current.author === "object" ? current.author?.name : current.author);

  let desc = trackUrl
    ? `**[${Utils.truncate(current.title || this.t(message, "responses.play.unknownTrack"), 50)}](${trackUrl})**`
    : `**${Utils.truncate(current.title || this.t(message, "responses.play.unknownTrack"), 50)}**`;

  if (rawAuthor) {
    desc += `\n${this.t(message, "responses.play.byAuthor", { author: rawAuthor })}`;
  }

  const embed = new EmbedBuilder()
    .setColor(0xe9196c)
    .setAuthor({ name: `⏸️ ${this.t(message, "responses.pause.pausedTitle")}` })
    .setTitle(this.t(message, "responses.pause.pausedAt", { time: elapsed }))
    .setDescription(desc)
    .setFooter({ text: this.t(message, "responses.pause.resumeHint", { prefix }) });

  if (current.thumbnail) {
    embed.setThumbnail(current.thumbnail);
  }

  message.reply({ embeds: [embed] }).catch(() => {});
}
