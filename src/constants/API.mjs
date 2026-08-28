/** @module constants/API */

/**
 * FluxerList API configuration.
 * @namespace FLUXERLIST
 */
export const FLUXERLIST = {
  /** Base URL for the FluxerList REST API. @type {string} */
  BASE_URL: "https://fluxerlist.com/api/v1",

  /** Public FluxerList website URL. @type {string} */
  SITE_URL: "https://fluxerlist.com",

  /** API endpoint path templates. @type {{ SERVER_VOTERS: string, BOT_VOTERS: string }} */
  ENDPOINTS: {
    SERVER_VOTERS: "/servers/:id/voters",

    BOT_VOTERS: "/bots/:id/voters",
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
 * FluxerList pagination and cache limits.
 * @namespace FLUXERLIST_LIMITS
 */
export const FLUXERLIST_LIMITS = {
  /** Default page number. @type {number} */
  DEFAULT_PAGE: 1,

  /** Default items-per-page. @type {number} */
  DEFAULT_LIMIT: 50,

  /** Maximum allowed items-per-page. @type {number} */
  MAX_LIMIT: 100,

  /** Cache time-to-live in milliseconds. @type {number} */
  CACHE_TTL_MS: 5 * 60 * 1000,
};

/**
 * Build a full FluxerList API URL by substituting `:id` in the endpoint and appending query params.
 * @param {string} endpoint - Endpoint template (e.g. `"/servers/:id/voters"`).
 * @param {string} resourceId - Value to substitute for `:id`.
 * @param {{ page?: number, limit?: number }} [queryParams={}]
 * @returns {string} Fully qualified URL.
 */
export function buildFluxerListUrl(endpoint, resourceId, queryParams = {}) {
  const path = endpoint.replace(":id", encodeURIComponent(resourceId));
  const params = new URLSearchParams();

  if (queryParams.page) params.set("page", String(queryParams.page));
  if (queryParams.limit) {
    const clamped = Math.min(Math.max(1, queryParams.limit), FLUXERLIST_LIMITS.MAX_LIMIT);
    params.set("limit", String(clamped));
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
