import { CommandBuilder } from "../src/CommandHandler.mjs";
import { Utils } from "../src/Utils.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

export const command = new CommandBuilder()
    .setName("stats")
    .setDescription("Display stats about the bot like the uptime.", "commands.stats")
    .addAliases("info")
    .setCategory("util");

// ── Stats cache ──────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000;
const FAST_WAIT_MS = 8_000;

let cachedStats = null; // { guildCount, userCount }
let cacheExpiresAt = 0;
let inflightPromise = null;

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
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

async function pool(limit, tasks) {
  const results = [];
  const executing = new Set();
  for (const task of tasks) {
    const p = Promise.resolve()
      .then(task)
      .then((value) => {
        results.push(value);
        executing.delete(p);
      })
      .catch(() => {
        results.push(0);
        executing.delete(p);
      });
    executing.add(p);
    if (executing.size >= limit) await Promise.race(executing);
  }
  await Promise.all(executing);
  return results;
}

function computeUserCount(client) {
  const uniqueUsers = new Set();
  for (const [, guild] of client.guilds ?? []) {
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

async function fetchAccurateGuildCount(client) {
  if (typeof client?.user?.fetchGuilds === "function") {
    try {
      const guilds = await withTimeout(client.user.fetchGuilds(), 4_000, null);
      if (Array.isArray(guilds)) return guilds.length;
      if (typeof guilds?.size === "number") return guilds.size;
      if (typeof guilds?.values === "function") return [...guilds.values()].length;
    } catch (_) {}
  }

  if (typeof client.fetchTotalGuildCount === "function") {
    try {
      const count = await withTimeout(client.fetchTotalGuildCount(), 4_000, null);
      if (typeof count === "number" && count >= 0) return count;
    } catch (_) {}
  }

  if (typeof client.fetchAllStats === "function") {
    try {
      const stats = await withTimeout(client.fetchAllStats(), 4_000, null);
      if (typeof stats?.guilds === "number" && stats.guilds >= 0) return stats.guilds;
    } catch (_) {}
  }

  if (client.rest && typeof client.rest.get === "function") {
    try {
      let total = 0;
      let after = undefined;
      for (let page = 0; page < 25; page++) {
        const route = `/users/@me/guilds?limit=200${after ? `&after=${after}` : ""}`;
        const response = await withTimeout(client.rest.get(route), 800, null);
        if (!response) break;
        const batch = Array.isArray(response) ? response : (response?.guilds ?? []);
        total += batch.length;
        if (batch.length < 200) break;
        after = batch[batch.length - 1]?.id;
        if (!after) break;
      }
      if (total > 0) return total;
    } catch (_) {}
  }

  return client.guilds?.size ?? 0;
}

async function fetchGuildMemberIds(guild) {
  try {
    let after = undefined;
    const ids = new Set();
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
        const id = member.id ?? member.user?.id ?? "";
        return id > max ? id : max;
      }, "0");
      if (!after) break;
    }
    return ids;
  } catch {
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
}

async function fetchAccurateUserCount(client) {
  const guilds = [...(client.guilds?.values?.() ?? [])];
  if (guilds.length === 0) return 0;
  const idSets = await pool(8, guilds.map((guild) => () => fetchGuildMemberIds(guild)));
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
      guildCount: await fetchAccurateGuildCount(client),
      userCount: await fetchAccurateUserCount(client),
    };
  } catch {
    cachedStats = {
      guildCount: client.guilds?.size ?? 0,
      userCount: computeUserCount(client),
    };
  }

  cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  inflightPromise = null;
  return cachedStats;
}

function getStats(client) {
  if (cachedStats && Date.now() < cacheExpiresAt) return Promise.resolve(cachedStats);
  if (!inflightPromise) inflightPromise = refreshStats(client);
  return inflightPromise;
}

function getLastfmSnapshot(lastfm) {
  return {
    scrobbleCount: Number(lastfm?._totalScrobblesCache ?? 0),
    linkedUsers: Number(lastfm?._linkedUsersCache ?? 0),
  };
}

function getLivePlayerCount(playerMap) {
  let live = 0;

  for (const [, player] of playerMap ?? []) {
    if (!player || player._destroyed || player.leaving) continue;
    if (player._isJoining) continue;

    const conn = player.connection;
    if (!conn) continue;

    const room = conn.room;
    if (room) {
      const isConnected = room.isConnected;
      const connectionState = room.connectionState;
      if (!isConnected && (connectionState === 0 || connectionState === "disconnected")) continue;
    }

    live++;
  }

  return live;
}

// ── Embed builder ─────────────────────────────────────────────────────────────

