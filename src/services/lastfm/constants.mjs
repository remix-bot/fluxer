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

/** @private Make an authenticated Last.fm API call. @async @param {object} params @param {string} apiSecret @param {boolean} [post=false] @returns {Promise<object>} @throws {Error} On HTTP or Last.fm API error. */
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
      }
    : {};

  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Last.fm HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  if (data.error) {
    throw new Error(`Last.fm ${data.error}: ${data.message}`);
  }
  return data;
}

export { BASE_URL, normalizeTrackText, buildSignature, apiCall };
