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
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22.0.0-339933.svg" alt="Node.js">
  <img src="https://img.shields.io/badge/ESM-Modules-yellow.svg" alt="ESM">
  <img src="https://img.shields.io/badge/Audio-moonlink.js-orange.svg" alt="moonlink.js">
  <img src="https://img.shields.io/badge/Voice-revoice.js-9b59b6.svg" alt="revoice.js">
  <img src="https://img.shields.io/badge/Database-MySQL-4479A1.svg" alt="MySQL">
  <img src="https://img.shields.io/badge/Maintained%3F-Yes-green.svg" alt="Maintained">
</p>

---

## Table of Contents

- [About The Project](#-about-the-project)
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

Remix is a free and open-source music bot for [Fluxer](https://fluxer.app), built with [`@fluxerjs/core`](https://github.com/fluxerjs/core) and powered by [`moonlink.js`](https://github.com/ShadowLp174/moonlink.js) for seamless, high-quality audio streaming. It uses [`revoice.js`](https://www.npmjs.com/package/revoice.js) for LiveKit voice connections and audio playback, and [`@fluxerjs/voice`](https://github.com/fluxerjs/voice) for native voice channel integration alongside the Moonlink Lavalink proxy.

We believe music features shouldn't be locked behind paywalls — **all commands on Remix are 100% free and always will be.**

---

## Features

- **High-quality audio playback** via moonlink.js (Lavalink proxy), revoice.js (LiveKit voice + MediaPlayer), and `@fluxerjs/voice`
- **Multi-source search** — YouTube, Spotify, SoundCloud, Deezer, Apple Music, Tidal, and direct URL support
- **24/7 mode** — keep the bot in a voice channel permanently, with auto-recovery on restart
- **Session recovery** — active players and queues survive bot restarts and crash recovery
- **Interactive emoji player** — reaction-based control panel with play, pause, skip, volume, shuffle, and more
- **Lyrics** — fetch synced lyrics via NodeLink
- **Radio stations** — built-in support for custom radio streams with keyword-based search
- **Last.fm integration** — auto-scrobble songs, play loved/top/recent tracks, and view your Last.fm profile
- **Server settings** — per-guild configuration for prefix, volume, locale, 24/7 channels, and more
- **Web dashboard** — optional browser-based control panel with Redis-backed sessions and Fluxer OAuth2 login
- **Multi-language support** — available in English, Arabic, German, Kurdish (Sorani), and Brazilian Portuguese
- **Configurable logging** — granular control over which log categories appear in the console
- **Graceful shutdown** — saves active session state on SIGINT/SIGTERM for seamless reboot recovery
- **Module system** — pluggable module architecture for extending bot functionality

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
| `play` | Play a song from a URL, search query, or playlist | `%play Never Gonna Give You Up` | `p` |
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

### Utility

| Command | Description | Usage | Aliases |
| :--- | :--- | :--- | :--- |
| `settings` | View or change server settings (requires Manage Server) | `%settings set` | `prefix`, `pfx`, `247` |
| `stats` | Display bot stats (uptime, ping, player count) | `%stats` | `info` |
| `invite` | Get the bot invite link | `%invite` | `addbot`, `remix` |
| `support` | Get an invite to the support server | `%support` | `server` |
| `lastfm` | Link Last.fm account, toggle scrobbling, view profile | `%lastfm link` | `lf`, `lfm` |
| `reload` | Reload commands or modules at runtime (owner) | `%reload` | |
| `servers` | List servers the bot is in (owner) | `%servers` | |
| `eval` | Evaluate JavaScript (owner only) | `%eval 1+1` | |
| `debug` | Debug voice connections and player state (owner) | `%debug voice` | |
| `test` | Show voice channel user counts (owner) | `%test` | |

---

## Self-Hosting The Bot

If you prefer to host Remix yourself, please note: **You must make it clear that your bot is an instance of Remix.** Change the bot's name and give credit in the bot's profile (e.g., *"Powered by [Remix](https://github.com/remix-bot/fluxer)"*).

### Prerequisites

- **Node.js** >= 22.0.0 (required by moonlink.js v5)
- **MySQL** 8.0+ with JSON column support
- **[NodeLink](https://github.com/PerformanC/NodeLink)** instance (Lavalink proxy for audio)
- **FFmpeg** (installed automatically via `ffmpeg-static`)
- **Redis** (optional, required for the web dashboard)

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
   - `spotify` — (optional) Spotify API credentials for Spotify track support
   - `geniusToken` — *(deprecated, unused)* was previously for lyrics; lyrics are now fetched via NodeLink
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

Remix requires a MySQL database to store per-guild settings.

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

3. Create the required table:
   ```sql
   CREATE TABLE `settings` (
     `id` varchar(70) NOT NULL,
     `data` json NOT NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3;
   ```

4. *(Optional)* If migrating from the legacy settings system, run:
   ```bash
   npm run migrate
   ```

### Dashboard Setup (Optional)

Remix includes a web dashboard for controlling the bot through a browser interface.

1. Enable the dashboard in `config.json`:
   ```json
   "dashboard": {
     "enabled": true,
     "redis": { "url": "redis://localhost:6379" },
     "fluxer": {
       "id": "your-fluxer-oauth2-app-id",
       "secret": "your-fluxer-oauth2-client-secret",
       "redirectUri": "https://your-backend.com/auth/fluxer"
     }
   }
   ```

2. Create a Fluxer OAuth2 application at Settings > application.

3. For HTTPS support, configure SSL in `config.json`:
   ```json
   "ssl": {
     "private": "/etc/letsencrypt/live/your.domain/privkey.pem",
     "cert": "/etc/letsencrypt/live/your.domain/fullchain.pem",
     "useSSL": true,
     "httpPort": 80
   }
   ```

### Configuration Reference

Key configuration options in `config.json`:

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `token` | string | — | **Required.** Fluxer bot token |
| `prefix` | string | `%` | Default command prefix |
| `embedColor` | string | `0xe9196c` | Hex color for embed messages |
| `owners` | string[] | `[]` | User IDs with owner privileges |
| `playerAFKTimeout` | number | `60000` | Inactivity timeout in ms before bot leaves |
| `customStatsFooter` | string | — | Custom text shown in the `%stats` embed footer |
| `webPort` | number | `80` | Port for the web dashboard |
| `helpCatalog` | bool | `true` | Enable categorized help command |
| `helpPagination` | bool | `true` | Enable paginated help output |
| `mysql` | object | — | **Required.** MySQL connection settings |
| `nodelink` | object | — | NodeLink connection (`host`, `port`, `password`, `requestTimeout`) |
| `spotify` | object | — | Spotify API credentials (`clientId`, `clientSecret`) |
| `geniusToken` | string | — | *(Deprecated, unused)* Previously for lyrics; lyrics are now fetched via NodeLink |
| `lastfm` | object | — | Last.fm integration (`apiKey`, `apiSecret`, `scrobbleThreshold`, `scrobbleMinMs`) |
| `dashboard` | object | — | Dashboard config: `enabled`, `redis`, `fluxer` (OAuth2) |
| `dashboardUrl` | string | — | URL the dashboard is accessible from |
| `sessionSecret` | string | — | Secret for Express.js session middleware |
| `logging` | object | — | Per-category log toggle (`enabled` + 12 sub-categories, see config example) |
| `timers` | object | — | Timing values for inactivity, recovery, rejoin, etc. (14 sub-keys) |
| `cache` | object | — | Guild and member cache (`guilds.enabled`, `guilds.max`, `members.enabled`, `members.max`) |
| `radio` | array | `[]` | Custom radio station definitions |
| `ssl` | object | — | SSL certificate paths (`private`, `cert`), `useSSL`, `httpPort` |
| `presenceInterval` | number | — | Interval in ms for rotating bot presence status |
| `presenceContents` | string[] | `[]` | Presence status messages to cycle through |
| `fluxer.js` | object | — | Fluxer.js REST options (`timeout`, `retries`) |
| `fluxer-api` | object | — | Fluxer API endpoint configuration |

---

## Project Architecture

```
fluxer/
├── index.mjs                    # Entry point — Remix class, boot sequence, error handling
├── config_example.json          # Configuration template
├── package.json
├── commands/                    # Command modules (one file per command)
│   ├── play.mjs                 # Play a track or playlist
│   ├── player.mjs               # Interactive emoji control panel with live progress
│   ├── settings.mjs             # Per-guild settings management (prefix, 247, volume, etc.)
│   ├── lyrics.mjs               # Synced lyrics from NodeLink
│   ├── filter.mjs               # Audio filter controls
│   ├── radio.mjs                # Radio station management
│   ├── debug.mjs                # Voice connection debugger (owner only, paginated)
│   ├── stats.mjs                # Bot stats with live player count
│   ├── lastfm.mjs               # Last.fm account linking, scrobbling, and profile
│   └── ...                      # All other commands
├── src/
│   ├── CommandHandler.mjs       # Command loader, prefix manager, registry
│   ├── MessageHandler.mjs       # Message parsing, embed builder, pagination, help
│   ├── PlayerManager.mjs        # Spawns and manages per-channel Player instances
│   ├── Player.mjs               # Core player — queue, playback, filters, events
│   ├── MoonlinkManager.mjs      # Moonlink.js (Lavalink) node session manager
│   ├── Settings.mjs             # RemoteSettingsManager + ServerSettings export
│   ├── GatewayHandler.mjs       # Raw WS events, voice-state tracking, presence rotation
│   ├── RecoveryManager.mjs      # Session persistence, crash recovery, 24/7 auto-join
│   ├── LastFmManager.mjs        # Last.fm API client — auth, scrobbling, user data
│   ├── Utils.mjs                # Shared utilities
│   ├── worker.mjs               # Background task worker
│   ├── probe.mjs                # FFprobe wrapper for audio stream info
│   ├── constants/
│   │   ├── Logger.mjs           # Structured logger with per-category control
│   │   ├── Locale.mjs           # i18n translation engine
│   │   ├── Helpers247.mjs       # 24/7 mode helper utilities
│   │   ├── providers.mjs        # Audio source provider definitions
│   │   └── audio/
│   │       ├── StreamMerger.mjs # Audio stream merging utilities
│   │       └── Tuna.mjs         # Audio filter/effect processing
│   └── dashboard/
│       ├── Dashboard.mjs        # Web dashboard server (Express + WebSocket)
│       ├── DatabaseManager.mjs  # Dashboard database query manager
│       └── RedisHandler.mjs     # Redis session and pub/sub handler
├── settings/
│   ├── Settings.mjs             # Abstract SettingsManager base class
│   ├── migrate.mjs              # Legacy-to-remote settings migration script
│   ├── runnables.mjs            # Runnable task definitions
│   └── README.md                # Settings system documentation
└── storage/
    ├── defaults.json            # Default per-guild settings template
    ├── modules.json             # Plugin module registry
    ├── stats.json               # Runtime statistics
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
| `npm run commands` | `node index.mjs usage` | Generate command usage documentation |
| `npm run defaultsSync` | `node index.mjs sreload` | Sync default settings to all guilds |
| `npm run migrate` | `node settings/migrate.mjs` | Run the legacy settings migration |

---

## Credits & License

**Development:**
- [ShadowLp174](https://github.com/ShadowLp174) — Lead developer
- [NoLogicAlan](https://github.com/NoLogicAlan) — Lead developer
- [Fantic](https://github.com/fanticwastaken) — Community Manager

**Powered by:**
- [`@fluxerjs/core`](https://github.com/fluxerjs/core) — Fluxer API client
- [`revoice.js`](https://www.npmjs.com/package/revoice.js) — LiveKit voice connection and MediaPlayer
- [`@fluxerjs/voice`](https://github.com/fluxerjs/voice) — Native voice channel integration
- [`moonlink.js`](https://github.com/ShadowLp174/moonlink.js) — Lavalink proxy
- [`NodeLink`](https://github.com/PerformanC/NodeLink) — Audio node manager

<p align="center">
  &copy; 2026 Remix. Code licensed under the <a href="LICENSE">MIT License</a>.<br>
  <em>The Remix name, logo, and branding are proprietary and may not be reused.</em>
</p>
