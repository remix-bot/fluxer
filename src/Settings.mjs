import fs from "node:fs";
import { logger } from "./constants/Logger.mjs";
import mysql from "mysql2";
import { EventEmitter } from "node:events";

// Re-export the abstract SettingsManager base class so JSDoc type hints and
// the migrate script can import it from a single canonical path.
export { SettingsManager } from "../settings/Settings.mjs";

export class ServerSettings {
  id;
  manager;
  data = {};

  constructor(id, mgr) {
    this.id = id;
    this.manager = mgr;
    this.loadDefaults();
  }
  set(key, value) { this.data[key] = value; this.manager.update(this, key); }
  get(key) { return this.data[key]; }
  reset(key) { return this.set(key, this.manager.defaults[key]); }
  getAll() { return this.data; }
  loadDefaults() { for (let key in this.manager.defaults) { this.data[key] = this.manager.defaults[key]; } }
  deserialize(json) { for (let k in json) { if (k === "id") continue; this.data[k] = json[k]; } }

  // was `if (!this.data[key])` which clobbered valid falsy values like 0, false, ""
  checkDefaults(d) { for (let key in d) { if (this.data[key] === undefined) this.data[key] = d[key]; } }

  get serializationData() { return { ...this.data, id: this.id }; }
  serialize() { return this.serializationData; }
  serializeObject() { return this.serializationData; }
}

export class RemoteSettingsManager extends EventEmitter {
  guilds = new Map();
  descriptions = {};
  defaults = {};
  db = null;
  /** @type {string|null} Bot user ID — used to isolate rows per-bot in shared databases */
  botId = null;
  /** @type {boolean} Whether the bot_id column exists in the settings table */
  _hasBotIdColumn = false;

  // track retry count and apply exponential backoff on load failures
  _loadAttempts = 0;
  /** @type {Promise|null} Tracks the in-flight load() so setBotId() can wait for it */
  _loadPromise = null;
  // Per-server debounce timers: serverId → NodeJS.Timeout
  // Batches rapid set() calls (e.g. 24/7 mode changes that write stay_247 + stay_247_mode)
  // into a single remoteSave() 80ms after the last write, rather than firing one UPDATE
  // per key.
  _debounceTimers = new Map();

  constructor(config, defaultsPath, botId = null) {
    super();
    this.botId = botId;
    this.db = mysql.createPool({ connectionLimit: 15, ...config });
    // Without this listener, any pool-level error (connection drop, timeout, protocol error)
    // fires an unhandled 'error' event which crashes the entire process with no log output.
    this.db.on("error", (err) => {
      logger.error("[DB] MySQL pool error:", err.code ?? err.message);
    });
    if (defaultsPath) this.loadDefaultsSync(defaultsPath);
    this._loadPromise = this.load().catch(err => logger.error("[Settings] Initial load failed:", err?.message ?? err));
  }

  /**
   * Check whether the `bot_id` column exists in the settings table AND is
   * part of the primary key.  If the column is missing, auto-migrate by
   * adding it (NOT NULL DEFAULT '') and updating the primary key to (id, bot_id).
   * If the column exists but isn't in the PK (previous failed migration),
   * fix the NULL values and retry the PK update.
   *
   * Key detail: MySQL primary key columns CANNOT be NULL.  The previous version
   * used DEFAULT NULL which caused ALTER TABLE ... ADD PRIMARY KEY to fail
   * silently, leaving the PK as just (id) and producing ER_DUP_ENTRY errors
   * when two bots tried to INSERT rows for the same guild.
   */
  async _ensureBotIdColumn() {
    if (this._hasBotIdColumn) return; // already verified column + PK

    // Check if bot_id column exists and its properties
    const res = await this.query(
      `SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_KEY FROM information_schema.COLUMNS `
      + `WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'settings' AND COLUMN_NAME = 'bot_id'`
    );

    if (res.error) {
      logger.error("[Settings] Failed to check bot_id column:", res.error);
      return;
    }

    if (res.results.length === 0) {
      // ── Column doesn't exist: add it and update PK ─────────────────────
      logger.settings("[Settings] Auto-migrating: adding bot_id column to settings table...");

      // NOT NULL DEFAULT '' — primary key columns can't be NULL in MySQL.
      // Existing rows get bot_id = '' which we'll claim for the current bot.
      const alterRes = await this.query(
        `ALTER TABLE settings ADD COLUMN bot_id VARCHAR(32) NOT NULL DEFAULT ''`
      );
      if (alterRes.error) {
        logger.error("[Settings] Failed to add bot_id column:", alterRes.error);
        return;
      }

      // Claim all existing rows for the current bot before updating PK.
      // This preserves existing settings (prefix, volume, etc.) instead of
      // leaving them orphaned with bot_id = ''.
      if (this.botId) {
        await this.query(
          `UPDATE settings SET bot_id = ${mysql.escape(String(this.botId))} WHERE bot_id = ''`
        );
      }

      // Update primary key from (id) to (id, bot_id)
      const pkRes = await this.query(
        `ALTER TABLE settings DROP PRIMARY KEY, ADD PRIMARY KEY (id, bot_id)`
      );
      if (pkRes.error) {
        logger.error("[Settings] Failed to update primary key:", pkRes.error);
        return; // Don't set flag — bot_id features can't work without composite PK
      }

      this._hasBotIdColumn = true;
      logger.settings("[Settings] Auto-migration complete: bot_id column added.");
      return;
    }

    // ── Column already exists: verify it's in the primary key ─────────────
    const colInfo = res.results[0];
    const isNullable = colInfo.IS_NULLABLE === 'YES';
    const isPrimaryKey = colInfo.COLUMN_KEY === 'PRI';

    if (isPrimaryKey) {
      // Column exists and is part of composite PK — all good
      this._hasBotIdColumn = true;
      return;
    }

    // Column exists but is NOT in PK — the ALTER TABLE PK update must have
    // failed previously (likely because the column had NULL values).
    logger.settings("[Settings] Fixing bot_id column: adding to primary key...");

    // Step 1: Replace NULLs with empty string (PK columns can't be NULL)
    if (isNullable) {
      await this.query(`UPDATE settings SET bot_id = '' WHERE bot_id IS NULL`);
      await this.query(`ALTER TABLE settings MODIFY COLUMN bot_id VARCHAR(32) NOT NULL DEFAULT ''`);
    }

    // Step 2: Claim unclaimed rows (bot_id = '') for the current bot
    if (this.botId) {
      await this.query(
        `UPDATE settings SET bot_id = ${mysql.escape(String(this.botId))} WHERE bot_id = ''`
      );
    }

    // Step 3: Update primary key
    const pkRes = await this.query(
      `ALTER TABLE settings DROP PRIMARY KEY, ADD PRIMARY KEY (id, bot_id)`
    );
    if (pkRes.error) {
      logger.error("[Settings] Failed to update primary key:", pkRes.error);
      return; // Don't set flag — can't use bot_id without composite PK
    }

    this._hasBotIdColumn = true;
    logger.settings("[Settings] Fix complete: bot_id column added to primary key.");
  }

