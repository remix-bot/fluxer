/**
 * @module dashboard/RedisHandler
 * @description Redis pub/sub handler for the dashboard. Maintains a main publisher client
 * and a subscriber client. Receives JSON requests on the "request" channel,
 * dispatches them to a user-supplied handler, and publishes results on "response".
 */

import { createClient } from "redis";
import { logger } from "../constants/Logger.mjs";

/**
 * Default reconnection strategy for Redis sockets.
 * @param {object} options - Reconnection options from the Redis client.
 * @param {number} options.totalRetryTime - Cumulative retry time so far.
 * @param {number} options.attempt - Current retry attempt number.
 * @returns {number|Error} Delay in ms before next retry, or an Error to stop retrying.
 */
const DEFAULT_RETRY_STRATEGY = (options) => {
  if (options.totalRetryTime > 60_000) {
    return new Error("Redis reconnection exhausted after 60s");
  }
  return Math.min(options.attempt * 500, 5_000);
};

/**
 * @class
 * @description Manages dual Redis connections (publisher + subscriber) for real-time
 * dashboard communication via pub/sub.
 */
export class RedisHandler {
  /** @type {string} Platform prefix used for Redis channel names. */
  platform = "fluxer";

  /** @type {import('redis').RedisClientType|null} The main (publisher) Redis client. */
  client = null;
  /** @type {import('redis').RedisClientType|null} The subscriber Redis client. */
  subscriber = null;
  /** @private @type {boolean} Whether the handler has been destroyed. */
  _destroyed = false;

  /**
   * Create a new RedisHandler and immediately begin connecting.
   * @param {object} [opts={}] - Redis connection options (passed to `createClient`).
   * @param {string} [opts.platform] - Platform prefix for channels.
   */
  constructor(opts = {}) {
    this.platform = opts.platform ?? "fluxer";

    const clientOpts = {
      ...opts,
      socket: {
        ...(opts.socket ?? {}),
        reconnectStrategy: DEFAULT_RETRY_STRATEGY,
      },
    };

    this.client = createClient(clientOpts);
    this.client.on("error", (err) => {
      logger.warn("[Redis/Main] Error:", err.message);
    });

    this.subscriber = this.client.duplicate();
    this.subscriber.on("error", (err) => {
      logger.warn("[Redis/Subscriber] Error:", err.message);
    });

    this._connect();
  }

  /**
   * Connect both the publisher and subscriber clients, then subscribe
   * to the "request" and "info" channels and start the ping interval.
   * @private
   * @async
   */
  async _connect() {
    try {
      await this.client.connect();
      logger.redis("[Redis/Main] Connected");
      this.readyMessage();
    } catch (e) {
      logger.error("[Redis/Main] Initial connection failed:", e.message);
    }

    try {
      await this.subscriber.connect();
      logger.redis("[Redis/Subscriber] Connected");

      this.subscriber.subscribe("request", async (m) => {
        if (this._destroyed) return;
        try {
          const payload = JSON.parse(m);
          if (payload.platform !== this.platform) return;
          if (typeof this.handleRequest !== "function") return;
          const result = await this.handleRequest(payload.content);
          this.send("response", JSON.stringify({
            id: payload.id,
            content: result,
          }));
        } catch (e) {
          logger.error("[Redis/Subscriber] Request handler error:", e.message);
        }
      });

      this.subscriber.subscribe("info", (m) => {
        if (this._destroyed) return;
        try {
          const data = JSON.parse(m);
          if (data.platform !== "backend") return;
          if (data.type !== "requestConnected") return;
          this.readyMessage();
        } catch (e) {
          logger.warn("[Redis/Subscriber] Info handler error:", e.message);
        }
      });
      this._pingInterval = setInterval(() => {
        this.send(this.platform + ":ping", "" + Date.now());
      }, 10000);
    } catch (e) {
      logger.error("[Redis/Subscriber] Initial connection failed:", e.message);
    }
  }

  /**
   * Send a "connected" info message to the dashboard after a 5-second debounce.
   * @returns {void}
   */
  readyMessage() {
    if (this._destroyed) return;
    if (this._readyTimer) clearTimeout(this._readyTimer);
    this._readyTimer = setTimeout(() => {
      this._readyTimer = null;
      if (this._destroyed) return;
      this.send("info", JSON.stringify({
        platform: this.platform,
        type: "connected",
      }));
    }, 5000);
  }

  /**
   * Publish a message to a Redis channel.
   * No-op if the handler is destroyed or the client is not ready.
   * @param {string} channel - The Redis channel to publish to.
   * @param {string} message - The message string to send.
   * @returns {Promise<number>} Number of subscribers that received the message.
   */
  send(channel, message) {
    if (this._destroyed || !this.client?.isReady) return Promise.resolve(0);
    return this.client.publish(channel, message).catch((e) => {
      logger.warn("[Redis/Main] Publish error:", e.message);
      return 0;
    });
  }

  /** @type {Function|null} The current request handler function. */
  handleRequest;

  /**
   * Set the handler function invoked for incoming "request" payloads.
   * @param {Function} handler - Async function `(data) => result`.
   */
  setRequestHandler(handler) {
    this.handleRequest = handler;
  }

  /**
   * Gracefully close both Redis connections and stop all internal timers.
   * @async
   * @returns {Promise<void>}
   */
  async destroy() {
    this._destroyed = true;
    if (this._pingInterval) { clearInterval(this._pingInterval); this._pingInterval = null; }
    if (this._readyTimer) { clearTimeout(this._readyTimer); this._readyTimer = null; }
    try { await this.subscriber?.quit(); } catch(e) { logger.warn("[Redis/Subscriber] Quit error:", e?.message); }
    try { await this.client?.quit(); } catch(e) { logger.warn("[Redis/Main] Quit error:", e?.message); }
    logger.redis("[Redis] Connections closed gracefully");
  }
}
