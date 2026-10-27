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
import { EmbedBuilder } from "@fluxerjs/core";
import { logger } from "./Logger.mjs";

const DEFAULT_API_BASE = "https://api.fluxer.app/v1";
const SEND_TIMEOUT_MS = 5_000;
const CRASH_SEND_BUDGET_MS = 3_500;
const FORWARD_DEDUP_MS = 60_000;
const CRASH_DEDUP_MS = 30_000;
const FAIL_LOG_COOLDOWN_MS = 30_000;
const CONTENT_MAX = 1_900;
const BODY_MAX = 1_500;

let _apiBase = DEFAULT_API_BASE;
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

let _forwardDedup = new Map();
let _crashDedup = new Map();
let _lastFailLog = 0;
let _rateLimitedUntil = 0;
let _consecutiveFailures = 0;
let _lastCrashReportTime = 0;
const CRASH_MIN_INTERVAL_MS = 5_000;
const MAX_CONSECUTIVE_FAILURES = 5;

/** @private Check if we are currently rate-limited before sending. */
function _isRateLimited() {
  return Date.now() < _rateLimitedUntil;
}

/** @private Apply an explicit rate-limit backoff delay. */
function _applyRateLimit(seconds = 15) {
  const ms = Math.max(10_000, Number(seconds) * 1_000);
  _rateLimitedUntil = Date.now() + ms;
  console.warn(`[ErrorChannel] Rate limit (429) active — backing off all error channel sends for ${Math.round(ms / 1000)}s.`);
}

/** @private Handle permanent permission failures (403/404) by permanently disabling the reporter. */
function _disablePermissionFailure(status) {
  _enabled = false;
  _queue = [];
  console.error(`[ErrorChannel] FATAL: Bot lacks permission (HTTP ${status}) for channel ${_channelId}. ErrorChannel has been PERMANENTLY DISABLED to prevent API flooding.`);
}

const _originals = { error: null, warn: null, info: null };

/**
 * Initialize the channel reporter from config. Safe to call once at boot;
 * subsequent calls only refresh options and never double-wrap the logger.
 * @param {object} [opts]
 * @param {object} [opts.config] - Full bot configuration (uses config.errorLogChannel and config.token).
 * @param {object} [opts.client] - The Fluxer client (provides client.rest.post for sending).
 */
