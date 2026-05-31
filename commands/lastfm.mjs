import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";
import { Utils } from "../src/Utils.mjs";
import { PROVIDER_CHOICES } from "../src/constants/providers.mjs";

const EMOJI_REMOVE_TIMEOUT = 60_000;

const VALID_PERIODS = ["7day", "1month", "3month", "6month", "12month", "overall"];

export const command = new CommandBuilder()
  .setName("lastfm")
  .setDescription("Link your Last.fm account, toggle scrobbling, or view your profile.", "commands.lastfm")
  .setCategory("util")
  .addAliases("lf", "lfm")
  .addChoiceOption(o =>
    o.setName("action")
      .setDescription("The action to perform: link, unlink, np, profile, loved, top, recent, playlists, play, scrobble, leaderboard, whoknows, artistinfo, albuminfo, trackinfo, topalbums, toptags, tag, compare, cover, refreshmembers, affinity, crowns, whoknowstrack, whoknowsalbum, artisttags, albumtags, tracktags, friends, weekly, trending, geo, tagalbums, artisttracks, search", "options.lastfm.action")
      .addChoices(
        "link", "confirm", "unlink", "np", "profile", "loved", "top", "recent",
        "playlists", "play", "scrobble", "leaderboard", "lb", "love", "unlove",
        "artists", "whoknows", "wk", "artistinfo", "ai", "albuminfo", "ali",
        "trackinfo", "ti", "topalbums", "toptags", "tags", "tag", "compare",
        "fmc", "cover", "art", "refreshmembers", "rm", "affinity", "af",
        "crowns", "cr", "whoknowstrack", "wkt", "whoknowsalbum", "wka",
        "artisttags", "at", "albumtags", "alt", "tracktags", "tt",
        "friends", "fr", "weekly", "wc", "trending", "tr",
        "geo", "g", "tagalbums", "ta", "artisttracks", "atr",
        "search", "s"
      )
      .setRequired(false)
  )
  .addUserOption(o =>
    o.setName("user")
      .setDescription("Another user (for compare/profile). Use: -user @mention or -u @mention")
      .setRequired(false)
      .addFlagAliases("u"),
    true
  )
  .addTextOption(o =>
    o.setName("token")
      .setDescription("The auth token from Last.fm (used with 'confirm' action), or a search query / period")
      .setRequired(false)
  );

function notConfigured(ctx, msg) {
  return {
    embeds: [new EmbedBuilder()
      .setColor("#ff0000")
      .setDescription(ctx.t(msg, "responses.lastfm.notConfigured"))]
  };
}

function notLinked(ctx, msg, prefix) {
  return {
    embeds: [new EmbedBuilder()
      .setColor(getGlobalColor())
      .setDescription(ctx.t(msg, "responses.lastfm.notLinked", { prefix }))]
  };
}

const SIMPLE_CATEGORIES = ["loved", "top", "recent", "albums", "artists"];

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
 * Extract current track info from the player for Last.fm lookups.
 * @param {object} player
 * @returns {{ artist: string|null, name: string|null, album: string|null, track: object|null } | null}
 */
function extractCurrentTrack(player) {
  const track = player?.queue?.getCurrent();
  if (!track) return null;
  const artist = track.lastfm?.artist ?? track.requestedArtist ?? track.artist ?? track.artists?.[0]?.name ?? track.author?.name ?? null;
  const name = track.lastfm?.name ?? track.requestedTitle ?? track.title ?? track.name ?? null;
  const album = track.album ?? track.lastfm?.album ?? null;
  return { artist, name, album, track };
}

/**
 * Get all human member IDs from a guild for whoknows lookups.
 * @param {object} guild
 * @returns {Promise<Array<string>>}
 */
async function getGuildLinkedUsers(guild) {
  const memberIds = [];
  try {
    const members = guild?.members;
    if (members) {
      const iter = typeof members.values === "function" ? members.values() : Object.values(members);
      for (const m of iter) {
        const userId = m.user?.id ?? m.id;
        if (userId && !m.user?.bot) memberIds.push(String(userId));
      }
    }
  } catch {}
  return memberIds;
}

/**
 * Parse a period string from token option or message content.
 * @param {object} data
 * @param {object} msg
 * @returns {string} A valid period string
 */
