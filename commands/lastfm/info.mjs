/**
 * @module commands/lastfm/info
 * @description Metadata lookup actions for the lastfm command (artistinfo, albuminfo, trackinfo, topalbums, toptags, cover) with the duration formatter. Extracted verbatim from the original single-file command; dispatched by commands/lastfm.mjs.
 */


import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../../src/ui/index.mjs";
import { Utils } from "../../src/utils/Utils.mjs";
import { logger } from "../../src/core/Logger.mjs";
import { ERROR_COLOR } from "../../src/utils/UI.mjs";
import { notLinked, extractCurrentTrack, extractPeriod } from "./shared.mjs";

/**
 * Action names dispatched to this module.
 * @type {Set<string>}
 */
export const INFO_ACTIONS = new Set([
  "artistinfo",,
  "ai",,
  "albuminfo",,
  "ali",,
  "trackinfo",,
  "ti",,
  "topalbums",,
  "toptags",,
  "tags",,
  "cover",,
  "art"
]);


/**
 * Format seconds into a human-readable duration string (h:mm:ss or m:ss).
 * @private
 * @param {number} seconds - Duration in seconds.
 * @returns {string} Formatted duration, or empty string if invalid.
 */
function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
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
export async function runInfoActions(msg, data, lastfm, prefix, userId, targetUserId, action) {
  switch (action) {
    case "artistinfo":
    case "ai": {
      const user = await lastfm.getUser(userId);

      let artistName = null;

      const pAi = await this.getPlayer(msg, false, false, false);
      const current = extractCurrentTrack(pAi);
      if (current?.artist) {
        artistName = current.artist;
      }

      const tokenText = data.get("token")?.value;
      if (tokenText) {
        artistName = tokenText.trim();
      }

      if (!artistName) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(
            this.t(msg, "responses.lastfm.noArtistSpecified")
          )]
        });
      }

      let info;
      try {
        info = await lastfm.getArtistInfo(artistName, userId);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!info) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.artistNotFound", { artist: artistName }))]
        });
      }

      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle(`🎤 ${info.name}`)
        .setURL(info.url || undefined)
        .setThumbnail(info.image || undefined);

      const fields = [];
      fields.push({ name: "Listeners", value: Utils.formatNumber(info.stats?.listeners ?? 0), inline: true });
      fields.push({ name: "Global Plays", value: Utils.formatNumber(info.stats?.playcount ?? 0), inline: true });

      if (info.userplaycount != null && user) {
        fields.push({ name: "Your Plays", value: Utils.formatNumber(info.userplaycount), inline: true });
      }

      if (info.tags?.length) {
        const tagStr = info.tags.slice(0, 8).map(t => {
          const tagLower = String(t).toLowerCase().replace(/\s+/g, "+");
          return `[${t}](https://www.last.fm/tag/${encodeURIComponent(tagLower)})`;
        }).join(" · ");
        fields.push({ name: "Tags", value: tagStr, inline: false });
      }

      if (info.similar?.length) {
        const simStr = info.similar.slice(0, 5).map(s => {
          return s.url ? `[${s.name}](${s.url})` : s.name;
        }).join(" · ");
        fields.push({ name: "Similar Artists", value: simStr, inline: false });
      }

      embed.addFields(...fields);

      if (info.bio) {
        const cleanBio = info.bio.replace(/<[^>]*>/g, "").trim();
        if (cleanBio.length > 0) {
          const truncated = cleanBio.length > 300 ? cleanBio.slice(0, 297) + "..." : cleanBio;
          embed.setDescription(truncated);
        }
      }

      embed.setFooter({ text: user ? `Last.fm: ${user.username}` : "Last.fm" });

      return msg.reply({ embeds: [embed] });
    }

    case "albuminfo":
    case "ali": {
      const user = await lastfm.getUser(userId);

      let artistName = null;
      let albumName = null;

      const pAli = await this.getPlayer(msg, false, false, false);
      const current = extractCurrentTrack(pAli);
      if (current?.album && current?.artist) {
        artistName = current.artist;
        albumName = current.album;
      }

      const tokenText = data.get("token")?.value;
      if (tokenText) {
        const dashMatch = tokenText.match(/^(.+?)\s*[-–—]\s*(.+)$/);
        if (dashMatch) {
          artistName = dashMatch[1].trim();
          albumName = dashMatch[2].trim();
        } else {
          albumName = tokenText.trim();
        }
      }

      if (!albumName) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(
            this.t(msg, "responses.lastfm.noAlbumSpecified")
          )]
        });
      }

      let info;
      try {
        info = await lastfm.getAlbumInfo(artistName || "", albumName, userId);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!info) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.albumNotFound", { album: albumName }))]
        });
      }

      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle(`💿 ${info.name}`)
        .setURL(info.url || undefined)
        .setThumbnail(info.image || undefined);

      const fields = [];

      if (info.artist) {
        fields.push({ name: "Artist", value: info.artist, inline: true });
      }

      if (info.userplaycount != null && user) {
        fields.push({ name: "Your Plays", value: Utils.formatNumber(info.userplaycount), inline: true });
      }

      if (info.tags?.length) {
        const tagStr = info.tags.slice(0, 8).map(t => {
          const tagLower = String(t).toLowerCase().replace(/\s+/g, "+");
          return `[${t}](https://www.last.fm/tag/${encodeURIComponent(tagLower)})`;
        }).join(" · ");
        fields.push({ name: "Tags", value: tagStr, inline: false });
      }

      if (info.tracks?.length) {
        const trackLines = info.tracks.slice(0, 15).map((t, i) => {
          const num = String(i + 1).padStart(2, " ");
          const dur = t.duration > 0 ? ` (${formatDuration(t.duration)})` : "";
          const link = t.url ? `[${t.name}](${t.url})` : t.name;
          return `\`${num}.\` ${link}${dur}`;
        });
        fields.push({ name: "Tracklist", value: trackLines.join("\n").slice(0, 1024), inline: false });
      }

      embed.addFields(...fields);
      embed.setFooter({ text: user ? `Last.fm: ${user.username}` : "Last.fm" });

      return msg.reply({ embeds: [embed] });
    }

    case "trackinfo":
    case "ti": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      let artistName = null;
      let trackName = null;

      const pTi = await this.getPlayer(msg, false, false, false);
      const current = extractCurrentTrack(pTi);
      if (current?.artist && current?.name) {
        artistName = current.artist;
        trackName = current.name;
      }

      const tokenText = data.get("token")?.value;
      if (tokenText) {
        const dashMatch = tokenText.match(/^(.+?)\s*[-–—]\s*(.+)$/);
        if (dashMatch) {
          artistName = dashMatch[1].trim();
          trackName = dashMatch[2].trim();
        } else {
          try {
            const searchResult = await lastfm.searchTrack(tokenText.trim());
            if (searchResult) {
              artistName = searchResult.artist;
              trackName = searchResult.name;
            }
          } catch(e) { logger.warn("[LastFm] Error:", e?.message); }
        }
      }

      if (!artistName || !trackName) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(
            this.t(msg, "responses.lastfm.noTrackSpecified")
          )]
        });
      }

      let info;
      try {
        info = await lastfm.getTrackInfo(artistName, trackName, userId);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!info) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.trackNotFound", { track: trackName, artist: artistName }))]
        });
      }

      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle(`🎵 ${info.name}`)
        .setURL(info.url || undefined);

      if (info.album?.image?.[2]?.["#text"] || info.album?.image?.[1]?.["#text"]) {
        embed.setThumbnail(info.album?.image?.[2]?.["#text"] || info.album?.image?.[1]?.["#text"]);
      }

      const fields = [];

      if (info.artist?.name || info.artist?.["#text"]) {
        fields.push({ name: "Artist", value: String(info.artist?.name ?? info.artist?.["#text"] ?? "Unknown"), inline: true });
      }

      if (info.album?.title) {
        fields.push({ name: "Album", value: info.album.title, inline: true });
      }

      if (info.listeners) {
        fields.push({ name: "Listeners", value: Utils.formatNumber(Number(info.listeners)), inline: true });
      }

      if (info.playcount) {
        fields.push({ name: "Global Plays", value: Utils.formatNumber(Number(info.playcount)), inline: true });
      }

      if (info.userplaycount) {
        fields.push({ name: "Your Plays", value: Utils.formatNumber(Number(info.userplaycount)), inline: true });
      }

      const userLoved = info.userloved === "1" || info.userloved === 1 || info.userloved === true;
      fields.push({ name: "Loved", value: userLoved ? "❤️ Yes" : "🖤 No", inline: true });

      if (info.toptags?.tag?.length) {
        const tagStr = info.toptags.tag.slice(0, 8).map(t => {
          const tagName = t.name ?? t;
          const tagLower = String(tagName).toLowerCase().replace(/\s+/g, "+");
          return `[${tagName}](https://www.last.fm/tag/${encodeURIComponent(tagLower)})`;
        }).join(" · ");
        fields.push({ name: "Tags", value: tagStr, inline: false });
      }

      embed.addFields(...fields);

      if (info.wiki?.summary) {
        const cleanSummary = info.wiki.summary.replace(/<[^>]*>/g, "").trim();
        if (cleanSummary.length > 0) {
          const truncated = cleanSummary.length > 200 ? cleanSummary.slice(0, 197) + "..." : cleanSummary;
          embed.setDescription(truncated);
        }
      }

      let similarTracks = [];
      try {
        similarTracks = await lastfm.getSimilarTracks(artistName, trackName, 5);
      } catch(e) { logger.warn("[LastFm] Error:", e?.message); }

      if (similarTracks.length) {
        const simStr = similarTracks.map(t => {
          const matchPct = Math.round(t.match * 100);
          const link = t.url ? `[${t.name}](${t.url})` : t.name;
          return `${link} by **${t.artist}** (${matchPct}%)`;
        }).join("\n");
        embed.addFields({ name: "Similar Tracks", value: simStr.slice(0, 1024), inline: false });
      }

      embed.setFooter({ text: `Last.fm: ${user.username}` });

      return msg.reply({ embeds: [embed] });
    }

    case "topalbums": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      const period = extractPeriod(data, msg);

      let albums;
      try {
        albums = await lastfm.getTopAlbums(userId, period, 15);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!albums.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.noTopAlbums", { username: user.username }))]
        });
      }

      const periodLabel = period !== "overall" ? ` (${period})` : "";

      const lines = albums.map((a, i) => {
        const num = String(i + 1).padStart(2, " ");
        let albumTitle = a.name;
        if (albumTitle.length > 30) albumTitle = albumTitle.slice(0, 27) + "...";
        const link = a.url ? `[${albumTitle}](${a.url})` : albumTitle;
        return `\`${num}.\` ${link} — **${a.artist}** (**${a.playcount}** plays)`;
      });

      const desc = lines.join("\n").slice(0, 4096);

      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle(this.t(msg, "responses.lastfm.topAlbumsTitle", { period: periodLabel, username: user.username }))
        .setDescription(desc);

      if (albums[0]?.image) {
        embed.setThumbnail(albums[0].image);
      }

      embed.setFooter({ text: this.t(msg, "responses.lastfm.topAlbumsFooter", { prefix }) });

      return msg.reply({ embeds: [embed] });
    }

    case "toptags":
    case "tags": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      let tags;
      try {
        tags = await lastfm.getUserTopTags(userId, 20);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!tags.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.noTopTags", { username: user.username }))]
        });
      }

      const lines = tags.map((t, i) => {
        const num = String(i + 1).padStart(2, " ");
        const link = t.url ? `[${t.name}](${t.url})` : t.name;
        return `\`${num}.\` ${link} — **${t.count}**`;
      });

      const desc = lines.join("\n").slice(0, 4096);

      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(getGlobalColor())
          .setTitle(this.t(msg, "responses.lastfm.topTagsTitle", { username: user.username }))
          .setDescription(desc)
          .setFooter({ text: this.t(msg, "responses.lastfm.topTagsFooter", { prefix }) })]
      });
    }

    case "cover":
    case "art": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      const pCover = await this.getPlayer(msg, false, false, false);
      const current = extractCurrentTrack(pCover);
      if (!current || !current.name) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.coverNothingPlaying"))]
        });
      }

      const artistName = current.artist ?? "Unknown";
      const trackName = current.name;
      const albumName = current.album;

      let coverUrl = null;
      let albumTitle = albumName ?? "Unknown Album";

      if (albumName) {
        try {
          const albumInfo = await lastfm.getAlbumInfo(artistName, albumName, userId);
          if (albumInfo?.image) {
            coverUrl = albumInfo.image;
            albumTitle = `${albumInfo.name} by ${albumInfo.artist}`;
          }
        } catch(e) { logger.warn("[LastFm] Error:", e?.message); }
      }

      if (!coverUrl) {
        try {
          const trackInfo = await lastfm.getTrackInfo(artistName, trackName, userId);
          if (trackInfo?.album?.image) {
            const images = trackInfo.album.image;
            coverUrl = images?.[2]?.["#text"] || images?.[1]?.["#text"] || images?.[0]?.["#text"] || null;
            if (trackInfo.album?.title) {
              albumTitle = trackInfo.album.title;
            }
          }
        } catch(e) { logger.warn("[LastFm] Error:", e?.message); }
      }

      if (!coverUrl) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.coverNotFound", { track: trackName, artist: artistName }))]
        });
      }

      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle(this.t(msg, "responses.lastfm.coverTitle", { album: albumTitle }))
        .setImage(coverUrl)
        .setFooter({ text: this.t(msg, "responses.lastfm.coverFooter", { track: trackName, artist: artistName }) });

      return msg.reply({ embeds: [embed] });
    }

  }
}
