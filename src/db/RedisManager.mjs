/**
 * @module src/db/RedisManager
 * @description Centralized Redis service for caching, atomic counters,
 * track search optimization, and 24/7 session restoration.
 */

import { createClient } from "redis";
import { logger } from "../core/Logger.mjs";

/**
 * Default linear-ramp reconnection strategy.
 * @param {number} retries - Number of reconnection attempts made so far.
 * @returns {number} Delay in milliseconds before next attempt.
 */
const DEFAULT_RETRY_STRATEGY = (retries) => {
  if (!Number.isFinite(retries)) return 15_000;
  return retries < 10 ? Math.min(retries * 500, 5_000) : 15_000;
};

/**
 * @class RedisManager
 * @description Oversees Redis connection lifecycle, search caching, and player session checkpoints.
 */
export class RedisManager {
  /**
   * @param {object} remix - The main Bot instance.
   * @param {object} [config] - Redis configuration object.
   */
  constructor(remix, config = {}) {
    this.remix = remix;
    this.config = config || {};
    this.enabled = this.config.enabled === true;
    this.platform = "fluxer";

    this.client = null;
    this._isReady = false;
    this._destroyed = false;
    this.searchTtlSeconds = Number(this.config.searchTtlSeconds ?? 86400);
  }

  /**
   * Connect to the Redis server if enabled.
   * @returns {Promise<boolean>}
   */
  async connect() {
    if (!this.enabled || !this.config.url) {
      logger.redis("[Redis] Disabled or missing URL in configuration.");
      return false;
    }

    try {
      const clientOpts = {
        url: this.config.url,
        socket: {
          connectTimeout: 5_000,
          reconnectStrategy: DEFAULT_RETRY_STRATEGY,
        },
      };

      if (this.config.password) {
        clientOpts.password = this.config.password;
      }

      this.client = createClient(clientOpts);

      this.client.on("error", (err) => {
        logger.warn("[Redis] Client error:", err.message);
      });

      this.client.on("ready", () => {
        this._isReady = true;
        logger.redis("[Redis] Connected and operational.");
      });

      this.client.on("reconnecting", () => {
        this._isReady = false;
        logger.redis("[Redis] Reconnecting to server...");
      });

      this.client.on("end", () => {
        this._isReady = false;
      });

      await this.client.connect();
      return true;
    } catch (err) {
      logger.warn("[Redis] Initial connection attempt failed:", err.message);
      this._isReady = false;
      return false;
    }
  }

  /**
   * Check if the Redis client is connected and ready for commands.
   * @returns {boolean}
   */
  isReady() {
    return this._isReady && Boolean(this.client?.isOpen);
  }

  /**
   * Get a cached track search result.
   * @param {string} query - The search query or URL.
   * @param {string} [source=""] - The Lavalink source prefix (e.g. ytmsearch).
   * @returns {Promise<object|null>}
   */
  async getCachedSearch(query, source = "") {
    if (!this.isReady() || !query) return null;
    try {
      const key = this.getSearchCacheKey(query, source);
      const data = await this.client.get(key);
      if (!data) return null;
      return JSON.parse(data);
    } catch (err) {
      logger.warn("[Redis] Error reading search cache:", err?.message);
      return null;
    }
  }

  /**
   * Cache a track search result in Redis.
   * @param {string} query - The search query or URL.
   * @param {string} source - The Lavalink source prefix.
   * @param {object} result - The search result object.
   * @param {number} [ttlSeconds] - Custom TTL in seconds.
   * @returns {Promise<void>}
   */
  async cacheSearch(query, source, result, ttlSeconds = this.searchTtlSeconds) {
    if (!this.isReady() || !query || !result) return;
    try {
      const key = this.getSearchCacheKey(query, source);
      await this.client.set(key, JSON.stringify(result), {
        EX: ttlSeconds,
      });
    } catch (err) {
      logger.warn("[Redis] Error storing search cache:", err?.message);
    }
  }

  /**
   * Build a standardized cache key for audio searches.
   * @param {string} query - The search query or URL.
   * @param {string} [source=""] - The source prefix.
   * @returns {string}
   */
  getSearchCacheKey(query, source = "") {
    const cleanQuery = String(query).trim().toLowerCase().replace(/\s+/g, " ");
    const cleanSource = String(source).trim().toLowerCase();
    return `${this.platform}:cache:search:${cleanSource}:${cleanQuery}`;
  }

  /**
   * Save a player session snapshot for 24/7 recovery across bot restarts.
   * @param {string} guildId - The guild snowflake ID.
   * @param {object} sessionData - Session payload (queue, currentTrack, volume, mode).
   * @param {number} [ttlSeconds=604800] - 7 days default retention.
   * @returns {Promise<void>}
   */
  async savePlayerSession(guildId, sessionData, ttlSeconds = 604800) {
    if (!this.isReady() || !guildId || !sessionData) return;
    try {
      const key = `${this.platform}:player:session:${guildId}`;
      await this.client.set(key, JSON.stringify(sessionData), {
        EX: ttlSeconds,
      });
    } catch (err) {
      logger.warn(`[Redis] Failed to save player session for guild ${guildId}:`, err?.message);
    }
  }

  /**
   * Retrieve a saved player session snapshot.
   * @param {string} guildId - The guild snowflake ID.
   * @returns {Promise<object|null>}
   */
  async getPlayerSession(guildId) {
    if (!this.isReady() || !guildId) return null;
    try {
      const key = `${this.platform}:player:session:${guildId}`;
      const data = await this.client.get(key);
      if (!data) return null;
      return JSON.parse(data);
    } catch (err) {
      logger.warn(`[Redis] Failed to load player session for guild ${guildId}:`, err?.message);
      return null;
    }
  }

  /**
   * Delete a saved player session snapshot.
   * @param {string} guildId - The guild snowflake ID.
   * @returns {Promise<void>}
   */
  async deletePlayerSession(guildId) {
    if (!this.isReady() || !guildId) return;
    try {
      const key = `${this.platform}:player:session:${guildId}`;
      await this.client.del(key);
    } catch (err) {
      logger.warn(`[Redis] Failed to delete player session for guild ${guildId}:`, err?.message);
    }
  }

  /**
   * Gracefully close Redis connection.
   * @returns {Promise<void>}
   */
  async destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._isReady = false;
    try {
      if (this.client?.isOpen) {
        await this.client.quit();
      }
    } catch (e) {
      logger.warn("[Redis] Quit error:", e?.message);
    }
    logger.redis("[Redis] Connection closed gracefully.");
  }
}

export default RedisManager;