export function initErrorChannel({ config, client, locale } = {}) {
  const cfg = config?.errorLogChannel ?? {};
  _channelId = typeof cfg.channelId === "string" && cfg.channelId.trim() ? cfg.channelId.trim() : null;
  _enabled = cfg.enabled === true && Boolean(_channelId);
  _token = typeof config?.token === "string" ? config.token : null;
  _client = client ?? null;
  _locale = locale ?? client?.locale ?? null;
  _minIntervalMs = Number(cfg.minIntervalMs) > 0 ? Number(cfg.minIntervalMs) : 1_500;
  _maxQueue = Number(cfg.maxQueue) > 0 ? Number(cfg.maxQueue) : 40;

  const customBase = config?.apiBase ?? config?.["fluxer.js"]?.api ?? client?.options?.rest?.api ?? null;
  if (typeof customBase === "string" && customBase.trim()) {
    const trimmed = customBase.trim().replace(/\/+$/, "");
    _apiBase = trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
  } else {
    _apiBase = DEFAULT_API_BASE;
  }

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
/**
 * @private
 * Resolve a localized string from the bot's configured locale or fallback.
 * @param {string} key
 * @param {Object} [vars={}]
 * @param {string} [fallback=""]
 * @returns {string}
 */
function _t(key, vars = {}, fallback = "") {
  try {
    if (_locale && typeof _locale.translate === "function") {
      const res = _locale.translate(null, `responses.errorChannel.${key}`, vars);
      if (res && res !== `responses.errorChannel.${key}`) return res;
    }
  } catch (_) { }
  return fallback;
}

function _announceOnce() {
  if (_announced) return;
  _announced = true;
  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setAuthor({ name: _t("author", {}, "🛠️ Error Channel Telemetry") })
    .setTitle(`✅ ${_t("connectedTitle", {}, "Log Channel Connected")}`)
    .setDescription(_t("connectedDesc", {},
      "Real-time diagnostic and crash forwarding is now active for this channel.\n\n" +
      "🔴 **Errors:** Database, player, audio node, and gateway exceptions\n" +
      "🟡 **Warnings:** Rate-limits, recoverable reconnections, and warnings\n" +
      "🚨 **Crash Reports:** Fatal process exceptions with memory and uptime stats"
    ))
    .setFooter({ text: _t("connectedFooter", {}, "Remix Watchdog • Verify delivery anytime with %logtest") });
  if (typeof embed.setTimestamp === "function") embed.setTimestamp();

  _sendWithFallback(embed).catch((e) => {
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
  if (!_enabled || !_channelId || _isRateLimited()) return false;
  const now = Date.now();
  if (now - _lastCrashReportTime < CRASH_MIN_INTERVAL_MS) {
    return false;
  }
  _lastCrashReportTime = now;
  try {
    const body = _formatArgs([err]).split("```").join("‹›");
    const key = body.slice(0, 300);
    if (_crashDedup.get(key) && now - _crashDedup.get(key) < CRASH_DEDUP_MS) return false;
    _crashDedup.set(key, now);
    if (_crashDedup.size > 100) _crashDedup.delete(_crashDedup.keys().next().value);

    const mem = Math.round(process.memoryUsage().rss / 1_048_576);
    const embedColor = fatal ? 0xe74c3c : 0xf39c12;
    const authorTitle = fatal
      ? _t("crashFatalAuthor", {}, "🚨 Fatal Process Crash")
      : _t("crashAlertAuthor", {}, "⚠️ Process Alert");
    const embedTitle = fatal
      ? _t("crashFatalTitle", { title }, `🚨 Fatal Crash: ${title}`)
      : _t("crashAlertTitle", { title }, `⚠️ Process Alert: ${title}`);

    const embed = new EmbedBuilder()
      .setColor(embedColor)
      .setAuthor({ name: authorTitle })
      .setTitle(embedTitle)
      .setDescription("```js\n" + body.slice(0, 1800) + "\n```")
      .addFields(
        { name: _t("uptimeField", {}, "⏱️ Uptime"), value: `\`${_uptime()}\``, inline: true },
        { name: _t("memoryField", {}, "💾 Memory (RSS)"), value: `\`${mem} MB\``, inline: true }
      )
      .setFooter({ text: _t("crashFooter", {}, "Process Error Telemetry • Unhandled Exception") });
    if (typeof embed.setTimestamp === "function") embed.setTimestamp();

    try {
      const delivered = await Promise.race([
        _sendWithFallback(embed).then(() => true),
        _sleep(CRASH_SEND_BUDGET_MS).then(() => false),
      ]);
      return Boolean(delivered);
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
  _locale = null;
  _apiBase = DEFAULT_API_BASE;
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
    const key = `${level}|${tag}|${(body || tag).slice(0, 200)}`;
    const last = _forwardDedup.get(key);
    if (last && now - last < FORWARD_DEDUP_MS) return;
    _forwardDedup.set(key, now);
    if (_forwardDedup.size > 300) _forwardDedup.delete(_forwardDedup.keys().next().value);

    const color = level === "error" ? 0xe74c3c : level === "info" ? 0x3498db : 0xf1c40f;
    const author = level === "error"
      ? _t("forwardErrorAuthor", {}, "🔴 System Error")
      : level === "info"
        ? _t("forwardInfoAuthor", {}, "ℹ️ System Info")
        : _t("forwardWarnAuthor", {}, "🟡 System Warning");

    let desc;
    if (body) {
      desc = body.length > 200
        ? "```\n" + body.slice(0, 3900) + "\n```"
        : `**${body}**`;
    } else {
      desc = _t("forwardNoDetails", {}, "*No additional details provided.*");
    }

    const embed = new EmbedBuilder()
      .setColor(color)
      .setAuthor({ name: author })
      .setTitle(tag)
      .setDescription(desc)
      .setFooter({ text: _t("forwardFooter", {}, "Logger Telemetry • Automatic Forwarding") });
    if (typeof embed.setTimestamp === "function") embed.setTimestamp();

    _enqueue(embed);
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
      if (!_enabled) {
        _queue = [];
        break;
      }
      if (_isRateLimited()) {
        const waitMs = Math.max(1_000, _rateLimitedUntil - Date.now() + 500);
        await _sleep(waitMs);
        continue;
      }
      const content = _queue.shift();
      await _sendQuietly(content);
      await _sleep(_minIntervalMs);
    }
    if (_dropped > 0 && _enabled) {
      const n = _dropped;
      _dropped = 0;
      const floodEmbed = new EmbedBuilder()
        .setColor(0xe67e22)
        .setAuthor({ name: _t("floodAuthor", {}, "📦 Log Flood Gate") })
        .setTitle(_t("floodTitle", {}, "Log Messages Dropped"))
        .setDescription(_t("floodDesc", { count: n }, `⚠️ **${n}** additional log message(s) were dropped during a flood to protect API rate limits.`))
        .setFooter({ text: _t("floodFooter", {}, "Rate Limit Guard • ErrorChannel") });
      if (typeof floodEmbed.setTimestamp === "function") floodEmbed.setTimestamp();
      await _sendQuietly(floodEmbed);
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

/**
 * @private
 * Normalize a send payload into { content, embeds } format expected by Fluxer API.
 * @param {string|object|EmbedBuilder} data
 * @returns {object}
 */
function _normalizePayload(data) {
  if (data instanceof EmbedBuilder) {
    const raw = typeof data.toJSON === "function" ? data.toJSON() : data;
    return { embeds: [raw] };
  }
  if (data && typeof data === "object") {
    if (Array.isArray(data.embeds)) {
      const rawEmbeds = data.embeds.map(e => (typeof e?.toJSON === "function" ? e.toJSON() : e));
      return { ...data, embeds: rawEmbeds };
    }
    if (data.embed) {
      const raw = typeof data.embed.toJSON === "function" ? data.embed.toJSON() : data.embed;
      return { embeds: [raw] };
    }
    return data;
  }
  return { content: String(data ?? "") };
}

/** @private Send through the client's REST client when available, else raw fetch. */
async function _send(payload) {
  if (!_enabled || _isRateLimited()) return;
  const rest = _client?.rest;
  const body = _normalizePayload(payload);
  if (typeof rest?.post === "function") {
    try {
      await rest.post(`/channels/${_channelId}/messages`, { body });
      _consecutiveFailures = 0;
      return;
    } catch (err) {
      const status = err?.statusCode ?? err?.status;
      if (status === 403 || status === 404) {
        _disablePermissionFailure(status);
        throw err;
      }
      if (status === 429) {
        const retryAfter = err?.retryAfter ?? 15;
        _applyRateLimit(retryAfter);
        throw err;
      }
      throw err;
    }
  }
  await _sendRaw(payload);
}

/** @private Send via client REST, retrying once via raw fetch when that throws. */
async function _sendWithFallback(payload) {
  if (!_enabled || _isRateLimited()) return;
  try {
    await _send(payload);
  } catch (_) {
    if (!_enabled || _isRateLimited()) return;
    await _sendRaw(payload);
  }
}

/** @private Send via a direct Fluxer REST call (Authorization: Bot <token>). */
async function _sendRaw(payload) {
  if (!_enabled || !_token || _isRateLimited()) return;
  const body = _normalizePayload(payload);
  let res;
  try {
    res = await fetch(`${_apiBase}/channels/${_channelId}/messages`, {
      method: "POST",
      headers: { "Authorization": `Bot ${_token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (err) {
    _consecutiveFailures++;
    if (_consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      _applyRateLimit(30);
    }
    throw err;
  }

  if (res.status === 403 || res.status === 404) {
    _disablePermissionFailure(res.status);
    throw new Error(`Fluxer API HTTP ${res.status}: Permission denied or channel not found`);
  }

  if (res.status === 429) {
    const rawRetry = res.headers.get("retry-after");
    const retrySec = Number(rawRetry) || 15;
    _applyRateLimit(retrySec);
    throw new Error(`Fluxer API HTTP 429: Rate limited, retry after ${retrySec}s`);
  }

  if (!res.ok) {
    _consecutiveFailures++;
    if (_consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      _applyRateLimit(30);
    }
    const text = await res.text().catch(() => "");
    throw new Error(`Fluxer API HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  _consecutiveFailures = 0;
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
