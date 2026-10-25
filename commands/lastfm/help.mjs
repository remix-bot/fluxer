/**
 * @module commands/lastfm/help
 * @description Fallback help action for the lastfm command.
 * Dispatched when the subcommand action matches 'help' or an unknown action.
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
 * @returns {Promise<*>} Embed response for Last.fm help.
 */
export async function runLastFmHelp(msg, data, lastfm, prefix, userId, targetUserId, action) {
  const pfx = prefix || "%";

  const accountLines = [
    `• \`${pfx}fm link\` · \`${pfx}fm unlink\` · \`${pfx}fm scrobble\` · \`${pfx}fm np\``,
    `• \`${pfx}fm profile\` · \`${pfx}fm loved\` · \`${pfx}fm top\` · \`${pfx}fm artists\` · \`${pfx}fm recent\``,
    `• \`${pfx}fm love\` · \`${pfx}fm unlove\` · \`${pfx}fm playlists\``
  ].join("\n");

  const discoveryLines = [
    `• \`${pfx}fm artistinfo\` · \`${pfx}fm albuminfo\` · \`${pfx}fm trackinfo\` · \`${pfx}fm cover\``,
    `• \`${pfx}fm trending\` · \`${pfx}fm weekly\` · \`${pfx}fm tag <name>\` · \`${pfx}fm geo <country>\``,
    `• \`${pfx}fm artisttags\` · \`${pfx}fm albumtags\` · \`${pfx}fm tagalbums <tag>\``
  ].join("\n");

  const socialLines = [
    `• \`${pfx}whoknows [artist]\` · \`${pfx}fm wkt\` · \`${pfx}fm wka\``,
    `• \`${pfx}fm crowns\` · \`${pfx}fm compare @user\` · \`${pfx}fm affinity\` · \`${pfx}fm lb\``,
    `• \`${pfx}fm friends\` · \`${pfx}fm refreshmembers\``
  ].join("\n");

  const playbackLines = [
    `• \`${pfx}fm play loved\` · \`${pfx}fm play top\` · \`${pfx}fm play albums\` · \`${pfx}fm play artists\``,
    `• Cross-provider: \`${pfx}fm play sp:top\` (Spotify) · \`yt:top\` · \`dz:top\` · \`td:top\``
  ].join("\n");

  const embed = new EmbedBuilder()
    .setColor(getGlobalColor())
    .setAuthor({ name: this.t(msg, "responses.lastfm.helpAuthor") })
    .setTitle(this.t(msg, "responses.lastfm.helpTitle"))
    .addFields(
      { name: this.t(msg, "responses.lastfm.helpCategoryAccount"), value: accountLines, inline: false },
      { name: this.t(msg, "responses.lastfm.helpCategoryDiscovery"), value: discoveryLines, inline: false },
      { name: this.t(msg, "responses.lastfm.helpCategorySocial"), value: socialLines, inline: false },
      { name: this.t(msg, "responses.lastfm.helpCategoryPlayback"), value: playbackLines, inline: false }
    )
    .setFooter({ text: this.t(msg, "responses.lastfm.helpFooterPro", { prefix: pfx }) });

  return msg.reply({ embeds: [embed] });
}
