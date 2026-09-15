/**
 * @module commands/lastfm/listening
 * @description Personal listening actions for the lastfm command (loved, top, leaderboard, recent, artists, love, unlove) with their list/leaderboard embed builders. Extracted verbatim from the original single-file command; dispatched by commands/lastfm.mjs.
 */


import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../../src/ui/index.mjs";
import { Utils } from "../../src/utils/Utils.mjs";
import { logger } from "../../src/core/Logger.mjs";
import { ERROR_COLOR, EMOJI_REMOVE_TIMEOUT } from "../../src/utils/UI.mjs";
import { notLinked, extractPeriod } from "./shared.mjs";

/**
 * Action names dispatched to this module.
 * @type {Set<string>}
 */
export const LISTENING_ACTIONS = new Set([
  "loved",
  "top",
  "leaderboard",
  "lb",
  "recent",
  "artists",
  "love",
  "unlove"
]);


/**
 * Build an embed listing tracks with optional playcount.
 * @private
 * @param {string} username - The Last.fm username.
 * @param {string} title - The list title.
 * @param {object[]} tracks - Array of track objects with name, artist, url, and optional playcount.
 * @param {function(string, object=): string} tr - Translator bound to the invoking message.
 * @param {boolean} [showPlaycount=false] - Whether to show play counts.
 * @param {string} [prefix="%"] - The command prefix for the footer hint.
 * @returns {EmbedBuilder} The constructed embed.
 */
function buildTrackList(username, title, tracks, tr, showPlaycount = false, prefix = "%") {
  const lines = tracks.map((t, i) => {
    const num = String(i + 1).padStart(2, " ");
    let name = t.name;
    if (name.length > 40) name = name.slice(0, 37) + "...";
    const link = t.url ? `[${name}](${t.url})` : name;
    const extra = showPlaycount && t.playcount ? ` (${t.playcount} ${tr("responses.lastfm.plays")})` : "";
    return `\`${num}.\` ${link} — **${t.artist}**${extra}`;
  });

  const desc = lines.join("\n").slice(0, 4096);

  return new EmbedBuilder()
    .setColor(getGlobalColor())
    .setTitle(title) /* locale titles (lovedTitle/topTitle/recentTitle) already embed {{username}} */
    .setDescription(desc)
    .setFooter({ text: tr("responses.lastfm.trackListFooter", { prefix }) });
}

/**
 * Build a scrobble leaderboard embed for a given page.
 * @private
 * @param {object} lb - Leaderboard data with entries, perPage and scope ("server"|"global").
 * @param {number} pageIdx - The page index (0-based).
 * @param {string} prefix - The command prefix for the footer hint.
 * @param {function(string, object=): string} tr - Translator bound to the invoking message.
 * @param {object} [opts] - Extra options.
 * @param {string|null} [opts.requesterId] - Invoking user's ID for the "you" marker.
 * @param {string|null} [opts.extraLine] - Extra description line (e.g. the requester's rank) appended below the list.
 * @returns {EmbedBuilder} The constructed embed.
 */
