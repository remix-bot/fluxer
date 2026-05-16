import { CommandBuilder } from "../src/CommandHandler.mjs";
import { Utils } from "../src/Utils.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

export const command = new CommandBuilder()
    .setName("stats")
    .setDescription("Display stats about the bot like the uptime.", "commands.stats")
    .addAliases("info")
    .setCategory("util");

// ── User count cache ──────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // refresh every 5 minutes

let cachedUserCount = null; // null = never fetched, 0 = real zero
let cacheExpiresAt  = 0;
let inflightPromise = null;

async function pool(limit, tasks) {
  const results   = [];
  const executing = new Set();
  for (const task of tasks) {
    const p = Promise.resolve().then(task).then(r => { results.push(r); executing.delete(p); });
    executing.add(p);
    if (executing.size >= limit) await Promise.race(executing);
  }
  await Promise.all(executing);
  return results;
}

async function fetchGuildMemberCount(guild) {
  try {
    let after = undefined;
    let total = 0;
    // Guard against runaway pagination: Fluxer may have far fewer than 1000 members
    // but return a Collection (Map-like) instead of an array, causing batch.length
    // to be undefined and the loop to run forever. Normalise to an array first.
    for (let page = 0; page < 1000; page++) {
      const raw   = await guild.members.fetch({ limit: 1000, after });
      // Normalise: Collection (Map), array, or plain object → array
      const batch = Array.isArray(raw)
          ? raw
          : typeof raw?.values === "function"
              ? [...raw.values()]
              : Object.values(raw ?? {});
      total += batch.length;
      if (batch.length < 1000) break;
      after = batch.reduce((max, m) => {
        const id = m.id ?? m.user?.id ?? "";
        return id > max ? id : max;
      }, "0");
    }
    return total;
  } catch {
    return guild.memberCount ?? guild.members?.size ?? 0;
  }
}

async function refreshUserCount(client) {
  const guilds = [...client.guilds.values()];
  const counts = await pool(10, guilds.map(g => () => fetchGuildMemberCount(g)));
  cachedUserCount = counts.reduce((a, b) => a + b, 0);
  cacheExpiresAt  = Date.now() + CACHE_TTL_MS;
  inflightPromise = null;
  return cachedUserCount;
}

function getUserCount(client) {
  if (cachedUserCount !== null && Date.now() < cacheExpiresAt) return Promise.resolve(cachedUserCount);
  if (!inflightPromise) inflightPromise = refreshUserCount(client);
  return inflightPromise;
}

function getLivePlayerCount(playerMap) {
  let live = 0;
  const seenGuilds = new Set();

  for (const [mapKey, player] of playerMap ?? []) {
    // Skip null / destroyed / leaving entries
    if (!player || player._destroyed || player.leaving) continue;

    // Skip players still in the join() phase — they don't have a voice
    // connection yet and may fail to connect.
    if (player._isJoining) continue;

    // A player is only "live" if it has an actual voice connection.
    // Stale entries (gateway disconnect, LiveKit drop) that haven't been
    // cleaned up yet will have connection = null or a dead room state.
    const conn = player.connection;
    if (conn) {
      const room = conn.room;
      if (room) {
        // Use @livekit/rtc-node Node.js SDK API:
        // room.isConnected — boolean getter (true when connected)
        // room.connectionState — ConnectionState enum (0=disconnected, 1=connected, 2=reconnecting)
        // room.state does NOT exist in the Node.js SDK (browser-only API)
        const isConnected = room.isConnected;
        const connectionState = room.connectionState;
        // Explicitly dead states → skip
        if (!isConnected && (connectionState === 0 || connectionState === "disconnected")) continue;
      }
      // conn exists but no room → still a valid LiveKit connection reference
    } else {
      // No connection at all → not live
      continue;
    }

    live++;

    // Also track unique guilds so we can report server count
    const guildId = String(player._guildId ?? "").replace(/\D/g, "");
    if (guildId) seenGuilds.add(guildId);
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

  const cachedGuildCount = this.client.guilds.size;

  const shared = {
    guildCount:  cachedGuildCount,
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

  // Fetch Last.fm stats in the background (non-blocking for initial reply)
  // getTotalScrobbles() syncs all linked users' lifetime scrobble counts from Last.fm
  const scrobblePromise = lastfmEnabled ? lastfm.getTotalScrobbles() : Promise.resolve(0);
  const linkedPromise   = lastfmEnabled ? lastfm.getLinkedUsersCount()  : Promise.resolve(0);

  const hasCached = cachedUserCount !== null;

  // Measure real round-trip latency
  const start = Date.now();
  const msg = await message.reply({
    embeds: [buildEmbed((...a) => this.t(...a), message, { ...shared, userCount: hasCached ? cachedUserCount : 0, ping: 0, loading: !hasCached })]
  });
  const ping = Date.now() - start;

  // Fetch the authoritative guild count from the API (same method the
  // Dashboard uses for its "allServers" endpoint).  This returns the
  // actual number of servers the bot is in, regardless of cache state.
  // Falls back to the cached count if the API call fails.
  const guildCountPromise = (async () => {
    try {
      if (typeof this.client.user?.fetchGuilds === "function") {
        const guilds = await this.client.user.fetchGuilds();
        return Array.isArray(guilds) ? guilds.length : cachedGuildCount;
      }
    } catch (_) { /* API unavailable — use cache */ }
    return cachedGuildCount;
  })();

  const [users, scrobbleCount, linkedUsers, guildCount] = await Promise.all([
    getUserCount(this.client),
    scrobblePromise,
    linkedPromise,
    guildCountPromise,
  ]);

  await msg.edit({
    embeds: [buildEmbed((...a) => this.t(...a), message, { ...shared, guildCount, userCount: users, scrobbleCount, linkedUsers, ping, loading: false })]
  }).catch((err) => console.error("[stats] editEmbed failed:", err));
}