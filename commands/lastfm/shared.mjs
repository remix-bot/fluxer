/**
 * @module commands/lastfm/shared
 * @description Helpers shared by several lastfm action modules. Bodies
 * are verbatim from the original single-file command; the `export `
 * prefixes are the only addition.
 */


import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../../src/ui/index.mjs";
import { ERROR_COLOR } from "../../src/utils/UI.mjs";

export const VALID_PERIODS = ["7day", "1month", "3month", "6month", "12month", "overall"];

/**
 * Return an embed indicating Last.fm is not configured.
 * @private
 * @param {object} ctx - The bot (Remix) instance context.
 * @param {object} msg - The command message wrapper.
 * @returns {{ embeds: EmbedBuilder[] }} Error embed payload.
 */
export function notConfigured(ctx, msg) {
  return {
    embeds: [new EmbedBuilder()
      .setColor(ERROR_COLOR)
      .setDescription(ctx.t(msg, "responses.lastfm.notConfigured"))]
  };
}

/**
 * Return an embed indicating the user has not linked their Last.fm account.
 * @private
 * @param {object} ctx - The bot (Remix) instance context.
 * @param {object} msg - The command message wrapper.
 * @param {string} prefix - The guild's command prefix.
 * @returns {{ embeds: EmbedBuilder[] }} Error embed payload.
 */
export function notLinked(ctx, msg, prefix) {
  return {
    embeds: [new EmbedBuilder()
      .setColor(getGlobalColor())
      .setDescription(ctx.t(msg, "responses.lastfm.notLinked", { prefix }))]
  };
}

/**
 * Extract Last.fm-relevant info from the player's current track.
 * @private
 * @param {object} player - The player instance.
 * @returns {{ artist: string|null, name: string|null, album: string|null, track: object|null }} Extracted track info.
 */
export function extractCurrentTrack(player) {
  const track = player?.queue?.getCurrent();
  if (!track) return null;
  const artist = track.lastfm?.artist ?? track.requestedArtist ?? track.artist ?? track.artists?.[0]?.name ?? track.author?.name ?? null;
  const name = track.lastfm?.name ?? track.requestedTitle ?? track.title ?? track.name ?? null;
  const album = track.album ?? track.lastfm?.album ?? null;
  return { artist, name, album, track };
}

/**
 * Extract a valid time period from command data or message content.
 * @private
 * @param {object} data - Parsed command data.
 * @param {object} msg - The command message wrapper.
 * @returns {string} The period string, defaults to "overall".
 */
export function extractPeriod(data, msg) {
  let raw = data.get("token")?.value;
  if (!raw) {
    const content = msg.message?.content ?? "";
    const args = content.split(/\s+/);
    const last = args[args.length - 1];
    if (last && VALID_PERIODS.includes(last.toLowerCase())) raw = last;
  }
  if (raw && VALID_PERIODS.includes(raw.toLowerCase().trim())) {
    return raw.toLowerCase().trim();
  }
  return "overall";
}
