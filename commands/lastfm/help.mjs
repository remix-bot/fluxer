/**
 * @module commands/lastfm/help
 * @description Fallback help action for the lastfm command (the original
 * switch's `default` branch). Extracted verbatim; reached when the action
 * matches no known action name.
 */

import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../../src/ui/index.mjs";

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
export async function runLastFmHelp(msg, data, lastfm, prefix, userId, targetUserId, action) {
      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(getGlobalColor())
          .setDescription([
            `🎵 **Last.fm Commands:**`,
            ``,
            `\`${prefix}lastfm link\` — Link your Last.fm account`,
            `\`${prefix}lastfm unlink\` — Disconnect your account`,
            `\`${prefix}lastfm scrobble\` — Toggle auto-scrobbling`,
            `\`${prefix}lastfm np\` — Show your Last.fm now playing`,
            `\`${prefix}lastfm profile\` — View your Last.fm profile (or another user's with user option)`,
            `\`${prefix}lastfm loved\` — View your loved tracks`,
            `\`${prefix}lastfm top\` — View your top tracks (supports period)`,
            `\`${prefix}lastfm artists\` — View your top artists (supports period)`,
            `\`${prefix}lastfm recent\` — View your recent tracks`,
            `\`${prefix}lastfm playlists\` — View your Last.fm playlists`,
            `\`${prefix}lastfm leaderboard\` — Scrobble leaderboard`,
            `\`${prefix}lastfm love\` — Love the current track`,
            `\`${prefix}lastfm unlove\` — Unlove the current track`,
            ``,
            `🔍 **Info Commands:**`,
            `\`${prefix}lastfm whoknows [artist]\` — Who in the server listens to an artist`,
            `\`${prefix}lastfm whoknowstrack\` — Who knows a specific track`,
            `\`${prefix}lastfm whoknowsalbum\` — Who knows a specific album`,
            `\`${prefix}lastfm artistinfo\` — Detailed info about an artist`,
            `\`${prefix}lastfm albuminfo\` — Detailed info about an album`,
            `\`${prefix}lastfm trackinfo\` — Detailed info about a track`,
            `\`${prefix}lastfm topalbums\` — View your top albums (supports period)`,
            `\`${prefix}lastfm toptags\` — View your top tags/genres`,
            `\`${prefix}lastfm tag <name>\` — View info about a specific tag`,
            `\`${prefix}lastfm compare @user\` — Compare your taste with another user`,
            `\`${prefix}lastfm cover\` — Get album cover art for the current track`,
            ``,
            `🏷️ **Tag Commands:**`,
            `\`${prefix}lastfm artisttags\` — Top tags for an artist`,
            `\`${prefix}lastfm albumtags\` — Top tags for an album`,
            `\`${prefix}lastfm tracktags\` — Top tags for a track`,
            `\`${prefix}lastfm tagalbums <tag>\` — Top albums for a tag`,
            ``,
            `👥 **Social Commands:**`,
            `\`${prefix}lastfm affinity\` — Find users with similar taste`,
            `\`${prefix}lastfm crowns\` — View your artist crowns (#1 listener)`,
            `\`${prefix}lastfm friends\` — View your Last.fm friends`,
            `\`${prefix}lastfm refreshmembers\` — Refresh server member cache`,
            ``,
            `📊 **Charts & Discovery:**`,
            `\`${prefix}lastfm weekly [artists|tracks|albums]\` — Weekly charts`,
            `\`${prefix}lastfm trending [tracks|artists]\` — Global trending on Last.fm`,
            `\`${prefix}lastfm geo [artists|tracks] <country>\` — Top by country`,
            `\`${prefix}lastfm artisttracks\` — Your scrobbles for an artist`,
            `\`${prefix}lastfm search <query>\` — Universal search`,
            ``,
            `🎶 **Play from Last.fm:**`,
            `\`${prefix}lastfm play loved\` — Play your loved tracks`,
            `\`${prefix}lastfm play top\` — Play your top tracks`,
            `\`${prefix}lastfm play recent\` — Play your recent tracks`,
            `\`${prefix}lastfm play albums\` — Play your top albums`,
            `\`${prefix}lastfm play artists\` — Play your top artists' tracks`,
            `\`${prefix}lastfm play playlist 1\` — Play a playlist`,
            ``,
            `🎧 **Play with a specific provider (defaults to \`top\`):**`,
            `\`${prefix}lastfm play sp\` or \`${prefix}lastfm play sp:top\` — Play top tracks, search on Spotify`,
            `\`${prefix}lastfm play td\` or \`${prefix}lastfm play td:top\` — Play top tracks, search on Tidal`,
            `\`${prefix}lastfm play dz\` or \`${prefix}lastfm play dz:top\` — Play top tracks, search on Deezer`,
            `\`${prefix}lastfm play yt\` or \`${prefix}lastfm play yt:top\` — Play top tracks, search on YouTube`,
            ``,
            `🎧 **Last.fm as resolve provider (all categories):**`,
            `\`${prefix}lastfm play lf:loved\` — Play loved tracks, search on Last.fm`,
            `\`${prefix}lastfm play lf:top\` — Play top tracks, search on Last.fm`,
            `\`${prefix}lastfm play lf:recent\` — Play recent tracks, search on Last.fm`,
            `\`${prefix}lastfm play lf:albums\` — Play top albums, search on Last.fm`,
            `\`${prefix}lastfm play lf:artists\` — Play top artists, search on Last.fm`,
            ``,
            `💡 Or use inline: \`${prefix}play lastfm:loved\` or \`${prefix}play lastfm:sp\` or \`${prefix}play lastfm:td:top\``,
          ].join("\n"))]
      });
}
