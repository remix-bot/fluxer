<p align="center">
    <a href="https://github.com/remix-bot">
      <img src="https://i.imgur.com/8hD1Jur.png" alt="Logo" width="80" height="80">
    </a>
    <h2 align="center">Remix</h2>
    <p align="center">
    The best high quality Fluxer music bot.
    <br>
    <a href="https://web.fluxer.app/oauth2/authorize?client_id=1478084469635211806&scope=bot&permissions=3206208">Invite to your server</a>
      ·
    <a href="https://fluxer.gg/Remix">Report bug</a>
      ·
    <a href="https://fluxer.gg/Remix">Request Feature</a>
  </p>
</p>

## About The Project

Remix is a free and open source music bot for Fluxer built on [fluxerjs](https://github.com/fluxerjs/core). All commands on Remix are free and will always be free to use.

## Commands

Below is a table of all of Remix's commands.

| Name      | Description                                                                                        | Format                      | Alias                   |
|-----------|----------------------------------------------------------------------------------------------------|-----------------------------|-------------------------|
| clear     | Remove all songs from the queue.                                                                   | %clear                      | clear, c                |
| join      | Make the bot join a specific voice channel.                                                        | %join 'Channel ID: channel' | join                    |
| leave     | Make the bot leave your current voice channel                                                      | %leave                      | leave, l                |
| list      | List the queue in your current voice channel.                                                      | %list                       | list, queue             |
| loop      | Toggle the looping of your queue/song.                                                             | %loop <queue \| song>       | loop                    |
| np        | Request the name and URL of the currently playing song.                                            | %np                         | np, current, nowplaying |
| pause     | Pause the playback in your voice channel                                                           | %pause                      | pause                   |
| play      | Play a song from URL/query or a playlist by URL.                                                   | %play 'query: text'         | play, p                 |
| player    | Create an emoji player control for your voice channel                                              | %player                     | player                  |
| playnext  | Play a song from URL/query or a playlist by URL. The result will be added to the top of the queue. | %playnext 'query: text'     | playnext, pn            |
| remove    | Remove a specific song from the queue.                                                             | %remove 'index: number'     | remove                  |
| resume    | Resume the playback in your voice channel                                                          | %resume                     | resume                  |
| search    | Display the search results for a given query                                                       | %search 'query: text'       | search                  |
| settings  | Change/Get settings in the current server.                                                         | %settings <set \| get>      | settings, s             |
| shuffle   | Re-orders the queue randomly.                                                                      | %shuffle                    | shuffle                 |
| skip      | Skip the current playing song.                                                                     | %skip                       | skip                    |
| stats     | Display stats about the bot like the uptime.                                                       | %stats                      | stats, info             |
| test      | A test command used for various purposes.                                                          | %test 'number: number'      | test                    |
| thumbnail | Request the thumbnail of the currently playing song.                                               | %thumbnail                  | thumbnail, thumb        |
| volume    | Change the current volume.                                                                         | %volume 'volume: number'    | volume, v               |

## Getting Started

Firstly, you have to [invite Remix](https://web.fluxer.app/oauth2/authorize?client_id=1478084469635211806&scope=bot&permissions=3206208). Then use the `%help` command to get a list of commands that you can use through the bot.

## Hosting The Bot

If you're self-hosting Remix, please make it clear that it is **not the main instance** (or **change the name**) but give credit by **linking to this repo** (for example, in the bot's profile - something like `This bot <is based on/is an instance of> [Remix](https://github.com/remix-bot/fluxer)` will suffice).

-   Clone this repo (`git clone https://github.com/remix-bot/fluxer.git`)
-   Install the dependencies (`npm install`)
-   Set up a `config.json` file
    - Rename the `config.example.json` file and fill out the missing values. You can generate Spotify credentials [here](https://developer.spotify.com/)
    - A MySQL database is required. For setup instructions see [DB Setup](#setup-database).
-   Set up a [NodeLink](https://github.com/PerformanC/NodeLink) instance and configure the `nodelink` section in `config.json`:
```json
    "nodelink": {
"host": "localhost",
"port": 3000,
"password": "youshallnotpass"
}
```
-   Run the bot (`node index.mjs`)

## Setup Database

1. The main thing you'll need is a MySQL database accessible to your server, either publicly or locally.
2. Create a separate database. This way none of your other data collides with Remix.
3. Enter the connection details into the respective fields in the `config.json` file.
4. Run the following SQL commands to create all the necessary tables:
```sql
    CREATE TABLE `settings` (
      `id` varchar(70) NOT NULL,
      `data` json NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3;
```
5. You're good to go! If you've used the old settings system and want to migrate your data, check the README in the `settings` folder.

## Contact

If you have any questions or would like to talk with other Remix users you can join our Fluxer server <a href="https://fluxer.gg/Remix">here</a>.

---

&copy; 2026 Remix. Code licensed under [MIT](LICENSE). The Remix name and branding are proprietary and may not be reused.
