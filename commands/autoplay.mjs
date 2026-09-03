/**
 * @module commands/autoplay
 * @description Toggle autoplay mode — keeps the music going forever:
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";
import { logger } from "../src/constants/Logger.mjs";

/** @type {CommandBuilder} @description Command definition for the autoplay command. */
export const command = new CommandBuilder()
  .setName("autoplay")
  .setDescription("Toggle autoplay — automatically play similar tracks when the queue ends.", "commands.autoplay")
  .setCategory("music")
  .addAliases("ap");

/** Max number of upcoming tracks the pre-filler keeps in the queue. */
const QUEUE_KEEP_AHEAD = 2;
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
/** Minimum time between fill runs — absorbs event bursts without extra Lavalink searches. */
const FILL_COOLDOWN_MS = 1_200;

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
 * Take a random acceptable candidate from a cached mix pool, if one exists and
 * is fresh. Candidates already picked are excluded via the autoplay history.
 * @param {object} p - The player instance.
 * @param {string} videoId - The video ID the pool was resolved from.
 * @returns {object|null} An acceptable track from the pool, or null.
 */
function takeFromPool(p, videoId) {
  const pools = p._autoplayMixPools;
  if (!pools) return null;
  const pool = pools.get(videoId);
  if (!pool) return null;
  if (Date.now() - pool.ts > MIX_POOL_TTL_MS) {
    pools.delete(videoId);
    return null;
  }
  const ok = pool.tracks.filter(t => isCandidateOk(p, t));
  if (!ok.length) {
    pools.delete(videoId);
    return null;
  }
  return ok[Math.floor(Math.random() * Math.min(PICK_POOL, ok.length))];
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
 * Resolve a query via the player's Lavalink search and return a random acceptable
 * candidate from the top results.
 * @param {object} p - The player instance.
 * @param {string} query - The search query or URL.
 * @param {string} provider - Provider shorthand key ("yt", "ytm", ...).
 * @returns {Promise<object|null>} An acceptable track, or null.
 */
async function pickFromQuery(p, query, provider = "ytm") {
  const ok = await resolveCandidates(p, query, provider);
  if (!ok.length) return null;
  return ok[Math.floor(Math.random() * Math.min(PICK_POOL, ok.length))];
}

/**
 * @param {object} p - The player instance.
 * @param {object} ctx - The bot context (needs .lastfm).
 * @param {object|null} lastTrack - The last played internal track.
 * @returns {Promise<object|null>} The chosen track, or null if all strategies failed.
 */
async function pickAutoplayTrack(p, ctx, lastTrack) {
  const artist = lastTrack?.lastfm?.artist ?? lastTrack?.requestedArtist ?? lastTrack?.artist
    ?? lastTrack?.artists?.[0]?.name ?? lastTrack?.author?.name ?? null;
  const name   = lastTrack?.lastfm?.name   ?? lastTrack?.requestedTitle   ?? lastTrack?.title   ?? lastTrack?.name ?? null;
  const videoId = extractVideoId(lastTrack);

  if (p._autoplayPreferredPoolVid) {
    const pooled = takeFromPool(p, p._autoplayPreferredPoolVid);
    if (pooled) return pooled;
    p._autoplayPreferredPoolVid = null;
  }

  if (videoId) {
    const cached = takeFromPool(p, videoId);
    if (cached) {
      p._autoplayPreferredPoolVid = videoId;
      return cached;
    }

    try {
      const mixUrl = `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`;
      const candidates = await resolveCandidates(p, mixUrl, "yt");
      if (candidates.length) {
        storePool(p, videoId, candidates);
        p._autoplayPreferredPoolVid = videoId;
        return candidates[Math.floor(Math.random() * Math.min(PICK_POOL, candidates.length))];
      }
    } catch (e) { logger.warn("[Autoplay] Mix strategy failed:", e?.message); }
  }

  const lf = ctx?.lastfm;
  if (lf?.enabled && artist && name) {
    try {
      const similar = await lf.getSimilarTracks(artist, name, 10);
      for (let i = 0; i < Math.min(4, similar.length); i++) {
        const pick = similar[Math.floor(Math.random() * Math.min(3, similar.length))];
        const track = await pickFromQuery(p, `${pick.name} ${pick.artist}`.trim(), "ytm");
        if (track) {
          p._autoplayPreferredPoolVid = null;
          return track;
        }
      }
    } catch (e) { logger.warn("[Autoplay] Last.fm strategy failed:", e?.message); }
  }

  if (artist) {
    try {
      const track = await pickFromQuery(p, `${artist} songs`, "ytm");
      if (track) {
        p._autoplayPreferredPoolVid = null;
        return track;
      }
    } catch (e) { logger.warn("[Autoplay] Artist strategy failed:", e?.message); }
  }
  if (name) {
    try {
      const track = await pickFromQuery(p, `${name}`, "ytm");
      if (track) {
        p._autoplayPreferredPoolVid = null;
        return track;
      }
    } catch (_) {}
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
      if (track) rememberTrack(p, track);
      return track;
    } catch (e) {
      logger.warn("[Autoplay] Pick error:", e?.message);
      return null;
    }
  };
  const prev = p._autoplayPickChain ?? Promise.resolve();
  const next = prev.then(run, run);
  // Keep the chain alive even if a caller lets a rejection slip through.
  p._autoplayPickChain = next.catch(() => {});
  return next;
}

