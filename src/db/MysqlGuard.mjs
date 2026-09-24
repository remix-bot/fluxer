/**
 * @module src/db/MysqlGuard
 * @description Hardening for mysql2 connection pools against fatal socket
 * errors (read ETIMEDOUT / ECONNRESET / EPIPE) escaping as uncaughtException.
 *
 * ## The problem this solves
 *
 * mysql2's `PoolConnection` registers only `once("error")`. The FIRST error
 * event on a pooled connection is silently consumed (the connection is removed
 * from the pool) — but any SUBSEQUENT `"error"` emission on that same
 * connection object has zero listeners and crashes the whole process with an
 * uncaughtException. This is a real-world scenario: when a NAT/firewall
 * silently drops an idle pooled connection, the next I/O attempt produces a
 * raw `read ETIMEDOUT` (errno -110, fatal: true) that surfaces exactly this
 * way. mysql2's `Pool` itself NEVER emits `"error"`, so pool-level
 * `pool.on("error", ...)` handlers (as used elsewhere in this codebase) do not
 * and cannot catch connection-level socket errors.
 *
 * ## The fix
 *
 * 1. `MYSQL_POOL_DEFAULTS` — spread into every `createPool()` call.
 *    `enableKeepAlive` sends TCP keepalive probes so idle connections survive
 *    NAT/firewall idle timeouts instead of dying silently.
 * 2. `attachMysqlPoolGuard(pool)` — listens on the core pool's
 *    `"connection"` event and attaches a persistent (non-`once`) error
 *    listener to every newly created pooled connection. After mysql2's
 *    internal `once("error")` has done its job (removing the dead connection
 *    from the pool), any further emissions are swallowed instead of crashing
 *    the process. In-flight queries still receive their rejections normally.
 *
 * Both helpers are idempotent (guarded by WeakSets) so they can safely be
 * called twice on the same pool.
 */

import { logger } from "../core/Logger.mjs";

/**
 * @type {object}
 * @description Pool config defaults that prevent idle-connection death.
 * `enableKeepAlive` is the critical one — without TCP keepalive probes, a
 * connection parked in the pool behind a NAT/firewall is silently dropped and
 * the next query on it dies with read ETIMEDOUT.
 */
const MYSQL_POOL_DEFAULTS = {
  enableKeepAlive: true,
  keepAliveInitialDelay: 10_000,
};

/**
 * @type {WeakSet<object>}
 * @description Pools already guarded (core callback pools).
 */
const _guardedPools = new WeakSet();

/**
 * Attach the persistent connection-level error guard to a mysql2 pool.
 * Accepts either a callback-API `Pool` (from `mysql2`) or a `PromisePool`
 * (from `mysql2/promise`) — the core pool is resolved automatically.
 * Idempotent: calling twice on the same pool is a no-op.
 * @param {object} pool - mysql2 Pool or PromisePool instance.
 * @param {string} [label="MySQL"] - Label used in log lines.
 * @param {object} [options={}]
 * @param {number} [options.keepAliveIntervalMs=20000] - How often to ping the pool
 *   with a trivial query to keep at least one connection active. Many shared/cheap
 *   MySQL hosts enforce a `wait_timeout` well under mysql2's own 60s idle default
 *   (error 4031, "disconnected because of inactivity") — a query at this interval
 *   keeps connections from ever sitting idle long enough to get killed server-side.
 *   Set to 0 to disable.
 * @returns {object} The core (callback-API) pool that was guarded.
 */
function attachMysqlPoolGuard(pool, label = "MySQL", { keepAliveIntervalMs = 20_000 } = {}) {
  if (!pool) return pool;
  const corePool = typeof pool.getConnection === "function" && pool.pool && pool.pool.getConnection
    ? pool.pool
    : pool;
  if (!corePool || typeof corePool.on !== "function" || _guardedPools.has(corePool)) {
    return corePool ?? pool;
  }
  _guardedPools.add(corePool);

  corePool.on("connection", (connection) => {
    if (!connection || connection.__mysqlGuardAttached) return;
    connection.__mysqlGuardAttached = true;
    connection.on("error", (err) => {
      logger.warn(
        `[${label}] Pooled MySQL connection error (handled, pool will recycle):`,
        err?.code ?? err?.message ?? err
      );
    });
  });

  corePool.on("error", (err) => {
    logger.error(`[${label}] MySQL pool error:`, err?.code ?? err?.message ?? err);
  });

  if (keepAliveIntervalMs > 0) {
    const timer = setInterval(() => {
      corePool.query("SELECT 1", (err) => {
        if (err) {
          logger.warn(`[${label}] Keepalive ping failed:`, err?.code ?? err?.message ?? err);
        }
      });
    }, keepAliveIntervalMs);
    timer.unref?.();
  }

  return corePool;
}

export { MYSQL_POOL_DEFAULTS, attachMysqlPoolGuard };
export default { MYSQL_POOL_DEFAULTS, attachMysqlPoolGuard };
