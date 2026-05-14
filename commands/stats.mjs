import { CommandBuilder } from "../src/CommandHandler.mjs";
import { Utils } from "../src/Utils.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

export const command = new CommandBuilder()
    .setName("stats")
    .setDescription("Display stats about the bot like the uptime.", "commands.stats")
    .addAliases("info")
    .setCategory("util");

const CACHE_TTL_MS = 5 * 60 * 1000;
const GUILD_FETCH_TIMEOUT_MS = 4_000;
const REST_PAGE_TIMEOUT_MS = 1_000;
const LASTFM_TIMEOUT_MS = 3_000;

let cachedStats = null;
let cacheExpiresAt = 0;
let inflightStatsPromise = null;

function isAbortError(err) {
  const name = String(err?.name ?? "");
  const code = String(err?.code ?? "");
  const message = String(err?.message ?? err ?? "");
  return name === "AbortError" ||
    code === "ABORT_ERR" ||
    message.includes("This operation was aborted");
}

function getMessageGuildId(message) {
  return message?.channel?.channel?.guildId ??
    message?.message?.guildId ??
    message?.guildId ??
    null;
}

function createTranslator(remix) {
  return (message, key, data = {}) => {
    const guildId = getMessageGuildId(message);
    return remix?.locale?.translate?.(guildId, key, data) ?? key;
  };
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

async function runLimited(tasks, limit = 6) {
  const results = new Array(tasks.length);
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const current = index++;
      try {
        results[current] = await tasks[current]();
      } catch (_) {
        results[current] = null;
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function getCachedGuildCount(client) {
  return Number(client?.guilds?.size ?? 0);
}

function getFastCachedUserCount() {
  return Number(cachedStats?.userCount ?? 0);
}

function getCachedUserCount(client) {
  const uniqueUsers = new Set();

  for (const guild of client?.guilds?.values?.() ?? []) {
    const members = guild?.members;
    const iterable = typeof members?.values === "function"
      ? members.values()
      : Array.isArray(members)
        ? members
        : Object.values(members ?? {});

    for (const member of iterable) {
      const id = member?.id ?? member?.user?.id ?? null;
      if (id) uniqueUsers.add(String(id));
    }
  }

  return uniqueUsers.size;
}

async function fetchGuildCount(client) {
  if (typeof client?.user?.fetchGuilds === "function") {
    try {
      const guilds = await withTimeout(client.user.fetchGuilds(), GUILD_FETCH_TIMEOUT_MS, null);
      if (Array.isArray(guilds)) return guilds.length;
      if (typeof guilds?.size === "number") return guilds.size;
      if (typeof guilds?.values === "function") return [...guilds.values()].length;
    } catch (_) {}
  }

  if (typeof client?.fetchTotalGuildCount === "function") {
    try {
      const total = await withTimeout(client.fetchTotalGuildCount(), GUILD_FETCH_TIMEOUT_MS, null);
      if (typeof total === "number" && total >= 0) return total;
    } catch (_) {}
  }

  if (typeof client?.fetchAllStats === "function") {
    try {
      const stats = await withTimeout(client.fetchAllStats(), GUILD_FETCH_TIMEOUT_MS, null);
      if (typeof stats?.guilds === "number" && stats.guilds >= 0) return stats.guilds;
    } catch (_) {}
  }

  if (client?.rest && typeof client.rest.get === "function") {
    try {
      let total = 0;
      let after = null;

      for (let page = 0; page < 25; page++) {
        const route = `/users/@me/guilds?limit=200${after ? `&after=${after}` : ""}`;
        const response = await withTimeout(client.rest.get(route), REST_PAGE_TIMEOUT_MS, null);
        if (!response) break;

        const batch = Array.isArray(response) ? response : (response?.guilds ?? []);
        total += batch.length;
        if (batch.length < 200) break;

        after = batch[batch.length - 1]?.id ?? null;
        if (!after) break;
      }

      if (total > 0) return total;
    } catch (_) {}
  }

  return getCachedGuildCount(client);
}

function collectIdsFromMembers(guild) {
  const ids = new Set();
  const members = guild?.members;
  const iterable = typeof members?.values === "function"
    ? members.values()
    : Array.isArray(members)
      ? members
      : Object.values(members ?? {});

  for (const member of iterable) {
    const id = member?.id ?? member?.user?.id ?? null;
    if (id) ids.add(String(id));
  }

  return ids;
}

async function fetchGuildMemberIds(guild) {
  if (typeof guild?.members?.fetch !== "function") {
    return collectIdsFromMembers(guild);
  }

  try {
    const ids = new Set();
    let after = undefined;

    for (let page = 0; page < 1000; page++) {
      const raw = await guild.members.fetch({ limit: 1000, after });
      const batch = Array.isArray(raw)
        ? raw
        : typeof raw?.values === "function"
          ? [...raw.values()]
          : Object.values(raw ?? {});

      for (const member of batch) {
        const id = member?.id ?? member?.user?.id ?? null;
        if (id) ids.add(String(id));
      }

      if (batch.length < 1000) break;

      after = batch.reduce((max, member) => {
        const id = String(member?.id ?? member?.user?.id ?? "");
        return id > max ? id : max;
      }, "0");

      if (!after) break;
    }

    return ids;
  } catch (_) {
    return collectIdsFromMembers(guild);
  }
}

async function fetchUserCount(client) {
  const guilds = [...(client?.guilds?.values?.() ?? [])];
  if (guilds.length === 0) return 0;

  const idSets = await runLimited(
    guilds.map((guild) => () => fetchGuildMemberIds(guild)),
    8
  );

  const uniqueUsers = new Set();
  for (const idSet of idSets) {
    if (!idSet || typeof idSet[Symbol.iterator] !== "function") continue;
    for (const id of idSet) uniqueUsers.add(String(id));
  }

  return uniqueUsers.size;
}

async function refreshStats(client) {
  try {
    cachedStats = {
      guildCount: await fetchGuildCount(client),
      userCount: await fetchUserCount(client),
    };
  } catch (_) {
    cachedStats = {
      guildCount: getCachedGuildCount(client),
      userCount: getCachedUserCount(client),
    };
  } finally {
    cacheExpiresAt = Date.now() + CACHE_TTL_MS;
    inflightStatsPromise = null;
  }

  return cachedStats;
}

function getStats(client) {
  if (cachedStats && Date.now() < cacheExpiresAt) {
    return Promise.resolve(cachedStats);
  }

  if (!inflightStatsPromise) {
    inflightStatsPromise = refreshStats(client);
  }

  return inflightStatsPromise;
}

function getLastfmSnapshot(lastfm) {
  return {
    scrobbleCount: Number(lastfm?._totalScrobblesCache ?? 0),
    linkedUsers: Number(lastfm?._linkedUsersCache ?? 0),
  };
}

function getLivePlayerCount(playerMap) {
  let count = 0;

  for (const player of playerMap?.values?.() ?? []) {
    if (!player || player._destroyed || player.leaving || player._isJoining) continue;

    const room = player?.connection?.room;
    if (room && !room.isConnected && (room.connectionState === 0 || room.connectionState === "disconnected")) {
      continue;
    }

    if (!player.connection) continue;
    count++;
  }

  return count;
}

function buildEmbed(t, message, stats) {
  const num = (value) => Utils.formatNumber(Number(value ?? 0));
  const maybeLoading = (value, loading) => loading ? "..." : value;

  const lines = [
    `${t(message, "responses.stats.servers")} — \`${num(stats.guildCount)}\``,
    `${t(message, "responses.stats.users")} — \`${maybeLoading(num(stats.userCount), stats.loading)}\``,
    `${t(message, "responses.stats.players")} — \`${num(stats.playerCount)}\``,
  ];

  if (stats.lastfmEnabled) {
    lines.push(`${t(message, "responses.stats.scrobbles")} — \`${maybeLoading(num(stats.scrobbleCount), stats.loading)}\``);
    lines.push(`${t(message, "responses.stats.linkedUsers")} — \`${maybeLoading(num(stats.linkedUsers), stats.loading)}\``);
  }

  lines.push(
    `${t(message, "responses.stats.ping")} — \`${maybeLoading(`${num(stats.ping)}ms`, stats.loading)}\``,
    `${t(message, "responses.stats.uptime")} — \`${stats.uptime}\``,
    `${t(message, "responses.stats.build")} — [\`${stats.comHash}\`](${stats.comLink})`
  );

  if (stats.reason) {
    lines.push(`${t(message, "responses.stats.lastRestart")} — \`${stats.reason}\``);
  }

  lines.push("", t(message, "responses.stats.supportKofi"), t(message, "responses.stats.community"));

  const embed = new EmbedBuilder()
      .setColor(getGlobalColor())
      .setAuthor({ name: t(message, "responses.stats.title") })
      .setDescription(lines.join("\n"))
      .setFooter({ text: stats.footer || t(message, "responses.stats.title") });

  if (typeof embed.setTimestamp === "function") {
    embed.setTimestamp();
  }

  return embed;
}

async function editOrReply(messageRef, payload, fallbackMessage) {
  try {
    if (typeof messageRef?.edit === "function") {
      await messageRef.edit(payload);
      return true;
    }

    if (typeof messageRef?.message?.edit === "function") {
      await messageRef.message.edit(payload);
      return true;
    }
  } catch (err) {
    console.error("[stats] edit failed:", err);
  }

  try {
    await fallbackMessage.reply(payload);
    return false;
  } catch (err) {
    if (!isAbortError(err)) {
      console.error("[stats] fallback reply failed:", err);
    }
    return false;
  }
}

async function safeReply(message, payload) {
  try {
    return await message.reply(payload);
  } catch (err) {
    if (!isAbortError(err)) {
      throw err;
    }

    console.warn("[stats] reply aborted by Fluxer timeout");
    return null;
  }
}

export async function run(message) {
  const t = createTranslator(this);
  const lastfm = this.lastfm;
  const lastfmEnabled = lastfm?.enabled ?? false;
  const lastfmSnapshot = getLastfmSnapshot(lastfm);

  const baseStats = {
    guildCount: getCachedGuildCount(this.client),
    userCount: getFastCachedUserCount(),
    playerCount: getLivePlayerCount(this.players.playerMap),
    scrobbleCount: lastfmSnapshot.scrobbleCount,
    linkedUsers: lastfmSnapshot.linkedUsers,
    lastfmEnabled,
    uptime: Utils.prettifyMS(Math.round(process.uptime()) * 1000),
    comHash: this.comHash,
    comLink: this.comLink,
    reason: this.config.restart ?? null,
    footer: this.config.customStatsFooter || null,
    ping: 0,
    loading: !cachedStats,
  };

  const cachedOrFallbackStats = cachedStats ?? {
    guildCount: baseStats.guildCount,
    userCount: getCachedUserCount(this.client),
  };

  try {
    const start = Date.now();
    const reply = await safeReply(message, {
      embeds: [
        buildEmbed(t, message, {
          ...baseStats,
          guildCount: cachedOrFallbackStats.guildCount,
          userCount: cachedOrFallbackStats.userCount,
        }),
      ],
    });
    if (!reply) return;

    const ping = Date.now() - start;

    const statsPromise = getStats(this.client).catch(() => cachedOrFallbackStats);
    const scrobblePromise = lastfmEnabled
      ? withTimeout(
          lastfm.getStoredTotalScrobbles?.() ?? Promise.resolve(lastfmSnapshot.scrobbleCount),
          LASTFM_TIMEOUT_MS,
          lastfmSnapshot.scrobbleCount
        ).catch(() => lastfmSnapshot.scrobbleCount)
      : Promise.resolve(0);
    const linkedPromise = lastfmEnabled
      ? withTimeout(
          lastfm.getLinkedUsersCount?.() ?? Promise.resolve(lastfmSnapshot.linkedUsers),
          LASTFM_TIMEOUT_MS,
          lastfmSnapshot.linkedUsers
        ).catch(() => lastfmSnapshot.linkedUsers)
      : Promise.resolve(0);

    const [stats, scrobbleCount, linkedUsers] = await Promise.all([
      statsPromise,
      scrobblePromise,
      linkedPromise,
    ]);

    await editOrReply(reply, {
      embeds: [
        buildEmbed(t, message, {
          ...baseStats,
          guildCount: stats?.guildCount ?? cachedOrFallbackStats.guildCount,
          userCount: stats?.userCount ?? cachedOrFallbackStats.userCount,
          scrobbleCount,
          linkedUsers,
          ping,
          loading: false,
        }),
      ],
    }, message);
  } catch (err) {
    if (!isAbortError(err)) {
      console.error("[stats] run failed:", err);
    }

    const fallback = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setDescription("Failed to load full stats. Please try again in a moment.");

    await safeReply(message, { embeds: [fallback] }).catch(() => {});
  }
}
