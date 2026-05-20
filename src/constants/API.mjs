/**
 * API.mjs — Single source of truth for all external API constants.
 *
 * FLUXERLIST        — FluxerList vote-tracking API configuration & endpoints
 * FLUXERLIST_AUTH   — Authentication header format & key prefix
 * FLUXERLIST_LIMITS — Pagination & rate limit defaults
 *
 * Edit only here; FluxerListManager.mjs and commands/vote.mjs import from this file.
 */


export const FLUXERLIST = {
  /** Base URL for all FluxerList API v1 endpoints */
  BASE_URL: "https://fluxerlist.com/api/v1",

  /** FluxerList website base URL (for vote links, profiles, etc.) */
  SITE_URL: "https://fluxerlist.com",

  /** Available endpoint paths — append :id and query params at call time */
  ENDPOINTS: {
    /** GET /api/v1/servers/:id/voters — voters for a server */
    SERVER_VOTERS: "/servers/:id/voters",

    /** GET /api/v1/bots/:id/voters — voters for a bot */
    BOT_VOTERS: "/bots/:id/voters",
  },

  /** Resource types supported by the API (used in command choices) */
  RESOURCE_TYPES: ["server", "bot"],

  /** Thumbnail image for vote embeds (FluxerList branding) */
  THUMBNAIL: "https://fluxerlist.com/api/v1",
};

export const FLUXERLIST_AUTH = {
  /** Header name for API key authentication */
  HEADER: "Authorization",

  /** Prefix prepended to all FluxerList API keys */
  KEY_PREFIX: "fl_",

  /**
   * Build the Authorization header value.
   * @param {string} apiKey - The raw API key (with or without the fl_ prefix)
   * @returns {string} Header value in "Bearer fl_xxx" format
   */
  bearer(apiKey) {
    const key = apiKey.startsWith(FLUXERLIST_AUTH.KEY_PREFIX)
      ? apiKey
      : FLUXERLIST_AUTH.KEY_PREFIX + apiKey;
    return `Bearer ${key}`;
  },
};

export const FLUXERLIST_LIMITS = {
  /** Default page number when none is specified */
  DEFAULT_PAGE: 1,

  /** Default number of results per page */
  DEFAULT_LIMIT: 50,

  /** Maximum number of results per page (API enforced) */
  MAX_LIMIT: 100,

  /** Cache TTL in milliseconds for voter list responses (5 min) */
  CACHE_TTL_MS: 5 * 60 * 1000,
};

/**
 * Build a full FluxerList API URL by replacing :id in the endpoint path.
 *
 * @param {string} endpoint - One of FLUXERLIST.ENDPOINTS values (e.g. "/servers/:id/voters")
 * @param {string} resourceId - The server or bot ID or slug to substitute for :id
 * @param {object} [queryParams] - Optional query parameters
 * @param {number} [queryParams.page] - Page number (default: 1)
 * @param {number} [queryParams.limit] - Results per page, max 100 (default: 50)
 * @returns {string} Full URL ready for fetch()
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
 * Build the vote link for a resource on FluxerList.
 *
 * @param {"server"|"bot"} type - Resource type
 * @param {string} resourceId - The server or bot ID or slug
 * @returns {string} URL to the vote page on FluxerList
 */
export function buildVoteLink(type, resourceId) {
  const path = type === "server" ? "servers" : "bots";
  return `${FLUXERLIST.SITE_URL}/${path}/${resourceId}`;
}

/**
 * Build the profile link for a resource on FluxerList.
 *
 * @param {"server"|"bot"} type - Resource type
 * @param {string} resourceId - The server or bot ID or slug
 * @returns {string} URL to the profile page on FluxerList
 */
export function buildProfileLink(type, resourceId) {
  const path = type === "server" ? "servers" : "bots";
  return `${FLUXERLIST.SITE_URL}/${path}/${resourceId}`;
}
