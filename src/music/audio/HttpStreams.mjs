/**
 * @module src/music/audio/HttpStreams
 * @description HTTP helper concern for {@link FluxerAudioBridge}: GET-JSON
 * with redirect following and streaming GET with connect/idle timeouts,
 * used for the Lavalink/NodeLink REST endpoints (trackstream, loadstream,
 * loadtracks).
 *
 * These methods are applied onto the FluxerAudioBridge class prototype via
 * {@link module:src/utils/mixins.applyMixins} — `this` is a
 * FluxerAudioBridge instance.
 */

import { logger } from "../../core/Logger.mjs";
import http from "node:http";
import https from "node:https";

/** @type {number} @description Maximum number of HTTP redirect hops to follow. */
const MAX_REDIRECTS = 5;

/** @type {number} @description Timeout (ms) for HTTP requests to Lavalink REST endpoints (trackstream, loadtracks JSON). */
const REST_REQUEST_TIMEOUT_MS = 15_000;

/** @type {number} @description Timeout (ms) to wait for the first byte from loadstream (Lavalink may need time to resolve HLS/external streams). */
const LOADSTREAM_CONNECT_TIMEOUT_MS = 60_000;

/** @type {number} @description Idle timeout (ms) once loadstream data is flowing — if no data arrives for this long, abort. */
const LOADSTREAM_IDLE_TIMEOUT_MS = 30_000;

/**
 * @type {object}
 * @description HTTP streams mixin — applied to FluxerAudioBridge.
 */
const HttpStreams = {
  /**
   * @param {string} url
   * @param {object} [headers]
   * @returns {Promise<object>}
   * @private
   */
  _httpGetJson(url, headers = {}, _redirectCount = 0, timeoutMs = REST_REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (_redirectCount >= MAX_REDIRECTS) {
        return reject(new Error("Too many redirects (" + _redirectCount + ")"));
      }
      const urlObj = new URL(url);
      const client = urlObj.protocol === "https:" ? https : http;

      const req = client.request({
        protocol: urlObj.protocol,
        host: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname + urlObj.search,
        method: "GET",
        headers: { "User-Agent": "Mozilla/5.0 (compatible; Bot/1.0)", ...headers },
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          let loc = res.headers.location;
          if (loc.startsWith("/")) loc = urlObj.protocol + "//" + urlObj.host + loc;
          return this._httpGetJson(loc, headers, _redirectCount + 1, timeoutMs).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          let body = "";
          res.on("data", (chunk) => { body += chunk; });
          res.on("end", () => {
            reject(new Error("HTTP " + res.statusCode + " for " + url + ": " + body.substring(0, 300)));
          });
          return;
        }

        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error("Invalid JSON from trackstream: " + data.substring(0, 200)));
          }
        });
      });

      req.on("socket", (socket) => {
        socket.on("error", () => {});
      });
      req.on("error", reject);
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        reject(new Error("REST request timeout (" + timeoutMs / 1000 + "s)"));
      });
      req.end();
    });
  },

  /**
   * @param {string} url
   * @param {object} [headers]
   * @param {number} [_redirectCount=0]
   * @returns {Promise<{stream: Readable, inputFormat: string|null, req: http.ClientRequest}>}
   * @private
   */
  _httpRequestStream(url, headers = {}, _redirectCount = 0) {
    return new Promise((resolve, reject) => {
      if (_redirectCount >= MAX_REDIRECTS) {
        return reject(new Error("Too many redirects (" + _redirectCount + ")"));
      }

      const urlObj = new URL(url);
      const client = urlObj.protocol === "https:" ? https : http;
      let firstByte = true;
      let connectTimer = null;
      let idleTimer = null;

      const resetIdleTimeout = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          req.destroy();
          reject(new Error("loadstream idle timeout (" + LOADSTREAM_IDLE_TIMEOUT_MS / 1000 + "s no data)"));
        }, LOADSTREAM_IDLE_TIMEOUT_MS);
        idleTimer.unref?.();
      };

      const req = client.request({
        protocol: urlObj.protocol,
        host: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname + urlObj.search,
        method: "GET",
        headers: { "User-Agent": "Mozilla/5.0 (compatible; Bot/1.0)", ...headers },
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
          res.resume();
          let nextHeaders = headers;
          let loc = res.headers.location;
          if (loc.startsWith("/")) loc = urlObj.protocol + "//" + urlObj.host + loc;
          try {
            const redirectHost = new URL(loc).hostname;
            if (redirectHost !== urlObj.hostname) {
              const { Authorization, "Session-Id": _, ...safe } = headers;
              nextHeaders = safe;
            }
          } catch (_) {}
          return this._httpRequestStream(loc, nextHeaders, _redirectCount + 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
          let body = "";
          res.on("data", (chunk) => { body += chunk; });
          res.on("end", () => {
            reject(new Error("HTTP " + res.statusCode + " for " + url + ": " + body.substring(0, 300)));
          });
          return;
        }

        if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
        resetIdleTimeout();
        res.once("data", () => resetIdleTimeout());

        logger.player("[AudioBridge] loadstream response: " + res.statusCode + " content-type=" + (res.headers["content-type"] || "?"));
        resolve({ stream: res, inputFormat: res.headers["content-type"] || null, req });
      });

      req.on("socket", (socket) => {
        socket.on("error", () => {});
      });

      req.on("error", (err) => {
        if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        reject(err);
      });

      connectTimer = setTimeout(() => {
        req.destroy();
        reject(new Error("loadstream connect timeout (" + LOADSTREAM_CONNECT_TIMEOUT_MS / 1000 + "s — Lavalink took too long to start stream)"));
      }, LOADSTREAM_CONNECT_TIMEOUT_MS);
      connectTimer.unref?.();

      req.end();
    });
  },
};

export default HttpStreams;
export { HttpStreams };
