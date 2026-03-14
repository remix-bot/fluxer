import { joinVoiceChannel, VoiceConnection } from "@fluxerjs/voice";
import { Utils } from "./Utils.mjs";
import { EventEmitter } from "node:events";
import meta from "./probe.mjs";
import { Client } from "@fluxerjs/core";
import { Worker } from "node:worker_threads";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import https from "node:https";
import ffmpegStatic from "ffmpeg-static";

export class Queue extends EventEmitter {
  /** @type {Video[]} */
  data = [];
  /** @type {Video|null} */
  current = null;
  loop = false;
  songLoop = false;

  /**
   * @typedef {Object} Video
   * @property {("radio"|"video"|"external"|"soundcloud")} type
   * @property {string} title
   * @property {string} description
   * @property {string} videoId
   * @property {string} url
   * @property {string} [spotifyUrl]
   * @property {string} [artist]
   * @property {Object[]} [artists]
   * @property {Object} author
   * @property {string} author.name
   * @property {string} author.url
   * @property {string} [thumbnail]
   * @property {number} [duration]
   */

  constructor() { super(); }

  isEmpty() { return this.data.length === 0; }
  size() { return this.data.length; }

  next() {
    const previous = this.current;
    if (this.songLoop && this.current) return this.current;
    if (this.loop && this.current) this.data.push(this.current);
    if (this.isEmpty()) return null;
    this.current = this.data.shift();
    this.emit("queue", { type: "update", data: { current: this.current, old: previous, loop: this.loop } });
    return this.current;
  }

  remove(idx) {
    if (!this.data[idx]) return "Index out of bounds";
    const title = this.data[idx].title;
    this.emit("queue", { type: "remove", data: { index: idx, old: this.data.slice(), removed: this.data.splice(idx, 1), new: this.data } });
    return "Successfully removed **" + title + "** from the queue.";
  }

  addFirst(data) { return this.add(data, true); }

  add(data, top = false) {
    this.emit("queue", { type: "add", data: { append: !top, data } });
    if (!top) return this.data.push(data);
    return this.data.unshift(data);
  }

  clear() { this.data.length = 0; }

  reset() {
    this.clear();
    this.current = null;
    this.songLoop = false;
    this.loop = false;
  }

  setSongLoop(bool) { this.songLoop = bool; }
  setLoop(bool) { this.loop = bool; }

  toggleLoop(loop) {
    switch (loop) {
      case "song": this.setSongLoop(!this.songLoop); return this.songLoop;
      case "queue": this.setLoop(!this.loop); return this.loop;
    }
  }

  shuffle() {
    Utils.shuffleArr(this.data);
    this.emit("queue", { type: "shuffle", data: this.data });
  }

  getCurrent() { return this.current; }
  getQueue() { return this.data; }
}

export default class Player extends EventEmitter {
  queue;
  /** @type {import("@fluxerjs/voice").VoiceConnection|null} */
  connection = null;
  /** @type {import("@fluxerjs/core").Client} */
  client;
  // In @fluxerjs/voice, VoiceConnection IS the player — no separate AudioPlayer
  player = null;

  /** @type {number} */
  startedPlaying;
  LEAVE_TIMEOUT = 45;
  leaving = false;
  searches = new Map();
  resultLimit = 5;
  preferredVolume = 1;
  _paused = false;

  /**
   * @param {string} token
   * @param {Object} opts
   * @param {Client} opts.client
   * @param {Object} opts.config
   */
  constructor(token, opts) {
    super();
    this.queue = new Queue();
    this.client = opts.client;
    this.innertube = opts.innertube;
    this.ytdlp = opts.ytdlp;
    this.spotifyConfig = opts.spotify;
  }

  workerJob(jobId, data, onMessage = null, msg = null) {
    return new Promise((res, rej) => {
      const worker = new Worker('./worker.mjs', { workerData: { jobId, data } });
      worker.on("message", (data) => {
        data = JSON.parse(data);
        if (data.event === "error") {
          rej(data.data);
        } else if (data.event === "message" && (msg || onMessage)) {
          if (msg) this.updateHandler(data.data, msg);
          if (onMessage) onMessage(data.data);
        } else if (data.event === "finished") {
          res(data.data);
        }
      });
      worker.on("exit", (code) => { if (code !== 0) rej(code); });
    });
  }

