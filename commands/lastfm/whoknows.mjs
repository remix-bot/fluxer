/**
 * @module commands/lastfm/whoknows
 * @description Server-social actions for the lastfm command (whoknows, whoknowstrack, whoknowsalbum, affinity, crowns, compare, refreshmembers) with the guild-member helper. Extracted verbatim from the original single-file command; dispatched by commands/lastfm.mjs.
 */


import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../../src/ui/index.mjs";
import { Utils } from "../../src/utils/Utils.mjs";
import { logger } from "../../src/core/Logger.mjs";
import { ERROR_COLOR } from "../../src/utils/UI.mjs";
import { notLinked, extractCurrentTrack } from "./shared.mjs";

/**
 * Action names dispatched to this module.
 * @type {Set<string>}
 */
export const WHOKNOWS_ACTIONS = new Set([
  "whoknows",,
  "wk",,
  "compare",,
  "fmc",,
  "refreshmembers",,
  "rm",,
  "affinity",,
  "af",,
  "crowns",,
  "cr",,
  "whoknowstrack",,
  "wkt",,
  "whoknowsalbum",,
  "wka"
]);


/**
 * Get all non-bot user IDs in a guild.
 * @private
 * @async
 * @param {object} guild - The guild object.
 * @returns {Promise<string[]>} Array of user ID strings.
 */
