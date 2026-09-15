/**
 * @module src/db/PlayerStateStore
 * @description MySQL-backed persistence for music player state so queues
 * survive bot reboots/crashes. One row per (bot_id, guild_id) holding a JSON
 * snapshot of the player: voice channel, text channel, queue tracks, current
 * track, resume position, volume and loop modes.
 *
 * WHY MySQL AND NOT REDIS/FILES:
 * - The bot already owns a MySQL pool (RemoteSettingsManager) that is flushed
 *   on graceful shutdown; snapshots ride the same healthy connection and are
 *   durable across restarts of ANY component.
 * - The project's Redis handle (dashboard RedisHandler) is a pub/sub cache
 *   whose client is closed on shutdown — it is the wrong place for state
 *   that must outlive a reboot.
 * - Local JSON files were audited and removed from the hot path years ago
 *   (storage/stats.json has no writer left); adding file writes would make
 *   the bot slower, not faster.
 *
 * Write pattern:
 * - Full snapshot: debounced 3s per player, triggered by queue/playback
 *   events (see Player.mjs).
 * - Position heartbeat: single cheap UPDATE of the position_ms column every
 *   15s while a track is playing, so resume-after-crash lands within ~15s
 *   of where the song actually was.
 */

import { logger } from "../core/Logger.mjs";
import { cleanId } from "../utils/Utils.mjs";

/** Maximum number of queued tracks persisted in one snapshot. */
const MAX_PERSISTED_TRACKS = 300;

/**
 * Reduce a track object to the plain fields needed to rebuild and replay it.
 * Track objects are plain data already, but the whitelist keeps the payload
 * small and guarantees JSON-safety (no circular refs from richer sources).
 * @param {object|null} t - Track object.
 * @returns {object|null} Slim track or null.
 */
function slimTrack(t) {
  if (!t || typeof t !== "object") return null;
  return {
    encoded:    typeof t.encoded === "string" ? t.encoded : null,
    title:      t.title ?? "Unknown",
    url:        t.url ?? null,
    thumbnail:  t.thumbnail ?? null,
    artworkUrl: t.artworkUrl ?? null,
    _durationMs: Number(t._durationMs) || 0,
    duration:   t.duration ?? null,
    author:     t.author ?? null,
    requester:  t.requester ?? null,
    type:       t.type ?? null,
    identifier: t.identifier ?? null,
    isStream:   !!t.isStream,
  };
}

/**
 * Compute the playback position of a player's current track in ms.
 * `startedPlaying` is kept in sync across seeks and pauses by the player
 * (resume folds pause duration back in), so:
 * - playing  → Date.now() - startedPlaying
 * - paused   → _pausedAt - startedPlaying (elapsed at the pause moment)
 * @param {object} player - Player instance.
 * @param {object|null} current - Current track.
 * @returns {number} Position in ms (0 when unknown).
 */
function computePosition(player, current) {
  if (!current) return 0;
  try {
    if (player._paused && player._pausedAt && player.startedPlaying) {
      return Math.max(0, player._pausedAt - player.startedPlaying);
    }
    if (player.startedPlaying) {
      return Math.max(0, Date.now() - player.startedPlaying);
    }
  } catch (_) { /* fallthrough */ }
  return 0;
}

/**
 * @class PlayerStateStore
 * @description Persists and restores player snapshots in MySQL. Reuses the
 * settings manager's mysql2 pool (callback API) — no extra connections.
 */
export class PlayerStateStore {
  /** @private @type {object|null} mysql2 callback-style pool. */
  db = null;

  /** @private @type {string} Bot user id for multi-bot isolation. */
  botId = "";

  /** @private @type {Promise<void>|null} Memoized CREATE TABLE promise. */
  _tableReady = null;

  /**
   * @param {object|null} pool - mysql2 callback pool (RemoteSettingsManager.db).
   */
  constructor(pool) {
    this.db = pool ?? null;
  }

  /**
   * Set the bot id (called once the gateway client is ready).
   * @param {string} id - Bot user id.
   */
  setBotId(id) {
    this.botId = id ? String(id) : "";
  }

  /**
   * Promisified pool.query with parameter binding.
   * @private
   * @param {string} sql - SQL with ? placeholders.
   * @param {Array} [params=[]] - Bind parameters.
   * @returns {Promise<any>} Result set.
   */
  _exec(sql, params = []) {
    return new Promise((resolve, reject) => {
      if (!this.db) return reject(new Error("PlayerStateStore: no MySQL pool"));
      this.db.query(sql, params, (err, results) => (err ? reject(err) : resolve(results)));
    });
  }