  isEmpty() { return this.queue.isEmpty(); }

  shuffle() {
    if (this.isEmpty()) return "There is nothing to shuffle in the queue.";
    this.queue.shuffle();
  }

  addToQueue(data, top = false) { this.queue.add(data, top); }

  get paused() { return this._paused || false; }

  pause() {
    if (!this.connection || !this.queue.getCurrent()) return ":negative_squared_cross_mark: There's nothing playing at the moment!";
    if (this.paused) return ":negative_squared_cross_mark: Already paused. Use the `resume` command to continue playing!";
    this._paused = true;
    this.connection.stop();
    this.emit("playback", false);
  }

  resume() {
    if (!this.connection || !this.queue.getCurrent()) return ":negative_squared_cross_mark: There's nothing playing at the moment!";
    if (!this.paused) return ":negative_squared_cross_mark: Not paused. To pause, use the `pause` command!";
    this._paused = false;
    // Re-stream the current song (fluxerjs/voice has no native pause/resume)
    const current = this.queue.getCurrent();
    this.queue.data.unshift(current);
    this.queue.current = null;
    this.playNext();
    this.emit("playback", true);
  }

  _killCurrentSong() {
    if (this._endCheckInterval) {
      clearInterval(this._endCheckInterval);
      this._endCheckInterval = null;
    }
    if (this._currentFfmpeg) {
      try { this._currentFfmpeg.kill("SIGKILL"); } catch (_) {}
      this._currentFfmpeg = null;
    }
    // NOTE: do NOT kill _prefetchData here — skip() reuses it for instant next song
    if (this.connection) {
      this.connection._playing = false;
      if (this.connection.currentStream) {
        try { this.connection.currentStream.destroy(); } catch (_) {}
        this.connection.currentStream = null;
      }
    }
    this._playingNext = false;
  }

  skip() {
    if (!this.connection || !this.queue.getCurrent()) return ":negative_squared_cross_mark: There's nothing playing at the moment!";
    this._killCurrentSong();
    this.queue.current = null;
    this.emit("update", "queue");
    if (!this.queue.isEmpty() && !this.leaving) this.playNext();
    else this.emit("stopplay");
  }

  async leave() {
    if (!this.connection) return false;
    try {
      this.leaving = true;
      this._killCurrentSong();
      // Kill prefetch on leave (we're done, not just skipping)
      if (this._prefetchData?.promise) {
        this._prefetchData.promise.then(r => { try { r?.ffmpeg?.kill("SIGKILL"); } catch(_){} });
        this._prefetchData = null;
      }
      await new Promise(r => setTimeout(r, 100));
      if (this.connection) {
        try { await this.connection.disconnect?.(); } catch (_) {}
        try { this.connection.destroy?.(); } catch (_) {}
      }
      this.queue.reset();
      this.connection = null;
      this.player = null;
      this._paused = false;
      this._playingNext = false;
    } catch (error) {
      console.error("[Player] leave error:", error.message);
      return false;
    }
    this.emit("leave");
    return true;
  }

  destroy() {
    try {
      this.leaving = true;
      this._killCurrentSong();
      this.connection?.destroy();
      this.connection = null;
    } catch (_) {}
  }

  clear() {
    this.queue.clear();
    this.emit("update", "queue");
  }

  getCurrent() {
    const current = this.queue.getCurrent();
    if (!current) return "There's nothing playing at the moment.";
    return this.getVideoName(current);
  }

  getVideoName(vid, code = false) {
    if (vid.type === "radio") {
      if (code) return "[Radio]: " + vid.title + " - " + vid.author.url + "";
      return "[Radio] [" + vid.title + " by " + vid.author.name + "](" + vid.author.url + ")";
    }
    if (vid.type === "external") {
      if (code) return vid.title + " - " + vid.url;
      return "[" + vid.title + "](" + vid.url + ")";
    }
    if (code) return vid.title + " (" + this.getCurrentElapsedDuration() + "/" + this.getDuration(vid.duration) + ")" + ((vid.spotifyUrl || vid.url) ? " - " + (vid.spotifyUrl || vid.url) : "");
    return "[" + vid.title + " (" + this.getCurrentElapsedDuration() + "/" + this.getDuration(vid.duration) + ")" + "]" + ((vid.spotifyUrl || vid.url) ? "(" + (vid.spotifyUrl || vid.url) + ")" : "");
  }

