import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";
import { Utils } from "../src/Utils.mjs";

const EMOJI_REMOVE_TIMEOUT = 60_000;

export const command = new CommandBuilder()
  .setName("lastfm")
  .setDescription("Link your Last.fm account, toggle scrobbling, or view your profile.", "commands.lastfm")
  .setCategory("util")
  .addAliases("lf", "lfm")
  .addChoiceOption(o =>
    o.setName("action")
      .setDescription("The action to perform: link, unlink, np, profile, loved, top, recent, playlists, play, scrobble", "options.lastfm.action")
      .addChoices("link", "confirm", "unlink", "np", "profile", "loved", "top", "recent", "playlists", "play", "scrobble")
      .setRequired(false)
  )
  .addTextOption(o =>
    o.setName("token")
      .setDescription("The auth token from Last.fm (used with 'confirm' action)")
      .setRequired(false)
  );

// ── Helpers ────────────────────────────────────────────────────────────────────

function notConfigured(msg) {
  return {
    embeds: [new EmbedBuilder()
      .setColor("#ff0000")
      .setDescription("❌ Last.fm integration is not configured on this bot. Ask the bot owner to add a Last.fm API key to the config.")]
  };
}

function notLinked(prefix) {
  return {
    embeds: [new EmbedBuilder()
      .setColor(getGlobalColor())
      .setDescription(`❌ You don't have a Last.fm account linked. Use \`${prefix}lastfm link\` to get started.`)]
  };
}

// Valid categories that can be played (without a sub-number)
const SIMPLE_CATEGORIES = ["loved", "top", "recent", "albums"];

/**
 * Resolve a Last.fm category (loved/top/recent/playlist) into playable tracks.
 * Shared between `%lastfm play <cat>` and `%play lastfm:<cat>`.
 *
 * @param {object} ctx     - The command `this` context (has .lastfm, .getPlayer, .handler, .t)
 * @param {object} msg     - The message object
 * @param {string} userId  - Discord user ID
 * @param {string} category - "loved", "top", "recent", or "playlist"
 * @param {object} [options]
 * @param {string} [options.period]      - Period for top tracks
 * @param {number} [options.limit]       - Max tracks
 * @param {string|number} [options.playlistId] - Playlist number or URL (for category="playlist")
 * @returns {Promise<void>}
 */
