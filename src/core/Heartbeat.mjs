/**
 * @module src/core/Heartbeat
 * @description Liveness heartbeat for the container HEALTHCHECK.
 *
 * The old healthcheck was `pgrep -f "node .*index.mjs"`, which (a) needs `procps`, not present in
 * the slim Node image, and (b) can only say "the process exists", never "the bot is working". This
 * writes a timestamp to a file every few seconds, but only while the Node event loop is actually
 * running timers AND the bot is logged in. `docker/healthcheck.mjs` fails when the file is missing
 * or stale, so a blocked event loop or a bot that never logged in now shows up as unhealthy.
 * It does nothing unless HEARTBEAT_FILE is set (the Dockerfile sets it).
 */
import { writeFile } from "node:fs";

/**
 * @param {object} [o]
 * @param {string} [o.file=process.env.HEARTBEAT_FILE] - Heartbeat file; no file means no heartbeat.
 * @param {number} [o.intervalMs=15000]
 * @param {() => boolean} [o.isReady] - Only beat while this returns true (e.g. "logged in").
 * @param {() => number} [o.now]
 * @returns {NodeJS.Timeout|null} The (unref'd) interval, or null when disabled.
 */
export function startHeartbeat({ file = process.env.HEARTBEAT_FILE, intervalMs = 15_000, isReady = () => true, now = Date.now } = {}) {
  if (!file) return null;
  const beat = () => {
    let ready = false;
    try { ready = Boolean(isReady()); } catch (_) {}
    if (ready) writeFile(file, String(now()), () => {});
  };
  beat();
  const timer = setInterval(beat, intervalMs);
  timer.unref?.();
  return timer;
}

export default { startHeartbeat };
