import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";
import { Utils } from "../src/Utils.mjs";
import { PROVIDER_CHOICES } from "../src/constants/providers.mjs";

const EMOJI_REMOVE_TIMEOUT = 60_000;

export const command = new CommandBuilder()
  .setName("lastfm")
  .setDescription("Link your Last.fm account, toggle scrobbling, or view your profile.", "commands.lastfm")
  .setCategory("util")
  .addAliases("lf", "lfm")
  .addChoiceOption(o =>
    o.setName("action")
      .setDescription("The action to perform: link, unlink, np, profile, loved, top, recent, playlists, play, scrobble, leaderboard", "options.lastfm.action")
      .addChoices("link", "confirm", "unlink", "np", "profile", "loved", "top", "recent", "playlists", "play", "scrobble", "leaderboard", "lb", "love", "unlove", "artists")
      .setRequired(false)
  )
  .addTextOption(o =>
    o.setName("token")
      .setDescription("The auth token from Last.fm (used with 'confirm' action)")
      .setRequired(false)
  );

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

const SIMPLE_CATEGORIES = ["loved", "top", "recent", "albums"];

function buildLastFmTrackMeta(track) {
  return {
    source: "lastfm",
    artist: track.artist,
    name: track.name,
    url: track.url ?? "",
  };
}

async function resolveLastFmTrack(player, track, resolveProvider = "yt") {
  const data = await player.workerJob("generalQuery", {
    query: track.query,
    provider: resolveProvider,
    trackMeta: buildLastFmTrackMeta(track),
  });

  if (!data || data.type === "error") return null;
  if (data.type === "video") return [data.data];
  if (data.type === "list") return data.data ?? [];
  return null;
}

/**
 * Resolve a Last.fm category (loved/top/recent/playlist) into playable tracks.
 * Shared between `%lastfm play <cat>` and `%play lastfm:<cat>`.
 *
 * @param {object} ctx     - The command `this` context (has .lastfm, .getPlayer, .handler, .t)
 * @param {object} msg     - The message object
 * @param {string} category - "loved", "top", "recent", or "playlist"
 * @param {object} [options]
 * @param {string} [options.period]           - Period for top tracks
 * @param {number} [options.limit]            - Max tracks
 * @param {string|number} [options.playlistId] - Playlist number or URL (for category="playlist")
 * @param {string} [options.resolveProvider]  - Provider to search on when resolving tracks (e.g. "td" for Tidal, "sp" for Spotify). Default: "yt"
 * @returns {Promise<void>}
 */
