/**
 * @module src/music/bilibili/BilibiliResolver
 * @description Bilibili video resolution: URL detection (BV/av ids, b23.tv /
 * bili2233.cn short links, ?p= page selection), the public web API client
 * for fully anonymous playback (no login cookies, ever), best-audio-stream
 * selection and internal track building.
 *
 * Anonymous access strategy (empirically verified against the live API):
 * - Every request carries a self-managed device fingerprint: the finger/spi
 *   endpoint mints a fresh buvid3/buvid4 pair and a homepage GET contributes
 *   b_nut. Risk-control blocks (HTTP 412 / code -412) trigger one shared
 *   fingerprint refresh and retry before giving up on an endpoint.
 * - Requests prefer the WBI-signed endpoints (`/x/web-interface/wbi/view`,
 *   `/x/player/wbi/playurl`): the mixin key is derived from the anonymous
 *   nav payload's img/sub keys, and signed calls survive IP blocks that
 *   reject the legacy unsigned endpoints outright.
 * - Every API failure on the WBI path falls back to the legacy unsigned
 *   endpoint once, so a bad key never breaks playback.
 * - playurl asks for the DASH manifest (fnval=16) plus try_look=1 — anonymous
 *   callers receive real DASH audio streams (typically up to ~170 kbps AAC),
 *   a big step up from the old progressive-only fallback. When a video has no
 *   DASH audio, the html5 platform variant (platform=html5&high_quality=1)
 *   yields a progressive mp4 instead.
 *
 * The audio URLs Bilibili hands out only respond to requests carrying a
 * bilibili Referer and a browser User-Agent, so the raw CDN URL is never
 * handed to the audio pipeline directly — playback goes through the signed
 * local proxy in {@link module:src/music/bilibili/BilibiliProxy}.
 */

import crypto from "node:crypto";
import { Utils } from "../../utils/Utils.mjs";
import { logger } from "../../core/Logger.mjs";

/** @type {string} @description Browser User-Agent required by Bilibili API and CDN endpoints. */
export const BILIBILI_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
/** @type {string} @description Referer required by Bilibili CDN endpoints. */
export const BILIBILI_REFERER = "https://www.bilibili.com/";
/** @type {string} @description Page origin paired with the Referer on browser-style requests. */
const BILIBILI_ORIGIN = "https://www.bilibili.com";

/** @type {string} @description Anonymous nav endpoint carrying the WBI img/sub keys. */
const API_NAV = "https://api.bilibili.com/x/web-interface/nav";
/** @type {string} @description Video metadata endpoint — legacy (unsigned). */
const API_VIEW = "https://api.bilibili.com/x/web-interface/view";
/** @type {string} @description Video metadata endpoint — WBI-signed (preferred). */
const API_VIEW_WBI = "https://api.bilibili.com/x/web-interface/wbi/view";
/** @type {string} @description Playback URL endpoint — legacy (unsigned). */
const API_PLAYURL = "https://api.bilibili.com/x/player/playurl";
/** @type {string} @description Playback URL endpoint — WBI-signed (preferred). */
const API_PLAYURL_WBI = "https://api.bilibili.com/x/player/wbi/playurl";
/** @type {string} @description Device-fingerprint endpoint returning a fresh buvid3/buvid4 pair. */
const API_FINGER_SPI = "https://api.bilibili.com/x/frontend/finger/spi";
/** @type {string} @description Homepage used to pick up buvid3/b_nut/buvid4 Set-Cookie values. */
const BOOTSTRAP_URL = "https://www.bilibili.com/";

/** @type {Set<string>} @description Bilibili hosts whose /video/ links the bot plays. */
const BILIBILI_HOSTS = new Set([
  "bilibili.com",
  "www.bilibili.com",
  "m.bilibili.com",
  "b23.tv",
  "bili2233.cn",
]);

