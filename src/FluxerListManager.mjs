/** @module src/FluxerListManager @description FluxerList API integration for fetching server/bot voter lists with caching. */

import { logger } from "./constants/Logger.mjs";
import {
  FLUXERLIST,
  FLUXERLIST_AUTH,
  FLUXERLIST_LIMITS,
  buildFluxerListUrl,
} from "./constants/API.mjs";

/** @class FluxerListManager @description Fetches and caches voter lists from the FluxerList API for servers and bots. */
export class FluxerListManager {
  /** @param {object} [config={}] @param {string} [config.apiKey] @param {string} [config.serverId] @param {string} [config.botId] @param {string} [config.serverSlug] @param {string} [config.botSlug] */
  constructor(config = {}) {
    this.apiKey     = config?.apiKey ?? "";
    this.serverId   = config?.serverId ?? "";
    this.botId      = config?.botId ?? "";
    this.serverSlug = config?.serverSlug ?? config?.serverId ?? "";
    this.botSlug    = config?.botSlug ?? config?.botId ?? "";
    this.enabled    = !!this.apiKey;

    this._cache = new Map();

    if (!this.enabled) {
      logger.settings("[FluxerList] Disabled — apiKey missing in config.");
    } else {
      logger.settings("[FluxerList] Enabled — API key configured.");
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

  /** @async Fetch voters from FluxerList API. @param {"server"|"bot"} type @param {string} [id] @param {object} [options={}] @param {number} [options.page] @param {number} [options.limit] @param {boolean} [options.skipCache] @returns {Promise<object>} @throws {Error} On auth, not-found, or HTTP errors. */
  async getVoters(type, id, options = {}) {
    this._assertEnabled();

    const resourceId = id || (type === "server" ? this.serverId : this.botId);
    if (!resourceId) {
      throw new Error(`No ${type} ID configured. Set it in config.json or provide it as an argument.`);
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

    const url = buildFluxerListUrl(endpoint, resourceId, { page, limit });

    const res = await fetch(url, {
      method: "GET",
      headers: {
        [FLUXERLIST_AUTH.HEADER]: FLUXERLIST_AUTH.bearer(this.apiKey),
        "Accept": "application/json",
        "User-Agent": "RemixBot/1.0 (FluxerList Integration)",
      },
    });

    if (res.status === 401) {
      throw new Error("Invalid FluxerList API key. Check your config.json fluxerlist.apiKey.");
    }
    if (res.status === 403) {
      throw new Error("FluxerList API key does not belong to this resource owner.");
    }
    if (res.status === 404) {
      const label = type === "server" ? "Server" : "Bot";
      throw new Error(`${label} "${resourceId}" was not found on FluxerList. Make sure the ID or slug in your config is correct (e.g. "remix" from fluxerlist.com/bots/remix).`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`FluxerList API error (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }

    const data = await res.json();

    if (typeof data.total !== "number" || !Array.isArray(data.voters)) {
      throw new Error("Unexpected FluxerList API response format.");
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

  /** @private @throws {Error} If not configured. */
  _assertEnabled() {
    if (!this.enabled) {
      throw new Error("FluxerList integration is not configured (missing apiKey in config.json).");
    }
  }
}
