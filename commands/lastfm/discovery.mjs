/**
 * @module commands/lastfm/discovery
 * @description Charts and discovery actions for the lastfm command (friends, weekly, trending, geo, artisttracks, search). Extracted verbatim from the original single-file command; dispatched by commands/lastfm.mjs.
 */


import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../../src/ui/index.mjs";
import { Utils } from "../../src/utils/Utils.mjs";
import { ERROR_COLOR } from "../../src/utils/UI.mjs";
import { notLinked, extractCurrentTrack } from "./shared.mjs";

/**
 * Action names dispatched to this module.
 * @type {Set<string>}
 */
export const DISCOVERY_ACTIONS = new Set([
  "friends",,
  "fr",,
  "weekly",,
  "wc",,
  "trending",,
  "tr",,
  "geo",,
  "g",,
  "artisttracks",,
  "atr",,
  "search",,
  "s"
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
export async function runDiscoveryActions(msg, data, lastfm, prefix, userId, targetUserId, action) {
  switch (action) {
    case "friends":
    case "fr": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      let friends;
      try {
        friends = await lastfm.getUserFriends(userId, 20);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!friends.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(`👥 No friends found for **${user.username}**.`)]
        });
      }

      const lines = friends.map((f, i) => {
        const num = String(i + 1).padStart(2, " ");
        const link = f.url ? `[${f.name}](${f.url})` : f.name;
        const details = [];
        if (f.realname) details.push(f.realname);
        if (f.country) details.push(f.country);
        const detailStr = details.length > 0 ? ` (${details.join(", ")})` : "";
        return `\`${num}.\` ${link}${detailStr}`;
      });

      const desc = lines.join("\n").slice(0, 4096);

      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(getGlobalColor())
          .setTitle(`👥 Friends — ${user.username}`)
          .setDescription(desc)]
      });
    }

    case "weekly":
    case "wc": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      const tokenTextWc = data.get("token")?.value?.toLowerCase().trim() ?? "artists";
      let chartData;
      let chartTitle;

      try {
        if (tokenTextWc === "tracks") {
          chartData = await lastfm.getUserWeeklyTrackChart(userId);
          chartTitle = `📅 Weekly Track Chart — ${user.username}`;
        } else if (tokenTextWc === "albums") {
          chartData = await lastfm.getUserWeeklyAlbumChart(userId);
          chartTitle = `📅 Weekly Album Chart — ${user.username}`;
        } else {
          chartData = await lastfm.getUserWeeklyArtistChart(userId);
          chartTitle = `📅 Weekly Artist Chart — ${user.username}`;
        }
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!chartData.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(`📅 No weekly chart data found for **${user.username}**.`)]
        });
      }

      const lines = chartData.slice(0, 15).map((item, i) => {
        const num = String(i + 1).padStart(2, " ");
        const link = item.url ? `[${item.name}](${item.url})` : item.name;
        const artistStr = item.artist ? ` by **${item.artist}**` : "";
        return `\`${num}.\` ${link}${artistStr} — **${Utils.formatNumber(item.playcount)}** plays`;
      });

      const desc = lines.join("\n").slice(0, 4096);

      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(getGlobalColor())
          .setTitle(chartTitle)
          .setDescription(desc)
          .setFooter({ text: `💡 Use token option: artists, tracks, or albums` })]
      });
    }

    case "trending":
    case "tr": {
      const tokenTextTr = data.get("token")?.value?.toLowerCase().trim() ?? "tracks";
      let trendingData;
      let trendingTitle;

      try {
        if (tokenTextTr === "artists") {
          trendingData = await lastfm.getChartTopArtists(15);
          trendingTitle = "🔥 Trending Artists on Last.fm";
        } else {
          trendingData = await lastfm.getChartTopTracks(15);
          trendingTitle = "🔥 Trending Tracks on Last.fm";
        }
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!trendingData.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(`🔥 No trending data found.`)]
        });
      }

      const lines = trendingData.map((item, i) => {
        const num = String(i + 1).padStart(2, " ");
        const link = item.url ? `[${item.name}](${item.url})` : item.name;
        const artistStr = item.artist ? ` by **${item.artist}**` : "";
        const extra = item.listeners ? ` — ${Utils.formatNumber(item.listeners)} listeners` : item.playcount ? ` — ${Utils.formatNumber(item.playcount)} plays` : "";
        return `\`${num}.\` ${link}${artistStr}${extra}`;
      });

      const desc = lines.join("\n").slice(0, 4096);

      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(getGlobalColor())
          .setTitle(trendingTitle)
          .setDescription(desc)
          .setFooter({ text: `💡 Use token option: tracks or artists` })]
      });
    }

    case "geo":
    case "g": {
      const tokenTextG = data.get("token")?.value?.trim() ?? "";
      if (!tokenTextG) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(`❌ Provide a query like \`artists <country>\` or \`tracks <country>\`. Example: \`${prefix}lastfm geo artists united states\`.`)]
        });
      }

      const lowerToken = tokenTextG.toLowerCase();
      let type = "artists";
      let country = tokenTextG;

      if (lowerToken.startsWith("artists ")) {
        type = "artists";
        country = tokenTextG.slice(8).trim();
      } else if (lowerToken.startsWith("tracks ")) {
        type = "tracks";
        country = tokenTextG.slice(7).trim();
      }

      if (!country) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(`❌ Please specify a country name. Example: \`${prefix}lastfm geo artists united states\`.`)]
        });
      }

      let geoData;
      let geoTitle;

      try {
        if (type === "tracks") {
          geoData = await lastfm.getGeoTopTracks(country, 15);
          geoTitle = `🌍 Top Tracks in ${country}`;
        } else {
          geoData = await lastfm.getGeoTopArtists(country, 15);
          geoTitle = `🌍 Top Artists in ${country}`;
        }
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!geoData.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(`🌍 No data found for **${country}**.`)]
        });
      }

      const lines = geoData.map((item, i) => {
        const num = String(i + 1).padStart(2, " ");
        const link = item.url ? `[${item.name}](${item.url})` : item.name;
        const artistStr = item.artist ? ` by **${item.artist}**` : "";
        const extra = item.listeners ? ` — ${Utils.formatNumber(item.listeners)} listeners` : "";
        return `\`${num}.\` ${link}${artistStr}${extra}`;
      });

      const desc = lines.join("\n").slice(0, 4096);

      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(getGlobalColor())
          .setTitle(geoTitle)
          .setDescription(desc)]
      });
    }

    case "artisttracks":
    case "atr": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      let artistName = null;

      const pAtr = await this.getPlayer(msg, false, false, false);
      const current = extractCurrentTrack(pAtr);
      if (current?.artist) {
        artistName = current.artist;
      }

      const tokenTextAtr = data.get("token")?.value;
      if (tokenTextAtr) {
        artistName = tokenTextAtr.trim();
      }

      if (!artistName) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.noArtistSpecified"))]
        });
      }

      let recentTracks;
      try {
        recentTracks = await lastfm.getRecentTracks(userId, 200);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      const artistTracks = recentTracks.filter(t =>
        t.artist.toLowerCase() === artistName.toLowerCase()
      );

      if (!artistTracks.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(`🎵 No scrobbles found for **${artistName}** in your recent history.`)]
        });
      }

      const lines = artistTracks.slice(0, 15).map((t, i) => {
        const num = String(i + 1).padStart(2, " ");
        const link = t.url ? `[${t.name}](${t.url})` : t.name;
        const nowStr = t.now ? " 🎵" : "";
        return `\`${num}.\` ${link}${nowStr}`;
      });

      const desc = lines.join("\n").slice(0, 4096);

      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(getGlobalColor())
          .setTitle(`🎵 ${artistName} Scrobbles — ${user.username}`)
          .setDescription(desc)
          .setFooter({ text: `${artistTracks.length} scrobble${artistTracks.length !== 1 ? "s" : ""} found` })]
      });
    }

    case "search":
    case "s": {
      const query = data.get("token")?.value;
      if (!query) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(`❌ Provide a search query via the token option. Example: \`${prefix}lastfm search radiohead\``)]
        });
      }

      let artistResults, albumResults, trackResult;
      try {
        [artistResults, albumResults, trackResult] = await Promise.all([
          lastfm.searchArtist(query, 5),
          lastfm.searchAlbum(query, 5),
          lastfm.searchTrack(query),
        ]);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      const sections = [];

      if (artistResults.length) {
        const artistLines = artistResults.map((a, i) => {
          const link = a.url ? `[${a.name}](${a.url})` : a.name;
          const listeners = a.listeners ? ` — ${Utils.formatNumber(a.listeners)} listeners` : "";
          return `${i + 1}. ${link}${listeners}`;
        });
        sections.push(`**🎤 Artists:**\n${artistLines.join("\n")}`);
      }

      if (albumResults.length) {
        const albumLines = albumResults.map((a, i) => {
          const link = a.url ? `[${a.name}](${a.url})` : a.name;
          return `${i + 1}. ${link} by **${a.artist}**`;
        });
        sections.push(`**💿 Albums:**\n${albumLines.join("\n")}`);
      }

      if (trackResult) {
        sections.push(`**🎵 Best Track Match:**\n[${trackResult.name}](${trackResult.url}) by **${trackResult.artist}**`);
      }

      if (!sections.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(`🔍 No results found for **${query}**.`)]
        });
      }

      const desc = sections.join("\n\n").slice(0, 4096);

      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(getGlobalColor())
          .setTitle(`🔍 Search Results for "${query}"`)
          .setDescription(desc)]
      });
    }

  }
}
