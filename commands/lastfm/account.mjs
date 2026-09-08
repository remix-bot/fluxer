/**
 * @module commands/lastfm/account
 * @description Account linking, profile and playlist actions for the lastfm command (link, confirm, unlink, scrobble, np, profile, playlists). Extracted verbatim from the original single-file command; dispatched by commands/lastfm.mjs.
 */


import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../../src/ui/index.mjs";
import { Utils } from "../../src/utils/Utils.mjs";
import { logger } from "../../src/core/Logger.mjs";
import { ERROR_COLOR } from "../../src/utils/UI.mjs";
import { notLinked } from "./shared.mjs";

/**
 * Action names dispatched to this module.
 * @type {Set<string>}
 */
export const ACCOUNT_ACTIONS = new Set([
  "link",,
  "confirm",,
  "unlink",,
  "scrobble",,
  "np",,
  "profile",,
  "playlists"
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
export async function runAccountActions(msg, data, lastfm, prefix, userId, targetUserId, action) {
  switch (action) {
    case "link": {
      const existing = await lastfm.getUser(userId);
      if (existing) {
        return msg.reply({
          embeds: [new EmbedBuilder()
            .setColor(getGlobalColor())
            .setDescription(this.t(msg, "responses.lastfm.alreadyLinked", { username: existing.username, prefix }))]
        });
      }

      let token;
      try {
        token = await lastfm.getAuthToken();
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.tokenFailed", { error: err.message }))]
        });
      }

      const authUrl = lastfm.getAuthUrl(token);

      let sent = false;
      try {
        const dm = await msg.author.createDM();
        await dm.send({
          embeds: [new EmbedBuilder()
            .setColor(getGlobalColor())
            .setTitle(this.t(msg, "responses.lastfm.authLinkTitle"))
            .setDescription(this.t(msg, "responses.lastfm.authLinkBody", { url: authUrl, prefix, token }))
          ]
        });
        sent = true;
      } catch(e) { logger.warn("[LastFm] Error:", e?.message); }

      const replyEmbed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setDescription(
          sent
            ? this.t(msg, "responses.lastfm.authDM", { prefix })
            : this.t(msg, "responses.lastfm.authDMFailed", { url: authUrl, prefix })
        );

      return msg.reply({ embeds: [replyEmbed] });
    }

    case "confirm": {
      let tokenValue = data.get("token")?.value;
      if (!tokenValue) {
        const rawContent = msg.message?.content ?? "";
        const args = rawContent.split(/\s+/);
        const confirmIdx = args.indexOf("confirm");
        tokenValue = confirmIdx >= 0 ? args[confirmIdx + 1] : null;
      }

      if (!tokenValue) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.confirmUsage", { prefix }))]
        });
      }

      let session;
      try {
        session = await lastfm.getSession(tokenValue);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.confirmFailed", { error: err.message }))]
        });
      }

      await lastfm.saveUser(userId, session.key, session.name);

      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(getGlobalColor())
          .setDescription(this.t(msg, "responses.lastfm.linked", { username: session.name }))]
      });
    }

    case "unlink": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      await lastfm.removeUser(userId);
      return msg.reply({
        embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.unlinked", { username: user.username }))]
      });
    }

    case "scrobble": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      const newState = !user.scrobbleEnabled;
      await lastfm.setScrobble(userId, newState);

      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(getGlobalColor())
          .setDescription(newState
            ? this.t(msg, "responses.lastfm.scrobbleEnabled", { username: user.username })
            : this.t(msg, "responses.lastfm.scrobbleDisabled")
          )]
      });
    }

    case "np": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      let recentData;
      try {
        recentData = await lastfm.getRecentTracks(userId, 1);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!recentData.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.noRecent", { username: user.username }))]
        });
      }

      const track = recentData[0];
      const statusEmoji = track.now ? this.t(msg, "responses.lastfm.nowPlaying") : this.t(msg, "responses.lastfm.lastPlayed");
      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setAuthor({ name: statusEmoji, iconURL: track.image || undefined })
        .setDescription(this.t(msg, "responses.lastfm.npTrackInfo", { name: track.name, artist: track.artist, url: track.url }))
        .setFooter({ text: this.t(msg, "responses.lastfm.npFooter", { username: user.username }) });

      return msg.reply({ embeds: [embed] });
    }

    case "profile": {
      const profileUserId = targetUserId || userId;
      const user = await lastfm.getUser(profileUserId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      let info;
      try {
        info = await lastfm.getUserInfo(profileUserId);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      lastfm.syncUserScrobbleCount(profileUserId).catch(() => {});

      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setAuthor({ name: this.t(msg, "responses.lastfm.profileTitle", { username: info.name }), iconURL: info.image?.[2]?.["#text"] || undefined, url: info.url })
        .setDescription([
          this.t(msg, "responses.lastfm.profileScrobbles", { playcount: Utils.formatNumber(info.playcount ?? 0) }),
          this.t(msg, "responses.lastfm.profileRegistered", { date: info.registered?.unixtime ? new Date(+info.registered.unixtime * 1000).toLocaleDateString() : "unknown" }),
          this.t(msg, "responses.lastfm.profileScrobbleStatus", { status: user.scrobbleEnabled ? this.t(msg, "responses.lastfm.profileScrobbleEnabled") : this.t(msg, "responses.lastfm.profileScrobbleDisabled") }),
          ``,
          this.t(msg, "responses.lastfm.profileLink", { url: info.url }),
        ].join("\n"))
        .setFooter({ text: this.t(msg, "responses.lastfm.profileScrobbleFooter", { prefix }) });

      return msg.reply({ embeds: [embed] });
    }

    case "playlists": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      let playlists;
      try {
        playlists = await lastfm.getPlaylists(userId);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!playlists.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.noPlaylists", { username: user.username }))]
        });
      }

      const lines = playlists.map((pl, i) => {
        const num = String(i + 1).padStart(2, " ");
        const link = pl.url ? `[${pl.title}](${pl.url})` : pl.title;
        return `\`${num}.\` ${link} — **${pl.trackCount}** tracks`;
      });

      const desc = lines.join("\n").slice(0, 4096);

      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(getGlobalColor())
          .setTitle(this.t(msg, "responses.lastfm.playlistsTitle", { username: user.username }))
          .setDescription(desc)
          .setFooter({ text: this.t(msg, "responses.lastfm.playlistsFooter", { prefix }) })]
      });
    }

  }
}
