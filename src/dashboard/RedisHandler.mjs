import { createClient } from "redis";
import { logger } from "../constants/Logger.mjs";

/**
 * Default retry strategy: exponential backoff starting at 500ms, max 5s, max 20 retries.
 * @param {Object} options
 * @returns {number} Delay in ms before next retry, or an Error to stop retrying
 */
const DEFAULT_RETRY_STRATEGY = (options) => {
  if (options.totalRetryTime > 60_000) {
    // Stop retrying after 60s total — something is fundamentally wrong
    return new Error("Redis reconnection exhausted after 60s");
  }
  return Math.min(options.attempt * 500, 5_000);
};

export class RedisHandler {
  platform = "fluxer";

  /** @type {import("redis").RedisClientType|null} */
  client = null;
  /** @type {import("redis").RedisClientType|null} */
  subscriber = null;
  /** Whether the handler has been explicitly destroyed */
  _destroyed = false;

  /**
   * @param {Object} opts
   * @param {import("redis").RedisClientOptions} opts Redis client options
   * @param {string} [opts.platform] Platform identifier for channel namespacing
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
   * Connect both publisher and subscriber with reconnection support.
   * Wrapped in a method so it can be called once from the constructor.
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
    } catch (e) {
      logger.error("[Redis/Subscriber] Initial connection failed:", e.message);
    }
  }

  readyMessage() {
    if (this._destroyed) return;
    this.send("info", JSON.stringify({
      platform: this.platform,
      type: "connected",
    }));
  }

  /**
   * Publish a message to a Redis channel.
   * @param {string} channel
   * @param {string} message
   * @returns {Promise<number>} Number of subscribers that received the message
   */
  send(channel, message) {
    if (this._destroyed || !this.client?.isReady) return Promise.resolve(0);
    return this.client.publish(channel, message).catch((e) => {
      logger.warn("[Redis/Main] Publish error:", e.message);
      return 0;
    });
  }

  /**
   * @callback RequestCallback
   * @param {Object} data
   * @param {string} data.type
   * @returns {Promise<Object>}
   */
  handleRequest;

  /**
   * @param {RequestCallback} handler
   */
  setRequestHandler(handler) {
    this.handleRequest = handler;
  }

  /**
   * Gracefully close both Redis connections.
   * Should be called on process shutdown to avoid abrupt connection drops.
   * @returns {Promise<void>}
   */
  async destroy() {
    this._destroyed = true;
    try { await this.subscriber?.quit(); } catch (_) {}
    try { await this.client?.quit(); } catch (_) {}
    logger.redis("[Redis] Connections closed gracefully");
  }
}
