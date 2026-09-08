/**
 * @module commands/lastfm/tags
 * @description Tag/genre actions for the lastfm command (tag, artisttags, albumtags, tracktags, tagalbums). Extracted verbatim from the original single-file command; dispatched by commands/lastfm.mjs.
 */


import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../../src/ui/index.mjs";
import { Utils } from "../../src/utils/Utils.mjs";
import { logger } from "../../src/core/Logger.mjs";
import { ERROR_COLOR } from "../../src/utils/UI.mjs";
import { extractCurrentTrack } from "./shared.mjs";

/**
 * Action names dispatched to this module.
 * @type {Set<string>}
 */
export const TAG_ACTIONS = new Set([
  "tag",,
  "artisttags",,
  "at",,
  "albumtags",,
  "alt",,
  "tracktags",,
  "tt",,
  "tagalbums",,
  "ta"
]);


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
export async function runTagActions(msg, data, lastfm, prefix, userId, targetUserId, action) {
  switch (action) {
    case "tag": {
      const tagName = data.get("token")?.value;
      if (!tagName) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(
            this.t(msg, "responses.lastfm.tagProvideName", { prefix })
          )]
        });
      }

      let tagInfo;
      let topTracks;
      let topArtists;

      try {
        [tagInfo, topTracks, topArtists] = await Promise.all([
          lastfm.getTagInfo(tagName),
          lastfm.getTagTopTracks(tagName, 5),
          lastfm.getTagTopArtists(tagName, 5),
        ]);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!tagInfo) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.tagNotFound", { tag: tagName }))]
        });
      }

      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle(`🏷️ ${tagInfo.name}`)
        .setURL(tagInfo.url || undefined);

      const fields = [];
      fields.push({ name: "Reach", value: Utils.formatNumber(tagInfo.reach), inline: true });
      fields.push({ name: "Total Taggings", value: Utils.formatNumber(tagInfo.count), inline: true });

      if (topArtists.length) {
        const artistStr = topArtists.map((a, i) => {
          const link = a.url ? `[${a.name}](${a.url})` : a.name;
          return `${i + 1}. ${link} (**${Utils.formatNumber(a.playcount)}** plays)`;
        }).join("\n");
        fields.push({ name: "Top Artists", value: artistStr.slice(0, 1024), inline: false });
      }

      if (topTracks.length) {
        const trackStr = topTracks.map((t, i) => {
          const link = t.url ? `[${t.name}](${t.url})` : t.name;
          return `${i + 1}. ${link} by **${t.artist}**`;
        }).join("\n");
        fields.push({ name: "Top Tracks", value: trackStr.slice(0, 1024), inline: false });
      }

      embed.addFields(...fields);

      if (tagInfo.summary) {
        const cleanSummary = tagInfo.summary.replace(/<[^>]*>/g, "").trim();
        if (cleanSummary.length > 0) {
          const truncated = cleanSummary.length > 300 ? cleanSummary.slice(0, 297) + "..." : cleanSummary;
          embed.setDescription(truncated);
        }
      }

      return msg.reply({ embeds: [embed] });
    }

    case "artisttags":
    case "at": {
      let artistName = null;

      const pAt = await this.getPlayer(msg, false, false, false);
      const current = extractCurrentTrack(pAt);
      if (current?.artist) {
        artistName = current.artist;
      }

      const tokenTextAt = data.get("token")?.value;
      if (tokenTextAt) {
        artistName = tokenTextAt.trim();
      }

      if (!artistName) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.noArtistSpecified"))]
        });
      }

      let tags;
      try {
        tags = await lastfm.getArtistTopTags(artistName, 15);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!tags.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.noArtistTags", { artist: artistName }))]
        });
      }

      const lines = tags.map((t, i) => {
        const num = String(i + 1).padStart(2, " ");
        const link = t.url ? `[${t.name}](${t.url})` : t.name;
        return `\`${num}.\` ${link}${t.count > 0 ? ` — **${Utils.formatNumber(t.count)}**` : ""}`;
      });

      const desc = lines.join("\n").slice(0, 4096);

      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(getGlobalColor())
          .setTitle(this.t(msg, "responses.lastfm.artistTagsTitle", { artist: artistName }))
          .setDescription(desc)]
      });
    }

    case "albumtags":
    case "alt": {
      let artistName = null;
      let albumName = null;

      const pAlt = await this.getPlayer(msg, false, false, false);
      const current = extractCurrentTrack(pAlt);
      if (current?.album && current?.artist) {
        artistName = current.artist;
        albumName = current.album;
      }

      const tokenTextAlt = data.get("token")?.value;
      if (tokenTextAlt) {
        const dashMatch = tokenTextAlt.match(/^(.+?)\s*[-–—]\s*(.+)$/);
        if (dashMatch) {
          artistName = dashMatch[1].trim();
          albumName = dashMatch[2].trim();
        } else {
          albumName = tokenTextAlt.trim();
        }
      }

      if (!albumName) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.noAlbumSpecified"))]
        });
      }

      let tags;
      try {
        tags = await lastfm.getAlbumTopTags(artistName || "", albumName, 15);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!tags.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(`🏷️ No tags found for album **${albumName}**.`)]
        });
      }

      const lines = tags.map((t, i) => {
        const num = String(i + 1).padStart(2, " ");
        const link = t.url ? `[${t.name}](${t.url})` : t.name;
        return `\`${num}.\` ${link}${t.count > 0 ? ` — **${Utils.formatNumber(t.count)}**` : ""}`;
      });

      const desc = lines.join("\n").slice(0, 4096);

      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(getGlobalColor())
          .setTitle(this.t(msg, "responses.lastfm.artistTagsTitle", { artist: albumName }))
          .setDescription(desc)]
      });
    }

    case "tracktags":
    case "tt": {
      let artistName = null;
      let trackName = null;

      const pTt = await this.getPlayer(msg, false, false, false);
      const current = extractCurrentTrack(pTt);
      if (current?.artist && current?.name) {
        artistName = current.artist;
        trackName = current.name;
      }

      const tokenTextTt = data.get("token")?.value;
      if (tokenTextTt) {
        const dashMatch = tokenTextTt.match(/^(.+?)\s*[-–—]\s*(.+)$/);
        if (dashMatch) {
          artistName = dashMatch[1].trim();
          trackName = dashMatch[2].trim();
        } else {
          try {
            const searchResult = await lastfm.searchTrack(tokenTextTt.trim());
            if (searchResult) {
              artistName = searchResult.artist;
              trackName = searchResult.name;
            }
          } catch(e) { logger.warn("[LastFm] Error:", e?.message); }
        }
      }

      if (!artistName || !trackName) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.noTrackSpecified"))]
        });
      }

      let tags;
      try {
        tags = await lastfm.getTrackTopTags(artistName, trackName, 15);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!tags.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(`🏷️ No tags found for **${trackName}** by **${artistName}**.`)]
        });
      }

      const lines = tags.map((t, i) => {
        const num = String(i + 1).padStart(2, " ");
        const link = t.url ? `[${t.name}](${t.url})` : t.name;
        return `\`${num}.\` ${link}${t.count > 0 ? ` — **${Utils.formatNumber(t.count)}**` : ""}`;
      });

      const desc = lines.join("\n").slice(0, 4096);

      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(getGlobalColor())
          .setTitle(this.t(msg, "responses.lastfm.artistTagsTitle", { artist: trackName }))
          .setDescription(desc)]
      });
    }

    case "tagalbums":
    case "ta": {
      const tagName = data.get("token")?.value;
      if (!tagName) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(`❌ Provide a tag name via the token option. Example: \`${prefix}lastfm tagalbums rock\``)]
        });
      }

      let albums;
      try {
        albums = await lastfm.getTagTopAlbums(tagName.trim(), 15);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!albums.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(`💿 No top albums found for tag **${tagName}**.`)]
        });
      }

      const lines = albums.map((a, i) => {
        const num = String(i + 1).padStart(2, " ");
        const link = a.url ? `[${a.name}](${a.url})` : a.name;
        return `\`${num}.\` ${link} by **${a.artist}**${a.playcount > 0 ? ` (${Utils.formatNumber(a.playcount)} plays)` : ""}`;
      });

      const desc = lines.join("\n").slice(0, 4096);

      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle(`💿 Top Albums — ${tagName}`)
        .setDescription(desc);

      if (albums[0]?.image) {
        embed.setThumbnail(albums[0].image);
      }

      return msg.reply({ embeds: [embed] });
    }

  }
}