/** @type {number} @description Timeout (ms) for Bilibili API requests. */
const API_TIMEOUT_MS = 15_000;
/** @type {number} @description Timeout (ms) for short-link redirect resolution. */
const SHORTLINK_TIMEOUT_MS = 10_000;
/** @type {number} @description Timeout (ms) for the fingerprint bootstrap requests. */
const BOOTSTRAP_TIMEOUT_MS = 10_000;
/** @type {number} @description Cool-down (ms) before retrying a risk-control-blocked request. */
const BLOCK_RETRY_DELAY_MS = 1_200;
/** @type {number} @description Cool-down (ms) before retrying after a WBI signature rejection. */
const WBI_RETRY_DELAY_MS = 250;
/** @type {number} @description Minimum spacing (ms) between fingerprint refreshes. */
const REFRESH_MIN_INTERVAL_MS = 2_500;
/** @type {number} @description Maximum number of multi-page parts queued from one video. */
const MAX_PAGES = 200;

/** @type {object} @description Browser-exact header set for api.bilibili.com fetch calls. */
const API_HEADERS = {
  "User-Agent": BILIBILI_UA,
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "Referer": BILIBILI_REFERER,
  "Origin": BILIBILI_ORIGIN,
  "sec-ch-ua": '"Chromium";v="137", "Google Chrome";v="137", "Not-A.Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-site",
};

/** @type {object} @description Navigation header set for the homepage bootstrap request. */
const NAV_HEADERS = {
  "User-Agent": BILIBILI_UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
  "Upgrade-Insecure-Requests": "1",
};

/** @type {object} @description Header set the local proxy forwards to Bilibili CDN hosts. */
const CDN_HEADERS = {
  "User-Agent": BILIBILI_UA,
  "Accept": "*/*",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "Referer": BILIBILI_REFERER,
  "Origin": BILIBILI_ORIGIN,
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "cross-site",
};

/** @type {string} @description Error hint shown when Bilibili risk control blocks the server IP. */
const BLOCKED_HINT =
    "Bilibili blocked this server's requests (risk control, HTTP 412). " +
    "The bot manages its device fingerprint and WBI request signatures automatically, so a persistent block means " +
    "Bilibili flagged this hosting IP: a different egress IP (VPN or proxy) may be required. " +
    "This bot plays Bilibili fully anonymously, so there is no cookie workaround.";

/**
 * @type {Array<number>} @description Permutation used to derive the WBI mixin
 * key from the nav payload's img+sub keys. Only the first 32 positions are
 * ever read (the mixin key is the first 32 characters of the permuted
 * string); these 32 entries are the empirically verified prefix of the
 * published table.
 */
const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50,
  10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38,
  41, 13,
];