  /**
   * Create the player_state table if needed (idempotent, memoized).
   * @returns {Promise<void>}
   */
  init() {
    if (!this._tableReady) {
      this._tableReady = this._exec(
        `CREATE TABLE IF NOT EXISTS player_state (
          bot_id      VARCHAR(32) NOT NULL DEFAULT '',
          guild_id    VARCHAR(32) NOT NULL,
          data        MEDIUMTEXT  NOT NULL,
          position_ms BIGINT      NOT NULL DEFAULT 0,
          updated_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (bot_id, guild_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
      ).catch((err) => {
        this._tableReady = null; // allow retry on next call
        throw err;
      });
    }
    return this._tableReady;
  }

  /**
   * Persist a full snapshot of a player (debounce happens on the caller side).
   * Deletes the row instead when the player has neither a current track nor
   * queued songs (nothing worth restoring).
   * @param {object} player - Player instance (duck-typed).
   * @returns {Promise<void>}
   */
  async saveSnapshot(player) {
    if (!player || player._destroyed || player.leaving) return;

    const guildId = cleanId(player._guildId ?? "");
    if (!guildId) return;

    const current = player.queue?.getCurrent?.() ?? null;
    const queued  = Array.isArray(player.queue?.data) ? player.queue.data : [];
    if (!current && queued.length === 0) {
      return this.clearSnapshot(guildId);
    }

    await this.init();

    const channelId = cleanId(player._channelId ?? player._home247Channel ?? "");
    if (!channelId) return;

    const positionMs = computePosition(player, current);
    const textChannel = player.textChannel ?? null;
    const payload = {
      v: 1,
      guildId,
      channelId,
      textChannelId: cleanId(textChannel?.id ?? textChannel?.channel?.id ?? ""),
      volume: Number.isFinite(player.preferredVolume) ? player.preferredVolume : null,
      loop:     !!player.queue?.loop,
      songLoop: !!player.queue?.songLoop,
      current:  slimTrack(current),
      positionMs,
      queue:    queued.slice(0, MAX_PERSISTED_TRACKS).map(slimTrack).filter(Boolean),
      savedAt:  Date.now(),
    };

    await this._exec(
      `INSERT INTO player_state (bot_id, guild_id, data, position_ms)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE data = VALUES(data), position_ms = VALUES(position_ms)`,
      [this.botId, guildId, JSON.stringify(payload), positionMs]
    );
  }

  /**
   * Cheap heartbeat: update only the resume position of a guild's snapshot.
   * @param {string} guildId - Guild id.
   * @param {number} positionMs - Position within the current track in ms.
   * @returns {Promise<void>}
   */
  async updatePosition(guildId, positionMs) {
    const gId = cleanId(guildId);
    if (!gId) return;
    await this.init();
    await this._exec(
      `UPDATE player_state SET position_ms = ? WHERE bot_id = ? AND guild_id = ?`,
      [Math.max(0, Math.round(Number(positionMs) || 0)), this.botId, gId]
    );
  }

  /**
   * Remove a guild's snapshot (intentional %leave, guild gone, empty queue).
   * @param {string} guildId - Guild id.
   * @returns {Promise<void>}
   */
  async clearSnapshot(guildId) {
    const gId = cleanId(guildId);
    if (!gId || !this.db) return;
    try {
      await this.init();
      await this._exec(`DELETE FROM player_state WHERE bot_id = ? AND guild_id = ?`, [this.botId, gId]);
    } catch (e) {
      logger.warn("[PlayerState] clearSnapshot failed:", e?.message);
    }
  }

  /**
   * Load every snapshot belonging to this bot.
   * @returns {Promise<Array<{guildId: string, data: object, positionMs: number}>>}
   */
  async loadAll() {
    await this.init();
    const rows = await this._exec(
      `SELECT guild_id, data, position_ms FROM player_state WHERE bot_id = ?`,
      [this.botId]
    );
    const out = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      try {
        const parsed = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
        if (parsed && parsed.channelId) {
          out.push({ guildId: String(row.guild_id), data: parsed, positionMs: Number(row.position_ms) || 0 });
        }
      } catch (e) {
        logger.warn("[PlayerState] Skipping malformed snapshot for guild", row.guild_id, ":", e?.message);
      }
    }
    return out;
  }

  /**
   * Snapshot every live player of a manager immediately (shutdown path).
   * @param {object} playerManager - Object exposing playerMap (channelId → Player).
   * @returns {Promise<void>}
   */
  async saveAllFrom(playerManager) {
    const players = [...(playerManager?.playerMap?.values?.() ?? [])];
    const alive = players.filter((p) => p && !p._destroyed && !p.leaving);
    if (alive.length === 0) return;
    logger.recovery(`[PlayerState] Saving ${alive.length} player snapshot(s) before shutdown...`);
    await Promise.allSettled(alive.map((p) => this.saveSnapshot(p)));
  }
}

export default PlayerStateStore;
