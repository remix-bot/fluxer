/**
 * @module src/db/PoolManager
 * @description Centralized MySQL connection pool manager for the Remix bot.
 * Provides a single shared connection pool instance across all services (Settings,
 * TrackOptions, Last.fm, Dashboard, PlayerStateStore), preventing connection exhaustion.
 * Supports both callback-style queries and Promise-based execution via `pool.promise()`.
 */

import mysql from "mysql2";
import { MYSQL_POOL_DEFAULTS, attachMysqlPoolGuard } from "./MysqlGuard.mjs";
import { logger } from "../core/Logger.mjs";

/** @type {import('mysql2').Pool|null} */
let _sharedPool = null;

/** @type {import('mysql2/promise').Pool|null} */
let _sharedPromisePool = null;

/**
 * Get or create the shared MySQL callback-style pool.
 * If config is omitted, returns the existing pool if one was already initialized.
 * @param {object} [config] - MySQL configuration (host, user, password, database, connectionLimit, etc.)
 * @returns {import('mysql2').Pool}
 */
export function getSharedMysqlPool(config = null) {
  if (_sharedPool) return _sharedPool;
  if (!config || !config.host) {
    throw new Error("[PoolManager] Cannot initialize MySQL pool: missing host or config.");
  }
  const connectionLimit = Number(config.connectionLimit) > 0 ? Number(config.connectionLimit) : 15;
  const poolConfig = {
    ...MYSQL_POOL_DEFAULTS,
    ...config,
    connectionLimit,
  };

  _sharedPool = mysql.createPool(poolConfig);
  attachMysqlPoolGuard(_sharedPool, "SharedMySQL");
  _sharedPool.on("error", (err) => {
    logger.error("[MySQL] Shared pool error:", err.code ?? err.message);
  });
  logger.db?.(`[PoolManager] Initialized shared MySQL pool (connectionLimit=${connectionLimit}).`);
  return _sharedPool;
}

/**
 * Get the Promise-based wrapper around the shared MySQL pool (`pool.promise()`).
 * Shares the exact same underlying connections as the callback pool.
 * @param {object} [config] - MySQL configuration if not yet initialized.
 * @returns {import('mysql2/promise').Pool}
 */
export function getSharedPromisePool(config = null) {
  if (_sharedPromisePool) return _sharedPromisePool;
  const pool = getSharedMysqlPool(config);
  _sharedPromisePool = pool.promise();
  return _sharedPromisePool;
}

/**
 * Gracefully close the shared MySQL pool on shutdown.
 * @returns {Promise<void>}
 */
export async function closeSharedMysqlPool() {
  if (_sharedPool) {
    try {
      await new Promise((resolve) => _sharedPool.end(() => resolve()));
      logger.recovery?.("[PoolManager] Shared MySQL pool closed.");
    } catch (e) {
      logger.warn?.("[PoolManager] Error closing shared MySQL pool:", e?.message);
    }
    _sharedPool = null;
    _sharedPromisePool = null;
  }
}
