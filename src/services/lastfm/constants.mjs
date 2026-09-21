/**
 * @module src/services/lastfm/constants
 * @description Constants and helpers shared by the Last.fm base class and all
 * mixin modules: the API endpoint, shared text normalisation, request signing
 * and the signed Last.fm API call wrapper. Kept in a dependency-free module so
 * the mixins never import the class file (no circular imports).
 */

import crypto from "node:crypto";
import { Utils } from "../../utils/Utils.mjs";

const BASE_URL = "https://ws.audioscrobbler.com/2.0/";

/** @private @param {string} value @returns {string} */
function normalizeTrackText(value) {
  return Utils.normalizeText(value);
}

/** @private Build an API signature per Last.fm auth spec. @param {object} params @param {string} apiSecret @returns {string} MD5 hex digest. */
function buildSignature(params, apiSecret) {
  const sorted = Object.keys(params).sort();
  const str = sorted.map(k => k + params[k]).join("");
  return crypto.createHash("md5").update(str + apiSecret).digest("hex");
}

/** @private @type {number} @description AbortSignal timeout (ms) for Last.fm API calls — prevents stalled TCP connections from hanging for the OS-level timeout (~15 min). */
const LASTFM_FETCH_TIMEOUT_MS = 15_000;

/**
 * @class LastFmApiError
 * @description Typed error for Last.fm API failures. All diagnostic detail
 * lives in the message itself ("Last.fm user not found", "Last.fm HTTP 404:")
 * so callers classify outcomes via isLastFmUserNotFound() without needing
 * extra structured fields on the error object.
 */
class LastFmApiError extends Error {
  /**
   * @param {string} apiMessage - Message from the Last.fm API body (may be empty).
   * @param {object} [meta]
   * @param {number} [meta.status] - HTTP status code (0 when body-level error).
   * @param {number} [meta.code] - Last.fm error code from the response body.
   */
  constructor(apiMessage, { status = 0, code = 0 } = {}) {
    const msg = String(apiMessage ?? "");
    super(
      /user not found/i.test(msg) ? "Last.fm user not found"
        : status ? `Last.fm HTTP ${status}: ${msg || `error ${code}`}`
        : `Last.fm error ${code}: ${msg}`
    );
    this.name = "LastFmApiError";
  }
}

/**
 * Check whether an error is Last.fm's "user not found" (error 6) — the
 * expected outcome when a linked account was renamed or deleted. Matches
 * typed LastFmApiError messages as well as legacy raw-format errors from
 * before the typed-error rework.
 * @param {Error} err
 * @returns {boolean}
 */
function isLastFmUserNotFound(err) {
  return /user not found/i.test(String(err?.message ?? ""));
}

/** @type {Set<string>} @description Users already warned about as stale (dedup for background flows). */
const _staleUserWarned = new Set();

/**
 * Report a stale linked user only once per bot+user pair (per process).
 * @param {object} manager - LastFmManager instance (used for botId scoping).
 * @param {string} userId
 * @returns {boolean} True the first time this user is reported.
 */
function noteStaleUser(manager, userId) {
  const key = `${manager?.botId ?? ""}:${userId}`;
  if (_staleUserWarned.has(key)) return false;
  if (_staleUserWarned.size >= 1000) _staleUserWarned.clear();
  _staleUserWarned.add(key);
  return true;
}

/** @private Make an authenticated Last.fm API call. @async @param {object} params @param {string} apiSecret @param {boolean} [post=false] @returns {Promise<object>} @throws {LastFmApiError} On HTTP or Last.fm API error. */
async function apiCall(params, apiSecret, post = false) {
  const allParams = { ...params };
  allParams.api_sig = buildSignature(allParams, apiSecret);
  allParams.format  = "json";

  const url = post ? BASE_URL : `${BASE_URL}?${new URLSearchParams(allParams)}`;

  const opts = post
    ? {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(allParams).toString(),
        signal: AbortSignal.timeout(LASTFM_FETCH_TIMEOUT_MS),
      }
    : { signal: AbortSignal.timeout(LASTFM_FETCH_TIMEOUT_MS) };

  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let code = 0;
    let message = "";
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") {
        code = Number(parsed.error) || 0;
        message = String(parsed.message ?? "");
      }
    } catch (_) {
      message = text.slice(0, 200);
    }
    throw new LastFmApiError(message, { status: res.status, code });
  }

  const data = await res.json();
  if (data.error) {
    throw new LastFmApiError(String(data.message ?? ""), { code: Number(data.error) || 0 });
  }
  return data;
}

export { BASE_URL, normalizeTrackText, buildSignature, apiCall, LastFmApiError, isLastFmUserNotFound, noteStaleUser };
