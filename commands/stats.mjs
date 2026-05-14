import { CommandBuilder } from "../src/CommandHandler.mjs";
import { Utils } from "../src/Utils.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

export const command = new CommandBuilder()
    .setName("stats")
    .setDescription("Display stats about the bot like the uptime.", "commands.stats")
    .addAliases("info")
    .setCategory("util");

// ── Constants ─────────────────────────────────────────────────────────────────

const CACHE_TTL_MS       = 5 * 60 * 1000;  // 5 min cache lifetime
const MEMBER_FETCH_LIMIT = 1_000;            // Discord max per page
const POOL_CONCURRENCY   = 6;               // guilds fetched in parallel
const GUILD_FETCH_MS     = 4_000;           // timeout per guild member fetch
const TOTAL_STATS_MS     = 15_000;          // hard cap for the whole refresh
const SCROBBLE_MS        = 3_000;
const LINKED_MS          = 5_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Resolve `promise` within `ms`, otherwise return `fallback`. */
function withTimeout(promise, ms, fallback) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** Run `tasks` (thunks) with at most `limit` in flight at once. */
async function pool(limit, tasks) {
  const results = [];
  const executing = new Set();

  for (const task of tasks) {
    const p = Promise.resolve()
        .then(task)
        .then((v) => { results.push(v); })
        .catch(() => { results.push(new Set()); }) // never let one guild crash all
        .finally(() => executing.delete(p));

    executing.add(p);
    if (executing.size >= limit) await Promise.race(executing);
  }

  await Promise.all(executing);
  return results;
}

// ── Member counting ───────────────────────────────────────────────────────────

/** Fast path: count from whatever is already cached in memory. */
function computeUserCount(client) {
  const uniqueUsers = new Set();
  const guilds = client?.guilds?.cache ?? client?.guilds ?? [];

  for (const guild of (guilds.values ? guilds.values() : guilds)) {
    const members = guild?.members?.cache ?? guild?.members ?? [];
    const iter = members.values ? members.values() : Object.values(members);
    for (const m of iter) {
      const id = m?.id ?? m?.user?.id;
      if (id) uniqueUsers.add(String(id));
    }
  }
  return uniqueUsers.size;
}

/**
 * Fetch all member IDs for one guild, paginating if needed.
 * Wrapped with a per-guild timeout so a slow shard can't block everything.
 */
async function fetchGuildMemberIds(guild) {
  const ids = new Set();

  const doFetch = async () => {
    if (!guild?.members?.fetch) throw new Error("no fetch");

    let after = "0";
    while (true) {
      const batch = await guild.members.fetch({ limit: MEMBER_FETCH_LIMIT, after });
      const items = batch?.values ? [...batch.values()] : (Array.isArray(batch) ? batch : []);
      if (!items.length) break;

      let lastId = "0";
      for (const m of items) {
        const id = String(m.id ?? m.user?.id ?? "");
        if (id) { ids.add(id); if (id > lastId) lastId = id; }
      }
      if (items.length < MEMBER_FETCH_LIMIT) break;
      after = lastId;
    }
    return ids;
  };

  try {
    return await withTimeout(doFetch(), GUILD_FETCH_MS, ids);
  } catch {
    // Fall back to cached members for this guild
    const members = guild?.members?.cache ?? guild?.members ?? [];
    const iter = members.values ? members.values() : Object.values(members);
    for (const m of iter) {
      const id = m?.id ?? m?.user?.id;
      if (id) ids.add(String(id));
    }
    return ids;
  }
}

/** Fetch accurate guild count, with a fallback to cache size. */
async function fetchAccurateGuildCount(client) {
  if (typeof client?.user?.fetchGuilds === "function") {
    try {
      const guilds = await withTimeout(client.user.fetchGuilds(), 4_000, null);
      if (Array.isArray(guilds)) return guilds.length;
      if (guilds?.size != null) return guilds.size;
    } catch { /* fall through */ }
  }
  return client?.guilds?.cache?.size ?? client?.guilds?.size ?? 0;
}

