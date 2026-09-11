<p align="center">
  <a href="https://github.com/remix-bot">
    <img src="https://i.imgur.com/8hD1Jur.png" alt="Remix Logo" width="100" height="100">
  </a>
</p>

<h1 align="center">Remix</h1>

<p align="center">
  <strong>A premium, high-quality, and open-source music bot for Fluxer.</strong>
</p>

<p align="center">
  <a href="https://web.fluxer.app/oauth2/authorize?client_id=1478084469635211806&scope=bot&permissions=3206208">Invite to Server</a> &middot;
  <a href="https://fluxer.gg/Remix">Report a Bug</a> &middot;
  <a href="https://fluxer.gg/Remix">Request a Feature</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22.13.0-339933.svg" alt="Node.js">
  <img src="https://img.shields.io/badge/ESM-Modules-yellow.svg" alt="ESM">
  <img src="https://img.shields.io/badge/Audio-lavalink--client%20%2B%20NodeLink-orange.svg" alt="lavalink-client">
  <img src="https://img.shields.io/badge/Voice-%40fluxerjs%2Fvoice%20(LiveKit)-9b59b6.svg" alt="@fluxerjs/voice">
  <img src="https://img.shields.io/badge/Database-MySQL-4479A1.svg" alt="MySQL">
  <img src="https://img.shields.io/badge/Maintained%3F-Yes-green.svg" alt="Maintained">
</p>

---

## Table of Contents

