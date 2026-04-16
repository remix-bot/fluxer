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
  <a href="https://web.fluxer.app/oauth2/authorize?client_id=1478084469635211806&scope=bot&permissions=3206208">Invite to Server</a> · 
  <a href="https://fluxer.gg/Remix">Report a Bug</a> · 
  <a href="https://fluxer.gg/Remix">Request a Feature</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License">
  <img src="https://img.shields.io/badge/Fluxer-Bot-7289DA.svg" alt="Fluxer Bot">
  <img src="https://img.shields.io/badge/Audio-revoice.js-orange.svg" alt="revoice.js">
  <img src="https://img.shields.io/badge/Maintained%3F-Yes-green.svg" alt="Maintained">
</p>

---

## 🎵 About The Project

Remix is a free and open-source music bot for Fluxer, built using [fluxerjs](https://github.com/fluxerjs/core) and powered by [revoice.js](https://github.com/ShadowLp174/revoice.js) for seamless, high-quality audio playback. We believe music features shouldn't be locked behind paywalls—**all commands on Remix are 100% free and always will be.**

## 🚀 Getting Started

Want to use Remix in your server right away?

1. **[Invite Remix](https://web.fluxer.app/oauth2/authorize?client_id=1478084469635211806&scope=bot&permissions=3206208)** to your Fluxer server.
2. Join a voice channel.
3. Use the `%help` command to see everything the bot can do, or jump straight in with `%play <song name>`.

---

## 📜 Commands

Below is a complete list of Remix's commands. The default prefix is `%`.

| Command | Description | Usage Example | Aliases |
| :--- | :--- | :--- | :--- |
| `play` | Play a song from a URL/query, or a playlist. | `%play Never Gonna Give You Up` | `p` |
| `playnext` | Play a song/playlist, adding it to the *top* of the queue. | `%playnext 'query: text'` | `pn` |
| `pause` | Pause the current playback. | `%pause` | |
| `resume` | Resume the paused playback. | `%resume` | |
| `skip` | Skip the currently playing song. | `%skip` | |
| `list` | View the upcoming queue for your voice channel. | `%list` | `queue` |
| `np` | See the name and URL of the currently playing song. | `%np` | `current`, `nowplaying` |
| `loop` | Toggle looping for the current song or the whole queue. | `%loop queue` | |
| `shuffle` | Re-orders the queue randomly. | `%shuffle` | |
| `remove` | Remove a specific song from the queue by its index number. | `%remove 3` | |
| `clear` | Remove all songs from the queue. | `%clear` | `c` |
| `volume` | Change the volume of the bot. | `%volume 50` | `v` |
| `join` | Make the bot join a specific voice channel. | `%join 123456789` | |
| `leave` | Make the bot leave your current voice channel. | `%leave` | `l` |
| `player` | Create an interactive emoji player control panel. | `%player` | |
| `search` | Display search results for a given query to choose from. | `%search 'query'` | |
| `settings`| Change or view bot settings for the current server. | `%settings set` | `s` |
| `stats` | Display bot statistics, like uptime and ping. | `%stats` | `info` |
| `thumbnail`| Get the thumbnail image of the currently playing song. | `%thumbnail` | `thumb` |
| `test` | A developer testing command. | `%test 1` | |

---

## 🛠️ Self-Hosting The Bot

If you prefer to host Remix yourself, please note: **You must make it clear that your bot is an instance of Remix.** Please change the bot's name and give credit in the bot's profile (e.g., *"Powered by [Remix](https://github.com/remix-bot/fluxer)"*).

### Prerequisites
- Node.js installed
- A MySQL Database
- A [NodeLink](https://github.com/PerformanC/NodeLink) instance

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
    - Rename `config.example.json` to `config.json`.
    - Fill out the missing values (Bot Token, DB credentials, etc.).
    - *Note: You can generate Spotify credentials [here](https://developer.spotify.com/).*
    - Configure your NodeLink instance inside the `config.json` file:
      ```json
      "nodelink": {
        "host": "localhost",
        "port": 3000,
        "password": "youshallnotpass"
      }
      ```

4. **Setup the Database:** *(See instructions below)*

5. **Start the bot:**
   ```bash
   node index.mjs
   ```

### 🗄️ Database Setup

Remix requires a MySQL database to function properly.

1. Create a dedicated database for Remix to prevent data collisions with other apps.
2. Enter your MySQL connection details into `config.json`.
3. Run the following SQL query to create the necessary tables:

   ```sql
   CREATE TABLE `settings` (
     `id` varchar(70) NOT NULL,
     `data` json NOT NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3;
   ```
*(Note: If you used the legacy settings system and want to migrate your data, please check the README inside the `settings` folder).*

---

## 💬 Contact & Support

If you have any questions, need help setting up, or just want to hang out with other Remix users, join our official Fluxer server:

👉 **[Join the Remix Support Server](https://fluxer.gg/Remix)**

---

<p align="center">
  &copy; 2026 Remix. Code licensed under the <a href="LICENSE">MIT License</a>.<br>
  <em>The Remix name, logo, and branding are proprietary and may not be reused.</em>
</p>