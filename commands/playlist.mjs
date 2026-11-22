/**
 * @module commands/playlist
 * @description Save the active queue or manage personal custom playlists across servers.
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { Utils, cleanId } from "../src/utils/Utils.mjs";
import { getGlobalColor, getMessageGuildId } from "../src/ui/index.mjs";
import { MAX_PLAYLISTS_PER_USER, MAX_TRACKS_PER_PLAYLIST } from "../src/services/PlaylistManager.mjs";
import { logger } from "../src/core/Logger.mjs";

const PAGE_SIZE = 10;
const COLOR_PRIMARY = 0xe9196c;
const COLOR_SUCCESS = 0x2ecc71;
const COLOR_ERROR = 0xe74c3c;

/** @type {CommandBuilder} */
export const command = new CommandBuilder()
  .setName("playlist")
  .setDescription("Save the current queue or manage your personal custom playlists.", "commands.playlist")
  .addAliases("pl", "playlists")
  .setCategory("music")
  .addTextOption((o) =>
    o
      .setName("action")
      .setDescription("Action to perform: save, play, list, show, add, remove, delete.")
      .setRequired(false)
  )
  .addTextOption((o) =>
    o
      .setName("name")
      .setDescription("Playlist name or target.")
      .setRequired(false)
  )
  .addTextOption((o) =>
    o
      .setName("extra")
      .setDescription("Track index or page number.")
      .setRequired(false)
  );

/**
 * Run handler for the playlist command.
 * @param {object} msg
 * @param {object} [data]
 * @returns {Promise<void>}
 */