/**
 * Fetch accurate unique user count across all guilds.
 * Hard-capped at TOTAL_STATS_MS so it can never hang the command.
 */
async function fetchAccurateUserCount(client) {
  const guildsMap = client?.guilds?.cache ?? client?.guilds;
  const guilds = guildsMap?.values ? [...guildsMap.values()] : [...(guildsMap ?? [])];
  if (!guilds.length) return 0;

  const idSets = await pool(
      POOL_CONCURRENCY,
      guilds.map((g) => () => fetchGuildMemberIds(g))
  );

  const unique = new Set();
  for (const set of idSets) for (const id of set) unique.add(id);
  return unique.size;
}

// ── Stats cache ───────────────────────────────────────────────────────────────

let cachedStats      = null;
let cacheExpiresAt   = 0;
let inflightPromise  = null;

async function refreshStats(client) {
  try {
    const [guildCount, userCount] = await withTimeout(
        Promise.all([
          fetchAccurateGuildCount(client),
          fetchAccurateUserCount(client),
        ]),
        TOTAL_STATS_MS,
        [
          client?.guilds?.cache?.size ?? client?.guilds?.size ?? 0,
          computeUserCount(client),
        ]
    );
    cachedStats = { guildCount, userCount };
  } catch {
    cachedStats = {
      guildCount: client?.guilds?.cache?.size ?? client?.guilds?.size ?? 0,
      userCount: computeUserCount(client),
    };
  } finally {
    cacheExpiresAt  = Date.now() + CACHE_TTL_MS;
    inflightPromise = null;       // always clear so future calls can retry
  }
  return cachedStats;
}

function getStats(client) {
  if (cachedStats && Date.now() < cacheExpiresAt) return Promise.resolve(cachedStats);
  if (!inflightPromise) inflightPromise = refreshStats(client);
  return inflightPromise;
}

// ── Live player count ─────────────────────────────────────────────────────────

function getLivePlayerCount(playerMap) {
  if (!playerMap) return 0;
  let live = 0;
  const iter = playerMap.values ? playerMap.values() : Object.values(playerMap);
  for (const player of iter) {
    if (!player || player._destroyed || player.leaving || player._isJoining) continue;
    const conn = player.connection;
    if (!conn) continue;
    const room = conn.room;
    if (room && !room.isConnected &&
        (room.connectionState === 0 || room.connectionState === "disconnected")) continue;
    live++;
  }
  return live;
}

// ── Embed builder ─────────────────────────────────────────────────────────────

function buildEmbed(translator, msg, data) {
  const {
    guildCount, userCount, playerCount, scrobbleCount,
    linkedUsers, ping, uptime, comHash, comLink,
    reason, footer, loading, lastfmEnabled,
  } = data;

  const t   = (key) => { try { return translator(msg, key); } catch { return key.split(".").pop(); } };
  const num = (v)   => Utils.formatNumber(v ?? 0);
  const ld  = (v)   => (loading ? "…" : v);

  const lines = [
    `${t("responses.stats.servers")} — \`${num(guildCount)}\``,
    `${t("responses.stats.users")}   — \`${ld(num(userCount))}\``,
    `${t("responses.stats.players")} — \`${num(playerCount)}\``,
  ];

  if (lastfmEnabled) {
    lines.push(
        `${t("responses.stats.scrobbles")}    — \`${ld(num(scrobbleCount))}\``,
        `${t("responses.stats.linkedUsers")} — \`${ld(num(linkedUsers))}\``
    );
  }

  lines.push(
      `${t("responses.stats.ping")}   — \`${ld(`${num(ping)}ms`)}\``,
      `${t("responses.stats.uptime")} — \`${uptime}\``,
      `${t("responses.stats.build")}  — [\`${comHash || "N/A"}\`](${comLink || "#"})`
  );

  if (reason) lines.push(`${t("responses.stats.lastRestart")} — \`${reason}\``);

  lines.push("", t("responses.stats.supportKofi"), t("responses.stats.community"));

  return new EmbedBuilder()
      .setColor(getGlobalColor())
      .setAuthor({ name: t("responses.stats.title") })
      .setDescription(lines.filter(Boolean).join("\n"))
      .setFooter({ text: footer || t("responses.stats.title") })
      .setTimestamp();
}

