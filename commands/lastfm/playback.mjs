/**
 * @module commands/lastfm/playback
 * @description The `play` action plus the shared Last.fm playback pipeline (playLastFmCategory, kept exported for commands/play.mjs, plus its private helpers). Extracted verbatim from the original single-file command; dispatched by commands/lastfm.mjs.
 */


import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../../src/ui/index.mjs";
import { logger } from "../../src/core/Logger.mjs";
import { PROVIDER_CHOICES } from "../../src/music/providers.mjs";
import { ERROR_COLOR } from "../../src/utils/UI.mjs";
import { notConfigured, notLinked } from "./shared.mjs";

/**
 * Action names dispatched to this module.
 * @type {Set<string>}
 */
export const PLAYBACK_ACTIONS = new Set([
  "play"
]);


const SIMPLE_CATEGORIES = ["loved", "top", "recent", "albums", "artists"];

/**
 * Build a Last.fm track metadata object from a track.
 * @private
 * @param {object} track - The track object with artist, name, and url.
 * @returns {{ source: string, artist: string, name: string, url: string }} Track metadata.
 */
function buildLastFmTrackMeta(track) {
  return {
    source: "lastfm",
    artist: track.artist,
    name: track.name,
    url: track.url ?? "",
  };
}

/**
 * Resolve a Last.fm track to playable audio via a search provider.
 * @private
 * @async
 * @param {object} player - The player instance.
 * @param {object} track - The Last.fm track with query and metadata.
 * @param {string} [resolveProvider="yt"] - The provider to resolve with.
 * @returns {Promise<object[]|null>} Array of resolved track data, or null on failure.
 */
async function resolveLastFmTrack(player, track, resolveProvider = "yt") {
  const data = await player.generalQuery({
    query: track.query,
    provider: resolveProvider,
    trackMeta: buildLastFmTrackMeta(track),
  });

  if (!data || data.type === "error") return null;
  if (data.type === "video") return [data.data];
  if (data.type === "list") return data.data ?? [];
  return null;
}

/**
 * Fetch and play tracks from a Last.fm category (loved, top, recent, albums, artists, playlist).
 * @async
 * @param {object} ctx - The bot (Remix) instance context.
 * @param {object} msg - The command message wrapper.
 * @param {string} userId - The user ID.
 * @param {string} category - The Last.fm category to play.
 * @param {object} [options={}] - Additional options.
 * @param {string} [options.resolveProvider="yt"] - Provider to resolve tracks with.
 * @param {string} [options.playlistId] - Playlist number for playlist category.
 * @returns {Promise<void>}
 */
