/**
 * @module commands/skipto
 * @description Skip directly to a specific track position in the queue.
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { Utils } from "../src/utils/Utils.mjs";

/** @type {CommandBuilder} @description Command definition for the skipto command. */
export const command = new CommandBuilder()
  .setName("skipto")
  .setDescription("Skip directly to a specific track in the queue.", "commands.skipto")
  .addAliases("jump", "jumpto")
  .setCategory("music")
  .addNumberOption(opt =>
    opt.setName("position")
      .setDescription("The track number in the queue to jump to.", "options.skipto.position")
      .setRequired(true)
  );

/**
 * @async
 * Run handler for the skipto command.
 * Skips all tracks prior to the target position and advances playback immediately.
 * @param {object} message - The command message wrapper.
 * @param {object} data - Parsed command data containing the position option.
 * @returns {Promise<void>}
 */
export async function run(message, data) {
  const p = await this.getPlayer(message, true, true, false);
  if (!p) return;

  const queueSize = p.queue?.size() ?? 0;
  if (queueSize === 0) {
    const embed = new EmbedBuilder()
      .setColor(0xe9196c)
      .setDescription(this.t(message, "responses.skipto.emptyQueue"));
    return message.reply({ embeds: [embed] });
  }

  const rawPosition = data.get("position")?.value;
  const position = parseInt(rawPosition, 10);

  if (isNaN(position) || position < 1 || position > queueSize) {
    const embed = new EmbedBuilder()
      .setColor(0xe9196c)
      .setDescription(this.t(message, "responses.skipto.invalidPosition", { max: queueSize }));
    return message.reply({ embeds: [embed] });
  }

  /* Preview targeted track before splicing */
  const targetTrack = p.queue.data[position - 1];
  const skippedCount = position;

  p.skipTo(position);

  const titleDisplay = targetTrack?.title ? Utils.truncate(targetTrack.title, 50) : this.t(message, "responses.play.unknownTrack");
  const trackLink = targetTrack?.spotifyUrl || targetTrack?.url || "";
  const rawAuthor = targetTrack?.artist || (typeof targetTrack?.author === "object" ? targetTrack.author?.name : targetTrack?.author);
  const remainingInQueue = Math.max(0, queueSize - position);

  let desc = trackLink ? `**[${titleDisplay}](${trackLink})**` : `**${titleDisplay}**`;
  if (rawAuthor) {
    desc += `\n${this.t(message, "responses.play.byAuthor", { author: rawAuthor })}`;
  }

  const embed = new EmbedBuilder()
    .setColor(0xe9196c)
    .setAuthor({ name: `⏭️ ${this.t(message, "responses.skipto.author")}` })
    .setTitle(this.t(message, "responses.skipto.title", { position, count: skippedCount }))
    .setDescription(desc)
    .setFooter({ text: this.t(message, "responses.skipto.footer", { remaining: remainingInQueue }) });

  if (targetTrack?.thumbnail) {
    embed.setThumbnail(targetTrack.thumbnail);
  }

  return message.reply({ embeds: [embed] });
}
