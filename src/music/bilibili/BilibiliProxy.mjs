/**
 * @module src/music/bilibili/BilibiliProxy
 * @description A tiny localhost HTTP proxy that lets the NodeLink/Lavalink
 * node fetch Bilibili CDN audio. Bilibili's stream URLs (DASH m4s and
 * progressive mp4/flv alike) only respond to requests carrying a bilibili
 * Referer and a browser User-Agent — headers an audio node cannot attach —
 * so the bot signs the CDN URL with a per-process HMAC key and hands the
 * node `http://<host>:<port>/s?u=<cdn-url>&e=<expiry>&x=<hmac>` instead.
 *
 * Two serving modes:
 * - `/s` — a single CDN URL: the proxy validates the signature, then
 *   streams the CDN response (including Range requests, which give seek
 *   support) with the right headers attached.
 * - `/l` — a list of progressive segments: some playurl responses return
 *   the audio split over several durl segments; the proxy streams them
 *   back-to-back as one continuous body. Range requests are mapped across
 *   the concatenation using the segment sizes from the playurl payload,
 *   so seeking works in this mode too.
 *
 * The server starts lazily on the first Bilibili play and is unref'd, so it
 * never delays startup or shutdown. Only URLs signed by this very process
 * can pass through — the HMAC key is random per boot.
 */

import http from "node:http";
import crypto from "node:crypto";
import { Readable, Transform } from "node:stream";
import { logger } from "../../core/Logger.mjs";
import { buildBilibiliCdnHeaders } from "./BilibiliResolver.mjs";

/** @type {number} @description How long a signed proxy URL stays valid (Bilibili CDN URLs themselves expire). */
const PROXY_TTL_MS = 6 * 60 * 60 * 1000;
/** @type {number} @description Timeout (ms) waiting for the CDN response headers. */
const CDN_CONNECT_TIMEOUT_MS = 20_000;
/** @type {number} @description Maximum number of segments served through one list-mode URL. */
const MAX_SEGMENTS = 64;

/** @type {object} @description Effective proxy configuration (merged from config.json -> bilibili). */
const _cfg = {
  enabled:  true,
  bind:     "127.0.0.1",
  port:     0,
  advertiseHost: null,
};

/** @type {http.Server|null} @description The lazily-started proxy server (unref'd). */
let _server = null;
/** @type {Buffer|null} @description Per-process HMAC signing key. */
let _key = null;
/** @type {Promise|null} @description Memoized server start (idempotent). */
let _starting = null;

/**
 * Merge the config.json `bilibili` section into the proxy configuration.
 * @param {object} [section]
 * @param {boolean} [section.enabled=true] - false disables Bilibili playback.
 * @param {string} [section.bind="127.0.0.1"] - Address the proxy listens on.
 * @param {number} [section.port=0] - Listen port (0 = pick a free port).
 * @param {string} [section.advertiseHost] - Host the audio node should use
 *   to reach the proxy (defaults to the bind address; set when the node runs
 *   on another machine/container).
 */
export function configureBilibiliProxy(section = {}) {
  if (section.bind != null)       _cfg.bind          = String(section.bind);
  if (section.port != null)       _cfg.port          = Number(section.port) || 0;
  if (section.advertiseHost != null) _cfg.advertiseHost = String(section.advertiseHost);
  if (section.enabled != null)    _cfg.enabled       = section.enabled !== false;
}

/**
 * Whether Bilibili playback is enabled in config.
 * @returns {boolean}
 */
export function bilibiliEnabled() {
  return _cfg.enabled === true;
}

/**
 * The host:port pair advertised to the audio node. 0.0.0.0 binds are
 * advertised as 127.0.0.1 unless an explicit advertiseHost was configured.
 * @returns {string}
 */
function advertiseHost() {
  if (_cfg.advertiseHost) return _cfg.advertiseHost;
  return _cfg.bind === "0.0.0.0" || _cfg.bind === "::" ? "127.0.0.1" : _cfg.bind;
}

/**
 * Start the proxy server (once per process) and return its listening info.
 * @returns {Promise<{port: number, host: string}>}
 */
