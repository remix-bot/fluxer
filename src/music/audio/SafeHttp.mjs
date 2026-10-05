/**
 * @module src/music/audio/SafeHttp
 * @description Public-internet-only HTTP streaming for URLs that users type into `%play`.
 *
 * Direct audio links are fetched by the bot process itself, which sits next to MySQL, Redis
 * and NodeLink. Without a guard, `%play http://169.254.169.254/x.ogg` (or a public URL that
 * redirects there) makes the bot issue requests into the internal network. This module:
 *   - allows only http/https,
 *   - refuses loopback / private / link-local / CGNAT / multicast / reserved addresses,
 *   - validates EVERY redirect hop (redirects are followed manually),
 *   - validates at connect time through a custom DNS `lookup`, so a hostname that resolves to
 *     a private address (or flips between lookups: DNS rebinding) is still refused,
 *   - uses a fresh agent per request so a pooled socket can never bypass the check,
 *   - applies connect-to-headers and idle timeouts, so a silent server cannot hang playback.
 */

import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** Thrown when a URL (or one of its redirects / DNS answers) points at a blocked address. */
export class BlockedAddressError extends Error {
  constructor(message) {
    super(message);
    this.name = "BlockedAddressError";
    this.code = "EBLOCKEDADDR";
  }
}

function isPrivateV4(ip) {
  const [a, b, c] = ip.split(".").map(Number);
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

/** Expand an IPv6 literal (incl. "::" compression and a dotted-IPv4 tail) to 8 numeric hextets. */
function expandV6(ip) {
  let s = ip.toLowerCase();
  const tail = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (tail) {
    const p = tail[1].split(".").map(Number);
    s = s.slice(0, -tail[1].length) + ((p[0] << 8) | p[1]).toString(16) + ":" + ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = s.split("::");
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length > 1 && halves[1] ? halves[1].split(":") : [];
  const parts = halves.length > 1
    ? [...head, ...Array(Math.max(0, 8 - head.length - rest.length)).fill("0"), ...rest]
    : head;
  return parts.map((h) => parseInt(h || "0", 16));
}

const v4From = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/**
 * @param {string} input - An IP literal (IPv4/IPv6, optionally bracketed or with a %zone).
 * @returns {boolean} true when the address must NOT be reachable from a user-supplied URL.
 *   Anything that is not a valid IP literal is also reported as unsafe.
 */
export function isPrivateAddress(input) {
  let ip = String(input ?? "").trim();
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);
  const family = net.isIP(ip);
  if (family === 0) return true;
  if (family === 4) return isPrivateV4(ip);

  const h = expandV6(ip);
  if (h.length !== 8 || h.some((x) => Number.isNaN(x))) return true;
  const zeros = (from, to) => h.slice(from, to).every((x) => x === 0);

  if (zeros(0, 8)) return true;
  if (zeros(0, 7) && h[7] === 1) return true;
  if (zeros(0, 5) && h[5] === 0xffff) return isPrivateV4(v4From(h[6], h[7]));
  if (zeros(0, 6)) return isPrivateV4(v4From(h[6], h[7]));
  if (h[0] === 0x64 && h[1] === 0xff9b && zeros(2, 6)) return isPrivateV4(v4From(h[6], h[7]));
  if (h[0] === 0x2002) return isPrivateV4(v4From(h[1], h[2]));
  if ((h[0] & 0xfe00) === 0xfc00) return true;
  if ((h[0] & 0xffc0) === 0xfe80) return true;
  if ((h[0] & 0xffc0) === 0xfec0) return true;
  if ((h[0] & 0xff00) === 0xff00) return true;
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true;
  return false;
}

/**
 * Build a `lookup` function for http(s).request that refuses disallowed addresses.
 * Checking the address Node is about to connect to (rather than pre-resolving) is what
 * defeats DNS-rebinding.
 * @param {(address: string) => boolean} isAllowed
 */
export function createSafeLookup(isAllowed) {
  return function safeLookup(hostname, options, callback) {
    if (typeof options === "function") { callback = options; options = {}; }
    options = options || {};
    dns.lookup(hostname, options, (err, address, family) => {
      if (err) return callback(err);
      const list = Array.isArray(address) ? address : [{ address, family }];
      const bad = list.find((a) => !isAllowed(a.address));
      if (bad) {
        return callback(new BlockedAddressError(
          `Refusing to connect to ${bad.address} (resolved from ${hostname}): private/internal addresses are not allowed`));
      }
      if (options.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

function requestOnce(u, { headers, lookup, connectTimeoutMs, idleTimeoutMs }) {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === "https:" ? https : http;
    let settled = false;
    let timer = null;
    const req = mod.request(u, {
      method: "GET",
      agent: false,
      lookup,
      headers: { Accept: "*/*", "Accept-Encoding": "identity", ...headers },
    }, (res) => {
      settled = true;
      clearTimeout(timer);
      res.setTimeout(idleTimeoutMs, () => res.destroy(new Error("Stream idle for " + idleTimeoutMs + "ms")));
      resolve({ res, req });
    });
    timer = setTimeout(() => {
      if (!settled) req.destroy(new Error("Timed out waiting for response headers (" + connectTimeoutMs + "ms)"));
    }, connectTimeoutMs);
    req.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(err); }
    });
    req.end();
  });
}

/**
 * Open a streaming GET to a user-supplied URL, public internet only.
 * @param {string} url
 * @param {object} [opts]
 * @param {object} [opts.headers] - Extra request headers.
 * @param {boolean} [opts.allowPrivate=false] - Skip the address checks (trusted sources only).
 * @param {(address: string) => boolean} [opts.addressFilter] - Custom allow-rule (overrides allowPrivate).
 * @param {number} [opts.maxRedirects=5]
 * @param {number} [opts.connectTimeoutMs=15000] - Max wait for response headers.
 * @param {number} [opts.idleTimeoutMs=30000] - A response that goes silent this long is destroyed.
 * @returns {Promise<{stream: import("node:http").IncomingMessage, req: import("node:http").ClientRequest, finalUrl: string}>}
 * @throws {BlockedAddressError} when a hop targets a blocked address.
 */
export async function openPublicStream(url, {
  headers = {},
  allowPrivate = false,
  addressFilter = null,
  maxRedirects = 5,
  connectTimeoutMs = 15_000,
  idleTimeoutMs = 30_000,
} = {}) {
  const isAllowed = typeof addressFilter === "function"
    ? addressFilter
    : allowPrivate ? () => true : (a) => !isPrivateAddress(a);
  const lookup = createSafeLookup(isAllowed);

  let current = String(url);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const u = new URL(current);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new Error("Blocked URL scheme: " + u.protocol);
    }
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host) && !isAllowed(host)) {
      throw new BlockedAddressError(`Refusing to connect to ${host}: private/internal addresses are not allowed`);
    }
    const { res, req } = await requestOnce(u, { headers, lookup, connectTimeoutMs, idleTimeoutMs });
    if (REDIRECT_STATUS.has(res.statusCode) && res.headers.location) {
      res.resume();
      current = new URL(res.headers.location, u).toString();
      continue;
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      res.resume();
      throw new Error("HTTP " + res.statusCode + " for " + url);
    }
    return { stream: res, req, finalUrl: u.toString() };
  }
  throw new Error("Too many redirects (" + maxRedirects + ")");
}

export default { openPublicStream, isPrivateAddress, createSafeLookup, BlockedAddressError };