function buildLeaderboardEmbed(lb, pageIdx, prefix, tr, opts = {}) {
  const MEDALS = ["🥇", "🥈", "🥉"];
  const startRank = pageIdx * lb.perPage;
  const requesterId = opts.requesterId ? String(opts.requesterId) : null;

  const lines = lb.entries.map((entry, i) => {
    const rank = startRank + i + 1;
    const head = rank <= 3 ? `${MEDALS[rank - 1]} ` : "";
    const who = entry.userId ? `<@${entry.userId}>` : (entry.username || "?");
    const lfName = entry.username ? ` — *${entry.username}*` : "";
    const marker = requesterId && String(entry.userId) === requesterId ? ` **${tr("responses.lastfm.leaderboardYou")}**` : "";
    const count = Utils.formatNumber(entry.scrobbleCount);
    return `${head}**${rank}.** ${who}${lfName} — **${count}** ${tr("responses.lastfm.leaderboardScrobbles")}${marker}`;
  });

  const desc = (lines.join("\n") + (opts.extraLine ? `\n\n${opts.extraLine}` : "")).slice(0, 4096);
  const title = lb.scope === "server"
    ? tr("responses.lastfm.leaderboardTitleServer")
    : tr("responses.lastfm.leaderboardTitleGlobal");

  return new EmbedBuilder()
    .setColor(getGlobalColor())
    .setTitle(title)
    .setDescription(desc)
    .setFooter({ text: tr("responses.lastfm.leaderboardFooterSync", { prefix }) });
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
export async function runListeningActions(msg, data, lastfm, prefix, userId, targetUserId, action) {
  /* Translator bound to this message: every embed builder below renders in
     the guild's locale instead of hardcoded English. */
  const tr = (key, repl = {}) => this.t(msg, key, repl);

  switch (action) {
    case "loved": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      let tracks;
      try {
        tracks = await lastfm.getLovedTracks(userId, 15);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!tracks.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.noLoved", { username: user.username }))]
        });
      }

      return msg.reply({ embeds: [buildTrackList(user.username, tr("responses.lastfm.lovedTitle", { username: user.username }), tracks, tr, false, prefix)] });
    }

    case "top": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      const period = extractPeriod(data, msg);

      let tracks;
      try {
        tracks = await lastfm.getTopTracks(userId, period, 15);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!tracks.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.noTop", { username: user.username }))]
        });
      }

      const periodLabel = period !== "overall" ? ` (${period})` : "";
      return msg.reply({ embeds: [buildTrackList(user.username, tr("responses.lastfm.topTitle", { username: user.username }) + periodLabel, tracks, tr, true, prefix)] });
    }

    case "leaderboard":
    case "lb": {
      let lb;
      try {
        lb = await lastfm.getLeaderboard(0, 10);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!lb.entries.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(
            this.t(msg, "responses.lastfm.leaderboardEmpty", { prefix })
          )]
        });
      }

      let myRank = null;
      try { myRank = await lastfm.getUserRank?.(userId) ?? null; } catch (_) { myRank = null; }
      const rankLine = () => (myRank && !lb.entries.some(e => String(e.userId) === String(userId))
        ? tr("responses.lastfm.leaderboardYourRank", { rank: myRank.rank, count: Utils.formatNumber(myRank.scrobbleCount) })
        : null);

      if (lb.totalPages <= 1) {
        const embed = buildLeaderboardEmbed(lb, 0, prefix, tr, { requesterId: userId, extraLine: rankLine() });
        return msg.reply({ embeds: [embed] });
      }

      let currentPage = 0;

      const buildPage = (pageIdx, expired = false) => {
        const footerText = expired
          ? tr("responses.lastfm.leaderboardControlsExpired")
          : tr("responses.lastfm.leaderboardPageFooter", { current: pageIdx + 1, total: lb.totalPages });
        const embed = buildLeaderboardEmbed(lb, pageIdx, prefix, tr, { requesterId: userId, extraLine: rankLine() });
        embed.setFooter({ text: footerText });
        return { embeds: [embed] };
      };

      const replyMsg = await msg.reply(buildPage(0));
      if (!replyMsg?.message) return;

      const navEmojis = ["◀️", "▶️", "❌"];
      for (const emoji of navEmojis) {
        await replyMsg.message.react(emoji).catch(() => {});
      }

      const clearReactions = async () => {
        try {
          await replyMsg.message.removeAllReactions();
        } catch {
          for (const emoji of navEmojis) {
            try { await replyMsg.message.removeReaction(emoji); } catch(e) { logger.warn("[LastFm] Error:", e?.message); }
          }
        }
      };

      let emojiTimeout;
      const resetTimer = () => {
        clearTimeout(emojiTimeout);
        emojiTimeout = setTimeout(async () => {
          unobserve?.();
          await clearReactions();
          await replyMsg.edit(buildPage(currentPage, true)).catch(() => {});
        }, EMOJI_REMOVE_TIMEOUT);
      };

      const unobserve = replyMsg.onReaction(navEmojis, async (e) => {
        if (e.emoji_id === "❌") {
          clearTimeout(emojiTimeout);
          unobserve?.();
          await replyMsg.message.delete().catch(() => {});
          return;
        }

        resetTimer();

        if (e.emoji_id === "◀️") {
          currentPage = currentPage > 0 ? currentPage - 1 : lb.totalPages - 1;
        } else if (e.emoji_id === "▶️") {
          currentPage = currentPage < lb.totalPages - 1 ? currentPage + 1 : 0;
        }

        try {
          lb = await lastfm.getLeaderboard(currentPage, 10);
        } catch(e) { logger.warn("[LastFm] Error:", e?.message); }

        await replyMsg.edit(buildPage(currentPage)).catch(() => {});
      });

      resetTimer();
      break;
    }

    case "recent": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      let tracks;
      try {
        tracks = await lastfm.getRecentTracks(userId, 15);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!tracks.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.noRecent", { username: user.username }))]
        });
      }

      return msg.reply({ embeds: [buildTrackList(user.username, tr("responses.lastfm.recentTitle", { username: user.username }), tracks, tr, false, prefix)] });
    }

    case "artists": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      const period = extractPeriod(data, msg);

      let artists;
      try {
        artists = await lastfm.getTopArtists(userId, period, 15);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!artists.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.noArtists", { username: user.username }))]
        });
      }

      const periodLabel = period !== "overall" ? ` (${period})` : "";
      const lines = artists.map((a, i) => {
        const num = String(i + 1).padStart(2, " ");
        let name = a.name;
        if (name.length > 40) name = name.slice(0, 37) + "...";
        const link = a.url ? `[${name}](${a.url})` : name;
        return `\`${num}.\` ${link} — **${a.playcount}** ${tr("responses.lastfm.plays")}`;
      });

      const desc = lines.join("\n").slice(0, 4096);

      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(getGlobalColor())
          .setTitle(tr("responses.lastfm.artistsTitle", { username: user.username }) + periodLabel)
          .setDescription(desc)
          .setFooter({ text: tr("responses.lastfm.artistsFooter", { prefix }) })]
      });
    }

    case "love": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      const pLove = await this.getPlayer(msg, false, false, false);
      if (!pLove) return;
      const track = pLove.queue?.getCurrent();
      if (!track) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.nothingPlayingLove"))]
        });
      }

      const artist = track.lastfm?.artist ?? track.requestedArtist ?? track.artist ?? track.artists?.[0]?.name ?? track.author?.name ?? "Unknown";
      const name = track.lastfm?.name ?? track.requestedTitle ?? track.title ?? track.name ?? "Unknown";

      try {
        await lastfm.loveTrack(userId, artist, name);
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.lovedTrack", { name, artist }))]
        });
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.loveFailed", { error: err.message }))]
        });
      }
    }

    case "unlove": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      const pUnlove = await this.getPlayer(msg, false, false, false);
      if (!pUnlove) return;
      const track = pUnlove.queue?.getCurrent();
      if (!track) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.nothingPlayingUnlove"))]
        });
      }

      const artist = track.lastfm?.artist ?? track.requestedArtist ?? track.artist ?? track.artists?.[0]?.name ?? track.author?.name ?? "Unknown";
      const name = track.lastfm?.name ?? track.requestedTitle ?? track.title ?? track.name ?? "Unknown";

      try {
        await lastfm.unloveTrack(userId, artist, name);
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.unlovedTrack", { name, artist }))]
        });
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.unloveFailed", { error: err.message }))]
        });
      }
    }

  }
}
