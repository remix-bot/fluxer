/**
 * @module commands/stats
 * @description Display bot statistics including guild count, user count, uptime, and ping.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CommandBuilder } from "../src/CommandHandler.mjs";
import { Utils } from "../src/Utils.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";
import { logger } from "../src/constants/Logger.mjs";

/**
 * @type {CommandBuilder}
 * @description Command definition for the stats command.
 */
export const command = new CommandBuilder()
    .setName("stats")
    .setDescription("Display stats about the bot like the uptime.", "commands.stats")
    .addAliases("info")
    .setCategory("util");

/** Cache is considered fresh for this long; older values trigger a background refresh. */
const CACHE_TTL_MS = 5 * 60 * 1000;
/** Max time the fill-in edit waits for Last.fm values before giving up (next run shows them). */
const LASTFM_FILL_BUDGET_MS = 2500;
/** Max time the fill-in edit waits for the background refresh to produce a user count. */
const REFRESH_FILL_BUDGET_MS = 10_000;
/** How many times a rate-limited message send is retried before giving up. */
const RATE_LIMIT_MAX_RETRIES = 2;
/** Upper bound for a single rate-limit backoff wait. */
const RATE_LIMIT_MAX_WAIT_MS = 15_000;
/** Where the warm cache is persisted (cwd-relative, same convention as ./storage/defaults.json). */
const CACHE_FILE = path.join(process.cwd(), "storage", "stats-cache.json");

let cache = { guilds: null, users: null, scrobbles: null, linkedUsers: null, updatedAt: 0 };
let lastPing        = null;
let refreshInflight = null;

try {
  const raw = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  cache = {
    guilds:      typeof raw?.guilds      === "number" ? raw.guilds      : null,
    users:       typeof raw?.users       === "number" ? raw.users       : null,
    scrobbles:   typeof raw?.scrobbles   === "number" ? raw.scrobbles   : null,
    linkedUsers: typeof raw?.linkedUsers === "number" ? raw.linkedUsers : null,
    updatedAt:   typeof raw?.updatedAt   === "number" ? raw.updatedAt   : 0,
  };
} catch {
  /* first run or unreadable cache — start cold, warm up in background */
}

/** Persist the current cache to disk so the next restart serves warm data. @private */
function persistCache() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch (e) {
    logger.warn("[Stats] Failed to persist stats cache:", e?.message);
  }
}

/**
 * Sum guild and member totals directly from the gateway cache.
 * memberCount comes with every guild payload, so no member listing is needed.
 * @private
 * @param {object} client - The client instance.
 * @returns {{guilds: number, users: number}} Instant totals.
 */
function computeInstantTotals(client) {
  let guilds = 0;
  let users  = 0;
  for (const guild of client.guilds.values()) {
    guilds++;
    users += guild.memberCount ?? guild.members?.size ?? 0;
  }
  return { guilds, users };
}

/**
 * Resolve the totals to display right now, merging the gateway cache with the
 * last known values. While the cache is fresh, the higher of the two smooths
 * over guilds still streaming in; the background refresh rewrites cache.users
 * with the pure gateway sum so counts still drop when members leave.
 * @private
 * @param {object} client - The client instance.
 * @returns {{guildCount: number, userCount: number, needsLoading: boolean}}
 */
function getTotals(client) {
  const instant    = computeInstantTotals(client);
  const cacheFresh = cache.updatedAt > 0 && Date.now() - cache.updatedAt < CACHE_TTL_MS;

  const guildCount = instant.guilds || cache.guilds || 0;
  const userCount  = cacheFresh
      ? Math.max(instant.users || 0, cache.users || 0)
      : instant.users;

  const needsLoading = userCount === 0 && !cache.users;
  return { guildCount, userCount, needsLoading };
}

/**
 * Refresh the cache in the background if it is older than the TTL.
 * Verifies the guild count via REST (covers guilds missing from the gateway
 * cache) and warms the Last.fm totals. Results are persisted for restarts.
 * @private
 * @param {object} client - The client instance.
 * @param {object|null} lastfm - The Last.fm manager, if enabled.
 * @returns {void}
 */
function scheduleBackgroundRefresh(client, lastfm) {
  if (cache.updatedAt > 0 && Date.now() - cache.updatedAt < CACHE_TTL_MS) return;
  if (refreshInflight) return;

  refreshInflight = (async () => {
    const instant = computeInstantTotals(client);

    let guilds = instant.guilds;
    try {
      let total = 0;
      let after = null;
      while (true) {
        const url   = "/users/@me/guilds?limit=200" + (after ? "&after=" + after : "");
        const chunk = await client.rest.get(url);
        if (!Array.isArray(chunk) || chunk.length === 0) break;
        total += chunk.length;
        if (chunk.length < 200) break;
        after = chunk[chunk.length - 1].id;
      }
      if (total > 0) guilds = Math.max(guilds, total);
    } catch (e) {
      logger.warn("[Stats] Background guild count refresh failed:", e?.message);
    }

    cache.guilds    = guilds || cache.guilds;
    cache.users     = instant.users || cache.users;
    cache.updatedAt = Date.now();
    persistCache();

    if (lastfm?.enabled) {
      const [sc, lu] = await Promise.allSettled([
        lastfm.getTotalScrobbles(),
        lastfm.getLinkedUsersCount(),
      ]);
      if (sc.status === "fulfilled" && typeof sc.value === "number") cache.scrobbles = sc.value;
      if (lu.status === "fulfilled" && typeof lu.value === "number") cache.linkedUsers = lu.value;
      persistCache();
    }
  })()
      .catch((e) => logger.warn("[Stats] Background refresh failed:", e?.message))
      .finally(() => { refreshInflight = null; });
}