/**
 * Fill the queue ahead while autoplay is enabled. Debounced and guarded so it
 * never runs concurrently or hammers Lavalink when events arrive in bursts.
 * @param {object} p - The player instance.
 * @param {object} ctx - The bot context.
 * @returns {Promise<void>}
 */
async function fillQueue(p, ctx) {
  if (!p._autoplay || p._destroyed || p._autoplayFilling) return;
  // Loop modes mean the user's own queue repeats forever — don't grow it.
  if (p.queue?.loop || p.queue?.songLoop) return;

  const current = p.queue?.getCurrent();
  if (!current) return; // queueEnd handler owns the "nothing playing" case.
  const upcoming = p.queue?.data?.length ?? 0;
  if (upcoming >= QUEUE_KEEP_AHEAD) return;

  const now = Date.now();
  if (now - (p._autoplayLastFillAt ?? 0) < FILL_COOLDOWN_MS) return;
  p._autoplayLastFillAt = now;

  p._autoplayFilling = true;
  try {
    while (p._autoplay && !p._destroyed && (p.queue?.data?.length ?? 0) < QUEUE_KEEP_AHEAD) {
      const last = p.queue?.data?.at?.(-1) ?? p._lastPlayedTrack ?? current;
      const track = await pickSerialized(p, ctx, last);
      if (!track || !p._autoplay || p._destroyed) break;
      p.addToQueue(track, false);
    }
  } catch (e) {
    logger.warn("[Autoplay] Fill error:", e?.message);
  } finally {
    p._autoplayFilling = false;
  }
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

    const lastTrack = p._lastPlayedTrack;
    if (!lastTrack) return;

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
    }
  };
}

/**
 * Build the trackSkip handler: a song was skipped — add a new similar song to
 * the queue so the music never runs dry. This fires on every skip (command,
 * control panel, dashboard, custom end-time cut) while autoplay is enabled.
 * @param {object} p - The player instance.
 * @param {object} ctx - The bot context.
 * @returns {Function} The handler.
 */
function buildTrackSkipHandler(p, ctx) {
  return async (skippedTrack) => {
    try {
      if (!p._autoplay || p._destroyed) return;
      // Loop modes mean the user wants their own queue repeated — don't grow it.
      if (p.queue?.loop || p.queue?.songLoop) return;

      const basis = skippedTrack ?? p._lastPlayedTrack;
      if (!basis) return;
      rememberTrack(p, basis); // never re-pick the song that was just skipped

      const track = await pickSerialized(p, ctx, basis);
      if (!track || !p._autoplay || p._destroyed) return;

      p.addToQueue(track, false);
      logger.player(`[Autoplay] Skipped — replenished queue with: ${track.title}`);
    } catch (e) {
      logger.warn("[Autoplay] Skip-refill error:", e?.message);
    }
  };
}

/**
 * Attach autoplay listeners (queueEnd, trackSkip + pre-fill hooks) to a player.
 * Exported so other modules (e.g. debug rebuilds) can restore autoplay state.
 * Note: the pre-fill hooks onto "startplay" — the Player never re-emits its
 * Queue's "queue" events as "queue" on itself, so listening for "queue" here
 * would be a dead listener and the keep-ahead fill would only run on manual
 * queue edits.
 * @param {object} p - The player instance.
 * @param {object} ctx - The bot context.
 * @returns {void}
 */
export function attachAutoplay(p, ctx) {
  detachAutoplay(p);

  p._autoplayHandler = buildQueueEndHandler(p, ctx);
  p.on("queueEnd", p._autoplayHandler);

  p._autoplaySkipHandler = buildTrackSkipHandler(p, ctx);
  p.on("trackSkip", p._autoplaySkipHandler);

  p._autoplayFillHandler = () => { fillQueue(p, ctx).catch(() => {}); };
  p.on("startplay", p._autoplayFillHandler);
  p.on("update", p._autoplayFillHandler);
  p.on("playback", p._autoplayFillHandler);
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
  if (p._autoplaySkipHandler) {
    p.removeListener("trackSkip", p._autoplaySkipHandler);
    p._autoplaySkipHandler = null;
  }
  if (p._autoplayFillHandler) {
    p.removeListener("startplay", p._autoplayFillHandler);
    p.removeListener("update", p._autoplayFillHandler);
    p.removeListener("playback", p._autoplayFillHandler);
    p._autoplayFillHandler = null;
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
    } else {
      fillQueue(p, this).catch(() => {});
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
    p._autoplayLastFillAt = 0;
    p._autoplayPickChain = null;

    return msg.reply({
      embeds: [new EmbedBuilder()
        .setColor(getGlobalColor())
        .setDescription(this.t(msg, "responses.autoplay.disabled"))]
    });
  }
}
