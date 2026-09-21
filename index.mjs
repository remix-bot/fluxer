/**
 * @module index
 * @description Entry point for the Remix music bot. Creates the {@link Remix}
 * instance, sets up process-level error handlers, and registers signal-based
 * graceful shutdown. All boot logic lives in src/core/Bot.mjs.
 */

import { logger } from "./src/core/Logger.mjs";
import Remix from "./src/core/Bot.mjs";
import { initErrorChannel, reportCrash } from "./src/core/ErrorChannel.mjs";

const remix = new Remix();

initErrorChannel({ config: remix.config, client: remix.client });

/**
 * Check whether an error is a known-ignorable WebSocket transport crash from
 * the fluxer.js ws or undici internals.
 * @param {Error} err - The error to check.
 * @returns {boolean} True if the error should be silently recovered.
 */
const isIgnorableWsCrash = (err) => {
  const message = String(err?.message ?? err ?? "");
  const stack = String(err?.stack ?? "");
  return message === "WebSocket error" &&
      (
        stack.includes("@fluxerjs/ws/dist/index.mjs") ||
        stack.includes("node:internal/deps/undici/undici")
      );
};

/**
 * Check whether an error is the benign LiveKit "AudioSource is closed" race.
 * Happens when a track is skipped/stopped while @fluxerjs/voice's internal
 * WebM demuxer still has queued frames to push into the just-closed audio
 * source. Harmless by itself — but if it ever surfaces as a synchronous
 * uncaughtException it must NOT take the whole bot down.
 * @param {Error} err - The error to check.
 * @returns {boolean} True if the error is the audio stop-race.
 */
const isBenignAudioStopRace = (err) =>
  String(err?.message ?? err ?? "").includes("AudioSource is closed");

/**
 * @param {Error} err - The error to check.
 * @returns {boolean} True if the error is the stream abort race.
 */
const isBenignStreamAbortRace = (err) =>
  err?.code === "ECONNRESET" && String(err?.message ?? "").includes("aborted");

/**
 * Socket error codes that represent transient transport failures of a single
 * connection (NAT/firewall idle drops, dead upstreams, restarts). Losing one
 * TCP connection is never a reason to take the whole bot down.
 * @type {Set<string>}
 */
const TRANSIENT_SOCKET_CODES = new Set([
  "ETIMEDOUT", "ECONNRESET", "EPIPE", "ECONNABORTED",
  "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN", "EAI_AGAIN",
]);

/**
 * Check whether an error is a raw transport-level socket failure that bubbled
 * out of a library's internals (mysql2 pooled connections, undici, ws, etc.)
 * with no user stack frames involved. The owning library has already recorded
 * the failure in its own state machine (marked the connection dead, destroyed
 * the request...), so continuing to run is safe — crashing is not.
 * Signature example: { errno: -110, code: 'ETIMEDOUT', syscall: 'read',
 * fatal: true } at TCP.onStreamRead.
 * @param {Error} err - The error to check.
 * @returns {boolean} True if the error is a recoverable socket transport error.
 */
const isBenignTransportError = (err) => {
  if (!err || typeof err !== "object") return false;
  if (!TRANSIENT_SOCKET_CODES.has(err.code)) return false;
  if (!err.syscall || !["read", "write", "connect", "getaddrinfo"].includes(err.syscall)) return false;
  const stack = String(err.stack ?? "");
  return !stack.includes("/src/") && !stack.includes("/commands/") && !stack.includes("index.mjs");
};

let _lastWsCrashLog = 0;
let _lastAudioRaceLog = 0;
let _lastTransportLog = 0;
const WS_CRASH_LOG_COOLDOWN = 30_000;

process.on("unhandledRejection", (reason, p) => {
  if (reason?.message?.includes("AudioSource is closed")) return;
  logger.error("[Error_Handling] Unhandled Rejection/Catch");
  logger.error("[Error_Handling] Reason:", reason, p);
  reportCrash("Unhandled Rejection", reason, { fatal: false });
});