function extractPeriod(data, msg) {
  let raw = data.get("token")?.value;
  if (!raw) {
    const content = msg.message?.content ?? "";
    const args = content.split(/\s+/);
    const last = args[args.length - 1];
    if (last && VALID_PERIODS.includes(last.toLowerCase())) raw = last;
  }
  if (raw && VALID_PERIODS.includes(raw.toLowerCase().trim())) {
    return raw.toLowerCase().trim();
  }
  return "overall";
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
  const prefix = ctx.handler.getPrefix(msg.message?.guildId);
  const resolveProvider = options.resolveProvider || "yt";

  if (!lastfm || !lastfm.enabled) return msg.reply(notConfigured(ctx, msg));

  const validCategories = [...SIMPLE_CATEGORIES, "playlist"];
  if (!validCategories.includes(category)) {
    return msg.reply({
      embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(
        `❌ Unknown category \`${category}\`. Use \`loved\`, \`top\`, \`recent\`, \`albums\`, \`artists\`, or \`playlist\`.`
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
  if (!user) return msg.reply(notLinked(ctx, msg, prefix));

  const p = await ctx.getPlayer(msg, true, true, true);
  if (!p) return;

  const categoryEmoji = { loved: "❤️", top: "📊", recent: "🕐", playlist: "📋", albums: "💿", artists: "🎤" }[category];
  const categoryLabel = { loved: "Loved", top: "Top", recent: "Recent", playlist: "Playlist", albums: "Top Albums", artists: "Top Artists" }[category];

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
      ? notLinked(ctx, msg, prefix)
      : { embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(ctx.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))] };
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
  if (!lastfm || !lastfm.enabled) return msg.reply(notConfigured(this, msg));

  const prefix = this.handler.getPrefix(msg.message?.guildId);
  const action = data.get("action")?.value ?? "profile";
  const userId = msg.message?.author?.id ?? msg.author?.id;
  const targetUserId = data.get("user")?.value ?? null;

  switch (action) {
    case "link": {
      const existing = await lastfm.getUser(userId);
      if (existing) {
        return msg.reply({
          embeds: [new EmbedBuilder()
            .setColor(getGlobalColor())
            .setDescription(this.t(msg, "responses.lastfm.alreadyLinked", { username: existing.username, prefix }))]
        });
      }

      let token;
      try {
        token = await lastfm.getAuthToken();
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.tokenFailed", { error: err.message }))]
        });
      }

      const authUrl = lastfm.getAuthUrl(token);

      let sent = false;
      try {
        const dm = await msg.author.createDM();
        await dm.send({
          embeds: [new EmbedBuilder()
            .setColor(getGlobalColor())
            .setTitle(this.t(msg, "responses.lastfm.authLinkTitle"))
            .setDescription(this.t(msg, "responses.lastfm.authLinkBody", { url: authUrl, prefix, token }))
          ]
        });
        sent = true;
      } catch {
      }

      const replyEmbed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setDescription(
          sent
            ? this.t(msg, "responses.lastfm.authDM", { prefix })
            : this.t(msg, "responses.lastfm.authDMFailed", { url: authUrl, prefix })
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
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.confirmUsage", { prefix }))]
        });
      }

      let session;
      try {
        session = await lastfm.getSession(tokenValue);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.confirmFailed", { error: err.message }))]
        });
      }

      await lastfm.saveUser(userId, session.key, session.name);

      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(getGlobalColor())
          .setDescription(this.t(msg, "responses.lastfm.linked", { username: session.name }))]
      });
    }

    case "unlink": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      await lastfm.removeUser(userId);
      return msg.reply({
        embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.unlinked", { username: user.username }))]
      });
    }

    case "scrobble": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      const newState = !user.scrobbleEnabled;
      await lastfm.setScrobble(userId, newState);

      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(getGlobalColor())
          .setDescription(newState
            ? this.t(msg, "responses.lastfm.scrobbleEnabled", { username: user.username })
            : this.t(msg, "responses.lastfm.scrobbleDisabled")
          )]
      });
    }

    case "np": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      let recentData;
      try {
        recentData = await lastfm.getRecentTracks(userId, 1);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!recentData.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.noRecent", { username: user.username }))]
        });
      }

      const track = recentData[0];
      const statusEmoji = track.now ? this.t(msg, "responses.lastfm.nowPlaying") : this.t(msg, "responses.lastfm.lastPlayed");
      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setAuthor({ name: statusEmoji, iconURL: track.image || undefined })
        .setDescription(this.t(msg, "responses.lastfm.npTrackInfo", { name: track.name, artist: track.artist, url: track.url }))
        .setFooter({ text: this.t(msg, "responses.lastfm.npFooter", { username: user.username }) });

      return msg.reply({ embeds: [embed] });
    }

    case "profile": {
      const profileUserId = targetUserId || userId;
      const user = await lastfm.getUser(profileUserId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      let info;
      try {
        info = await lastfm.getUserInfo(profileUserId);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      lastfm.syncUserScrobbleCount(profileUserId).catch(() => {});

      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setAuthor({ name: this.t(msg, "responses.lastfm.profileTitle", { username: info.name }), iconURL: info.image?.[2]?.["#text"] || undefined, url: info.url })
        .setDescription([
          this.t(msg, "responses.lastfm.profileScrobbles", { playcount: Utils.formatNumber(info.playcount ?? 0) }),
          this.t(msg, "responses.lastfm.profileRegistered", { date: info.registered?.unixtime ? new Date(+info.registered.unixtime * 1000).toLocaleDateString() : "unknown" }),
          this.t(msg, "responses.lastfm.profileScrobbleStatus", { status: user.scrobbleEnabled ? this.t(msg, "responses.lastfm.profileScrobbleEnabled") : this.t(msg, "responses.lastfm.profileScrobbleDisabled") }),
          ``,
          this.t(msg, "responses.lastfm.profileLink", { url: info.url }),
        ].join("\n"))
        .setFooter({ text: this.t(msg, "responses.lastfm.profileScrobbleFooter", { prefix }) });

      return msg.reply({ embeds: [embed] });
    }

    case "playlists": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      let playlists;
      try {
        playlists = await lastfm.getPlaylists(userId);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!playlists.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.noPlaylists", { username: user.username }))]
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
          .setTitle(this.t(msg, "responses.lastfm.playlistsTitle", { username: user.username }))
          .setDescription(desc)
          .setFooter({ text: this.t(msg, "responses.lastfm.playlistsFooter", { prefix }) })]
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
            `\`artists\` — Play your top artists' tracks`,
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
            `\`${prefix}lastfm play lf:artists\` — Play top artists, search on Last.fm`,
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
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      let tracks;
      try {
        tracks = await lastfm.getLovedTracks(userId, 15);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!tracks.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.noLoved", { username: user.username }))]
        });
      }

      return msg.reply({ embeds: [buildTrackList(user.username, this.t(msg, "responses.lastfm.lovedTitle", { username: user.username }), tracks, false, prefix)] });
    }

    case "top": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      const period = extractPeriod(data, msg);

      let tracks;
      try {
        tracks = await lastfm.getTopTracks(userId, period, 15);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!tracks.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.noTop", { username: user.username }))]
        });
      }

      const periodLabel = period !== "overall" ? ` (${period})` : "";
      return msg.reply({ embeds: [buildTrackList(user.username, this.t(msg, "responses.lastfm.topTitle", { username: user.username }) + periodLabel, tracks, true, prefix)] });
    }

    case "leaderboard":
    case "lb": {
      let lb;
      try {
        lb = await lastfm.getLeaderboard(0, 10);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!lb.entries.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(
            this.t(msg, "responses.lastfm.leaderboardEmpty", { prefix })
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
          ? this.t(msg, "responses.lastfm.leaderboardControlsExpired")
          : this.t(msg, "responses.lastfm.leaderboardPageFooter", { current: pageIdx + 1, total: lb.totalPages });
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
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      let tracks;
      try {
        tracks = await lastfm.getRecentTracks(userId, 15);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!tracks.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.noRecent", { username: user.username }))]
        });
      }

      return msg.reply({ embeds: [buildTrackList(user.username, this.t(msg, "responses.lastfm.recentTitle", { username: user.username }), tracks, false, prefix)] });
    }

    case "artists": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      const period = extractPeriod(data, msg);

      let artists;
      try {
        artists = await lastfm.getTopArtists(userId, period, 15);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!artists.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.noArtists", { username: user.username }))]
        });
      }

      const periodLabel = period !== "overall" ? ` (${period})` : "";
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
          .setTitle(this.t(msg, "responses.lastfm.artistsTitle", { username: user.username }) + periodLabel)
          .setDescription(desc)
          .setFooter({ text: this.t(msg, "responses.lastfm.artistsFooter", { prefix }) })]
      });
    }

    case "love": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      const pLove = await this.getPlayer(msg, false, false, false);
      if (!pLove) return;
      const track = pLove.queue?.getCurrent();
      if (!track) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.nothingPlayingLove"))]
        });
      }

      const artist = track.lastfm?.artist ?? track.requestedArtist ?? track.artist ?? track.artists?.[0]?.name ?? track.author?.name ?? "Unknown";
      const name = track.lastfm?.name ?? track.requestedTitle ?? track.title ?? track.name ?? "Unknown";

      try {
        await lastfm.loveTrack(userId, artist, name);
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.lovedTrack", { name, artist }))]
        });
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.loveFailed", { error: err.message }))]
        });
      }
    }

    case "unlove": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      const pUnlove = await this.getPlayer(msg, false, false, false);
      if (!pUnlove) return;
      const track = pUnlove.queue?.getCurrent();
      if (!track) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.nothingPlayingUnlove"))]
        });
      }

      const artist = track.lastfm?.artist ?? track.requestedArtist ?? track.artist ?? track.artists?.[0]?.name ?? track.author?.name ?? "Unknown";
      const name = track.lastfm?.name ?? track.requestedTitle ?? track.title ?? track.name ?? "Unknown";

      try {
        await lastfm.unloveTrack(userId, artist, name);
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.unlovedTrack", { name, artist }))]
        });
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.unloveFailed", { error: err.message }))]
        });
      }
    }

    case "whoknows":
    case "wk": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      let artistName = null;
      const tokenTextWk = data.get("token")?.value;
      if (tokenTextWk) {
        artistName = tokenTextWk.trim();
      } else {
        const pWk = await this.getPlayer(msg, false, false, false);
        const current = extractCurrentTrack(pWk);
        if (current?.artist) {
          artistName = current.artist;
        }
      }

      if (!artistName) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.nothingPlayingNoArtist"))]
        });
      }

      let statusMsg;
      try {
        statusMsg = await msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(
            this.t(msg, "responses.lastfm.whoknowsChecking", { artist: artistName })
          )]
        });
      } catch { statusMsg = null; }

      const guild = msg.message?.guild ?? msg.message?.member?.guild;
      const memberIds = await getGuildLinkedUsers(guild);

      let listeners;
      try {
        listeners = await lastfm.getWhoKnows(artistName, memberIds);
      } catch (err) {
        const errEmbed = { embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))] };
        if (statusMsg) statusMsg.edit(errEmbed).catch(() => msg.reply(errEmbed));
        else msg.reply(errEmbed);
        return;
      }

      if (!listeners.length) {
        const noData = { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(
          this.t(msg, "responses.lastfm.whoknowsNobody", { artist: artistName })
        )] };
        if (statusMsg) statusMsg.edit(noData).catch(() => msg.reply(noData));
        else msg.reply(noData);
        return;
      }

      const MEDALS = ["🥇", "🥈", "🥉"];
      const totalPlays = listeners.reduce((sum, l) => sum + l.playcount, 0);

      const lines = listeners.map((l, i) => {
        const medal = i < 3 ? MEDALS[i] : `  `;
        return `${medal} ${i + 1}. **${l.username}** — **${Utils.formatNumber(l.playcount)}** plays`;
      });

      const desc = lines.join("\n").slice(0, 4096);

      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle(this.t(msg, "responses.lastfm.whoknowsTitle", { artist: artistName }))
        .setDescription(desc)
        .setFooter({ text: this.t(msg, "responses.lastfm.whoknowsFooter", { count: listeners.length, plural: listeners.length !== 1 ? "s" : "", totalPlays: Utils.formatNumber(totalPlays) }) });

      const replyPayload = { embeds: [embed] };
      if (statusMsg) statusMsg.edit(replyPayload).catch(() => msg.reply(replyPayload));
      else msg.reply(replyPayload);
      return;
    }

    case "artistinfo":
    case "ai": {
      const user = await lastfm.getUser(userId);

      let artistName = null;

      const pAi = await this.getPlayer(msg, false, false, false);
      const current = extractCurrentTrack(pAi);
      if (current?.artist) {
        artistName = current.artist;
      }

      const tokenText = data.get("token")?.value;
      if (tokenText) {
        artistName = tokenText.trim();
      }

      if (!artistName) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(
            this.t(msg, "responses.lastfm.noArtistSpecified")
          )]
        });
      }

      let info;
      try {
        info = await lastfm.getArtistInfo(artistName, userId);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!info) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.artistNotFound", { artist: artistName }))]
        });
      }

      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle(`🎤 ${info.name}`)
        .setURL(info.url || undefined)
        .setThumbnail(info.image || undefined);

      const fields = [];
      fields.push({ name: "Listeners", value: Utils.formatNumber(info.stats?.listeners ?? 0), inline: true });
      fields.push({ name: "Global Plays", value: Utils.formatNumber(info.stats?.playcount ?? 0), inline: true });

      if (info.userplaycount != null && user) {
        fields.push({ name: "Your Plays", value: Utils.formatNumber(info.userplaycount), inline: true });
      }

      if (info.tags?.length) {
        const tagStr = info.tags.slice(0, 8).map(t => {
          const tagLower = String(t).toLowerCase().replace(/\s+/g, "+");
          return `[${t}](https://www.last.fm/tag/${encodeURIComponent(tagLower)})`;
        }).join(" · ");
        fields.push({ name: "Tags", value: tagStr, inline: false });
      }

      if (info.similar?.length) {
        const simStr = info.similar.slice(0, 5).map(s => {
          return s.url ? `[${s.name}](${s.url})` : s.name;
        }).join(" · ");
        fields.push({ name: "Similar Artists", value: simStr, inline: false });
      }

      embed.addFields(...fields);

      if (info.bio) {
        const cleanBio = info.bio.replace(/<[^>]*>/g, "").trim();
        if (cleanBio.length > 0) {
          const truncated = cleanBio.length > 300 ? cleanBio.slice(0, 297) + "..." : cleanBio;
          embed.setDescription(truncated);
        }
      }

      embed.setFooter({ text: user ? `Last.fm: ${user.username}` : "Last.fm" });

      return msg.reply({ embeds: [embed] });
    }

    case "albuminfo":
    case "ali": {
      const user = await lastfm.getUser(userId);

      let artistName = null;
      let albumName = null;

      const pAli = await this.getPlayer(msg, false, false, false);
      const current = extractCurrentTrack(pAli);
      if (current?.album && current?.artist) {
        artistName = current.artist;
        albumName = current.album;
      }

      const tokenText = data.get("token")?.value;
      if (tokenText) {
        const dashMatch = tokenText.match(/^(.+?)\s*[-–—]\s*(.+)$/);
        if (dashMatch) {
          artistName = dashMatch[1].trim();
          albumName = dashMatch[2].trim();
        } else {
          albumName = tokenText.trim();
        }
      }

      if (!albumName) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(
            this.t(msg, "responses.lastfm.noAlbumSpecified")
          )]
        });
      }

      let info;
      try {
        info = await lastfm.getAlbumInfo(artistName || "", albumName, userId);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!info) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.albumNotFound", { album: albumName }))]
        });
      }

      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle(`💿 ${info.name}`)
        .setURL(info.url || undefined)
        .setThumbnail(info.image || undefined);

      const fields = [];

      if (info.artist) {
        fields.push({ name: "Artist", value: info.artist, inline: true });
      }

      if (info.userplaycount != null && user) {
        fields.push({ name: "Your Plays", value: Utils.formatNumber(info.userplaycount), inline: true });
      }

      if (info.tags?.length) {
        const tagStr = info.tags.slice(0, 8).map(t => {
          const tagLower = String(t).toLowerCase().replace(/\s+/g, "+");
          return `[${t}](https://www.last.fm/tag/${encodeURIComponent(tagLower)})`;
        }).join(" · ");
        fields.push({ name: "Tags", value: tagStr, inline: false });
      }

      if (info.tracks?.length) {
        const trackLines = info.tracks.slice(0, 15).map((t, i) => {
          const num = String(i + 1).padStart(2, " ");
          const dur = t.duration > 0 ? ` (${formatDuration(t.duration)})` : "";
          const link = t.url ? `[${t.name}](${t.url})` : t.name;
          return `\`${num}.\` ${link}${dur}`;
        });
        fields.push({ name: "Tracklist", value: trackLines.join("\n").slice(0, 1024), inline: false });
      }

      embed.addFields(...fields);
      embed.setFooter({ text: user ? `Last.fm: ${user.username}` : "Last.fm" });

      return msg.reply({ embeds: [embed] });
    }

    case "trackinfo":
    case "ti": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      let artistName = null;
      let trackName = null;

      const pTi = await this.getPlayer(msg, false, false, false);
      const current = extractCurrentTrack(pTi);
      if (current?.artist && current?.name) {
        artistName = current.artist;
        trackName = current.name;
      }

      const tokenText = data.get("token")?.value;
      if (tokenText) {
        const dashMatch = tokenText.match(/^(.+?)\s*[-–—]\s*(.+)$/);
        if (dashMatch) {
          artistName = dashMatch[1].trim();
          trackName = dashMatch[2].trim();
        } else {
          try {
            const searchResult = await lastfm.searchTrack(tokenText.trim());
            if (searchResult) {
              artistName = searchResult.artist;
              trackName = searchResult.name;
            }
          } catch {}
        }
      }

      if (!artistName || !trackName) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(
            this.t(msg, "responses.lastfm.noTrackSpecified")
          )]
        });
      }

      let info;
      try {
        info = await lastfm.getTrackInfo(artistName, trackName, userId);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!info) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.trackNotFound", { track: trackName, artist: artistName }))]
        });
      }

      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle(`🎵 ${info.name}`)
        .setURL(info.url || undefined);

      if (info.album?.image?.[2]?.["#text"] || info.album?.image?.[1]?.["#text"]) {
        embed.setThumbnail(info.album?.image?.[2]?.["#text"] || info.album?.image?.[1]?.["#text"]);
      }

      const fields = [];

      if (info.artist?.name || info.artist?.["#text"]) {
        fields.push({ name: "Artist", value: String(info.artist?.name ?? info.artist?.["#text"] ?? "Unknown"), inline: true });
      }

      if (info.album?.title) {
        fields.push({ name: "Album", value: info.album.title, inline: true });
      }

      if (info.listeners) {
        fields.push({ name: "Listeners", value: Utils.formatNumber(Number(info.listeners)), inline: true });
      }

      if (info.playcount) {
        fields.push({ name: "Global Plays", value: Utils.formatNumber(Number(info.playcount)), inline: true });
      }

      if (info.userplaycount) {
        fields.push({ name: "Your Plays", value: Utils.formatNumber(Number(info.userplaycount)), inline: true });
      }

      const userLoved = info.userloved === "1" || info.userloved === 1 || info.userloved === true;
      fields.push({ name: "Loved", value: userLoved ? "❤️ Yes" : "🖤 No", inline: true });

      if (info.toptags?.tag?.length) {
        const tagStr = info.toptags.tag.slice(0, 8).map(t => {
          const tagName = t.name ?? t;
          const tagLower = String(tagName).toLowerCase().replace(/\s+/g, "+");
          return `[${tagName}](https://www.last.fm/tag/${encodeURIComponent(tagLower)})`;
        }).join(" · ");
        fields.push({ name: "Tags", value: tagStr, inline: false });
      }

      embed.addFields(...fields);

      if (info.wiki?.summary) {
        const cleanSummary = info.wiki.summary.replace(/<[^>]*>/g, "").trim();
        if (cleanSummary.length > 0) {
          const truncated = cleanSummary.length > 200 ? cleanSummary.slice(0, 197) + "..." : cleanSummary;
          embed.setDescription(truncated);
        }
      }

      let similarTracks = [];
      try {
        similarTracks = await lastfm.getSimilarTracks(artistName, trackName, 5);
      } catch {}

      if (similarTracks.length) {
        const simStr = similarTracks.map(t => {
          const matchPct = Math.round(t.match * 100);
          const link = t.url ? `[${t.name}](${t.url})` : t.name;
          return `${link} by **${t.artist}** (${matchPct}%)`;
        }).join("\n");
        embed.addFields({ name: "Similar Tracks", value: simStr.slice(0, 1024), inline: false });
      }

      embed.setFooter({ text: `Last.fm: ${user.username}` });

      return msg.reply({ embeds: [embed] });
    }

    case "topalbums": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      const period = extractPeriod(data, msg);

      let albums;
      try {
        albums = await lastfm.getTopAlbums(userId, period, 15);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!albums.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.noTopAlbums", { username: user.username }))]
        });
      }

      const periodLabel = period !== "overall" ? ` (${period})` : "";

      const lines = albums.map((a, i) => {
        const num = String(i + 1).padStart(2, " ");
        let albumTitle = a.name;
        if (albumTitle.length > 30) albumTitle = albumTitle.slice(0, 27) + "...";
        const link = a.url ? `[${albumTitle}](${a.url})` : albumTitle;
        return `\`${num}.\` ${link} — **${a.artist}** (**${a.playcount}** plays)`;
      });

      const desc = lines.join("\n").slice(0, 4096);

      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle(this.t(msg, "responses.lastfm.topAlbumsTitle", { period: periodLabel, username: user.username }))
        .setDescription(desc);

      if (albums[0]?.image) {
        embed.setThumbnail(albums[0].image);
      }

      embed.setFooter({ text: this.t(msg, "responses.lastfm.topAlbumsFooter", { prefix }) });

      return msg.reply({ embeds: [embed] });
    }

    case "toptags":
    case "tags": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      let tags;
      try {
        tags = await lastfm.getUserTopTags(userId, 20);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!tags.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.noTopTags", { username: user.username }))]
        });
      }

      const lines = tags.map((t, i) => {
        const num = String(i + 1).padStart(2, " ");
        const link = t.url ? `[${t.name}](${t.url})` : t.name;
        return `\`${num}.\` ${link} — **${t.count}**`;
      });

      const desc = lines.join("\n").slice(0, 4096);

      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(getGlobalColor())
          .setTitle(this.t(msg, "responses.lastfm.topTagsTitle", { username: user.username }))
          .setDescription(desc)
          .setFooter({ text: this.t(msg, "responses.lastfm.topTagsFooter", { prefix }) })]
      });
    }

    case "tag": {
      const tagName = data.get("token")?.value;
      if (!tagName) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(
            this.t(msg, "responses.lastfm.tagProvideName", { prefix })
          )]
        });
      }

      let tagInfo;
      let topTracks;
      let topArtists;

      try {
        [tagInfo, topTracks, topArtists] = await Promise.all([
          lastfm.getTagInfo(tagName),
          lastfm.getTagTopTracks(tagName, 5),
          lastfm.getTagTopArtists(tagName, 5),
        ]);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!tagInfo) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.tagNotFound", { tag: tagName }))]
        });
      }

      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle(`🏷️ ${tagInfo.name}`)
        .setURL(tagInfo.url || undefined);

      const fields = [];
      fields.push({ name: "Reach", value: Utils.formatNumber(tagInfo.reach), inline: true });
      fields.push({ name: "Total Taggings", value: Utils.formatNumber(tagInfo.count), inline: true });

      if (topArtists.length) {
        const artistStr = topArtists.map((a, i) => {
          const link = a.url ? `[${a.name}](${a.url})` : a.name;
          return `${i + 1}. ${link} (**${Utils.formatNumber(a.playcount)}** plays)`;
        }).join("\n");
        fields.push({ name: "Top Artists", value: artistStr.slice(0, 1024), inline: false });
      }

      if (topTracks.length) {
        const trackStr = topTracks.map((t, i) => {
          const link = t.url ? `[${t.name}](${t.url})` : t.name;
          return `${i + 1}. ${link} by **${t.artist}**`;
        }).join("\n");
        fields.push({ name: "Top Tracks", value: trackStr.slice(0, 1024), inline: false });
      }

      embed.addFields(...fields);

      if (tagInfo.summary) {
        const cleanSummary = tagInfo.summary.replace(/<[^>]*>/g, "").trim();
        if (cleanSummary.length > 0) {
          const truncated = cleanSummary.length > 300 ? cleanSummary.slice(0, 297) + "..." : cleanSummary;
          embed.setDescription(truncated);
        }
      }

      return msg.reply({ embeds: [embed] });
    }

    case "compare":
    case "fmc": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      if (!targetUserId) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(
            this.t(msg, "responses.lastfm.compareSpecifyUser", { prefix })
          )]
        });
      }

      const targetUser = await lastfm.getUser(targetUserId);
      if (!targetUser) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(
            this.t(msg, "responses.lastfm.compareUserNotLinked")
          )]
        });
      }

      let comparison;
      try {
        comparison = await lastfm.compareUsers(userId, targetUserId);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!comparison) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.compareFailed"))]
        });
      }

      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle(this.t(msg, "responses.lastfm.compareTitle"))
        .setDescription([
          `**${comparison.user1.username}** vs **${comparison.user2.username}**`,
          ``,
          `📊 **${comparison.matchPercentage}%** match`,
          ``,
          `👤 ${comparison.user1.username}: ${comparison.user1.totalArtists} top artists`,
          `👤 ${comparison.user2.username}: ${comparison.user2.totalArtists} top artists`,
        ].join("\n"));

      if (comparison.commonArtists?.length) {
        const commonStr = comparison.commonArtists.slice(0, 15).map((a, i) => {
          const num = String(i + 1).padStart(2, " ");
          const link = a.url ? `[${a.name}](${a.url})` : a.name;
          return `\`${num}.\` ${link} (**${a.playcount}** plays)`;
        }).join("\n");
        embed.addFields({ name: `Common Artists (${comparison.commonArtists.length})`, value: commonStr.slice(0, 1024), inline: false });
      }

      return msg.reply({ embeds: [embed] });
    }

    case "cover":
    case "art": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      const pCover = await this.getPlayer(msg, false, false, false);
      const current = extractCurrentTrack(pCover);
      if (!current || !current.name) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.coverNothingPlaying"))]
        });
      }

      const artistName = current.artist ?? "Unknown";
      const trackName = current.name;
      const albumName = current.album;

      let coverUrl = null;
      let albumTitle = albumName ?? "Unknown Album";

      if (albumName) {
        try {
          const albumInfo = await lastfm.getAlbumInfo(artistName, albumName, userId);
          if (albumInfo?.image) {
            coverUrl = albumInfo.image;
            albumTitle = `${albumInfo.name} by ${albumInfo.artist}`;
          }
        } catch {}
      }

      if (!coverUrl) {
        try {
          const trackInfo = await lastfm.getTrackInfo(artistName, trackName, userId);
          if (trackInfo?.album?.image) {
            const images = trackInfo.album.image;
            coverUrl = images?.[2]?.["#text"] || images?.[1]?.["#text"] || images?.[0]?.["#text"] || null;
            if (trackInfo.album?.title) {
              albumTitle = trackInfo.album.title;
            }
          }
        } catch {}
      }

      if (!coverUrl) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.coverNotFound", { track: trackName, artist: artistName }))]
        });
      }

      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle(this.t(msg, "responses.lastfm.coverTitle", { album: albumTitle }))
        .setImage(coverUrl)
        .setFooter({ text: this.t(msg, "responses.lastfm.coverFooter", { track: trackName, artist: artistName }) });

      return msg.reply({ embeds: [embed] });
    }

    case "refreshmembers":
    case "rm": {
      const guild = msg.message?.guild ?? msg.message?.member?.guild;
      if (!guild) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.refreshFailed"))]
        });
      }
      let count = 0;
      try {
        if (guild.members && typeof guild.members.fetch === "function") {
          const fetched = await guild.members.fetch();
          count = fetched.size;
        } else {
          const memberIds = await getGuildLinkedUsers(guild);
          count = memberIds.length;
        }
      } catch {
        const memberIds = await getGuildLinkedUsers(guild);
        count = memberIds.length;
      }
      return msg.reply({
        embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.refreshSuccess", { count: Utils.formatNumber(count) }))]
      });
    }

    case "affinity":
    case "af": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      const guild = msg.message?.guild ?? msg.message?.member?.guild;
      const memberIds = await getGuildLinkedUsers(guild);

      if (memberIds.length < 2) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.affinityNeedUsers"))]
        });
      }

      let statusMsg;
      try {
        statusMsg = await msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.affinityChecking"))]
        });
      } catch { statusMsg = null; }

      let affinityResults;
      try {
        affinityResults = await lastfm.getAffinity(memberIds, 10);
      } catch (err) {
        const errEmbed = { embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))] };
        if (statusMsg) statusMsg.edit(errEmbed).catch(() => msg.reply(errEmbed));
        else msg.reply(errEmbed);
        return;
      }

      if (!affinityResults.length) {
        const noData = { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.affinityNoCommon"))] };
        if (statusMsg) statusMsg.edit(noData).catch(() => msg.reply(noData));
        else msg.reply(noData);
        return;
      }

      const lines = affinityResults.map(r => {
        const topCommon = r.commonArtists.slice(0, 3).map(a => a.name).join(", ");
        return `**${r.users[0]}** & **${r.users[1]}** — ${r.matchCount} common artists (${topCommon}${r.commonArtists.length > 3 ? "..." : ""})`;
      });

      const desc = lines.join("\n").slice(0, 4096);

      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle(this.t(msg, "responses.lastfm.affinityTitle"))
        .setDescription(desc)
        .setFooter({ text: this.t(msg, "responses.lastfm.affinityFooter", { count: memberIds.length }) });

      const replyPayload = { embeds: [embed] };
      if (statusMsg) statusMsg.edit(replyPayload).catch(() => msg.reply(replyPayload));
      else msg.reply(replyPayload);
      return;
    }

    case "crowns":
    case "cr": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      const guild = msg.message?.guild ?? msg.message?.member?.guild;
      const memberIds = await getGuildLinkedUsers(guild);

      let statusMsg;
      try {
        statusMsg = await msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.crownsChecking"))]
        });
      } catch { statusMsg = null; }

      let crowns;
      try {
        crowns = await lastfm.getCrowns(userId, memberIds);
      } catch (err) {
        const errEmbed = { embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))] };
        if (statusMsg) statusMsg.edit(errEmbed).catch(() => msg.reply(errEmbed));
        else msg.reply(errEmbed);
        return;
      }

      if (!crowns.length) {
        const noData = { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.crownsNone"))] };
        if (statusMsg) statusMsg.edit(noData).catch(() => msg.reply(noData));
        else msg.reply(noData);
        return;
      }

      const tokenFilter = data.get("token")?.value?.toLowerCase().trim();

      let filteredCrowns = crowns;
      if (tokenFilter === "stolen") {
        filteredCrowns = crowns.filter(c => c.nextBest && c.nextBest.playcount > 0);
      } else if (tokenFilter === "recent") {
        filteredCrowns = crowns.slice(0, 10);
      }

      const lines = filteredCrowns.slice(0, 20).map(c => {
        const link = c.artistUrl ? `[${c.artist}](${c.artistUrl})` : c.artist;
        const nextStr = c.nextBest ? ` (next: **${c.nextBest.username}** with ${Utils.formatNumber(c.nextBest.playcount)})` : "";
        return `👑 ${link} — **${Utils.formatNumber(c.userPlaycount)}** plays${nextStr}`;
      });

      const desc = lines.join("\n").slice(0, 4096);

      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle(this.t(msg, "responses.lastfm.crownsTitle", { username: user.username }))
        .setDescription(desc)
        .setFooter({ text: this.t(msg, "responses.lastfm.crownsFooter", { count: filteredCrowns.length, plural: filteredCrowns.length !== 1 ? "s" : "" }) });

      if (filteredCrowns[0]?.image) {
        embed.setThumbnail(filteredCrowns[0].image);
      }

      const replyPayload = { embeds: [embed] };
      if (statusMsg) statusMsg.edit(replyPayload).catch(() => msg.reply(replyPayload));
      else msg.reply(replyPayload);
      return;
    }

    case "whoknowstrack":
    case "wkt": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      let artistName = null;
      let trackName = null;

      const pWkt = await this.getPlayer(msg, false, false, false);
      const current = extractCurrentTrack(pWkt);
      if (current?.artist && current?.name) {
        artistName = current.artist;
        trackName = current.name;
      }

      const tokenTextWkt = data.get("token")?.value;
      if (tokenTextWkt) {
        const dashMatch = tokenTextWkt.match(/^(.+?)\s*[-–—]\s*(.+)$/);
        if (dashMatch) {
          artistName = dashMatch[1].trim();
          trackName = dashMatch[2].trim();
        } else {
          try {
            const searchResult = await lastfm.searchTrack(tokenTextWkt.trim());
            if (searchResult) {
              artistName = searchResult.artist;
              trackName = searchResult.name;
            }
          } catch {}
        }
      }

      if (!artistName || !trackName) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.noTrackSpecified"))]
        });
      }

      let statusMsg;
      try {
        statusMsg = await msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.whoknowsTrackChecking", { track: trackName, artist: artistName }))]
        });
      } catch { statusMsg = null; }

      const guild = msg.message?.guild ?? msg.message?.member?.guild;
      const memberIds = await getGuildLinkedUsers(guild);

      let listeners;
      try {
        listeners = await lastfm.getWhoKnowsTrack(artistName, trackName, memberIds);
      } catch (err) {
        const errEmbed = { embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))] };
        if (statusMsg) statusMsg.edit(errEmbed).catch(() => msg.reply(errEmbed));
        else msg.reply(errEmbed);
        return;
      }

      if (!listeners.length) {
        const noData = { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.whoknowsTrackNobody", { track: trackName, artist: artistName }))] };
        if (statusMsg) statusMsg.edit(noData).catch(() => msg.reply(noData));
        else msg.reply(noData);
        return;
      }

      const MEDALS = ["🥇", "🥈", "🥉"];
      const totalPlays = listeners.reduce((sum, l) => sum + l.playcount, 0);

      const lines = listeners.map((l, i) => {
        const medal = i < 3 ? MEDALS[i] : `  `;
        return `${medal} ${i + 1}. **${l.username}** — **${Utils.formatNumber(l.playcount)}** plays`;
      });

      const desc = lines.join("\n").slice(0, 4096);

      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle(this.t(msg, "responses.lastfm.whoknowsTrackTitle", { track: trackName }))
        .setDescription(desc)
        .setFooter({ text: this.t(msg, "responses.lastfm.whoknowsTrackFooter", { count: listeners.length, plural: listeners.length !== 1 ? "s" : "", totalPlays: Utils.formatNumber(totalPlays), artist: artistName }) });

      const replyPayload = { embeds: [embed] };
      if (statusMsg) statusMsg.edit(replyPayload).catch(() => msg.reply(replyPayload));
      else msg.reply(replyPayload);
      return;
    }

    case "whoknowsalbum":
    case "wka": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      let artistName = null;
      let albumName = null;

      const pWka = await this.getPlayer(msg, false, false, false);
      const current = extractCurrentTrack(pWka);
      if (current?.album && current?.artist) {
        artistName = current.artist;
        albumName = current.album;
      }

      const tokenTextWka = data.get("token")?.value;
      if (tokenTextWka) {
        const dashMatch = tokenTextWka.match(/^(.+?)\s*[-–—]\s*(.+)$/);
        if (dashMatch) {
          artistName = dashMatch[1].trim();
          albumName = dashMatch[2].trim();
        } else {
          albumName = tokenTextWka.trim();
        }
      }

      if (!albumName) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.noAlbumSpecified"))]
        });
      }

      let statusMsg;
      try {
        statusMsg = await msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.whoknowsAlbumChecking", { album: albumName, artistClause: artistName ? ` by **${artistName}**` : "" }))]
        });
      } catch { statusMsg = null; }

      const guild = msg.message?.guild ?? msg.message?.member?.guild;
      const memberIds = await getGuildLinkedUsers(guild);

      let listeners;
      try {
        listeners = await lastfm.getWhoKnowsAlbum(artistName || "", albumName, memberIds);
      } catch (err) {
        const errEmbed = { embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))] };
        if (statusMsg) statusMsg.edit(errEmbed).catch(() => msg.reply(errEmbed));
        else msg.reply(errEmbed);
        return;
      }

      if (!listeners.length) {
        const noData = { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.whoknowsAlbumNobody", { album: albumName }))] };
        if (statusMsg) statusMsg.edit(noData).catch(() => msg.reply(noData));
        else msg.reply(noData);
        return;
      }

      const MEDALS = ["🥇", "🥈", "🥉"];
      const totalPlays = listeners.reduce((sum, l) => sum + l.playcount, 0);

      const lines = listeners.map((l, i) => {
        const medal = i < 3 ? MEDALS[i] : `  `;
        return `${medal} ${i + 1}. **${l.username}** — **${Utils.formatNumber(l.playcount)}** plays`;
      });

      const desc = lines.join("\n").slice(0, 4096);

      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle(this.t(msg, "responses.lastfm.whoknowsAlbumTitle", { album: albumName }))
        .setDescription(desc)
        .setFooter({ text: this.t(msg, "responses.lastfm.whoknowsFooter", { count: listeners.length, plural: listeners.length !== 1 ? "s" : "", totalPlays: Utils.formatNumber(totalPlays) }) });

      const replyPayload = { embeds: [embed] };
      if (statusMsg) statusMsg.edit(replyPayload).catch(() => msg.reply(replyPayload));
      else msg.reply(replyPayload);
      return;
    }

    case "artisttags":
    case "at": {
      let artistName = null;

      const pAt = await this.getPlayer(msg, false, false, false);
      const current = extractCurrentTrack(pAt);
      if (current?.artist) {
        artistName = current.artist;
      }

      const tokenTextAt = data.get("token")?.value;
      if (tokenTextAt) {
        artistName = tokenTextAt.trim();
      }

      if (!artistName) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.noArtistSpecified"))]
        });
      }

      let tags;
      try {
        tags = await lastfm.getArtistTopTags(artistName, 15);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!tags.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.lastfm.noArtistTags", { artist: artistName }))]
        });
      }

      const lines = tags.map((t, i) => {
        const num = String(i + 1).padStart(2, " ");
        const link = t.url ? `[${t.name}](${t.url})` : t.name;
        return `\`${num}.\` ${link}${t.count > 0 ? ` — **${Utils.formatNumber(t.count)}**` : ""}`;
      });

      const desc = lines.join("\n").slice(0, 4096);

      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(getGlobalColor())
          .setTitle(this.t(msg, "responses.lastfm.artistTagsTitle", { artist: artistName }))
          .setDescription(desc)]
      });
    }

    case "albumtags":
    case "alt": {
      let artistName = null;
      let albumName = null;

      const pAlt = await this.getPlayer(msg, false, false, false);
      const current = extractCurrentTrack(pAlt);
      if (current?.album && current?.artist) {
        artistName = current.artist;
        albumName = current.album;
      }

      const tokenTextAlt = data.get("token")?.value;
      if (tokenTextAlt) {
        const dashMatch = tokenTextAlt.match(/^(.+?)\s*[-–—]\s*(.+)$/);
        if (dashMatch) {
          artistName = dashMatch[1].trim();
          albumName = dashMatch[2].trim();
        } else {
          albumName = tokenTextAlt.trim();
        }
      }

      if (!albumName) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.noAlbumSpecified"))]
        });
      }

      let tags;
      try {
        tags = await lastfm.getAlbumTopTags(artistName || "", albumName, 15);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!tags.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(`🏷️ No tags found for album **${albumName}**.`)]
        });
      }

      const lines = tags.map((t, i) => {
        const num = String(i + 1).padStart(2, " ");
        const link = t.url ? `[${t.name}](${t.url})` : t.name;
        return `\`${num}.\` ${link}${t.count > 0 ? ` — **${Utils.formatNumber(t.count)}**` : ""}`;
      });

      const desc = lines.join("\n").slice(0, 4096);

      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(getGlobalColor())
          .setTitle(this.t(msg, "responses.lastfm.artistTagsTitle", { artist: albumName }))
          .setDescription(desc)]
      });
    }

    case "tracktags":
    case "tt": {
      let artistName = null;
      let trackName = null;

      const pTt = await this.getPlayer(msg, false, false, false);
      const current = extractCurrentTrack(pTt);
      if (current?.artist && current?.name) {
        artistName = current.artist;
        trackName = current.name;
      }

      const tokenTextTt = data.get("token")?.value;
      if (tokenTextTt) {
        const dashMatch = tokenTextTt.match(/^(.+?)\s*[-–—]\s*(.+)$/);
        if (dashMatch) {
          artistName = dashMatch[1].trim();
          trackName = dashMatch[2].trim();
        } else {
          try {
            const searchResult = await lastfm.searchTrack(tokenTextTt.trim());
            if (searchResult) {
              artistName = searchResult.artist;
              trackName = searchResult.name;
            }
          } catch {}
        }
      }

      if (!artistName || !trackName) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.noTrackSpecified"))]
        });
      }

      let tags;
      try {
        tags = await lastfm.getTrackTopTags(artistName, trackName, 15);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!tags.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(`🏷️ No tags found for **${trackName}** by **${artistName}**.`)]
        });
      }

      const lines = tags.map((t, i) => {
        const num = String(i + 1).padStart(2, " ");
        const link = t.url ? `[${t.name}](${t.url})` : t.name;
        return `\`${num}.\` ${link}${t.count > 0 ? ` — **${Utils.formatNumber(t.count)}**` : ""}`;
      });

      const desc = lines.join("\n").slice(0, 4096);

      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(getGlobalColor())
          .setTitle(this.t(msg, "responses.lastfm.artistTagsTitle", { artist: trackName }))
          .setDescription(desc)]
      });
    }

    case "friends":
    case "fr": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      let friends;
      try {
        friends = await lastfm.getUserFriends(userId, 20);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!friends.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(`👥 No friends found for **${user.username}**.`)]
        });
      }

      const lines = friends.map((f, i) => {
        const num = String(i + 1).padStart(2, " ");
        const link = f.url ? `[${f.name}](${f.url})` : f.name;
        const details = [];
        if (f.realname) details.push(f.realname);
        if (f.country) details.push(f.country);
        const detailStr = details.length > 0 ? ` (${details.join(", ")})` : "";
        return `\`${num}.\` ${link}${detailStr}`;
      });

      const desc = lines.join("\n").slice(0, 4096);

      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(getGlobalColor())
          .setTitle(`👥 Friends — ${user.username}`)
          .setDescription(desc)]
      });
    }

    case "weekly":
    case "wc": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      const tokenTextWc = data.get("token")?.value?.toLowerCase().trim() ?? "artists";
      let chartData;
      let chartTitle;

      try {
        if (tokenTextWc === "tracks") {
          chartData = await lastfm.getUserWeeklyTrackChart(userId);
          chartTitle = `📅 Weekly Track Chart — ${user.username}`;
        } else if (tokenTextWc === "albums") {
          chartData = await lastfm.getUserWeeklyAlbumChart(userId);
          chartTitle = `📅 Weekly Album Chart — ${user.username}`;
        } else {
          chartData = await lastfm.getUserWeeklyArtistChart(userId);
          chartTitle = `📅 Weekly Artist Chart — ${user.username}`;
        }
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!chartData.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(`📅 No weekly chart data found for **${user.username}**.`)]
        });
      }

      const lines = chartData.slice(0, 15).map((item, i) => {
        const num = String(i + 1).padStart(2, " ");
        const link = item.url ? `[${item.name}](${item.url})` : item.name;
        const artistStr = item.artist ? ` by **${item.artist}**` : "";
        return `\`${num}.\` ${link}${artistStr} — **${Utils.formatNumber(item.playcount)}** plays`;
      });

      const desc = lines.join("\n").slice(0, 4096);

      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(getGlobalColor())
          .setTitle(chartTitle)
          .setDescription(desc)
          .setFooter({ text: `💡 Use token option: artists, tracks, or albums` })]
      });
    }

    case "trending":
    case "tr": {
      const tokenTextTr = data.get("token")?.value?.toLowerCase().trim() ?? "tracks";
      let trendingData;
      let trendingTitle;

      try {
        if (tokenTextTr === "artists") {
          trendingData = await lastfm.getChartTopArtists(15);
          trendingTitle = "🔥 Trending Artists on Last.fm";
        } else {
          trendingData = await lastfm.getChartTopTracks(15);
          trendingTitle = "🔥 Trending Tracks on Last.fm";
        }
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!trendingData.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(`🔥 No trending data found.`)]
        });
      }

      const lines = trendingData.map((item, i) => {
        const num = String(i + 1).padStart(2, " ");
        const link = item.url ? `[${item.name}](${item.url})` : item.name;
        const artistStr = item.artist ? ` by **${item.artist}**` : "";
        const extra = item.listeners ? ` — ${Utils.formatNumber(item.listeners)} listeners` : item.playcount ? ` — ${Utils.formatNumber(item.playcount)} plays` : "";
        return `\`${num}.\` ${link}${artistStr}${extra}`;
      });

      const desc = lines.join("\n").slice(0, 4096);

      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(getGlobalColor())
          .setTitle(trendingTitle)
          .setDescription(desc)
          .setFooter({ text: `💡 Use token option: tracks or artists` })]
      });
    }

    case "geo":
    case "g": {
      const tokenTextG = data.get("token")?.value?.trim() ?? "";
      if (!tokenTextG) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(`❌ Provide a query like \`artists <country>\` or \`tracks <country>\`. Example: \`${prefix}lastfm geo artists united states\`.`)]
        });
      }

      const lowerToken = tokenTextG.toLowerCase();
      let type = "artists";
      let country = tokenTextG;

      if (lowerToken.startsWith("artists ")) {
        type = "artists";
        country = tokenTextG.slice(8).trim();
      } else if (lowerToken.startsWith("tracks ")) {
        type = "tracks";
        country = tokenTextG.slice(7).trim();
      }

      if (!country) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(`❌ Please specify a country name. Example: \`${prefix}lastfm geo artists united states\`.`)]
        });
      }

      let geoData;
      let geoTitle;

      try {
        if (type === "tracks") {
          geoData = await lastfm.getGeoTopTracks(country, 15);
          geoTitle = `🌍 Top Tracks in ${country}`;
        } else {
          geoData = await lastfm.getGeoTopArtists(country, 15);
          geoTitle = `🌍 Top Artists in ${country}`;
        }
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!geoData.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(`🌍 No data found for **${country}**.`)]
        });
      }

      const lines = geoData.map((item, i) => {
        const num = String(i + 1).padStart(2, " ");
        const link = item.url ? `[${item.name}](${item.url})` : item.name;
        const artistStr = item.artist ? ` by **${item.artist}**` : "";
        const extra = item.listeners ? ` — ${Utils.formatNumber(item.listeners)} listeners` : "";
        return `\`${num}.\` ${link}${artistStr}${extra}`;
      });

      const desc = lines.join("\n").slice(0, 4096);

      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(getGlobalColor())
          .setTitle(geoTitle)
          .setDescription(desc)]
      });
    }

    case "tagalbums":
    case "ta": {
      const tagName = data.get("token")?.value;
      if (!tagName) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(`❌ Provide a tag name via the token option. Example: \`${prefix}lastfm tagalbums rock\``)]
        });
      }

      let albums;
      try {
        albums = await lastfm.getTagTopAlbums(tagName.trim(), 15);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      if (!albums.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(`💿 No top albums found for tag **${tagName}**.`)]
        });
      }

      const lines = albums.map((a, i) => {
        const num = String(i + 1).padStart(2, " ");
        const link = a.url ? `[${a.name}](${a.url})` : a.name;
        return `\`${num}.\` ${link} by **${a.artist}**${a.playcount > 0 ? ` (${Utils.formatNumber(a.playcount)} plays)` : ""}`;
      });

      const desc = lines.join("\n").slice(0, 4096);

      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle(`💿 Top Albums — ${tagName}`)
        .setDescription(desc);

      if (albums[0]?.image) {
        embed.setThumbnail(albums[0].image);
      }

      return msg.reply({ embeds: [embed] });
    }

    case "artisttracks":
    case "atr": {
      const user = await lastfm.getUser(userId);
      if (!user) return msg.reply(notLinked(this, msg, prefix));

      let artistName = null;

      const pAtr = await this.getPlayer(msg, false, false, false);
      const current = extractCurrentTrack(pAtr);
      if (current?.artist) {
        artistName = current.artist;
      }

      const tokenTextAtr = data.get("token")?.value;
      if (tokenTextAtr) {
        artistName = tokenTextAtr.trim();
      }

      if (!artistName) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.noArtistSpecified"))]
        });
      }

      let recentTracks;
      try {
        recentTracks = await lastfm.getRecentTracks(userId, 200);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      const artistTracks = recentTracks.filter(t =>
        t.artist.toLowerCase() === artistName.toLowerCase()
      );

      if (!artistTracks.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(`🎵 No scrobbles found for **${artistName}** in your recent history.`)]
        });
      }

      const lines = artistTracks.slice(0, 15).map((t, i) => {
        const num = String(i + 1).padStart(2, " ");
        const link = t.url ? `[${t.name}](${t.url})` : t.name;
        const nowStr = t.now ? " 🎵" : "";
        return `\`${num}.\` ${link}${nowStr}`;
      });

      const desc = lines.join("\n").slice(0, 4096);

      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(getGlobalColor())
          .setTitle(`🎵 ${artistName} Scrobbles — ${user.username}`)
          .setDescription(desc)
          .setFooter({ text: `${artistTracks.length} scrobble${artistTracks.length !== 1 ? "s" : ""} found` })]
      });
    }

    case "search":
    case "s": {
      const query = data.get("token")?.value;
      if (!query) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(`❌ Provide a search query via the token option. Example: \`${prefix}lastfm search radiohead\``)]
        });
      }

      let artistResults, albumResults, trackResult;
      try {
        [artistResults, albumResults, trackResult] = await Promise.all([
          lastfm.searchArtist(query, 5),
          lastfm.searchAlbum(query, 5),
          lastfm.searchTrack(query),
        ]);
      } catch (err) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.lastfm.fetchFailed", { error: err.message }))]
        });
      }

      const sections = [];

      if (artistResults.length) {
        const artistLines = artistResults.map((a, i) => {
          const link = a.url ? `[${a.name}](${a.url})` : a.name;
          const listeners = a.listeners ? ` — ${Utils.formatNumber(a.listeners)} listeners` : "";
          return `${i + 1}. ${link}${listeners}`;
        });
        sections.push(`**🎤 Artists:**\n${artistLines.join("\n")}`);
      }

      if (albumResults.length) {
        const albumLines = albumResults.map((a, i) => {
          const link = a.url ? `[${a.name}](${a.url})` : a.name;
          return `${i + 1}. ${link} by **${a.artist}**`;
        });
        sections.push(`**💿 Albums:**\n${albumLines.join("\n")}`);
      }

      if (trackResult) {
        sections.push(`**🎵 Best Track Match:**\n[${trackResult.name}](${trackResult.url}) by **${trackResult.artist}**`);
      }

      if (!sections.length) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(`🔍 No results found for **${query}**.`)]
        });
      }

      const desc = sections.join("\n\n").slice(0, 4096);

      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(getGlobalColor())
          .setTitle(`🔍 Search Results for "${query}"`)
          .setDescription(desc)]
      });
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
            `\`${prefix}lastfm profile\` — View your Last.fm profile (or another user's with user option)`,
            `\`${prefix}lastfm loved\` — View your loved tracks`,
            `\`${prefix}lastfm top\` — View your top tracks (supports period)`,
            `\`${prefix}lastfm artists\` — View your top artists (supports period)`,
            `\`${prefix}lastfm recent\` — View your recent tracks`,
            `\`${prefix}lastfm playlists\` — View your Last.fm playlists`,
            `\`${prefix}lastfm leaderboard\` — Scrobble leaderboard`,
            `\`${prefix}lastfm love\` — Love the current track`,
            `\`${prefix}lastfm unlove\` — Unlove the current track`,
            ``,
            `🔍 **Info Commands:**`,
            `\`${prefix}lastfm whoknows [artist]\` — Who in the server listens to an artist`,
            `\`${prefix}lastfm whoknowstrack\` — Who knows a specific track`,
            `\`${prefix}lastfm whoknowsalbum\` — Who knows a specific album`,
            `\`${prefix}lastfm artistinfo\` — Detailed info about an artist`,
            `\`${prefix}lastfm albuminfo\` — Detailed info about an album`,
            `\`${prefix}lastfm trackinfo\` — Detailed info about a track`,
            `\`${prefix}lastfm topalbums\` — View your top albums (supports period)`,
            `\`${prefix}lastfm toptags\` — View your top tags/genres`,
            `\`${prefix}lastfm tag <name>\` — View info about a specific tag`,
            `\`${prefix}lastfm compare @user\` — Compare your taste with another user`,
            `\`${prefix}lastfm cover\` — Get album cover art for the current track`,
            ``,
            `🏷️ **Tag Commands:**`,
            `\`${prefix}lastfm artisttags\` — Top tags for an artist`,
            `\`${prefix}lastfm albumtags\` — Top tags for an album`,
            `\`${prefix}lastfm tracktags\` — Top tags for a track`,
            `\`${prefix}lastfm tagalbums <tag>\` — Top albums for a tag`,
            ``,
            `👥 **Social Commands:**`,
            `\`${prefix}lastfm affinity\` — Find users with similar taste`,
            `\`${prefix}lastfm crowns\` — View your artist crowns (#1 listener)`,
            `\`${prefix}lastfm friends\` — View your Last.fm friends`,
            `\`${prefix}lastfm refreshmembers\` — Refresh server member cache`,
            ``,
            `📊 **Charts & Discovery:**`,
            `\`${prefix}lastfm weekly [artists|tracks|albums]\` — Weekly charts`,
            `\`${prefix}lastfm trending [tracks|artists]\` — Global trending on Last.fm`,
            `\`${prefix}lastfm geo [artists|tracks] <country>\` — Top by country`,
            `\`${prefix}lastfm artisttracks\` — Your scrobbles for an artist`,
            `\`${prefix}lastfm search <query>\` — Universal search`,
            ``,
            `🎶 **Play from Last.fm:**`,
            `\`${prefix}lastfm play loved\` — Play your loved tracks`,
            `\`${prefix}lastfm play top\` — Play your top tracks`,
            `\`${prefix}lastfm play recent\` — Play your recent tracks`,
            `\`${prefix}lastfm play albums\` — Play your top albums`,
            `\`${prefix}lastfm play artists\` — Play your top artists' tracks`,
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
            `\`${prefix}lastfm play lf:artists\` — Play top artists, search on Last.fm`,
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

/**
 * Format seconds into mm:ss or h:mm:ss.
 * @param {number} seconds
 * @returns {string}
 */
function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}