export async function playLastFmCategory(ctx, msg, userId, category, options = {}) {
  const lastfm = ctx.lastfm;
  const prefix = ctx.handler?.getPrefix?.(msg.message?.guildId) ?? "%";

  if (!lastfm || !lastfm.enabled) return msg.reply(notConfigured(msg));

  // Validate category
  const validCategories = [...SIMPLE_CATEGORIES, "playlist"];
  if (!validCategories.includes(category)) {
    return msg.reply({
      embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(
        `❌ Unknown category \`${category}\`. Use \`loved\`, \`top\`, \`recent\`, \`albums\`, or \`playlist\`.`
      )]
    });
  }

  // Playlist requires an ID
  if (category === "playlist" && !options.playlistId) {
    return msg.reply({
      embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(
        `❌ Specify a playlist number. Use \`${prefix}lastfm playlists\` to see your playlists, then \`${prefix}lastfm play playlist <number>\`.`
      )]
    });
  }

  // Check if user is linked
  const user = await lastfm.getUser(userId);
  if (!user) return msg.reply(notLinked(prefix));

  // Get a player (user must be in a voice channel)
  const p = await ctx.getPlayer(msg, true, true, true);
  if (!p) return;

  // Fetch tracks from Last.fm
  const categoryEmoji = { loved: "❤️", top: "📊", recent: "🕐", playlist: "📋", albums: "💿" }[category];
  const categoryLabel = { loved: "Loved", top: "Top", recent: "Recent", playlist: "Playlist", albums: "Top Albums" }[category];

  let statusMsg;
  try {
    statusMsg = await msg.reply({
      embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(
        `${categoryEmoji} Fetching your ${categoryLabel} tracks from Last.fm...`
      )]
    });
  } catch { statusMsg = null; }

  let result;
  try {
    result = await lastfm.getTracksForPlay(userId, category, options);
  } catch (err) {
    const errMsg = err.message === "NOT_LINKED"
      ? notLinked(prefix)
      : { embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(`❌ Failed to fetch Last.fm tracks: ${err.message}`)] };
    if (statusMsg) statusMsg.edit(errMsg).catch(() => msg.reply(errMsg));
    else msg.reply(errMsg);
    return;
  }

  if (!result.tracks.length) {
    const noTracks = { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(
      `${categoryEmoji} No ${categoryLabel.toLowerCase()} tracks found for **${result.username}**.`
    )] };
    if (statusMsg) statusMsg.edit(noTracks).catch(() => msg.reply(noTracks));
    else msg.reply(noTracks);
    return;
  }

  // Play each track sequentially — first one via play(), rest added to queue
  let added = 0;
  let failed = 0;

  if (statusMsg) {
    statusMsg.edit({
      embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(
        `${categoryEmoji} Loading **${result.tracks.length}** ${categoryLabel.toLowerCase()} tracks from **${result.username}**...`
      )]
    }).catch(() => {});
  }

  // Play the first track immediately
  const firstTrack = result.tracks[0];
  try {
    const events = p.play(firstTrack.query, false, "ytm");
    await new Promise((resolve) => {
      events.on("message", () => resolve());
      events.on("error", () => { failed++; resolve(); });
      // Timeout safety
      setTimeout(resolve, 15_000);
    });
    added++;
  } catch {
    failed++;
  }

  // Queue the rest — use workerJob directly for speed (no need to wait for play messages)
  const restTracks = result.tracks.slice(1);
  for (const track of restTracks) {
    try {
      const data = await p.workerJob("generalQuery", { query: track.query, provider: "ytm" });
      if (data && data.type !== "error") {
        if (data.type === "list") {
          p.addManyToQueue(data.data, false);
          added += data.data.length;
        } else if (data.type === "video") {
          p.addToQueue(data.data, false);
          added++;
        } else {
          failed++;
        }
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
  }

  const summary = [];
  if (added > 0) summary.push(`✅ Added **${added}** track${added !== 1 ? "s" : ""} to the queue`);
  if (failed > 0) summary.push(`⚠️ ${failed} track${failed !== 1 ? "s" : ""} couldn't be found`);

  const doneEmbed = { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(
    `${categoryEmoji} **${categoryLabel} Tracks — ${result.username}**\n${summary.join(" · ")}`
  )] };

  if (statusMsg) statusMsg.edit(doneEmbed).catch(() => msg.reply(doneEmbed));
  else msg.reply(doneEmbed);
}

/**
 * Parse "playlist N" from message text after "play" keyword.
 * @returns {{ category: string, playlistId?: string|number }}
 */
function parsePlayArgs(msg, data) {
  // Try from the token option first
  let raw = data.get("token")?.value;
  if (!raw) {
    const content = msg.message?.content ?? "";
    const args = content.split(/\s+/);
    const playIdx = args.indexOf("play");
    if (playIdx >= 0 && args[playIdx + 1]) {
      // Collect everything after "play"
      raw = args.slice(playIdx + 1).join(" ");
    }
  }

  if (!raw) return { category: "" };

  const lower = raw.toLowerCase().trim();

  // "playlist 3" or "playlist 1"
  const playlistMatch = lower.match(/^playlist\s+(\d+)$/);
  if (playlistMatch) {
    return { category: "playlist", playlistId: playlistMatch[1] };
  }

  // "loved", "top", "recent"
  if (SIMPLE_CATEGORIES.includes(lower)) {
    return { category: lower };
  }

  return { category: "" };
}