process.on("uncaughtException", async (err, origin) => {
  if (isIgnorableWsCrash(err)) {
    const now = Date.now();
    if (now - _lastWsCrashLog > WS_CRASH_LOG_COOLDOWN) {
      _lastWsCrashLog = now;
      logger.warn("[Error_Handling] Suppressed recoverable websocket transport crash (will not re-log for 30s).");
    }
    return;
  }
  if (isBenignAudioStopRace(err)) {
    const now = Date.now();
    if (now - _lastAudioRaceLog > WS_CRASH_LOG_COOLDOWN) {
      _lastAudioRaceLog = now;
      logger.warn("[Error_Handling] Suppressed benign audio stop-race (AudioSource is closed) — track was skipped/stopped mid-frame.");
    }
    return;
  }
  if (isBenignStreamAbortRace(err)) {
    const now = Date.now();
    if (now - _lastAudioRaceLog > WS_CRASH_LOG_COOLDOWN) {
      _lastAudioRaceLog = now;
      logger.warn("[Error_Handling] Suppressed benign stream abort race (aborted/ECONNRESET) — loadstream was destroyed mid-transfer.");
    }
    return;
  }
  if (isBenignTransportError(err)) {
    const now = Date.now();
    if (now - _lastTransportLog > WS_CRASH_LOG_COOLDOWN) {
      _lastTransportLog = now;
      logger.warn("[Error_Handling] Recovered from transient socket transport error (" + (err.code ?? "?") + " on " + (err.syscall ?? "?") + ") — connection-level failure, bot continues running (will not re-log for 30s).");
    }
    return;
  }
  logger.error("[Error_Handling] Uncaught Exception/Catch");
  logger.error("[Error_Handling] Error:", err, origin);
  await reportCrash("Uncaught Exception — bot is restarting", err, { fatal: true });
  process.exit(1);
});

process.on("uncaughtExceptionMonitor", (err, origin) => {
  if (isIgnorableWsCrash(err)) return;
  if (isBenignAudioStopRace(err)) return;
  if (isBenignStreamAbortRace(err)) return;
  if (isBenignTransportError(err)) return;
  logger.error("[Error_Handling] Uncaught Exception/Catch (MONITOR)");
  logger.error("[Error_Handling] Error:", err, origin);
  reportCrash("Uncaught Exception (MONITOR)", err, { fatal: false });
});

/**
 * Graceful shutdown handler: destroys all active players, closes Lavalink,
 * Redis, and Dashboard DB connections, then exits.
 * @async
 * @returns {Promise<void>}
 */
const saveAndExit = async () => {
  logger.recovery("\n[Shutdown] Cleaning up before exit...");
  try {
    await remix.playerState?.saveAllFrom?.(remix.players);
  } catch (e) {
    logger.warn("[Shutdown] Player state save failed:", e?.message);
  }
  try {
    if (remix.players?.playerMap) {
      for (const [channelId, player] of remix.players.playerMap) {
        try { player.destroy(); } catch (e) { logger.warn("[Shutdown] Player destroy error:", e?.message); }
      }
      remix.players.playerMap.clear();
    }
  } catch (e) {
    logger.warn("[Shutdown] Player cleanup error:", e?.message);
  }
  try {
    if (remix.lavalink) {
      remix.lavalink.destroy();
    }
  } catch (e) {
    logger.warn("[Shutdown] Lavalink cleanup error:", e?.message);
  }
  try {
    if (remix.dashboard?.redis?.destroy) {
      await remix.dashboard.redis.destroy();
    }
  } catch (e) {
    logger.error("[Shutdown] Failed to close Redis:", e.message);
  }
  try {
    if (remix.dashboard?.db?.close) {
      await remix.dashboard.db.close();
    }
  } catch (e) {
    logger.error("[Shutdown] Failed to close Dashboard DB:", e.message);
  }
  try {
    remix.gatewayHandler?.stop247Watchdog?.();
  } catch (e) {
    logger.warn("[Shutdown] Watchdog stop error:", e?.message);
  }
  try {
    if (remix.settingsMgr?.shutdown) {
      await remix.settingsMgr.shutdown();
    }
  } catch (e) {
    logger.error("[Shutdown] Settings flush failed:", e.message);
  }
  process.exit(0);
};

process.once("SIGINT",  saveAndExit);
process.once("SIGTERM", saveAndExit);
process.once("SIGUSR2", saveAndExit);

process.on("SIGPIPE", () => {});