export function ensureBilibiliProxy() {
  if (_starting) return _starting;
  _starting = new Promise((resolve, reject) => {
    try {
      _key = crypto.randomBytes(32);
      const server = http.createServer((req, res) => {
        handleProxyRequest(req, res).catch(err => {
          logger.warn("[BilibiliProxy] request failed: " + (err?.message || err));
          try {
            if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
            res.end("bilibili proxy error: " + (err?.message || err));
          } catch (_) {}
        });
      });
      server.on("clientError", (_err, socket) => {
        try { socket.destroy(); } catch (_) {}
      });
      server.listen(_cfg.port, _cfg.bind, () => {
        const addr = server.address();
        _server = server;
        const port = typeof addr === "object" && addr ? addr.port : _cfg.port;
        logger.player("[BilibiliProxy] listening on " + _cfg.bind + ":" + port + " (advertised as " + advertiseHost() + ")");
        resolve({ port, host: advertiseHost() });
      });
      server.once("error", (err) => {
        _starting = null;
        reject(new Error("bilibili proxy failed to listen on " + _cfg.bind + ":" + _cfg.port + ": " + err.message));
      });
      server.unref?.();
    } catch (e) {
      _starting = null;
      reject(e);
    }
  });
  return _starting;
}

/**
 * Current proxy info (without starting it).
 * @returns {{port: number, host: string}|null}
 */
export function bilibiliProxyInfo() {
  if (!_server) return null;
  const addr = _server.address();
  const port = typeof addr === "object" && addr ? addr.port : _cfg.port;
  return { port, host: advertiseHost() };
}

/**
 * Stop the proxy and clear its key (used by tests and reconfiguration).
 * @returns {Promise<void>}
 */
export function resetBilibiliProxy() {
  const server = _server;
  _server = null;
  _starting = null;
  _key = null;
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    try { server.close(() => resolve()); } catch (_) { resolve(); }
    try { server.closeAllConnections?.(); } catch (_) {}
  });
}

/**
 * HMAC-SHA256 signature binding a payload to its expiry epoch.
 * @param {string} target
 * @param {number} expires
 * @returns {string}
 */
function signTarget(target, expires) {
  return crypto.createHmac("sha256", _key).update(target + "." + expires).digest("hex");
}

/**
 * Constant-time signature verification.
 * @param {string} target
 * @param {number} expires
 * @param {string} sig
 * @returns {boolean}
 */
function verifySignature(target, expires, sig) {
  if (!_key) return false;
  const expected = Buffer.from(signTarget(target, expires), "utf8");
  const provided = Buffer.from(String(sig ?? ""), "utf8");
  return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
}

/**
 * Sign a single Bilibili CDN URL into a proxy URL the audio node can fetch.
 * Starts the proxy on first use. The HMAC is computed over the
 * base64url-encoded target exactly as it travels in the `u` query
 * parameter, so verification on the serving side never has to guess the
 * encoding.
 * @param {string} targetUrl - The raw CDN (m4s / mp4) URL from the playurl API.
 * @param {number} [ttlMs=PROXY_TTL_MS] - Signature lifetime.
 * @returns {Promise<string>} The signed proxy URL (`/s` mode).
 */
export async function buildSignedProxyUrl(targetUrl, ttlMs = PROXY_TTL_MS) {
  const { port, host } = await ensureBilibiliProxy();
  const expires = Date.now() + ttlMs;
  const u = Buffer.from(String(targetUrl), "utf8").toString("base64url");
  const x = signTarget(u, expires);
  return "http://" + host + ":" + port + "/s?u=" + u + "&e=" + expires + "&x=" + x;
}

/**
 * Sign a multi-segment progressive stream into a concatenating proxy URL.
 * The payload carries each segment's CDN URL and byte size (plus up to four
 * backup URLs); the `/l` handler streams the segments back-to-back and maps
 * Range requests across the concatenation.
 * @param {Array<{url: string, size: number, backupUrls?: Array<string>}>} segments
 * @param {number} [ttlMs=PROXY_TTL_MS] - Signature lifetime.
 * @returns {Promise<string>} The signed proxy URL (`/l` mode).
 */
