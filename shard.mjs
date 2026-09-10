/**
 * @module shard
 * @description Opt-in process-level sharding supervisor for the Remix music
 * bot, built on @fluxerjs/sharding 3.0 (beta).
 *
 * Forks one child process per shard slice; every child runs the standard
 * `index.mjs` boot path, attaches the child-side ShardClientUtil before
 * login (see src/core/Bot.mjs), and reports readiness over IPC. The manager
 * owns the shared per-IP IDENTIFY budget so children never collectively
 * exceed the gateway's identify limit.
 *
 * Usage:
 *   node shard.mjs            (or `npm run shard`)
 *
 * Single-process operation (`npm start` / `node index.mjs`) is unchanged and
 * remains the default — sharding is purely additive.
 *
 * Configuration (config.json, optional `sharding` object):
 *   {
 *     "sharding": {
 *       "totalShards":     4,      // gateway shards across all children
 *       "shardsPerProcess": 2,     // gateway shards per child process
 *       "respawn":          true,  // restart dead children
 *       "spawnTimeout":     30000, // ms to wait for a child's ready IPC
 *       "spawnDelay":       5000   // ms between successive spawns
 *     }
 *   }
 *
 * Environment overrides (win over config.json — handy for Docker):
 *   FLUXER_TOTAL_SHARDS, FLUXER_SHARDS_PER_PROCESS
 *
 * Notes:
 *   - DMs and guild-less events only reach shard 0 (Fluxer limitation).
 *   - Prefer an explicit totalShards number: Fluxer's /gateway/bot always
 *     reports `shards: 1`, so `'auto'` is not offered here.
 *   - The FLUXER_SHARD_* / FLUXER_TOKEN env vars are set by the manager on
 *     its children — never export them manually.
 */

import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { ShardingManager } from "@fluxerjs/sharding";
import { logger } from "./src/core/Logger.mjs";

/**
 * Load config.json with the same fatal-error semantics as src/core/Bot.mjs.
 * @returns {{token: string, sharding?: object}} The parsed config.
 */
function loadConfig() {
  let config;
  try {
    config = JSON.parse(fs.readFileSync("config.json", "utf8"));
  } catch (e) {
    const reason = e.code === "ENOENT"
        ? "config.json not found. Copy config_example.json → config.json and fill in your values."
        : `config.json is malformed JSON: ${e.message}`;
    console.error(`[Sharding] FATAL: ${reason}`);
    process.exit(1);
  }
  if (config.token == null) {
    console.error('[Sharding] FATAL: config.json is missing required key "token".');
    process.exit(1);
  }
  return config;
}

/**
 * Read a positive integer from an env var (undefined when unset/invalid).
 * @param {string} name - The env var name.
 * @returns {number|undefined}
 */
function envPositiveInt(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/**
 * Read a positive integer from the sharding config with a default.
 * @param {object} shardingCfg - The config's `sharding` object.
 * @param {string} key - The key to read.
 * @param {number} fallback - Default value.
 * @returns {number}
 */
function cfgPositiveInt(shardingCfg, key, fallback) {
  const n = Number(shardingCfg?.[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const config       = loadConfig();
const shardingCfg  = config.sharding ?? {};

const totalShards      = envPositiveInt("FLUXER_TOTAL_SHARDS")
    ?? cfgPositiveInt(shardingCfg, "totalShards", 1);
const shardsPerProcess = envPositiveInt("FLUXER_SHARDS_PER_PROCESS")
    ?? cfgPositiveInt(shardingCfg, "shardsPerProcess", 1);
const respawn          = shardingCfg.respawn !== false;
const spawnTimeout     = cfgPositiveInt(shardingCfg, "spawnTimeout", 30_000);
const spawnDelay       = Math.max(0, Number(shardingCfg.spawnDelay) >= 0 ? Number(shardingCfg.spawnDelay) : 5_000);

const entryFile = fileURLToPath(new URL("./index.mjs", import.meta.url));

const manager = new ShardingManager(entryFile, {
  token: config.token,
  totalShards,
  shardsPerProcess,
  respawn,
  spawnTimeout,
  spawnDelay,
});

manager.on("shardCreate", (shard) => {
  logger.player(`[Sharding] Spawning shard process ${shard.id} (gateway shards ${shard.shardIds.join(", ")})...`);
});
manager.on("shardReady", (shard) => {
  logger.player(`[Sharding] Shard process ${shard.id} ready (gateway shards ${shard.shardIds.join(", ")}).`);
});
manager.on("shardDeath", (shard, info) => {
  logger.warn(
    `[Sharding] Shard process ${shard.id} died (code=${info?.code} signal=${info?.signal})` +
    `${respawn ? " — respawning" : ""}.`
  );
});
manager.on("error", (err) => {
  logger.error("[Sharding] Manager error:", err?.message ?? err);
});

/** Graceful shutdown: destroy all children, then exit.
 * @param {string} sig - The received signal name. */
let shuttingDown = false;
const shutdown = async (sig) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.recovery(`\n[Sharding] ${sig} received — destroying shard processes...`);
  try {
    await manager.destroy();
  } catch (e) {
    logger.warn("[Sharding] destroy error:", e?.message);
  }
  process.exit(0);
};
process.once("SIGINT",  () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGPIPE", () => {});

manager.spawn().then((shards) => {
  logger.player(
    `[Sharding] ${shards.size} shard process(es) online — ${totalShards} gateway shard(s), ` +
    `${shardsPerProcess} per process (respawn ${respawn ? "on" : "off"}).`
  );
}).catch((e) => {
  logger.error("[Sharding] Spawn failed:", e?.message ?? e);
  process.exit(1);
});
