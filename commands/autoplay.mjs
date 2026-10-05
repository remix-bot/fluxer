/**
 * @module commands/autoplay
 * @description Toggle autoplay mode — keeps the music going forever:
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/ui/index.mjs";
import { logger } from "../src/core/Logger.mjs";

/** @type {CommandBuilder} @description Command definition for the autoplay command. */
export const command = new CommandBuilder()
  .setName("autoplay")
  .setDescription("Toggle autoplay — automatically play similar tracks when the queue ends.", "commands.autoplay")
  .setCategory("music")
  .addAliases("ap");

/** How many candidate results are considered for random picking. */
const PICK_POOL = 8;
/** Tracks considered "recently played" and excluded from re-picking. */
const HISTORY_SIZE = 30;
/** Sanity bounds for candidate durations (ms) — skip hour-long mixes and jingles. */
const MIN_DURATION_MS = 45_000;
const MAX_DURATION_MS = 15 * 60_000;
/** Resolved mix candidate pools older than this are discarded. */
const MIX_POOL_TTL_MS = 5 * 60_000;
/** Max mix pools cached per player (LRU-style eviction). */
const MAX_MIX_POOLS = 4;

/** Max Last.fm tag lookups per pick (each uncached lookup is a network call). */
const MAX_TAG_CHECKS = 8;
/** Last.fm tag weights are 0-100 relative to the top tag; ignore the long tail. */
const TAG_MIN_COUNT = 30;
/** Number of genre tags kept per artist. */
const TAG_KEEP = 6;
const TAG_CACHE_MAX = 500;
const TAG_CACHE_TTL_MS = 6 * 60 * 60_000;
/** Cap on remembered autoplay-picked video IDs per player. */
const PICKED_VIDS_MAX = 100;

/** Last.fm tags that say nothing about genre (normalised form). */
const NOISE_TAGS = new Set([
  "seenlive", "favorites", "favourites", "favorite", "favourite", "love", "awesome", "beautiful",
  "malevocalists", "femalevocalists", "malevocalist", "femalevocalist", "good", "amazing", "best",
  "cool", "music", "songs", "underrated", "allsongs", "mymusic",
]);
/** Broad tags that many unrelated genres share — never enough on their own to match. */
const WEAK_TAGS = new Set([
  "pop", "rock", "electronic", "dance", "alternative", "indie", "hiphop", "rap", "rnb",
  "electropop", "metal", "popmusic",
]);

/** artist (normalised) -> { tags: Set<string>, ts } */
const tagCache = new Map();

/**
 * Normalise a tag/artist string for comparison ("K-Pop" and "kpop" become "kpop").
 * @param {string} s - Raw string.
 * @returns {string} Lower-case letters and digits only.
 */
