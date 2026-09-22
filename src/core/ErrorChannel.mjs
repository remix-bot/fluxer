/**
 * @module src/core/ErrorChannel
 * @description Forward runtime errors, warnings and fatal crash reports to a
 * designated Fluxer channel, so the owner sees problems (player failures,
 * node disconnects, database errors, crashes) without reading container logs.
 *
 * Three forwarding layers:
 *  1. Logger tap: wraps logger.error, (optionally) logger.warn and
 *     (opt-in via forwardInfo) logger.info so every existing error site in
 *     the codebase is covered without touching call sites. The logger's
 *     built-in storm gate already collapses identical repeated lines before
 *     they reach this tap.
 *  2. Crash reports: explicit reportCrash() calls from the process-level
 *     handlers in index.mjs. These bypass the queue and send immediately —
 *     REST keeps working even when the gateway connection is down — with a
 *     bounded timeout so the fatal-exit path is never stalled.
 *  3. Startup confirmation: when enabled (startupMessage, default true), a
 *     one-time "Log channel connected" message is sent through the real
 *     send path at boot, so the owner immediately sees that forwarding works
 *     — and gets an explicit console hint when the channel ID or bot
 *     permissions are wrong instead of silent silence.
 *
 * Messages are sent through client.rest.post when available, with a raw
 * fetch fallback (Authorization: Bot <token>) for very early crashes before
 * the REST client exists. A queue with a minimum send interval plus drop
 * counting keeps the channel and API rate limits safe. Every failure inside
 * this module is swallowed: error reporting must never cause a crash or
 * alter runtime behavior.
 */

import util from "node:util";
import { logger } from "./Logger.mjs";

const API_BASE = "https://api.fluxer.app/v1";
const SEND_TIMEOUT_MS = 5_000;
const CRASH_SEND_BUDGET_MS = 3_500;
const FORWARD_DEDUP_MS = 60_000;
const CRASH_DEDUP_MS = 30_000;
const FAIL_LOG_COOLDOWN_MS = 30_000;
const CONTENT_MAX = 1_900;
const BODY_MAX = 1_500;

let _enabled = false;
let _channelId = null;
let _token = null;
let _client = null;
let _minIntervalMs = 1_500;
let _maxQueue = 40;

let _queue = [];
let _dropped = 0;
let _flushing = false;
let _announced = false;

const _forwardDedup = new Map();
const _crashDedup = new Map();
let _lastFailLog = 0;

const _originals = { error: null, warn: null, info: null };

/**
 * Initialize the channel reporter from config. Safe to call once at boot;
 * subsequent calls only refresh options and never double-wrap the logger.
 * @param {object} [opts]
 * @param {object} [opts.config] - Full bot configuration (uses config.errorLogChannel and config.token).
 * @param {object} [opts.client] - The Fluxer client (provides client.rest.post for sending).
 */
export function initErrorChannel({ config, client } = {}) {
  const cfg = config?.errorLogChannel ?? {};
  _channelId = typeof cfg.channelId === "string" && cfg.channelId.trim() ? cfg.channelId.trim() : null;
  _enabled = cfg.enabled === true && Boolean(_channelId);
  _token = typeof config?.token === "string" ? config.token : null;
  _client = client ?? null;
  _minIntervalMs = Number(cfg.minIntervalMs) > 0 ? Number(cfg.minIntervalMs) : 1_500;
  _maxQueue = Number(cfg.maxQueue) > 0 ? Number(cfg.maxQueue) : 40;

  if (!_enabled) {
    console.info(`[ErrorChannel] Disabled (${!_channelId ? "no channelId configured" : "enabled=false"}).`);
    return;
  }
  const forwardWarn = cfg.forwardWarn !== false;
  const forwardInfo = cfg.forwardInfo === true;
  if (!_originals.error) _tapLogger(forwardWarn, forwardInfo);
  console.info(`[ErrorChannel] Active — forwarding errors${forwardWarn ? " + warnings" : ""}${forwardInfo ? " + info" : ""} to channel ${_channelId}.`);
  if (cfg.startupMessage !== false) _announceOnce();
}

/**
 * Whether the channel reporter is currently active (enabled=true and a
 * channelId is configured). Used by the logtest command for its status reply.
 * @returns {boolean} True when forwarding is active.
 */
export function isLogChannelEnabled() {
  return _enabled && Boolean(_channelId);
}

/** @private Send the one-time startup confirmation through the real send path. */
function _announceOnce() {
  if (_announced) return;
  _announced = true;
  const content =
    "✅ **Log channel connected** — from now on this channel receives:\n" +
    "🔴 every error · 🟡 every warning · 🚨 crash reports (with uptime + memory)\n" +
    "Verify delivery any time with the `logtest` command.";
  _sendWithFallback(content).catch((e) => {
    console.error(
      `[ErrorChannel] Startup notice FAILED for channel ${_channelId}: ${e?.message ?? e}` +
      " — check that the bot has View Channel + Send Messages permission there and that errorLogChannel.channelId is correct."
    );
  });
}

/**
 * Report a process-level event (crash, unhandled rejection, monitor catch).
 * Bypasses the queue, deduplicates identical errors within a short window
 * (prevents double-sends between the fatal handler and the MONITOR handler),
 * and resolves within a bounded timeout so fatal paths can still exit.
 * @async
 * @param {string} title - Event headline shown in the channel.
 * @param {*} err - The error (any value; formatted like console would).
 * @param {object} [opts]
 * @param {boolean} [opts.fatal=false] - True when the bot is about to exit.
 * @returns {Promise<boolean>} True when the message was delivered.
 */
