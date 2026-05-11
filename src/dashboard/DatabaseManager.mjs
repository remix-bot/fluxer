import { compare, genSalt, hash } from "bcryptjs";
import { createPool } from "mysql2/promise";

/**
 * DatabaseManager — MySQL pool for dashboard login codes and API tokens.
 * Adapted for use with the Fluxer bot.
 */
export class DatabaseManager {
  /**
   * @param {import("mysql2/promise").PoolOptions} config
   */
  constructor(config) {
    this.db = createPool({
      connectionLimit: 15,
      ...config,
    });
  }

  /**
   * Execute a raw SQL query.
   * @param {string} query
   * @returns {Promise<[import("mysql2/promise").QueryResult, import("mysql2/promise").FieldPacket[]]>}
   */
  async query(query) {
    return this.db.query(query);
  }

  /**
   * Execute a parameterized SQL query.
   * @param {string} query
   * @param {any[]} [data]
   * @returns {Promise<import("mysql2/promise").QueryResult>}
   */
  async execute(query, data) {
    const [res, _fields] = await this.db.execute(query, data);
    return res;
  }

  /**
   * Hash a plaintext string using bcrypt.
   * @param {string} plain
   * @returns {Promise<string>}
   */
  async hash(plain) {
    const salt = await genSalt(10);
    return hash(plain, salt);
  }

  /**
   * Compare a plaintext string against a bcrypt hash.
   * @param {string} plain
   * @param {string} hashed
   * @returns {Promise<boolean>}
   */
  async compareHash(plain, hashed) {
    return await compare(plain, hashed);
  }

  /**
   * Gracefully close the connection pool.
   * @returns {Promise<void>}
   */
  close() {
    return this.db.end();
  }
}
