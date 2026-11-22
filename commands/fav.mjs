/**
 * @module commands/fav
 * @description Bookmark personal favorite tracks and queue them across any server.
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { Utils, cleanId } from "../src/utils/Utils.mjs";
import { getGlobalColor, getMessageGuildId } from "../src/ui/index.mjs";

const PAGE_SIZE = 10;
const COLOR_PRIMARY = 0xe9196c;
const COLOR_SUCCESS = 0x2ecc71;
const COLOR_ERROR = 0xe74c3c;

/** @type {CommandBuilder} */
export const command = new CommandBuilder()
  .setName("fav")
  .setDescription("Bookmark your favorite tracks and load them into voice channels.", "commands.fav")
  .addAliases("favorite", "favorites", "bookmark", "bookmarks")
  .setCategory("music")
  .addSubcommand((s) =>
    s
      .setName("toggle")
      .setId("fav_toggle")
      .setDescription("Save or remove the currently playing song from your favorites.")
  )
  .addSubcommand((s) =>
    s
      .setName("list")
      .setId("fav_list")
      .setDescription("View your list of saved favorite tracks.")
      .addNumberOption((o) =>
        o.setName("page").setDescription("Page number to view.").setRequired(false)
      )
  )
  .addSubcommand((s) =>
    s
      .setName("play")
      .setId("fav_play")
      .setDescription("Play all your favorites or a specific track number.")
      .addNumberOption((o) =>
        o.setName("track").setDescription("Track number to play.").setRequired(false)
      )
  )
  .addSubcommand((s) =>
    s
      .setName("remove")
      .setId("fav_remove")
      .setDescription("Remove a track from your favorites by number or title.")
      .addTextOption((o) =>
        o.setName("target").setDescription("Track number or title to remove.").setRequired(true)
      )
  )
  .addSubcommand((s) =>
    s
      .setName("clear")
      .setId("fav_clear")
      .setDescription("Clear all tracks from your personal favorites.")
  );

/**
 * Run handler for the fav command.
 * @param {object} msg
 * @param {object} [data]
 * @returns {Promise<void>}
 */
