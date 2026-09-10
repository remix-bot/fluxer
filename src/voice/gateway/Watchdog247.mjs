/**
 * @module src/voice/gateway/Watchdog247
 * @description Continuous 24/7 self-healing watchdog for {@link GatewayHandler}.
 *
 * Boot recovery (rejoin247Channels) is one-shot: if a rejoin fails — Lavalink
 * not up yet, transient voice error, gateway hiccup — the channel stays dead
 * until the next restart. This mixin adds a periodic sweep so every saved
 * 24/7 channel converges on a live player:
 *
 *   healthy player        -> nothing to do
 *   zombie / dead player  -> evict from the map + arm bot-level rejoin
 *   no player at all      -> arm bot-level rejoin
 *   intentional leave     -> never re-armed (respect the user's !leave/!247 off)
 *   channel gone          -> verified via cache AND REST before the setting
 *                            is pruned (cache-miss alone is NOT proof the
 *                            channel was deleted — the channels cache is
 *                            FIFO-bounded since the OOM fix)
 *
 * Sweeps are skipped while boot recovery is running so the two systems never
 * race. The interval is unref'd so it never holds the process open.
 */

import { logger } from "../../core/Logger.mjs";
import { cleanId } from "../../utils/Utils.mjs";
import { get247ChannelMode, isPlayerConnectionDead, detachPlayerFromManager } from "../../utils/Helpers247.mjs";

/** @type {number} Default sweep interval (ms). Overridable via config.timers.watchdog247Interval. */
const DEFAULT_SWEEP_INTERVAL = 60_000;

/**
 * @type {object}
 * @description Watchdog mixin — applied to GatewayHandler alongside
 * VoiceStateRouting / GuildSync / RejoinManager.
 */
