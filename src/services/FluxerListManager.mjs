/** @module src/services/FluxerListManager @description FluxerList API integration: voter lists, server-count auto-sync for the bot listing, per-user vote checks and listing info — with per-endpoint caching, doc-accurate rate-limit handling (429 + Retry-After) and typed errors. Docs: https://docs.fluxerlist.com/api-quickstart */

import { logger } from "../core/Logger.mjs";
import {
  FLUXERLIST,
  FLUXERLIST_AUTH,
  FLUXERLIST_LIMITS,
  buildFluxerListUrl,
} from "../utils/API.mjs";

const REQUEST_TIMEOUT_MS = 15_000;
const RATE_LIMIT_WARN_COOLDOWN_MS = 60_000;

/**
 * Typed FluxerList API error. Diagnostics live in `message`; `status` carries
 * the HTTP status code (0 for client-side blocks like an active rate-limit gate).
 */
export class FluxerListApiError extends Error {
  /**
   * @param {string} message - Human-readable diagnostic message.
   * @param {number} [status=0] - HTTP status code, or 0 when blocked locally.
   */
  constructor(message, status = 0) {
    super(message);
    this.name = "FluxerListApiError";
    this.status = status;
  }
}

/** @class FluxerListManager @description FluxerList API client shared by the whole bot (voter lists, stats sync, vote checks). */
export class FluxerListManager {
  /** @param {object} [config={}] @param {string} [config.apiKey] @param {string} [config.botId] @param {string} [config.serverId] @param {string} [config.serverSlug] @param {string} [config.botSlug] @param {boolean} [config.autoStats] @param {number} [config.statsIntervalMinutes] */
  constructor(config = {}) {
    this.apiKey     = typeof config?.apiKey === "string" ? config.apiKey.trim() : "";
    this.serverId   = config?.serverId ?? "";
    this.botId      = config?.botId ?? "";
    this.serverSlug = config?.serverSlug ?? config?.serverId ?? "";
    this.botSlug    = config?.botSlug ?? config?.botId ?? "";
    this.enabled    = !!this.apiKey;
    this.autoStats = config?.autoStats !== false;
    this.statsIntervalMinutes = Number(config?.statsIntervalMinutes) > 0
      ? Number(config.statsIntervalMinutes)
      : 30;

    this._cache = new Map();
    this._blockedUntil = 0;
    this._lastRateLimitWarn = 0;
    this._lastStatsPost = 0;
    this._lastPostedCount = null;
    this._statsIntervalMs = FLUXERLIST_LIMITS.STATS_DEFAULT_INTERVAL_MS;
    this._statsTimer = null;
    this._statsClient = null;

    if (!this.enabled) {
      logger.settings("[FluxerList] Disabled — apiKey missing in config.");
    } else {
      logger.settings(
        `[FluxerList] Enabled${this.autoStats ? " — auto server-count sync every " + this.statsIntervalMinutes + " min" : ""}.`
      );
    }
  }