  /**
   * Set or update the bot ID used for database row isolation.
   * Called after login when the bot user ID becomes available.
   * Ensures the bot_id column exists (auto-migrates if needed), then
   * reloads guild data filtered by the bot's ID.
   * @param {string} id
   */
  async setBotId(id) {
    const changed = this.botId !== id;
    this.botId = id;
    if (changed) {
      // Wait for the initial load to finish before clearing and reloading
      if (this._loadPromise) await this._loadPromise;
      // Ensure the DB schema supports bot_id before querying with it
      await this._ensureBotIdColumn();

      // Claim any unclaimed legacy rows (bot_id = '') for this bot.
      // This handles the case where the column was already properly set up
      // (e.g. by another bot's migration) but legacy rows weren't claimed yet.
      if (this._hasBotIdColumn && this.botId) {
        const claimRes = await this.query(
          `UPDATE settings SET bot_id = ${mysql.escape(String(this.botId))} WHERE bot_id = ''`
        );
        if (claimRes.results?.affectedRows > 0) {
          logger.settings(`[Settings] Claimed ${claimRes.results.affectedRows} legacy row(s) for bot ${this.botId}`);
        }
      }

      // Reload with the new botId so we pick up this bot's rows
      this.guilds.clear();
      this._loadPromise = this.load();
      await this._loadPromise;
    }
  }

  /**
   * Returns the SQL WHERE clause fragment for bot_id filtering.
   * When botId is set AND the bot_id column exists in the table,
   * includes "AND bot_id = <escaped>" in queries.
   * Otherwise no filter is applied (backward-compatible with old schemas).
   * @returns {string}
   */
  _botIdWhere() {
    if (!this.botId || !this._hasBotIdColumn) return "";
    return ` AND bot_id = ${mysql.escape(String(this.botId))}`;
  }

  /**
   * Returns the bot_id column + value for INSERT statements.
   * Only includes bot_id when both the botId is set AND the column exists.
   * @returns {{ col: string, val: string }}
   */
  _botIdInsert() {
    if (!this.botId || !this._hasBotIdColumn) return { col: "", val: "" };
    return { col: ", bot_id", val: `, ${mysql.escape(String(this.botId))}` };
  }

  /**
   * Fetch a single guild's settings row from the database, filtered by bot_id.
   * Used by GatewayHandler when a guild is (re-)joined and not in the cache.
   * @param {string} guildId
   * @returns {Promise<{error: object|null, results: Array, fields: Array}>}
   */
  selectGuild(guildId) {
    const escapedId = mysql.escape(String(guildId));
    return this.query(`SELECT * FROM settings WHERE id=${escapedId}${this._botIdWhere()}`);
  }

  query(q) {
    return new Promise(res => {
      this.db.query(q, (error, results, fields) => { res({ error, results, fields }); });
    });
  }