  list() {
    var text = "";
    const current = this.queue.getCurrent();
    if (current) text += "[x] " + this.getVideoName(current) + "\n";
    this.queue.getQueue().forEach((vid, i) => { text += "[" + i + "] " + this.getVideoName(vid) + "\n"; });
    if (this.queue.isEmpty() && !current) text += "--- Empty ---";
    return text;
  }

  loop(choice) {
    if (!["song", "queue"].includes(choice)) return "'" + choice + "' is not a valid option. Valid are: `song`, `queue`";
    const state = this.queue.toggleLoop(choice);
    const name = choice.charAt(0).toUpperCase() + choice.slice(1);
    return (state) ? name + " loop activated" : name + " loop disabled";
  }

  remove(index) {
    if (!index && index !== 0) throw "Index can't be empty";
    const oldSize = this.queue.size();
    const msg = this.queue.remove(index);
    if (oldSize !== this.queue.size()) this.emit("update", "queue");
    return msg;
  }

  async nowPlaying() {
    const current = this.queue.getCurrent();
    if (!current) return { msg: "There's nothing playing at the moment." };
    let loopqueue = (this.queue.loop) ? "**enabled**" : "**disabled**";
    let songloop = (this.queue.songLoop) ? "**enabled**" : "**disabled**";
    const vol = ((this.preferredVolume || 1) * 100) + "%";
    if (current.type === "radio") {
      const data = await meta(current.url);
      return { msg: "Streaming **[" + current.title + "](" + current.author.url + ")**\n\n" + current.description + " \n\n### Current song: " + data.title + "\n\nVolume: " + vol + "\n\nQueue loop: " + loopqueue + "\nSong loop: " + songloop, image: current.thumbnail };
    }
    if (current.type === "external") {
      return { msg: "Playing **[" + current.title + "](" + current.url + ") by [" + current.artist + "](" + current.author.url + ")** \n\nVolume: " + vol + "\n\nQueue loop: " + loopqueue + "\nSong loop: " + songloop, image: current.thumbnail };
    }
    return { msg: "Playing: **[" + current.title + "](" + (current.spotifyUrl || current.url) + ")** (" + this.getCurrentElapsedDuration() + "/" + this.getCurrentDuration() + ")" + "\n\nVolume: " + vol + "\n\nQueue loop: " + loopqueue + "\nSong loop: " + songloop, image: current.thumbnail };
  }

  getThumbnail() {
    return new Promise(async (res) => {
      const current = this.queue.getCurrent();
      if (!current) return res({ msg: "There's nothing playing at the moment.", image: null });
      if (!current.thumbnail) return res({ msg: "The current media resource doesn't have a thumbnail.", image: null });
      res({ msg: `The thumbnail of the video [${current.title}](${current.url}): `, image: current.thumbnail });
    });
  }

  setVolume(v) {
    if (!this.connection) return "Not connected to a voice channel.";
    this.preferredVolume = v;
    // LiveKitRtcConnection.setVolume() takes 0-200 (100 = normal)
    try { this.connection.setVolume?.(Math.round(v * 100)); } catch (_) {}
    this.emit("volume", v);
    return "Volume changed to `" + (v * 100) + "%`.";
  }

  announceSong(s) {
    if (!s) return;
    if (s.type === "radio") {
      this.emit("message", "Now streaming _" + s.title + "_ by [" + s.author.name + "](" + s.author.url + ")");
      return;
    }
    var author = (!s.artists) ? "[" + s.author.name + "](" + s.author.url + ")" : s.artists.map(a => `[${a.name}](${a.url})`).join(" & ");
    this.emit("message", "Now playing [" + s.title + "](" + (s.spotifyUrl || s.url) + ") by " + author);
  }

  getDuration(duration) {
    if (typeof duration === "object" && duration?.timestamp) return duration.timestamp;
    return Utils.prettifyMS(duration);
  }

  getCurrentElapsedDuration() {
    if (!this.startedPlaying) return "0:00";
    return this.getDuration(Date.now() - this.startedPlaying);
  }

  getCurrentDuration() {
    const current = this.queue.getCurrent();
    if (!current?.duration) return "?:??";
    return this.getDuration(current.duration);
  }

