/**
 * @module commands/stats
 * @description Display bot statistics including guild count, user count, uptime, and ping.
 */

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

const CACHE_TTL_MS = 5 * 60 * 1000;

let cachedUserCount = null;
let cacheExpiresAt  = 0;
let inflightPromise = null;

/**
 * Run tasks with a concurrency limit.
 * @private
 * @param {number} limit - Maximum number of concurrent tasks.
 * @param {Function[]} tasks - Array of task functions to execute.
 * @returns {Promise<unknown[]>} Array of task results.
 */
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

/**
 * Fetch the total member count for a guild by paginating through members.
 * @private
 * @async
 * @param {object} guild - The Discord guild object.
 * @returns {Promise<number>} Total member count.
 */
async function fetchGuildMemberCount(guild) {
  try {
    let after = undefined;
    let total = 0;
    for (let page = 0; page < 1000; page++) {
      const raw   = await guild.members.fetch({ limit: 1000, after });
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
  } catch (e) {
      logger.warn("[Stats] Error:", e?.message);
      return guild.memberCount ?? guild.members?.size ?? 0;
  }
}

/**
 * Refresh the cached total user count across all guilds.
 * @private
 * @async
 * @param {object} client - The Discord client instance.
 * @returns {Promise<number>} Total user count.
 */
async function refreshUserCount(client) {
  const guilds = [...client.guilds.values()];
  const counts = await pool(10, guilds.map(g => () => fetchGuildMemberCount(g)));
  cachedUserCount = counts.reduce((a, b) => a + b, 0);
  cacheExpiresAt  = Date.now() + CACHE_TTL_MS;
  inflightPromise = null;
  return cachedUserCount;
}

/**
 * Get the total user count, using cache if still valid or refreshing if expired.
 * @private
 * @param {object} client - The Discord client instance.
 * @returns {Promise<number>} Total user count.
 */
function getUserCount(client) {
  if (cachedUserCount !== null && Date.now() < cacheExpiresAt) return Promise.resolve(cachedUserCount);
  if (!inflightPromise) inflightPromise = refreshUserCount(client);
  return inflightPromise;
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

let cachedGuildCount    = null;
let guildCacheExpiresAt = 0;

/**
 * Get the total guild count via REST API with caching.
 * @private
 * @async
 * @param {object} client - The Discord client instance.
 * @returns {Promise<number>} Total guild count.
 */
async function getGuildCount(client) {
  if (cachedGuildCount !== null && Date.now() < guildCacheExpiresAt) {
    return cachedGuildCount;
  }

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

    cachedGuildCount    = total;
    guildCacheExpiresAt = Date.now() + CACHE_TTL_MS;
    return total;
  } catch (e) {
    logger.warn("[Stats] REST guild count fetch failed:", e?.message);
    if (typeof client.guilds?.size === "number") return client.guilds.size;
    return Object.keys(client.guilds ?? {}).length;
  }
}

/**
 * Build the stats embed with all bot information.
 * @private
 * @param {Function} t - Translation function.
 * @param {object} msg - The command message wrapper.
 * @param {object} stats - Statistics data object.
 * @param {number} stats.guildCount - Number of guilds.
 * @param {number} stats.userCount - Number of users.
 * @param {number} stats.playerCount - Number of active players.
 * @param {number} stats.scrobbleCount - Total Last.fm scrobbles.
 * @param {number} stats.linkedUsers - Number of Last.fm linked users.
 * @param {number} stats.ping - Bot response ping in ms.
 * @param {string} stats.uptime - Formatted uptime string.
 * @param {string} stats.comHash - Git commit hash.
 * @param {string} stats.comLink - Git commit link URL.
 * @param {string} [stats.reason] - Last restart reason.
 * @param {string} [stats.footer] - Custom footer text.
 * @param {boolean} stats.loading - Whether data is still loading.
 * @param {boolean} stats.lastfmEnabled - Whether Last.fm integration is enabled.
 * @returns {EmbedBuilder} The constructed embed.
 */
function buildEmbed(t, msg, { guildCount, userCount, playerCount, scrobbleCount, linkedUsers, ping, uptime, comHash, comLink, reason, footer, loading, lastfmEnabled }) {
  const num = (v) => Utils.formatNumber(v);
  const ld  = (v) => loading ? "..." : v;

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

/**
 * Run handler for the stats command.
 * Collects bot statistics and displays them in an embed, initially with loading
 * state then edited with the real data.
 *
 * @param {object} message - The command message wrapper.
 * @returns {Promise<void>}
 */
export async function run(message) {
  const lastfm        = this.lastfm;
  const lastfmEnabled = lastfm?.enabled ?? false;

  const shared = {
    guildCount:    cachedGuildCount ?? this.client.guilds?.size ?? 0,
    playerCount:   getLivePlayerCount(this.players.playerMap),
    scrobbleCount: 0,
    linkedUsers:   0,
    lastfmEnabled,
    uptime:        Utils.prettifyMS(Math.round(process.uptime()) * 1000),
    comHash:       this.comHash,
    comLink:       this.comLink,
    reason:        this.config.restart ?? null,
    footer:        this.config.customStatsFooter || null,
  };

  const scrobblePromise = lastfmEnabled ? lastfm.getTotalScrobbles()   : Promise.resolve(0);
  const linkedPromise   = lastfmEnabled ? lastfm.getLinkedUsersCount() : Promise.resolve(0);

  const hasCached = cachedUserCount !== null;

  const start = Date.now();
  const msg = await message.reply({
    embeds: [buildEmbed((...a) => this.t(...a), message, { ...shared, userCount: hasCached ? cachedUserCount : 0, ping: 0, loading: true })]
  });
  const ping = Date.now() - start;

  const [users, scrobbleCount, linkedUsers, guildCount] = await Promise.all([
    getUserCount(this.client),
    scrobblePromise,
    linkedPromise,
    getGuildCount(this.client),
  ]);

  await msg.edit({
    embeds: [buildEmbed((...a) => this.t(...a), message, { ...shared, guildCount, userCount: users, scrobbleCount, linkedUsers, ping, loading: false })]
  }).catch((err) => logger.error("[stats] editEmbed failed:", err));
}
