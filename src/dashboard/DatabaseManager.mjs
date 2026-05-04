import { compare, genSalt, hash } from "bcryptjs";
import { createPool } from "mysql2/promise";
import mysql2 from "mysql2/promise";
const { FieldPacket, PoolOptions, QueryResult } = mysql2;

export class DatabaseManager {
  /**
   * @param {PoolOptions} config Based on https://sidorares.github.io/node-mysql2/docs#using-connection-pools
   */
  constructor(config) {
    this.db = createPool({
      connectionLimit: 15,
      ...config
    });
  }
  /**
   * @param {string} query
   * @returns {Promise<[QueryResult, FieldPacket[]]>}
   */
  async query(query) {
    return this.db.query(query);
  }
  /**
   * @param {string} query
   * @param {string[]} [data]
   * @returns {Promise<QueryResult>}
   */
  async execute(query, data) {
    const [res, _fields] = await this.db.execute(query, data);
    return res;
  }
  /**
   * @param {string} plain
   * @returns {Promise<string>}
   */
  async hash(plain) {
    const salt = await genSalt(10);
    return hash(plain, salt);
  }
  /**
   * @param {string} plain
   * @param {string} hash
   * @returns {Promise<string>}
   */
  async compareHash(plain, hash) {
    return await compare(plain, hash);
  }
  /**
   * Gracefully closes any database connections
   * @returns {Promise<void>}
   */
  close() {
    return this.db.end();
  }
}