function norm(s) {
  return String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * Strip YouTube channel decorations from an artist name.
 * @param {string} s - Raw artist/channel name.
 * @returns {string} Cleaned artist name.
 */
function cleanArtist(s) {
  return String(s ?? "")
    .replace(/\s*-\s*topic$/i, "")
    .replace(/\s*vevo$/i, "")
    .replace(/\s*official$/i, "")
    .trim();
}

/**
 * Best-effort artist name of an internal track object.
 * @param {object|null} t - Track.
 * @returns {string|null} Artist name, or null.
 */
function artistOf(t) {
  let a = t?.lastfm?.artist ?? t?.requestedArtist ?? t?.artist ?? t?.artists?.[0]?.name ?? t?.author?.name ?? null;
  if (a && typeof a !== "string") a = a.name ?? null;
  a = a ? cleanArtist(a) : null;
  return a || null;
}

/**
 * Best-effort title of an internal track object.
 * @param {object|null} t - Track.
 * @returns {string|null} Title, or null.
 */
function titleOf(t) {
  return t?.lastfm?.name ?? t?.requestedTitle ?? t?.title ?? t?.name ?? null;
}

/**
 * Whether two artist names refer to the same artist ("TWICE" vs "TWICE Japan").
 * @param {string|null} a - First name.
 * @param {string|null} b - Second name.
 * @returns {boolean} True if they match.
 */
function artistMatches(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 3 && long.includes(short);
}

/**
 * Fisher-Yates shuffle (copy).
 * @template T
 * @param {T[]} arr - Input array.
 * @returns {T[]} Shuffled copy.
 */
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Whether the genre tags of an artist are already cached (a lookup would be free).
 * @param {string} artist - Artist name.
 * @returns {boolean} True if cached and fresh.
 */
function hasFreshTags(artist) {
  const hit = tagCache.get(norm(artist));
  return !!hit && Date.now() - hit.ts < TAG_CACHE_TTL_MS;
}

/**
 * Genre tags for an artist from Last.fm: top tags with real weight, minus
 * noise ("seen live", decades, ...). Cached across players.
 * @param {object} lf - Last.fm manager (enabled).
 * @param {string} artist - Artist name.
 * @returns {Promise<Set<string>>} Normalised genre tags (empty if unknown).
 */
async function getGenreTags(lf, artist) {
  const key = norm(artist);
  if (!key) return new Set();
  const hit = tagCache.get(key);
  if (hit && Date.now() - hit.ts < TAG_CACHE_TTL_MS) return hit.tags;

  const tags = new Set();
  try {
    const list = await lf.getArtistTopTags(cleanArtist(artist), 12);
    for (const t of list) {
      if ((t.count ?? 0) < TAG_MIN_COUNT) continue;
      const n = norm(t.name);
      if (!n || NOISE_TAGS.has(n) || /^(?:19|20)?\d{2}s?$/.test(n)) continue;
      tags.add(n);
      if (tags.size >= TAG_KEEP) break;
    }
  } catch (e) { logger.warn("[Autoplay] Tag lookup failed:", e?.message); }

  if (tags.size) {
    if (tagCache.size >= TAG_CACHE_MAX) tagCache.delete(tagCache.keys().next().value);
    tagCache.set(key, { tags, ts: Date.now() });
  }
  return tags;
}

/**
 * Do a candidate's tags share the seed's genre? Broad tags ("pop", "rock")
 * only count when the seed has nothing more specific.
 * @param {Set<string>} seedTags - Genre tags of the seed artist.
 * @param {Set<string>} candTags - Genre tags of the candidate artist.
 * @returns {boolean} True if the genres overlap.
 */
function genreOverlaps(seedTags, candTags) {
  const strong = [...seedTags].filter(t => !WEAK_TAGS.has(t));
  const need = strong.length ? strong : [...seedTags];
  return need.some(t => candTags.has(t));
}

/**
 * Track whether the player's last track was picked by autoplay, and keep the
 * "seed" (the most recent track a human chose) up to date. Recommendations are
 * always built from the seed, never from a previous autoplay pick, so a single
 * off-genre result can no longer snowball into a different genre.
 * @param {object} p - The player instance.
 * @param {object|null} lastTrack - The track that just finished.
 * @returns {boolean} True if lastTrack was itself an autoplay pick.
 */
function updateSeed(p, lastTrack) {
  if (!lastTrack) return false;
  const vid = extractVideoId(lastTrack);
  const picked = !!lastTrack._autoplayPicked || (!!vid && !!p._autoplayPickedVids?.has(vid));
  if (picked) return true;

  const key = vid ?? `${norm(artistOf(lastTrack))}|${norm(titleOf(lastTrack))}`;
  if (!p._autoplaySeed || p._autoplaySeedKey !== key) {
    p._autoplaySeed = lastTrack;
    p._autoplaySeedKey = key;
    p._autoplaySeedTags = null;
    p._autoplayMixPools?.clear();
    p._autoplayPreferredPoolVid = null;
  }
  return false;
}

/**
 * Mark a track as chosen by autoplay (so it is never mistaken for a seed).
 * @param {object} p - The player instance.
 * @param {object} track - The picked track.
 * @returns {void}
 */
function markPicked(p, track) {
  track._autoplayPicked = true;
  const vid = extractVideoId(track);
  if (!vid) return;
  const set = p._autoplayPickedVids ?? new Set();
  p._autoplayPickedVids = set;
  set.delete(vid);
  set.add(vid);
  if (set.size > PICKED_VIDS_MAX) set.delete(set.values().next().value);
}

/**
 * Extract a YouTube video ID from a track's videoId field or URL.
 * @param {object} t - Internal track object.
 * @returns {string|null} Video ID, or null if unavailable.
 */
function extractVideoId(t) {
  if (!t) return null;
  if (t.videoId && /^[A-Za-z0-9_-]{6,20}$/.test(t.videoId)) return t.videoId;
  const url = typeof t.url === "string" ? t.url : "";
  const m = url.match(/[?&]v=([A-Za-z0-9_-]{6,20})/) ?? url.match(/youtu\.be\/([A-Za-z0-9_-]{6,20})/);
  return m ? m[1] : null;
}

/**
 * Record a track in the player's autoplay history so it is not picked again soon.
 * @param {object} p - The player instance.
 * @param {object} track - The internal track object.
 * @returns {void}
 */
function rememberTrack(p, track) {
  const vid = extractVideoId(track);
  const title = String(track?.title ?? "").toLowerCase().trim();
  p._autoplayHistory = (p._autoplayHistory ?? []).filter(h => h.vid !== vid || !vid);
  if (vid) p._autoplayHistory.push({ vid, title });
  if (p._autoplayHistory.length > HISTORY_SIZE) {
    p._autoplayHistory.splice(0, p._autoplayHistory.length - HISTORY_SIZE);
  }
}

/**
 * Check whether a candidate track is acceptable: not recently played, sane duration.
 * @param {object} p - The player instance.
 * @param {object} t - Candidate internal track object.
 * @returns {boolean} True if the candidate is playable and not a recent repeat.
 */
function isCandidateOk(p, t) {
  if (!t) return false;
  const ms = Number(t._durationMs) || (Number(t.duration?.seconds) * 1000) || 0;
  if (ms && (ms < MIN_DURATION_MS || ms > MAX_DURATION_MS)) return false;
  const vid = extractVideoId(t);
  if (vid && (p._autoplayHistory ?? []).some(h => h.vid === vid)) return false;
  const title = String(t?.title ?? "").toLowerCase().trim();
  if (title && (p._autoplayHistory ?? []).some(h => h.title && h.title === title)) return false;
  return true;
}

/**
 * Take an acceptable candidate from a cached mix pool, if one exists and is
 * fresh. Candidates already played are excluded via the autoplay history;
 * candidates failing the genre guard are dropped from the pool.
 * @param {object} p - The player instance.
 * @param {string} videoId - The video ID the pool was resolved from.
 * @param {(t: object) => Promise<boolean>} [guard] - Optional genre guard.
 * @returns {Promise<object|null>} An acceptable track from the pool, or null.
 */
async function takeFromPool(p, videoId, guard) {
  const pools = p._autoplayMixPools;
  if (!pools) return null;
  const pool = pools.get(videoId);
  if (!pool) return null;
  if (Date.now() - pool.ts > MIX_POOL_TTL_MS) {
    pools.delete(videoId);
    return null;
  }
  const ok = shuffle(pool.tracks.filter(t => isCandidateOk(p, t)));
  const rejected = new Set();
  let found = null;
  for (const t of ok) {
    if (!guard || await guard(t)) { found = t; break; }
    rejected.add(t);
  }
  if (rejected.size) pool.tracks = pool.tracks.filter(t => !rejected.has(t));
  if (!found && !pool.tracks.some(t => isCandidateOk(p, t))) pools.delete(videoId);
  return found;
}

/**
 * Store resolved mix candidates on the player for reuse across picks.
 * @param {object} p - The player instance.
 * @param {string} videoId - The video ID the candidates were resolved from.
 * @param {Array<object>} candidates - Acceptable candidate tracks.
 * @returns {void}
 */
function storePool(p, videoId, candidates) {
  if (!videoId || !candidates.length) return;
  const pools = p._autoplayMixPools ?? new Map();
  if (!p._autoplayMixPools) p._autoplayMixPools = pools;
  if (pools.size >= MAX_MIX_POOLS) {
    pools.delete(pools.keys().next().value);
  }
  pools.set(videoId, { tracks: candidates, ts: Date.now() });
}

/**
 * Resolve a query via the player's Lavalink search and return all acceptable
 * @param {object} p - The player instance.
 * @param {string} query - The search query or URL.
 * @param {string} provider - Provider shorthand key ("yt", "ytm", ...).
 * @returns {Promise<Array<object>>} Acceptable candidate tracks.
 */
async function resolveCandidates(p, query, provider = "ytm") {
  const resolved = await p.generalQuery({ query, provider });
  const list = resolved?.type === "list" ? (resolved.data ?? [])
    : resolved?.type === "video" && resolved.data ? [resolved.data] : [];
  return list.filter(t => isCandidateOk(p, t));
}

/**
 * Search and return the first acceptable result that passes every check.
 * @param {object} p - The player instance.
 * @param {string} query - The search query.
 * @param {(t: object) => (boolean|Promise<boolean>)} accept - Extra acceptance test (artist/genre).
 * @param {string} [provider="ytm"] - Provider shorthand key.
 * @returns {Promise<object|null>} A passing track, or null.
 */
async function searchAccepted(p, query, accept, provider = "ytm") {
  const found = await resolveCandidates(p, query, provider);
  for (const t of shuffle(found.slice(0, PICK_POOL))) {
    if (await accept(t)) return t;
  }
  return null;
}

/**
 * Choose the next track. Everything is anchored to the "seed" — the last track a
 * person actually chose — and, when Last.fm is available, every candidate's
 * artist must share the seed artist's genre tags. Search results must also be by
 * the artist we asked for, so a title collision (a different band's song with the
 * same name) can no longer slip through. The old title-only search fallback was
 * removed for the same reason.
 * @param {object} p - The player instance.
 * @param {object} ctx - The bot context (needs .lastfm).
 * @param {object|null} lastTrack - The last played internal track.
 * @returns {Promise<object|null>} The chosen track, or null if all strategies failed.
 */
export async function pickAutoplayTrack(p, ctx, lastTrack) {
  const lastWasPicked = updateSeed(p, lastTrack);
  const seed = p._autoplaySeed ?? lastTrack;
  const seedArtist = artistOf(seed);
  const seedName = titleOf(seed);
  const seedVid = extractVideoId(seed);
  const lf = ctx?.lastfm?.enabled ? ctx.lastfm : null;

  let seedTags = p._autoplaySeedTags ?? null;
  if (!seedTags && lf && seedArtist) {
    const t = await getGenreTags(lf, seedArtist);
    if (t.size) { seedTags = t; p._autoplaySeedTags = t; }
  }

  const budget = { left: MAX_TAG_CHECKS };
  /** True if the candidate belongs to the seed's genre (or genre can't be judged). */
  const genreOk = async (t) => {
    if (!lf || !seedTags?.size) return true;
    const ca = artistOf(t);
    if (!ca) return false;
    if (artistMatches(ca, seedArtist)) return true;
    if (!hasFreshTags(ca)) {
      if (budget.left <= 0) return false;
      budget.left--;
    }
    return genreOverlaps(seedTags, await getGenreTags(lf, ca));
  };

  const finish = (track) => {
    p._autoplayPreferredPoolVid = null;
    return track;
  };

  if (seedVid) {
    const pooled = await takeFromPool(p, seedVid, genreOk);
    if (pooled) { p._autoplayPreferredPoolVid = seedVid; return pooled; }
  }

  const tryLastfmSimilar = async () => {
    const bases = [seed];
    if (lastWasPicked && lastTrack && artistOf(lastTrack) && !artistMatches(artistOf(lastTrack), seedArtist)) bases.push(lastTrack);
    for (const base of bases) {
      const bArtist = artistOf(base), bName = titleOf(base);
      if (!bArtist || !bName) continue;
      try {
        const similar = await lf.getSimilarTracks(bArtist, bName, 30);
        const picks = shuffle(similar.slice(0, 15)).slice(0, 5);
        for (const pick of picks) {
          const track = await searchAccepted(
            p, `${pick.name} ${pick.artist}`.trim(),
            async (t) => artistMatches(artistOf(t), pick.artist) && await genreOk(t),
          );
          if (track) return track;
        }
      } catch (e) { logger.warn("[Autoplay] Last.fm similar-tracks strategy failed:", e?.message); }
    }
    return null;
  };

  const tryLastfmArtists = async () => {
    if (!seedArtist) return null;
    try {
      const similar = await lf.getSimilarArtists(seedArtist, 12);
      for (const a of shuffle(similar.filter(x => x.name)).slice(0, 4)) {
        const track = await searchAccepted(
          p, `${a.name} songs`,
          async (t) => artistMatches(artistOf(t), a.name) && await genreOk(t),
        );
        if (track) return track;
      }
    } catch (e) { logger.warn("[Autoplay] Last.fm similar-artists strategy failed:", e?.message); }
    return null;
  };

  const trySameArtist = async () => {
    if (!seedArtist) return null;
    try {
      return await searchAccepted(p, `${seedArtist} songs`, (t) => artistMatches(artistOf(t), seedArtist));
    } catch (e) { logger.warn("[Autoplay] Artist strategy failed:", e?.message); }
    return null;
  };

  const tryMix = async () => {
    if (!seedVid) return null;
    try {
      const mixUrl = `https://www.youtube.com/watch?v=${seedVid}&list=RD${seedVid}`;
      const candidates = await resolveCandidates(p, mixUrl, "yt");
      if (!candidates.length) return null;
      storePool(p, seedVid, candidates);
      const track = await takeFromPool(p, seedVid, genreOk);
      if (track) p._autoplayPreferredPoolVid = seedVid;
      return track;
    } catch (e) { logger.warn("[Autoplay] Mix strategy failed:", e?.message); }
    return null;
  };

  const order = lf
    ? [tryLastfmSimilar, tryLastfmArtists, trySameArtist, tryMix]
    : [tryMix, trySameArtist];

  for (const strat of order) {
    const track = await strat();
    if (track) return strat === tryMix ? track : finish(track);
  }
  return null;
}

/**
 * Serialized track picking. All autoplay picks go through a per-player promise
 * chain so concurrent triggers (e.g. a skip firing "trackSkip" + "queueEnd" at
 * the same time) never race each other into picking the same track twice.
 * The picked track is recorded in history immediately after selection.
 * @param {object} p - The player instance.
 * @param {object} ctx - The bot context.
 * @param {object|null} lastTrack - Track to base the recommendation on.
 * @returns {Promise<object|null>} The chosen track, or null.
 */
function pickSerialized(p, ctx, lastTrack) {
  const run = async () => {
    try {
      const track = await pickAutoplayTrack(p, ctx, lastTrack);
      if (track) { rememberTrack(p, track); markPicked(p, track); }
      return track;
    } catch (e) {
      logger.warn("[Autoplay] Pick error:", e?.message);
      return null;
    }
  };
  const prev = p._autoplayPickChain ?? Promise.resolve();
  const next = prev.then(run, run);
  p._autoplayPickChain = next.catch(() => {});
  return next;
}

/**
 * Build the queueEnd handler: the last song just ended and nothing is queued —
 * pick a similar track, add it, and start playing it right away.
 * @param {object} p - The player instance.
 * @param {object} ctx - The bot context.
 * @returns {Function} The handler.
 */
function buildQueueEndHandler(p, ctx) {
  return async () => {
    if (!p._autoplay || p._destroyed) return;
    if (p.queue?.getCurrent() || !(p.queue?.isEmpty?.() ?? true)) return;
    if (p._autoplayQueueEndPicking) return;
    p._autoplayQueueEndPicking = true;

    const lastTrack = p._lastPlayedTrack;
    if (!lastTrack) { p._autoplayQueueEndPicking = false; return; }

    try {
      p._stopInactivityTimer();
      rememberTrack(p, lastTrack);

      const track = await pickSerialized(p, ctx, lastTrack);
      if (track && p._autoplay && !p._destroyed) {
        p.addToQueue(track, false);
        logger.player(`[Autoplay] Queue ended — added and playing: ${track.title}`);
        if (!p.queue.getCurrent()) {
          p.playNext().catch(() => {});
        }
      } else if (!track && !p.queue?.getCurrent() && p.queue?.isEmpty() && !p._is247Enabled() && p._autoplay) {
        p._startInactivityTimer();
      }
    } catch (err) {
      logger.warn("[Autoplay] Handler error:", err?.message);
      if (!p.queue?.getCurrent() && p.queue?.isEmpty() && !p._is247Enabled()) {
        p._startInactivityTimer();
      }
    } finally {
      p._autoplayQueueEndPicking = false;
    }
  };
}

/**
 * Attach autoplay listeners to a player. Exported so other modules (e.g. debug
 * rebuilds) can restore autoplay state.
 *
 * Autoplay only ever reacts to "queueEnd" — i.e. the moment the current song
 * actually finishes (or a skip empties the queue) and nothing is left to
 * play. It adds exactly one track at a time, right when it's needed. There is
 * intentionally no pre-fill/keep-ahead behavior: that used to run on every
 * startplay/update/playback event and on every skip regardless of whether the
 * queue still had songs left, which both queued tracks well before they were
 * needed and burned CPU re-running searches constantly.
 * @param {object} p - The player instance.
 * @param {object} ctx - The bot context.
 * @returns {void}
 */
export function attachAutoplay(p, ctx) {
  detachAutoplay(p);

  p._autoplayHandler = buildQueueEndHandler(p, ctx);
  p.on("queueEnd", p._autoplayHandler);
}

/**
 * Remove all autoplay listeners from a player.
 * @param {object} p - The player instance.
 * @returns {void}
 */
export function detachAutoplay(p) {
  if (p._autoplayHandler) {
    p.removeListener("queueEnd", p._autoplayHandler);
    p._autoplayHandler = null;
  }
}

/**
 * Run handler for the autoplay command.
 * Toggles autoplay on the player.
 * @param {object} msg - The command message wrapper.
 * @param {object} data - Parsed command data (unused, no options required).
 * @returns {Promise<void>}
 */
export async function run(msg, data) {
  const p = await this.getPlayer(msg, true, true, false);
  if (!p) return;

  p._autoplay = !p._autoplay;

  if (p._autoplay) {
    p._autoplayHistory = p._autoplayHistory ?? [];
    attachAutoplay(p, this);

    if (!p.queue.getCurrent() && p.queue.isEmpty() && p._lastPlayedTrack) {
      p._autoplayHandler().catch(() => {});
    }

    return msg.reply({
      embeds: [new EmbedBuilder()
        .setColor(getGlobalColor())
        .setDescription(this.t(msg, "responses.autoplay.enabled"))]
    });
  } else {
    detachAutoplay(p);
    p._autoplayHistory = [];
    p._autoplayMixPools?.clear();
    p._autoplayPreferredPoolVid = null;
    p._autoplayPickChain = null;
    p._autoplayQueueEndPicking = false;
    p._autoplaySeed = null;
    p._autoplaySeedKey = null;
    p._autoplaySeedTags = null;
    p._autoplayPickedVids = null;

    return msg.reply({
      embeds: [new EmbedBuilder()
        .setColor(getGlobalColor())
        .setDescription(this.t(msg, "responses.autoplay.disabled"))]
    });
  }
}
