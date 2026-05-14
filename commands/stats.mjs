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
const FAST_WAIT_MS = 1_500;

let cachedStats = null; // { guildCount, userCount }
let cacheExpiresAt = 0;
let inflightPromise = null;

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

function computeGuildCount(client) {
  return client.guilds?.size ?? 0;
}

function computeUserCount(client) {
  let total = 0;
  for (const [, guild] of client.guilds ?? []) {
    total += guild.memberCount ?? guild.members?.size ?? 0;
  }
  return total;
}

async function refreshStats(client) {
  try {
    cachedStats = {
      guildCount: computeGuildCount(client),
      userCount: computeUserCount(client),
    };
  } catch {
    cachedStats = {
      guildCount: client.guilds?.size ?? 0,
      userCount: 0,
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

// ── Runner ────────────────────────────────────────────────────────────────────

export async function run(message) {
  const lastfm = this.lastfm;
  const lastfmEnabled = lastfm?.enabled ?? false;
  const lastfmSnapshot = getLastfmSnapshot(lastfm);

  const shared = {
    guildCount: computeGuildCount(this.client),
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
        FAST_WAIT_MS,
        lastfmSnapshot.scrobbleCount
      )
    : Promise.resolve(0);

  const linkedPromise = lastfmEnabled
    ? withTimeout(lastfm.getLinkedUsersCount(), FAST_WAIT_MS, lastfmSnapshot.linkedUsers)
    : Promise.resolve(0);

  const start = Date.now();
  const msg = await message.reply({
    embeds: [buildEmbed((...args) => this.t(...args), message, {
      ...shared,
      guildCount: statsFallback.guildCount,
      userCount: statsFallback.userCount,
      ping: 0,
      loading: !cachedStats,
    })],
  });
  const ping = Date.now() - start;

  const [stats, scrobbleCount, linkedUsers] = await Promise.all([
    withTimeout(getStats(this.client), FAST_WAIT_MS, statsFallback),
    scrobblePromise,
    linkedPromise,
  ]);

  await msg.edit({
    embeds: [buildEmbed((...args) => this.t(...args), message, {
      ...shared,
      guildCount: stats.guildCount,
      userCount: stats.userCount,
      scrobbleCount,
      linkedUsers,
      ping,
      loading: false,
    })],
  }).catch((err) => console.error("[stats] editEmbed failed:", err));
}
