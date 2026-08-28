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
- [Localization](#-localization)
- [Scripts](#-npm-scripts)
- [Credits](#-credits--license)

---

## About The Project

Remix is a free and open-source music bot for [Fluxer](https://fluxer.app), built with [`@fluxerjs/core`](https://github.com/fluxerjs/core) for the Fluxer API and [`@fluxerjs/voice`](https://github.com/fluxerjs/voice) for LiveKit voice connections. Track search and streaming are handled by [`lavalink-client`](https://www.npmjs.com/package/lavalink-client) talking to a [NodeLink](https://github.com/PerformanC/NodeLink) audio node (Lavalink-compatible), and the bot publishes Opus audio to LiveKit as a participant — with a custom WebM/Opus pipeline (zero-re-encode passthrough and remux where possible).

We believe music features shouldn't be locked behind paywalls — **all commands on Remix are 100% free and always will be.**

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
            │     • raw PCM         → OpusEncoder (opusscript / @discordjs/opus)
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

---

## Features

- **High-quality audio playback** — NodeLink streaming with a zero-re-encode WebM/Opus pipeline, published over LiveKit
- **Multi-source search** — YouTube, YT Music, Spotify, SoundCloud, Deezer, Apple Music, Tidal, Bandcamp and 40+ more provider prefixes, plus direct URLs
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
├── index.mjs                    # Entry point — Remix class, boot sequence, alone-check,
│                                #   presence rotation, error handling, graceful shutdown
├── config_example.json          # Configuration template
├── package.json
├── commands/                    # 37 command modules (one file per command)
│   ├── play.mjs                 # Play a track or playlist (Last.fm categories, providers)
│   ├── player.mjs               # Interactive emoji control panel with live progress
│   ├── settings.mjs             # Per-guild settings management (+ prefix/247 shortcuts)
│   ├── lyrics.mjs               # Synced lyrics from NodeLink
│   ├── filter.mjs               # Audio filter controls
│   ├── radio.mjs                # Radio station management
│   ├── debug.mjs                # Voice connection debugger (owner only)
│   ├── lastfm.mjs               # Last.fm linking, scrobbling, profiles, leaderboards
│   ├── trackopt.mjs             # Per-track start/end time options (set/get/remove/list)
│   └── ...                      # All other commands
├── src/
│   ├── CommandHandler.mjs       # Command framework — builder, options, requirements,
│   │                            #   cooldowns, prefix manager, loader
│   ├── MessageHandler.mjs       # Replies/embeds, reaction observers, pagination, help
│   ├── PlayerManager.mjs        # Player lifecycle, VC resolution & permission checks,
│   │                            #   dashboard broadcasts, Last.fm scrobble wiring
│   ├── Player.mjs               # Core per-channel player — queue, playback, filters,
│   │                            #   search sessions, autoplay, error circuit breaker
│   ├── FluxerAudioBridge.mjs    # Audio engine — NodeLink REST streams → sniff/remux/
│   │                            #   encode → LiveKit publishing
│   ├── LavalinkManager.mjs      # lavalink-client wrapper (NodeLink mode) — search,
│   │                            #   voice payload caching, node readiness
│   ├── GatewayHandler.mjs       # Raw WS events, voice-state routing, guild lifecycle,
│   │                            #   24/7 rejoin & rejoin retries
│   ├── LastFmManager.mjs        # Last.fm API client — auth, scrobbling, user data,
│   │                            #   MySQL persistence (lastfm_users / lastfm_stats)
│   ├── FluxerListManager.mjs    # FluxerList voters API client (5-min TTL cache)
│   ├── TrackOptionsManager.mjs  # Per-user per-track start/end times (MySQL + LRU cache)
│   ├── Settings.mjs             # RemoteSettingsManager — MySQL-backed per-guild settings
│   │                            #   with debounced JSON_SET writes
│   ├── Utils.mjs                # Shared utilities (IDs, durations, markdown, progress bar)
│   ├── probe.mjs                # ffprobe wrapper for audio stream info (radio metadata)
│   ├── constants/
│   │   ├── Logger.mjs           # Structured logger with per-category control
│   │   ├── Locale.mjs           # i18n translation engine
│   │   ├── Helpers247.mjs       # 24/7 mode helpers
│   │   ├── UI.mjs               # Emoji + UI constants
│   │   ├── providers.mjs        # 45+ audio source provider definitions
│   │   ├── VoiceStateCache.mjs  # Dual LRU voice-state caches (humans / bots)
│   │   ├── VoiceStateResolver.mjs # Voice-state normalization + humans-in-channel check
│   │   └── audio/
│   │       └── WebMOpusMuxer.mjs # Streaming EBML/Matroska muxer (Opus → WebM for LiveKit)
│   └── dashboard/
│       ├── Dashboard.mjs        # Dashboard backend — Redis RPC, player/user serializers,
│       │                        #   remote-control actions with authorization checks
│       ├── DatabaseManager.mjs  # mysql2 pool + parameterized queries + bcrypt helpers
│       └── RedisHandler.mjs     # Redis pub/sub RPC transport with reconnect handling
├── settings/
│   ├── Settings.mjs             # Re-export of src/Settings.mjs classes
│   ├── migrate.mjs              # One-shot settings table clone/repair tool
│   ├── runnables.mjs            # Setting validators (prefix, pfp, stay_247)
│   └── README.md                # Settings system documentation
├── docker/                      # Docker self-hosting (Dockerfile, compose, entrypoint,
│                                #   config templates, .env.example)
└── storage/
    ├── defaults.json            # Default per-guild settings template
    ├── modules.json             # Plugin module registry (empty by default)
    ├── stats.json               # Static counters
    └── locales/bot/             # Translation files
        ├── en.json
        ├── ar-SA.json
        ├── de-DE.json
        ├── ckb.json
        └── pt-BR.json
```

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

To add a new language, place a JSON file in `storage/locales/bot/` following the same key structure as `en.json`, then set the locale per guild with `%settings set locale <code>`.

---

## npm Scripts

| Script | Command | Description |
| :--- | :--- | :--- |
| `npm start` | `node index.mjs` | Start the bot |
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

