/**
 * FluxerListManager.mjs — FluxerList API client for voter data queries.
 *
 * Features:
 *   - Fetch paginated voter lists for servers and bots
 *   - Bearer token authentication (fl_ prefixed API keys)
 *   - In-memory response caching with configurable TTL
 *   - Graceful error handling (401/403 auth errors, network failures)
 *
 * FluxerList API docs: https://fluxerlist.com/api/v1
 */

import { logger } from "./constants/Logger.mjs";
import {
  FLUXERLIST,
  FLUXERLIST_AUTH,
  FLUXERLIST_LIMITS,
  buildFluxerListUrl,
} from "./constants/API.mjs";

// ── FluxerListManager ───────────────────────────────────────────────────────────

export class FluxerListManager {
  /**
   * @param {object} config - The `fluxerlist` section from config.json
   * @param {string} [config.apiKey] - FluxerList API key (prefixed with fl_)
   * @param {string} [config.serverId] - Default server UUID for voter queries
   * @param {string} [config.botId] - Default bot UUID for voter queries
   */
  constructor(config = {}) {
    this.apiKey    = config?.apiKey ?? "";
    this.serverId  = config?.serverId ?? "";
    this.botId     = config?.botId ?? "";
    this.enabled   = !!this.apiKey;

    // In-memory cache: Map<cacheKey, { data, expiresAt }>
    this._cache = new Map();

    if (!this.enabled) {
      logger.settings("[FluxerList] Disabled — apiKey missing in config.");
    } else {
      logger.settings("[FluxerList] Enabled — API key configured.");
    }
  }

  // ── Cache helpers ───────────────────────────────────────────────────────────

  /**
   * Generate a cache key from the request parameters.
   * @param {"server"|"bot"} type
   * @param {string} id
   * @param {number} page
   * @param {number} limit
   * @returns {string}
   */
  _cacheKey(type, id, page, limit) {
    return `${type}:${id}:p${page}:l${limit}`;
  }

  /**
   * Get a cached response if still fresh.
   * @param {string} key
   * @returns {object|null}
   */
  _getCached(key) {
    const entry = this._cache.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this._cache.delete(key);
      return null;
    }
    return entry.data;
  }

  /**
   * Store a response in the cache with the configured TTL.
   * @param {string} key
   * @param {object} data
   * @param {number} [ttlMs] - Override TTL in milliseconds
   */
  _setCached(key, data, ttlMs) {
    this._cache.set(key, {
      data,
      expiresAt: Date.now() + (ttlMs ?? FLUXERLIST_LIMITS.CACHE_TTL_MS),
    });

    // Evict stale entries periodically to prevent unbounded growth
    if (this._cache.size > 200) {
      const now = Date.now();
      for (const [k, v] of this._cache) {
        if (now >= v.expiresAt) this._cache.delete(k);
      }
    }
  }

  // ── API calls ───────────────────────────────────────────────────────────────

  /**
   * Fetch the list of voters for a server or bot.
   *
   * @param {"server"|"bot"} type - Resource type
   * @param {string} [id] - Server or bot UUID (falls back to config default)
   * @param {object} [options]
   * @param {number} [options.page=1] - Page number (1-based)
   * @param {number} [options.limit=50] - Results per page (max 100)
   * @param {boolean} [options.skipCache=false] - Bypass cache and fetch fresh data
   * @returns {Promise<{ total: number, page: number, limit: number, voters: Array<{ username: string, fluxerId: number, votedAt: string }> }>}
   * @throws {Error} If the API key is missing or the request fails
   */
  async getVoters(type, id, options = {}) {
    this._assertEnabled();

    const resourceId = id || (type === "server" ? this.serverId : this.botId);
    if (!resourceId) {
      throw new Error(`No ${type} ID configured. Set it in config.json or provide it as an argument.`);
    }

    const page  = options.page  ?? FLUXERLIST_LIMITS.DEFAULT_PAGE;
    const limit = options.limit ?? FLUXERLIST_LIMITS.DEFAULT_LIMIT;

    // Check cache first
    const cacheKey = this._cacheKey(type, resourceId, page, limit);
    if (!options.skipCache) {
      const cached = this._getCached(cacheKey);
      if (cached) {
        logger.settings(`[FluxerList] Cache hit for ${cacheKey}`);
        return cached;
      }
    }

    // Build request URL
    const endpoint = type === "server"
      ? FLUXERLIST.ENDPOINTS.SERVER_VOTERS
      : FLUXERLIST.ENDPOINTS.BOT_VOTERS;

    const url = buildFluxerListUrl(endpoint, resourceId, { page, limit });

    // Make the API call
    const res = await fetch(url, {
      method: "GET",
      headers: {
        [FLUXERLIST_AUTH.HEADER]: FLUXERLIST_AUTH.bearer(this.apiKey),
        "Accept": "application/json",
        "User-Agent": "RemixBot/1.0 (FluxerList Integration)",
      },
    });

    // Handle HTTP errors
    if (res.status === 401) {
      throw new Error("Invalid FluxerList API key. Check your config.json fluxerlist.apiKey.");
    }
    if (res.status === 403) {
      throw new Error("FluxerList API key does not belong to this resource owner.");
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`FluxerList API error (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }

    const data = await res.json();

    // Validate response shape
    if (typeof data.total !== "number" || !Array.isArray(data.voters)) {
      throw new Error("Unexpected FluxerList API response format.");
    }

    // Cache the result
    this._setCached(cacheKey, data);

    logger.settings(`[FluxerList] Fetched ${data.voters.length} voters for ${type} ${resourceId} (page ${page}, total ${data.total})`);
    return data;
  }

  /**
   * Convenience: fetch voters for a server.
   * @param {string} [id] - Server UUID (falls back to config default)
   * @param {object} [options] - Same as getVoters options
   * @returns {Promise<object>}
   */
  async getServerVoters(id, options = {}) {
    return this.getVoters("server", id, options);
  }

  /**
   * Convenience: fetch voters for a bot.
   * @param {string} [id] - Bot UUID (falls back to config default)
   * @param {object} [options] - Same as getVoters options
   * @returns {Promise<object>}
   */
  async getBotVoters(id, options = {}) {
    return this.getVoters("bot", id, options);
  }

  /**
   * Fetch ALL voters across all pages for a resource.
   * Use with caution on resources with many voters — this makes multiple API calls.
   *
   * @param {"server"|"bot"} type
   * @param {string} [id] - Resource UUID
   * @param {object} [options]
   * @param {number} [options.limit=100] - Results per page (uses max to minimize calls)
   * @returns {Promise<Array<{ username: string, fluxerId: number, votedAt: string }>>}
   */
  async getAllVoters(type, id, options = {}) {
    this._assertEnabled();

    const limit = options.limit ?? FLUXERLIST_LIMITS.MAX_LIMIT;
    let page = 1;
    let allVoters = [];
    let total = Infinity;

    // Safety: max 50 pages to prevent runaway loops
    while (allVoters.length < total && page <= 50) {
      const data = await this.getVoters(type, id, { page, limit, skipCache: options.skipCache });
      allVoters = allVoters.concat(data.voters);
      total = data.total;
      page++;

      // If we got fewer results than the limit, we've reached the last page
      if (data.voters.length < limit) break;
    }

    return allVoters;
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  _assertEnabled() {
    if (!this.enabled) {
      throw new Error("FluxerList integration is not configured (missing apiKey in config.json).");
    }
  }
}
