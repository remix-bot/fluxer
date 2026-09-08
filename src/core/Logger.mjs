/** @module src/core/Logger */

/** @private */
let _config = null;

/**
 * Initialize the logger with a configuration object.
 * @param {object} [config] - Application configuration object.
 * @param {object} [config.logging] - Logging-specific configuration.
 */
export function initLogger(config) {
  _config = config?.logging ?? {};
}

/**
 * Check whether a given log category is enabled.
 * @private
 * @param {string} category - The log category name (e.g. "player", "voice").
 * @returns {boolean} `true` if the category is enabled (or no config is loaded).
 */
function isEnabled(category) {
  if (!_config) return true;
  if (_config.enabled === false) return false;
  return _config[category] !== false;
}

/**
 * Return an ISO-8601 timestamp string truncated to seconds.
 * @private
 * @returns {string} Timestamp in `YYYY-MM-DD HH:MM:SS` format.
 */
function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

/**
 * Cooldown state for WebSocket error logging to avoid spam.
 * @type {{ lastLogged: number, COOLDOWN_MS: number }}
 */
export const _wsErrorCooldown = { lastLogged: 0, COOLDOWN_MS: 15_000 };

/**
 * Log-storm suppression for identical repeated `error`/`warn` lines.
 * The first occurrence is always emitted; identical repeats within a 60s
 * window are counted silently, and once per window a single pulse line with
 * the repeat count is emitted instead. Bounds worst-case volume of any hot
 * retry loop to one line per minute instead of millions.
 * @private
 * @type {Map<string, {n: number, start: number}>}
 */
const _stormGuard = new Map();
const STORM_WINDOW_MS = 60_000;
const STORM_MAX_KEYS = 128;

/**
 * Decide whether an error/warn line should be emitted, and with what suffix.
 * @private
 * @param {string} level - Log level ("error" | "warn").
 * @param {string} tag - Caller tag (e.g. "[Redis/Main]").
 * @param {Array<*>} args - Message arguments.
 * @returns {{emit: boolean, suffix: string}} Whether to emit, and the pulse suffix.
 */
function _stormGate(level, tag, args) {
  const key = level + "|" + tag + "|" + args.map(a => (typeof a === "string" ? a : String(a))).join(" ");
  const now = Date.now();
  const st = _stormGuard.get(key);
  if (st === undefined) {
    if (_stormGuard.size >= STORM_MAX_KEYS) {
      // Evict the oldest key to bound memory.
      _stormGuard.delete(_stormGuard.keys().next().value);
    }
    _stormGuard.set(key, { n: 0, start: now });
    return { emit: true, suffix: "" };
  }
  st.n++;
  if (now - st.start >= STORM_WINDOW_MS) {
    const n = st.n;
    st.n = 0;
    st.start = now;
    return { emit: true, suffix: `── identical line suppressed ${n}x in the last 60s` };
  }
  return { emit: false, suffix: "" };
}

/**
 * Reset the log-storm suppression state (used by tests).
 * @returns {void}
 */
export function _resetStormGuard() {
  _stormGuard.clear();
}

/**
 * Structured logger exposing category-gated log methods.
 * @namespace logger
 */
export const logger = {
  /**
   * Log an error message (always emitted regardless of config).
   * @param {string} tag - A tag identifying the source (e.g. "[Player]").
   * @param {...*} args - Additional values to log.
   */
  error(tag, ...args) {
    const g = _stormGate("error", tag, args);
    if (!g.emit) return;
    console.error(`[${ts()}] ${tag}`, ...args, ...(g.suffix ? [g.suffix] : []));
  },
  /**
   * Log a warning message. Honours `logging.warn` override when logging is disabled.
   * @param {string} tag - A tag identifying the source.
   * @param {...*} args - Additional values to log.
   */
  warn(tag, ...args) {
    if (_config?.enabled === false && _config?.warn !== true) return;
    const g = _stormGate("warn", tag, args);
    if (!g.emit) return;
    console.warn(`[${ts()}] ${tag}`, ...args, ...(g.suffix ? [g.suffix] : []));
  },
  /**
   * Log an info message. Suppressed when `logging.enabled === false`.
   * @param {string} tag - A tag identifying the source.
   * @param {...*} args - Additional values to log.
   */
  info(tag, ...args) {
    if (_config?.enabled === false) return;
    console.log(`[${ts()}] ${tag}`, ...args);
  },

  /**
   * Category-gated player log.
   * @param {...*} args
   */
  player(...args)      { if (isEnabled("player"))      console.log(`[${ts()}]`, ...args); },
  /**
   * Category-gated inactivity log.
   * @param {...*} args
   */
  inactivity(...args)  { if (isEnabled("inactivity"))  console.log(`[${ts()}]`, ...args); },
  /**
   * Category-gated voice 24/7 log.
   * @param {...*} args
   */
  voice247(...args)    { if (isEnabled("voice247"))     console.log(`[${ts()}]`, ...args); },
  /**
   * Category-gated voice-state log.
   * @param {...*} args
   */
  voiceState(...args)  { if (isEnabled("voiceState"))   console.log(`[${ts()}]`, ...args); },
  /**
   * Category-gated media-player log.
   * @param {...*} args
   */
  mediaplayer(...args) { if (isEnabled("mediaplayer"))  console.log(`[${ts()}]`, ...args); },
  /**
   * Category-gated commands log.
   * @param {...*} args
   */
  commands(...args)    { if (isEnabled("commands"))     console.log(`[${ts()}]`, ...args); },
  /**
   * Category-gated guild log.
   * @param {...*} args
   */
  guild(...args)       { if (isEnabled("guild"))        console.log(`[${ts()}]`, ...args); },
  /**
   * Category-gated recovery log.
   * @param {...*} args
   */
  recovery(...args)    { if (isEnabled("recovery"))     console.log(`[${ts()}]`, ...args); },
  /**
   * Category-gated settings log.
   * @param {...*} args
   */
  settings(...args)    { if (isEnabled("settings"))     console.log(`[${ts()}]`, ...args); },
  /**
   * Category-gated lavalink log.
   * @param {...*} args
   */
  lavalink(...args)    { if (isEnabled("lavalink"))     console.log(`[${ts()}]`, ...args); },
  /**
   * Category-gated alone-check log.
   * @param {...*} args
   */
  aloneCheck(...args)  { if (isEnabled("aloneCheck"))  console.log(`[${ts()}]`, ...args); },
  /**
   * Category-gated voice log.
   * @param {...*} args
   */
  voice(...args)       { if (isEnabled("voice"))        console.log(`[${ts()}]`, ...args); },
  /**
   * Category-gated dashboard log.
   * @param {...*} args
   */
  dashboard(...args)   { if (isEnabled("dashboard"))    console.log(`[${ts()}]`, ...args); },
  /**
   * Category-gated redis log.
   * @param {...*} args
   */
  redis(...args)       { if (isEnabled("redis"))        console.log(`[${ts()}]`, ...args); },
};
