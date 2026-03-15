import * as fs from "fs";
import path from "path";
import { Client, Events } from "@fluxerjs/core";
import { CommandHandler, CommandLoader, PrefixManager } from "./src/CommandHandler.mjs";
import { Message, MessageHandler, PageBuilder } from "./src/MessageHandler.mjs";
import { MySqlSettingsManager } from "./src/Settings.mjs";
import YTDlpWrapE from "yt-dlp-wrap-extended";
import { PlayerManager } from "./src/PlayerManager.mjs";
import Player from "./src/Player.mjs";
const YTDlpWrap = YTDlpWrapE.default;
import { Innertube, Platform } from "youtubei.js";
import { generate } from "youtube-po-token-generator";
import childProcess from "node:child_process";
import { getVoiceManager } from "@fluxerjs/voice";

class Remix {
  // FIX 1: Removed stray (client, options = {}) parameters from constructor —
  // those shadowed the locally declared `const client` and corrupted this.client.
  constructor() {
    const config = JSON.parse(fs.readFileSync("config.json"));
    this.config = config;

    const client = new Client({
      intents: 0,
      ...config["fluxer.js"],
    });
    this.client = client;

    const messages = new MessageHandler(this.client);
    this.messages = messages;
    const settings = new MySqlSettingsManager(config.mysql, "./storage/defaults.json");
    this.settingsMgr = settings;
    const commands = new CommandHandler(messages);
    this.handler = commands;

    commands.setPrefixManager(new PrefixManager(settings));
    //commands.owners = config.owners ?? [];
    commands.onPing = (msg) => {
      msg.replyEmbed(this.handler.format("My prefix in this server is `$prefix`\n\nRun `$prefix$helpCmd` to get started!", msg.message.guildId), false, {
        icon_url: (msg.channel.channel.guild?.iconURL?.() ?? null),
        title: msg.channel.channel.guild?.name ?? null
      });
    };

    client.on(Events.Ready, () => {
      console.log("Logged in as " + (client.user?.username ?? "bot"));
      // Initialize VoiceManager immediately so it starts tracking VOICE_STATE_UPDATE
      // events from the start. Without this, checkVoiceChannels() returns null until
      // the bot has already joined a channel once.
      try {
        getVoiceManager(client);
        console.log("VoiceManager initialized.");
      } catch (e) {
        console.warn("VoiceManager init failed:", e.message);
      }
    });

    const loader = new CommandLoader(commands, this);
    const __dirname = import.meta.dirname;
    const dir = path.join(__dirname, "commands");
    console.log("Started loading commands.");
    loader.loadFromDir(dir).then(() => {
      console.log("Commands loaded.");
    });

    console.log("Loading Modules.");
    this.loadedModules = new Map();
    this.modules = JSON.parse(fs.readFileSync("./storage/modules.json"));
    Promise.all(this.modules.map(async m => {
      if (!m.enabled) return;
      const mod = { instance: (new ((await import(m.index)).default)(this)), c: (await import(m.index)).default };
      this.loadedModules.set(m.name, mod);
    })).then(() => {
      console.log("Modules loaded.");
    });

    this.observedVoiceUsers = new Map();

    if (!fs.existsSync("./bin")) fs.mkdirSync("./bin");
    const ytdlPath = path.join(__dirname, "./bin/ytdlp.bin");
    if (!fs.existsSync(ytdlPath)) {
      console.log("Downloading yt-dlp binaries.");
      YTDlpWrap.downloadFromGithub(ytdlPath).then(() => {
        console.log("Finished downloading yt-dlp binaries.");
        this.ytdlp = new YTDlpWrap(ytdlPath);
        // FIX 3: Keep playerContext.ytdlp in sync when downloaded async
        if (this.playerContext) this.playerContext.ytdlp = this.ytdlp;
      });
    } else {
      this.ytdlp = new YTDlpWrap(ytdlPath);
    }

    try {
      this.comHash = childProcess
        .execSync('git rev-parse --short HEAD', { cwd: __dirname })
        .toString().trim();
      this.comHashLong = childProcess
        .execSync('git rev-parse HEAD', { cwd: __dirname })
        .toString().trim();
    } catch (e) {
      console.log("Git comhash error");
      this.comHash = "Newest";
      this.comHashLong = null;
    }

    // FIX 2: Define playerContext BEFORE PlayerManager so Player instances
    // receive a valid client. Previously playerContext was defined after
    // new PlayerManager(...), so every Player was constructed with client: undefined,
    // causing VoiceManager to throw "this.client.on is not a function".
    this.playerContext = {
      client: this.client,
      config,
      ytdlp: this.ytdlp,       // may be undefined if still downloading — that's ok, updated above
      innertube: this.innertube // will be set once initInnertube() resolves
    };

    this.players = new PlayerManager(settings, commands, {
      config: config,
      player: this.playerContext
    });

    // initInnertube runs async and sets this.playerContext.innertube when ready
    this.initInnertube();

    this.comLink = (this.comHashLong) ? "https://github.com/remix-bot/fluxer/tree/" + this.comHashLong : "https://github.com/remix-bot/fluxer";
    this.playerMap = new Map();
    this.currPort = -1;
    this.channels = [];
    this.freed = [];

    client.login(config.token);
  }

