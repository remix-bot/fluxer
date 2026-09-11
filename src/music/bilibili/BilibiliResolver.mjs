/**
 * @module src/music/bilibili/BilibiliResolver
 * @description Bilibili video resolution: URL detection (BV/av ids, b23.tv /
 * bili2233.cn short links, ?p= page selection), the public web API client
 * (view + playurl with browser-style headers and an automatic buvid
 * bootstrap), DASH audio-stream selection, and internal track building.
 *
 * The audio URLs Bilibili hands out only respond to requests carrying a
 * bilibili Referer and a browser User-Agent, so the raw CDN URL is never
 * handed to the audio pipeline directly — playback goes through the signed
 * local proxy in {@link module:src/music/bilibili/BilibiliProxy}.
 */

import { Utils } from "../../utils/Utils.mjs";
import { logger } from "../../core/Logger.mjs";

/** @type {string} @description Browser User-Agent required by Bilibili API and CDN endpoints. */
export const BILIBILI_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
/** @type {string} @description Referer required by Bilibili CDN endpoints. */
export const BILIBILI_REFERER = "https://www.bilibili.com/";

/** @type {string} @description Video metadata endpoint (bvid= or aid=). */
const API_VIEW = "https://api.bilibili.com/x/web-interface/view";
/** @type {string} @description Playback URL endpoint (DASH manifest when fnval=16). */
const API_PLAYURL = "https://api.bilibili.com/x/player/playurl";
/** @type {string} @description Homepage used once per process to bootstrap buvid3/b_nut cookies. */
const BOOTSTRAP_URL = "https://www.bilibili.com/";

/** @type {number} @description Timeout (ms) for Bilibili API requests. */
const API_TIMEOUT_MS = 15_000;
/** @type {number} @description Timeout (ms) for short-link redirect resolution. */
const SHORTLINK_TIMEOUT_MS = 10_000;
/** @type {number} @description Timeout (ms) for the one-shot cookie bootstrap. */
const BOOTSTRAP_TIMEOUT_MS = 10_000;
/** @type {number} @description Maximum number of multi-page parts queued from one video. */
const MAX_PAGES = 200;

/** @type {Set<string>} @description Bilibili hosts whose /video/ links the bot plays. */
const BILIBILI_HOSTS = new Set([
  "bilibili.com",
  "www.bilibili.com",
  "m.bilibili.com",
  "b23.tv",
  "bili2233.cn",
]);

/** @type {string} @description Error hint shown when Bilibili risk control blocks the server IP. */
const BLOCKED_HINT =
    "Bilibili blocked this server's requests (risk control, HTTP 412). " +
    "Add a cookie string from a logged-in browser to config.json -> bilibili.cookie and restart the bot.";

/** @type {string|null} @description Optional cookie string from config (SESSDATA etc.), overrides the bootstrap. */
let _cookieOverride = null;
/** @type {string|null} @description buvid3/b_nut cookies picked up from the homepage bootstrap. */
let _bootstrappedCookie = null;
/** @type {Promise|null} @description Memoized bootstrap run (best effort, never rejects). */
let _bootstrapPromise = null;

/**
 * Set a user-provided cookie string (from config.json -> bilibili.cookie).
 * Sent on every Bilibili API and CDN request; unlocks higher audio quality
 * and works around IP-level risk-control blocks.
 * @param {string|null} cookie
 */
export function setBilibiliCookie(cookie) {
  _cookieOverride = cookie ? String(cookie).trim() : null;
}

/**
 * One best-effort homepage GET per process: Bilibili's risk control expects
 * to see the buvid3/b_nut cookies the homepage sets, so picking them up
 * raises the request trust level at zero cost.
 * @returns {Promise<null>}
 */