/** @type {RegExp} @description Characters stripped from values before WBI signing (per the published algorithm). */
const WBI_FILTER_RE = /[!'()*]/g;

/** @type {object|null} @description Auto-managed device fingerprint (buvid3/buvid4/b_nut). */
let _fingerprint = null;
/** @type {Promise|null} @description Memoized bootstrap run (best effort, never rejects). */
let _bootstrapPromise = null;
/** @type {Promise|null} @description Shared cool-down + refresh promise for blocked requests. */
let _refreshPromise = null;
/** @type {number} @description Timestamp (ms) of the last fingerprint refresh trigger. */
let _refreshGate = 0;
/** @type {{mixinKey: string, imgKey: string, subKey: string}|null} @description Cached WBI signing keys. */
let _wbiKeys = null;
/** @type {Promise|null} @description Memoized WBI key load. */
let _wbiPromise = null;

/**
 * Whether a device-cookie value is plausible (used when harvesting
 * Set-Cookie values from the homepage bootstrap).
 * @param {string} name
 * @param {string} value
 * @returns {boolean}
 */
function plausibleDeviceValue(name, value) {
  if (value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) return false;
  switch (name) {
    case "buvid3": return /^[A-Za-z0-9-]{16,}$/.test(value);
    case "b_nut":  return /^[0-9]{9,11}$/.test(value);
    case "buvid4": return /^[A-Za-z0-9-+=]{20,}$/.test(value);
    default:       return false;
  }
}

/**
 * The auto-managed device fingerprint. Bilibili's risk control expects to
 * see buvid3 (and friends) on browser-style requests; the finger/spi
 * endpoint mints a fresh pair even from IPs the WAF already distrusts, and
 * the homepage GET contributes b_nut. Best effort: on total failure requests
 * simply go out without a fingerprint.
 * @returns {Promise<null>}
 */
function bootstrapFingerprint() {
  if (_bootstrapPromise) return _bootstrapPromise;
  _bootstrapPromise = (async () => {
    const fp = {};
    await Promise.all([
      (async () => {
        try {
          const res = await fetch(API_FINGER_SPI, {
            headers: { ...API_HEADERS },
            redirect: "follow",
            signal: AbortSignal.timeout(BOOTSTRAP_TIMEOUT_MS),
          });
          if (res.status === 200) {
            const body = await res.json();
            if (body?.code === 0 && body.data) {
              if (typeof body.data.b_3 === "string" && body.data.b_3) fp.buvid3 = body.data.b_3;
              if (typeof body.data.b_4 === "string" && body.data.b_4) fp.buvid4 = body.data.b_4;
            }
          } else {
            try { res.body?.cancel?.(); } catch (_) {}
          }
        } catch (_) {}
        return null;
      })(),
      (async () => {
        try {
          const res = await fetch(BOOTSTRAP_URL, {
            headers: { ...NAV_HEADERS },
            redirect: "follow",
            signal: AbortSignal.timeout(BOOTSTRAP_TIMEOUT_MS),
          });
          const jar = {};
          for (const raw of res.headers.getSetCookie?.() ?? []) {
            const pair = raw.split(";")[0].trim();
            const eq = pair.indexOf("=");
            if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
          }
          try { res.body?.cancel?.(); } catch (_) {}
          if (!fp.buvid3 && plausibleDeviceValue("buvid3", jar.buvid3 ?? "")) fp.buvid3 = jar.buvid3;
          if (!fp.b_nut && plausibleDeviceValue("b_nut", jar.b_nut ?? "")) fp.b_nut = jar.b_nut;
          if (!fp.buvid4 && plausibleDeviceValue("buvid4", jar.buvid4 ?? "")) fp.buvid4 = jar.buvid4;
        } catch (_) {}
        return null;
      })(),
    ]);
    _fingerprint = Object.keys(fp).length ? fp : null;
    if (_fingerprint) {
      logger.player("[Bilibili] device fingerprint ready: " + Object.keys(_fingerprint).join(","));
    }
    return null;
  })();
  return _bootstrapPromise;
}

/**
 * Clear the memoized device fingerprint, WBI keys and pending refresh state
 * so the next request bootstraps everything fresh (used by tests).
 */
export function resetBilibiliFingerprint() {
  _bootstrapPromise = null;
  _fingerprint = null;
  _refreshPromise = null;
  _refreshGate = 0;
  _wbiKeys = null;
  _wbiPromise = null;
}

/**
 * Re-bootstrap the device fingerprint right now — a fresh buvid3 often
 * lifts a transient risk-control block.
 * @returns {Promise<null>}
 */
function refreshFingerprint() {
  _bootstrapPromise = null;
  return bootstrapFingerprint();
}

/**
 * Shared cool-down + refresh for risk-control-blocked requests: one short
 * pause, then a single fingerprint refresh (and WBI key invalidation) no
 * matter how many requests were blocked at the same time — the refresh is
 * rate-limited so parallel queue loads cannot hammer the endpoints.
 * @returns {Promise<null>}
 */
function refreshAfterBlock() {
  const now = Date.now();
  if (!_refreshPromise || now - _refreshGate >= REFRESH_MIN_INTERVAL_MS) {
    _refreshGate = now;
    _refreshPromise = (async () => {
      await new Promise((r) => setTimeout(r, BLOCK_RETRY_DELAY_MS));
      logger.warn("[Bilibili] risk control block (412) — refreshing device fingerprint and retrying once");
      _wbiKeys = null;
      _wbiPromise = null;
      await refreshFingerprint();
    })();
  }
  return _refreshPromise;
}

/**
 * The device-fingerprint cookie sent on Bilibili requests (buvid3/b_nut/
 * buvid4 only — no login cookies exist in this module by design).
 * @returns {string|null}
 */
function effectiveCookie() {
  if (!_fingerprint) return null;
  const parts = [];
  for (const name of ["buvid3", "b_nut", "buvid4"]) {
    if (_fingerprint[name]) parts.push(name + "=" + _fingerprint[name]);
  }
  return parts.length ? parts.join("; ") : null;
}

/**
 * Build the header set for Bilibili API requests: the browser-exact UA /
 * Referer / Origin / Sec-Fetch set plus the device fingerprint cookie.
 * @returns {Promise<object>}
 */
async function biliRequestHeaders() {
  await bootstrapFingerprint();
  const headers = { ...API_HEADERS };
  const cookie = effectiveCookie();
  if (cookie) headers.Cookie = cookie;
  return headers;
}

/**
 * Build the header set the local proxy forwards to Bilibili CDN hosts.
 * @returns {Promise<object>}
 */
export async function buildBilibiliCdnHeaders() {
  await bootstrapFingerprint();
  const headers = { ...CDN_HEADERS };
  const cookie = effectiveCookie();
  if (cookie) headers.Cookie = cookie;
  return headers;
}

/**
 * Load the WBI signing keys: the anonymous nav endpoint reports code -101
 * ("not logged in") but still carries data.wbi_img with the img/sub key
 * pair, from which the mixin key is derived through the published
 * permutation table. Keys are cached for the process lifetime and only
 * invalidated reactively (signature rejections / risk-control blocks).
 * @returns {Promise<{mixinKey: string, imgKey: string, subKey: string}>}
 * @throws {Error} when nav is unreachable or carries no wbi_img payload.
 */
async function loadWbiKeys() {
  if (_wbiKeys) return _wbiKeys;
  if (_wbiPromise) return _wbiPromise;
  _wbiPromise = (async () => {
    const headers = await biliRequestHeaders();
    const res = await fetch(API_NAV, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (res.status !== 200) {
      try { res.body?.cancel?.(); } catch (_) {}
      throw new Error("WBI nav HTTP " + res.status);
    }
    const body = await res.json();
    const img = body?.data?.wbi_img?.img_url;
    const sub = body?.data?.wbi_img?.sub_url;
    if (typeof img !== "string" || typeof sub !== "string" || !img || !sub) {
      throw new Error("WBI nav payload has no wbi_img (code " + body?.code + ")");
    }
    const imgKey = new URL(img).pathname.split("/").pop().split(".")[0];
    const subKey = new URL(sub).pathname.split("/").pop().split(".")[0];
    const raw = imgKey + subKey;
    if (raw.length < 32) throw new Error("WBI keys too short");
    const mixinKey = MIXIN_TAB.map((i) => raw[i]).join("").slice(0, 32);
    if (mixinKey.length !== 32) throw new Error("WBI mixin key derivation failed");
    _wbiKeys = { mixinKey, imgKey, subKey };
    logger.player("[Bilibili] WBI signing keys ready (anonymous)");
    return _wbiKeys;
  })().catch((e) => {
    _wbiPromise = null;
    throw e;
  });
  return _wbiPromise;
}

/**
 * Sign API params for a WBI endpoint: values are sanitized, `wts` is added,
 * pairs are sorted by key, and `w_rid` is the MD5 of the query string plus
 * the mixin key — the published web-client algorithm.
 * @param {object} params
 * @returns {string} The signed query string (w_rid included).
 */
function signWbiParams(params) {
  const keys = _wbiKeys;
  if (!keys) throw new Error("WBI keys not loaded");
  const merged = { ...params, wts: Math.floor(Date.now() / 1000) };
  const clean = {};
  for (const [k, v] of Object.entries(merged)) {
    clean[k] = String(v).replace(WBI_FILTER_RE, "");
  }
  const qs = Object.keys(clean).sort()
      .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(clean[k]))
      .join("&");
  const wRid = crypto.createHash("md5").update(qs + keys.mixinKey, "utf8").digest("hex");
  return qs + "&w_rid=" + wRid;
}

/**
 * Turn a Bilibili API error code into a user-readable message.
 * @param {number} code
 * @param {string} message
 * @returns {string}
 */
function describeApiError(code, message) {
  if (code === -412) return BLOCKED_HINT;
  if (code === -404 || code === 404 || code === -400) return "video not found (it may be private, deleted, or the link is wrong)";
  if (code === -403 || code === 403) return "this video is region-locked or private";
  if (code === 62002 || code === 62004) return "this video is not publicly visible";
  if (code === 62012) return "this video is only visible to its uploader";
  return "Bilibili API error " + code + (message ? ": " + message : "");
}

/**
 * One raw GET against api.bilibili.com.
 * @param {string} url
 * @returns {Promise<{status: number, body: object|null}>}
 * @throws {Error} on network failure.
 */
async function rawGet(url) {
  const headers = await biliRequestHeaders();
  const res = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  if (res.status !== 200) {
    try { res.body?.cancel?.(); } catch (_) {}
    return { status: res.status, body: null };
  }
  let body;
  try {
    body = await res.json();
  } catch (_) {
    return { status: -1, body: null };
  }
  return { status: 200, body };
}

/**
 * Read one JSON API response: HTTP 200 + body code 0 returns `data`.
 * @param {{status: number, body: object|null}} r
 * @returns {object} The `data` payload.
 * @throws {Error} with a user-readable message for HTTP/transport/API errors.
 */
function unwrap(r) {
  if (r.status !== 200) throw new Error("Bilibili API HTTP " + r.status);
  const body = r.body;
  if (!body) throw new Error("Bilibili API returned invalid JSON");
  if (body.code !== 0) throw new Error(describeApiError(body.code, body.message));
  if (!body.data) throw new Error("Bilibili API returned no data");
  return body.data;
}

/**
 * GET a Bilibili API endpoint anonymously and return its `data` payload.
 * The WBI-signed endpoint is tried first (it survives IP blocks that reject
 * legacy unsigned calls); risk-control blocks and signature rejections
 * trigger one refresh + retry; hard WBI failures fall back to the legacy
 * unsigned endpoint, whose own errors are surfaced to the user.
 * @param {string} wbiUrl - Full WBI endpoint base URL.
 * @param {string} legacyUrl - Full legacy endpoint base URL.
 * @param {object} params - Query parameters (signed for WBI, plain for legacy).
 * @returns {Promise<object>} The endpoint's `data` payload.
 * @throws {Error} with a user-readable message on network/HTTP/API errors.
 */
async function biliApiGet(wbiUrl, legacyUrl, params) {
  // --- WBI-signed attempt (with one reactive refresh + retry) ---
  for (let attempt = 0; attempt < 2; attempt++) {
    let keys;
    try {
      keys = await loadWbiKeys();
    } catch (_) {
      break; // no keys -> legacy path
    }
    let r;
    try {
      r = await rawGet(wbiUrl + "?" + signWbiParams(params));
    } catch (e) {
      if (attempt === 0) continue; // transient network error -> retry once with fresh signature (wts changes)
      break; // legacy path
    }
    if (r.status === 412 || r.body?.code === -412) {
      if (attempt === 0) { await refreshAfterBlock(); continue; }
      break; // blocked even signed -> try legacy
    }
    if (r.body?.code === -403) {
      // Either a WBI signature rejection or a region-locked video: refresh
      // the keys once; if it persists, the legacy endpoint below decides.
      if (attempt === 0) {
        _wbiKeys = null;
        _wbiPromise = null;
        await new Promise((r2) => setTimeout(r2, WBI_RETRY_DELAY_MS));
        continue;
      }
      break; // legacy decides (region-locked videos fail there too)
    }
    if (r.status === 200 && r.body) {
      if (r.body.code === 0) {
        if (r.body.data) return r.body.data;
        break; // code 0 without data -> legacy path
      }
      // A definite business error is trustworthy — surface it directly.
      throw new Error(describeApiError(r.body.code, r.body.message));
    }
    break; // unexpected status -> legacy path
  }

  // --- Legacy unsigned attempt (with one fingerprint refresh + retry) ---
  const qs = new URLSearchParams(params).toString();
  for (let attempt = 0; ; attempt++) {
    let r;
    try {
      r = await rawGet(legacyUrl + "?" + qs);
    } catch (e) {
      throw new Error("Bilibili API unreachable: " + (e?.cause?.message || e?.message || String(e)));
    }
    if (r.status === 412 || r.body?.code === -412) {
      if (attempt === 0) { await refreshAfterBlock(); continue; }
      throw new Error(BLOCKED_HINT);
    }
    return unwrap(r);
  }
}

/**
 * Check whether a string is an HTTP(S) URL on a known Bilibili host
 * (www./m. bilibili.com or the b23.tv / bili2233.cn shorteners).
 * @param {string} str
 * @returns {boolean}
 */
export function isBilibiliUrl(str) {
  if (!str || typeof str !== "string") return false;
  const trimmed = str.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  try {
    const u = new URL(trimmed);
    return BILIBILI_HOSTS.has(u.hostname.toLowerCase());
  } catch (_) {
    return false;
  }
}

/**
 * Extract the video reference (BV/av id plus optional ?p= page) from a URL
 * on a Bilibili host. BV ids are case-sensitive and preserved verbatim.
 * @param {string} urlStr
 * @returns {{kind: "bvid"|"aid", id: string, page: number|null}|null}
 */
export function parseBilibiliVideoRef(urlStr) {
  let u;
  try { u = new URL(String(urlStr)); } catch (_) { return null; }
  if (!BILIBILI_HOSTS.has(u.hostname.toLowerCase())) return null;
  const m = u.pathname.match(/\/video\/(BV[0-9A-Za-z]{8,12}|av(\d+))/i);
  if (!m) return null;
  const raw = m[1];
  const isAv = /^av/i.test(raw);
  const pageRaw = u.searchParams.get("p");
  const page = pageRaw && /^\d+$/.test(pageRaw) ? Math.max(1, parseInt(pageRaw, 10)) : null;
  return { kind: isAv ? "aid" : "bvid", id: isAv ? m[2] : raw, page };
}

/**
 * Resolve b23.tv / bili2233.cn short links to their final URL by following
 * redirects. Falls back to the short URL itself when resolution fails (the
 * view API then produces the real error). Non-bilibili redirects (bangumi,
 * space, etc.) yield null — only /video/ pages are playable.
 * @param {URL} u
 * @returns {Promise<string|null>}
 */
async function resolveShortLink(u) {
  try {
    const res = await fetch(u.href, {
      headers: { "User-Agent": BILIBILI_UA, "Accept": "text/html,*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(SHORTLINK_TIMEOUT_MS),
    });
    const finalUrl = res.url || u.href;
    try { res.body?.cancel?.(); } catch (_) {}
    let final;
    try { final = new URL(finalUrl); } catch (_) { return null; }
    if (!BILIBILI_HOSTS.has(final.hostname.toLowerCase())) return null;
    return final.href;
  } catch (_) {
    return u.href;
  }
}

/**
 * Normalize any accepted Bilibili link to its canonical URL form: short
 * hosts are expanded, other hosts pass through. Returns null when the
 * string is not a URL on a Bilibili host.
 * @param {string} str
 * @returns {Promise<string|null>}
 */
async function normalizeBilibiliUrl(str) {
  const trimmed = String(str ?? "").trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  let u;
  try { u = new URL(trimmed); } catch (_) { return null; }
  const host = u.hostname.toLowerCase();
  if (!BILIBILI_HOSTS.has(host)) return null;
  if (host === "b23.tv" || host === "bili2233.cn") return resolveShortLink(u);
  return u.href;
}

/**
 * Fetch video metadata for a parsed reference (WBI-signed view, legacy
 * fallback).
 * @param {{kind: string, id: string}} ref
 * @returns {Promise<object>} The view API `data` payload.
 */
export async function fetchBilibiliView(ref) {
  const params = ref.kind === "bvid" ? { bvid: ref.id } : { aid: String(ref.id) };
  return biliApiGet(API_VIEW_WBI, API_VIEW, params);
}

/**
 * Fetch the playback manifest for one video page (WBI-signed playurl,
 * legacy fallback). Both modes carry try_look=1, the anonymous
 * watch-anyway flag. Default mode requests the DASH manifest (fnval=16),
 * which anonymously includes real DASH audio streams; html5 mode requests
 * the progressive mp4 (durl) used when a video has no DASH audio.
 * @param {{bvid?: string, aid?: number|string, cid: number|string}} meta
 * @param {{mode?: "dash"|"html5"}} [opts]
 * @returns {Promise<object>} The playurl API `data` payload.
 */
export async function fetchBilibiliPlayUrl(meta, opts = {}) {
  const params = opts.mode === "html5"
      ? { cid: String(meta.cid), platform: "html5", high_quality: "1", try_look: "1" }
      : { cid: String(meta.cid), fnval: "16", fourk: "1", try_look: "1" };
  if (meta.bvid) params.bvid = meta.bvid;
  else if (meta.aid != null) params.aid = String(meta.aid);
  return biliApiGet(API_PLAYURL_WBI, API_PLAYURL, params);
}

/**
 * Pick the best DASH audio stream from a playurl payload: all audio
 * variants are candidates and the highest-bandwidth entry wins. Anonymous
 * calls return the regular AAC tiers here (empirically up to ~170 kbps).
 * @param {object} data - playurl `data` payload.
 * @returns {object|null} The chosen audio stream entry, or null.
 */
export function pickBestAudioStream(data) {
  const dash = data?.dash;
  const candidates = [];
  if (Array.isArray(dash?.audio)) candidates.push(...dash.audio);
  if (Array.isArray(dash?.flac?.audio)) candidates.push(...dash.flac.audio);
  if (Array.isArray(dash?.dolby?.audio)) candidates.push(...dash.dolby.audio);
  const usable = candidates.filter(a => typeof a?.baseUrl === "string" && a.baseUrl.startsWith("http"));
  usable.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
  return usable[0] ?? null;
}

/**
 * Pick the progressive (non-DASH) fallback streams from a playurl payload:
 * the durl entries (mp4/flv) whose audio the node can decode directly.
 * All segments are returned — a single segment is served through the plain
 * proxy URL, multiple segments through the list/concatenating proxy mode.
 * @param {object} data - playurl `data` payload.
 * @returns {{segments: Array<{url: string, size: number, backupUrls: Array<string>}>}|null}
 */
export function pickProgressiveSegments(data) {
  const durl = Array.isArray(data?.durl) ? data.durl : null;
  if (!durl || !durl.length) return null;
  const segments = [];
  for (const seg of durl) {
    if (typeof seg?.url !== "string" || !seg.url.startsWith("http")) return null;
    const backupUrls = Array.isArray(seg.backup_url)
        ? seg.backup_url.filter(u => typeof u === "string" && u.startsWith("http"))
        : [];
    segments.push({ url: seg.url, size: Math.floor(Number(seg.size) || 0), backupUrls });
  }
  return segments.length ? { segments } : null;
}

/**
 * Build the https page URL for a video (optionally a specific part).
 * @param {string} bvid
 * @param {number|null} page
 * @returns {string}
 */
function pageUrl(bvid, page) {
  return page && page > 1
      ? "https://www.bilibili.com/video/" + bvid + "?p=" + page
      : "https://www.bilibili.com/video/" + bvid;
}

/**
 * Force https on Bilibili asset URLs (thumbnails come back as http://).
 * @param {string|null} url
 * @returns {string|null}
 */
function httpsify(url) {
  if (typeof url !== "string" || !url) return null;
  return url.replace(/^http:\/\//i, "https://");
}

/**
 * Build one internal track object for a single video page.
 * @param {object} opts - { bvid, aid, cid, page, partTitle, title, durationSec, thumbnail, owner }
 * @returns {object}
 */
function buildTrack(opts) {
  const { bvid, aid, cid, page, partTitle, title, durationSec, thumbnail, owner } = opts;
  const displayTitle = partTitle && partTitle !== title ? title + " [P" + page + ": " + partTitle + "]" : title;
  const ms = Math.max(0, Math.floor(Number(durationSec) || 0) * 1000);
  const authorUrl = owner?.mid ? "https://space.bilibili.com/" + owner.mid : null;
  return {
    type:        "bilibili",
    videoId:     bvid,
    encoded:     "",
    sourceName:  "bilibili",
    title:       displayTitle,
    url:         pageUrl(bvid, page),
    thumbnail:   httpsify(thumbnail),
    spotifyUrl:  null,
    artist:      owner?.name ?? null,
    author:      { name: owner?.name ?? "Unknown", url: authorUrl },
    artists:     null,
    _durationMs: ms,
    duration:    { timestamp: Utils.prettifyMS(ms), seconds: Math.floor(ms / 1000) },
    bilibili:    { bvid, aid: aid ?? null, cid, page: page || 1 },
  };
}

/**
 * Turn a view API payload into queueable tracks.
 * Requested page: exactly that part. Multi-page video without a page: every
 * part (capped at {@link MAX_PAGES}), matching the YouTube playlist UX.
 * @param {object} data - view API `data` payload.
 * @param {number|null} requestedPage
 * @returns {{video: object, tracks: Array<object>}}
 */
function buildBilibiliResult(data, requestedPage) {
  const bvid    = data.bvid;
  const aid     = data.aid ?? null;
  const title   = String(data.title ?? "Bilibili video");
  const pic     = httpsify(data.pic);
  const owner   = data.owner ?? null;
  const pages   = Array.isArray(data.pages) ? data.pages : [];

  const base = { bvid, aid, title, thumbnail: pic, owner };
  const video = { ...base, url: pageUrl(bvid, null), durationSec: data.duration ?? 0 };

  if (requestedPage != null) {
    if (pages.length > 1) {
      const page = pages.find(p => Number(p.page) === requestedPage)
          ?? (requestedPage >= 1 && requestedPage <= pages.length ? pages[requestedPage - 1] : null);
      if (!page) throw new Error("this video has " + pages.length + " part(s) — there is no part " + requestedPage);
      return { video, tracks: [buildTrack({
        ...base, cid: page.cid, page: Number(page.page) || requestedPage,
        partTitle: page.part, durationSec: page.duration ?? data.duration,
      })] };
    }
    if (requestedPage > 1) throw new Error("this video has a single part — there is no part " + requestedPage);
  }

  if (pages.length > 1) {
    const tracks = pages.slice(0, MAX_PAGES).map(p => buildTrack({
      ...base, cid: p.cid, page: Number(p.page) || 1,
      partTitle: p.part, durationSec: p.duration ?? data.duration,
    }));
    return { video, tracks };
  }

  return {
    video,
    tracks: [buildTrack({
      ...base, cid: data.cid, page: 1, partTitle: null, durationSec: data.duration ?? 0,
    })],
  };
}

/**
 * Full resolution pipeline for a pasted Bilibili link: normalize (expand
 * short links), parse the video reference, fetch metadata, build tracks.
 * @param {string} input - The raw query string (a Bilibili URL).
 * @returns {Promise<{video: object, tracks: Array<object>}>}
 * @throws {Error} with a user-readable message when the link is not a
 *   playable video, the API fails, or the video is unavailable.
 */
export async function resolveBilibiliVideo(input) {
  const normalized = await normalizeBilibiliUrl(input);
  if (!normalized) throw new Error("not a Bilibili link");
  const ref = parseBilibiliVideoRef(normalized);
  if (!ref) throw new Error("only Bilibili video links are supported (…/video/BV… or …/video/av…)");
  const data = await fetchBilibiliView(ref);
  logger.player("[Bilibili] resolved " + (ref.kind === "bvid" ? ref.id : "av" + ref.id) + ": " + data.title);
  return buildBilibiliResult(data, ref.page);
}
