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
  "whoknows",
  "wk",
  "compare",
  "fmc",
  "refreshmembers",
  "rm",
  "affinity",
  "af",
  "crowns",
  "cr",
  "whoknowstrack",
  "wkt",
  "whoknowsalbum",
  "wka"
]);


/**
 * Get all non-bot user IDs in a guild.
 * @async
 * @param {object} guild - The guild object.
 * @returns {Promise<string[]>} Array of user ID strings.
 */
export async function getGuildLinkedUsers(guild) {
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

      const top1 = listeners[0];
      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setAuthor({ name: this.t(msg, "responses.lastfm.serverLeaderboardAuthor") })
        .setTitle(artistName)
        .setFooter({ text: `${listeners.length} listener${listeners.length !== 1 ? "s" : ""} • ${Utils.formatNumber(totalPlays)} total plays • %fm` });

      if (top1) {
        embed.addFields({
          name: this.t(msg, "responses.lastfm.crownHolder"),
          value: `**${top1.username}** — **${Utils.formatNumber(top1.playcount)}** ${this.t(msg, "responses.lastfm.plays")}`,
          inline: false
        });
      }

      const rest = listeners.slice(1);
      if (rest.length > 0) {
        const lines = rest.map((l, i) => {
          const rank = i + 2;
          const medal = rank === 2 ? "🥈" : rank === 3 ? "🥉" : `\`#${rank}\``;
          return `${medal} **${l.username}** — **${Utils.formatNumber(l.playcount)}** ${this.t(msg, "responses.lastfm.plays")}`;
        });
        embed.setDescription(lines.join("\n").slice(0, 4096));
      }

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

      const pct = Math.min(100, Math.max(0, Math.round(comparison.matchPercentage ?? 0)));
      const filledBars = Math.round(pct / 10);
      const emptyBars = 10 - filledBars;
      const bar = "█".repeat(filledBars) + "░".repeat(emptyBars);

      let level = "Low";
      if (pct >= 80) level = "Super";
      else if (pct >= 60) level = "High";
      else if (pct >= 40) level = "Medium";
      else if (pct >= 20) level = "Fair";

      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setAuthor({ name: this.t(msg, "responses.lastfm.compareAuthor") })
        .setTitle(`${comparison.user1.username} & ${comparison.user2.username}`)
        .setDescription(
          `📊 **[${bar}] ${pct}% MATCH**\n` +
          `*${this.t(msg, "responses.lastfm.compareMeter", { level, score: pct })}*\n\n` +
          `👤 **${comparison.user1.username}**: ${Utils.formatNumber(comparison.user1.totalArtists)} artists · ` +
          `👤 **${comparison.user2.username}**: ${Utils.formatNumber(comparison.user2.totalArtists)} artists`
        )
        .setFooter({ text: this.t(msg, "responses.lastfm.compareFooterPro", { prefix }) });

      if (comparison.commonArtists?.length) {
        const commonStr = comparison.commonArtists.slice(0, 10).map((a, i) => {
          const num = String(i + 1).padStart(2, " ");
          const link = a.url ? `[${a.name}](${a.url})` : a.name;
          return `\`${num}.\` ${link} — **${Utils.formatNumber(a.playcount)}** ${this.t(msg, "responses.lastfm.plays")}`;
        }).join("\n");
        embed.addFields({
          name: `${this.t(msg, "responses.lastfm.compareFieldShared")} (${comparison.commonArtists.length})`,
          value: commonStr.slice(0, 1024),
          inline: false
        });
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

      const topCrown = filteredCrowns[0];
      const rest = filteredCrowns.slice(1, 15);

      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setAuthor({ name: this.t(msg, "responses.lastfm.crownsAuthor") })
        .setTitle(this.t(msg, "responses.lastfm.crownsTitle", { username: user.username }))
        .setFooter({ text: this.t(msg, "responses.lastfm.crownsFooterPro", { prefix }) });

      if (topCrown) {
        const topLink = topCrown.artistUrl ? `[${topCrown.artist}](${topCrown.artistUrl})` : topCrown.artist;
        let leadDesc = this.t(msg, "responses.lastfm.crownsUncontested");
        if (topCrown.nextBest && topCrown.nextBest.playcount > 0) {
          const lead = topCrown.userPlaycount - topCrown.nextBest.playcount;
          leadDesc = `${this.t(msg, "responses.lastfm.crownsLead", { lead: Utils.formatNumber(lead) })} · ${this.t(msg, "responses.lastfm.crownsRunnerUp", { user: topCrown.nextBest.username, plays: Utils.formatNumber(topCrown.nextBest.playcount) })}`;
        }
        embed.addFields({
          name: `👑 ${this.t(msg, "responses.lastfm.crownsMonopolyField")}`,
          value: `**${topLink}** — **${Utils.formatNumber(topCrown.userPlaycount)}** ${this.t(msg, "responses.lastfm.plays")}\n*${leadDesc}*`,
          inline: false
        });
      }

      if (rest.length > 0) {
        const otherLines = rest.map(c => {
          const link = c.artistUrl ? `[${c.artist}](${c.artistUrl})` : c.artist;
          const runner = c.nextBest ? ` (${c.nextBest.username}: ${Utils.formatNumber(c.nextBest.playcount)})` : "";
          return `👑 ${link} — **${Utils.formatNumber(c.userPlaycount)}**${runner}`;
        });
        embed.addFields({
          name: `🏛️ ${this.t(msg, "responses.lastfm.crownsOtherField")} (${filteredCrowns.length})`,
          value: otherLines.join("\n").slice(0, 1024),
          inline: false
        });
      }

      if (topCrown?.image) {
        embed.setThumbnail(topCrown.image);
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

      const totalPlays = listeners.reduce((sum, l) => sum + l.playcount, 0);
      const top1 = listeners[0];

      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setAuthor({ name: this.t(msg, "responses.lastfm.trackLeaderboardAuthor") })
        .setTitle(trackName + (artistName ? ` by ${artistName}` : ""))
        .setFooter({ text: this.t(msg, "responses.lastfm.whoknowsTrackFooter", { count: listeners.length, plural: listeners.length !== 1 ? "s" : "", totalPlays: Utils.formatNumber(totalPlays), artist: artistName }) });

      if (top1) {
        embed.addFields({
          name: this.t(msg, "responses.lastfm.crownHolder"),
          value: `**${top1.username}** — **${Utils.formatNumber(top1.playcount)}** ${this.t(msg, "responses.lastfm.plays")}`,
          inline: false
        });
      }

      const rest = listeners.slice(1);
      if (rest.length > 0) {
        const lines = rest.map((l, i) => {
          const rank = i + 2;
          const medal = rank === 2 ? "🥈" : rank === 3 ? "🥉" : `\`#${rank}\``;
          return `${medal} **${l.username}** — **${Utils.formatNumber(l.playcount)}** ${this.t(msg, "responses.lastfm.plays")}`;
        });
        embed.setDescription(lines.join("\n").slice(0, 4096));
      }

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

      const totalPlays = listeners.reduce((sum, l) => sum + l.playcount, 0);
      const top1 = listeners[0];

      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setAuthor({ name: this.t(msg, "responses.lastfm.albumLeaderboardAuthor") })
        .setTitle(albumName + (artistName ? ` by ${artistName}` : ""))
        .setFooter({ text: this.t(msg, "responses.lastfm.whoknowsFooter", { count: listeners.length, plural: listeners.length !== 1 ? "s" : "", totalPlays: Utils.formatNumber(totalPlays) }) });

      if (top1) {
        embed.addFields({
          name: this.t(msg, "responses.lastfm.crownHolder"),
          value: `**${top1.username}** — **${Utils.formatNumber(top1.playcount)}** ${this.t(msg, "responses.lastfm.plays")}`,
          inline: false
        });
      }

      const rest = listeners.slice(1);
      if (rest.length > 0) {
        const lines = rest.map((l, i) => {
          const rank = i + 2;
          const medal = rank === 2 ? "🥈" : rank === 3 ? "🥉" : `\`#${rank}\``;
          return `${medal} **${l.username}** — **${Utils.formatNumber(l.playcount)}** ${this.t(msg, "responses.lastfm.plays")}`;
        });
        embed.setDescription(lines.join("\n").slice(0, 4096));
      }

      const replyPayload = { embeds: [embed] };
      if (statusMsg) statusMsg.edit(replyPayload).catch(() => msg.reply(replyPayload));
      else msg.reply(replyPayload);
      return;
    }

  }
}