export async function playLastFmCategory(ctx, msg, userId, category, options = {}) {
  const lastfm = ctx.lastfm;
  const prefix = ctx.handler.getPrefix(msg.message?.guildId);
  const resolveProvider = options.resolveProvider || "yt";

  if (!lastfm || !lastfm.enabled) return msg.reply(notConfigured(ctx, msg));

  const validCategories = [...SIMPLE_CATEGORIES, "playlist"];
  if (!validCategories.includes(category)) {
    return msg.reply({
      embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(
        `❌ Unknown category \`${category}\`. Use \`loved\`, \`top\`, \`recent\`, \`albums\`, \`artists\`, or \`playlist\`.`
      )]
    });
  }

  if (category === "playlist" && !options.playlistId) {
    return msg.reply({
      embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(
        `❌ Specify a playlist number. Use \`${prefix}lastfm playlists\` to see your playlists, then \`${prefix}lastfm play playlist <number>\`.`
      )]
    });
  }

  const user = await lastfm.getUser(userId);
  if (!user) return msg.reply(notLinked(ctx, msg, prefix));

  const p = await ctx.getPlayer(msg, true, true, true);
  if (!p) return;

  const categoryEmoji = { loved: "❤️", top: "📊", recent: "🕐", playlist: "📋", albums: "💿", artists: "🎤" }[category];
  const categoryLabel = { loved: "Loved", top: "Top", recent: "Recent", playlist: "Playlist", albums: "Top Albums", artists: "Top Artists" }[category];

  const resolveLabel = resolveProvider !== "yt" ? ` via ${resolveProvider.toUpperCase()}` : "";

  let statusMsg;
  try {
    statusMsg = await msg.reply({
      embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(
        `${categoryEmoji} Fetching your ${categoryLabel} tracks from Last.fm${resolveLabel}...`
      )]
    });
  } catch (e) { logger.warn("[LastfmCmd] Error:", e?.message); statusMsg = null; }

  let result;
  try {
    result = await lastfm.getTracksForPlay(userId, category, options);
  } catch (err) {
    const errMsg = err.message === "NOT_LINKED"
      ? notLinked(ctx, msg, prefix)
      : { embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(ctx.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))] };
    if (statusMsg) statusMsg.edit(errMsg).catch(() => msg.reply(errMsg));
    else msg.reply(errMsg);
    return;
  }

  if (!result.tracks.length) {
    const noTracks = { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(
      `${categoryEmoji} No ${categoryLabel.toLowerCase()} tracks found for **${result.username}**.`
    )] };
    if (statusMsg) statusMsg.edit(noTracks).catch(() => msg.reply(noTracks));
    else msg.reply(noTracks);
    return;
  }

  let added = 0;
  let failed = 0;

  if (statusMsg) {
    statusMsg.edit({
      embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(
        `${categoryEmoji} Loading **${result.tracks.length}** ${categoryLabel.toLowerCase()} tracks from **${result.username}**${resolveLabel}...`
      )]
    }).catch(() => {});
  }

  for (const track of result.tracks) {
    try {
      const resolvedTracks = await resolveLastFmTrack(p, track, resolveProvider);
      if (!resolvedTracks?.length) {
        failed++;
        continue;
      }

      p.addManyToQueue(resolvedTracks, false);
      added += resolvedTracks.length;

      if (!p.queue.getCurrent()) {
        p.playNext();
      }
    } catch (e) {
      logger.warn("[LastfmCmd] Track resolve failed:", e?.message);
      failed++;
    }
  }

  const summary = [];
  if (added > 0) summary.push(`✅ Added **${added}** track${added !== 1 ? "s" : ""} to the queue`);
  if (failed > 0) summary.push(`⚠️ ${failed} track${failed !== 1 ? "s" : ""} couldn't be found`);

  const doneEmbed = { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(
    `${categoryEmoji} **${categoryLabel} Tracks — ${result.username}**\n${summary.join(" · ")}`
  )] };

  if (statusMsg) statusMsg.edit(doneEmbed).catch(() => msg.reply(doneEmbed));
  else msg.reply(doneEmbed);
}

/**
 * Parse play subcommand arguments for category and provider.
 * @private
 * @param {object} msg - The command message wrapper.
 * @param {object} data - Parsed command data.
 * @returns {{ category: string, resolveProvider?: string, playlistId?: string, showAllCategories?: boolean, invalidCategory?: string }} Parsed args.
 */
function parsePlayArgs(msg, data) {
  let raw = data.get("token")?.value;
  if (!raw) {
    const content = msg.message?.content ?? "";
    const args = content.split(/\s+/);
    const playIdx = args.indexOf("play");
    if (playIdx >= 0 && args[playIdx + 1]) {
      raw = args.slice(playIdx + 1).join(" ");
    }
  }

  if (!raw) return { category: "" };

  const lower = raw.toLowerCase().trim();

  const subMatch = lower.match(/^([a-z]+):\s*(.*)$/);
  if (subMatch) {
    const maybeProvider = subMatch[1];
    const rest = subMatch[2].trim();
    if (PROVIDER_CHOICES.includes(maybeProvider)) {
      const isLastFmProvider = maybeProvider === "lf" || maybeProvider === "lastfm";

      if (!rest) {
        if (isLastFmProvider) {
          return { category: "", resolveProvider: maybeProvider, showAllCategories: true };
        }
        return { category: "top", resolveProvider: maybeProvider };
      }

      if (isLastFmProvider) {
        const playlistMatch = rest.match(/^playlist\s+(\d+)$/);
        if (playlistMatch) {
          return { category: "playlist", playlistId: playlistMatch[1], resolveProvider: maybeProvider };
        }
        if (SIMPLE_CATEGORIES.includes(rest)) {
          return { category: rest, resolveProvider: maybeProvider };
        }
      } else {
        if (rest === "top") {
          return { category: "top", resolveProvider: maybeProvider };
        }
        return { category: "", resolveProvider: maybeProvider, invalidCategory: rest };
      }
    }
  }

  if (PROVIDER_CHOICES.includes(lower)) {
    const isLastFmProvider = lower === "lf" || lower === "lastfm";
    if (isLastFmProvider) {
      return { category: "", resolveProvider: lower, showAllCategories: true };
    }
    return { category: "top", resolveProvider: lower };
  }

  const playlistMatch = lower.match(/^playlist\s+(\d+)$/);
  if (playlistMatch) {
    return { category: "playlist", playlistId: playlistMatch[1] };
  }

  if (SIMPLE_CATEGORIES.includes(lower)) {
    return { category: lower };
  }

  return { category: "" };
}

