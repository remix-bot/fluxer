/**
 * @module src/utils/ShardingUtils
 * @description Shard-aware gateway helpers that work identically on Fluxer.js
 * 2.2 (plain single process) and 3.0 (optionally sharded via
 * `@fluxerjs/sharding`).
 *
 * When the bot boots through the root `shard.mjs` supervisor, every child
 * process is forked by a {@link ShardingManager} with the
 * `FLUXER_SHARD_IDS` / `FLUXER_SHARD_COUNT` / `FLUXER_SHARD_PROCESS_ID` env
 * vars set, and `Bot.mjs` attaches the child-side `ShardClientUtil` as
 * `client.shard` before login. These helpers read that state to:
 *   - route guild-scoped gateway payloads (opcode 4 voice joins/leaves) to
 *     the shard that owns the guild,
 *   - fan presence updates out to every gateway shard connected in this
 *     process,
 *   - enumerate the raw WebSocket socket of every local shard (2.2 exposed
 *     a `ws.shards` Map property; 3.0 exposes `getShards()`/`getShard()`
 *     methods and no property).
 *
 * In plain single-process mode (`npm start` / `node index.mjs`) every helper
 * degrades to the exact pre-sharding behavior — shard 0 and a one-element
 * shard list — so callers never need to know whether the bot is sharded.
 */

/**
 * True when this process was forked by an `@fluxerjs/sharding`
 * ShardingManager (root `shard.mjs`). Detection requires both the manager
 * env var and a live IPC channel (`process.send`); manually exporting
 * FLUXER_* variables does not activate sharding.
 * @returns {boolean}
 */
export function isShardedProcess() {
  return process.env.FLUXER_SHARD_IDS !== undefined &&
      typeof process.send === "function";
}

/**
 * Resolve the gateway shard that owns a guild. Under a ShardingManager the
 * child-side `client.shard.shardIdForGuildId()` computes the assignment
 * (`(guild_id >> 22) % shard_count`, matching the gateway); otherwise the
 * bot runs a single gateway shard and the answer is always 0.
 * @param {object} client - The Fluxer client instance.
 * @param {string|number|null} guildId - The guild ID to route for.
 * @returns {number} The owning shard id (0 when not sharded).
 */
export function shardIdForGuild(client, guildId) {
  try {
    const shardUtil = client?.shard;
    if (shardUtil && typeof shardUtil.shardIdForGuildId === "function") {
      const id = shardUtil.shardIdForGuildId(String(guildId ?? ""));
      if (Number.isInteger(id) && id >= 0) return id;
    }
  } catch {
    // fall through to the single-process default
  }
  return 0;
}

/**
 * Read the client's shard map in a 2.2- and 3.0-compatible way.
 * Fluxer 3.0 exposes `getShards()` on the WebSocketManager (the 2.2 `shards`
 * Map property is gone), and `client.ws` itself is a throwing getter before
 * login on 3.0, so every access here is guarded.
 * @param {object} client - The Fluxer client instance.
 * @returns {Array<Array<number, object>>} [id, shard] entries; empty when the
 *   gateway is not connected yet or no shards are running in this process.
 */
export function getLocalShards(client) {
  try {
    const ws = client?.ws;
    if (!ws) return [];
    const map = typeof ws.getShards === "function" ? ws.getShards() : ws.shards;
    if (map && typeof map.entries === "function") {
      return [...map.entries()].filter(([id]) => Number.isInteger(id));
    }
  } catch {
    // Fluxer 3.0: client.ws throws before login — treat as "no shards yet".
  }
  return [];
}

/**
 * Ids of the gateway shards connected in this process. Defaults to `[0]`
 * (single-process behavior) when no shard map is available yet.
 * @param {object} client - The Fluxer client instance.
 * @returns {number[]}
 */
export function localShardIds(client) {
  const ids = getLocalShards(client).map(([id]) => id);
  return ids.length > 0 ? ids : [0];
}

/**
 * Raw WebSocket socket of every gateway shard connected in this process
 * (used by the raw-socket listeners in GatewayHandler and LavalinkManager).
 * 2.2-style code read `client.ws.shards.get(0).ws`; this generalises it to
 * all local shards for sharded children.
 * @param {object} client - The Fluxer client instance.
 * @returns {Array<object>} Raw socket objects (may be empty).
 */
export function localShardSockets(client) {
  const out = [];
  for (const [, shard] of getLocalShards(client)) {
    const wsObj = shard?.ws ?? null;
    if (wsObj) out.push(wsObj);
  }
  return out;
}

/**
 * Look up a single shard handle by id, 2.2- and 3.0-compatible.
 * @param {object} client - The Fluxer client instance.
 * @param {number} [shardId=0] - The shard id to fetch.
 * @returns {object|null} The shard handle, or null when unavailable.
 */
export function getShard(client, shardId = 0) {
  try {
    const ws = client?.ws;
    if (!ws) return null;
    if (typeof ws.getShard === "function") return ws.getShard(shardId) ?? null;
    return ws.shards?.get?.(shardId) ?? null;
  } catch {
    return null;
  }
}

/**
 * One-line sharding description for startup logs.
 * @param {object} [client] - The Fluxer client instance (optional).
 * @returns {string} e.g. "process 2, gateway shards 4,5 of 8" or
 *   "single process (unsharded)".
 */
export function describeSharding(client) {
  if (!isShardedProcess()) return "single process (unsharded)";
  const ids  = String(process.env.FLUXER_SHARD_IDS ?? "0");
  const count = Number(process.env.FLUXER_SHARD_COUNT ?? "1") || 1;
  const pid  = process.env.FLUXER_SHARD_PROCESS_ID ?? ids.split(",")[0] ?? "0";
  const live = localShardIds(client);
  return `process ${pid}, gateway shards ${ids} of ${count} (connected: ${live.join(", ")})`;
}
