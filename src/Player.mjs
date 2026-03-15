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

  // Innertube session tracking for auto-refresh
  _innertubeCreatedAt = null;
  _INNERTUBE_TTL_MS = 30 * 60 * 1000; // 30 minutes

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
    this._innertubeCreatedAt = opts.innertube ? Date.now() : null;
    this.ytdlp = opts.ytdlp;
    this.spotifyConfig = opts.spotify;
  }

  workerJob(jobId, data, onMessage = null, msg = null) {
    return new Promise((res, rej) => {
      const worker = new Worker('./src/worker.mjs', { workerData: { jobId, data } });
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
    if (this._currentYtdlpProc) {
      try { this._currentYtdlpProc.kill("SIGKILL"); } catch (_) {}
      this._currentYtdlpProc = null;
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

  /**
   * Reads OAuth credentials from /root/fluxer/.ytcache/yt_auth.json and
   * visitorData from visitor_data.json.
   * Returns { accessToken, refreshToken, visitorData } or null on failure.
   */
  async _readCachedAuth() {
    try {
      const { readFile } = await import("node:fs/promises");
      const CACHE_DIR = "/root/fluxer/.ytcache";

      const [vdRaw, authRaw] = await Promise.all([
        readFile(`${CACHE_DIR}/visitor_data.json`, "utf8"),
        readFile(`${CACHE_DIR}/yt_auth.json`, "utf8"),
      ]);

      const vd = JSON.parse(vdRaw);
      const auth = JSON.parse(authRaw);

      const visitorData = vd.visitorData || vd.visitor_data;
      const accessToken = auth.access_token;
      const refreshToken = auth.refresh_token;
      const expiryDate = auth.expiry_date ? new Date(auth.expiry_date) : null;

      if (!accessToken || !refreshToken) {
        console.warn("[Player] yt_auth.json missing access_token or refresh_token.");
        return null;
      }

      // Warn if token is expired but still try — youtubei.js may auto-refresh
      if (expiryDate && expiryDate < new Date()) {
        console.warn("[Player] OAuth access token appears expired:", expiryDate.toISOString());
      }

      console.log("[Player] Loaded OAuth credentials from .ytcache.");
      return { accessToken, refreshToken, visitorData };
    } catch (e) {
      console.warn("[Player] Could not read .ytcache:", e.message);
      return null;
    }
  }

  /**
   * Refreshes the Innertube instance if the session is stale (older than TTL).
   * Authenticates using OAuth tokens from /root/fluxer/.ytcache/yt_auth.json.
   */
  async _ensureFreshInnertube() {
    const needsRefresh = !this.innertube ||
      !this._innertubeCreatedAt ||
      (Date.now() - this._innertubeCreatedAt > this._INNERTUBE_TTL_MS);

    if (needsRefresh) {
      try {
        const { Innertube, UniversalCache } = await import("youtubei.js");

        const cached = await this._readCachedAuth();

        if (cached) {
          // Build an OAuth-authenticated Innertube session.
          // We confirmed session.oauth has: oauth2_tokens, client_id, etc.
          this.innertube = await Innertube.create({
            generate_session_locally: true,
            device_category: 'MOBILE', // Ensure mobile category
            client_type: 'ANDROID'      // Default to Android
          });

          // Inject tokens using the confirmed oauth2_tokens key from session inspection
          try {
            this.innertube.session.oauth.oauth2_tokens = {
              access_token: cached.accessToken,
              refresh_token: cached.refreshToken,
              token_type: "Bearer",
              expiry_date: cached.expiryDate || new Date(Date.now() + 3600 * 1000).toISOString(),
            };
            // Set logged_in flag so requests include Authorization header
            this.innertube.session.logged_in = true;
            console.log("[Player] Innertube session created with OAuth credentials.");
          } catch (oauthErr) {
            console.warn("[Player] OAuth injection failed:", oauthErr.message, "— continuing without auth.");
          }
        } else {
          this.innertube = await Innertube.create({ generate_session_locally: true });
          console.warn("[Player] Innertube session created WITHOUT auth — some videos may fail.");
        }

        this._innertubeCreatedAt = Date.now();
      } catch (e) {
        console.error("[Player] Failed to refresh Innertube session:", e.message);
      }
    }
  }

  async getYoutubeiStream(videoId) {
    try {
      // Ensure session is fresh/authenticated before attempting download
      await this._ensureFreshInnertube();

      const innertube = this.innertube;
      if (!innertube) throw new Error("Innertube instance unavailable");

      // TV client crashes with nFunction bug — excluded
      // Authenticated sessions work best with WEB_EMBEDDED or YTMUSIC first
      const clients = ["ANDROID", "IOS", "YTMUSIC", "WEB_EMBEDDED", "TV_EMBEDDED"];
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
      // Swallow errors on the passthrough so they don't become uncaught exceptions
      passThrough.on("error", (err) => {
        console.error("[Player] youtubei passThrough error:", err.message);
      });

      const reader = webStream.getReader();
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) { passThrough.end(); break; }
            passThrough.write(value);
          }
        } catch (e) {
          console.error("[Player] youtubei reader error:", e.message);
          passThrough.destroy(e);
        }
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
          // Always pipe yt-dlp through ffmpeg — handles any format (opus, aac, etc.)
          // and produces a clean WebM/Opus stream for connection.play()
          const passThrough = new PassThrough();
          passThrough.on("error", (err) => {
            console.error("[Player] Stream pipeline error:", err.message);
          });

          const proc = spawn(ytdlpPath, [
            "--cookies", "/root/fluxer/cookies.txt",
            "--js-runtimes", "node",
            "--remote-components", "ejs:github",
            // Match Firefox UA — reduces bot detection from datacenter IPs
            "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0",
            "-f", "251/250/249/140/bestaudio[ext=webm]/bestaudio[protocol=m3u8_native]/bestaudio/best",
            "--hls-prefer-native",
            "--no-playlist", "-o", "-", "--force-ipv4",
            "--cache-dir", "/root/fluxer/.ytcache/yt-dlp",
            "https://www.youtube.com/watch?v=" + videoId
          ]);

          this._currentYtdlpProc = proc;

          // Always transcode through ffmpeg so connection.play() always gets clean WebM/Opus
          // regardless of whether yt-dlp picked opus, aac, or anything else
          const ffmpegProc = spawn(ffmpegStatic, [
            "-i", "pipe:0", "-vn", "-c:a", "libopus", "-b:a", "128k",
            "-flush_packets", "1", "-f", "webm", "pipe:1"
          ], { stdio: ["pipe", "pipe", "pipe"] });
          proc.stdout.pipe(ffmpegProc.stdin);
          ffmpegProc.stdin.on("error", () => {});
          ffmpegProc.stderr.on("data", () => {});
          ffmpegProc.stdout.pipe(passThrough, { end: false });
          ffmpegProc.stdout.on("end", () => passThrough.end());
          ffmpegProc.stdout.on("error", (err) => {
            console.error("[Player] ffmpeg stdout error:", err.message);
          });

          res({ buffer: passThrough, ffmpeg: ffmpegProc });

          let fallbackTriggered = false;

          proc.stderr.on("data", async (d) => {
            if (fallbackTriggered) return;
            const msg = d.toString();
            // Only log actual ERRORs — suppress all info/progress/status lines
            if (msg.includes("ERROR:")) {
              console.warn("[yt-dlp]", msg.trim());
            }
            const isBlocked =
              msg.includes("Sign in") ||
              msg.includes("bot") ||
              msg.includes("HTTP Error 400") ||
              msg.includes("HTTP Error 403") ||
              msg.includes("HTTP Error 429") ||
              msg.includes("Precondition") ||
              msg.includes("This video is not available") ||
              msg.includes("blocked") ||
              msg.includes("login") ||
              msg.includes("Private video") ||
              msg.includes("Video unavailable");

            if (isBlocked) {
              fallbackTriggered = true;
              proc.stdout.unpipe(ffmpegProc.stdin);
              try { proc.kill(); } catch(_) {}
              try { ffmpegProc.kill(); } catch(_) {}
              console.warn("[Player] yt-dlp blocked, falling back to youtubei.js for:", videoId);
              const raw = await this.getYoutubeiStream(videoId);
              if (raw) {
                const fb = spawn(ffmpegStatic, ["-i","pipe:0","-vn","-c:a","libopus","-b:a","128k","-flush_packets","1","-f","webm","pipe:1"], { stdio: ["pipe","pipe","pipe"] });
                raw.pipe(fb.stdin);
                fb.stdin.on("error", () => {});
                fb.stderr.on("data", () => {});
                fb.stdout.pipe(passThrough, { end: false });
                fb.stdout.on("end", () => passThrough.end());
              } else {
                passThrough.destroy(new Error("Both yt-dlp and youtubei.js failed"));
              }
            }
          });

          proc.on("close", async (code) => {
            if (fallbackTriggered) return;
            if (code !== 0 && !passThrough.destroyed) {
              fallbackTriggered = true;
              try { ffmpegProc.kill(); } catch(_) {}
              console.warn("[Player] yt-dlp exited with code", code, "— falling back to youtubei.js for:", videoId);
              const raw = await this.getYoutubeiStream(videoId);
              if (raw) {
                const fb = spawn(ffmpegStatic, ["-i","pipe:0","-vn","-c:a","libopus","-b:a","128k","-flush_packets","1","-f","webm","pipe:1"], { stdio: ["pipe","pipe","pipe"] });
                raw.pipe(fb.stdin);
                fb.stdin.on("error", () => {});
                fb.stderr.on("data", () => {});
                fb.stdout.pipe(passThrough, { end: false });
                fb.stdout.on("end", () => passThrough.end());
              } else {
                passThrough.destroy(new Error("Both yt-dlp and youtubei.js failed"));
              }
            }
            // ffmpegProc handles passThrough ending via its own stdout "end" event
          });
        } else {
          const raw = await this.getYoutubeiStream(videoId);
          if (raw) rawStream = raw;
        }
      }

      if (!rawStream) return res(null);

      // For radio/external/soundcloud/youtubei fallback: encode to WebM/Opus via ffmpeg
      const ffmpeg = spawn(ffmpegStatic, [
        "-i", "pipe:0",
        "-vn",
        "-c:a", "libopus",
        "-b:a", "128k",
        "-f", "webm",
        "-flush_packets", "1",
        "pipe:1"
      ], { stdio: ["pipe", "pipe", "pipe"] });
      rawStream.pipe(ffmpeg.stdin);
      ffmpeg.stdin.on("error", () => {});
      ffmpeg.stderr.on("data", () => {});
      ffmpeg.stdout.on("error", (err) => {
        console.error("[Player] ffmpeg stdout error:", err.message);
      });
      res({ buffer: ffmpeg.stdout, ffmpeg });
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
      // FIX 2: Wrap prefetch resolution in try/catch
      let result = null;
      try {
        result = await this._prefetchData.promise;
      } catch (err) {
        console.error("[Player] Prefetch buffer failed:", err.message);
        result = null;
      }
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
      // FIX 2: Wrap _buildSongBuffer in try/catch so stream errors don't crash the process
      let result = null;
      try {
        result = await this._buildSongBuffer(songData);
      } catch (err) {
        console.error("[Player] Buffer build failed for:", songData.title, "—", err.message);
        result = null;
      }
      if (!result || !this.connection || this.leaving) {
        if (result) try { result.ffmpeg?.kill("SIGKILL"); } catch(_) {}
        if (!this.connection || this.leaving) return false;
        // Both extraction methods failed — notify user and skip to next
        console.error("[Player] Failed to stream:", songData.title);
        this.emit("message", `:x: Could not play **${songData.title}** — YouTube is blocking requests. Skipping...`);
        // Try to continue with the next song rather than stopping entirely
        setTimeout(() => this.playNext(), 500);
        return false;
      }
      buffer = result.buffer;
      ffmpeg = result.ffmpeg;
    }

    if (ffmpeg) this._currentFfmpeg = ffmpeg;

    // Detect song end via ffmpeg "close" (radio/external) or buffer "end" (yt-dlp direct)
    const endSource = ffmpeg || buffer;
    endSource.on(ffmpeg ? "close" : "end", () => {
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

    // Delay prefetch slightly to avoid two simultaneous yt-dlp processes hitting YouTube
    setTimeout(() => this._prefetchNext(), 5000);
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
