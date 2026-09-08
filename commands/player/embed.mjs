/**
 * @module commands/player/embed
 * @description Player panel embed construction: state emoji, progress bar,
 * volume gauge, loop/filter status and footer (verbatim body of the original
 * run() closure, with the bot instance passed explicitly instead of `this`).
 */

import { Utils } from "../../src/utils/Utils.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../../src/ui/index.mjs";
import { STATES, PROGRESS } from "./consts.mjs";

/**
 * Build the player panel embed with current state, progress, volume, and loop info.
 * @param {object} bot - The bot instance (used for locale translation).
 * @param {object} msg - The command message wrapper.
 * @param {object} player - The guild player.
 * @param {number} timeout - Session timeout in ms (shown in the footer area).
 * @param {object} [state={}] - Optional state override with a message field.
 * @returns {EmbedBuilder} The constructed embed builder.
 */
export function buildPlayerEmbed(bot, msg, player, timeout, state = {}) {
  const current = player.queue.getCurrent();
  const isPlaying = !player.paused && current;
  const statusEmoji = isPlaying ? STATES.playing : player.paused ? STATES.paused : STATES.stopped;

  let progressBar = "";
  let timeDisplay = "`0:00 / 0:00`";

  if (current?.duration && player.startedPlaying) {
    const elapsed = Date.now() - player.startedPlaying;
    const totalMs = typeof current.duration === "object"
        ? (current.duration.seconds ?? 0) * 1000
        : current.duration;

    const bar = Utils.progressBar(elapsed, totalMs, 20, PROGRESS.filled, PROGRESS.empty, isPlaying ? PROGRESS.indicator : PROGRESS.filled);
    progressBar = PROGRESS.start + bar + PROGRESS.end;

    const elapsedStr = Utils.prettifyMS(elapsed);
    const totalStr = Utils.prettifyMS(totalMs);
    timeDisplay = `\`${elapsedStr} / ${totalStr}\``;
  } else {
    progressBar = PROGRESS.start + PROGRESS.empty.repeat(20) + PROGRESS.end;
  }

  const volPercent = Math.round((player.preferredVolume ?? 1) * 100);
  const volBars = Math.ceil(volPercent / 10);
  const volumeBar = "█".repeat(volBars) + "░".repeat(10 - volBars);

  const queueSize = player.queue.size();
  const loopStatus = player.queue.songLoop ? bot.t(msg, "responses.player.loopSong") : player.queue.loop ? bot.t(msg, "responses.player.loopQueue") : bot.t(msg, "responses.player.loopOff");

  let filterStatus = bot.t(msg, "responses.player.filterOff");
  if (player.activeFilter) {
    if (player.activeFilter.label.includes("+")) {
      filterStatus = `🔥 **${player.activeFilter.label}**`;
    } else {
      filterStatus = `${player.activeFilter.emoji ?? "🎛️"} **${player.activeFilter.label}**`;
    }
  }

  const nowPlaying = current
      ? `[${Utils.truncate(current.title, 45)}](${current.spotifyUrl || current.url})`
      : bot.t(msg, "responses.filter.nothingPlayingInline");

  const description = [
    `${statusEmoji} ${bot.t(msg, "responses.player.nowPlayingLabel")}`,
    `${nowPlaying}`,
    ``,
    `${progressBar}`,
    `${timeDisplay}`,
    ``,
    bot.t(msg, "responses.player.volumeLabel", { volume: volPercent }) + " " + volumeBar,
    `${bot.t(msg, "responses.player.queueLabel", { count: queueSize })} | Loop: ${loopStatus} | Filter: ${filterStatus}`,
    ``,
    state.message ? `💬 *${state.message}*` : `💡 *${bot.t(msg, "responses.player.reactHint")}*`,
    ``,
    bot.t(msg, "responses.player.sessionExpires", { minutes: Math.ceil(timeout / 60000) })
  ].join("\n");

  const avatarUrl = typeof msg.author?.avatarURL === "function"
      ? msg.author.avatarURL()
      : msg.author?.avatarURL ?? null;

  const builder = new EmbedBuilder()
      .setColor(getGlobalColor())
      .setTitle(bot.t(msg, "responses.player.title"))
      .setDescription(description)
      .setFooter({
        text: bot.t(msg, "responses.player.requestedBy", { username: msg.author?.username || "Unknown" }),
        iconURL: avatarUrl
      });
  if (typeof builder.setTimestamp === "function") builder.setTimestamp();
  if (current?.thumbnail) builder.setThumbnail(current.thumbnail);
  return builder;
}