  /**
   * @private
   * Perform one authenticated API request with rate-limit gating and typed errors.
   * @param {string} endpoint - Endpoint template with `:id`.
   * @param {string} resourceId - Bot/server ID or slug.
   * @param {{ method?: string, body?: object, query?: Record<string, string|number> }} [opts]
   * @returns {Promise<object|null>} Parsed JSON response, or null for 204s.
   * @throws {FluxerListApiError} On rate-limit gate or HTTP error responses.
   */
  async _request(endpoint, resourceId, opts = {}) {
    this._assertEnabled();

    const now = Date.now();
    if (now < this._blockedUntil) {
      const waitS = Math.ceil((this._blockedUntil - now) / 1000);
      throw new FluxerListApiError(`FluxerList rate limit is active — retrying in ${waitS}s.`, 429);
    }

    const method = opts.method ?? "GET";
    const url = buildFluxerListUrl(endpoint, resourceId, opts.query ?? {});

    const headers = {
      [FLUXERLIST_AUTH.HEADER]: FLUXERLIST_AUTH.bearer(this.apiKey),
      "Accept": "application/json",
      "User-Agent": "RemixBot/1.0 (FluxerList Integration)",
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      throw new FluxerListApiError(`FluxerList request failed: ${e?.message ?? e}`, 0);
    }

    if (res.status === 429) {
      const retryAfterS = Number(res.headers.get("retry-after")) || 0;
      let resetMs = 0;
      try {
        const payload = await res.json();
        resetMs = Number(payload?.reset) || 0;
      } catch (_) { /* body not JSON — header already parsed above */ }
      const waitMs = retryAfterS > 0
        ? retryAfterS * 1000
        : Math.max(0, resetMs - Date.now()) || 60_000;
      this._blockedUntil = Date.now() + waitMs;
      if (Date.now() - this._lastRateLimitWarn > RATE_LIMIT_WARN_COOLDOWN_MS) {
        this._lastRateLimitWarn = Date.now();
        const long = waitMs > 30 * 60_000 ? " (long window — the shared 3,000/month key budget may be exhausted)" : "";
        logger.warn(`[FluxerList] Rate limited — pausing all FluxerList requests for ${Math.round(waitMs / 1000)}s${long}.`);
      }
      throw new FluxerListApiError(
        `FluxerList rate limited — retry after ${Math.round(waitMs / 1000)}s.`,
        429
      );
    }

    if (res.status === 400) {
      const text = await res.text().catch(() => "");
      throw new FluxerListApiError(`FluxerList rejected the request as invalid (HTTP 400): ${text.slice(0, 200)}`, 400);
    }
    if (res.status === 401) {
      throw new FluxerListApiError("Invalid FluxerList API key. Generate one in the FluxerList Dashboard → Developer tab (keys start with fl_) and set fluxerlist.apiKey in config.json.", 401);
    }
    if (res.status === 403) {
      throw new FluxerListApiError("FluxerList API key does not belong to this listing's owner. Use a key from the account that owns the bot/server.", 403);
    }
    if (res.status === 404) {
      throw new FluxerListApiError(`No FluxerList listing matches "${resourceId}". Check the ID or slug in your config (e.g. "remix" from fluxerlist.com/bots/remix).`, 404);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new FluxerListApiError(`FluxerList API error (HTTP ${res.status}): ${text.slice(0, 200)}`, res.status);
    }

    if (res.status === 204) return null;
    try {
      return await res.json();
    } catch (_) {
      return null;
    }
  }

  /** @private @param {string} type @param {string} id @param {number} page @param {number} limit @returns {string} */
  _cacheKey(type, id, page, limit) {
    return `${type}:${id}:p${page}:l${limit}`;
  }