export async function playLastFmCategory(ctx, msg, userId, category, options = {}) {
  const lastfm = ctx.lastfm;
  const prefix = ctx.handler?.getPrefix?.(msg.message?.guildId) ?? "%";
  const resolveProvider = options.resolveProvider || "yt";

  if (!lastfm || !lastfm.enabled) return msg.reply(notConfigured(msg));

  const validCategories = [...SIMPLE_CATEGORIES, "playlist"];
  if (!validCategories.includes(category)) {
    return msg.reply({
      embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(
        `❌ Unknown category \`${category}\`. Use \`loved\`, \`top\`, \`recent\`, \`albums\`, or \`playlist\`.`
      )]
    });
  }

  if (category === "playlist" && !options.playlistId) {
    return msg.reply({
      embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(
        `❌ Specify a playlist number. Use \`${prefix}lastfm playlists\` to see your playlists, then \`${prefix}lastfm play playlist <number>\`.`
      )]
    });
  }

  const user = await lastfm.getUser(userId);
  if (!user) return msg.reply(notLinked(prefix));

  const p = await ctx.getPlayer(msg, true, true, true);
  if (!p) return;

  const categoryEmoji = { loved: "❤️", top: "📊", recent: "🕐", playlist: "📋", albums: "💿" }[category];
  const categoryLabel = { loved: "Loved", top: "Top", recent: "Recent", playlist: "Playlist", albums: "Top Albums" }[category];

  const resolveLabel = resolveProvider !== "yt" ? ` via ${resolveProvider.toUpperCase()}` : "";

  let statusMsg;
  try {
    statusMsg = await msg.reply({
      embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(
        `${categoryEmoji} Fetching your ${categoryLabel} tracks from Last.fm${resolveLabel}...`
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

  let added = 0;
  let failed = 0;

  if (statusMsg) {
    statusMsg.edit({
      embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(
        `${categoryEmoji} Loading **${result.tracks.length}** ${categoryLabel.toLowerCase()} tracks from **${result.username}**${resolveLabel}...`
      )]
    }).catch(() => {});
  }

  for (const track of result.tracks) {
    try {
      const resolvedTracks = await resolveLastFmTrack(p, track, resolveProvider);
      if (!resolvedTracks?.length) {
        failed++;
        continue;
      }

      p.addManyToQueue(resolvedTracks, false);
      added += resolvedTracks.length;

      if (!p.queue.getCurrent()) {
        p.playNext();
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
  let raw = data.get("token")?.value;
  if (!raw) {
    const content = msg.message?.content ?? "";
    const args = content.split(/\s+/);
    const playIdx = args.indexOf("play");
    if (playIdx >= 0 && args[playIdx + 1]) {
      raw = args.slice(playIdx + 1).join(" ");
    }
  }

  if (!raw) return { category: "" };

  const lower = raw.toLowerCase().trim();

  const subMatch = lower.match(/^([a-z]+):\s*(.*)$/);
  if (subMatch) {
    const maybeProvider = subMatch[1];
    const rest = subMatch[2].trim();
    if (PROVIDER_CHOICES.includes(maybeProvider)) {
      const isLastFmProvider = maybeProvider === "lf" || maybeProvider === "lastfm";

      if (!rest) {
        if (isLastFmProvider) {
          return { category: "", resolveProvider: maybeProvider, showAllCategories: true };
        }
        return { category: "top", resolveProvider: maybeProvider };
      }

      if (isLastFmProvider) {
        const playlistMatch = rest.match(/^playlist\s+(\d+)$/);
        if (playlistMatch) {
          return { category: "playlist", playlistId: playlistMatch[1], resolveProvider: maybeProvider };
        }
        if (SIMPLE_CATEGORIES.includes(rest)) {
          return { category: rest, resolveProvider: maybeProvider };
        }
      } else {
        if (rest === "top") {
          return { category: "top", resolveProvider: maybeProvider };
        }
        return { category: "", resolveProvider: maybeProvider, invalidCategory: rest };
      }
    }
  }

  if (PROVIDER_CHOICES.includes(lower)) {
    const isLastFmProvider = lower === "lf" || lower === "lastfm";
    if (isLastFmProvider) {
      return { category: "", resolveProvider: lower, showAllCategories: true };
    }
    return { category: "top", resolveProvider: lower };
  }

  const playlistMatch = lower.match(/^playlist\s+(\d+)$/);
  if (playlistMatch) {
    return { category: "playlist", playlistId: playlistMatch[1] };
  }

  if (SIMPLE_CATEGORIES.includes(lower)) {
    return { category: lower };
  }

  return { category: "" };
}

export async function run(msg, data) {
  const lastfm = this.lastfm;
  if (!lastfm || !lastfm.enabled) return msg.reply(notConfigured(msg));

  const prefix = this.handler?.getPrefix?.(msg.message?.guildId) ?? "%";
  const action = data.get("action")?.value ?? "profile";
  const userId = msg.message?.author?.id ?? msg.author?.id;

  switch (action) {
    case "link": {
      const existing = await lastfm.getUser(userId);
      if (existing) {
        return msg.reply({
          embeds: [new EmbedBuilder()
            .setColor(getGlobalColor())
            .setDescription(`✅ You already have **${existing.username}** linked! Use \`${prefix}lastfm unlink\` to disconnect, or \`${prefix}lastfm scrobble\` to toggle scrobbling.`)]
        });
      }

      let token;
      try {
        token = await lastfm.getAuthToken();
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(`❌ Failed to get auth token: ${err.message}`)]
        });
      }

      const authUrl = lastfm.getAuthUrl(token);

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

    case "confirm": {
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

    case "unlink": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(prefix));

      await lastfm.removeUser(userId);
      return msg.reply({
        embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(`✅ Last.fm account **${user.username}** has been unlinked.`)]
      });
    }

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
        .setAuthor({ name: `${statusEmoji} on Last.fm`, iconURL: track.image || undefined })
        .setDescription(`**${track.name}** by **${track.artist}**\n[Open on Last.fm](${track.url})`)
        .setFooter({ text: `Last.fm: ${user.username}` });

      return msg.reply({ embeds: [embed] });
    }

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

      lastfm.syncUserScrobbleCount(userId).catch(() => {});

      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setAuthor({ name: `Last.fm Profile: ${info.name}`, iconURL: info.image?.[2]?.["#text"] || undefined, url: info.url })
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

    case "play": {
      const parsed = parsePlayArgs(msg, data);

      if (parsed.invalidCategory) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(
            `❌ \`${parsed.resolveProvider}:${parsed.invalidCategory}\` is not valid. Non-Last.fm providers only support \`top\`.\nUse \`${prefix}lastfm play ${parsed.resolveProvider}\` or \`${prefix}lastfm play ${parsed.resolveProvider}:top\` instead.\nFor other categories, use Last.fm as the resolve provider: \`${prefix}lastfm play lf:${parsed.invalidCategory}\``
          )]
        });
      }

      if (!parsed.category) {
        const lfProviderNote = parsed.showAllCategories && parsed.resolveProvider
          ? `\n\n💡 \`${prefix}lastfm play ${parsed.resolveProvider}:<category>\` — Specify a category after the provider:`
          : "";
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
            `**With a search provider (defaults to \`top\`):**`,
            `\`${prefix}lastfm play td\` or \`${prefix}lastfm play td:top\` — Play top tracks, search on Tidal`,
            `\`${prefix}lastfm play sp\` or \`${prefix}lastfm play sp:top\` — Play top tracks, search on Spotify`,
            `\`${prefix}lastfm play dz\` or \`${prefix}lastfm play dz:top\` — Play top tracks, search on Deezer`,
            `\`${prefix}lastfm play yt\` or \`${prefix}lastfm play yt:top\` — Play top tracks, search on YouTube`,
            ``,
            `**Last.fm as resolve provider (all categories):**`,
            `\`${prefix}lastfm play lf:loved\` — Play loved tracks, search on Last.fm`,
            `\`${prefix}lastfm play lf:top\` — Play top tracks, search on Last.fm`,
            `\`${prefix}lastfm play lf:recent\` — Play recent tracks, search on Last.fm`,
            `\`${prefix}lastfm play lf:albums\` — Play top albums, search on Last.fm`,
            ``,
            `**Examples:**`,
            `\`${prefix}lastfm play loved\``,
            `\`${prefix}lastfm play td\``,
            `\`${prefix}lastfm play sp:top\``,
            `\`${prefix}lastfm play lf:loved\``,
            `\`${prefix}lastfm play playlist 1\``,
            lfProviderNote,
          ].join("\n"))]
        });
      }

      return playLastFmCategory(this, msg, userId, parsed.category, {
        playlistId: parsed.playlistId,
        resolveProvider: parsed.resolveProvider,
      });
    }

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

      return msg.reply({ embeds: [buildTrackList(user.username, "❤️ Loved Tracks", tracks, false, prefix)] });
    }

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

      return msg.reply({ embeds: [buildTrackList(user.username, "📊 Top Tracks", tracks, true, prefix)] });
    }

    case "leaderboard":
    case "lb": {
      let lb;
      try {
        lb = await lastfm.getLeaderboard(0, 10);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(`❌ Failed to fetch leaderboard: ${err.message}`)]
        });
      }

      if (!lb.entries.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(
            `🎵 No scrobbles recorded yet. Link your Last.fm account with \`${prefix}lastfm link\` and start listening!`
          )]
        });
      }

      if (lb.totalPages <= 1) {
        const embed = buildLeaderboardEmbed(lb, 0, prefix);
        return msg.reply({ embeds: [embed] });
      }

      let currentPage = 0;

      const buildPage = (pageIdx, expired = false) => {
        const footerText = expired
          ? "Controls expired"
          : `Page ${pageIdx + 1}/${lb.totalPages} • Use ◀️▶️ to navigate`;
        const embed = buildLeaderboardEmbed(lb, pageIdx, prefix);
        embed.setFooter({ text: footerText });
        return { embeds: [embed] };
      };

      const replyMsg = await msg.reply(buildPage(0));
      if (!replyMsg?.message) return;

      const navEmojis = ["◀️", "▶️", "❌"];
      for (const emoji of navEmojis) {
        await replyMsg.message.react(emoji).catch(() => {});
      }

      const clearReactions = async () => {
        try {
          await replyMsg.message.removeAllReactions();
        } catch {
          for (const emoji of navEmojis) {
            try { await replyMsg.message.removeReaction(emoji); } catch {}
          }
        }
      };

      let emojiTimeout;
      const resetTimer = () => {
        clearTimeout(emojiTimeout);
        emojiTimeout = setTimeout(async () => {
          unobserve?.();
          await clearReactions();
          await replyMsg.edit(buildPage(currentPage, true)).catch(() => {});
        }, EMOJI_REMOVE_TIMEOUT);
      };

      const unobserve = replyMsg.onReaction(navEmojis, async (e) => {
        if (e.emoji_id === "❌") {
          clearTimeout(emojiTimeout);
          unobserve?.();
          await replyMsg.message.delete().catch(() => {});
          return;
        }

        resetTimer();

        if (e.emoji_id === "◀️") {
          currentPage = currentPage > 0 ? currentPage - 1 : lb.totalPages - 1;
        } else if (e.emoji_id === "▶️") {
          currentPage = currentPage < lb.totalPages - 1 ? currentPage + 1 : 0;
        }

        try {
          lb = await lastfm.getLeaderboard(currentPage, 10);
        } catch {
          /* keep previous data */
        }

        await replyMsg.edit(buildPage(currentPage)).catch(() => {});
      });

      resetTimer();
      break;
    }

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

      return msg.reply({ embeds: [buildTrackList(user.username, "🕐 Recent Tracks", tracks, false, prefix)] });
    }

    case "artists": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(prefix));

      let artists;
      try {
        artists = await lastfm.getTopArtists(userId, "overall", 15);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(`❌ Failed to fetch top artists: ${err.message}`)]
        });
      }

      if (!artists.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(`🎤 No top artists found for **${user.username}**.`)]
        });
      }

      const lines = artists.map((a, i) => {
        const num = String(i + 1).padStart(2, " ");
        let name = a.name;
        if (name.length > 40) name = name.slice(0, 37) + "...";
        const link = a.url ? `[${name}](${a.url})` : name;
        return `\`${num}.\` ${link} — **${a.playcount}** plays`;
      });

      const desc = lines.join("\n").slice(0, 4096);

      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(getGlobalColor())
          .setTitle(`🎤 Top Artists — ${user.username}`)
          .setDescription(desc)
          .setFooter({ text: `💡 Use ${prefix}lastfm play top to play your top tracks!` })]
      });
    }

    case "love": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(prefix));

      const pLove = await this.getPlayer(msg, false, false, false);
      if (!pLove) return;
      const track = pLove.queue?.getCurrent();
      if (!track) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(`❌ Nothing is playing right now. Play a song first to love it!`)]
        });
      }

      const artist = track.lastfm?.artist ?? track.requestedArtist ?? track.artist ?? track.artists?.[0]?.name ?? "Unknown";
      const name = track.lastfm?.name ?? track.requestedTitle ?? track.title ?? track.name ?? "Unknown";

      try {
        await lastfm.loveTrack(userId, artist, name);
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(`❤️ Loved **${name}** by **${artist}** on Last.fm!`)]
        });
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(`❌ Failed to love track: ${err.message}`)]
        });
      }
    }

    case "unlove": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(prefix));

      const pUnlove = await this.getPlayer(msg, false, false, false);
      if (!pUnlove) return;
      const track = pUnlove.queue?.getCurrent();
      if (!track) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(`❌ Nothing is playing right now. Play a song first to unlove it!`)]
        });
      }

      const artist = track.lastfm?.artist ?? track.requestedArtist ?? track.artist ?? track.artists?.[0]?.name ?? "Unknown";
      const name = track.lastfm?.name ?? track.requestedTitle ?? track.title ?? track.name ?? "Unknown";

      try {
        await lastfm.unloveTrack(userId, artist, name);
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(`💔 Unloved **${name}** by **${artist}** on Last.fm.`)]
        });
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(`❌ Failed to unlove track: ${err.message}`)]
        });
      }
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
            `\`${prefix}lastfm artists\` — View your top artists`,
            `\`${prefix}lastfm recent\` — View your recent tracks`,
            `\`${prefix}lastfm playlists\` — View your Last.fm playlists`,
            `\`${prefix}lastfm leaderboard\` — Scrobble leaderboard`,
            `\`${prefix}lastfm love\` — Love the current track`,
            `\`${prefix}lastfm unlove\` — Unlove the current track`,
            ``,
            `🎶 **Play from Last.fm:**`,
            `\`${prefix}lastfm play loved\` — Play your loved tracks`,
            `\`${prefix}lastfm play top\` — Play your top tracks`,
            `\`${prefix}lastfm play recent\` — Play your recent tracks`,
            `\`${prefix}lastfm play albums\` — Play your top albums`,
            `\`${prefix}lastfm play playlist 1\` — Play a playlist`,
            ``,
            `🎧 **Play with a specific provider (defaults to \`top\`):**`,
            `\`${prefix}lastfm play sp\` or \`${prefix}lastfm play sp:top\` — Play top tracks, search on Spotify`,
            `\`${prefix}lastfm play td\` or \`${prefix}lastfm play td:top\` — Play top tracks, search on Tidal`,
            `\`${prefix}lastfm play dz\` or \`${prefix}lastfm play dz:top\` — Play top tracks, search on Deezer`,
            `\`${prefix}lastfm play yt\` or \`${prefix}lastfm play yt:top\` — Play top tracks, search on YouTube`,
            ``,
            `🎧 **Last.fm as resolve provider (all categories):**`,
            `\`${prefix}lastfm play lf:loved\` — Play loved tracks, search on Last.fm`,
            `\`${prefix}lastfm play lf:top\` — Play top tracks, search on Last.fm`,
            `\`${prefix}lastfm play lf:recent\` — Play recent tracks, search on Last.fm`,
            `\`${prefix}lastfm play lf:albums\` — Play top albums, search on Last.fm`,
            ``,
            `💡 Or use inline: \`${prefix}play lastfm:loved\` or \`${prefix}play lastfm:sp\` or \`${prefix}play lastfm:td:top\``,
          ].join("\n"))]
      });
  }
}

function buildTrackList(username, title, tracks, showPlaycount = false, prefix = "%") {
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
    .setFooter({ text: `💡 Use ${prefix}lastfm play loved to play these!` });
}

function buildLeaderboardEmbed(lb, pageIdx, prefix) {
  const MEDALS = ["🥇", "🥈", "🥉"];
  const startRank = pageIdx * lb.perPage;

  const lines = lb.entries.map((entry, i) => {
    const rank = startRank + i + 1;
    const medal = rank <= 3 ? MEDALS[rank - 1] : `  `;
    const name = entry.username || entry.userId;
    const count = Utils.formatNumber(entry.scrobbleCount);
    return `${medal} ${rank}. **${name}** — ${count} scrobbles`;
  });

  const desc = lines.join("\n").slice(0, 4096);

  return new EmbedBuilder()
    .setColor(getGlobalColor())
    .setTitle("🎵 Scrobble Leaderboard")
    .setDescription(desc)
    .setFooter({ text: `💡 View & sync your count: ${prefix}lastfm profile` });
}