  async load() {
    const res = await this.query(`SELECT * FROM settings WHERE 1=1${this._botIdWhere()}`);
    if (res.error) {
      this._loadAttempts++;
      // exponential backoff with a cap of 30s instead of forever-at-2s
      const delay = Math.min(1000 * Math.pow(2, this._loadAttempts - 1), 30_000);
      logger.error("[Settings] Init error (attempt", this._loadAttempts, "retrying in", delay + "ms):", res.error);
      return setTimeout(() => { this.load().catch(err => logger.error("[Settings] Retry load error:", err?.message ?? err)); }, delay);
    }
    this._loadAttempts = 0;
    res.results.forEach((r) => {
      try {
        const server = new ServerSettings(r.id, this);
        // mysql2 may return JSON columns as already-parsed objects;
        // only JSON.parse when the value is still a string.
        const parsed = (typeof r.data === "string") ? JSON.parse(r.data) : r.data;
        server.deserialize(parsed);
        server.checkDefaults(this.defaults);
        this.guilds.set(server.id, server);
      } catch (e) {
        logger.error("[Settings] Failed to parse settings for server", r.id, ":", e.message);
      }
    });
    this.emit("ready");
  }

  async remoteUpdate(server, key) {
    const val = server.data[key];
    // Arrays/objects must go through remoteSave — JSON_SET with scalar
    // interpolation corrupts arrays by merging IDs into one number on read-back.
    if (Array.isArray(val) || (typeof val === "object" && val !== null)) {
      return this.remoteSave(server);
    }
    // Use mysql.escape() for every user-supplied value to prevent SQL injection.
    // Preserve native boolean/number types — mysql.escape(String(false)) stores "false"
    // (a truthy string) which breaks strict equality checks like songAnnouncements === false.
    const escapedPath = mysql.escape(`$.${key}`);
    const escapedVal  = (typeof val === "boolean" || typeof val === "number")
        ? mysql.escape(val)
        : mysql.escape(String(val));
    const escapedId   = mysql.escape(server.id);
    const r = await this.query(`UPDATE settings SET data = JSON_SET(data, ${escapedPath}, ${escapedVal}) WHERE id=${escapedId}${this._botIdWhere()}`);
    if (r.error) logger.error("[Settings] remoteUpdate error:", r.error);
  }

  async remoteSave(server) {
    const escapedData = mysql.escape(JSON.stringify(server.data));
    const escapedId   = mysql.escape(server.id);
    const r = await this.query(`UPDATE settings SET data = ${escapedData} WHERE id=${escapedId}${this._botIdWhere()}`);
    if (r.error) logger.error("[Settings] remoteSave error:", r.error);
  }

  loadDefaultsSync(filePath) {
    try {
      const d = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(d);
      this.descriptions = parsed.descriptions;
      this.defaults = parsed.values;
    } catch (e) {
      logger.error("[Settings] Failed to load defaults from", filePath, ":", e.message);
      this.descriptions = {};
      this.defaults = {};
    }
  }

  async saveAsync() {
    await Promise.allSettled([...this.guilds.values()].map(v => this.remoteSave(v)));
  }

  async create(id, server) {
    const escapedId   = mysql.escape(id);
    const escapedData = mysql.escape(JSON.stringify(server.data));
    const bi = this._botIdInsert();
    // INSERT IGNORE: if the row already exists (race condition or failed
    // migration), silently skip instead of crashing with ER_DUP_ENTRY.
    const r = await this.query(
      `INSERT IGNORE INTO settings (id, data${bi.col}) VALUES (${escapedId}, ${escapedData}${bi.val})`
    );
    if (r.error) logger.error("[Settings] create error:", r.error);
  }

  update(server, key) {
    if (!this.guilds.has(server.id)) { this.guilds.set(server.id, server); this.create(server.id, server); }
    const s = this.guilds.get(server.id);
    s.data[key] = server.data[key];
    // Debounce: collapse rapid successive set() calls (e.g. stay_247 + stay_247_mode written
    // together) into a single remoteSave() 80ms after the last write for this server.
    // This prevents N parallel UPDATE queries when multiple keys change in one command handler.
    const existing = this._debounceTimers.get(server.id);
    if (existing) clearTimeout(existing);
    this._debounceTimers.set(server.id, setTimeout(() => {
      this._debounceTimers.delete(server.id);
      this.remoteSave(s);
    }, 80));
  }

  isOption(key) { return key in this.defaults; }
  hasServer(id) { return this.guilds.has(id); }

  getServer(id) {
    if (!this.guilds.has(id)) {
      // Return a fresh object but don't register it yet;
      // update() will call create() on the first real write.
      return new ServerSettings(id, this);
    }
    return this.guilds.get(id);
  }

  /**
   * Drop a server from the in-memory cache without touching the DB row.
   * This lets settings be restored automatically if the bot is re-invited.
   * @param {string} id - Guild / server ID
   */
  removeServer(id) {
    // Clear any pending debounce timer so it doesn't fire after the guild is gone
    // and attempt a DB write for a server that no longer belongs to us.
    const timer = this._debounceTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this._debounceTimers.delete(id);
    }
    this.guilds.delete(id);
  }
}
