/**
 * @module commands/thumbnail
 * @description Display the thumbnail artwork of the currently playing track.
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { Utils } from "../src/utils/Utils.mjs";

/** @type {CommandBuilder} @description Command definition for the thumbnail command. */
export const command = new CommandBuilder()
    .setName("thumbnail")
    .setDescription("Request the thumbnail of the currently playing song.", "commands.thumbnail")
    .addAliases("thumb")
    .setCategory("music");

/**
 * @async
 * Run handler for the thumbnail command.
 * Fetches and displays the thumbnail of the currently playing track.
 * @param {object} msg - The command message wrapper.
 * @returns {Promise<void>}
 */
export async function run(msg) {
  const p = await this.getPlayer(msg);
  if (!p) return;

  const current = p.queue?.getCurrent();
  if (!current) {
    const embed = new EmbedBuilder()
      .setColor(0xe9196c)
      .setDescription(this.t(msg, "responses._common.nothingPlaying"));
    return msg.reply({ embeds: [embed] }).catch(() => {});
  }

  if (!current.thumbnail) {
    const embed = new EmbedBuilder()
      .setColor(0xe9196c)
      .setDescription(this.t(msg, "responses.thumbnail.noArtwork"));
    return msg.reply({ embeds: [embed] }).catch(() => {});
  }

  const trackUrl = current.spotifyUrl || current.url || null;
  const rawAuthor = current.artist || (typeof current.author === "object" ? current.author?.name : current.author);
  const titleDisplay = Utils.truncate(current.title || this.t(msg, "responses.play.unknownTrack"), 50);

  let desc = trackUrl ? `**[${titleDisplay}](${trackUrl})**` : `**${titleDisplay}**`;
  if (rawAuthor) {
    desc += `\n${this.t(msg, "responses.play.byAuthor", { author: rawAuthor })}`;
  }

  const embed = new EmbedBuilder()
    .setColor(0xe9196c)
    .setAuthor({ name: `🖼️ ${this.t(msg, "responses.thumbnail.thumbTitle")}` })
    .setTitle(this.t(msg, "responses.thumbnail.highRes"))
    .setDescription(desc)
    .setImage(current.thumbnail)
    .setFooter({ text: this.t(msg, "responses.thumbnail.expandHint") });

  msg.reply({ embeds: [embed] }).catch(() => {});
}
