import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";
import { PROVIDER_CHOICES } from "../src/constants/providers.mjs";
import { playLastFmCategory } from "./lastfm.mjs";

// Last.fm provider keywords that trigger special play logic
const LASTFM_PLAY_CATEGORIES = ["loved", "top", "recent", "albums"];

/**
 * Parse a lastfm query like "td:top", "sp:loved", "playlist 1", or just "top".
 * Returns { category, resolveProvider } where resolveProvider is the
 * search provider to use for resolving tracks (e.g. "td" for Tidal).
 */
function parseLastFmSubProvider(query) {
  const value = query.trim();
  // Non-lastfm providers only allow "top" (or bare provider defaults to "top")
  // Last.fm as resolve provider allows all categories: loved, top, recent, albums, playlist
  const subMatch = value.match(/^([a-z]+):\s*(.*)$/i);
  if (subMatch) {
    const maybeProvider = subMatch[1].toLowerCase();
    const rest = subMatch[2].trim().toLowerCase();
    if (PROVIDER_CHOICES.includes(maybeProvider)) {
      const isLastFmProvider = maybeProvider === "lf" || maybeProvider === "lastfm";

      if (!rest) {
        if (isLastFmProvider) {
          return { category: "", resolveProvider: maybeProvider };
        }
        return { category: "top", resolveProvider: maybeProvider };
      }

      if (isLastFmProvider) {
        // Last.fm as resolve provider: all categories allowed
        if (LASTFM_PLAY_CATEGORIES.includes(rest) || rest.startsWith("playlist")) {
          return { category: rest, resolveProvider: maybeProvider };
        }
      } else {
        // Non-lastfm providers: only "top" allowed
        if (rest === "top") {
          return { category: "top", resolveProvider: maybeProvider };
        }
        return { category: "", resolveProvider: maybeProvider, invalidCategory: rest };
      }
    }
  }

  // Bare provider without colon: "td", "sp", "yt" → defaults to "top"
  const lower = value.toLowerCase();
  if (PROVIDER_CHOICES.includes(lower)) {
    const isLastFmProvider = lower === "lf" || lower === "lastfm";
    if (isLastFmProvider) {
      return { category: "", resolveProvider: lower };
    }
    return { category: "top", resolveProvider: lower };
  }

  return { category: lower, resolveProvider: null };
}

function parseInlineProvider(raw) {
  const match = raw.match(/^([a-z]+):\s*(.+)$/i);
  if (!match) return { provider: null, query: raw.trim() };
  const maybeProvider = match[1].toLowerCase();
  if (PROVIDER_CHOICES.includes(maybeProvider)) {
    return { provider: maybeProvider, query: match[2].trim() };
  }
  return { provider: null, query: raw.trim() };
}

function parseLastFmTrackQuery(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return null;

  const byMatch = value.match(/^(.+?)\s+by\s+(.+)$/i);
  if (byMatch) {
    return {
      artist: byMatch[2].trim(),
      name: byMatch[1].trim(),
      source: "lastfm",
    };
  }

  const dashMatch = value.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dashMatch) {
    return {
      artist: dashMatch[1].trim(),
      name: dashMatch[2].trim(),
      source: "lastfm",
    };
  }

  return null;
}

export const command = new CommandBuilder()
    .setName("play")
    .setId("play")
    .setCategory("music")
    .setDescription(
        "Play a song or playlist from a URL or search query.\n" +
        "Supports YouTube, Spotify, SoundCloud, Deezer, Apple Music, Tidal, and more.\n" +
        "Default search: YouTube Music. Use `-p <provider>` or inline prefix e.g. `sp: blinding lights`.",
        "commands.play"
    )
    .addExamples(
        "$prefixplay take over league of legends",
        "$prefixplay sp: blinding lights",
        "$prefixplay dz: get lucky",
        "$prefixplay -p yt take over league of legends",
        "$prefixplay https://open.spotify.com/track/...",
        "$prefixplay lastfm:loved",
        "$prefixplay lastfm:td:top",
        "$prefixplay lastfm:sp",
        "$prefixplay lastfm:lf:loved",
        "$prefixp take over league of legends"
    )
    .addTextOption(option =>
        option.setName("query")
            .setDescription("A search query, URL, or provider-prefixed query like `sp: song name`.", "options.play.query")
            .setRequired(true)
    )
    .addChoiceOption(o =>
            o.setName("provider")
                .setDescription("The search provider. Default: YouTube Music. Or use inline prefix: sp:, dz:, am:, yt:, sc: etc.", "options.play.provider")
                .addFlagAliases("p", "u", "use")
                .addChoices(...PROVIDER_CHOICES)
                .setDefault("yt")
        , true)
    .addAlias("p");