export async function reportCrash(title, err, { fatal = false } = {}) {
  if (!_enabled || !_channelId) return false;
  try {
    const body = _formatArgs([err]).split("```").join("‹›");
    const now = Date.now();
    const key = body.slice(0, 300);
    if (_crashDedup.get(key) && now - _crashDedup.get(key) < CRASH_DEDUP_MS) return false;
    _crashDedup.set(key, now);
    if (_crashDedup.size > 100) _crashDedup.delete(_crashDedup.keys().next().value);

    const mem = Math.round(process.memoryUsage().rss / 1_048_576);
    const content =
      `${fatal ? "🚨" : "⚠️"} **${title}**\n${body.slice(0, BODY_MAX)}\n— uptime ${_uptime()} · rss ${mem}MB`
        .slice(0, CONTENT_MAX);

    try {
      await Promise.race([_sendWithFallback(content), _sleep(CRASH_SEND_BUDGET_MS)]);
      return true;
    } catch (_) {
      return false;
    }
  } catch (_) {
    return false;
  }
}

/**
 * Restore the untouched logger methods and clear all state (tests only).
 * @returns {void}
 */
export function _resetErrorChannelForTests() {
  if (_originals.error) logger.error = _originals.error;
  if (_originals.warn) logger.warn = _originals.warn;
  if (_originals.info) logger.info = _originals.info;
  _originals.error = null;
  _originals.warn = null;
  _originals.info = null;
  _announced = false;
  _enabled = false;
  _channelId = null;
  _token = null;
  _client = null;
  _queue = [];
  _dropped = 0;
  _flushing = false;
  _forwardDedup.clear();
  _crashDedup.clear();
}

/** @private Wrap the shared logger methods so all existing error sites forward automatically. */
function _tapLogger(forwardWarn, forwardInfo = false) {
  _originals.error = logger.error;
  logger.error = function (tag, ...args) {
    _originals.error(tag, ...args);
    _forward("error", tag, args);
  };
  if (forwardWarn) {
    _originals.warn = logger.warn;
    logger.warn = function (tag, ...args) {
      _originals.warn(tag, ...args);
      _forward("warn", tag, args);
    };
  }
  if (forwardInfo && typeof logger.info === "function") {
    _originals.info = logger.info;
    logger.info = function (tag, ...args) {
      _originals.info(tag, ...args);
      _forward("info", tag, args);
    };
  }
}

/** @private Forward one emitted log line into the queue (with dedup + self-exclusion). */
function _forward(level, tag, args) {
  try {
    if (typeof tag !== "string") return;
    if (tag.startsWith("[ErrorChannel]") || tag.startsWith("[Error_Handling]")) return;
    const body = _formatArgs(args);
    const now = Date.now();
    const emoji = level === "error" ? "🔴" : level === "info" ? "ℹ️" : "🟡";
    const text = body ? `${emoji} **${tag}** ${body}` : `${emoji} **${tag}**`;
    const key = `${level}|${tag}|${(body || tag).slice(0, 200)}`;
    const last = _forwardDedup.get(key);
    if (last && now - last < FORWARD_DEDUP_MS) return;
    _forwardDedup.set(key, now);
    if (_forwardDedup.size > 300) _forwardDedup.delete(_forwardDedup.keys().next().value);
    _enqueue(text.slice(0, CONTENT_MAX));
  } catch (_) { }
}

/** @private Format values the same way console would. */
function _formatArgs(args) {
  try {
    return util.format(...args).trim();
  } catch (_) {
    return "";
  }
}

/** @private Add a message to the bounded send queue and start the flusher. */
function _enqueue(content) {
  if (_queue.length >= _maxQueue) {
    _dropped++;
    return;
  }
  _queue.push(content);
  if (!_flushing) _runFlush();
}

/** @private Drain the queue with rate-limit spacing, then report any dropped flood messages. */
async function _runFlush() {
  _flushing = true;
  try {
    while (_queue.length > 0) {
      const content = _queue.shift();
      await _sendQuietly(content);
      await _sleep(_minIntervalMs);
    }
    if (_dropped > 0) {
      const n = _dropped;
      _dropped = 0;
      await _sendQuietly(`📦 ${n} additional error log message(s) were dropped during a flood to protect rate limits.`);
    }
  } finally {
    _flushing = false;
  }
}

/** @private Send a queued message, swallowing and cooldown-logging failures. */
async function _sendQuietly(content) {
  try {
    await _sendWithFallback(content);
  } catch (e) {
    const now = Date.now();
    if (now - _lastFailLog > FAIL_LOG_COOLDOWN_MS) {
      _lastFailLog = now;
      console.error(`[ErrorChannel] Send failed: ${e?.message ?? e}`);
    }
  }
}

/** @private Send through the client's REST client when available, else raw fetch. */
async function _send(content) {
  const rest = _client?.rest;
  if (typeof rest?.post === "function") {
    await rest.post(`/channels/${_channelId}/messages`, { body: { content } });
    return;
  }
  await _sendRaw(content);
}

/** @private Send via client REST, retrying once via raw fetch when that throws. */
async function _sendWithFallback(content) {
  try {
    await _send(content);
  } catch (_) {
    await _sendRaw(content);
  }
}

/** @private Send via a direct Fluxer REST call (Authorization: Bot <token>). */
async function _sendRaw(content) {
  const res = await fetch(`${API_BASE}/channels/${_channelId}/messages`, {
    method: "POST",
    headers: { "Authorization": `Bot ${_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Fluxer API HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
}

/** @private Human-readable process uptime. */
function _uptime() {
  const s = Math.floor(process.uptime());
  const h = Math.floor(s / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

/** @private Sleep that never keeps the event loop alive by itself. */
function _sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