export async function run(msg, data) {
  const pm = this.playlists;
  if (!pm) {
    const embed = new EmbedBuilder()
      .setColor(COLOR_ERROR)
      .setDescription(this.t(msg, "responses.playlist.notAvailable"));
    return msg.reply({ embeds: [embed] });
  }

  const userId = cleanId(msg.author?.id ?? msg.message?.author?.id ?? msg.member?.user?.id ?? msg.user?.id);
  const authorName = msg.author?.username ?? msg.message?.author?.username ?? "User";
  const guildId = cleanId(getMessageGuildId(msg));
  const prefix = this.handler.getPrefix(guildId) || "%";
  const embedColor = getGlobalColor() || COLOR_PRIMARY;

  /* Parse raw text tokens for fallback CLI syntax */
  const rawContent = (msg.message?.content || msg.content || "").trim();
  const rawParts = rawContent.split(/\s+/).slice(1);
  const firstToken = (rawParts[0] || "").toLowerCase();

  let sub = data?.get?.("action")?.value || "";
  if (sub) sub = sub.toLowerCase();

  if (!sub || sub === "playlist" || sub === "pl" || sub === "playlists") {
    if (["save", "create", "new"].includes(firstToken)) sub = "save";
    else if (["play", "p", "load"].includes(firstToken)) sub = "play";
    else if (["list", "all"].includes(firstToken)) sub = "list";
    else if (["show", "view", "info"].includes(firstToken)) sub = "show";
    else if (["add"].includes(firstToken)) sub = "add";
    else if (["remove", "rm"].includes(firstToken)) sub = "remove";
    else if (["delete", "del", "destroy"].includes(firstToken)) sub = "delete";
    else if (rawParts.length > 0 && !["list", "play"].includes(firstToken)) {
      /* If user typed %playlist <name>, interpret as play */
      sub = "play";
    } else {
      sub = "list";
    }
  }

  /* -------------------------------------------------------------------------
     SUBCOMMAND: SAVE
     ------------------------------------------------------------------------- */
  if (sub === "save" || sub === "create" || sub === "new") {
    let name = data?.get?.("name")?.value;
    if (!name && rawParts.length > 1) {
      name = rawParts[1];
    }

    if (!name) {
      const embed = new EmbedBuilder()
        .setColor(COLOR_ERROR)
        .setDescription(this.t(msg, "responses.playlist.saveUsage", { prefix }));
      return msg.reply({ embeds: [embed] });
    }

    const p = await this.getPlayer(msg, false, false, false);
    const current = p?.queue?.getCurrent();
    const queued = p?.queue?.data || [];

    const allTracks = [];
    if (current) allTracks.push(current);
    if (queued.length > 0) allTracks.push(...queued);

    if (allTracks.length === 0) {
      const embed = new EmbedBuilder()
        .setColor(COLOR_ERROR)
        .setDescription(this.t(msg, "responses.playlist.emptyQueue", { prefix }));
      return msg.reply({ embeds: [embed] });
    }

    const res = await pm.savePlaylist(userId, name, allTracks);
    if (!res.success) {
      if (res.error === "LIMIT_REACHED") {
        const embed = new EmbedBuilder()
          .setColor(COLOR_ERROR)
          .setDescription(this.t(msg, "responses.playlist.limitReached", { max: MAX_PLAYLISTS_PER_USER }));
        return msg.reply({ embeds: [embed] });
      }
      if (res.error === "INVALID_NAME") {
        const embed = new EmbedBuilder()
          .setColor(COLOR_ERROR)
          .setDescription(this.t(msg, "responses.playlist.invalidName"));
        return msg.reply({ embeds: [embed] });
      }
      const embed = new EmbedBuilder()
        .setColor(COLOR_ERROR)
        .setDescription(this.t(msg, "responses.playlist.saveFailed"));
      return msg.reply({ embeds: [embed] });
    }

    const embed = new EmbedBuilder()
      .setColor(COLOR_SUCCESS)
      .setDescription(this.t(msg, "responses.playlist.saved", {
        name: res.name,
        count: res.count,
        prefix,
      }));
    return msg.reply({ embeds: [embed] });
  }

  /* -------------------------------------------------------------------------
     SUBCOMMAND: PLAY
     ------------------------------------------------------------------------- */
  if (sub === "play" || sub === "p" || sub === "load") {
    let name = data?.get?.("name")?.value;
    if (!name && rawParts.length > 1) {
      name = rawParts[1];
    } else if (!name && rawParts.length === 1 && !["play", "list", "p", "load"].includes(firstToken)) {
      name = rawParts[0];
    }

    if (!name) {
      const embed = new EmbedBuilder()
        .setColor(COLOR_ERROR)
        .setDescription(this.t(msg, "responses.playlist.playUsage", { prefix }));
      return msg.reply({ embeds: [embed] });
    }

    const playlist = await pm.getPlaylist(userId, name);
    if (!playlist) {
      const embed = new EmbedBuilder()
        .setColor(COLOR_ERROR)
        .setDescription(this.t(msg, "responses.playlist.notFound", { name, prefix }));
      return msg.reply({ embeds: [embed] });
    }

    if (!playlist.tracks || playlist.tracks.length === 0) {
      const embed = new EmbedBuilder()
        .setColor(COLOR_ERROR)
        .setDescription(this.t(msg, "responses.playlist.playlistEmpty", { name }));
      return msg.reply({ embeds: [embed] });
    }

    const p = await this.getPlayer(msg, true, true, true);
    if (!p) return;

    const videos = playlist.tracks.map((t) => ({
      videoId: "",
      encoded: "",
      sourceName: t.sourceName || "unknown",
      isLive: false,
      isStream: false,
      title: t.title,
      url: t.uri,
      thumbnail: t.thumbnail || null,
      spotifyUrl: null,
      _durationMs: Number(t.durationMs) || 0,
      duration: {
        timestamp: Utils.prettifyMS(Number(t.durationMs) || 0),
        seconds: Math.floor((Number(t.durationMs) || 0) / 1000),
      },
      author: {
        name: t.author || "Unknown",
        url: t.uri || null,
      },
      artists: null,
      requester: userId,
      requesterName: authorName,
    }));

    p.addManyToQueue(videos, false);
    if (!p.queue.getCurrent()) {
      p.playNext().catch((e) => logger.error("[playlist] playNext error:", e?.message));
    }

    const embed = new EmbedBuilder()
      .setColor(COLOR_SUCCESS)
      .setDescription(this.t(msg, "responses.playlist.queued", {
        name: playlist.name,
        count: videos.length,
      }));
    return msg.reply({ embeds: [embed] });
  }

  /* -------------------------------------------------------------------------
     SUBCOMMAND: LIST
     ------------------------------------------------------------------------- */
  if (sub === "list" || sub === "all") {
    const playlists = await pm.listPlaylists(userId);
    if (playlists.length === 0) {
      const embed = new EmbedBuilder()
        .setColor(embedColor)
        .setAuthor({ name: this.t(msg, "responses.playlist.listTitle", { user: authorName }) })
        .setDescription(this.t(msg, "responses.playlist.noPlaylists", { prefix }));
      return msg.reply({ embeds: [embed] });
    }

    const totalPages = Math.max(1, Math.ceil(playlists.length / PAGE_SIZE));
    let page = data?.get?.("name")?.value;
    if (!page && rawParts.length > 1) {
      const parsed = parseInt(rawParts[1], 10);
      if (!isNaN(parsed)) page = parsed;
    }
    const safePage = Math.max(1, Math.min(parseInt(page, 10) || 1, totalPages));
    const offset = (safePage - 1) * PAGE_SIZE;

    const slice = playlists.slice(offset, offset + PAGE_SIZE);

    let desc = "";
    slice.forEach((pl, i) => {
      const num = offset + i + 1;
      desc += `\`${num}.\` **${pl.name}** — \`${pl.trackCount} tracks\`\n`;
    });

    const embed = new EmbedBuilder()
      .setColor(embedColor)
      .setAuthor({ name: this.t(msg, "responses.playlist.listTitle", { user: authorName }) })
      .setDescription(desc)
      .setFooter({
        text: this.t(msg, "responses.playlist.listFooter", {
          page: safePage,
          totalPages,
          total: playlists.length,
          max: MAX_PLAYLISTS_PER_USER,
          prefix,
        }),
      });

    return msg.reply({ embeds: [embed] });
  }

  /* -------------------------------------------------------------------------
     SUBCOMMAND: SHOW / VIEW
     ------------------------------------------------------------------------- */
  if (sub === "show" || sub === "view" || sub === "info") {
    let name = data?.get?.("name")?.value;
    if (!name && rawParts.length > 1) {
      name = rawParts[1];
    }

    if (!name) {
      const embed = new EmbedBuilder()
        .setColor(COLOR_ERROR)
        .setDescription(this.t(msg, "responses.playlist.showUsage", { prefix }));
      return msg.reply({ embeds: [embed] });
    }

    const playlist = await pm.getPlaylist(userId, name);
    if (!playlist) {
      const embed = new EmbedBuilder()
        .setColor(COLOR_ERROR)
        .setDescription(this.t(msg, "responses.playlist.notFound", { name, prefix }));
      return msg.reply({ embeds: [embed] });
    }

    const tracks = playlist.tracks || [];
    if (tracks.length === 0) {
      const embed = new EmbedBuilder()
        .setColor(embedColor)
        .setDescription(this.t(msg, "responses.playlist.playlistEmpty", { name: playlist.name }));
      return msg.reply({ embeds: [embed] });
    }

    const totalPages = Math.max(1, Math.ceil(tracks.length / PAGE_SIZE));
    let page = data?.get?.("extra")?.value;
    if (!page && rawParts.length > 2) {
      const parsed = parseInt(rawParts[2], 10);
      if (!isNaN(parsed)) page = parsed;
    }
    const safePage = Math.max(1, Math.min(parseInt(page, 10) || 1, totalPages));
    const offset = (safePage - 1) * PAGE_SIZE;

    const slice = tracks.slice(offset, offset + PAGE_SIZE);

    let desc = "";
    slice.forEach((t, i) => {
      const num = offset + i + 1;
      const dur = Utils.prettifyMS(Number(t.durationMs) || 0);
      const authorText = t.author ? ` • ${t.author}` : "";
      desc += `\`${num}.\` **[${t.title}](${t.uri})**${authorText} \`[${dur}]\`\n`;
    });

    const embed = new EmbedBuilder()
      .setColor(embedColor)
      .setAuthor({ name: this.t(msg, "responses.playlist.showTitle", { name: playlist.name }) })
      .setDescription(desc)
      .setFooter({
        text: this.t(msg, "responses.playlist.showFooter", {
          page: safePage,
          totalPages,
          total: tracks.length,
          name: playlist.name,
          prefix,
        }),
      });

    return msg.reply({ embeds: [embed] });
  }

  /* -------------------------------------------------------------------------
     SUBCOMMAND: ADD
     ------------------------------------------------------------------------- */
  if (sub === "add") {
    let name = data?.get?.("name")?.value;
    if (!name && rawParts.length > 1) {
      name = rawParts[1];
    }

    if (!name) {
      const embed = new EmbedBuilder()
        .setColor(COLOR_ERROR)
        .setDescription(this.t(msg, "responses.playlist.addUsage", { prefix }));
      return msg.reply({ embeds: [embed] });
    }

    const p = await this.getPlayer(msg, false, false, false);
    const current = p?.queue?.getCurrent();

    if (!current) {
      const embed = new EmbedBuilder()
        .setColor(COLOR_ERROR)
        .setDescription(this.t(msg, "responses.playlist.nothingPlaying"));
      return msg.reply({ embeds: [embed] });
    }

    const res = await pm.addToPlaylist(userId, name, current);
    if (!res.success) {
      if (res.error === "NOT_FOUND") {
        const embed = new EmbedBuilder()
          .setColor(COLOR_ERROR)
          .setDescription(this.t(msg, "responses.playlist.notFound", { name, prefix }));
        return msg.reply({ embeds: [embed] });
      }
      if (res.error === "PLAYLIST_FULL") {
        const embed = new EmbedBuilder()
          .setColor(COLOR_ERROR)
          .setDescription(this.t(msg, "responses.playlist.playlistFull", { max: MAX_TRACKS_PER_PLAYLIST }));
        return msg.reply({ embeds: [embed] });
      }
      const embed = new EmbedBuilder()
        .setColor(COLOR_ERROR)
        .setDescription(this.t(msg, "responses.playlist.addFailed"));
      return msg.reply({ embeds: [embed] });
    }

    const embed = new EmbedBuilder()
      .setColor(COLOR_SUCCESS)
      .setDescription(this.t(msg, "responses.playlist.trackAdded", {
        title: current.title,
        name: res.name,
        count: res.count,
      }));
    return msg.reply({ embeds: [embed] });
  }

  /* -------------------------------------------------------------------------
     SUBCOMMAND: REMOVE
     ------------------------------------------------------------------------- */
  if (sub === "remove" || sub === "rm") {
    let name = data?.get?.("name")?.value;
    let index = data?.get?.("extra")?.value;

    if (!name && rawParts.length > 1) name = rawParts[1];
    if (index == null && rawParts.length > 2) index = parseInt(rawParts[2], 10);

    if (!name || index == null || isNaN(index)) {
      const embed = new EmbedBuilder()
        .setColor(COLOR_ERROR)
        .setDescription(this.t(msg, "responses.playlist.removeUsage", { prefix }));
      return msg.reply({ embeds: [embed] });
    }

    const res = await pm.removeFromPlaylist(userId, name, index);
    if (!res.success) {
      if (res.error === "NOT_FOUND") {
        const embed = new EmbedBuilder()
          .setColor(COLOR_ERROR)
          .setDescription(this.t(msg, "responses.playlist.notFound", { name, prefix }));
        return msg.reply({ embeds: [embed] });
      }
      const embed = new EmbedBuilder()
        .setColor(COLOR_ERROR)
        .setDescription(this.t(msg, "responses.playlist.invalidIndex"));
      return msg.reply({ embeds: [embed] });
    }

    const embed = new EmbedBuilder()
      .setColor(COLOR_SUCCESS)
      .setDescription(this.t(msg, "responses.playlist.trackRemoved", {
        title: res.removedTrack?.title || "Track",
        name: res.name,
        count: res.count,
      }));
    return msg.reply({ embeds: [embed] });
  }

  /* -------------------------------------------------------------------------
     SUBCOMMAND: DELETE
     ------------------------------------------------------------------------- */
  if (sub === "delete" || sub === "del" || sub === "destroy") {
    let name = data?.get?.("name")?.value;
    if (!name && rawParts.length > 1) {
      name = rawParts[1];
    }

    if (!name) {
      const embed = new EmbedBuilder()
        .setColor(COLOR_ERROR)
        .setDescription(this.t(msg, "responses.playlist.deleteUsage", { prefix }));
      return msg.reply({ embeds: [embed] });
    }

    const deleted = await pm.deletePlaylist(userId, name);
    if (!deleted) {
      const embed = new EmbedBuilder()
        .setColor(COLOR_ERROR)
        .setDescription(this.t(msg, "responses.playlist.notFound", { name, prefix }));
      return msg.reply({ embeds: [embed] });
    }

    const embed = new EmbedBuilder()
      .setColor(COLOR_SUCCESS)
      .setDescription(this.t(msg, "responses.playlist.deleted", { name }));
    return msg.reply({ embeds: [embed] });
  }
}
