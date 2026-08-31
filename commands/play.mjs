/**
 * @module commands/play
 * @description Play a song or playlist from a URL or search query.
 * Supports YouTube, Spotify, SoundCloud, Deezer, Apple Music, Tidal, and Last.fm integration.
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";
import { logger } from "../src/constants/Logger.mjs";
import { PROVIDER_CHOICES, parseInlineProvider } from "../src/constants/providers.mjs";
import { playLastFmCategory } from "./lastfm.mjs";
import { parseLastFmUrl, isLastFmUrl } from "../src/LastFmManager.mjs";
import { ERROR_COLOR } from "../src/constants/UI.mjs";

const LASTFM_PLAY_CATEGORIES = ["loved", "top", "recent", "albums"];

/**
 * Parse a Last.fm sub-provider string (e.g. "lf:loved", "sp:top").
 * @private
 * @param {string} query - The raw query string to parse.
 * @returns {{ category: string, resolveProvider: string|null, invalidCategory?: string }} Parsed components.
 */
function parseLastFmSubProvider(query) {
  const value = query.trim();
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
        if (LASTFM_PLAY_CATEGORIES.includes(rest) || rest.startsWith("playlist")) {
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


/**
 * Parse a Last.fm track query into artist and name components.
 * Supports "title by artist" and "artist - title" formats.
 * @private
 * @param {string} raw - The raw query string.
 * @returns {{ artist: string, name: string, source: string }|null} Parsed track info or null.
 */
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

/** @type {RegExp} Known music-service URL patterns that should go through Lavalink search. */
const KNOWN_SERVICE_HOSTS = /(?:youtu(?:be\.com|\.be)|youtube\.com|music\.youtube\.com|open\.spotify\.com|soundcloud\.com|deezer\.com|music\.apple\.com|tidal\.com|bandcamp\.com|last\.fm|mixcloud\.com|tunein\.com)/i;

/** Audio file extensions for formats the bridge handles natively (no Lavalink needed). */
const NATIVE_AUDIO_EXTENSIONS = /\.(?:opus|webm|ogg)(?:\?|$)/i;

/** Audio file extensions that indicate any direct audio URL (broader set). */
const AUDIO_EXTENSIONS = /\.(?:mp3|m4a|aac|ogg|opus|flac|wav|wma|webm|stream|m3u8|pls)(?:\?|$)/i;

/** Common stream/radio content-type paths or patterns. */
const STREAM_PATH_HINTS = /\/(?:stream|live|radio|audio|playlist|play|listen|mp3|aac|ogg)/i;

/**
 * Check if a URL points to an audio format the FluxerAudioBridge handles natively
 * (Opus, WebM, OGG) — no Lavalink resolution needed, goes straight to playExternal.
 * @param {string} str
 * @returns {boolean}
 */
function isNativeAudioUrl(str) {
  if (!str || typeof str !== "string") return false;
  const trimmed = str.trim();
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) return false;
  try {
    const url = new URL(trimmed);
    if (KNOWN_SERVICE_HOSTS.test(url.hostname)) return false;
    return NATIVE_AUDIO_EXTENSIONS.test(url.pathname);
  } catch (_) {}
  return false;
}

/**
 * Check if a URL looks like a direct audio stream/file rather than a music-service page.
 * Excludes known service URLs (YouTube, Spotify, etc.) which should use Lavalink search.
 *
 * @param {string} str - The raw query string.
 * @returns {boolean} True if this looks like a direct audio URL.
 */
function isDirectAudioUrl(str) {
  if (!str || typeof str !== "string") return false;
  const trimmed = str.trim();
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) return false;
  try {
    const url = new URL(trimmed);
    if (KNOWN_SERVICE_HOSTS.test(url.hostname)) return false;
    if (AUDIO_EXTENSIONS.test(url.pathname)) return true;
    if (STREAM_PATH_HINTS.test(url.pathname) && !url.pathname.includes(".html") && !url.pathname.includes(".php")) {
      return true;
    }
    if (/:80\d{0,2}\//.test(trimmed) || /:8\d{3}\//.test(trimmed)) return true;
  } catch (_) {}
  return false;
}


/**
 * @type {CommandBuilder}
 * @description Command definition for the play command.
 */
export const command = new CommandBuilder()
    .setName("play")
    .setId("play")
    .setCategory("music")
    .setDescription(
        "Play a song or playlist from a URL or search query.\n" +
        "Supports YouTube, Spotify, SoundCloud, Deezer, Apple Music, Tidal, and more.\n" +
        "Also accepts direct audio URLs (MP3, OGG, AAC, radio streams).\n" +
        "Default search: YouTube Music. Use `-p <provider>` or inline prefix e.g. `sp: blinding lights`.",
        "commands.play"
    )
    .addExamples(
        "$prefixplay take over league of legends",
        "$prefixplay sp: blinding lights",
        "$prefixplay dz: get lucky",
        "$prefixplay -p yt take over league of legends",
        "$prefixplay https://open.spotify.com/track/...",
        "$prefixplay https://example.com/stream.mp3",
        "$prefixplay https://radio.example.com:8000/live",
        "$prefixplay https://www.last.fm/music/Drake/_/Make+Them+Cry",
        "$prefixplay lastfm:loved",
        "$prefixplay lastfm:soda pop",
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
                .setDefault("ytm")
        , true)
    .addAlias("p");

/**
 * Run handler for the play command.
 * Handles URL detection, Last.fm integration, provider selection, and track searching.
 *
 * @param {object} message - The command message wrapper.
 * @param {object} data - Parsed command data containing query and provider options.
 * @returns {Promise<void>}
 */
export async function run(message, data) {
  const rawQuery     = data.get("query").value;
  const flagProvider = data.get("provider")?.value;
  const { provider: inlineProvider, query } = parseInlineProvider(rawQuery);
  const provider = inlineProvider ?? flagProvider ?? "ytm";

  if (isNativeAudioUrl(rawQuery)) {
    const p = await this.getPlayer(message, true, true, true);
    if (!p) return;

    const statusEmbed = new EmbedBuilder()
      .setColor(getGlobalColor())
      .setDescription(":mag_right: Loading direct stream...");
    let statusMsg = null;
    try { statusMsg = await message.reply({ embeds: [statusEmbed] }); } catch(e) { logger.warn("[Play] Error:", e?.message); }

    const messages = p.playExternal(rawQuery);
    messages.on("message", d => {
      const embed = new EmbedBuilder().setColor(getGlobalColor()).setDescription(d);
      if (statusMsg) { statusMsg.edit({ embeds: [embed] }).catch(() => {}); }
      else { message.reply({ embeds: [embed] }).catch(() => {}); }
    });
    return;
  }

  if (isDirectAudioUrl(rawQuery)) {
    const p = await this.getPlayer(message, true, true, true);
    if (!p) return;

    const statusEmbed = new EmbedBuilder()
      .setColor(getGlobalColor())
      .setDescription(":mag_right: Resolving stream via Lavalink...");
    let statusMsg = null;
    try { statusMsg = await message.reply({ embeds: [statusEmbed] }); } catch(e) { logger.warn("[Play] Error:", e?.message); }

    const messages = p.playExternal(rawQuery, null, null, false, "stream");
    messages.on("message", d => {
      const embed = new EmbedBuilder().setColor(getGlobalColor()).setDescription(d);
      if (statusMsg) { statusMsg.edit({ embeds: [embed] }).catch(() => {}); }
      else { message.reply({ embeds: [embed] }).catch(() => {}); }
    });
    return;
  }

  if (isLastFmUrl(rawQuery) || isLastFmUrl(query)) {
    const lfUrl = isLastFmUrl(rawQuery) ? rawQuery : query;
    const parsed = parseLastFmUrl(lfUrl);

    if (parsed && parsed.track) {
      const lastfmTrackMeta = {
        artist: parsed.artist,
        name: parsed.track,
        source: "lastfm",
        url: parsed.url,
      };

      const p = await this.getPlayer(message, true, true, true);
      if (!p) return;

      const searchEmbed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setDescription(this.t(message, "responses.play.searching"));
      let statusMsg = null;
      try { statusMsg = await message.reply({ embeds: [searchEmbed] }); } catch(e) { logger.warn("[Play] Error:", e?.message); }

      const playQuery = `${parsed.track} ${parsed.artist}`.trim();
      const messages = p.play(playQuery, false, provider === "lastfm" || provider === "lf" ? "yt" : provider, lastfmTrackMeta);
      messages.on("message", d => {
        const embed = new EmbedBuilder().setColor(getGlobalColor()).setDescription(d);
        if (statusMsg) { statusMsg.edit({ embeds: [embed] }).catch(() => {}); }
        else { message.reply({ embeds: [embed] }).catch(() => {}); }
      });
      return;
    }

    if (parsed && !parsed.track) {
      const p = await this.getPlayer(message, true, true, true);
      if (!p) return;

      const searchEmbed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setDescription(this.t(message, "responses.play.searching"));
      let statusMsg = null;
      try { statusMsg = await message.reply({ embeds: [searchEmbed] }); } catch(e) { logger.warn("[Play] Error:", e?.message); }

      const playQuery = parsed.artist;
      const messages = p.play(playQuery, false, provider === "lastfm" || provider === "lf" ? "yt" : provider);
      messages.on("message", d => {
        const embed = new EmbedBuilder().setColor(getGlobalColor()).setDescription(d);
        if (statusMsg) { statusMsg.edit({ embeds: [embed] }).catch(() => {}); }
        else { message.reply({ embeds: [embed] }).catch(() => {}); }
      });
      return;
    }
  }

  if (provider === "lastfm" || provider === "lf") {
    const parsed = parseLastFmSubProvider(query);
    const lowerQuery = parsed.category;
    const resolveProvider = parsed.resolveProvider;

    if (parsed.invalidCategory) {
      return message.reply({
        embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(
          `❌ \`${resolveProvider}:${parsed.invalidCategory}\` is not valid. Non-Last.fm providers only support \`top\`.\nUse \`lastfm:${resolveProvider}\` or \`lastfm:${resolveProvider}:top\` instead.\nFor other categories, use Last.fm as the resolve provider: \`lastfm:lf:${parsed.invalidCategory}\``
        )]
      });
    }

    if (!lowerQuery && resolveProvider && (resolveProvider === "lf" || resolveProvider === "lastfm")) {
      return message.reply({
        embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription([
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

    if (LASTFM_PLAY_CATEGORIES.includes(lowerQuery)) {
      const userId = message.message?.author?.id ?? message.author?.id;
      return playLastFmCategory(this, message, userId, lowerQuery, { resolveProvider });
    }

    const playlistMatch = lowerQuery.match(/^playlist\s+(\d+)$/);
    if (playlistMatch) {
      const userId = message.message?.author?.id ?? message.author?.id;
      return playLastFmCategory(this, message, userId, "playlist", {
        playlistId: playlistMatch[1],
        resolveProvider,
      });
    }

    if (lowerQuery && !LASTFM_PLAY_CATEGORIES.includes(lowerQuery) && !lowerQuery.startsWith("playlist")) {
      const lastfm = this.lastfm;
      if (lastfm && lastfm.enabled) {
        const trackMeta = parseLastFmTrackQuery(query);
        let searchResult;

        if (trackMeta) {
          searchResult = { artist: trackMeta.artist, name: trackMeta.name, url: "" };
        } else {
          let statusMsg = null;
          try {
            statusMsg = await message.reply({
              embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(
                `🔍 Searching Last.fm for **${query}**...`
              )]
            });
          } catch(e) { logger.warn("[Play] Error:", e?.message); }

          try {
            searchResult = await lastfm.searchTrack(query);
          } catch(e) { logger.warn("[Play] Error:", e?.message); }

          if (!searchResult) {
            const noResult = { embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(
              `❌ No results found on Last.fm for **${query}**.`
            )] };
            if (statusMsg) statusMsg.edit(noResult).catch(() => message.reply(noResult));
            else message.reply(noResult);
            return;
          }
        }

        const lastfmTrackMeta = {
          artist: searchResult.artist,
          name: searchResult.name,
          source: "lastfm",
          url: searchResult.url ?? "",
        };

        const playProvider = resolveProvider && resolveProvider !== "lf" && resolveProvider !== "lastfm"
          ? resolveProvider
          : "yt";

        const p = await this.getPlayer(message, true, true, true);
        if (!p) return;

        const playQuery = `${searchResult.name} ${searchResult.artist}`.trim();
        const messages = p.play(playQuery, false, playProvider, lastfmTrackMeta);
        messages.on("message", d => {
          const embed = new EmbedBuilder().setColor(getGlobalColor()).setDescription(d);
          if (statusMsg) { statusMsg.edit({ embeds: [embed] }).catch(() => {}); }
          else { message.reply({ embeds: [embed] }).catch(() => {}); }
        });
        return;
      }
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
    logger.warn("[Play] Error:", err?.message);
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
      message.reply({ embeds: [embed] }).catch(() => {});
    }
  });
}
