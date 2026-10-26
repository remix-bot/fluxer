/**
 * @module commands/replay
 * @description Restart the currently playing track from the beginning without re-fetching from source.
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { Utils } from "../src/utils/Utils.mjs";

/** @type {CommandBuilder} @description Command definition for the replay command. */
export const command = new CommandBuilder()
  .setName("replay")
  .setDescription("Restart the current song from the beginning.", "commands.replay")
  .addAliases("restart")
  .setCategory("music");

/**
 * @async
 * Run handler for the replay command.
 * Seeks the player back to 0:00.
 * @param {object} message - The command message wrapper.
 * @returns {Promise<void>}
 */
export async function run(message) {
  const p = await this.getPlayer(message, true, true, false);
  if (!p) return;

  const current = p.queue?.getCurrent();
  if (!current) {
    const embed = new EmbedBuilder()
      .setColor(0xe9196c)
      .setDescription(this.t(message, "responses.replay.nothingPlaying"));
    return message.reply({ embeds: [embed] });
  }

  if (current.type === "radio" || current.isLive) {
    const embed = new EmbedBuilder()
      .setColor(0xe9196c)
      .setDescription(this.t(message, "responses.replay.live"));
    return message.reply({ embeds: [embed] });
  }

  const success = await p.seekToPosition(0);
  if (!success) {
    const embed = new EmbedBuilder()
      .setColor(0xe9196c)
      .setDescription(this.t(message, "responses.replay.failed"));
    return message.reply({ embeds: [embed] });
  }

  const titleDisplay = current.title ? Utils.truncate(current.title, 50) : this.t(message, "responses.play.unknownTrack");
  const trackLink = current.spotifyUrl || current.url || "";
  const rawAuthor = current.artist || (typeof current.author === "object" ? current.author?.name : current.author);
  const thumb = current.thumbnail || null;
  const trackDuration = p._getTrackDurationMs(current);
  const totalStr = trackDuration > 0 ? Utils.prettifyMS(trackDuration) : null;

  let desc = trackLink ? `**[${titleDisplay}](${trackLink})**` : `**${titleDisplay}**`;
  if (rawAuthor) {
    desc += `\n${this.t(message, "responses.play.byAuthor", { author: rawAuthor })}`;
  }

  const embed = new EmbedBuilder()
    .setColor(0xe9196c)
    .setAuthor({ name: `🔄 ${this.t(message, "responses.replay.author")}` })
    .setTitle(this.t(message, "responses.replay.title"))
    .setDescription(desc)
    .setFooter({ text: totalStr ? this.t(message, "responses.replay.footer", { duration: totalStr }) : "Remix Music • Restarted from 0:00" });

  if (thumb) {
    embed.setThumbnail(thumb);
  }

  return message.reply({ embeds: [embed] });
}
