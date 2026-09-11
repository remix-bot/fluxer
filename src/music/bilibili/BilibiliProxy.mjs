/**
 * @module src/music/bilibili/BilibiliProxy
 * @description A tiny localhost HTTP proxy that lets the NodeLink/Lavalink
 * node fetch Bilibili CDN audio. Bilibili's DASH audio URLs (m4s) only
 * respond to requests carrying a bilibili Referer and a browser User-Agent —
 * headers an audio node cannot attach — so the bot signs the CDN URL with a
 * per-process HMAC key and hands the node
 * `http://<host>:<port>/s?u=<cdn-url>&e=<expiry>&x=<hmac>` instead. The
 * proxy validates the signature, then streams the CDN response (including
 * Range requests, which give seek support) with the right headers attached.
 *
 * The server starts lazily on the first Bilibili play and is unref'd, so it
 * never delays startup or shutdown. Only URLs signed by this very process
 * can pass through — the HMAC key is random per boot.
 */

import http from "node:http";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { logger } from "../../core/Logger.mjs";
import { buildBilibiliCdnHeaders } from "./BilibiliResolver.mjs";

/** @type {number} @description How long a signed proxy URL stays valid (Bilibili CDN URLs themselves expire). */
const PROXY_TTL_MS = 6 * 60 * 60 * 1000;
/** @type {number} @description Timeout (ms) waiting for the CDN response headers. */
const CDN_CONNECT_TIMEOUT_MS = 20_000;

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
 * HMAC-SHA256 signature binding a CDN URL to its expiry epoch.
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
 * Sign a Bilibili CDN URL into a proxy URL the audio node can fetch. Starts
 * the proxy on first use. The HMAC is computed over the base64url-encoded
 * target exactly as it travels in the `u` query parameter, so verification
 * on the serving side never has to guess the encoding.
 * @param {string} targetUrl - The raw CDN (m4s) URL from the playurl API.
 * @param {number} [ttlMs=PROXY_TTL_MS] - Signature lifetime.
 * @returns {Promise<string>} The signed proxy URL.
 */
export async function buildSignedProxyUrl(targetUrl, ttlMs = PROXY_TTL_MS) {
  const { port, host } = await ensureBilibiliProxy();
  const expires = Date.now() + ttlMs;
  const u = Buffer.from(String(targetUrl), "utf8").toString("base64url");
  const x = signTarget(u, expires);
  return "http://" + host + ":" + port + "/s?u=" + u + "&e=" + expires + "&x=" + x;
}

/**
 * Serve one proxy request: verify the signature, fetch the CDN URL with the
 * Referer/UA headers Bilibili requires, and pipe the response through
 * (status, content-type/length/range and Range semantics included).
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
  if (u.pathname !== "/s") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }

  const uParam = u.searchParams.get("u");
  const expires = Number(u.searchParams.get("e"));
  const sig = u.searchParams.get("x");
  if (!uParam || !Number.isFinite(expires) || !sig || Date.now() >= expires || !verifySignature(uParam, expires, sig)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("forbidden");
    return;
  }

  let targetUrl;
  try { targetUrl = new URL(Buffer.from(uParam, "base64url").toString("utf8")); } catch (_) {
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

  if (!upstream.body) {
    res.end();
    return;
  }

  await new Promise((resolve, reject) => {
    const stream = Readable.fromWeb(upstream.body);
    stream.once("error", reject);
    res.once("error", reject);
    res.once("close", () => { abort.abort(); resolve(); });
    stream.pipe(res);
    res.once("finish", resolve);
  });
}