export async function buildSignedListProxyUrl(segments, ttlMs = PROXY_TTL_MS) {
  const { port, host } = await ensureBilibiliProxy();
  const payload = JSON.stringify(
      (Array.isArray(segments) ? segments : []).slice(0, MAX_SEGMENTS).map(s => ({
        u: String(s?.url ?? ""),
        s: Math.max(0, Math.floor(Number(s?.size) || 0)),
        b: Array.isArray(s?.backupUrls)
            ? s.backupUrls.filter(u => typeof u === "string" && u.startsWith("http")).slice(0, 4)
            : [],
      })),
  );
  const u = Buffer.from(payload, "utf8").toString("base64url");
  const expires = Date.now() + ttlMs;
  const x = signTarget(u, expires);
  return "http://" + host + ":" + port + "/l?u=" + u + "&e=" + expires + "&x=" + x;
}

/**
 * Verify a proxy request's signature and return its decoded payload.
 * @param {URL} u - The parsed request URL.
 * @returns {string} The base64-decoded `u` payload.
 * @returns {null} when the signature/expiry check fails (response already sent).
 */
function checkSignature(u, res) {
  const uParam = u.searchParams.get("u");
  const expires = Number(u.searchParams.get("e"));
  const sig = u.searchParams.get("x");
  if (!uParam || !Number.isFinite(expires) || !sig || Date.now() >= expires || !verifySignature(uParam, expires, sig)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("forbidden");
    return null;
  }
  return uParam;
}

/**
 * Parse a `Range: bytes=a-b` header against a known total length.
 * @param {string} header
 * @param {number} total
 * @returns {{start: number, end: number}|"invalid"|null} "invalid" means the
 *   header is syntactically valid but unsatisfiable (416); null means the
 *   header is absent or unparseable (serve 200 from byte 0).
 */
function parseByteRange(header, total) {
  const m = /^bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/.exec(String(header || ""));
  if (!m) return null;
  const [, a, b] = m;
  if (a === "" && b === "") return null;
  if (a === "") {
    // suffix range: last N bytes
    const n = Math.min(parseInt(b, 10), total);
    return n <= 0 ? "invalid" : { start: total - n, end: total - 1 };
  }
  const start = parseInt(a, 10);
  if (start >= total) return "invalid";
  let end = b === "" ? total - 1 : Math.min(parseInt(b, 10), total - 1);
  if (end < start) end = start;
  return { start, end };
}

/**
 * Fetch one upstream (a segment URL, honoring mapped sub-ranges), trying
 * backup URLs on connect failure.
 * @param {{u: string, s: number, b: Array<string>}} seg
 * @param {object} forwardHeaders - CDN headers (Referer/UA/cookie).
 * @param {string|null} range - Range header for this segment or null.
 * @param {AbortSignal} signal
 * @returns {Promise<Response>}
 * @throws {Error} when every candidate URL fails.
 */
async function fetchSegment(seg, forwardHeaders, range, signal) {
  const candidates = [seg.u, ...seg.b];
  let lastErr = null;
  for (const candidate of candidates) {
    const headers = { ...forwardHeaders };
    if (range) headers.Range = range;
    try {
      return await fetch(candidate, { headers, redirect: "follow", signal });
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error("CDN fetch failed: " + (lastErr?.cause?.message || lastErr?.message || String(lastErr)));
}

/**
 * Stream one upstream body into the response without ending it (list mode:
 * further segments follow). Resolves when the source is exhausted or the
 * byte cap is reached — whichever comes first. The cap guarantees the
 * concatenation matches the declared segment sizes even when an upstream
 * over-delivers (e.g. a CDN that ignores a Range request and answers with
 * the full body): extra bytes are swallowed and the upstream is destroyed
 * early to save bandwidth.
 * @param {Response} upstream
 * @param {http.ServerResponse} res
 * @param {number} maxBytes - Exact number of bytes to deliver (< 0 = all).
 * @returns {Promise<void>}
 */
function pipeSegmentBody(upstream, res, maxBytes) {
  return new Promise((resolve, reject) => {
    if (!upstream.body) { resolve(); return; }
    const source = Readable.fromWeb(upstream.body);
    let remaining = maxBytes >= 0 ? maxBytes : Number.POSITIVE_INFINITY;
    let capped = false;
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err && !capped) reject(err);
      else resolve();
    };
    const gate = new Transform({
      transform(chunk, _enc, cb) {
        if (remaining <= 0) {
          capped = true;
          try { source.destroy(); } catch (_) {}
          cb();
          return;
        }
        if (chunk.length > remaining) {
          capped = true;
          const slice = chunk.subarray(0, remaining);
          remaining = 0;
          try { source.destroy(); } catch (_) {}
          cb(null, slice);
          return;
        }
        remaining -= chunk.length;
        cb(null, chunk);
      },
    });
    gate.once("error", (e) => finish(e));
    res.once("error", (e) => finish(e));
    source.once("error", (e) => finish(e));
    source.once("close", () => { if (capped) gate.end(); });
    gate.once("end", () => finish());
    source.pipe(gate);
    gate.pipe(res, { end: false });
  });
}