export async function run(msg, data) {
  const pm = this.playlists;
  if (!pm) {
    const embed = new EmbedBuilder()
      .setColor(COLOR_ERROR)
      .setDescription(this.t(msg, "responses.fav.notAvailable"));
    return msg.reply({ embeds: [embed] });
  }

  const userId = cleanId(msg.author?.id ?? msg.message?.author?.id ?? msg.member?.user?.id ?? msg.user?.id);
  const authorName = msg.author?.username ?? msg.message?.author?.username ?? "User";
  const guildId = cleanId(getMessageGuildId(msg));
  const prefix = this.handler.getPrefix(guildId) || "%";
  const embedColor = getGlobalColor() || COLOR_PRIMARY;

  /* Parse raw arguments for text-command dispatch */
  const rawContent = (msg.message?.content || msg.content || "").trim();
  const rawParts = rawContent.split(/\s+/).slice(1);
  const firstToken = (rawParts[0] || "").toLowerCase();

  let sub = data?.command?.name || data?.commandId || "";
  if (!sub || sub === "fav") {
    if (["list", "view", "all"].includes(firstToken)) sub = "list";
    else if (["play", "p", "queue"].includes(firstToken)) sub = "play";
    else if (["remove", "delete", "rm", "del"].includes(firstToken)) sub = "remove";
    else if (["clear", "reset"].includes(firstToken)) sub = "clear";
    else if (["add", "save"].includes(firstToken)) sub = "add";
    else sub = "toggle";
  }

  /* -------------------------------------------------------------------------
     SUBCOMMAND: PLAY
     ------------------------------------------------------------------------- */
  if (sub === "play") {
    const p = await this.getPlayer(msg);
    if (!p) return;

    const favs = await pm.getFavorites(userId, 250, 0);
    if (favs.length === 0) {
      const embed = new EmbedBuilder()
        .setColor(COLOR_ERROR)
        .setDescription(this.t(msg, "responses.fav.empty", { prefix }));
      return msg.reply({ embeds: [embed] });
    }

    /* Check if a specific track number was requested */
    let trackNum = data?.get?.("track")?.value;
    if (!trackNum && rawParts.length > 1) {
      const parsedNum = parseInt(rawParts[1], 10);
      if (!isNaN(parsedNum)) trackNum = parsedNum;
    }

    if (trackNum != null) {
      const idx = parseInt(trackNum, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= favs.length) {
        const embed = new EmbedBuilder()
          .setColor(COLOR_ERROR)
          .setDescription(this.t(msg, "responses.fav.invalidIndex", { max: favs.length }));
        return msg.reply({ embeds: [embed] });
      }

      const target = favs[idx];
      const video = {
        videoId: "",
        encoded: "",
        sourceName: target.source_name || "unknown",
        isLive: false,
        isStream: false,
        title: target.title,
        url: target.uri,
        thumbnail: target.thumbnail || null,
        spotifyUrl: null,
        _durationMs: Number(target.duration_ms) || 0,
        duration: {
          timestamp: Utils.prettifyMS(Number(target.duration_ms) || 0),
          seconds: Math.floor((Number(target.duration_ms) || 0) / 1000),
        },
        author: {
          name: target.author || "Unknown",
          url: target.uri || null,
        },
        artists: null,
        requester: userId,
        requesterName: authorName,
      };

      p.addToQueue(video, false);
      if (!p.queue.getCurrent()) {
        p.playNext().catch((e) => logger.error("[fav] playNext error:", e?.message));
      }

      const embed = new EmbedBuilder()
        .setColor(COLOR_SUCCESS)
        .setDescription(this.t(msg, "responses.fav.queuedOne", {
          title: target.title,
          url: target.uri,
        }));
      return msg.reply({ embeds: [embed] });
    }

    /* Queue all favorite tracks */
    const videos = favs.map((f) => ({
      videoId: "",
      encoded: "",
      sourceName: f.source_name || "unknown",
      isLive: false,
      isStream: false,
      title: f.title,
      url: f.uri,
      thumbnail: f.thumbnail || null,
      spotifyUrl: null,
      _durationMs: Number(f.duration_ms) || 0,
      duration: {
        timestamp: Utils.prettifyMS(Number(f.duration_ms) || 0),
        seconds: Math.floor((Number(f.duration_ms) || 0) / 1000),
      },
      author: {
        name: f.author || "Unknown",
        url: f.uri || null,
      },
      artists: null,
      requester: userId,
      requesterName: authorName,
    }));

    p.addManyToQueue(videos, false);
    if (!p.queue.getCurrent()) {
      p.playNext().catch((e) => logger.error("[fav] playNext error:", e?.message));
    }

    const embed = new EmbedBuilder()
      .setColor(COLOR_SUCCESS)
      .setDescription(this.t(msg, "responses.fav.queuedAll", { count: videos.length }));
    return msg.reply({ embeds: [embed] });
  }

  /* -------------------------------------------------------------------------
     SUBCOMMAND: REMOVE
     ------------------------------------------------------------------------- */
  if (sub === "remove") {
    let target = data?.get?.("target")?.value;
    if (!target && rawParts.length > 1) {
      target = rawParts.slice(1).join(" ");
    }

    if (!target) {
      const embed = new EmbedBuilder()
        .setColor(COLOR_ERROR)
        .setDescription(this.t(msg, "responses.fav.removeUsage", { prefix }));
      return msg.reply({ embeds: [embed] });
    }

    const res = await pm.removeFavorite(userId, target);
    if (!res.removed || !res.track) {
      const embed = new EmbedBuilder()
        .setColor(COLOR_ERROR)
        .setDescription(this.t(msg, "responses.fav.notFound"));
      return msg.reply({ embeds: [embed] });
    }

    const embed = new EmbedBuilder()
      .setColor(COLOR_SUCCESS)
      .setDescription(this.t(msg, "responses.fav.removed", {
        title: res.track.title,
        url: res.track.uri,
      }));
    return msg.reply({ embeds: [embed] });
  }

  /* -------------------------------------------------------------------------
     SUBCOMMAND: CLEAR
     ------------------------------------------------------------------------- */
  if (sub === "clear") {
    const count = await pm.clearFavorites(userId);
    const embed = new EmbedBuilder()
      .setColor(COLOR_SUCCESS)
      .setDescription(this.t(msg, "responses.fav.cleared", { count }));
    return msg.reply({ embeds: [embed] });
  }

  /* -------------------------------------------------------------------------
     SUBCOMMAND: LIST
     ------------------------------------------------------------------------- */
  if (sub === "list") {
    const totalCount = await pm.getFavoriteCount(userId);
    if (totalCount === 0) {
      const embed = new EmbedBuilder()
        .setColor(embedColor)
        .setAuthor({ name: this.t(msg, "responses.fav.listTitle", { user: authorName }) })
        .setDescription(this.t(msg, "responses.fav.empty", { prefix }));
      return msg.reply({ embeds: [embed] });
    }

    const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
    let page = data?.get?.("page")?.value;
    if (!page && rawParts.length > 1) {
      const parsed = parseInt(rawParts[1], 10);
      if (!isNaN(parsed)) page = parsed;
    }
    const safePage = Math.max(1, Math.min(parseInt(page, 10) || 1, totalPages));
    const offset = (safePage - 1) * PAGE_SIZE;

    const favs = await pm.getFavorites(userId, PAGE_SIZE, offset);

    let desc = "";
    favs.forEach((f, i) => {
      const num = offset + i + 1;
      const dur = Utils.prettifyMS(Number(f.duration_ms) || 0);
      const authorText = f.author ? ` • ${f.author}` : "";
      desc += `\`${num}.\` **[${f.title}](${f.uri})**${authorText} \`[${dur}]\`\n`;
    });

    const embed = new EmbedBuilder()
      .setColor(embedColor)
      .setAuthor({ name: this.t(msg, "responses.fav.listTitle", { user: authorName }) })
      .setDescription(desc || this.t(msg, "responses.fav.empty", { prefix }))
      .setFooter({
        text: this.t(msg, "responses.fav.listFooter", {
          page: safePage,
          totalPages,
          total: totalCount,
          prefix,
        }),
      });

    return msg.reply({ embeds: [embed] });
  }

  /* -------------------------------------------------------------------------
     SUBCOMMAND: TOGGLE / DEFAULT
     ------------------------------------------------------------------------- */
  const p = await this.getPlayer(msg, false);
  const current = p?.queue?.getCurrent();

  /* If no track is currently playing and user typed plain %fav, show the list */
  if (!current) {
    const totalCount = await pm.getFavoriteCount(userId);
    if (totalCount === 0) {
      const embed = new EmbedBuilder()
        .setColor(embedColor)
        .setDescription(this.t(msg, "responses.fav.empty", { prefix }));
      return msg.reply({ embeds: [embed] });
    }
    return run.call(this, msg, { command: { name: "list" } });
  }

  /* Toggle the currently playing track in favorites */
  const toggleRes = await pm.toggleFavorite(userId, current);

  if (toggleRes.action === "limit") {
    const embed = new EmbedBuilder()
      .setColor(COLOR_ERROR)
      .setDescription(this.t(msg, "responses.fav.limitReached", { max: 250 }));
    return msg.reply({ embeds: [embed] });
  }

  if (toggleRes.action === "added") {
    const embed = new EmbedBuilder()
      .setColor(COLOR_SUCCESS)
      .setDescription(this.t(msg, "responses.fav.added", {
        title: current.title,
        url: current.url || current.uri,
        count: toggleRes.count,
      }));
    return msg.reply({ embeds: [embed] });
  }

  const embed = new EmbedBuilder()
    .setColor(COLOR_PRIMARY)
    .setDescription(this.t(msg, "responses.fav.removed", {
      title: current.title,
      url: current.url || current.uri,
    }));
  return msg.reply({ embeds: [embed] });
}
