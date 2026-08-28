/**
 * @module commands/skip
 * @description Skip the currently playing track.
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

/** @type {CommandBuilder} @description Command definition for the skip command. */
export const command = new CommandBuilder()
    .setName("skip")
    .setDescription("Skip the current playing song.", "commands.skip")
    .addAliases("s")
    .setCategory("music");

/**
 * @async
 * Run handler for the skip command.
 * Skips the current track and shows which track was skipped.
 * @param {object} message - The command message wrapper.
 * @returns {Promise<void>}
 */
export async function run(message) {
  const p = await this.getPlayer(message);
  if (!p) return;

  const current      = p.queue.getCurrent();
  const skippedTitle = current?.title ?? null;
  const skippedLink  = current ? (current.spotifyUrl || current.url || "") : "";

  const err = p.skip();
  if (!p.connection || !current) {
    const embed = new EmbedBuilder().setColor(getGlobalColor()).setDescription(err);
    return message.reply({ embeds: [embed] });
  }

  const desc = skippedTitle
    ? this.t(message, "responses.skip.skippedTrack", { title: skippedTitle, url: skippedLink })
    : this.t(message, "responses.skip.skipped");

  const embed = new EmbedBuilder()
    .setColor(getGlobalColor())
    .setDescription(desc)
    ;
  message.reply({ embeds: [embed] }).catch(() => {});
}
