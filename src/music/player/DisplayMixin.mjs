/**
 * @module src/music/player/DisplayMixin
 * @description User-facing rendering concern for {@link Player}: progress
 * bars, now-playing announcements, queue listing, thumbnails and duration
 * formatting.
 *
 * These methods are applied onto the Player class prototype via
 * {@link applyMixins} — `this` is a Player instance.
 */

import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../../ui/index.mjs";
import { Utils } from "../../utils/Utils.mjs";
import { logger } from "../../core/Logger.mjs";
import meta from "../probe.mjs";

/**
 * @type {object}
 * @description Display mixin — applied to Player.
 */
const DisplayMixin = {
  /**
   * @private Build a progress bar line for the current track.
   * @this {import('./Player.mjs').Player}
   * @param {number} [length=15]
   * @returns {string}
   */
  _createProgressBar(length = 15) {
    const current = this.queue.getCurrent();
    if (!current?.duration || !this.startedPlaying) {
      const total = this._getTrackDurationMs(current);
      if (total > 0) {
        return `${Utils.progressBar(0, total, length)} \`0:00 / ${Utils.prettifyMS(total)}\``;
      }
      return Utils.progressBar(0, 1, length);
    }

    const totalMs = this._getTrackDurationMs(current);
    let elapsed = Date.now() - this.startedPlaying;
    if (this._paused && this._pausedAt) {
      elapsed = this._pausedAt - this.startedPlaying;
    }

    if (totalMs > 0 && elapsed > totalMs) elapsed = totalMs;
    elapsed = Math.max(0, elapsed);

    const bar     = Utils.progressBar(elapsed, totalMs, length);
    const timeNow = Utils.prettifyMS(elapsed);
    const total   = Utils.prettifyMS(totalMs);
    return `${bar} \`${timeNow} / ${total}\``;
  },

  /**
   * @returns {string} Formatted name of the currently playing track.
   * @this {import('./Player.mjs').Player}
   */
  getCurrent() {
    const c = this.queue.getCurrent();
    if (!c) return "There's nothing playing at the moment.";
    return this.getVideoName(c);
  },

  /**
   * Format a track object into a display name.
   * @this {import('./Player.mjs').Player}
   * @param {object} vid
   * @param {boolean} [code=false]
   * @returns {string}
   */
  getVideoName(vid, code = false) {
    if (!vid) return "Unknown";
    if (vid.type === "radio") {
      return code
          ? `[Radio]: ${vid.title} - ${vid.author?.url || ""}`
          : `[Radio] [${vid.title} by ${vid.author?.name || "Unknown"}](${vid.author?.url || ""})`;
    }
    if (vid.type === "external" || vid.type === "stream") {
      return code
          ? `${vid.title} - ${vid.url}`
          : `[${vid.title}](${vid.url})`;
    }
    const elapsed = this.getCurrentElapsedDuration();
    const total   = this.getDuration(vid.duration);
    const link    = vid.spotifyUrl || vid.url || "";
    return code
        ? `${vid.title} (${elapsed}/${total})${link ? " - " + link : ""}`
        : `[${vid.title} (${elapsed}/${total})]${link ? "(" + link + ")" : ""}`;
  },

  /**
   * @returns {string} Human-readable total remaining time for all queued tracks.
   * @this {import('./Player.mjs').Player}
   */
  getQueueRemainingTime() {
    let totalMs  = 0;
    const current = this.queue.getCurrent();
    if (current?.duration && this.startedPlaying) {
      const totalMsCurrent = this._getTrackDurationMs(current);
      let elapsed = Date.now() - this.startedPlaying;
      if (this._paused && this._pausedAt) {
        elapsed = this._pausedAt - this.startedPlaying;
      }
      totalMs += Math.max(0, totalMsCurrent - elapsed);
    }
    for (const track of this.queue.data) {
      totalMs += this._getTrackDurationMs(track);
    }
    return Utils.prettifyMS(totalMs);
  },

  /**
   * @returns {string} Elapsed time of the current track.
   * @this {import('./Player.mjs').Player}
   */
  getCurrentElapsedDuration() {
    if (!this.startedPlaying) return "0:00";
    const current = this.queue.getCurrent();
    const totalMs = this._getTrackDurationMs(current);

    let elapsed = Date.now() - this.startedPlaying;
    if (this._paused && this._pausedAt) {
      elapsed = this._pausedAt - this.startedPlaying;
    }

    if (totalMs > 0 && elapsed > totalMs) elapsed = totalMs;
    return Utils.prettifyMS(Math.max(0, elapsed));
  },

  /**
   * Generate a text-based queue listing.
   * @this {import('./Player.mjs').Player}
   * @param {number} [page=1]
   * @param {number} [pageSize=10]
   * @returns {string}
   */
  list(page = 1, pageSize = 10) {
    const current = this.queue.getCurrent();
    const total   = this.queue.size();
    let text = "";
    if (current) {
      const remaining = this.getQueueRemainingTime();
      text += `🎧 **Queue**\n`;
      text += `**${total} tracks** • ⏱️ ${remaining}\n`;
      text += `${this._createProgressBar()}\n\n`;
      text += `🎵 **Now Playing**\n`;
      text += `${this.getVideoName(current)}\n\n`;
    }
    if (total === 0) { if (!current) text += "--- Empty ---"; return text; }
    const { items, page: pg, totalPages, start } = this.queue.getPage(page, pageSize);
    items.forEach((vid, i) => {
      const index = String(start + i + 1).padStart(2, " ");
      const name  = this.getVideoName({ ...vid, title: Utils.truncate(vid.title, 60) });
      text += `\`${index}.\` ${name}\n`;
    });
    text += `\nPage ${pg}/${totalPages} • Loop: ${this.queue.loop ? "🟢" : "🔴"}`;
    return text;
  },

  /**
   * @async Build a now-playing info object for the current track, including
   * progress bar, volume, and loop states.
   * @this {import('./Player.mjs').Player}
   * @returns {Promise<{msg: string, image?: string}>}
   */
  async nowPlaying() {
    const current = this.queue.getCurrent();
    if (!current) return { msg: "There's nothing playing at the moment." };

    const loopqueue = this.queue.loop     ? "🔄" : "⏹️";
    const songloop  = this.queue.songLoop ? "🔂" : "⏹️";
    const vol       = `${Math.round((this.preferredVolume || 1) * 100)}%`;
    const autoplay  = this._autoplay ? "🔁" : "⏹️";

    const vcLine = this._channelId ? `🔊 <#${this._channelId}>\n` : "";

    if (current.type === "radio") {
      try {
        const data = await meta(current.url);
        return {
          msg: `${vcLine}📻 **[${current.title}](${current.author?.url || current.url})**\n${current.description || ""}\n\n🎵 Now playing: ${data?.title || "Unknown"}\n\n🔉 ${vol} │ ${loopqueue} Queue │ ${songloop} Song │ ${autoplay} Autoplay`,
          image: current.thumbnail
        };
      } catch (e) {
          logger.warn("[Player] Error:", e?.message);
          return {
          msg: `${vcLine}📻 **[${current.title}](${current.author?.url || current.url})**\n\n🔉 ${vol} │ ${loopqueue} Queue │ ${songloop} Song │ ${autoplay} Autoplay`,
          image: current.thumbnail
        };
      }
    }

    if (current.type === "external" || current.type === "stream") {
      const totalMs = this._getTrackDurationMs(current);
      let progressLine = "";

      if (totalMs > 0) {
        progressLine = `\n${this._createProgressBar(20)}`;
      }
      return {
        msg: `${vcLine}🎵 **[${current.title}](${current.url})** by ${current.artist || "Unknown"}${progressLine}\n\n🔉 ${vol} │ ${loopqueue} Queue │ ${songloop} Song │ ${autoplay} Autoplay`,
        image: current.thumbnail
      };
    }

    const progressBar = this._createProgressBar(20);
    let trackOptLine = "";
    if (this._activeTrackOpt) {
      const optStart = Utils.prettifyMS(this._activeTrackOpt.startMs);
      const optEnd = this._activeTrackOpt.endMs > 0 ? Utils.prettifyMS(this._activeTrackOpt.endMs) : "end";
      trackOptLine = `\n✂️ Custom: ${optStart} → ${optEnd}`;
    }
    return {
      msg: `${vcLine}🎵 **[${current.title}](${current.spotifyUrl || current.url})**\n${progressBar}${trackOptLine}\n\n🔉 ${vol} │ ${loopqueue} Queue │ ${songloop} Song │ ${autoplay} Autoplay`,
      image: current.thumbnail
    };
  },

  /**
   * @async Get the thumbnail of the currently playing track.
   * @this {import('./Player.mjs').Player}
   * @returns {Promise<{msg: string, image: string|null}>}
   */
  async getThumbnail() {
    const current = this.queue.getCurrent();
    if (!current) return { msg: "There's nothing playing at the moment.", image: null };
    if (!current.thumbnail) return { msg: "No thumbnail available.", image: null };
    return { msg: `Thumbnail of [${current.title}](${current.url}):`, image: current.thumbnail };
  },

  /**
   * Format a track duration from various shapes.
   * @this {import('./Player.mjs').Player}
   * @param {*} duration
   * @returns {string}
   */
  getDuration(duration) {
    if (typeof duration === "object" && duration?.timestamp) return duration.timestamp;
    if (typeof duration === "object" && duration?.seconds  != null) return Utils.formatSeconds(duration.seconds);
    if (typeof duration === "string" && duration.startsWith("PT")) return Utils.prettifyMS(Utils.parseISODuration(duration));
    return Utils.prettifyMS(duration);
  },

  /**
   * @returns {string} Formatted duration of the currently playing track.
   * @this {import('./Player.mjs').Player}
   */
  getCurrentDuration() {
    const current = this.queue.getCurrent();
    if (!current?.duration) return "?:??";
    return this.getDuration(current.duration);
  },

  /**
   * Emit a now-playing announcement for the given track.
   * @this {import('./Player.mjs').Player}
   * @param {object} s
   */
  announceSong(s) {
    if (!s) return;

    if (s.type === "radio") {
      this.emit("message", { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this._t("responses.radio.nowPlaying", {
        title:  Utils.escapeMarkdown(s.title),
        author: s.author?.name || "Unknown",
        url:    s.author?.url || "",
        channel: this._channelId || "",
      }))] });
      return;
    }
    const author = s.artists
        ? s.artists.map(a => a.url ? `[${a.name}](${a.url})` : a.name).join(" & ")
        : s.author?.url
            ? `[${s.author.name}](${s.author.url})`
            : s.author?.name || null;

    if (!author && (s.type === "external" || s.type === "stream")) {
      const desc = "🎵 Now playing [" + Utils.escapeMarkdown(s.title) + "](" + (s.url || "") + ") in <#" + (this._channelId || "") + ">";
      this.emit("message", { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(desc)] });
      return;
    }

    this.emit("message", { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this._t("responses.play.nowPlaying", {
      title:   Utils.escapeMarkdown(s.title),
      url:     s.spotifyUrl || s.url,
      author:  author || "Unknown",
      channel: this._channelId || "",
    }))] });
  },
};

export default DisplayMixin;
export { DisplayMixin };
