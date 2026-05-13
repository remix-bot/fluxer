import { CommandBuilder } from "../src/CommandHandler.mjs";
import { Utils } from "../src/Utils.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

export const command = new CommandBuilder()
    .setName("stats")
    .setDescription("Display stats about the bot like the uptime.", "commands.stats")
    .addAliases("info")
    .setCategory("util");

// ── Stats cache ───────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // refresh every 5 minutes

let cachedStats = null;   // { guildCount, userCount } or null
let cacheExpiresAt  = 0;
let inflightPromise = null;

/**
 * Accurate guild count — same multi-layer strategy as ErinJS:
 *   1. Try client.fetchTotalGuildCount() (shard-aware, if available)
 *   2. Try client.fetchAllStats().guilds (shard-aware, if available)
 *   3. Paginate REST API via /users/@me/guilds?limit=200
 *   4. Fallback to client.guilds.size (local shard only)
 */
async function fetchAccurateGuildCount(client) {
  // Strategy 1: built-in shard-aware method
  if (typeof client.fetchTotalGuildCount === "function") {
    try {
      const count = await client.fetchTotalGuildCount();
      if (typeof count === "number" && count >= 0) return count;
    } catch {}
  }

  // Strategy 2: built-in stats aggregator
  if (typeof client.fetchAllStats === "function") {
    try {
      const stats = await client.fetchAllStats();
      if (typeof stats?.guilds === "number" && stats.guilds >= 0) return stats.guilds;
    } catch {}
  }

  // Strategy 3: REST API pagination — gets all guilds across shards
  if (client.rest && typeof client.rest.get === "function") {
    try {
      let total = 0;
      let after = undefined;
      for (let page = 0; page < 500; page++) {
        const route = `/users/@me/guilds?limit=200${after ? `&after=${after}` : ""}`;
        const response = await client.rest.get(route);
        const batch = Array.isArray(response) ? response : (response?.guilds ?? []);
        total += batch.length;
        if (batch.length < 200) break;
        after = batch[batch.length - 1]?.id;
        if (!after) break;
      }
      return total;
    } catch {}
  }

  // Strategy 4: fallback — local shard cache only
  return client.guilds?.size ?? 0;
}

/**
 * Accurate user count — sum memberCount across all guilds.
 * Uses guild.memberCount from the GUILD_CREATE payload (O(1), no API calls).
 * Falls back to guild.members.size if memberCount is missing.
 */
function computeUserCount(client) {
  let total = 0;
  for (const [, guild] of client.guilds) {
    total += guild.memberCount ?? guild.members?.size ?? 0;
  }
  return total;
}

async function refreshStats(client) {
  try {
    const [guildCount, userCount] = await Promise.all([
      fetchAccurateGuildCount(client),
      Promise.resolve(computeUserCount(client)),
    ]);
    cachedStats = { guildCount, userCount };
  } catch (err) {
    console.error("[stats] refreshStats failed:", err);
    // Keep old cache instead of overwriting with bad data
    if (cachedStats) {
      cacheExpiresAt = Date.now() + CACHE_TTL_MS;
      inflightPromise = null;
      return cachedStats;
    }
    cachedStats = { guildCount: client.guilds?.size ?? 0, userCount: 0 };
  }
  cacheExpiresAt  = Date.now() + CACHE_TTL_MS;
  inflightPromise = null;
  return cachedStats;
}

function getStats(client) {
  if (cachedStats && Date.now() < cacheExpiresAt) return Promise.resolve(cachedStats);
  if (!inflightPromise) inflightPromise = refreshStats(client);
  return inflightPromise;
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

function buildEmbed(t, msg, { guildCount, userCount, playerCount, scrobbleCount, linkedUsers, ping, uptime, comHash, comLink, reason, footer, loading, lastfmEnabled }) {
  const num = (v) => Utils.formatNumber(v);
  const ld  = (v) => loading ? "..." : v;

  const description = [
    `${t(msg, "responses.stats.servers")} — \`${num(guildCount)}\``,
    `${t(msg, "responses.stats.users")} — \`${ld(num(userCount))}\``,
    `${t(msg, "responses.stats.players")} — \`${num(playerCount)}\``,
  ];

  // Add Last.fm stats if the integration is enabled
  if (lastfmEnabled) {
    description.push(`${t(msg, "responses.stats.scrobbles")} — \`${ld(num(scrobbleCount))}\``);
    description.push(`${t(msg, "responses.stats.linkedUsers")} — \`${ld(num(linkedUsers))}\``);
  }

  description.push(
      `${t(msg, "responses.stats.ping")} — \`${ld(`${num(ping)}ms`)}\``,
      `${t(msg, "responses.stats.uptime")} — \`${uptime}\``,
      `${t(msg, "responses.stats.build")} — [\`${comHash}\`](${comLink})`,
      reason ? `${t(msg, "responses.stats.lastRestart")} — \`${reason}\`` : null,
      ``,
      t(msg, "responses.stats.supportKofi"),
      t(msg, "responses.stats.community"),
  );

  const desc = description.filter(l => l !== null).join("\n");

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

  const shared = {
    guildCount:  this.client.guilds.size,
    playerCount: getLivePlayerCount(this.players.playerMap),
    scrobbleCount: 0,
    linkedUsers: 0,
    lastfmEnabled,
    uptime:      Utils.prettifyMS(Math.round(process.uptime()) * 1000),
    comHash:     this.comHash,
    comLink:     this.comLink,
    reason:      this.config.restart ?? null,
    footer:      this.config.customStatsFooter || null,
  };

  // Fetch Last.fm stats (non-blocking for initial reply)
  const scrobblePromise = lastfmEnabled ? lastfm.getTotalScrobbles() : Promise.resolve(0);
  const linkedPromise   = lastfmEnabled ? lastfm.getLinkedUsersCount()  : Promise.resolve(0);

  const hasCached = cachedStats !== null;

  // Measure real round-trip latency
  const start = Date.now();
  const msg = await message.reply({
    embeds: [buildEmbed((...a) => this.t(...a), message, {
      ...shared,
      guildCount: hasCached ? cachedStats.guildCount : shared.guildCount,
      userCount:  hasCached ? cachedStats.userCount : 0,
      ping: 0,
      loading: !hasCached,
    })]
  });
  const ping = Date.now() - start;

  const [stats, scrobbleCount, linkedUsers] = await Promise.all([
    getStats(this.client),
    scrobblePromise,
    linkedPromise,
  ]);

  await msg.edit({
    embeds: [buildEmbed((...a) => this.t(...a), message, {
      ...shared,
      guildCount:   stats.guildCount,
      userCount:    stats.userCount,
      scrobbleCount,
      linkedUsers,
      ping,
      loading: false,
    })]
  }).catch((err) => console.error("[stats] editEmbed failed:", err));
}