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
  <a href="https://fluxer.com/oauth2/authorize?client_id=1478084469635211806&scope=bot&permissions=3206208">Invite Remix</a> &middot;
  <a href="https://fluxer.gg/remix">Join Support Server</a> &middot;
  <a href="https://github.com/remix-bot/fluxer/issues">Report an Issue</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22.13.0-339933.svg" alt="Node.js">
  <img src="https://img.shields.io/badge/Voice-LiveKit%20%2B%20NodeLink-orange.svg" alt="Audio Engine">
  <img src="https://img.shields.io/badge/Database-MySQL-4479A1.svg" alt="Database">
  <img src="https://img.shields.io/badge/Languages-8%20Locales-9b59b6.svg" alt="Localization">
  <img src="https://img.shields.io/badge/Maintained%3F-Yes-green.svg" alt="Maintained">
</p>

---

## 🌟 Overview

**Remix** is a feature-rich, self-hostable music bot built specifically for [Fluxer](https://fluxer.com). Built on [`@fluxerjs/core`](https://github.com/fluxerjs/core) and [`@fluxerjs/voice`](https://github.com/fluxerjs/voice), it streams ultra-low-latency Opus audio directly to LiveKit voice channels using an optimized [NodeLink](https://github.com/PerformanC/NodeLink) backend.

We believe essential music features should never be locked behind a paywall — **every feature on Remix is 100% free and open-source.**

---

## ⚡ Highlights & Features

* 🎵 **Low-Latency Zero-Re-Encode Audio** — Direct WebM/Opus streaming pipeline published over LiveKit with instant start times and zero CPU re-encoding overhead.
* 🔎 **Universal Music Search** — Seamless search and playback across YouTube, YouTube Music, Spotify, SoundCloud, Deezer, Apple Music, Tidal, Bandcamp, Bilibili, plus direct HTTP/HTTPS and radio streams.
* 🔄 **24/7 Voice Persistence** — Keeps the bot in designated voice channels around the clock with exponential backoff recovery, boot rejoin, and state restore across restarts.
* ⏪ **Playback History & `%previous`** — Dedicated 20-track circular playback history ring buffer to step backward (`%previous`, `%undo`) without lost tracks.
* ⏸️ **Smart Auto-Pause & Mute Protection** — Automatically pauses playback when voice channels empty (auto-resuming when members return) or when server-muted by administrators.
* 🔁 **Instant Track Replay** — Restart the current song from 0:00 with `%replay` (or `%restart`) without re-fetching network streams.
* 🎛️ **Audio Filters & DSP Studio** — Real-time audio transformations: Bassboost (low/medium/hard), Nightcore, Vaporwave, 8D audio, and fine-grained `%speed` & `%pitch` tuning.
* 📊 **Loudness Normalization** — Built-in EBU R128 / ReplayGain leveling (`%normalize`) to eliminate volume jumps between quiet acoustic songs and loud EDM tracks.
* 📈 **Comprehensive Last.fm Suite** — Real-time scrobbling, loved tracks synchronization, artist crowns, server leaderboards, profile cards, and automated similar-track autoplay.
* 📑 **Massive Playlist Ingestion** — Asynchronous chunked ingestion for large Spotify and SoundCloud playlists (>100 tracks) with instant playback start on song #1.
* 🌐 **Full 8-Language Localization** — English, Arabic, Kurdish (Sorani), Turkish, German, Brazilian Portuguese, Simplified Chinese, and Traditional Chinese.
* 💾 **Personal Saved Playlists & Favorites** — Bookmark favorite tracks (`%fav`) and save custom queue snapshots (`%playlist save <name>`) stored per-user in MySQL for seamless playback across all servers.
* 📊 **Community & Personal Music Analytics** — Server leaderboards (`%top`) with custom timeframes (`24h`, `week`, `month`, `year`, `all`, `global`), Server Music Wrapped (`%wrapped`), and personal listening recap profiles (`%mywrapped` / `%top me`) backed by permanent MySQL analytics.
* 🛡️ **Hardened Security & Reliability** — Built-in SSRF protection with DNS-rebinding guards (`SafeHttp`) and automated credential redaction (`[REDACTED]`) in owner diagnostics.

---

## 🚀 Getting Started

### Invite to Your Server
1. Click here to **[Invite Remix](https://fluxer.com/oauth2/authorize?client_id=1478084469635211806&scope=bot&permissions=3206208)** to your Fluxer server.
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
| `skipto` | `jump`, `jumpto` | Skip directly to track #X in the queue | `%skipto 4` |
| `shuffle` | — | Randomize the order of queued tracks | `%shuffle` |
| `move` | `mv`, `m` | Move a song from one position to another | `%move 4 1` |
| `remove` | — | Remove a track or range from the queue | `%remove 3` / `%remove 5-8` |
| `clear` | `c` | Clear upcoming tracks or a range | `%clear` / `%clear 2 10` |
| `loop` | — | Toggle repeat mode (`song`, `queue`, or `off`) | `%loop queue` |
| `trackopt` | `to` | Configure custom start/end timestamps | `%trackopt set 0:30 3:15` |

### 💾 Personal Playlists & Favorites

| Command | Aliases | Description | Example |
| :--- | :--- | :--- | :--- |
| `fav` | `favorite`, `favorites`, `bookmark` | Save or remove playing track from personal favorites, list, or play | `%fav` / `%fav play` / `%fav list` |
| `playlist` | `pl`, `playlists` | Save active queue as a named playlist, play, list, or manage personal playlists | `%playlist save chill` / `%playlist play chill` / `%playlist list` |

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

### 🏆 Leaderboards & Community Stats

| Command | Aliases | Description | Example |
| :--- | :--- | :--- | :--- |
| `top` | `leaderboard`, `chart`, `toptracks` | Most played tracks and top artists with interactive pagination and timeframes (`24h`, `week`, `month`, `year`, `all`, `global`) | `%top` / `%top 24h` / `%top global` |
| `wrapped` | `recap`, `summary` | Server or network-wide music listening recap and personality card | `%wrapped` / `%wrapped global` |
| `mywrapped` | `myrecap`, `personalwrapped`, `me`, `djstats` | Personal listening recap, personal top 5 tracks, favorite artist, and server DJ rank | `%mywrapped` / `%top me` |

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
  "instanceUrl": null,
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

> [!NOTE]
> Set `"instanceUrl": "https://chat.example.com/api"` if connecting Remix to a self-hosted Fluxer instance instead of the official platform (include `/api` if your instance mounts REST endpoints under `/api`).

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

| Flag | Code | Language | Native Name |
| :---:| :---: | :--- | :--- |
|<img width="40" height="40" alt="image" src="https://github.com/user-attachments/assets/bcbcbdfb-8bbf-4fcf-a778-5d324ad47c9f" />| `en` | English | English (Default) |
|<img width="40" height="40" alt="image" src="https://github.com/user-attachments/assets/2e3cc42a-47e5-4d6e-9b99-c6f5534cee87" />| `ar-SA` | Arabic | العربية |
|<img width="40" height="40" alt="image" src="https://github.com/user-attachments/assets/44bc9ba4-0bee-4141-96b6-d144e4c5089a" />| `ckb` | Central Kurdish (Sorani) | کوردیی ناوەندی |
|<img width="40" height="40" alt="image" src="https://github.com/user-attachments/assets/6dddb041-52ec-4dca-ab37-22d1ef3cc78d" />| `tr` | Turkish | Türkçe |
|<img width="40" height="40" alt="image" src="https://github.com/user-attachments/assets/558a97e5-579e-4bca-8cbb-a684a5678a1a" />| `de-DE` | German | Deutsch |
|<img width="40" height="40" alt="image" src="https://github.com/user-attachments/assets/d7177647-d53c-418e-b4c1-cb16aaa77323" />| `pt-BR` | Portuguese (Brazil) | Português Brasileiro |
|<img width="40" height="40" alt="image" src="https://github.com/user-attachments/assets/53d34c41-6a4c-4f69-88e7-32a09d6f4945" />| `zh-CN` | Simplified Chinese | 简体中文 |
|<img width="40" height="40" alt="image" src="https://github.com/user-attachments/assets/4ee1d3a2-c047-442f-9710-0e43cdb2baf7" />| `zh-TW` | Traditional Chinese | 繁體中文 |

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