function bootstrapCookies() {
  if (_bootstrapPromise) return _bootstrapPromise;
  _bootstrapPromise = (async () => {
    try {
      const res = await fetch(BOOTSTRAP_URL, {
        headers: { "User-Agent": BILIBILI_UA, "Accept": "text/html,application/xhtml+xml,*/*" },
        redirect: "follow",
        signal: AbortSignal.timeout(BOOTSTRAP_TIMEOUT_MS),
      });
      const parts = [];
      for (const raw of res.headers.getSetCookie?.() ?? []) {
        const pair = raw.split(";")[0].trim();
        if (/^(buvid3|b_nut|buvid4)=/.test(pair)) parts.push(pair);
      }
      try { res.body?.cancel?.(); } catch (_) {}
      if (parts.length) {
        _bootstrappedCookie = parts.join("; ");
        logger.player("[Bilibili] bootstrapped cookies: " + parts.map(p => p.split("=")[0]).join(","));
      }
    } catch (_) {
      /* best effort only — plain headerless requests still work on most IPs */
    }
    return null;
  })();
  return _bootstrapPromise;
}

/**
 * Build the header set for Bilibili API requests (UA, Referer, Accept and
 * the effective cookie: config override, else the bootstrapped buvid pair).
 * @returns {Promise<object>}
 */
async function biliRequestHeaders() {
  if (!_cookieOverride) await bootstrapCookies();
  const headers = {
    "User-Agent": BILIBILI_UA,
    "Referer": BILIBILI_REFERER,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
  };
  const cookie = _cookieOverride || _bootstrappedCookie;
  if (cookie) headers.Cookie = cookie;
  return headers;
}

/**
 * Build the header set the local proxy forwards to Bilibili CDN hosts.
 * Same trust rules as the API headers: config cookie overrides bootstrap.
 * @returns {Promise<object>}
 */
export async function buildBilibiliCdnHeaders() {
  if (!_cookieOverride) await bootstrapCookies();
  const headers = {
    "User-Agent": BILIBILI_UA,
    "Referer": BILIBILI_REFERER,
    "Accept": "*/*",
  };
  const cookie = _cookieOverride || _bootstrappedCookie;
  if (cookie) headers.Cookie = cookie;
  return headers;
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
 * GET a Bilibili API endpoint and return its `data` payload, mapping HTTP
 * status and body error codes to readable messages.
 * @param {string} url
 * @returns {Promise<object>}
 * @throws {Error} with a user-readable message on network/HTTP/API errors.
 */
async function biliJson(url) {
  const headers = await biliRequestHeaders();
  let res;
  try {
    res = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  } catch (e) {
    throw new Error("Bilibili API unreachable: " + (e?.cause?.message || e?.message || String(e)));
  }
  if (res.status === 412) {
    try { res.body?.cancel?.(); } catch (_) {}
    throw new Error(BLOCKED_HINT);
  }
  if (res.status !== 200) {
    try { res.body?.cancel?.(); } catch (_) {}
    throw new Error("Bilibili API HTTP " + res.status);
  }
  let body;
  try {
    body = await res.json();
  } catch (_) {
    throw new Error("Bilibili API returned invalid JSON");
  }
  if (body.code !== 0) throw new Error(describeApiError(body.code, body.message));
  if (!body.data) throw new Error("Bilibili API returned no data");
  return body.data;
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
 * Fetch video metadata for a parsed reference.
 * @param {{kind: string, id: string}} ref
 * @returns {Promise<object>} The view API `data` payload.
 */
export async function fetchBilibiliView(ref) {
  const params = ref.kind === "bvid" ? { bvid: ref.id } : { aid: String(ref.id) };
  return biliJson(API_VIEW + "?" + new URLSearchParams(params));
}

/**
 * Fetch the playback manifest (DASH when fnval=16) for one video page.
 * @param {{bvid?: string, aid?: number|string, cid: number|string}} meta
 * @returns {Promise<object>} The playurl API `data` payload.
 */
export async function fetchBilibiliPlayUrl(meta) {
  const params = { cid: String(meta.cid), fnval: "16", fourk: "1" };
  if (meta.bvid) params.bvid = meta.bvid;
  else if (meta.aid != null) params.aid = String(meta.aid);
  return biliJson(API_PLAYURL + "?" + new URLSearchParams(params));
}

/**
 * Pick the best DASH audio stream from a playurl payload: all audio
 * variants (plain, flac, dolby when a login cookie unlocks them) are
 * candidates and the highest-bandwidth entry wins.
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