// ── Runner ────────────────────────────────────────────────────────────────────

export async function run(message) {
  const lastfm        = this.lastfm;
  const lastfmEnabled = !!lastfm?.enabled;
  const translator    = typeof this.t === "function" ? this.t.bind(this) : (_m, k) => k;

  const shared = {
    playerCount:   getLivePlayerCount(this.players?.playerMap),
    scrobbleCount: Number(lastfm?._totalScrobblesCache ?? 0),
    linkedUsers:   Number(lastfm?._linkedUsersCache    ?? 0),
    lastfmEnabled,
    uptime:  Utils.prettifyMS(Math.round(process.uptime()) * 1000),
    comHash: this.comHash,
    comLink: this.comLink,
    reason:  this.config?.restart            ?? null,
    footer:  this.config?.customStatsFooter  ?? null,
  };

  // Use whatever we already have so the first reply is instant
  const statsFallback = cachedStats ?? {
    guildCount: this.client?.guilds?.cache?.size ?? this.client?.guilds?.size ?? 0,
    userCount:  computeUserCount(this.client),
  };

  // ── 1. Reply immediately with a loading embed ─────────────────────────────
  let sentMsg;
  const sendStart = Date.now();

  try {
    const loadingEmbed = buildEmbed(translator, message, {
      ...shared,
      ...statsFallback,
      ping:    0,
      loading: !cachedStats,
    });
    sentMsg = await message.reply({ embeds: [loadingEmbed] });
  } catch (err) {
    console.error("[stats] initial reply failed:", err);
    return; // nothing we can do without a message handle
  }

  const ping = Date.now() - sendStart;

  // ── 2. Fetch everything in parallel, all with timeouts ────────────────────
  const scrobblePromise = lastfmEnabled && typeof lastfm.getStoredTotalScrobbles === "function"
      ? withTimeout(lastfm.getStoredTotalScrobbles(), SCROBBLE_MS, shared.scrobbleCount)
      : Promise.resolve(shared.scrobbleCount);

  const linkedPromise = lastfmEnabled && typeof lastfm.getLinkedUsersCount === "function"
      ? withTimeout(lastfm.getLinkedUsersCount(), LINKED_MS, shared.linkedUsers)
      : Promise.resolve(shared.linkedUsers);

  let stats, scrobbleCount, linkedUsers;
  try {
    [stats, scrobbleCount, linkedUsers] = await Promise.all([
      getStats(this.client).catch(() => statsFallback),
      scrobblePromise.catch(() => shared.scrobbleCount),
      linkedPromise.catch(() => shared.linkedUsers),
    ]);
  } catch (err) {
    console.error("[stats] background fetch failed:", err);
    stats         = statsFallback;
    scrobbleCount = shared.scrobbleCount;
    linkedUsers   = shared.linkedUsers;
  }

  // ── 3. Edit with the final data ───────────────────────────────────────────
  try {
    const finalEmbed = buildEmbed(translator, message, {
      ...shared,
      guildCount: stats?.guildCount ?? statsFallback.guildCount,
      userCount:  stats?.userCount  ?? statsFallback.userCount,
      scrobbleCount,
      linkedUsers,
      ping,
      loading: false,
    });

    if (typeof sentMsg?.edit === "function") {
      await sentMsg.edit({ embeds: [finalEmbed] });
    }
  } catch (err) {
    console.error("[stats] edit failed:", err);
  }
}
