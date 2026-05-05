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
  const liveChannels = new Set();

  for (const [mapKey, player] of playerMap ?? []) {
    if (!player || player._destroyed || player.leaving) continue;

    const channelId = String(player._channelId ?? mapKey ?? "").replace(/\D/g, "");
    if (!channelId) continue;

    liveChannels.add(channelId);
  }

  return liveChannels.size;
}

// ── Embed builder ─────────────────────────────────────────────────────────────

function buildEmbed(t, msg, { guildCount, userCount, playerCount, ping, uptime, comHash, comLink, reason, footer, loading }) {
  const num = (v) => Utils.formatNumber(v);
  const ld  = (v) => loading ? "..." : v;

  const description = [
    `${t(msg, "responses.stats.servers")} — \`${num(guildCount)}\``,
    `${t(msg, "responses.stats.users")} — \`${ld(num(userCount))}\``,
    `${t(msg, "responses.stats.players")} — \`${num(playerCount)}\``,
    `${t(msg, "responses.stats.ping")} — \`${ld(`${num(ping)}ms`)}\``,
    `${t(msg, "responses.stats.uptime")} — \`${uptime}\``,
    `${t(msg, "responses.stats.build")} — [\`${comHash}\`](${comLink})`,
    reason ? `${t(msg, "responses.stats.lastRestart")} — \`${reason}\`` : null,
    ``,
    t(msg, "responses.stats.supportKofi"),
    t(msg, "responses.stats.community"),
  ].filter(l => l !== null).join("\n");

  const builder = new EmbedBuilder()
      .setColor(getGlobalColor())
      .setAuthor({ name: t(msg, "responses.stats.title") })
      .setDescription(description)
      .setFooter({ text: footer || t(msg, "responses.stats.title") });

  if (typeof builder.setTimestamp === "function") builder.setTimestamp();
  return builder;
}

// ── Runner ────────────────────────────────────────────────────────────────────

export async function run(message) {
  const shared = {
    guildCount:  this.client.guilds.size,
    playerCount: getLivePlayerCount(this.players.playerMap),
    uptime:      Utils.prettifyMS(Math.round(process.uptime()) * 1000),
    comHash:     this.comHash,
    comLink:     this.comLink,
    reason:      this.config.restart ?? null,
    footer:      this.config.customStatsFooter || null,
  };

  const hasCached = cachedUserCount !== null;

  // Measure real round-trip latency
  const start = Date.now();
  const msg = await message.reply({
    embeds: [buildEmbed((...a) => this.t(...a), message, { ...shared, userCount: hasCached ? cachedUserCount : 0, ping: 0, loading: !hasCached })]
  });
  const ping = Date.now() - start;

  const users = await getUserCount(this.client);

  await msg.edit({
    embeds: [buildEmbed((...a) => this.t(...a), message, { ...shared, userCount: users, ping, loading: false })]
  }).catch((err) => console.error("[stats] editEmbed failed:", err));
}