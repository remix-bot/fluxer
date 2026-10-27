/**
 * @module src/db/DatabaseManager
 * @description MySQL connection pool wrapper for the dashboard. Provides parameterised
 * query execution and bcrypt hashing utilities for login code management.
 */

import { compare, genSalt, hash } from "bcryptjs";
import { attachMysqlPoolGuard } from "./MysqlGuard.mjs";
import { getSharedPromisePool } from "./PoolManager.mjs";

/**
 * @class
 * @description Wraps a mysql2 connection pool with convenience methods for
 * parameterised queries and bcrypt hash operations.
 */
export class DatabaseManager {
  /**
   * Create a new DatabaseManager.
   * @param {object} config - mysql2 pool configuration or shared PromisePool instance.
   */
  constructor(config) {
    if (config && typeof config.execute === "function") {
      this.db = config;
      this._ownsPool = false;
    } else if (config && typeof config.promise === "function") {
      this.db = config.promise();
      this._ownsPool = false;
    } else {
      this.db = getSharedPromisePool(config);
      this._ownsPool = false;
    }
    attachMysqlPoolGuard(this.db, "DashboardDB");
  }

  /**
   * Execute a raw SQL query (no parameter binding).
   * @async
   * @param {string} query - The SQL query string.
   * @returns {Promise<Array>} The query result rows and fields.
   */
  async query(query) {
    return this.db.query(query);
  }

  /**
   * Execute a parameterised SQL query.
   * @async
   * @param {string} query - The SQL query with `?` placeholders.
   * @param {Array} data - The values to bind.
   * @returns {Promise<Array>} The result rows.
   */
  async execute(query, data) {
    const [res, _fields] = await this.db.execute(query, data);
    return res;
  }

  /**
   * Generate a bcrypt hash of the given plaintext.
   * @async
   * @param {string} plain - The plaintext string.
   * @returns {Promise<string>} The hashed string.
   */
  async hash(plain) {
    const salt = await genSalt(10);
    return hash(plain, salt);
  }

  /**
   * Compare a plaintext string against a bcrypt hash.
   * @async
   * @param {string} plain - The plaintext string.
   * @param {string} hashed - The bcrypt hash.
   * @returns {Promise<boolean>} True if the plaintext matches the hash.
   */
  async compareHash(plain, hashed) {
    return await compare(plain, hashed);
  }

  /**
   * Close the underlying MySQL connection pool (no-op if using a shared pool).
   * @returns {Promise<void>}
   */
  close() {
    if (this._ownsPool && this.db?.end) {
      return this.db.end();
    }
    return Promise.resolve();
  }
}