/**
 * @async
 * @param {object} msg - The command message wrapper.
 * @param {object} data - Parsed command data.
 * @param {object} lastfm - The Last.fm manager instance.
 * @param {string} prefix - The guild command prefix.
 * @param {string} userId - The invoking user's ID.
 * @param {string|null} targetUserId - The targeted user's ID, if any.
 * @param {string} action - The resolved action name.
 * @returns {Promise<*>} Whatever the original switch returned for this action.
 */
export async function runPlaybackActions(msg, data, lastfm, prefix, userId, targetUserId, action) {
  switch (action) {
    case "play": {
      const parsed = parsePlayArgs(msg, data);

      if (parsed.invalidCategory) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(
            `❌ \`${parsed.resolveProvider}:${parsed.invalidCategory}\` is not valid. Non-Last.fm providers only support \`top\`.\nUse \`${prefix}lastfm play ${parsed.resolveProvider}\` or \`${prefix}lastfm play ${parsed.resolveProvider}:top\` instead.\nFor other categories, use Last.fm as the resolve provider: \`${prefix}lastfm play lf:${parsed.invalidCategory}\``
          )]
        });
      }

      if (!parsed.category) {
        const lfProviderNote = parsed.showAllCategories && parsed.resolveProvider
          ? `\n\n💡 \`${prefix}lastfm play ${parsed.resolveProvider}:<category>\` — Specify a category after the provider:`
          : "";
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription([
            `❌ Usage: \`${prefix}lastfm play <category>\``,
            ``,
            `**Categories:**`,
            `\`loved\` — Play your loved tracks`,
            `\`top\` — Play your top tracks`,
            `\`recent\` — Play your recent tracks`,
            `\`albums\` — Play your top albums`,
            `\`artists\` — Play your top artists' tracks`,
            `\`playlist <number>\` — Play a playlist (use \`${prefix}lastfm playlists\` to list)`,
            ``,
            `**With a search provider (defaults to \`top\`):**`,
            `\`${prefix}lastfm play td\` or \`${prefix}lastfm play td:top\` — Play top tracks, search on Tidal`,
            `\`${prefix}lastfm play sp\` or \`${prefix}lastfm play sp:top\` — Play top tracks, search on Spotify`,
            `\`${prefix}lastfm play dz\` or \`${prefix}lastfm play dz:top\` — Play top tracks, search on Deezer`,
            `\`${prefix}lastfm play yt\` or \`${prefix}lastfm play yt:top\` — Play top tracks, search on YouTube`,
            ``,
            `**Last.fm as resolve provider (all categories):**`,
            `\`${prefix}lastfm play lf:loved\` — Play loved tracks, search on Last.fm`,
            `\`${prefix}lastfm play lf:top\` — Play top tracks, search on Last.fm`,
            `\`${prefix}lastfm play lf:recent\` — Play recent tracks, search on Last.fm`,
            `\`${prefix}lastfm play lf:albums\` — Play top albums, search on Last.fm`,
            `\`${prefix}lastfm play lf:artists\` — Play top artists, search on Last.fm`,
            ``,
            `**Examples:**`,
            `\`${prefix}lastfm play loved\``,
            `\`${prefix}lastfm play td\``,
            `\`${prefix}lastfm play sp:top\``,
            `\`${prefix}lastfm play lf:loved\``,
            `\`${prefix}lastfm play playlist 1\``,
            lfProviderNote,
          ].join("\n"))]
        });
      }

      return playLastFmCategory(this, msg, userId, parsed.category, {
        playlistId: parsed.playlistId,
        resolveProvider: parsed.resolveProvider,
      });
    }

  }
}
