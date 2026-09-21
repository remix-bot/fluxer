/**
 * @module src/db/DatabaseManager
 * @description MySQL connection pool wrapper for the dashboard. Provides parameterised
 * query execution and bcrypt hashing utilities for login code management.
 */

import { compare, genSalt, hash } from "bcryptjs";
import { createPool } from "mysql2/promise";
import { logger } from "../core/Logger.mjs";
import { MYSQL_POOL_DEFAULTS, attachMysqlPoolGuard } from "./MysqlGuard.mjs";

/**
 * @class
 * @description Wraps a mysql2 connection pool with convenience methods for
 * parameterised queries and bcrypt hash operations.
 */
export class DatabaseManager {
  /**
   * Create a new DatabaseManager.
   * @param {object} config - mysql2 pool configuration (host, user, password, database, etc.).
   */
  constructor(config) {
    this.db = createPool({
      ...MYSQL_POOL_DEFAULTS,
      connectionLimit: 15,
      ...config,
    });
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
   * Close the underlying MySQL connection pool.
   * @returns {Promise<void>}
   */
  close() {
    return this.db.end();
  }
}