async function getGuildLinkedUsers(guild) {
  const memberIds = [];
  try {
    const members = guild?.members;
    if (members) {
      const iter = typeof members.values === "function" ? members.values() : Object.values(members);
      for (const m of iter) {
        const userId = m.user?.id ?? m.id;
        if (userId && !m.user?.bot) memberIds.push(String(userId));
      }
    }
  } catch(e) { logger.warn("[LastFm] Error:", e?.message); }
  return memberIds;
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
export async function runWhoknowsActions(msg, data, lastfm, prefix, userId, targetUserId, action) {
  switch (action) {
    case "whoknows":
    case "wk": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      let artistName = null;
      const tokenTextWk = data.get("token")?.value;
      if (tokenTextWk) {
        artistName = tokenTextWk.trim();
      } else {
        const pWk = await this.getPlayer(msg, false, false, false);
        const current = extractCurrentTrack(pWk);
        if (current?.artist) {
          artistName = current.artist;
        }
      }

      if (!artistName) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.nothingPlayingNoArtist"))]
        });
      }

      let statusMsg;
      try {
        statusMsg = await msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(
            this.t(msg, "responses.lastfm.whoknowsChecking", { artist: artistName })
          )]
        });
      } catch (e) { logger.warn("[LastfmCmd] Error:", e?.message); statusMsg = null; }

      const guild = msg.message?.guild ?? msg.message?.member?.guild;
      const memberIds = await getGuildLinkedUsers(guild);

      let listeners;
      try {
        listeners = await lastfm.getWhoKnows(artistName, memberIds);
      } catch (err) {
        const errEmbed = { embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))] };
        if (statusMsg) statusMsg.edit(errEmbed).catch(() => msg.reply(errEmbed));
        else msg.reply(errEmbed);
        return;
      }

      if (!listeners.length) {
        const noData = { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(
          this.t(msg, "responses.lastfm.whoknowsNobody", { artist: artistName })
        )] };
        if (statusMsg) statusMsg.edit(noData).catch(() => msg.reply(noData));
        else msg.reply(noData);
        return;
      }

      const MEDALS = ["🥇", "🥈", "🥉"];
      const totalPlays = listeners.reduce((sum, l) => sum + l.playcount, 0);

      const lines = listeners.map((l, i) => {
        const medal = i < 3 ? MEDALS[i] : `  `;
        return `${medal} ${i + 1}. **${l.username}** — **${Utils.formatNumber(l.playcount)}** plays`;
      });

      const desc = lines.join("\n").slice(0, 4096);

      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle(this.t(msg, "responses.lastfm.whoknowsTitle", { artist: artistName }))
        .setDescription(desc)
        .setFooter({ text: this.t(msg, "responses.lastfm.whoknowsFooter", { count: listeners.length, plural: listeners.length !== 1 ? "s" : "", totalPlays: Utils.formatNumber(totalPlays) }) });

      const replyPayload = { embeds: [embed] };
      if (statusMsg) statusMsg.edit(replyPayload).catch(() => msg.reply(replyPayload));
      else msg.reply(replyPayload);
      return;
    }

    case "compare":
    case "fmc": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      if (!targetUserId) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(
            this.t(msg, "responses.lastfm.compareSpecifyUser", { prefix })
          )]
        });
      }

      const targetUser = await lastfm.getUser(targetUserId);
      if (!targetUser) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(
            this.t(msg, "responses.lastfm.compareUserNotLinked")
          )]
        });
      }

      let comparison;
      try {
        comparison = await lastfm.compareUsers(userId, targetUserId);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!comparison) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.compareFailed"))]
        });
      }

      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle(this.t(msg, "responses.lastfm.compareTitle"))
        .setDescription([
          `**${comparison.user1.username}** vs **${comparison.user2.username}**`,
          ``,
          `📊 **${comparison.matchPercentage}%** match`,
          ``,
          `👤 ${comparison.user1.username}: ${comparison.user1.totalArtists} top artists`,
          `👤 ${comparison.user2.username}: ${comparison.user2.totalArtists} top artists`,
        ].join("\n"));

      if (comparison.commonArtists?.length) {
        const commonStr = comparison.commonArtists.slice(0, 15).map((a, i) => {
          const num = String(i + 1).padStart(2, " ");
          const link = a.url ? `[${a.name}](${a.url})` : a.name;
          return `\`${num}.\` ${link} (**${a.playcount}** plays)`;
        }).join("\n");
        embed.addFields({ name: `Common Artists (${comparison.commonArtists.length})`, value: commonStr.slice(0, 1024), inline: false });
      }

      return msg.reply({ embeds: [embed] });
    }

    case "refreshmembers":
    case "rm": {
      const guild = msg.message?.guild ?? msg.message?.member?.guild;
      if (!guild) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.refreshFailed"))]
        });
      }
      let count = 0;
      try {
        if (guild.members && typeof guild.members.fetch === "function") {
          const fetched = await guild.members.fetch();
          count = fetched.size;
        } else {
          const memberIds = await getGuildLinkedUsers(guild);
          count = memberIds.length;
        }
      } catch {
        const memberIds = await getGuildLinkedUsers(guild);
        count = memberIds.length;
      }
      return msg.reply({
        embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.refreshSuccess", { count: Utils.formatNumber(count) }))]
      });
    }

    case "affinity":
    case "af": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      const guild = msg.message?.guild ?? msg.message?.member?.guild;
      const memberIds = await getGuildLinkedUsers(guild);

      if (memberIds.length < 2) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.affinityNeedUsers"))]
        });
      }

      let statusMsg;
      try {
        statusMsg = await msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.affinityChecking"))]
        });
      } catch (e) { logger.warn("[LastfmCmd] Error:", e?.message); statusMsg = null; }

      let affinityResults;
      try {
        affinityResults = await lastfm.getAffinity(memberIds, 10);
      } catch (err) {
        const errEmbed = { embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))] };
        if (statusMsg) statusMsg.edit(errEmbed).catch(() => msg.reply(errEmbed));
        else msg.reply(errEmbed);
        return;
      }

      if (!affinityResults.length) {
        const noData = { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.affinityNoCommon"))] };
        if (statusMsg) statusMsg.edit(noData).catch(() => msg.reply(noData));
        else msg.reply(noData);
        return;
      }

      const lines = affinityResults.map(r => {
        const topCommon = r.commonArtists.slice(0, 3).map(a => a.name).join(", ");
        return `**${r.users[0]}** & **${r.users[1]}** — ${r.matchCount} common artists (${topCommon}${r.commonArtists.length > 3 ? "..." : ""})`;
      });

      const desc = lines.join("\n").slice(0, 4096);

      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle(this.t(msg, "responses.lastfm.affinityTitle"))
        .setDescription(desc)
        .setFooter({ text: this.t(msg, "responses.lastfm.affinityFooter", { count: memberIds.length }) });

      const replyPayload = { embeds: [embed] };
      if (statusMsg) statusMsg.edit(replyPayload).catch(() => msg.reply(replyPayload));
      else msg.reply(replyPayload);
      return;
    }

    case "crowns":
    case "cr": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      const guild = msg.message?.guild ?? msg.message?.member?.guild;
      const memberIds = await getGuildLinkedUsers(guild);

      let statusMsg;
      try {
        statusMsg = await msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.crownsChecking"))]
        });
      } catch (e) { logger.warn("[LastfmCmd] Error:", e?.message); statusMsg = null; }

      let crowns;
      try {
        crowns = await lastfm.getCrowns(userId, memberIds);
      } catch (err) {
        const errEmbed = { embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))] };
        if (statusMsg) statusMsg.edit(errEmbed).catch(() => msg.reply(errEmbed));
        else msg.reply(errEmbed);
        return;
      }

      if (!crowns.length) {
        const noData = { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.crownsNone"))] };
        if (statusMsg) statusMsg.edit(noData).catch(() => msg.reply(noData));
        else msg.reply(noData);
        return;
      }

      const tokenFilter = data.get("token")?.value?.toLowerCase().trim();

      let filteredCrowns = crowns;
      if (tokenFilter === "stolen") {
        filteredCrowns = crowns.filter(c => c.nextBest && c.nextBest.playcount > 0);
      } else if (tokenFilter === "recent") {
        filteredCrowns = crowns.slice(0, 10);
      }

      const lines = filteredCrowns.slice(0, 20).map(c => {
        const link = c.artistUrl ? `[${c.artist}](${c.artistUrl})` : c.artist;
        const nextStr = c.nextBest ? ` (next: **${c.nextBest.username}** with ${Utils.formatNumber(c.nextBest.playcount)})` : "";
        return `👑 ${link} — **${Utils.formatNumber(c.userPlaycount)}** plays${nextStr}`;
      });

      const desc = lines.join("\n").slice(0, 4096);

      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle(this.t(msg, "responses.lastfm.crownsTitle", { username: user.username }))
        .setDescription(desc)
        .setFooter({ text: this.t(msg, "responses.lastfm.crownsFooter", { count: filteredCrowns.length, plural: filteredCrowns.length !== 1 ? "s" : "" }) });

      if (filteredCrowns[0]?.image) {
        embed.setThumbnail(filteredCrowns[0].image);
      }

      const replyPayload = { embeds: [embed] };
      if (statusMsg) statusMsg.edit(replyPayload).catch(() => msg.reply(replyPayload));
      else msg.reply(replyPayload);
      return;
    }

    case "whoknowstrack":
    case "wkt": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      let artistName = null;
      let trackName = null;

      const pWkt = await this.getPlayer(msg, false, false, false);
      const current = extractCurrentTrack(pWkt);
      if (current?.artist && current?.name) {
        artistName = current.artist;
        trackName = current.name;
      }

      const tokenTextWkt = data.get("token")?.value;
      if (tokenTextWkt) {
        const dashMatch = tokenTextWkt.match(/^(.+?)\s*[-–—]\s*(.+)$/);
        if (dashMatch) {
          artistName = dashMatch[1].trim();
          trackName = dashMatch[2].trim();
        } else {
          try {
            const searchResult = await lastfm.searchTrack(tokenTextWkt.trim());
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

      let statusMsg;
      try {
        statusMsg = await msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.whoknowsTrackChecking", { track: trackName, artist: artistName }))]
        });
      } catch (e) { logger.warn("[LastfmCmd] Error:", e?.message); statusMsg = null; }

      const guild = msg.message?.guild ?? msg.message?.member?.guild;
      const memberIds = await getGuildLinkedUsers(guild);

      let listeners;
      try {
        listeners = await lastfm.getWhoKnowsTrack(artistName, trackName, memberIds);
      } catch (err) {
        const errEmbed = { embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))] };
        if (statusMsg) statusMsg.edit(errEmbed).catch(() => msg.reply(errEmbed));
        else msg.reply(errEmbed);
        return;
      }

      if (!listeners.length) {
        const noData = { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.whoknowsTrackNobody", { track: trackName, artist: artistName }))] };
        if (statusMsg) statusMsg.edit(noData).catch(() => msg.reply(noData));
        else msg.reply(noData);
        return;
      }

      const MEDALS = ["🥇", "🥈", "🥉"];
      const totalPlays = listeners.reduce((sum, l) => sum + l.playcount, 0);

      const lines = listeners.map((l, i) => {
        const medal = i < 3 ? MEDALS[i] : `  `;
        return `${medal} ${i + 1}. **${l.username}** — **${Utils.formatNumber(l.playcount)}** plays`;
      });

      const desc = lines.join("\n").slice(0, 4096);

      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle(this.t(msg, "responses.lastfm.whoknowsTrackTitle", { track: trackName }))
        .setDescription(desc)
        .setFooter({ text: this.t(msg, "responses.lastfm.whoknowsTrackFooter", { count: listeners.length, plural: listeners.length !== 1 ? "s" : "", totalPlays: Utils.formatNumber(totalPlays), artist: artistName }) });

      const replyPayload = { embeds: [embed] };
      if (statusMsg) statusMsg.edit(replyPayload).catch(() => msg.reply(replyPayload));
      else msg.reply(replyPayload);
      return;
    }

    case "whoknowsalbum":
    case "wka": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      let artistName = null;
      let albumName = null;

      const pWka = await this.getPlayer(msg, false, false, false);
      const current = extractCurrentTrack(pWka);
      if (current?.album && current?.artist) {
        artistName = current.artist;
        albumName = current.album;
      }

      const tokenTextWka = data.get("token")?.value;
      if (tokenTextWka) {
        const dashMatch = tokenTextWka.match(/^(.+?)\s*[-–—]\s*(.+)$/);
        if (dashMatch) {
          artistName = dashMatch[1].trim();
          albumName = dashMatch[2].trim();
        } else {
          albumName = tokenTextWka.trim();
        }
      }

      if (!albumName) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.noAlbumSpecified"))]
        });
      }

      let statusMsg;
      try {
        statusMsg = await msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.whoknowsAlbumChecking", { album: albumName, artistClause: artistName ? ` by **${artistName}**` : "" }))]
        });
      } catch (e) { logger.warn("[LastfmCmd] Error:", e?.message); statusMsg = null; }

      const guild = msg.message?.guild ?? msg.message?.member?.guild;
      const memberIds = await getGuildLinkedUsers(guild);

      let listeners;
      try {
        listeners = await lastfm.getWhoKnowsAlbum(artistName || "", albumName, memberIds);
      } catch (err) {
        const errEmbed = { embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))] };
        if (statusMsg) statusMsg.edit(errEmbed).catch(() => msg.reply(errEmbed));
        else msg.reply(errEmbed);
        return;
      }

      if (!listeners.length) {
        const noData = { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.whoknowsAlbumNobody", { album: albumName }))] };
        if (statusMsg) statusMsg.edit(noData).catch(() => msg.reply(noData));
        else msg.reply(noData);
        return;
      }

      const MEDALS = ["🥇", "🥈", "🥉"];
      const totalPlays = listeners.reduce((sum, l) => sum + l.playcount, 0);

      const lines = listeners.map((l, i) => {
        const medal = i < 3 ? MEDALS[i] : `  `;
        return `${medal} ${i + 1}. **${l.username}** — **${Utils.formatNumber(l.playcount)}** plays`;
      });

      const desc = lines.join("\n").slice(0, 4096);

      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle(this.t(msg, "responses.lastfm.whoknowsAlbumTitle", { album: albumName }))
        .setDescription(desc)
        .setFooter({ text: this.t(msg, "responses.lastfm.whoknowsFooter", { count: listeners.length, plural: listeners.length !== 1 ? "s" : "", totalPlays: Utils.formatNumber(totalPlays) }) });

      const replyPayload = { embeds: [embed] };
      if (statusMsg) statusMsg.edit(replyPayload).catch(() => msg.reply(replyPayload));
      else msg.reply(replyPayload);
      return;
    }

  }
}