- [About The Project](#-about-the-project)
- [How Audio Playback Works](#-how-audio-playback-works)
- [Features](#-features)
- [Getting Started (Users)](#-getting-started-users)
- [Commands](#-commands)
- [Self-Hosting](#-self-hosting-the-bot)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Database Setup](#-database-setup)
  - [Dashboard Setup (Optional)](#-dashboard-setup-optional)
  - [Configuration Reference](#-configuration-reference)
- [Project Architecture](#-project-architecture)
- [The Layered Codebase](#-the-layered-codebase)
- [Localization](#-localization)
- [Scripts](#-npm-scripts)
- [Credits](#-credits--license)

---

## About The Project

Remix is a free and open-source music bot for [Fluxer](https://fluxer.app), built with [`@fluxerjs/core`](https://github.com/fluxerjs/core) for the Fluxer API and [`@fluxerjs/voice`](https://github.com/fluxerjs/voice) for LiveKit voice connections. Track search and streaming are handled by [`lavalink-client`](https://www.npmjs.com/package/lavalink-client) talking to a [NodeLink](https://github.com/PerformanC/NodeLink) audio node (Lavalink-compatible), and the bot publishes Opus audio to LiveKit as a participant — with a custom WebM/Opus pipeline (zero-re-encode passthrough and remux where possible).

We believe music features shouldn't be locked behind paywalls — **all commands on Remix are 100% free and always will be.**

### Fluxer.js 3.0

Remix runs on **`@fluxerjs/core` / `@fluxerjs/util` / `@fluxerjs/voice` 3.0.0** plus **`@fluxerjs/sharding` 3.0.0** (see the [changelog](https://fluxer.js.org/changelog/)). The v3 DX overhaul required only five code-level changes in this codebase — everything else (event names, gateway opcodes, permission flags, the voice/LiveKit API, `EmbedBuilder`, message `reply`/`edit`/`react`, the raw `VOICE_STATE_UPDATE` / `VoiceStatesSync` payloads this bot tracks) is unchanged between 2.2 and 3.0:

1. `package.json` — the three `@fluxerjs/*` ranges moved from `^2.2.0` to `^3.0.0` (a `^2.2.0` range will not install 3.0).
2. `src/core/Bot.mjs` — the `Client` `presence` option now uses the normalized v3 shape (`customStatus`/`emojiName`/`emojiId`) instead of the 2.2 wire format (`custom_status`); the deprecated no-op `suppressIntentWarning` option was dropped.
3. `src/voice/gateway/GatewayHandler.mjs` — the presence-rotation sender wraps its `client.ws` access in a try/catch, because 3.0 exposes `client.ws` as a getter that throws when the gateway is not connected (2.2 exposed a plain optional). The rotation payload itself stays in wire format because it sends opcode 3 straight to the shard.
4. `src/ui/MessageHandler.mjs` — `joinChannel()` checks `channel.isGuild?.()` first (the new ChannelType-based guard) and keeps the legacy `"guildId" in channel` check as a fallback for stub objects.
5. `src/utils/ShardingUtils.mjs` (new) — 3.0 removed the WebSocketManager's `shards` Map property in favour of `getShards()`/`getShard()` methods, which had silently disabled the bot's raw-socket listeners (they no-op'd behind their existing guards). All five readers — Bot.mjs's WS error handlers, GatewayHandler's raw listener and presence sender, LavalinkManager's payload routing and raw listener — now go through version-agnostic helpers that also make them shard-aware (see below).

Two 3.0 library-level notes that need no code change here: the WS manager no longer emits `shardCreate` (the bot's 5-second handler re-arm loop covers re-attachment), and `Guild.description` was removed from the core structures (the dashboard serializer already null-guards it, so server descriptions simply render empty). Passing `intents` or `suppressIntentWarning` inside `config["fluxer.js"]` is still accepted — both are documented deprecated no-ops in 3.0.

### Sharding (optional)

`@fluxerjs/sharding` 3.0.0 (beta) is wired in as an **opt-in** layer — the default single-process boot (`npm start` / `node index.mjs`) is byte-for-byte unchanged, and none of the sharding code paths activate unless the process was actually forked by the manager (it sets `FLUXER_SHARD_IDS` *and* provides an IPC channel; manually exporting the variables does nothing).

- **Supervisor:** `node shard.mjs` (or `npm run shard`) forks one child per shard slice, each running the ordinary `index.mjs` boot. The manager owns the shared per-IP IDENTIFY budget so children can never collectively exceed the gateway limit, respawns dead children, and exposes `broadcastEval` / `fetchClientValues` / `respawnAll`.
- **Child side:** `src/core/Bot.mjs` attaches the library's `ShardClientUtil` before `login()` (it applies the shard slice to the client options) and calls `notifyReady()` after login so the supervisor's spawn promise resolves. A failed attach under a manager is fatal by design — without its slice the child would identify as shard 0 like every other child and thrash the gateway sessions.
- **Guild→shard routing:** opcode-4 voice payloads from LavalinkManager now target `shardIdForGuildId(guildId)` instead of hardcoded shard 0, presence updates fan out to every gateway shard in the process, and raw-socket listeners attach to *all* local shard sockets. Unsharded, every one of these degrades to exactly the previous shard-0 behavior.

Configuration (config.json, all optional — defaults shown):

```json
"sharding": { "totalShards": 1, "shardsPerProcess": 1, "respawn": true,
              "spawnTimeout": 30000, "spawnDelay": 5000 }
```

`FLUXER_TOTAL_SHARDS` / `FLUXER_SHARDS_PER_PROCESS` env vars override the config (useful in Docker, where you switch the container command to `node shard.mjs`). Prefer an explicit `totalShards` — Fluxer's `/gateway/bot` always reports `shards: 1`, so there is no reliable `"auto"`.

Beta caveats worth knowing: DMs and guild-less events only reach shard 0 (library limitation); each child opens its own MySQL/Redis/Lavalink connections and its own dashboard RPC subscription, so the dashboard is currently single-process-first — guilds on other shards won't be reachable from it, and concurrent `storage/stats.json` writes across children can race. The stock `node index.mjs` deployment has none of these issues.

---

## How Audio Playback Works

Understanding the pipeline helps when debugging or contributing:

```
%play → LavalinkManager.search()  ──►  NodeLink (track resolution only)
      → Player queue → FluxerAudioBridge.play(voiceConnection, track)
            ├─ /v4/trackstream → direct WebM/Opus passthrough (no re-encode)
            ├─ /v4/loadstream  → magic-byte sniffing:
            │     • WebM (1A45DFA3) → passthrough to LiveKit
            │     • OggS            → OggDemuxer → WebMOpusMuxer (remux, no re-encode)
            │     • raw PCM         → OpusEncoder (opusscript)
            │                          → WebMOpusMuxer → LiveKit
            └─ conn.play() → @fluxerjs/voice LiveKit connection (bot publishes audio
                             as a LiveKit participant)
```

A few things worth knowing:

- **No Lavalink players are created.** NodeLink is used for search and its REST stream/lyrics endpoints (`/v4/loadstream`, `/v4/trackstream`, `/v4/loadlyrics`); playback itself is pure LiveKit publishing.
- **Seek / pause / resume** work by stopping the current stream and re-requesting it at an offset from NodeLink.
- **Filters** (bassboost, nightcore, etc.) are applied server-side by NodeLink, so they take effect on the next track that starts.
- **Volume** is applied client-side by the LiveKit connection (1–200).
- Radio metadata (StreamTitle) is read with **ffprobe** (`ffprobe-static`).
- **Bilibili playback** — `%play https://www.bilibili.com/video/BV…` (b23.tv short links and `?p=` parts included) resolves the video through Bilibili's web API, picks the best DASH audio stream, and feeds it to the node through a signed localhost proxy that attaches the Referer/User-Agent headers Bilibili's CDN requires. Multi-part videos queue like a playlist. If Bilibili risk-control blocks your hosting IP (HTTP 412), set `bilibili.cookie` in config.json to a logged-in browser cookie string. The proxy binds `127.0.0.1` by default — set `bilibili.advertiseHost` (and `bind: "0.0.0.0"`) when your node runs on another machine.

---

## Features

- **High-quality audio playback** — NodeLink streaming with a zero-re-encode WebM/Opus pipeline, published over LiveKit
- **Multi-source search** — YouTube, YT Music, Spotify, SoundCloud, Deezer, Apple Music, Tidal, Bandcamp and 40+ more provider prefixes, plus direct URLs and Bilibili videos
- **24/7 mode** — keep the bot in a voice channel permanently, with staggered auto-rejoin on boot and rejoin retries on connection loss
- **Interactive emoji player** — reaction-based control panel with live progress, lyrics viewer, and a filter submenu
- **Lyrics** — synced lyrics via NodeLink
- **Radio stations** — built-in support for custom radio streams with keyword-based search
- **Last.fm integration** — account linking, scrobbling, now-playing, play loved/top/recent/albums, whoknows, crowns, compare, leaderboards, and profiles
- **Autoplay** — automatically play similar tracks when the queue ends (powered by Last.fm)
- **Seek** — jump to a specific position in the current track
- **Track options** — set custom start/end times per track, great for album compilations and hidden tracks
- **Queue move** — reorder tracks by moving them to a different position
- **Audio filters** — bassboost, speed, nightcore and more (applied server-side by NodeLink)
- **Server settings** — per-guild configuration (prefix, volume, locale, 24/7 channels, …) stored in MySQL
- **Dashboard backend** — optional Redis-RPC backend that an external web frontend uses to monitor players and control playback remotely
- **Multi-language support** — English, Arabic, German, Kurdish (Sorani), and Brazilian Portuguese
- **Configurable logging** — granular control over which log categories appear in the console
- **Graceful shutdown** — destroys players and closes MySQL/Redis/NodeLink sessions cleanly on SIGINT/SIGTERM/SIGUSR2
- **Module system** — pluggable module architecture for extending bot functionality (`storage/modules.json`)

---

## Getting Started (Users)

Want to use Remix in your server right away?

1. **[Invite Remix](https://web.fluxer.app/oauth2/authorize?client_id=1478084469635211806&scope=bot&permissions=3206208)** to your Fluxer server.
2. Join a voice channel.
3. Use the `%help` command to see everything the bot can do, or jump straight in with `%play <song name>`.

---

## Commands

Below is the complete list of Remix's commands. The default prefix is `%`.

### Music

| Command | Description | Usage | Aliases |
| :--- | :--- | :--- | :--- |
| `play` | Play a song from a URL, search query, or playlist | `%play Never Gonna Give You Up` / `%play lastfm:loved` | `p` |
| `playnext` | Add a song/playlist to the *top* of the queue | `%playnext query: text` | `pn` |
| `pause` | Pause the current playback | `%pause` | |
| `resume` | Resume the paused playback | `%resume` | |
| `skip` | Skip the currently playing song | `%skip` | `s` |
| `np` | Show the currently playing song | `%np` | `current`, `nowplaying` |
| `list` | View the upcoming queue | `%list` | `queue`, `q` |
| `loop` | Toggle loop mode (song or queue) | `%loop queue` | |
| `shuffle` | Randomize the queue order | `%shuffle` | |
| `remove` | Remove a specific song by its queue index | `%remove 3` | |
| `clear` | Clear the entire queue | `%clear` | `c` |
| `volume` | Change the playback volume (1–200) | `%volume 50` | `v`, `vol` |
| `volumedefault` | Set the default volume for the server | `%volumedefault 80` | `vd` |
| `search` | Search for a track and pick from results | `%search query` | |
| `lyrics` | Display synced lyrics from NodeLink | `%lyrics` | `lyric`, `ly` |
| `thumbnail` | Get the thumbnail of the current track | `%thumbnail` | `thumb` |
| `radio` | Play a built-in or custom radio station | `%radio` | `r` |
| `filter` | Manage audio filters (bass, speed, nightcore, etc.) | `%filter bass 50` | `filters`, `fx`, `effect` |
| `player` | Create an interactive emoji control panel with live progress | `%player` | |
| `join` | Make the bot join a specific voice channel | `%join 123456789` | |
| `leave` | Make the bot leave the current voice channel | `%leave` | `l`, `stop` |
| `forceleave` | Force the bot to leave any channel (requires Manage Channels) | `%forceleave` | `fl` |
| `seek` | Seek to a specific position in the current track | `%seek 1:30` / `%seek 90` | |
| `move` | Move a track from one position to another in the queue | `%move 2 5` | `mv`, `m` |
| `autoplay` | Toggle autoplay — automatically play similar tracks when queue ends | `%autoplay` | `ap` |
| `trackopt` | Set custom start/end times for tracks | `%trackopt set 0:30 3:45` | `to` |

### Utility

| Command | Description | Usage | Aliases |
| :--- | :--- | :--- | :--- |
| `settings` | View or change server settings (requires Manage Server) | `%settings set` | `prefix`, `pfx`, `247` |
| `stats` | Display bot stats (uptime, ping, player count, stored scrobbles) | `%stats` | `info` |
| `invite` | Get the bot invite link | `%invite` | `addbot`, `remix` |
| `support` | Get an invite to the support server | `%support` | `server` |
| `lastfm` | Link Last.fm, toggle scrobbling, view profile, love/unlove tracks, top artists, play tracks, leaderboard | `%lastfm link` / `%lastfm love` / `%lastfm artists` / `%lastfm lb` | `lf`, `lfm` |
| `vote` | Check FluxerList voters for the bot | `%vote` | |
| `reload` | Reload commands or modules at runtime (owner) | `%reload` | |
| `servers` | List servers the bot is in (owner) | `%servers` | |
| `eval` | Evaluate JavaScript (owner only) | `%eval 1+1` | |
| `debug` | Debug voice connections and player state (owner) | `%debug voice` | |
| `test` | Show voice channel user counts (owner) | `%test` | |

## Self-Hosting The Bot

If you prefer to host Remix yourself, please note: **You must make it clear that your bot is an instance of Remix.** Change the bot's name and give credit in the bot's profile (e.g., *"Powered by [Remix](https://github.com/remix-bot/fluxer)"*).

### Quick Start with Docker (Recommended)

The fastest way to self-host Remix is with Docker. Everything — the bot, MySQL, Redis, and NodeLink — runs in containers with a single command. All Docker files live in the `docker/` folder.

1. **Clone and configure:**
   ```bash
   git clone https://github.com/remix-bot/fluxer.git
   cd fluxer/docker
   cp config_example.json config.json
   cp .env.example .env   # optional — compose has working defaults
   ```

2. **Edit `config.json`** — fill in your bot token, MySQL credentials (defaults match the compose MySQL service), NodeLink details (defaults match the compose NodeLink service), and your owner IDs. Spotify/Deezer/Apple Music credentials are configured on the **NodeLink side** (`nodelink.config.json`), not in the bot config.

3. **Edit `.env`** (optional) — MySQL passwords, host port mappings (`WEB_PORT`, `NODELINK_PORT`), and timezone.

4. **Start everything:**
   ```bash
   docker compose up -d
   ```

5. **Check logs:**
   ```bash
   docker compose logs -f bot
   ```

That's it. The bot will start, connect to MySQL (Last.fm and track-options tables are auto-created), connect to NodeLink, and log in to Fluxer.

#### Docker file structure

```
docker/
├── Dockerfile              # Multi-stage build (Node 22 + tini, non-root user, healthcheck)
├── docker-entrypoint.sh    # Writes config.json from CONFIG_JSON env var on first boot
├── docker-compose.yml      # bot + MySQL + Redis + NodeLink
├── .env.example            # Compose env template (MySQL creds, ports, TZ)
├── config_example.json     # Docker-friendly config template
├── config.json             # You create this (gitignored)
├── .env                    # You create this (gitignored)
└── nodelink.config.json    # NodeLink audio node config
```

#### Docker services

| Service | Container | Port | Purpose |
| :--- | :--- | :--- | :--- |
| `bot` | remix-bot | `${WEB_PORT:-8080}` → 80 | The Remix bot (+ optional dashboard backend) |
| `mysql` | remix-mysql | — | Settings, Last.fm users, and track options storage |
| `redis` | remix-redis | — | Dashboard RPC pub/sub (optional) |
| `nodelink` | remix-nodelink | `${NODELINK_PORT:-3000}` | Lavalink-compatible audio node |

#### Useful Docker commands

```bash
# Run from the docker/ folder
cd docker

# Start all services
docker compose up -d

# View live bot logs
docker compose logs -f bot

# Restart the bot
docker compose restart bot

# Stop everything
docker compose down

# Stop and delete data volumes (full reset)
docker compose down -v

# Rebuild after code changes
docker compose up -d --build bot
```

#### Using `CONFIG_JSON` env var instead of a mounted file

If you prefer to keep your config in an environment variable (useful for CI/CD or secret managers), set `CONFIG_JSON` in your `.env`:

```bash
CONFIG_JSON={"token":"YOUR_TOKEN","mysql":{"host":"mysql","port":3306,"user":"remix","password":"remix_pw","database":"remix"},"nodelink":{"host":"nodelink","port":3000,"password":"youshallnotpass"}}
```

The entrypoint will write it to `/app/config.json` on first boot if no config file is mounted.

### Manual Installation (Without Docker)

#### Prerequisites

- **Node.js** >= 22.13.0
- **MySQL** 8.0+ with JSON column support
- **[NodeLink](https://github.com/PerformanC/NodeLink)** instance (Lavalink-compatible audio node)
- **Redis** (optional — required only for the dashboard backend)

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/remix-bot/fluxer.git
   cd fluxer
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure the bot:**
   ```bash
   cp config_example.json config.json
   ```
   Open `config.json` and fill in the required values:
   - `token` — your Fluxer bot token
   - `mysql` — your MySQL connection details (host, port, user, password, database)
   - `prefix` — the command prefix (default: `%`)
   - `nodelink` — your NodeLink instance connection details
   - `lastfm` — (optional) Last.fm API credentials for scrobbling/autoplay features
   - `owners` — array of Fluxer user IDs with owner-only command access

4. **Set up the database:** *(See [Database Setup](#-database-setup) below)*

5. **Start the bot:**
   ```bash
   npm start
   ```

   For development with inspector:
   ```bash
   npm run dev
   ```

### Database Setup

Remix requires a MySQL database to store per-guild settings and user data.

1. Create a dedicated database for Remix:
   ```sql
   CREATE DATABASE remix;
   ```

2. Enter your MySQL connection details into `config.json`:
   ```json
   "mysql": {
     "host": "localhost",
     "port": 3306,
     "user": "remix",
     "password": "your-password",
     "database": "remix"
   }
   ```

3. Create the required `settings` table:
   ```sql
   CREATE TABLE `settings` (
     `id` varchar(70) NOT NULL,
     `data` json NOT NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3;
   ```

4. Everything else is **auto-created on startup** if missing:
   - `track_options` — per-user per-track start/end times (`%trackopt`)
   - `lastfm_users` — Last.fm session keys and scrobble opt-ins
   - `lastfm_stats` — stored scrobble/link counts

5. *(Optional)* If you need to clone or repair the settings table across bot IDs, run:
   ```bash
   npm run migrate
   ```

### Dashboard Setup (Optional)

Remix ships the **backend half** of a web dashboard: a Redis-RPC service that an external frontend project talks to. There is no HTTP server or web UI in this repository.

1. Enable it in `config.json`:
   ```json
   "dashboard": {
     "enabled": true,
     "redis": { "url": "redis://localhost:6379" }
   }
   ```

2. How it works:
   - The bot listens on Redis pub/sub channels (`request` / `response` / `info`) and answers JSON-RPC style requests with an `id` for correlation.
   - Supported requests: `fetchPlayers`, `user`, `sharedServers`, `server`, `allServers`, `commands`, and `function` (remote actions: `join`, `pausePlayback`, `resumePlayback`, `skip`, `volume`, `addToQueue`, `voiceState`, `leave`, `testConnection`).
   - Player updates are broadcast (debounced) on per-bot/per-player Redis channels so the frontend can render live state.
   - **Login flow:** the external frontend writes login codes into the MySQL `login_codes` table; the bot verifies them with bcrypt hashes and marks them verified. Player control additionally requires the user to be in the same voice channel (owners are exempt).

3. **Security note:** the RPC channel has **no shared secret** — anything that can publish to your Redis can invoke the remote actions. Keep Redis network-isolated (as the Docker setup does) and don't expose it publicly.

---

## Configuration Reference

Key configuration options in `config.json`:

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `token` | string | — | **Required.** Fluxer bot token |
| `prefix` | string | `%` | Default command prefix |
| `embedColor` | string | `0xe9196c` | Hex color for embed messages |
| `owners` | string[] | `[]` | User IDs with owner privileges |
| `playerAFKTimeout` | number | `60000` | Inactivity timeout in ms before the player panel session ends |
| `customStatsFooter` | string | — | Custom text shown in the `%stats` embed footer |
| `presenceInterval` | number | `30000` | Interval in ms for rotating bot presence status |
| `presenceContents` | array | `[]` | Presence status messages to cycle through (strings or objects with `text`/`emoji_name`/`emoji_id`/`activity`) |
| `mysql` | object | — | **Required.** MySQL connection settings |
| `nodelink` | object | — | NodeLink connection (`host`, `port`, `password`, `requestTimeout`) |
| `lastfm` | object | — | Last.fm integration (`apiKey`, `apiSecret`, `scrobbleThreshold`, `scrobbleMinMs`) |
| `fluxerlist` | object | — | FluxerList integration (`apiKey`, `serverId`, `botId`, `serverSlug`, `botSlug`) |
| `dashboard` | object | — | Dashboard backend: `enabled`, `redis.url` |
| `radio` | array | `[]` | Custom radio station definitions |
| `logging` | object | — | Per-category log toggles: `enabled`, `warn`, and 14 categories (`player`, `inactivity`, `aloneCheck`, `voiceState`, `voice247`, `voice`, `mediaplayer`, `commands`, `guild`, `recovery`, `settings`, `lavalink`, `dashboard`, `redis`) |
| `timers` | object | — | Timing values in ms: `inactivityTimeout`, `aloneCheckInterval`, `aloneCheckDebounce`, `rejoin247Delay`, `leave247RejoinDelay`, `playerUpdateInterval`, `searchSessionTimeout`, `playerSessionTimeout`, `intentionalLeaveTTL` |
| `fluxer.js` | object | — | Fluxer.js REST options (`timeout`, `retries`) |

---

## Project Architecture

```
fluxer/
├── index.mjs                    # Entry point — creates the Remix instance, process-level
│                                #   error guards, and signal-based graceful shutdown
├── shard.mjs                    # OPTIONAL sharding supervisor (@fluxerjs/sharding) — forks
│                                #   one child process per shard slice, each running index.mjs
├── config_example.json          # Configuration template
├── package.json
├── commands/                    # 37 command entry files (one per command); the three
│   │   # largest (lastfm, settings, debug) are split into action-family
│   │   #   modules inside commands/<name>/ subdirectories
│   ├── lastfm/                 # lastfm action families (account, playback, listening,
│   │                           #   whoknows, info, tags, discovery, help, shared)
│   ├── settings/               # settings helpers (utils, channels247, setters)
│   └── debug/                  # debug helpers (consts, gateway, rejoin, voiceDiagnostic)
├── settings/                    # Settings system entry points (re-export, migrate, validators)
├── storage/                     # Runtime data: defaults, modules.json, locales
├── docker/                      # Docker self-hosting (Dockerfile, compose, entrypoint,
│                                #   config templates, .env.example)
└── src/
    ├── core/                    # Bot composition
    │   ├── Bot.mjs              # Remix class — boot sequence, service wiring, alone-check,
    │   │                        #   presence rotation, WebSocket error guards
    │   ├── BotVoiceMixin.mjs    # Voice-channel resolution, 24/7 player spawning with
    │   │                        #   announcements, programmatic leave, shared servers
    │   ├── Logger.mjs           # Structured logger with per-category control
    │   └── Locale.mjs           # i18n translation engine
    ├── commands/                # Command framework layer
    │   ├── index.mjs            # Public surface (re-exports)
    │   ├── CommandBuilder.mjs   # Fluent builder + permission requirements
    │   ├── Option.mjs           # Typed options + flags with validation
    │   ├── CommandHandler.mjs   # Dispatcher: parsing, cooldowns, permission checks
    │   ├── CommandLoader.mjs    # Dynamic command loading + run-handler binding
    │   ├── HelpHandler.mjs      # Text help generation (usage/aliases/options)
    │   └── PrefixManager.mjs    # Per-guild prefix resolution
    ├── ui/                      # Message/embed layer
    │   ├── index.mjs            # Public surface (re-exports)
    │   ├── MessageHandler.mjs   # Reply/send/edit embeds, reaction + message observers,
    │   │                        #   permission checks, pagination entry
    │   ├── Wrappers.mjs         # Message & Channel wrappers
    │   ├── Paginators.mjs       # PageBuilder, RichPaginator (tabbed), QueuePaginator
    │   ├── HelpCommand.mjs      # Rich tabbed help command (Home/Music/Utilities/Support)
    │   ├── Permissions.mjs      # Required/critical/optional bot permission catalog
    │   └── Embeds.mjs           # Global embed color + message-shape helpers
    ├── voice/                   # Gateway & voice-state layer
    │   ├── VoiceStateCache.mjs  # Dual LRU voice-state caches (humans / bots)
    │   ├── VoiceStateResolver.mjs # Voice-state normalization + humans-in-channel check
    │   └── gateway/
    │       ├── index.mjs        # Public surface
    │       ├── GatewayHandler.mjs       # Raw WS dispatch, presence rotation, boot recovery
    │       ├── VoiceStateRouting.mjs    # Voice-state update handling, inactivity triggers
    │       ├── GuildSync.mjs            # Guild seeding (cache + REST), guild delete
    │       └── RejoinManager.mjs        # 24/7 rejoin scheduling with retries
    ├── music/                   # Player + audio engine layer
    │   ├── PlayerManager.mjs    # Player lifecycle & registry, getPlayer/initPlayer
    │   ├── PlayerEventsMixin.mjs   # Per-player event wiring, scrobbles, broadcasts
    │   ├── PlayerLifecycleMixin.mjs# Voice checks, prompts, joins, leaves
    │   ├── LavalinkManager.mjs # lavalink-client wrapper (NodeLink mode)
    │   ├── probe.mjs           # ffprobe wrapper for radio stream metadata
    │   ├── providers.mjs       # 45+ audio source provider definitions
    │   ├── player/
    │   │   ├── index.mjs       # Public surface (default export: Player)
    │   │   ├── Player.mjs      # Core state machine: join/leave/destroy, controls, 24/7
    │   │   ├── Queue.mjs       # Queue data structure with loop modes + events
    │   │   ├── PlaybackMixin.mjs   # playNext pipeline, track-end timers, lyrics
    │   │   ├── SearchMixin.mjs     # Lavalink search, fallbacks, radio/external builders
    │   │   └── DisplayMixin.mjs    # Now-playing, queue listing, announcements
    │   └── audio/
    │       ├── index.mjs       # Public surface
    │       ├── FluxerAudioBridge.mjs  # NodeLink streams → LiveKit publishing core
    │       ├── StreamPipeline.mjs     # Magic-byte sniffing, remux, Opus encode
    │       ├── HttpStreams.mjs        # Redirect-following HTTP JSON/stream helpers
    │       └── WebMOpusMuxer.mjs      # Streaming EBML/Matroska muxer (Opus → WebM)
    ├── services/                # Integrations
    │   ├── FluxerListManager.mjs   # FluxerList voters API client (TTL cache)
    │   ├── TrackOptionsManager.mjs # Per-user per-track start/end times (MySQL + LRU)
    │   └── lastfm/
    │       ├── index.mjs       # Public surface
    │       ├── LastFmManager.mjs   # Base: config, MySQL pool, shared helpers
    │       ├── UserStoreMixin.mjs  # Linking, sessions, scrobble opt-ins
    │       ├── ScrobblingMixin.mjs # Scrobble + now-playing
    │       ├── TrackQueriesMixin.mjs  # Track/artist/album/tag/geo/chart queries
    │       ├── UserQueriesMixin.mjs   # User tops, charts, playlists, play categories
    │       ├── ServerStatsMixin.mjs   # Whoknows, crowns, leaderboards, affinity
    │       ├── constants.mjs    # Signed API-call plumbing
    │       └── urlUtils.mjs     # lastfm:// URL parsing
    ├── db/                      # Persistence
    │   ├── Settings.mjs         # SettingsManager / ServerSettings / RemoteSettingsManager
    │   │                        #   (MySQL-backed, debounced JSON_SET writes)
    │   └── DatabaseManager.mjs  # mysql2 pool + parameterized queries + bcrypt helpers
    ├── utils/                   # Cross-layer primitives (leaf layer)
    │   ├── mixins.mjs           # applyMixins — god-class splitting helper
    │   ├── ShardingUtils.mjs    # Shard-aware gateway helpers (2.2/3.0 compatible,
    │   │                        #   guild→shard routing, local shard enumeration)
    │   ├── Utils.mjs            # Formatting, validation, ID cleaning
    │   ├── API.mjs              # REST call helpers (status/error wrapping)
    │   ├── UI.mjs               # Shared UI constants (colors)
    │   └── Helpers247.mjs       # 24/7 channel-mode helpers
    └── dashboard/               # Dashboard backend
        ├── index.mjs           # Public surface
        ├── Dashboard.mjs       # Redis RPC routing, player/user broadcasts
        ├── RpcHandlersMixin.mjs# Request handlers + authorization checks
        ├── Serializers.mjs     # Channel/user/player/command serializers (statics)
        └── RedisHandler.mjs    # Redis pub/sub RPC transport with reconnect handling
```

---

## The Layered Codebase

The rewrite organises the codebase into strict layers with one-way dependencies
(no layer reaches *down* past another):

```
index.mjs
   └── core/  ──────────────► composition root: wires every layer together
        ├── commands/  ─────► command framework (parsing, cooldowns, help)
        │      └── ui/ ─────► message/embed primitives used by the framework
        ├── ui/          ──── message wrappers, paginators, permissions
        ├── voice/       ──── gateway events, voice-state caches, 24/7 rejoin
        ├── music/       ──── players, queue, audio engine, Lavalink client
        ├── services/    ──── Last.fm, FluxerList, track options
        ├── db/          ──── MySQL settings + dashboard database pool
        └── dashboard/   ──── Redis-RPC backend
```

**God classes were eliminated.** The five largest modules (Player, PlayerManager,
GatewayHandler, FluxerAudioBridge, LastFmManager, Dashboard) are each split into a
small base class plus **concern mixins** — one file per responsibility, applied onto
the class at load time via `src/utils/mixins.mjs` (`applyMixins`). All methods keep
the same names, so callers (including your own command files and modules) are
unaffected.

**Big commands are grouped the same way.** The three commands that outgrew a
single file (`lastfm` 2.5k lines, `settings` 705, `debug` 669) keep their entry
file at `commands/<name>.mjs` (same path the loader, `%reload` and help system
reference) and move their implementation into `commands/<name>/` — one module per
action family, dispatched by the entry's `run()` via per-module action sets:

```js
// commands/lastfm.mjs (entry) — dispatch
if (ACCOUNT_ACTIONS.has(action))
  return runAccountActions.call(this, msg, data, lastfm, prefix, userId, targetUserId, action);
```

The loader only reads top-level `*.mjs` files, so the subdirectories are invisible
to command discovery; case bodies and helpers were moved verbatim (verified by
per-command runtime parity harnesses under `scripts/`), and every entry file keeps
its original exports (`playLastFmCategory` is still importable from
`commands/lastfm.mjs`). `commands/player.mjs` intentionally stays single-file: it
is one cohesive interactive UI flow (a single 500-line `run()` closure) with no
seams that could be split without rewriting behavior.

**Public surfaces are barrels.** Each layer folder has an `index.mjs` that
re-exports its public API, so imports stay short and implementation files can move
without touching consumers:

```js
import { CommandBuilder } from "../src/commands/index.mjs";
import { Message, getGlobalColor } from "../src/ui/index.mjs";
import Player from "../src/music/player/index.mjs";
import { LastFmManager } from "../src/services/lastfm/index.mjs";
```

**Compatibility is drop-in:** `config.json` keys, the MySQL schema, the Redis RPC
protocol, command names/aliases, locale files, and the Docker entrypoint
(`node index.mjs` at the repository root) are all unchanged from the previous
single-layer layout.

---

## Localization

Remix supports multiple languages out of the box. The locale system loads JSON translation files from `storage/locales/bot/` and serves the appropriate language based on each guild's `locale` setting.

Currently supported languages:

| Code | Language |
| :--- | :--- |
| `en` | English (default) |
| `ar-SA` | Arabic |
| `de-DE` | German |
| `ckb` | Kurdish (Sorani) |
| `pt-BR` | Brazilian Portuguese |
| `tr` | Turkish |

To add a new language, place a JSON file in `storage/locales/bot/` following the same key structure as `en.json`, then set the locale per guild with `%settings set locale <code>`.

---

## npm Scripts

| Script | Command | Description |
| :--- | :--- | :--- |
| `npm start` | `node index.mjs` | Start the bot (single process — default) |
| `npm run shard` | `node shard.mjs` | Start under the sharding supervisor (optional) |
| `npm run dev` | `node --inspect index.mjs --trace-warnings` | Start with Node.js inspector |
| `npm run migrate` | `node settings/migrate.mjs` | Clone/repair the remote settings table |

---

## Credits & License

**Development:**
- [ShadowLp174](https://github.com/ShadowLp174) — Lead developer
- [NoLogicAlan](https://github.com/NoLogicAlan) — Lead developer
- [Fantic](https://github.com/fanticwastaken) — Community Manager

**Powered by:**
- [`@fluxerjs/core`](https://github.com/fluxerjs/core) — Fluxer API client
- [`@fluxerjs/voice`](https://github.com/fluxerjs/voice) — LiveKit voice connections and playback
- [`lavalink-client`](https://www.npmjs.com/package/lavalink-client) — Lavalink/NodeLink client (search + streaming)
- [`NodeLink`](https://github.com/PerformanC/NodeLink) — Lavalink-compatible audio node
- [`prism-media`](https://github.com/discordjs/prism-media) — Opus encoding and stream demuxing

<p align="center">
  &copy; 2026 Remix. Code licensed under the <a href="LICENSE">MIT License</a>.<br>
  <em>The Remix name, logo, and branding are proprietary and may not be reused.</em>
</p>
