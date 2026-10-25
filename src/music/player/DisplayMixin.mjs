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
    if (vid.isLive || vid.type === "livestream") {
      const link = vid.url || "";
      return code
          ? `${vid.title} (LIVE) - ${link}`
          : `🔴 [${vid.title}](${link}) — **LIVE**`;
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
    if (!current) return { msg: "There's nothing playing at the moment.", embed: null };

    const loopqueue = this.queue.loop     ? "🔄" : "⏹️";
    const songloop  = this.queue.songLoop ? "🔂" : "⏹️";
    const vol       = `${Math.round((this.preferredVolume || 1) * 100)}%`;
    const autoplay  = this._autoplay ? "🔁" : "⏹️";

    const vcLine = this._channelId ? `🔊 <#${this._channelId}>\n` : "";

    let sourceName = this._t("responses.play.sourceMusic");
    let sourceIcon = "🎵";
    const sourceColor = 0xe9196c;

    if (current.type === "radio") {
      sourceName = this._t("responses.play.sourceRadio");
      sourceIcon = "📻";
    } else if (current.spotifyUrl || current.type === "spotify") {
      sourceName = this._t("responses.play.sourceSpotify");
      sourceIcon = "🟢";
    } else if (current.type === "soundcloud" || current.url?.includes("soundcloud.com")) {
      sourceName = this._t("responses.play.sourceSoundcloud");
      sourceIcon = "🟠";
    } else if (current.type === "youtube" || current.url?.includes("youtube.com") || current.url?.includes("youtu.be")) {
      sourceName = this._t("responses.play.sourceYoutube");
      sourceIcon = "▶️";
    }

    const trackUrl = current.spotifyUrl || current.url || null;
    const rawAuthor = current.artist || (typeof current.author === "object" ? current.author?.name : current.author);
    const artistName = rawAuthor || this._t("responses.play.unknownAuthor");
    const loopState = this.queue.songLoop
      ? `🔂 ${this._t("responses.play.loopSongLabel")}`
      : this.queue.loop
        ? `🔄 ${this._t("responses.play.loopQueueLabel")}`
        : this._t("responses.play.loopOffLabel");
    const nextTrack = this.queue.data?.[0]?.title
      ? Utils.truncate(this.queue.data[0].title, 35)
      : this._t("responses.play.endOfQueue");
    const queueCount = this.queue.size();
    const queueRemaining = this.getQueueRemainingTime();

    let textMsg = "";
    let radioLiveTitle = null;

    if (current.type === "radio") {
      try {
        const data = await meta(current.url);
        radioLiveTitle = data?.title || null;
        textMsg = `${vcLine}📻 **[${current.title}](${current.author?.url || current.url})**\n${current.description || ""}\n\n🎵 Now playing: ${radioLiveTitle || "Unknown"}\n\n🔉 ${vol} │ ${loopqueue} Queue │ ${songloop} Song │ ${autoplay} Autoplay`;
      } catch (e) {
        logger.warn("[Player] Error:", e?.message);
        textMsg = `${vcLine}📻 **[${current.title}](${current.author?.url || current.url})**\n\n🔉 ${vol} │ ${loopqueue} Queue │ ${songloop} Song │ ${autoplay} Autoplay`;
      }
    } else if (current.type === "external" || current.type === "stream") {
      const totalMs = this._getTrackDurationMs(current);
      const progressLine = totalMs > 0 ? `\n${this._createProgressBar(20)}` : "";
      textMsg = `${vcLine}🎵 **[${current.title}](${current.url})** by ${artistName}${progressLine}\n\n🔉 ${vol} │ ${loopqueue} Queue │ ${songloop} Song │ ${autoplay} Autoplay`;
    } else {
      const progressBar = this._createProgressBar(20);
      let trackOptLine = "";
      if (this._activeTrackOpt) {
        const optStart = Utils.prettifyMS(this._activeTrackOpt.startMs);
        const optEnd = this._activeTrackOpt.endMs > 0 ? Utils.prettifyMS(this._activeTrackOpt.endMs) : "end";
        trackOptLine = `\n✂️ Custom: ${optStart} → ${optEnd}`;
      }
      textMsg = `${vcLine}🎵 **[${current.title}](${trackUrl || current.url})**\n${progressBar}${trackOptLine}\n\n🔉 ${vol} │ ${loopqueue} Queue │ ${songloop} Song │ ${autoplay} Autoplay`;
    }

    const embed = new EmbedBuilder()
      .setColor(sourceColor)
      .setAuthor({
        name: `${sourceIcon} ${this._t("responses.play.autoNowPlaying")} • ${sourceName}`,
        url: trackUrl || undefined,
      })
      .setTitle(Utils.truncate(current.title || this._t("responses.play.unknownTrack"), 250))
      .setURL(trackUrl || undefined);

    if (current.thumbnail) {
      embed.setThumbnail(current.thumbnail);
    }

    if (current.type === "radio") {
      let desc = current.description ? `${current.description}\n\n` : "";
      desc += `🎵 **${this._t("responses.play.liveBroadcast")}:** ${radioLiveTitle || this._t("responses.play.sourceRadio")}`;
      embed.setDescription(desc);
      embed.addFields(
        { name: `📻 ${this._t("responses.play.station")}`, value: Utils.truncate(current.title || this._t("responses.play.sourceRadio"), 40), inline: true },
        { name: `🎧 ${this._t("responses.play.channel")}`, value: this._channelId ? `<#${this._channelId}>` : this._t("responses.play.none"), inline: true },
        { name: `🔊 ${this._t("responses.play.volume")}`, value: vol, inline: true }
      );
    } else {
      let desc = `${this._createProgressBar(20)}`;
      if (this._activeTrackOpt) {
        const optStart = Utils.prettifyMS(this._activeTrackOpt.startMs);
        const optEnd = this._activeTrackOpt.endMs > 0 ? Utils.prettifyMS(this._activeTrackOpt.endMs) : "end";
        desc += `\n✂️ ${this._t("responses.play.customCut")}: \`${optStart} → ${optEnd}\``;
      }
      embed.setDescription(desc);
      embed.addFields(
        { name: `👤 ${this._t("responses.play.artist")}`, value: Utils.truncate(artistName, 40), inline: true },
        { name: `🎧 ${this._t("responses.play.channel")}`, value: this._channelId ? `<#${this._channelId}>` : this._t("responses.play.none"), inline: true },
        { name: `⚙️ ${this._t("responses.play.modeVol")}`, value: `${loopState} • ${vol}`, inline: true }
      );
    }

    const pluralStr = queueCount === 1 ? this._t("responses.play.trackSingle") : this._t("responses.play.trackPlural");
    const footerText = queueCount > 0
      ? this._t("responses.play.nowPlayingFooter", { count: queueCount, plural: pluralStr, remaining: queueRemaining, next: nextTrack })
      : this._t("responses.play.nowPlayingFooterEmpty", { autoplay: this._autoplay ? this._t("responses.play.on") : this._t("responses.play.off") });

    embed.setFooter({ text: footerText });
    if (typeof embed.setTimestamp === "function") embed.setTimestamp();

    return {
      msg: textMsg,
      image: current.thumbnail,
      embed
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
   * Build a rich localized Added-to-Queue embed.
   * @this {import('./Player.mjs').Player}
   * @param {object} video - The queued track object.
   * @param {boolean} [top=false] - Whether added to the top of queue.
   * @param {string} [requester=null] - User ID who queued the track.
   * @returns {EmbedBuilder}
   */
  buildAddedToQueueEmbed(video, top = false, requester = null) {
    const rawAuthor = video.artist || (typeof video.author === "object" ? video.author?.name : video.author);
    const author = rawAuthor || this._t("responses.play.unknownAuthor");
    const trackUrl = video.spotifyUrl || video.url || null;
    const durationStr = this.getDuration(video.duration);

    const queueCount = this.queue.size();
    let position = top ? 1 : queueCount;
    if (position <= 0) position = 1;

    let waitMs = 0;
    const current = this.queue.getCurrent();
    if (current?.duration && this.startedPlaying) {
      const curTotal = this._getTrackDurationMs(current);
      let elapsed = Date.now() - this.startedPlaying;
      if (this._paused && this._pausedAt) {
        elapsed = this._pausedAt - this.startedPlaying;
      }
      waitMs += Math.max(0, curTotal - elapsed);
    }
    const upToIndex = top ? 0 : Math.max(0, this.queue.data.length - 1);
    for (let i = 0; i < upToIndex; i++) {
      waitMs += this._getTrackDurationMs(this.queue.data[i]);
    }

    const waitStr = waitMs < 60_000
      ? this._t("responses.play.estimatedWaitLessMinute")
      : this._t("responses.play.estimatedWaitMinutes", { minutes: Math.max(1, Math.round(waitMs / 60_000)) });

    const posStr = position === 1
      ? this._t("responses.play.positionNext")
      : this._t("responses.play.positionValue", { position });

    const embed = new EmbedBuilder()
      .setColor(0xe9196c)
      .setAuthor({
        name: `➕ ${this._t("responses.play.addedToQueue")}`,
        url: trackUrl || undefined
      })
      .setTitle(Utils.truncate(video.title || this._t("responses.play.unknownTrack"), 250))
      .setURL(trackUrl || undefined);

    if (video.thumbnail) {
      embed.setThumbnail(video.thumbnail);
    }

    embed.setDescription(`${this._t("responses.play.byAuthor", { author })}`);

    embed.addFields(
      { name: this._t("responses.play.position"), value: posStr, inline: true },
      { name: this._t("responses.play.duration"), value: durationStr, inline: true },
      { name: this._t("responses.play.estimatedWait"), value: waitStr, inline: true }
    );

    const userReq = requester || video.requester || null;
    const reqText = userReq ? `${this._t("responses.play.requestedBy", { user: `<@${userReq}>` })} • ` : "";
    const pluralStr = queueCount === 1 ? this._t("responses.play.trackSingle") : this._t("responses.play.trackPlural");
    embed.setFooter({
      text: `${reqText}${this._t("responses.play.queueCount", { count: queueCount, plural: pluralStr })}`
    });

    if (typeof embed.setTimestamp === "function") embed.setTimestamp();
    return embed;
  },

  /**
   * Emit a now-playing announcement for the given track.
   * @this {import('./Player.mjs').Player}
   * @param {object} s
   */
  announceSong(s) {
    if (!s) return;
    if (this._destroyed || this.leaving || (!this._voiceConn && !this.connection)) return;

    const prefix = this._getPrefix?.(this._guildId) ?? "%";

    if (s.type === "radio") {
      const embed = new EmbedBuilder()
        .setColor(0xe9196c)
        .setAuthor({ name: `📻 ${this._t("responses.play.autoNowPlaying")}` })
        .setTitle(Utils.truncate(s.title || this._t("responses.play.sourceRadio"), 250))
        .setURL(s.author?.url || s.url || undefined)
        .setDescription(`🎵 **${s.description || this._t("responses.play.liveBroadcast")}**\n\n🔊 <#${this._channelId}>`)
        .setFooter({ text: this._t("responses.play.controlsHint", { prefix }) });
      if (s.thumbnail) embed.setThumbnail(s.thumbnail);
      this.emit("message", { embeds: [embed] });
      return;
    }

    const rawAuthor = s.artist || (typeof s.author === "object" ? s.author?.name : s.author);
    const author = rawAuthor || this._t("responses.play.unknownAuthor");
    const trackUrl = s.spotifyUrl || s.url || null;
    const durationStr = this.getDuration(s.duration);
    const nextTrack = this.queue.data?.[0]?.title ? Utils.truncate(this.queue.data[0].title, 35) : null;

    let sourceIcon = "🎵";
    if (s.spotifyUrl || s.type === "spotify") {
      sourceIcon = "🟢";
    } else if (s.type === "soundcloud" || s.url?.includes("soundcloud.com")) {
      sourceIcon = "🟠";
    } else if (s.type === "youtube" || s.url?.includes("youtube.com") || s.url?.includes("youtu.be")) {
      sourceIcon = "▶️";
    }

    const embed = new EmbedBuilder()
      .setColor(0xe9196c)
      .setAuthor({
        name: `${sourceIcon} ${this._t("responses.play.autoNowPlaying")}`,
        url: trackUrl || undefined
      })
      .setTitle(Utils.truncate(s.title || this._t("responses.play.unknownTrack"), 250))
      .setURL(trackUrl || undefined);

    if (s.thumbnail) {
      embed.setThumbnail(s.thumbnail);
    }

    let desc = `${this._t("responses.play.byAuthor", { author })} • \`${durationStr}\``;
    if (this._channelId) {
      desc += `\n🔊 <#${this._channelId}>`;
    }
    embed.setDescription(desc);

    const footerParts = [];
    if (nextTrack) {
      footerParts.push(`${this._t("responses.play.upNext")}: ${nextTrack}`);
    }
    footerParts.push(this._t("responses.play.controlsHint", { prefix }));
    embed.setFooter({ text: footerParts.join(" • ") });

    this.emit("message", { embeds: [embed] });
  },
};

export default DisplayMixin;
export { DisplayMixin };