  getSettings(message) {
    const guildId = message?.channel?.channel?.guildId ?? message?.guildId ?? null;
    return this.settingsMgr.getServer(guildId);
  }

  /**
   * @param {Message} message
   * @param {boolean} [promptJoin]
   * @param {boolean} [verifyUser]
   * @returns {Player}
   */
  getPlayer(message, promptJoin, verifyUser) {
    return this.players.getPlayer(message, promptJoin, verifyUser);
  }

  /**
   * @param {import("@fluxerjs/core").User} user
   * @returns {Promise<Object[]>}
   */
  getSharedServers(user) {
    return new Promise(async (res, _rej) => {
      const mutualGuilds = this.client.guilds.cache.filter(guild =>
        guild.members.cache.has(user.id)
      );
      const servers = mutualGuilds.map((guild) => {
        return {
          name: guild.name,
          id: guild.id,
          icon: guild.iconURL() ?? null,
          voiceChannels: guild.channels.cache
            .filter(c => c.isVoiceBased())
            .map(c => ({ name: c.name, id: c.id, icon: null }))
        };
      });
      res([...servers.values()]);
    });
  }

  /**
   * @param {string} form
   * @param {string} content
   * @param {Message} msg
   * @param {number} linesPerPage
   */
  pagination(form, content, msg, linesPerPage) {
    const builder = new PageBuilder(content)
      .setForm(form)
      .setMaxLines(linesPerPage);
    this.messages.initPagination(builder, msg);
  }

  async generateVisitorData() {
    return new Promise((res, _rej) => {
      generate().then(result => {
        console.log("[Innertube init] VisitorData and PO Token generated: ", result);
        return res(result.visitorData);
      }).catch(() => {
        console.log("[Innertube init] VisitorData generation failed. Retrying in 2 seconds.");
        setTimeout(async () => {
          return res(await this.generateVisitorData());
        }, 2000);
      });
    });
  }

  async getVisitorData() {
    const regenerate = async () => {
      console.log("[Innertube init] generating VisitorData");
      const data = {
        visitorData: await this.generateVisitorData(),
        created: Date.now()
      };
      fs.writeFileSync("./.ytcache/visitor_data.json", JSON.stringify(data));
      return data.visitorData;
    };
    if (!fs.existsSync("./.ytcache/visitor_data.json")) {
      return await regenerate();
    }
    const data = JSON.parse(fs.readFileSync("./.ytcache/visitor_data.json"));
    if (data.created < Date.now() - 1000 * 60 * 60 * 24 * 4) {
      console.log("[Innertube init] VisitorData expired");
      return await regenerate();
    }
    return data.visitorData;
  }

  async initInnertube() {
    Platform.shim.eval = async (data, env) => {
      const properties = [];
      if (env.n) properties.push(`n: exportedVars.nFunction("${env.n}")`);
      if (env.sig) properties.push(`sig: exportedVars.sigFunction("${env.sig}")`);
      const code = `${data.output}\nreturn { ${properties.join(', ')} }`;
      return new Function(code)();
    };

    this.innertube = await Innertube.create({
      retrieve_player: true,
      generate_session_locally: true,
      user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
      client_type: 'WEB',
      visitor_data: await this.getVisitorData()
    });

    // Keep playerContext in sync once innertube is ready
    if (this.playerContext) this.playerContext.innertube = this.innertube;

    this.innertube.session.on('auth-pending', (data) => {
      console.log(`\n[!] YOUTUBE LOGIN: Go to ${data.verification_url} and enter: ${data.user_code}\n`);
    });
    this.innertube.session.on('auth', (data) => {
      console.log('[Player] youtubei.js successfully authenticated.');
      fs.writeFileSync('./.ytcache/yt_auth.json', JSON.stringify(data.credentials));
    });
    this.innertube.session.on('update-credentials', (data) => {
      fs.writeFileSync('./.ytcache/yt_auth.json', JSON.stringify(data.credentials));
    });

    if (fs.existsSync('./.ytcache/yt_auth.json')) {
      const creds = JSON.parse(fs.readFileSync('./.ytcache/yt_auth.json'));
      try {
        await this.innertube.session.signIn(creds);
      } catch (e) {
        console.error("[Player] Session expired, re-authenticating...");
        await this.innertube.session.signIn();
      }
    } else {
      await this.innertube.session.signIn();
    }
  }
}

const remix = new Remix();

process.on("unhandledRejection", (reason, p) => {
  // Suppress "AudioSource is closed" — this fires from @fluxerjs/voice internals
  // when stop() is called while captureFrame() is mid-await. It's harmless.
  if (reason?.message?.includes("AudioSource is closed")) return;
  console.log(" [Error_Handling] :: Unhandled Rejection/Catch");
  console.log(reason, p);
});
process.on("uncaughtException", (err, origin) => {
  console.log(" [Error_Handling] :: Uncaught Exception/Catch");
  console.log(err, origin);
});
process.on("uncaughtExceptionMonitor", (err, origin) => {
  console.log(" [Error_Handling] :: Uncaught Exception/Catch (MONITOR)");
  console.log(err, origin);
});