const Watchdog247 = {
  /**
   * Start the 24/7 watchdog sweep loop (idempotent).
   * @this {GatewayHandler}
   * @returns {void}
   */
  start247Watchdog() {
    if (this._247WatchdogTimer) return;
    const interval = Number(this.remix?.config?.timers?.watchdog247Interval) || DEFAULT_SWEEP_INTERVAL;
    this._247WatchdogInterval = interval;
    this._247WatchdogTimer = setInterval(() => {
      this._sweep247Channels().catch(err => {
        logger.warn("[Watchdog247] Sweep crashed:", err?.message ?? err);
      });
    }, interval);
    this._247WatchdogTimer.unref?.();
    logger.voice247(`[Watchdog247] Active — checking every ${interval / 1000}s.`);
  },

  /**
   * Stop the watchdog sweep loop (idempotent). Called on shutdown.
   * @this {GatewayHandler}
   * @returns {void}
   */
  stop247Watchdog() {
    if (!this._247WatchdogTimer) return;
    clearInterval(this._247WatchdogTimer);
    this._247WatchdogTimer = null;
    logger.voice247("[Watchdog247] Stopped.");
  },

  /**
   * Whether the watchdog loop is currently running.
   * @this {GatewayHandler}
   * @returns {boolean}
   */
  isWatchdog247Running() {
    return Boolean(this._247WatchdogTimer);
  },

  /**
   * Resolve a channel by ID with a REST fallback. The channels cache is
   * FIFO-bounded (OOM fix), so a cache miss does NOT mean the channel was
   * deleted — only a REST fetch that definitively fails (404-style) proves
   * deletion. Network errors keep the setting intact.
   * @this {GatewayHandler}
   * @param {string} channelId - The channel ID to resolve.
   * @returns {Promise<{channel: object|null, definitive: boolean}>}
   *          `channel` when found; otherwise `definitive: true` only when the
   *          channel is provably gone.
   * @private
   */
  async _resolve247Channel(channelId) {
    const clean = cleanId(channelId);
    if (!clean) return { channel: null, definitive: true };

    const cached = this.remix?.client?.channels?.get?.(clean) ?? null;
    if (cached) return { channel: cached, definitive: false };

    try {
      const fetched = await this.remix?.client?.channels?.fetch?.(clean);
      if (fetched) return { channel: fetched, definitive: false };
      return { channel: null, definitive: true };
    } catch (_) {
      return { channel: null, definitive: false };
    }
  },

  /**
   * Remove a channel from the guild's stay_247 setting (prune).
   * @this {GatewayHandler}
   * @param {string} guildId - The guild ID.
   * @param {string} channelId - The channel ID to prune.
   * @returns {boolean} True when the setting was modified.
   * @private
   */
  _prune247Channel(guildId, channelId) {
    const cleanG = cleanId(guildId);
    const cleanCh = cleanId(channelId);
    if (!cleanG || !cleanCh) return false;
    try {
      const set = this.remix?.settingsMgr?.getServer?.(cleanG);
      if (!set?.get) return false;
      const raw = set.get("stay_247");
      if (!raw || raw === "none") return false;
      const arr = Array.isArray(raw) ? raw : [raw];
      const filtered = arr.map(id => cleanId(id)).filter(id => id && id !== cleanCh);
      if (filtered.length === arr.map(id => cleanId(id)).filter(Boolean).length) return false;
      set.set("stay_247", filtered.length > 0 ? filtered : "none");
      return true;
    } catch (err) {
      logger.warn(`[Watchdog247] Failed to prune ${cleanCh} from guild ${cleanG}:`, err?.message);
      return false;
    }
  },

  /**
   * One watchdog sweep: verify every saved 24/7 channel has a live player,
   * self-heal the ones that don't, and prune provably-deleted channels.
   * Also cancels stale rejoin timers whose channel is no longer saved.
   * @this {GatewayHandler}
   * @returns {Promise<void>}
   * @private
   */
  async _sweep247Channels() {
    const { remix } = this;
    if (!remix?.players?.playerMap) return;
    if (this._bootRecoveryActive) {
      logger.voice247("[Watchdog247] Boot recovery in progress — skipping sweep.");
      return;
    }

    let healthy = 0, healed = 0, pruned = 0, skipped = 0;
    const savedChannels = [];

    for (const [guildId, serverSettings] of remix.settingsMgr.guilds) {
      const raw = serverSettings?.get?.("stay_247");
      if (!raw || raw === "none") continue;
      const channels = (Array.isArray(raw) ? raw : [raw])
          .map(id => cleanId(id))
          .filter(id => id && id.length >= 15 && id.length <= 22);
      for (const channelId of channels) {
        if (get247ChannelMode(serverSettings, channelId) !== "on") continue;
        savedChannels.push({ guildId, channelId });
      }
    }

    for (const { guildId, channelId } of savedChannels) {
      if (remix.intentionalLeaves?.has?.(channelId)) {
        skipped++;
        continue;
      }

      const player = remix.players.playerMap.get(channelId)
          ?? [...remix.players.playerMap.values()].find(p =>
            cleanId(p?._channelId ?? "") === channelId &&
            cleanId(p?._guildId ?? "") === cleanId(guildId)
          );

      if (player && !isPlayerConnectionDead(player)) {
        healthy++;
        continue;
      }

      if (player) {
        logger.voice247(
            `[Watchdog247] ${channelId} player is a zombie — evicting and re-arming rejoin.`
        );
        try { player.destroy?.(); } catch (_) {}
        detachPlayerFromManager(remix, player, channelId);
      }

      const { channel, definitive } = await this._resolve247Channel(channelId);
      if (!channel && definitive) {
        if (this._prune247Channel(guildId, channelId)) {
          pruned++;
          remix.cancel247Rejoin?.(channelId);
          logger.voice247(`[Watchdog247] ${channelId} no longer exists — pruned from 24/7 settings.`);
        }
        continue;
      }
      if (!channel && !definitive) {
        skipped++;
        continue;
      }
      if (channel && channel.type !== 2) {
        if (this._prune247Channel(guildId, channelId)) {
          pruned++;
          remix.cancel247Rejoin?.(channelId);
          logger.voice247(`[Watchdog247] ${channelId} is not a voice channel anymore — pruned.`);
        }
        continue;
      }

      if (typeof remix.schedule247Rejoin === "function") {
        remix.schedule247Rejoin(channelId, guildId);
        healed++;
      }
    }

    const savedSet = new Set(savedChannels.map(c => c.channelId));
    for (const timerKey of remix._247RejoinTimers?.keys() ?? []) {
      if (!savedSet.has(cleanId(timerKey))) {
        remix.cancel247Rejoin?.(timerKey);
        logger.voice247(`[Watchdog247] Cancelled stale rejoin timer for ${timerKey} (not a saved 24/7 channel).`);
      }
    }

    if (healthy || healed || pruned || skipped) {
      logger.voice247(
          `[Watchdog247] Sweep done — healthy: ${healthy}, re-armed: ${healed}, ` +
          `pruned: ${pruned}, skipped: ${skipped}.`
      );
    }
  },
};


export default Watchdog247;
export { Watchdog247 };
