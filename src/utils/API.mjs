/** @module src/utils/API */

/**
 * FluxerList API configuration.
 * @namespace FLUXERLIST
 */
export const FLUXERLIST = {
  /** Base URL for the FluxerList REST API. @type {string} */
  BASE_URL: "https://fluxerlist.com/api/v1",

  /** Public FluxerList website URL. @type {string} */
  SITE_URL: "https://fluxerlist.com",

  /** API endpoint path templates. @type {{ SERVER_VOTERS: string, BOT_VOTERS: string, BOT_STATS: string, BOT_CHECK: string, BOT_INFO: string }} */
  ENDPOINTS: {
    SERVER_VOTERS: "/servers/:id/voters",

    BOT_VOTERS: "/bots/:id/voters",

    /** POST server count for a bot listing (body: { serverCount }). */
    BOT_STATS: "/bots/:id/stats",

    /** GET a user's vote status for a bot (query: fluxerId). */
    BOT_CHECK: "/bots/:id/check",

    /** GET a bot's public listing data. */
    BOT_INFO: "/bots/:id",
  },

  /** Accepted resource type identifiers. @type {string[]} */
  RESOURCE_TYPES: ["server", "bot"],

  /** Thumbnail API base URL. @type {string} */
  THUMBNAIL: "https://fluxerlist.com/api/v1",
};

/**
 * FluxerList authentication helpers.
 * @namespace FLUXERLIST_AUTH
 */
export const FLUXERLIST_AUTH = {
  /** HTTP header name for auth. @type {string} */
  HEADER: "Authorization",

  /** Required API key prefix. @type {string} */
  KEY_PREFIX: "fl_",

  /**
   * Format an API key as a Bearer token, prepending the prefix if needed.
   * @param {string} apiKey - Raw or prefixed API key.
   * @returns {string} `Bearer fl_...` string.
   */
  bearer(apiKey) {
    const key = apiKey.startsWith(FLUXERLIST_AUTH.KEY_PREFIX)
      ? apiKey
      : FLUXERLIST_AUTH.KEY_PREFIX + apiKey;
    return `Bearer ${key}`;
  },
};

/**
 * FluxerList pagination, cache and rate-limit limits (per docs.fluxerlist.com).
 * @namespace FLUXERLIST_LIMITS
 */
export const FLUXERLIST_LIMITS = {
  /** Default page number. @type {number} */
  DEFAULT_PAGE: 1,

  /** Default items-per-page. @type {number} */
  DEFAULT_LIMIT: 50,

  /** Maximum allowed items-per-page. @type {number} */
  MAX_LIMIT: 100,

  /** Cache time-to-live in milliseconds for voter lists. @type {number} */
  CACHE_TTL_MS: 5 * 60 * 1000,

  /** Minimum spacing between stats posts (docs: limit is 12/hour). @type {number} */
  STATS_MIN_INTERVAL_MS: 5 * 60 * 1000,

  /** Recommended stats cadence (docs: "post on startup, then roughly every 30 minutes"). @type {number} */
  STATS_DEFAULT_INTERVAL_MS: 30 * 60 * 1000,

  /** Cache TTL for per-user vote checks (docs limit 60/min; cache on our side). @type {number} */
  VOTE_CHECK_TTL_MS: 60 * 1000,

  /** Cache TTL for the bot's own listing info (default 20/min bucket). @type {number} */
  BOT_INFO_TTL_MS: 5 * 60 * 1000,

  /** Hard cap on scheduled stats intervals accepted from config, in ms. @type {number} */
  STATS_MAX_INTERVAL_MS: 6 * 60 * 60 * 1000,
};

/**
 * Build a full FluxerList API URL by substituting `:id` in the endpoint and appending query params.
 * `page`/`limit` keep their clamping behavior; any other params are passed through verbatim.
 * @param {string} endpoint - Endpoint template (e.g. `"/bots/:id/check"`).
 * @param {string} resourceId - Value to substitute for `:id`.
 * @param {Record<string, string|number>} [queryParams={}]
 * @returns {string} Fully qualified URL.
 */
export function buildFluxerListUrl(endpoint, resourceId, queryParams = {}) {
  const path = endpoint.replace(":id", encodeURIComponent(resourceId));
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(queryParams)) {
    if (value === undefined || value === null) continue;
    if (key === "limit") {
      const clamped = Math.min(Math.max(1, Number(value) || 1), FLUXERLIST_LIMITS.MAX_LIMIT);
      params.set("limit", String(clamped));
    } else if (key === "page") {
      params.set("page", String(Math.max(1, Number(value) || 1)));
    } else {
      params.set(key, String(value));
    }
  }

  const qs = params.toString();
  return `${FLUXERLIST.BASE_URL}${path}${qs ? "?" + qs : ""}`;
}

/**
 * Build a FluxerList vote link for a server or bot.
 * @param {"server"|"bot"} type - Resource type.
 * @param {string} resourceId - The server/bot ID.
 * @returns {string} Absolute URL to the vote page.
 */
export function buildVoteLink(type, resourceId) {
  const path = type === "server" ? "servers" : "bots";
  return `${FLUXERLIST.SITE_URL}/${path}/${resourceId}`;
}