// ── Run ────────────────────────────────────────────────────────────────────────

export async function run(msg, data) {
  const lastfm = this.lastfm;
  if (!lastfm || !lastfm.enabled) return msg.reply(notConfigured(msg));

  const prefix = this.handler?.getPrefix?.(msg.message?.guildId) ?? "%";
  const action = data.get("action")?.value ?? "profile";
  const userId = msg.message?.author?.id ?? msg.author?.id;

  switch (action) {
    // ── Link ────────────────────────────────────────────────────────────────
    case "link": {
      // Check if already linked
      const existing = await lastfm.getUser(userId);
      if (existing) {
        return msg.reply({
          embeds: [new EmbedBuilder()
            .setColor(getGlobalColor())
            .setDescription(`✅ You already have **${existing.username}** linked! Use \`${prefix}lastfm unlink\` to disconnect, or \`${prefix}lastfm scrobble\` to toggle scrobbling.`)]
        });
      }

      // Step 1: Get auth token
      let token;
      try {
        token = await lastfm.getAuthToken();
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(`❌ Failed to get auth token: ${err.message}`)]
        });
      }

      const authUrl = lastfm.getAuthUrl(token);

      // Send auth URL via DM so it's private
      let sent = false;
      try {
        const dm = await msg.author.createDM();
        await dm.send({
          embeds: [new EmbedBuilder()
            .setColor(getGlobalColor())
            .setTitle("🎵 Link your Last.fm account")
            .setDescription([
              `Click the link below to authorize Remix on Last.fm:`,
              ``,
              `**[Authorize on Last.fm](${authUrl})**`,
              ``,
              `After you click "Yes, allow access", come back and run:`,
              `\`${prefix}lastfm confirm ${token}\``,
              ``,
              `_This link expires in 60 minutes._`,
            ].join("\n"))
          ]
        });
        sent = true;
      } catch {
        // DM failed — send in channel with a warning
      }

      const replyEmbed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setDescription(
          sent
            ? `📧 Check your DMs for the Last.fm authorization link! After approving, run \`${prefix}lastfm confirm <token>\` here.`
            : `⚠️ I couldn't DM you. [Click here to authorize on Last.fm](${authUrl}), then run \`${prefix}lastfm confirm <token>\`.`
        );

      return msg.reply({ embeds: [replyEmbed] });
    }

    // ── Confirm (completes the auth flow) ──────────────────────────────────
    case "confirm": {
      // Get token from the option, or fall back to parsing the message
      let tokenValue = data.get("token")?.value;
      if (!tokenValue) {
        const rawContent = msg.message?.content ?? "";
        const args = rawContent.split(/\s+/);
        const confirmIdx = args.indexOf("confirm");
        tokenValue = confirmIdx >= 0 ? args[confirmIdx + 1] : null;
      }

      if (!tokenValue) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(`❌ Usage: \`${prefix}lastfm confirm <token>\` — provide the token from the auth DM.`)]
        });
      }

      let session;
      try {
        session = await lastfm.getSession(tokenValue);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(`❌ Failed to get session: ${err.message}\nMake sure you approved the token on Last.fm first.`)]
        });
      }

      await lastfm.saveUser(userId, session.key, session.name);

      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(getGlobalColor())
          .setDescription(`✅ Last.fm account **[${session.name}](https://last.fm/user/${session.name})** linked! Scrobbling is enabled by default.`)]
      });
    }

    // ── Unlink ─────────────────────────────────────────────────────────────
    case "unlink": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(prefix));

      await lastfm.removeUser(userId);
      return msg.reply({
        embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(`✅ Last.fm account **${user.username}** has been unlinked.`)]
      });
    }

    // ── Toggle scrobbling ──────────────────────────────────────────────────
    case "scrobble": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(prefix));

      const newState = !user.scrobbleEnabled;
      await lastfm.setScrobble(userId, newState);

      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(getGlobalColor())
          .setDescription(newState
            ? `✅ Scrobbling **enabled** — songs you listen to will be scrobbled to **${user.username}**.`
            : `⏸️ Scrobbling **disabled** — songs won't be scrobbled. Your account is still linked.`
          )]
      });
    }

    // ── Now playing info ───────────────────────────────────────────────────
    case "np": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(prefix));

      let recentData;
      try {
        recentData = await lastfm.getRecentTracks(userId, 1);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(`❌ Failed to fetch recent tracks: ${err.message}`)]
        });
      }

      if (!recentData.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(`🎵 No recent tracks found for **${user.username}**.`)]
        });
      }

      const track = recentData[0];
      const statusEmoji = track.now ? "🎵 Now Playing" : "🕐 Last Played";
      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setAuthor({ name: `${statusEmoji} on Last.fm`, icon_url: track.image || undefined })
        .setDescription(`**${track.name}** by **${track.artist}**\n[Open on Last.fm](${track.url})`)
        .setFooter({ text: `Last.fm: ${user.username}` });

      return msg.reply({ embeds: [embed] });
    }

    // ── Profile ────────────────────────────────────────────────────────────
    case "profile": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(prefix));

      let info;
      try {
        info = await lastfm.getUserInfo(userId);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(`❌ Failed to fetch profile: ${err.message}`)]
        });
      }

      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setAuthor({ name: `Last.fm Profile: ${info.name}`, icon_url: info.image?.[2]?.["#text"] || undefined, url: info.url })
        .setDescription([
          `🎵 **${Utils.formatNumber(info.playcount ?? 0)}** scrobbles`,
          `👤 Registered: ${info.registered?.unixtime ? new Date(+info.registered.unixtime * 1000).toLocaleDateString() : "unknown"}`,
          `🔄 Scrobbling: ${user.scrobbleEnabled ? "✅ Enabled" : "⏸️ Disabled"}`,
          ``,
          `🔗 [Open profile](${info.url})`,
        ].join("\n"))
        .setFooter({ text: `Use ${prefix}lastfm scrobble to toggle scrobbling` });

      return msg.reply({ embeds: [embed] });
    }

    // ── Playlists ──────────────────────────────────────────────────────────
    case "playlists": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(prefix));

      let playlists;
      try {
        playlists = await lastfm.getPlaylists(userId);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(`❌ Failed to fetch playlists: ${err.message}`)]
        });
      }

      if (!playlists.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(`📋 No playlists found for **${user.username}**.`)]
        });
      }

      const lines = playlists.map((pl, i) => {
        const num = String(i + 1).padStart(2, " ");
        const link = pl.url ? `[${pl.title}](${pl.url})` : pl.title;
        return `\`${num}.\` ${link} — **${pl.trackCount}** tracks`;
      });

      const desc = lines.join("\n").slice(0, 4096);

      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(getGlobalColor())
          .setTitle(`📋 Playlists — ${user.username}`)
          .setDescription(desc)
          .setFooter({ text: `💡 Use ${prefix}lastfm play playlist <number> to play one!` })]
      });
    }

    // ── Play (loved/top/recent/playlist tracks as queue) ────────────────────
    case "play": {
      const parsed = parsePlayArgs(msg, data);

      if (!parsed.category) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription([
            `❌ Usage: \`${prefix}lastfm play <category>\``,
            ``,
            `**Categories:**`,
            `\`loved\` — Play your loved tracks`,
            `\`top\` — Play your top tracks`,
            `\`recent\` — Play your recent tracks`,
            `\`albums\` — Play your top albums`,
            `\`playlist <number>\` — Play a playlist (use \`${prefix}lastfm playlists\` to list)`,
            ``,
            `**Examples:**`,
            `\`${prefix}lastfm play loved\``,
            `\`${prefix}lastfm play playlist 1\``,
          ].join("\n"))]
        });
      }

      return playLastFmCategory(this, msg, userId, parsed.category, {
        playlistId: parsed.playlistId,
      });
    }

    // ── Loved tracks ──────────────────────────────────────────────────────
    case "loved": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(prefix));

      let tracks;
      try {
        tracks = await lastfm.getLovedTracks(userId, 15);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(`❌ Failed to fetch loved tracks: ${err.message}`)]
        });
      }

      if (!tracks.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(`❤️ No loved tracks found for **${user.username}**.`)]
        });
      }

      return msg.reply({ embeds: [buildTrackList(user.username, "❤️ Loved Tracks", tracks)] });
    }

    // ── Top tracks ─────────────────────────────────────────────────────────
    case "top": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(prefix));

      let tracks;
      try {
        tracks = await lastfm.getTopTracks(userId, "overall", 15);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(`❌ Failed to fetch top tracks: ${err.message}`)]
        });
      }

      if (!tracks.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(`📊 No top tracks found for **${user.username}**.`)]
        });
      }

      return msg.reply({ embeds: [buildTrackList(user.username, "📊 Top Tracks", tracks, true)] });
    }

    // ── Recent tracks ──────────────────────────────────────────────────────
    case "recent": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(prefix));

      let tracks;
      try {
        tracks = await lastfm.getRecentTracks(userId, 15);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(`❌ Failed to fetch recent tracks: ${err.message}`)]
        });
      }

      if (!tracks.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(`🕐 No recent tracks found for **${user.username}**.`)]
        });
      }

      return msg.reply({ embeds: [buildTrackList(user.username, "🕐 Recent Tracks", tracks)] });
    }

    default:
      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(getGlobalColor())
          .setDescription([
            `🎵 **Last.fm Commands:**`,
            ``,
            `\`${prefix}lastfm link\` — Link your Last.fm account`,
            `\`${prefix}lastfm unlink\` — Disconnect your account`,
            `\`${prefix}lastfm scrobble\` — Toggle auto-scrobbling`,
            `\`${prefix}lastfm np\` — Show your Last.fm now playing`,
            `\`${prefix}lastfm profile\` — View your Last.fm profile`,
            `\`${prefix}lastfm loved\` — View your loved tracks`,
            `\`${prefix}lastfm top\` — View your top tracks`,
            `\`${prefix}lastfm recent\` — View your recent tracks`,
            `\`${prefix}lastfm playlists\` — View your Last.fm playlists`,
            ``,
            `🎶 **Play from Last.fm:**`,
            `\`${prefix}lastfm play loved\` — Play your loved tracks`,
            `\`${prefix}lastfm play top\` — Play your top tracks`,
            `\`${prefix}lastfm play recent\` — Play your recent tracks`,
            `\`${prefix}lastfm play albums\` — Play your top albums`,
            `\`${prefix}lastfm play playlist 1\` — Play a playlist`,
            ``,
            `💡 Or use inline: \`${prefix}play lastfm:loved\``,
          ].join("\n"))]
      });
  }
}

// ── Track list embed builder ──────────────────────────────────────────────────

function buildTrackList(username, title, tracks, showPlaycount = false) {
  const lines = tracks.map((t, i) => {
    const num = String(i + 1).padStart(2, " ");
    let name = t.name;
    if (name.length > 40) name = name.slice(0, 37) + "...";
    const link = t.url ? `[${name}](${t.url})` : name;
    const extra = showPlaycount && t.playcount ? ` (${t.playcount} plays)` : "";
    return `\`${num}.\` ${link} — **${t.artist}**${extra}`;
  });

  const desc = lines.join("\n").slice(0, 4096);

  return new EmbedBuilder()
    .setColor(getGlobalColor())
    .setTitle(`${title} — ${username}`)
    .setDescription(desc)
    .setFooter({ text: `💡 Use %lastfm play loved to play these!` });
}