  /** @private @param {string} key @returns {object|null} */
  _getCached(key) {
    const entry = this._cache.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this._cache.delete(key);
      return null;
    }
    return entry.data;
  }

  /** @private @param {string} key @param {object} data @param {number} [ttlMs] */
  _setCached(key, data, ttlMs) {
    this._cache.set(key, {
      data,
      expiresAt: Date.now() + (ttlMs ?? FLUXERLIST_LIMITS.CACHE_TTL_MS),
    });

    if (this._cache.size > 200) {
      const now = Date.now();
      for (const [k, v] of this._cache) {
        if (now >= v.expiresAt) this._cache.delete(k);
      }
    }
  }

  /** @async Fetch voters from FluxerList API. @param {"server"|"bot"} type @param {string} [id] @param {object} [options={}] @param {number} [options.page] @param {number} [options.limit] @param {boolean} [options.skipCache] @returns {Promise<object>} @throws {FluxerListApiError} On auth, not-found, or HTTP errors. */
  async getVoters(type, id, options = {}) {
    this._assertEnabled();

    const resourceId = id || (type === "server" ? this.serverId : this.botId);
    if (!resourceId) {
      throw new FluxerListApiError(`No ${type} ID configured. Set it in config.json or provide it as an argument.`, 0);
    }

    const page  = options.page  ?? FLUXERLIST_LIMITS.DEFAULT_PAGE;
    const limit = options.limit ?? FLUXERLIST_LIMITS.DEFAULT_LIMIT;

    const cacheKey = this._cacheKey(type, resourceId, page, limit);
    if (!options.skipCache) {
      const cached = this._getCached(cacheKey);
      if (cached) {
        logger.settings(`[FluxerList] Cache hit for ${cacheKey}`);
        return cached;
      }
    }

    const endpoint = type === "server"
      ? FLUXERLIST.ENDPOINTS.SERVER_VOTERS
      : FLUXERLIST.ENDPOINTS.BOT_VOTERS;

    const data = await this._request(endpoint, resourceId, { query: { page, limit } });

    if (typeof data?.total !== "number" || !Array.isArray(data?.voters)) {
      throw new FluxerListApiError("Unexpected FluxerList API response format.", 0);
    }

    this._setCached(cacheKey, data);

    logger.settings(`[FluxerList] Fetched ${data.voters.length} voters for ${type} ${resourceId} (page ${page}, total ${data.total})`);
    return data;
  }

  /** @async @param {string} [id] @param {object} [options] @returns {Promise<object>} */
  async getServerVoters(id, options = {}) {
    return this.getVoters("server", id, options);
  }

  /** @async @param {string} [id] @param {object} [options] @returns {Promise<object>} */
  async getBotVoters(id, options = {}) {
    return this.getVoters("bot", id, options);
  }

  /** @async Fetch all pages of voters for a resource. @param {"server"|"bot"} type @param {string} [id] @param {object} [options] @returns {Promise<Array>} */
  async getAllVoters(type, id, options = {}) {
    this._assertEnabled();

    const limit = options.limit ?? FLUXERLIST_LIMITS.MAX_LIMIT;
    let page = 1;
    let allVoters = [];
    let total = Infinity;

    while (allVoters.length < total && page <= 50) {
      const data = await this.getVoters(type, id, { page, limit, skipCache: options.skipCache });
      allVoters = allVoters.concat(data.voters);
      total = data.total;
      page++;

      if (data.voters.length < limit) break;
    }

    return allVoters;
  }

  /**
   * Post the bot's server count to its FluxerList listing.
   * Docs: POST /bots/{id}/stats, limit 12 requests/hour — post on a schedule,
   * not on every guild join/leave. Identical counts are skipped (unless forced)
   * to conserve the shared 3,000 requests/month key budget.
   * @async
   * @param {number} count - Current server count (non-negative integer).
   * @param {{ force?: boolean, id?: string }} [opts] - `force` bypasses the unchanged-count and min-interval guards.
   * @returns {Promise<{ok: boolean, skipped?: boolean, reason?: string, serverCount?: number, retryInMs?: number}>}
   * @throws {FluxerListApiError} On HTTP errors (auth, not found, rate limit).
   */
  async postServerCount(count, opts = {}) {
    this._assertEnabled();

    const resourceId = opts.id || this.botId;
    if (!resourceId) {
      throw new FluxerListApiError("No bot ID available for stats sync. Set fluxerlist.botId in config.json (or let the bot auto-detect it at startup).", 0);
    }

    const serverCount = Number(count);
    if (!Number.isInteger(serverCount) || serverCount < 0) {
      throw new FluxerListApiError(`Invalid server count: ${count} (must be a non-negative integer).`, 0);
    }

    const now = Date.now();
    if (!opts.force) {
      if (serverCount === this._lastPostedCount) {
        return { ok: false, skipped: true, reason: "unchanged", serverCount };
      }
      const sinceLast = now - this._lastStatsPost;
      if (this._lastStatsPost > 0 && sinceLast < FLUXERLIST_LIMITS.STATS_MIN_INTERVAL_MS) {
        return {
          ok: false,
          skipped: true,
          reason: "too-soon",
          serverCount,
          retryInMs: FLUXERLIST_LIMITS.STATS_MIN_INTERVAL_MS - sinceLast,
        };
      }
    }

    const data = await this._request(FLUXERLIST.ENDPOINTS.BOT_STATS, resourceId, {
      method: "POST",
      body: { serverCount },
    });

    this._lastStatsPost = now;
    this._lastPostedCount = serverCount;

    logger.settings(`[FluxerList] Server count posted: ${serverCount}${typeof data?.serverCount === "number" && data.serverCount !== serverCount ? ` (listing now shows ${data.serverCount})` : ""}`);
    return { ok: true, serverCount };
  }

  /**
   * Start automatic server-count syncing: one post shortly after the bot is
   * ready, then every `statsIntervalMinutes` (default 30, minimum 5 per the
   * docs' 12/hour endpoint limit). The scheduled post skips identical counts
   * to conserve the monthly key budget. Safe to call multiple times.
   * @param {object} client - The Fluxer client (uses client.guilds.cache.size and client.user.id).
   * @param {{ intervalMs?: number }} [opts] - Override the cadence (production default 30 min).
   * @returns {(() => void)|null} A stop function, or null when disabled/no key.
   */
  startAutoStats(client, opts = {}) {
    if (!this.enabled || this.autoStats === false) return null;
    if (this._statsTimer) return () => this.stopAutoStats();

    const resolvedId = this.botId || client?.user?.id || "";
    if (!resolvedId) {
      logger.warn("[FluxerList] Auto stats sync skipped — no botId in config and client.user.id unavailable yet.");
      return null;
    }
    if (this.botId !== resolvedId) this.botId = resolvedId;

    this._statsClient = client;
    const requested = opts.intervalMs ?? this.statsIntervalMinutes * 60_000;
    const clamped = Math.min(
      Math.max(Number(requested) || FLUXERLIST_LIMITS.STATS_DEFAULT_INTERVAL_MS, FLUXERLIST_LIMITS.STATS_MIN_INTERVAL_MS),
      FLUXERLIST_LIMITS.STATS_MAX_INTERVAL_MS
    );
    this._statsIntervalMs = clamped;

    const tick = async () => {
      try {
        const count = this._statsClient?.guilds?.cache?.size;
        if (!Number.isFinite(count)) return;
        await this.postServerCount(count, { force: !this._lastPostedCount });
      } catch (e) {
        logger.warn(`[FluxerList] Stats sync failed: ${e?.message ?? e}`);
      }
    };

    logger.settings(`[FluxerList] Auto stats sync started — posting server count every ${Math.round(clamped / 60_000)} min.`);
    const bootTimer = setTimeout(tick, 15_000);
    bootTimer.unref?.();
    this._statsTimer = setInterval(tick, clamped);
    this._statsTimer.unref?.();

    return () => this.stopAutoStats();
  }

  /** Stop the automatic server-count sync (also clears pending boot post). @returns {void} */
  stopAutoStats() {
    if (this._statsTimer) {
      clearInterval(this._statsTimer);
      this._statsTimer = null;
    }
    this._statsClient = null;
  }

  /**
   * Check whether a user currently has an active vote for the bot.
   * Docs: GET /bots/{id}/check?fluxerId= — 60 requests/min, so results are
   * cached for 60 seconds per user.
   * @async
   * @param {string} userId - The Fluxer user ID to check.
   * @returns {Promise<boolean|null>} `true`/`false` for the vote status, or `null` when the API failed (caller decides fail-open/fail-closed).
   */
  async hasVoted(userId) {
    try {
      this._assertEnabled();
      const resourceId = this.botId;
      if (!resourceId) {
        logger.warn("[FluxerList] hasVoted called without a botId (set fluxerlist.botId or wait for auto-detect).");
        return null;
      }
      const cacheKey = `check:${resourceId}:${userId}`;
      const cached = this._getCached(cacheKey);
      if (cached !== null) return cached.voted;

      const data = await this._request(FLUXERLIST.ENDPOINTS.BOT_CHECK, resourceId, {
        query: { fluxerId: String(userId) },
      });
      const result = { voted: data?.voted === true, votes: Number(data?.votes) || 0 };
      this._setCached(cacheKey, result, FLUXERLIST_LIMITS.VOTE_CHECK_TTL_MS);
      return result.voted;
    } catch (e) {
      logger.warn(`[FluxerList] Vote check failed: ${e?.message ?? e}`);
      return null;
    }
  }

  /**
   * Fetch the bot's own public listing data (cached for 5 minutes).
   * @async
   * @param {{ force?: boolean, id?: string }} [opts]
   * @returns {Promise<object>} The bot listing object.
   * @throws {FluxerListApiError} On HTTP errors.
   */
  async getBotInfo(opts = {}) {
    this._assertEnabled();
    const resourceId = opts.id || this.botId;
    if (!resourceId) {
      throw new FluxerListApiError("No bot ID available. Set fluxerlist.botId in config.json.", 0);
    }
    const cacheKey = `info:${resourceId}`;
    if (!opts.force) {
      const cached = this._getCached(cacheKey);
      if (cached) return cached;
    }
    const data = await this._request(FLUXERLIST.ENDPOINTS.BOT_INFO, resourceId);
    this._setCached(cacheKey, data, FLUXERLIST_LIMITS.BOT_INFO_TTL_MS);
    return data;
  }

  /** @private @throws {FluxerListApiError} If not configured. */
  _assertEnabled() {
    if (!this.enabled) {
      throw new FluxerListApiError("FluxerList integration is not configured (missing apiKey in config.json). Generate one in the FluxerList Dashboard → Developer tab (keys start with fl_).", 0);
    }
  }
}