function buildEmbed(t, msg, {
  guildCount,
  userCount,
  playerCount,
  scrobbleCount,
  linkedUsers,
  ping,
  uptime,
  comHash,
  comLink,
  reason,
  footer,
  loading,
  lastfmEnabled,
}) {
  const num = (v) => Utils.formatNumber(v);
  const ld = (v) => loading ? "..." : v;

  const description = [
    `${t(msg, "responses.stats.servers")} — \`${num(guildCount)}\``,
    `${t(msg, "responses.stats.users")} — \`${ld(num(userCount))}\``,
    `${t(msg, "responses.stats.players")} — \`${num(playerCount)}\``,
  ];

  if (lastfmEnabled) {
    description.push(`${t(msg, "responses.stats.scrobbles")} — \`${ld(num(scrobbleCount))}\``);
    description.push(`${t(msg, "responses.stats.linkedUsers")} — \`${ld(num(linkedUsers))}\``);
  }

  description.push(
      `${t(msg, "responses.stats.ping")} — \`${ld(`${num(ping)}ms`)}\``,
      `${t(msg, "responses.stats.uptime")} — \`${uptime}\``,
      `${t(msg, "responses.stats.build")} — [\`${comHash}\`](${comLink})`,
      reason ? `${t(msg, "responses.stats.lastRestart")} — \`${reason}\`` : null,
      "",
      t(msg, "responses.stats.supportKofi"),
      t(msg, "responses.stats.community"),
  );

  const desc = description.filter((line) => line !== null).join("\n");

  const builder = new EmbedBuilder()
      .setColor(getGlobalColor())
      .setAuthor({ name: t(msg, "responses.stats.title") })
      .setDescription(desc)
      .setFooter({ text: footer || t(msg, "responses.stats.title") });

  if (typeof builder.setTimestamp === "function") builder.setTimestamp();
  return builder;
}

async function safeEditStatsMessage(messageRef, payload, fallbackMessage) {
  try {
    if (messageRef && typeof messageRef.edit === "function") {
      await messageRef.edit(payload);
      return true;
    }
    if (messageRef?.message && typeof messageRef.message.edit === "function") {
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
    console.error("[stats] fallback reply failed:", err);
    return false;
  }
}

// ── Runner ────────────────────────────────────────────────────────────────────

export async function run(message) {
  try {
    const t = createTranslator(this);
    const lastfm = this.lastfm;
    const lastfmEnabled = lastfm?.enabled ?? false;
    const lastfmSnapshot = getLastfmSnapshot(lastfm);

    const shared = {
      guildCount: this.client.guilds?.size ?? 0,
      playerCount: getLivePlayerCount(this.players.playerMap),
      scrobbleCount: lastfmSnapshot.scrobbleCount,
      linkedUsers: lastfmSnapshot.linkedUsers,
      lastfmEnabled,
      uptime: Utils.prettifyMS(Math.round(process.uptime()) * 1000),
      comHash: this.comHash,
      comLink: this.comLink,
      reason: this.config.restart ?? null,
      footer: this.config.customStatsFooter || null,
    };

    const statsFallback = cachedStats ?? {
      guildCount: shared.guildCount,
      userCount: computeUserCount(this.client),
    };

    const scrobblePromise = lastfmEnabled
      ? withTimeout(
          lastfm.getStoredTotalScrobbles?.() ?? Promise.resolve(lastfmSnapshot.scrobbleCount),
          3_000,
          lastfmSnapshot.scrobbleCount
        ).catch(() => lastfmSnapshot.scrobbleCount)
      : Promise.resolve(0);

    const linkedPromise = lastfmEnabled
      ? withTimeout(lastfm.getLinkedUsersCount(), FAST_WAIT_MS, lastfmSnapshot.linkedUsers).catch(() => lastfmSnapshot.linkedUsers)
      : Promise.resolve(0);

    const start = Date.now();
    const msg = await message.reply({
      embeds: [buildEmbed(t, message, {
        ...shared,
        guildCount: statsFallback.guildCount,
        userCount: statsFallback.userCount,
        ping: 0,
        loading: !cachedStats,
      })],
    });
    const ping = Date.now() - start;

    const [stats, scrobbleCount, linkedUsers] = await Promise.all([
      getStats(this.client).catch(() => statsFallback),
      scrobblePromise,
      linkedPromise,
    ]);

    await safeEditStatsMessage(msg, {
      embeds: [buildEmbed(t, message, {
        ...shared,
        guildCount: stats?.guildCount ?? statsFallback.guildCount,
        userCount: stats?.userCount ?? statsFallback.userCount,
        scrobbleCount,
        linkedUsers,
        ping,
        loading: false,
      })],
    }, message);
  } catch (err) {
    console.error("[stats] run failed:", err);
    const fallback = new EmbedBuilder()
      .setColor(getGlobalColor())
      .setDescription("Failed to load full stats. Please try again in a moment.");
    await message.reply({ embeds: [fallback] }).catch(() => {});
  }
}
