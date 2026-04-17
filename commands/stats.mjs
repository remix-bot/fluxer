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
    while (true) {
      const batch = await guild.members.fetch({ limit: 1000, after });
      total += batch.length;
      if (batch.length < 1000) break;
      after = batch.reduce((max, m) => (m.id > max ? m.id : max), "0");
    }
    return total;
  } catch {
    return guild.members.size ?? 0;
  }
}

async function refreshUserCount(client) {
  const guilds = [...client.guilds.cache.values()];
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

// ── Embed builder ─────────────────────────────────────────────────────────────

function buildEmbed({ guildCount, userCount, playerCount, ping, uptime, comHash, comLink, reason, footer, loading }) {
  const num = (v) => Utils.formatNumber(v);
  const ld  = (v) => loading ? "..." : v;

  const description = [
    `📂  **Servers** — \`${num(guildCount)}\``,
    `👥  **Users** — \`${ld(num(userCount))}\``,
    `🎧  **Players** — \`${num(playerCount)}\``,
    `🏓  **Ping** — \`${ld(`${num(ping)}ms`)}\``,
    `⏱️  **Uptime** — \`${uptime}\``,
    `🔧  **Build** — [\`${comHash}\`](${comLink})`,
    reason ? `🪛  **Last restart** — \`${reason}\`` : null,
    ``,
    `☕ [Support us on Ko-fi](https://ko-fi.com/remixbot)`,
    `💬 [Community](https://fluxer.gg/Remix)`,
  ].filter(l => l !== null).join("\n");

  const builder = new EmbedBuilder()
      .setColor(getGlobalColor())
      .setAuthor({ name: "Remix Music Bot" })
      .setDescription(description)
      .setFooter({ text: footer || "Remix Music Bot" });

  if (typeof builder.setTimestamp === "function") builder.setTimestamp();
  return builder.toJSON();
}

// ── Runner ────────────────────────────────────────────────────────────────────

export async function run(message) {
  const shared = {
    guildCount:  this.client.guilds.cache.size,
    playerCount: this.players.playerMap.size,
    uptime:      Utils.prettifyMS(Math.round(process.uptime()) * 1000),
    comHash:     this.comHash,
    comLink:     this.comLink,
    reason:      this.config.restart ?? null,
    footer:      this.config.customStatsFooter || null,
  };

  const hasCached = cachedUserCount !== null;

  // Measure real Discord round-trip latency
  const start = Date.now();
  const msg = await message.replyEmbed({
    embeds: [buildEmbed({ ...shared, userCount: hasCached ? cachedUserCount : 0, ping: 0, loading: !hasCached })]
  });
  const ping = Date.now() - start;

  const users = await getUserCount(this.client);

  await msg.editEmbed({
    embeds: [buildEmbed({ ...shared, userCount: users, ping, loading: false })]
  }).catch((err) => console.error("[stats] editEmbed failed:", err));
}