export async function run(message, data) {
  const rawQuery     = data.get("query").value;
  const flagProvider = data.get("provider")?.value;
  const { provider: inlineProvider, query } = parseInlineProvider(rawQuery);
  const provider = inlineProvider ?? flagProvider ?? "ytm";

  // ── Last.fm special provider: %play lastfm:loved / lastfm:top / lastfm:recent / lastfm:playlist 1 ──
  //   Also supports sub-provider syntax: %play lastfm:td:top (play Last.fm top tracks, search on Tidal)
  //   Bare provider defaults: %play lastfm:sp → top tracks on Spotify, %play lastfm:td → top tracks on Tidal
  if (provider === "lastfm" || provider === "lf") {
    const parsed = parseLastFmSubProvider(query);
    const lowerQuery = parsed.category;
    const resolveProvider = parsed.resolveProvider;

    // Invalid category used with a non-lastfm provider (e.g. "sp:loved", "td:recent")
    if (parsed.invalidCategory) {
      return message.reply({
        embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(
          `❌ \`${resolveProvider}:${parsed.invalidCategory}\` is not valid. Non-Last.fm providers only support \`top\`.\nUse \`lastfm:${resolveProvider}\` or \`lastfm:${resolveProvider}:top\` instead.\nFor other categories, use Last.fm as the resolve provider: \`lastfm:lf:${parsed.invalidCategory}\``
        )]
      });
    }

    // If lf/lastfm used as resolve provider without a category, show help
    if (!lowerQuery && resolveProvider && (resolveProvider === "lf" || resolveProvider === "lastfm")) {
      return message.reply({
        embeds: [new EmbedBuilder().setColor("#ff0000").setDescription([
          `❌ Specify a Last.fm category after \`lf:\``,
          ``,
          `**Available categories:**`,
          `\`lf:loved\` — Play your loved tracks`,
          `\`lf:top\` — Play your top tracks`,
          `\`lf:recent\` — Play your recent tracks`,
          `\`lf:albums\` — Play your top albums`,
          `\`lf:playlist 1\` — Play a playlist`,
        ].join("\n"))]
      });
    }

    // Simple categories: lastfm:loved, lastfm:top, lastfm:recent
    if (LASTFM_PLAY_CATEGORIES.includes(lowerQuery)) {
      const userId = message.message?.author?.id ?? message.author?.id;
      return playLastFmCategory(this, message, userId, lowerQuery, { resolveProvider });
    }

    // Playlist: lastfm:playlist 1 or lastfm:playlist 3
    const playlistMatch = lowerQuery.match(/^playlist\s+(\d+)$/);
    if (playlistMatch) {
      const userId = message.message?.author?.id ?? message.author?.id;
      return playLastFmCategory(this, message, userId, "playlist", {
        playlistId: playlistMatch[1],
        resolveProvider,
      });
    }
  }

  const resolvedProvider =
    provider === "lastfm" || provider === "lf"
      ? (flagProvider && flagProvider !== "lastfm" && flagProvider !== "lf" ? flagProvider : "yt")
      : provider;
  const lastfmTrackMeta =
    provider === "lastfm" || provider === "lf"
      ? parseLastFmTrackQuery(query)
      : null;

  const p = await this.getPlayer(message, true, true, true);
  if (!p) return;

  const searchEmbed = new EmbedBuilder()
    .setColor(getGlobalColor())
    .setDescription(this.t(message, "responses.play.searching"))
    ;

  let statusMsg = null;
  try {
    statusMsg = await message.reply({ embeds: [searchEmbed] });
  } catch (err) {
    // Fluxer API timed out sending the status message — continue without it
  }

  const playQuery = lastfmTrackMeta
    ? `${lastfmTrackMeta.name} ${lastfmTrackMeta.artist}`.trim()
    : query;

  const messages = p.play(playQuery, false, resolvedProvider);
  messages.on("message", d => {
    const embed = new EmbedBuilder().setColor(getGlobalColor()).setDescription(d);
    if (statusMsg) {
      statusMsg.edit({ embeds: [embed] }).catch(() => {});
    } else {
      // statusMsg failed to send earlier, fall back to a fresh reply
      message.reply({ embeds: [embed] }).catch(() => {});
    }
  });
}