  async streamResource(url) {
    const { default: axios } = await import('axios');
    const response = await axios({ method: 'get', url: url, responseType: 'stream' });
    return response.data;
  }

  async getYoutubeiStream(videoId) {
    try {
      const innertube = this.innertube;
      const clients = ["TV", "ANDROID", "YTMUSIC", "WEB"];
      let webStream = null;
      let lastErr = null;
      for (const client of clients) {
        try {
          webStream = await innertube.download(videoId, { type: "audio", quality: "best", client });
          console.log("[Player] youtubei.js stream acquired via client:", client);
          break;
        } catch (e) {
          console.warn(`[Player] client ${client} failed:`, e.message);
          lastErr = e;
        }
      }
      if (!webStream) throw lastErr;
      const passThrough = new PassThrough();
      const reader = webStream.getReader();
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) { passThrough.end(); break; }
            passThrough.write(value);
          }
        } catch (e) { passThrough.destroy(e); }
      })();
      return passThrough;
    } catch (err) {
      console.error("[Player] youtubei.js fallback failed:", err.message);
      return null;
    }
  }

  /**
   * Builds the yt-dlp + ffmpeg pipeline for a song and returns { buffer, ffmpeg }.
   */
  _buildSongBuffer(songData) {
    return new Promise(async (res) => {
      let rawStream;
      const ytdlpPath = (typeof this.ytdlp === "string") ? this.ytdlp : (this.ytdlp?.binaryPath || "yt-dlp");

      if (songData.type === "soundcloud") {
        const proc = spawn(ytdlpPath, ["-f", "bestaudio/best", "--no-playlist", "-o", "-", "--quiet", songData.url]);
        rawStream = proc.stdout;

      } else if (songData.type === "external" || songData.type === "radio") {
        rawStream = await this.streamResource(songData.url);

      } else {
        const videoId = songData.videoId || (songData.url && (
          (songData.url.match(/[?&]v=([^&]{11})/) || [])[1] ||
          (songData.url.match(/youtu\.be\/([^?]{11})/) || [])[1]
        ));

        if (this.ytdlp) {
          const proc = spawn(ytdlpPath, [
            "-f", "251/250/249/bestaudio",
            "--no-playlist", "-o", "-", "--quiet", "--no-cache-dir", "--force-ipv4",
            "https://www.youtube.com/watch?v=" + videoId
          ]);
          const passThrough = new PassThrough();
          rawStream = passThrough;
          let fallbackTriggered = false;
          proc.stdout.pipe(passThrough);
          proc.stderr.on("data", async (d) => {
            if (fallbackTriggered) return;
            const msg = d.toString();
            const isBlocked = msg.includes("Sign in") || msg.includes("bot") || msg.includes("HTTP Error 403") || msg.includes("HTTP Error 429") || msg.includes("Precondition") || msg.includes("This video is not available") || msg.includes("blocked") || msg.includes("login") || msg.includes("Private video") || msg.includes("Video unavailable");
            if (isBlocked) {
              fallbackTriggered = true;
              proc.stdout.unpipe(passThrough);
              proc.kill();
              const raw = await this.getYoutubeiStream(videoId);
              if (raw) { const fb = spawn(ffmpegStatic, ["-i","pipe:0","-vn","-c:a","libopus","-b:a","128k","-f","webm","pipe:1"],{stdio:["pipe","pipe","pipe"]}); raw.pipe(fb.stdin); fb.stdin.on("error",()=>{}); fb.stderr.on("data",()=>{}); fb.stdout.pipe(passThrough); }
              else passThrough.destroy(new Error("Both yt-dlp and youtubei.js failed"));
            }
          });
          proc.on("close", async (code) => {
            if (fallbackTriggered) return;
            if (code !== 0 && !passThrough.destroyed) {
              fallbackTriggered = true;
              const raw = await this.getYoutubeiStream(videoId);
              if (raw) { const fb = spawn(ffmpegStatic, ["-i","pipe:0","-vn","-c:a","libopus","-b:a","128k","-f","webm","pipe:1"],{stdio:["pipe","pipe","pipe"]}); raw.pipe(fb.stdin); fb.stdin.on("error",()=>{}); fb.stderr.on("data",()=>{}); fb.stdout.pipe(passThrough); }
              else passThrough.destroy(new Error("Both yt-dlp and youtubei.js failed"));
            }
          });
        } else {
          const raw = await this.getYoutubeiStream(videoId);
          if (raw) rawStream = raw;
        }
      }

      if (!rawStream) return res(null);

      const buffer = new PassThrough({ highWaterMark: 64 * 1024 * 1024 });
      const ffmpeg = spawn(ffmpegStatic, [
        "-i", "pipe:0", "-vn", "-c:a", "libopus", "-b:a", "128k", "-f", "webm", "pipe:1"
      ], { stdio: ["pipe", "pipe", "pipe"] });
      rawStream.pipe(ffmpeg.stdin);
      ffmpeg.stdin.on("error", () => {});
      ffmpeg.stderr.on("data", () => {});
      ffmpeg.stdout.pipe(buffer);
      res({ buffer, ffmpeg });
    });
  }

  /** Start fetching the next queued song in the background so skip is instant. */
  _prefetchNext() {
    const next = this.queue.getQueue()[0];
    if (!next) return;
    if (this._prefetchData?.songData === next) return;
    if (this._prefetchData?.promise) {
      this._prefetchData.promise.then(r => { try { r?.ffmpeg?.kill("SIGKILL"); } catch(_){} });
    }
    console.log("[Player] Prefetching:", next.title);
    this._prefetchData = { songData: next, promise: this._buildSongBuffer(next) };
  }

  async playNext() {
    if (this._playingNext) return;
    this._playingNext = true;
    try {
      await this._doPlayNext();
    } finally {
      this._playingNext = false;
    }
  }

  async _doPlayNext() {
    const songData = this.queue.next();
    if (!songData) {
      this._prefetchData = null;
      this.emit("stopplay");
      return false;
    }

    let buffer, ffmpeg;

    // Use prefetched buffer if available for this song
    if (this._prefetchData?.songData === songData) {
      console.log("[Player] Using prefetched buffer for:", songData.title);
      const result = await this._prefetchData.promise;
      this._prefetchData = null;
      if (result && !this.leaving && this.connection) {
        buffer = result.buffer;
        ffmpeg = result.ffmpeg;
      } else if (result) {
        // Prefetch done but we got killed — discard
        try { result.ffmpeg?.kill("SIGKILL"); } catch(_) {}
        return false;
      }
    }

    // Build fresh if no prefetch
    if (!buffer) {
      const result = await this._buildSongBuffer(songData);
      if (!result || !this.connection || this.leaving) {
        if (result) try { result.ffmpeg?.kill("SIGKILL"); } catch(_) {}
        return false;
      }
      buffer = result.buffer;
      ffmpeg = result.ffmpeg;
    }

    this._currentFfmpeg = ffmpeg;

    // Detect song end: poll _playing after ffmpeg finishes encoding
    ffmpeg.on("close", () => {
      if (this.leaving || this._paused) return;
      this._endCheckInterval = setInterval(() => {
        if (!this.connection || this.leaving || this._paused) {
          clearInterval(this._endCheckInterval);
          this._endCheckInterval = null;
          return;
        }
        if (!this.connection._playing) {
          clearInterval(this._endCheckInterval);
          this._endCheckInterval = null;
          console.log("[Player] Song finished.");
          this.playNext();
        }
      }, 250);
    });

    try {
      await this.connection.play(buffer);
    } catch (err) {
      if (err?.message?.includes("AudioSource is closed")) return false;
      console.error("[Player] playNext error:", err.message);
      this.emit("stopplay");
      return false;
    }

    this.startedPlaying = Date.now();
    this._paused = false;
    this.announceSong(songData);
    this.emit("startplay", songData);

    // Start prefetching the next song after a short delay
    // so the current play() call completes first without competition
    setTimeout(() => this._prefetchNext(), 2000);
  }

  /**
   * @param {string} channelId
   * @returns {Promise<void>}
   */
  join(channelId) {
    return new Promise(async (res, rej) => {
      try {
        // @fluxerjs/voice API: joinVoiceChannel(client, channel, options)
        // NOT an options object — client and channel are separate positional args
        const channel = this.client?.channels?.cache?.get(channelId);
        if (!channel) throw new Error("Channel not found: " + channelId);

        // joinVoiceChannel(client, channel) — returns a VoiceConnection (EventEmitter)
        const connection = await joinVoiceChannel(this.client, channel);

        this.connection = connection;
        this.connection.channelId = channelId;

        // VoiceConnection IS the player in @fluxerjs/voice — no separate AudioPlayer
        this.player = connection;

        // Note: @fluxerjs/voice play() does NOT emit "finish"/"idle" on the connection.
        // Song-end detection is handled via ffmpeg process "close" in _doPlayNext().
        connection.on("error", (err) => {
          console.error("[Player] Voice connection error:", err?.message ?? err);
        });
        connection.on("disconnected", () => {
          if (!this.leaving) this.emit("autoleave");
          try { connection.destroy(); } catch (_) {}
        });

        // @fluxerjs/voice uses LiveKit RTC — emits "connected" not "ready"
        // Listen for both, plus a short fallback timeout
        let resolved = false;
        const onReady = () => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeout);
          console.log("[Player] Voice connection ready.");
          this.emit("roomfetched");
          res();
          if (!this.queue.isEmpty() && !this.queue.getCurrent()) this.playNext();
        };

        const timeout = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            console.log("[Player] Voice connected (via timeout fallback).");
            this.emit("roomfetched");
            res();
            if (!this.queue.isEmpty() && !this.queue.getCurrent()) this.playNext();
          }
        }, 3000);

        connection.once("ready", onReady);
        connection.once("connected", onReady);

      } catch (e) {
        rej(e);
      }
    });
  }

  fetchResults(query, id, provider = "ytm") {
    const providerNames = { yt: "YouTube", ytm: "YouTube Music", scld: "SoundCloud" };
    return new Promise(res => {
      let list = `Search results using **${providerNames[provider] || "YouTube Music"}**:\n\n`;
      this.workerJob("searchResults", { query, provider, resultCount: this.resultLimit }, () => {}).then((data) => {
        data.data.forEach((v, i) => {
          const url = v.url || v.permalink_url || "";
          const title = v.title || v.name || "Unknown";
          const dur = v.duration ? this.getDuration(v.duration) : "?:??";
          list += `${i + 1}. [${title}](${url}) - ${dur}\n`;
        });
        list += "\nSend the number of the result you'd like to play here in this channel. Example: `2`\nTo cancel this process, just send an 'x'!";
        this.searches.set(id, data.data);
        res({ m: list, count: data.data.length });
      });
    });
  }

  playResult(id, result = 0, next = false) {
    if (!this.searches.has(id)) return null;
    const res = this.searches.get(id)[result];
    this.addToQueue(res, next);
    if (!this.queue.getCurrent()) this.playNext();
    return res;
  }

  playFirst(query, provider) { return this.play(query, true, provider); }

  play(query, top = false, provider) {
    const events = new EventEmitter();
    this.workerJob("generalQuery", { query, spotify: this.spotifyConfig, provider }, (msg) => {
      events.emit("message", msg);
    }).then((data) => {
      if (data.type === "list") {
        data.data.forEach(vid => this.addToQueue(vid, top));
      } else if (data.type === "video") {
        this.addToQueue(data.data, top);
      } else {
        console.log("Unknown case: ", data.type, data);
      }
      if (!this.queue.getCurrent()) this.playNext();
    }).catch(reason => {
      reason = reason || "An error occurred. Please contact support if this happens repeatedly.";
      events.emit("message", reason);
    });
    return events;
  }

  playRadio(radio, top = false) {
    this.addToQueue({
      type: "radio",
      title: radio.detailedName,
      description: radio.description,
      url: radio.url,
      author: { name: radio.author.name, url: radio.author.url },
      thumbnail: radio.thumbnail,
    }, top);
    if (!this.queue.getCurrent()) this.playNext();
  }

  lyrics() {
    return new Promise(async res => {
      const current = this.queue.getCurrent();
      if (!current) return res([]);
      try {
        const { Genius } = await import("genius-lyrics");
        const genius = new Genius.Client(this.geniusToken);
        const searches = await genius.songs.search(current.title);
        if (!searches.length) return res(null);
        const lyrics = await searches[0].lyrics();
        res(lyrics);
      } catch (e) {
        console.error("[Player] Lyrics fetch error:", e.message);
        res(null);
      }
    });
  }
}