/**
 * Race a promise against a timeout. Resolves `{ timedOut: true, value: fallback }`
 * when the budget is spent; the underlying promise keeps running either way.
 * @private
 * @template T
 * @param {Promise<T>} promise - The promise to race.
 * @param {number} ms - Timeout budget in milliseconds.
 * @param {T} fallback - Value returned when the budget is spent or rejected.
 * @returns {Promise<{timedOut: boolean, value: T}>}
 */
function withBudget(promise, ms, fallback) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (timedOut, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ timedOut, value });
    };
    const timer = setTimeout(() => finish(true, fallback), ms);
    timer.unref?.();
    promise.then(
        (v) => finish(false, v),
        () => finish(true, fallback),
    );
  });
}

/**
 * Run a message send/edit action, transparently retrying when the REST
 * library throws a 429 RateLimitError. Waits exactly as long as the API
 * asks for (capped), so bursts in a busy channel degrade to a short delay
 * instead of an error.
 * @private
 * @template T
 * @param {Function} fn - Async action returning the message.
 * @param {string} [label] - Label used in warning logs.
 * @returns {Promise<T>} The action result.
 */
async function withRateLimitRetry(fn, label = "send") {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const isRateLimit = e?.code === "RATE_LIMITED" || e?.statusCode === 429;
      if (!isRateLimit || attempt >= RATE_LIMIT_MAX_RETRIES) throw e;
      const waitMs = Math.min(Math.ceil((e.retryAfter ?? 1) * 1000), RATE_LIMIT_MAX_WAIT_MS);
      logger.warn(`[Stats] Rate limited on ${label}, retrying in ${waitMs}ms (attempt ${attempt + 1}/${RATE_LIMIT_MAX_RETRIES})`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

/**
 * Count players with active voice connections.
 * @private
 * @param {Map} playerMap - The player map from PlayerManager.
 * @returns {number} Number of live connected players.
 */
function getLivePlayerCount(playerMap) {
  let live = 0;

  for (const [mapKey, player] of playerMap ?? []) {
    if (!player || player._destroyed || player.leaving) continue;
    if (player._isJoining) continue;

    const conn = player.connection;
    if (conn) {
      const room = conn.room;
      if (room) {
        const isConnected     = room.isConnected;
        const connectionState = room.connectionState;
        if (!isConnected && (connectionState === 0 || connectionState === "disconnected")) continue;
      }
    } else {
      continue;
    }

    live++;
  }

  return live;
}

/**
 * Build the stats embed with all bot information.
 * @private
 * @param {Function} t - Translation function.
 * @param {object} msg - The command message wrapper.
 * @param {object} s - Statistics data object.
 * @param {number} s.guildCount - Number of guilds.
 * @param {number} s.userCount - Number of users.
 * @param {number} s.playerCount - Number of active players.
 * @param {number} s.scrobbleCount - Total Last.fm scrobbles.
 * @param {number} s.linkedUsers - Number of Last.fm linked users.
 * @param {number} s.ping - Bot response ping in ms.
 * @param {string} s.uptime - Formatted uptime string.
 * @param {string} s.comHash - Git commit hash.
 * @param {string} s.comLink - Git commit link URL.
 * @param {string} [s.reason] - Last restart reason.
 * @param {string} [s.footer] - Custom footer text.
 * @param {boolean} s.lastfmEnabled - Whether Last.fm integration is enabled.
 * @param {string[]} [pending] - Keys to render as "..." while still unknown.
 * @returns {EmbedBuilder} The constructed embed.
 */
function buildEmbed(t, msg, s, pending = []) {
  const num   = (v) => Utils.formatNumber(v);
  const field = (key, value) => `\`${pending.includes(key) ? "..." : value}\``;

  const description = [
    `${t(msg, "responses.stats.servers")} — ${field("guilds", num(s.guildCount))}`,
    `${t(msg, "responses.stats.users")} — ${field("users", num(s.userCount))}`,
    `${t(msg, "responses.stats.players")} — ${field("players", num(s.playerCount))}`,
  ];

  if (s.lastfmEnabled) {
    description.push(
        `${t(msg, "responses.stats.scrobbles")} — ${field("scrobbles", num(s.scrobbleCount))}`,
        `${t(msg, "responses.stats.linkedUsers")} — ${field("linkedUsers", num(s.linkedUsers))}`,
    );
  }

  description.push(
      `${t(msg, "responses.stats.ping")} — ${field("ping", `${num(s.ping)}ms`)}`,
      `${t(msg, "responses.stats.uptime")} — \`${s.uptime}\``,
      `${t(msg, "responses.stats.build")} — [\`${s.comHash}\`](${s.comLink})`,
      s.reason ? `${t(msg, "responses.stats.lastRestart")} — \`${s.reason}\`` : null,
      ``,
      t(msg, "responses.stats.supportKofi"),
      t(msg, "responses.stats.community"),
  );

  const desc = description.filter(l => l !== null).join("\n");

  const builder = new EmbedBuilder()
      .setColor(getGlobalColor())
      .setAuthor({ name: t(msg, "responses.stats.title") })
      .setDescription(desc)
      .setFooter({ text: s.footer || t(msg, "responses.stats.title") });

  if (typeof builder.setTimestamp === "function") builder.setTimestamp();
  return builder;
}

/**
 * Run handler for the stats command.
 * Replies instantly with everything known from the gateway cache and the warm
 * cache; slow sources are refreshed in the background and filled in with a
 * single bounded, fire-and-forget edit when needed.
 *
 * @param {object} message - The command message wrapper.
 * @returns {Promise<void>}
 */
export async function run(message) {
  const lastfm        = this.lastfm;
  const lastfmEnabled = lastfm?.enabled ?? false;
  const t             = (...a) => this.t(...a);

  const totals = getTotals(this.client);

  scheduleBackgroundRefresh(this.client, lastfmEnabled ? lastfm : null);

  const pending = [];
  if (totals.needsLoading) pending.push("users");
  if (lastfmEnabled) {
    if (cache.scrobbles   === null) pending.push("scrobbles");
    if (cache.linkedUsers === null) pending.push("linkedUsers");
  }
  if (lastPing === null) pending.push("ping");

  const embedData = {
    guildCount:    totals.guildCount,
    userCount:     totals.userCount,
    playerCount:   getLivePlayerCount(this.players.playerMap),
    scrobbleCount: lastfmEnabled ? (cache.scrobbles ?? 0) : 0,
    linkedUsers:   lastfmEnabled ? (cache.linkedUsers ?? 0) : 0,
    lastfmEnabled,
    ping:          lastPing ?? 0,
    uptime:        Utils.prettifyMS(Math.round(process.uptime()) * 1000),
    comHash:       this.comHash,
    comLink:       this.comLink,
    reason:        this.config.restart ?? null,
    footer:        this.config.customStatsFooter || null,
  };

  let msg = null;
  try {
    msg = await withRateLimitRetry(async () => {
      const t0 = Date.now();
      const m  = await message.reply({ embeds: [buildEmbed(t, message, embedData, pending)] });
      lastPing = Date.now() - t0;
      return m;
    }, "stats reply");
  } catch (e) {
    logger.warn("[Stats] Could not send stats reply:", e?.message);
    return;
  }

  if (pending.length > 0) {
    (async () => {
      if (totals.needsLoading && refreshInflight) {
        await withBudget(refreshInflight, REFRESH_FILL_BUDGET_MS, null);
      }

      if (lastfmEnabled && (cache.scrobbles === null || cache.linkedUsers === null)) {
        const [sc, lu] = await Promise.all([
          withBudget(lastfm.getTotalScrobbles(),   LASTFM_FILL_BUDGET_MS, null),
          withBudget(lastfm.getLinkedUsersCount(), LASTFM_FILL_BUDGET_MS, null),
        ]);
        if (!sc.timedOut && typeof sc.value === "number") cache.scrobbles = sc.value;
        if (!lu.timedOut && typeof lu.value === "number") cache.linkedUsers = lu.value;
        persistCache();
      }

      const fresh = getTotals(this.client);
      const fill  = {
        ...embedData,
        guildCount:    fresh.guildCount,
        userCount:     fresh.userCount,
        scrobbleCount: lastfmEnabled ? (cache.scrobbles ?? 0) : 0,
        linkedUsers:   lastfmEnabled ? (cache.linkedUsers ?? 0) : 0,
        ping:          lastPing ?? 0,
      };

      const stillPending = [];
      if (fresh.userCount === 0 && !cache.users) stillPending.push("users");
      if (lastPing === null) stillPending.push("ping");
      if (lastfmEnabled) {
        if (cache.scrobbles   === null) stillPending.push("scrobbles");
        if (cache.linkedUsers === null) stillPending.push("linkedUsers");
      }
      if (stillPending.length >= pending.length && stillPending.length > 0) return;

      await withRateLimitRetry(
          () => msg.edit({ embeds: [buildEmbed(t, message, fill, stillPending)] }),
          "stats fill-in edit",
      );
    })().catch((e) => logger.warn("[Stats] Fill-in edit failed:", e?.message));
  }
}
