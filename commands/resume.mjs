/**
 * @module commands/resume
 * @description Resume paused playback in the current voice channel.
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { Utils } from "../src/utils/Utils.mjs";

/**
 * @type {CommandBuilder}
 * @description Command definition for the resume command.
 */
export const command = new CommandBuilder()
  .setName("resume")
  .setDescription("Resume the playback in your voice channel", "commands.resume")
  .setCategory("music");

/**
 * Run handler for the resume command.
 * Resumes playback and sends a confirmation embed.
 *
 * @param {object} message - The command message wrapper.
 * @returns {Promise<void>}
 */
export async function run(message) {
  const p = await this.getPlayer(message, false, true, false);
  if (!p) return;

  const current = p.queue.getCurrent();
  if (!p.connection || !current) {
    const embed = new EmbedBuilder()
      .setColor(0xe9196c)
      .setAuthor({ name: `▶️ ${this.t(message, "responses.resume.resumedTitle")}` })
      .setDescription(this.t(message, "responses._common.nothingPlaying"));
    return message.reply({ embeds: [embed] });
  }

  const prefix = this.handler.getPrefix(message.message?.guildId ?? message.channel?.guildId) || "%";

  if (!p._paused) {
    const embed = new EmbedBuilder()
      .setColor(0xe9196c)
      .setAuthor({ name: `▶️ ${this.t(message, "responses.resume.resumedTitle")}` })
      .setDescription(this.t(message, "responses.resume.notPaused"))
      .setFooter({ text: this.t(message, "responses.resume.pauseHint", { prefix }) });
    return message.reply({ embeds: [embed] });
  }

  p.resume();
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
    .setAuthor({ name: `▶️ ${this.t(message, "responses.resume.resumedTitle")}` })
    .setTitle(this.t(message, "responses.resume.resumedAt", { time: elapsed }))
    .setDescription(desc)
    .setFooter({ text: this.t(message, "responses.resume.pauseHint", { prefix }) });

  if (current.thumbnail) {
    embed.setThumbnail(current.thumbnail);
  }

  message.reply({ embeds: [embed] }).catch(() => {});
}
