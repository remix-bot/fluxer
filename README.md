<p align="center">
  <a href="https://github.com/remix-bot">
    <img src="https://i.imgur.com/8hD1Jur.png" alt="Remix Logo" width="100" height="100">
  </a>
</p>

<h1 align="center">Remix</h1>

<p align="center">
  <strong>A modern, high-performance, and open-source music bot for Fluxer.</strong>
</p>

<p align="center">
  <a href="https://web.fluxer.app/oauth2/authorize?client_id=1478084469635211806&scope=bot&permissions=3206208">Invite Remix</a> &middot;
  <a href="https://fluxer.gg/remix">Join Support Server</a> &middot;
  <a href="https://github.com/remix-bot/fluxer/issues">Report an Issue</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22.13.0-339933.svg" alt="Node.js">
  <img src="https://img.shields.io/badge/Voice-LiveKit%20%2B%20NodeLink-orange.svg" alt="Audio Engine">
  <img src="https://img.shields.io/badge/Database-MySQL-4479A1.svg" alt="Database">
  <img src="https://img.shields.io/badge/Languages-6%20Locales-9b59b6.svg" alt="Localization">
  <img src="https://img.shields.io/badge/Maintained%3F-Yes-green.svg" alt="Maintained">
</p>

---

## 🌟 Overview

