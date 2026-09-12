/**
 * @module commands/skip
 * @description Skip the currently playing track. Solo or duo listeners skip
 * instantly; once 3+ (configurable) people are in the voice channel, a
 * majority vote is required — unless the server has disabled vote-skip.
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor, cleanId } from "../src/ui/index.mjs";
import { countHumansInChannel } from "../src/voice/VoiceStateResolver.mjs";

/** @type {CommandBuilder} @description Command definition for the skip command. */
export const command = new CommandBuilder()
    .setName("skip")
    .setDescription("Skip the current playing song.", "commands.skip")
    .addAliases("s")
    .setCategory("music");

/** @private Perform the actual skip and reply with what was skipped. @param {object} ctx @param {object} message @param {Player} p @returns {Promise<void>} */
async function doSkip(ctx, message, p) {
  const current      = p.queue.getCurrent();
  const skippedTitle = current?.title ?? null;
  const skippedLink  = current ? (current.spotifyUrl || current.url || "") : "";

  const err = p.skip();
  if (!p.connection || !current) {
    const embed = new EmbedBuilder().setColor(getGlobalColor()).setDescription(err);
    return message.reply({ embeds: [embed] });
  }

  const desc = skippedTitle
    ? ctx.t(message, "responses.skip.skippedTrack", { title: skippedTitle, url: skippedLink })
    : ctx.t(message, "responses.skip.skipped");

  message.reply({ embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(desc)] }).catch(() => {});
}

/**
 * @async
 * Run handler for the skip command.
 * Skips instantly for 1-2 listeners; requires a majority vote for 3+
 * (threshold configurable per server via `voteSkipThreshold`, and the whole
 * system can be turned off via `voteSkip`).
 * @param {object} message - The command message wrapper.
 * @returns {Promise<void>}
 */
export async function run(message) {
  const p = await this.getPlayer(message);
  if (!p) return;

  const current = p.queue.getCurrent();
  if (!p.connection || !current) {
    const embed = new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(message, "responses._common.nothingPlaying"));
    return message.reply({ embeds: [embed] });
  }

  const guildId   = cleanId(p._guildId) || cleanId(message?.channel?.guildId ?? message?.message?.guildId);
  const channelId = cleanId(p._channelId ?? p._home247Channel);

  const set             = this.getSettings(message);
  const voteSkipEnabled = set?.get("voteSkip") ?? true;
  const threshold       = Number(set?.get("voteSkipThreshold")) || 3;

  const humanCount = countHumansInChannel({
    guildId,
    channelId,
    client: this.client,
    voiceCache: this.voiceCache,
    observedVoiceUsers: this.observedVoiceUsers,
  });

  if (!voteSkipEnabled || humanCount < threshold) {
    return doSkip(this, message, p);
  }

  const userId = message?.author?.id ?? message?.member?.user?.id;
  if (!userId) return doSkip(this, message, p);

  const needed = Math.floor(humanCount / 2) + 1;

  if (p._skipVotes.has(userId)) {
    const embed = new EmbedBuilder().setColor(getGlobalColor())
        .setDescription(this.t(message, "responses.skip.alreadyVoted", { votes: p._skipVotes.size, needed }));
    return message.reply({ embeds: [embed] }).catch(() => {});
  }

  p._skipVotes.add(userId);

  if (p._skipVotes.size >= needed) {
    p._skipVotes.clear();
    return doSkip(this, message, p);
  }

  const embed = new EmbedBuilder().setColor(getGlobalColor())
      .setDescription(this.t(message, "responses.skip.voteAdded", { votes: p._skipVotes.size, needed }));
  message.reply({ embeds: [embed] }).catch(() => {});
}