/**
 * Serve one proxy request: route to the single-URL (`/s`) or segment-list
 * (`/l`) handler after signature verification.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @returns {Promise<void>}
 */
async function handleProxyRequest(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("method not allowed");
    return;
  }

  let u;
  try { u = new URL(req.url ?? "/", "http://localhost"); } catch (_) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("bad request");
    return;
  }
  if (u.pathname !== "/s" && u.pathname !== "/l") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }

  const uParam = checkSignature(u, res);
  if (uParam == null) return;

  let payload;
  try { payload = Buffer.from(uParam, "base64url").toString("utf8"); } catch (_) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("bad target");
    return;
  }

  if (u.pathname === "/s") {
    await serveSingle(req, res, payload);
  } else {
    await serveSegmentList(req, res, payload);
  }
}

/**
 * `/s` mode: verify the target URL, fetch it with the Referer/UA headers
 * Bilibili requires, and pipe the response through (status,
 * content-type/length/range and Range semantics included).
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} payload - The raw CDN URL.
 * @returns {Promise<void>}
 */
async function serveSingle(req, res, payload) {
  let targetUrl;
  try { targetUrl = new URL(payload); } catch (_) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("bad target");
    return;
  }
  if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("bad target protocol");
    return;
  }

  const forwardHeaders = await buildBilibiliCdnHeaders();
  if (req.headers.range) forwardHeaders.Range = req.headers.range;

  const abort = new AbortController();
  const connectTimer = setTimeout(() => abort.abort(), CDN_CONNECT_TIMEOUT_MS);
  req.once("close", () => abort.abort());

  let upstream;
  try {
    upstream = await fetch(targetUrl.href, {
      method: req.method === "HEAD" ? "HEAD" : "GET",
      headers: forwardHeaders,
      redirect: "follow",
      signal: abort.signal,
    });
  } catch (e) {
    clearTimeout(connectTimer);
    throw new Error("CDN fetch failed: " + (e?.cause?.message || e?.message || String(e)));
  }
  clearTimeout(connectTimer);

  const headers = {};
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const v = upstream.headers.get(name);
    if (v != null) headers[name] = v;
  }
  res.writeHead(upstream.status, headers);

  if (req.method === "HEAD") {
    try { upstream.body?.cancel?.(); } catch (_) {}
    res.end();
    return;
  }

  await new Promise((resolve, reject) => {
    if (!upstream.body) { resolve(); return; }
    const stream = Readable.fromWeb(upstream.body);
    stream.once("error", reject);
    res.once("error", reject);
    res.once("close", () => { abort.abort(); resolve(); });
    stream.pipe(res);
    res.once("finish", resolve);
  });
}

/**
 * `/l` mode: stream a list of progressive segments back-to-back as one
 * continuous body. Range requests are mapped across the concatenation via
 * the segment sizes; when any size is unknown, Range is ignored and the
 * full stream is served (seeking then degrades to a full re-fetch, which
 * still decodes correctly).
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} payload - JSON array of {u, s, b} segments.
 * @returns {Promise<void>}
 */