**Remix** is a feature-rich, self-hostable music bot built specifically for [Fluxer](https://fluxer.app). Built on [`@fluxerjs/core`](https://github.com/fluxerjs/core) and [`@fluxerjs/voice`](https://github.com/fluxerjs/voice), it streams ultra-low-latency Opus audio directly to LiveKit voice channels using an optimized [NodeLink](https://github.com/PerformanC/NodeLink) backend.

We believe essential music features should never be locked behind a paywall — **every feature on Remix is 100% free and open-source.**

---

## ⚡ Highlights & Features

* 🎵 **Low-Latency Zero-Re-Encode Audio** — Direct WebM/Opus streaming pipeline published over LiveKit with instant start times and zero CPU re-encoding overhead.
* 🔎 **Universal Music Search** — Seamless search and playback across YouTube, YouTube Music, Spotify, SoundCloud, Deezer, Apple Music, Tidal, Bandcamp, Bilibili, plus direct HTTP/HTTPS and radio streams.
* 🔄 **24/7 Voice Persistence** — Keeps the bot in designated voice channels around the clock with exponential backoff recovery, boot rejoin, and state restore across restarts.
* ⏪ **Playback History & `%previous`** — Dedicated 20-track circular playback history ring buffer to step backward (`%previous`, `%undo`) without lost tracks.
* 🔁 **Instant Track Replay** — Restart the current song from 0:00 with `%replay` (or `%restart`) without re-fetching network streams.
* 🎛️ **Audio Filters & DSP Studio** — Real-time audio transformations: Bassboost (low/medium/hard), Nightcore, Vaporwave, 8D audio, and fine-grained `%speed` & `%pitch` tuning.
* 📊 **Loudness Normalization** — Built-in EBU R128 / ReplayGain leveling (`%normalize`) to eliminate volume jumps between quiet acoustic songs and loud EDM tracks.
* 📈 **Comprehensive Last.fm Suite** — Real-time scrobbling, loved tracks synchronization, artist crowns, server leaderboards, profile cards, and automated similar-track autoplay.
* 📑 **Massive Playlist Ingestion** — Asynchronous chunked ingestion for large Spotify and SoundCloud playlists (>100 tracks) with instant playback start on song #1.
* 🌐 **Full 6-Language Localization** — English, Arabic, Kurdish (Sorani), Turkish, German, and Brazilian Portuguese.
* 🛡️ **Hardened Security & Reliability** — Built-in SSRF protection with DNS-rebinding guards (`SafeHttp`) and automated credential redaction (`[REDACTED]`) in owner diagnostics.

---

## 🚀 Getting Started

### Invite to Your Server
1. Click here to **[Invite Remix](https://web.fluxer.app/oauth2/authorize?client_id=1478084469635211806&scope=bot&permissions=3206208)** to your Fluxer server.
2. Join any voice channel.
3. Type `%play <song title or URL>` to start listening!

---

## 📖 Command Reference

The default prefix is `%`. Server administrators can customize the prefix at any time using `%settings set prefix <new_prefix>`.

### 🎵 Playback & Controls

| Command | Aliases | Description | Example |
| :--- | :--- | :--- | :--- |
| `play` | `p` | Play a track, search query, or playlist | `%play Blinding Lights` |
| `playnext` | `pn` | Insert a song at the very top of the queue | `%playnext Starboy` |
| `pause` | — | Pause audio playback | `%pause` |
| `resume` | — | Resume paused playback | `%resume` |
| `skip` | `s` | Skip to the next track (vote-skip in busy rooms) | `%skip` |
| `previous` | `prev`, `back`, `undo` | Play the previous song from history | `%previous` |
| `replay` | `restart` | Restart the currently playing song from 0:00 | `%replay` |
| `seek` | — | Jump to a specific timestamp in the track | `%seek 1:45` |
| `np` | `current`, `nowplaying` | Show detailed now-playing track card | `%np` |
| `volume` | `v`, `vol` | Adjust playback volume (1–200%) | `%volume 85` |
| `volumedefault` | `vd` | Set default volume for the server | `%volumedefault 75` |
| `autoplay` | `ap` | Toggle similar-track autoplay when queue ends | `%autoplay on` |
| `normalize` | `norm`, `replaygain` | Toggle dynamic loudness normalization | `%normalize on` |

### 📑 Queue Management

| Command | Aliases | Description | Example |
| :--- | :--- | :--- | :--- |
| `list` | `queue`, `q` | Display interactive paginated queue | `%list` |
| `shuffle` | — | Randomize the order of queued tracks | `%shuffle` |
| `move` | `mv`, `m` | Move a song from one position to another | `%move 4 1` |
| `remove` | — | Remove a track or range from the queue | `%remove 3` / `%remove 5-8` |
| `clear` | `c` | Clear upcoming tracks or a range | `%clear` / `%clear 2 10` |
| `loop` | — | Toggle repeat mode (`song`, `queue`, or `off`) | `%loop queue` |
| `trackopt` | `to` | Configure custom start/end timestamps | `%trackopt set 0:30 3:15` |

### 🎛️ Audio Effects & Filters

| Command | Aliases | Description | Example |
| :--- | :--- | :--- | :--- |
| `filter` | `fx`, `effect` | Interactive filter picker menu | `%filter` |
| `bassboost` | `bb`, `bass` | Apply bass boost (`low`, `medium`, `hard`, `off`) | `%bassboost medium` |
| `speed` | `rate`, `tempo` | Adjust playback speed multiplier (0.5×–2.0×) | `%speed 1.2` |
| `pitch` | `semitone`, `tune` | Adjust pitch multiplier (0.5×–2.0×) | `%pitch 1.15` |

### 📊 Last.fm Suite

| Command | Aliases | Description | Example |
| :--- | :--- | :--- | :--- |
| `lastfm` | `lf`, `lfm` | Main Last.fm hub | `%lastfm` |
| `lastfm link` | — | Link your Last.fm username | `%lastfm link your_user` |
| `lastfm love` | — | Love/unlove the currently playing track | `%lastfm love` |
| `lastfm whoknows` | `wk` | See who in the server listens to an artist | `%lastfm whoknows Queen` |
| `lastfm crowns` | — | View artist crown holders in the server | `%lastfm crowns` |
| `lastfm top` | — | View your top tracks, artists, or albums | `%lastfm top artists` |
| `lastfm lb` | — | View server-wide scrobble leaderboard | `%lastfm lb` |

### ⚙️ Server & Voice Settings

| Command | Aliases | Description | Example |
| :--- | :--- | :--- | :--- |
| `settings` | `247`, `prefix` | View or configure server preferences | `%settings get` |
| `join` | `connect` | Connect bot to your voice channel | `%join` |
| `leave` | `stop`, `disconnect` | Disconnect bot from voice | `%leave` |
| `forceleave` | `fl` | Force disconnect from any channel (Admin) | `%forceleave` |
| `radio` | `r` | Browse and play internet radio streams | `%radio list` |
| `lyrics` | `ly` | Search or display synced lyrics | `%lyrics` |
| `thumbnail` | `thumb` | View high-resolution track thumbnail | `%thumbnail` |
| `player` | — | Spawn interactive reaction controller | `%player` |

### 🛠️ Utilities & Diagnostics

| Command | Aliases | Description |
| :--- | :--- | :--- |
| `ping` | `latency` | View gateway latency and WebSocket round-trip |
| `stats` | `info`, `botinfo` | View bot uptime, RAM usage, active players, and servers |
| `invite` | `addbot` | Get bot invite link |
| `support` | `server` | Get official support community link |
| `vote` | — | View and support bot voters on FluxerList |

---

## 🐳 Self-Hosting (Docker Setup)

The recommended way to run Remix is via Docker Compose. It bundles the bot, MySQL 8.4, Redis, and NodeLink into lightweight, automated containers.

### 1. Clone & Configure
```bash
git clone https://github.com/remix-bot/fluxer.git
cd fluxer/docker
cp config_example.json config.json
cp .env.example .env
```

### 2. Edit Configuration
Open `docker/config.json` and insert your bot token:
```json
{
  "token": "YOUR_FLUXER_BOT_TOKEN",
  "prefix": "%",
  "owners": ["YOUR_USER_ID"],
  "mysql": {
    "host": "mysql",
    "port": 3306,
    "user": "remix",
    "password": "remix_pw",
    "database": "remix"
  },
  "nodelink": {
    "host": "nodelink",
    "port": 3000,
    "password": "youshallnotpass"
  }
}
```

### 3. Start the Stack
```bash
docker compose up -d
```

### 4. Monitor Live Logs
```bash
docker compose logs -f bot
```

*To stop the stack:* `docker compose down`  
*To update code and rebuild:* `docker compose up -d --build bot`

---

## 🏗️ Architecture

```
User (%play) ──► Command Handler ──► LavalinkManager (NodeLink Search)
                         │
                         ▼
                    Queue Engine (History + Lossless Navigation)
                         │
                         ▼
                 FluxerAudioBridge (In-Process Opus / WebM)
                         │
                         ▼
             LiveKit Voice Connection (@fluxerjs/voice)
```

* **Zero Re-Encode Pipeline:** Audio tracks from NodeLink stream as native WebM/Opus straight into LiveKit voice rooms.
* **In-Process Seeks:** Byte-level cluster/page seeking (`StreamPositioner`) eliminates FFmpeg subprocess requirements.
* **Safe HTTP Execution:** All direct stream URLs pass through DNS verification and private-network IP filters (`SafeHttp`) to prevent SSRF vulnerabilities.

---

## 🌍 Supported Languages

Remix automatically adapts to each server's configured locale (`%settings set locale <code>`):

| Code | Language | Native Name |
| :---: | :--- | :--- |
| `en` | English | English (Default) |
| `ar-SA` | Arabic | العربية |
| `ckb` | Kurdish (Sorani) | کوردیی ناوەندی |
| `tr` | Turkish | Türkçe |
| `de-DE` | German | Deutsch |
| `pt-BR` | Portuguese (Brazil) | Português Brasileiro |

---

## 👥 Credits & Team

* **[ShadowLp174](https://github.com/ShadowLp174)** — Lead Developer
* **[NoLogicAlan](https://github.com/NoLogicAlan)** — Lead Developer
* **[Fantic](https://github.com/fanticwastaken)** — Community Manager

**Core Libraries:**
* [`@fluxerjs/core`](https://github.com/fluxerjs/core) & [`@fluxerjs/voice`](https://github.com/fluxerjs/voice) — Fluxer API & LiveKit voice
* [`NodeLink`](https://github.com/PerformanC/NodeLink) — High-performance audio node
* [`lavalink-client`](https://www.npmjs.com/package/lavalink-client) — Audio client & search interface

---

<p align="center">
  &copy; 2026 Remix. Licensed under the <a href="LICENSE">MIT License</a>.<br>
  <em>The Remix name, logo, and branding are proprietary and may not be reused.</em>
</p>
