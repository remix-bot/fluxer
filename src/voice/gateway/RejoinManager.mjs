/**
 * @module src/voice/gateway/RejoinManager
 * @description Rejoin concern for {@link GatewayHandler}: 24/7 channel
 * rejoin with exponential-backoff retries, duplicate-join guarding, and
 * guild move-in-progress detection. The MAX_REJOIN_RETRIES static lives on
 * the base GatewayHandler class (imported below).
 *
 * These methods are applied onto the GatewayHandler class prototype via
 * {@link applyMixins} — `this` is a GatewayHandler instance.
 */

import { logger } from "../../core/Logger.mjs";
import { cleanId } from "../../utils/Utils.mjs";
import { GatewayHandler } from "./GatewayHandler.mjs";

/**
 * @type {object}
 * @description Rejoin manager mixin — applied to GatewayHandler.
 */
const RejoinManager = {
  /**
   * Attempt to spawn a player for a channel with exponential-backoff retries.
   * @param {string} channelId - The target channel ID.
   * @param {string} guildId - The guild ID.
   * @param {number} [maxRetries=3] - Maximum retry attempts.
   * @param {number} [baseDelay=5000] - Base delay in ms (doubled each retry).
   * @param {string} [context='Rejoin'] - Label for log messages.
   * @returns {Promise<Player|null>} The spawned player, or null if all retries failed.
   * @private
   */
  async _attemptRejoin(channelId, guildId, maxRetries = 3, baseDelay = 5_000, context = 'Rejoin') {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const player = await this.remix._spawnPlayer(guildId, channelId);
        this.reseedVoiceStatesForChannel(guildId, channelId);
        logger.voice247(
            `[${context}] Successfully rejoined channel ${channelId}` +
            (attempt > 1 ? ` (after ${attempt - 1} retry/retries)` : '')
        );
        return player;
      } catch (err) {
        const errMsg = err?.message ?? String(err);
        const isTrackTimeout = errMsg.includes("track publication timed out")
            || errMsg.includes("lavalink player create failed")
            || errMsg.includes("Failed to create audio player")
            || errMsg.includes("internal error");

        if (isTrackTimeout && attempt < maxRetries) {
          const backoffMs = baseDelay * Math.pow(2, attempt - 1);
          logger.warn(
              `[${context}] Track publication failed for channel ${channelId} (attempt ${attempt}/${maxRetries}) — ` +
              `retrying in ${backoffMs / 1000}s: ${errMsg}`
          );
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          continue;
        }

        logger.warn(
            `[${context}] Failed to rejoin channel ${channelId} (attempt ${attempt}/${maxRetries}): ${errMsg}` +
            (attempt > 1 ? ` (after ${attempt} attempts)` : '')
        );
        return null;
      }
    }
    return null;
  },

  /**
   * Safely rejoin a 24/7 channel. Guards against duplicate joins,
   * intentional leaves, missing channels, and pending joins.
   * @param {string} guildId - The guild ID.
   * @param {string} channelId - The target channel ID.
   * @returns {Promise<Player|null>} The spawned player, or null if skipped.
   * @private
   */
  async _rejoinChannel(guildId, channelId) {
    const { remix } = this;
    const cleanGuildId   = cleanId(guildId);
    const cleanChannelId = cleanId(channelId);

    if (this._rejoinInProgress.has(cleanChannelId)) {
      logger.voice247(`[Rejoin] Channel ${cleanChannelId} rejoin already in progress — skipping.`);
      return;
    }

    const existing = remix.players.playerMap.get(cleanChannelId);
    if (existing && !existing._destroyed) {
      logger.voice247(`[Rejoin] Channel ${cleanChannelId} already has a player — skipping.`);
      this._rejoinAttempts.delete(cleanChannelId);
      return;
    }

    if (remix.players._pendingJoins?.has?.(cleanChannelId)) {
      logger.voice247(`[Rejoin] Channel ${cleanChannelId} already has a pending join — skipping.`);
      return;
    }

    if (remix.intentionalLeaves.has(cleanChannelId)) {
      logger.voice247(`[Rejoin] Channel ${cleanChannelId} was intentionally left — skipping.`);
      this._rejoinAttempts.delete(cleanChannelId);
      return;
    }

    const channel = remix.client?.channels?.get?.(cleanChannelId);
    if (!channel) {
      logger.voice247(`[Rejoin] Channel ${cleanChannelId} no longer exists — skipping.`);
      this._rejoinAttempts.delete(cleanChannelId);
      return;
    }

    this._rejoinInProgress.add(cleanChannelId);

    const maxRetries = GatewayHandler.MAX_REJOIN_RETRIES;
    logger.voice247(
        `[Rejoin] Attempting to rejoin channel ${cleanChannelId} in guild ${cleanGuildId}...`
    );

    try {
      const player = await this._attemptRejoin(cleanChannelId, cleanGuildId, maxRetries, 5_000, "Rejoin");
      if (player) {
        this._rejoinAttempts.delete(cleanChannelId);
      } else {
        this._rejoinAttempts.delete(cleanChannelId);
      }
      return player;
    } finally {
      this._rejoinInProgress.delete(cleanChannelId);
    }
  },

  /** @private Check whether a guild currently has a move in progress (recently connected player or pending join). Used to suppress false positive disconnect-rejoin loops. @param {string} guildId - The guild ID. @param {string} oldChannelId - The channel the bot just left. @returns {boolean} True if a move is in progress within the evidence window. */
  _isGuildMoveInProgress(guildId, oldChannelId) {
    const { remix } = this;
    const cleanGuild = cleanId(guildId);
    const cleanOld = cleanId(oldChannelId);
    if (!cleanGuild || !cleanOld) return false;

    const now = Date.now();
    const activePlayers = [...remix.players.playerMap.values()].filter(
        p => !p._destroyed && cleanId(p._guildId ?? "") === cleanGuild
    );

    for (const player of activePlayers) {
      const playerChannel = cleanId(player._channelId ?? "");
      if (!playerChannel || playerChannel === cleanOld) continue;
      const connectedAt = player._lastConnectedAt ?? 0;
      if (now - connectedAt < this._moveEvidenceWindowMs) {
        return true;
      }
    }

    if (remix.players._pendingJoins) {
      for (const pendingId of remix.players._pendingJoins) {
        const cleanPending = cleanId(pendingId);
        if (cleanPending && cleanPending !== cleanOld) {
          const pendingChannel = remix.client?.channels?.get?.(cleanPending);
          if (pendingChannel && cleanId(pendingChannel.guildId ?? "") === cleanGuild) {
            return true;
          }
        }
      }
    }

    return false;
  },
};

export default RejoinManager;
export { RejoinManager };