async function serveSegmentList(req, res, payload) {
  let segs;
  try {
    segs = JSON.parse(payload);
  } catch (_) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("bad target");
    return;
  }
  if (!Array.isArray(segs) || !segs.length || segs.length > MAX_SEGMENTS
      || !segs.every(s => typeof s?.u === "string" && /^https?:\/\//i.test(s.u) && Number.isFinite(s?.s))) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("bad target list");
    return;
  }

  const knownSizes = segs.every(s => s.s > 0);
  const offsets = [];
  let total = 0;
  for (const seg of segs) { offsets.push(total); total += seg.s; }
  if (!knownSizes) total = -1;

  let range = null;
  if (knownSizes && req.headers.range) {
    range = parseByteRange(req.headers.range, total);
    if (range === "invalid") {
      res.writeHead(416, { "Content-Range": "bytes */" + total });
      res.end();
      return;
    }
  }

  const forwardHeaders = await buildBilibiliCdnHeaders();
  // One request-level abort controller: the client vanishing mid-list aborts
  // the in-flight segment fetch; response lifecycle events never touch it.
  const abort = new AbortController();
  req.once("close", () => abort.abort());

  if (req.method === "HEAD") {
    const headers = { "Accept-Ranges": "bytes" };
    if (total >= 0) headers["Content-Length"] = String(total);
    res.writeHead(200, headers);
    res.end();
    return;
  }

  // Open the first segment to learn the content-type before writing headers.
  const start = range ? range.start : 0;
  let firstIdx = 0;
  if (range) {
    while (firstIdx < segs.length - 1 && start >= offsets[firstIdx] + segs[firstIdx].s) firstIdx++;
  }

  let plannedLength = -1;
  if (range) {
    plannedLength = range.end - range.start + 1;
  } else if (total >= 0) {
    plannedLength = total;
  }

  for (let i = firstIdx; i < segs.length; i++) {
    if (range && offsets[i] > range.end) break;

    const seg = segs[i];
    let segRange = null;
    if (range) {
      const localStart = Math.max(0, range.start - offsets[i]);
      const localEnd = Math.min(range.end, offsets[i] + seg.s - 1) - offsets[i];
      if (localEnd < localStart) continue;
      segRange = "bytes=" + localStart + "-" + localEnd;
    }

    const timer = setTimeout(() => abort.abort(), CDN_CONNECT_TIMEOUT_MS);
    let upstream;
    try {
      upstream = await fetchSegment(seg, forwardHeaders, segRange, abort.signal);
    } catch (e) {
      clearTimeout(timer);
      throw new Error("CDN fetch failed: " + (e?.cause?.message || e?.message || String(e)));
    }
    clearTimeout(timer);

    if (!upstream.ok && upstream.status !== 206) {
      try { upstream.body?.cancel?.(); } catch (_) {}
      throw new Error("CDN returned HTTP " + upstream.status + " for segment " + (i + 1));
    }

    if (i === firstIdx) {
      const contentType = upstream.headers.get("content-type");
      const headers = { "Accept-Ranges": "bytes" };
      if (contentType) headers["Content-Type"] = contentType;
      if (range) {
        headers["Content-Range"] = "bytes " + range.start + "-" + range.end + "/" + total;
        if (plannedLength >= 0) headers["Content-Length"] = String(plannedLength);
        res.writeHead(206, headers);
      } else {
        if (plannedLength >= 0) headers["Content-Length"] = String(plannedLength);
        res.writeHead(200, headers);
      }
    }

    // Deliver exactly this segment's share: the requested sub-range when a
    // Range was mapped, else the declared segment size (unknown -> all).
    const cap = range
        ? (Number(segRange.split("-")[1]) - Number(segRange.split("-")[0]) + 1)
        : (seg.s > 0 ? seg.s : -1);
    try {
      await pipeSegmentBody(upstream, res, cap);
    } catch (_) {
      try { res.destroy(); } catch (_) {}
      return;
    }
    if (res.destroyed) return;
  }

  if (!res.headersSent) {
    // No segment was served (empty effective range) — send the empty 206.
    res.writeHead(206, { "Content-Range": "bytes */" + total, "Content-Length": "0" });
  }
  res.end();
}
