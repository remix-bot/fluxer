import * as fs from "fs";
import { logger } from "./constants/Logger.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "./MessageHandler.mjs";
import Player from "./Player.mjs";

/**
 * RecoveryManager — handles session persistence, boot recovery, 24/7 auto-join,
 * and player spawning with concurrency control.
 *
 * Extracted from index.mjs to reduce the Remix constructor footprint.
 */
export class RecoveryManager {
  /**
   * @param {import('../../index.mjs').Remix} remix  Reference to the running bot instance.
   */
  constructor(remix) {
    this.remix = remix;

    // ── Timers derived from config ────────────────────────────────────────────
    const timers = remix.config.timers ?? {};
    this.T = {
      aloneCheckInterval:  timers.aloneCheckInterval  ?? 30_000,
      aloneCheckDebounce:  timers.aloneCheckDebounce  ?? 500,
      rejoin247Delay:      timers.rejoin247Delay       ?? 3_000,
      recoveryStaggerMs:   timers.recoveryStaggerMs    ?? 2_000,
      recoveryConcurrency:  timers.recoveryConcurrency   ?? 2,
    };

    // ── Internal state ────────────────────────────────────────────────────────
    /** @type {Set<string>} Per-channel spawn mutex */
    this.pendingSpawns = new Set();
    /** @type {Map<string, {timer, guildId, recoveryData, reason, retryCount}>} Scheduled delayed spawns */
    this.scheduledSpawns = new Map();
    /** @type {string} Path to the recovery JSON file */
    this.recoveryPath = "./storage/recovery.json";
    /** @type {number} Maximum transient retry attempts per channel before giving up */
    this.maxTransientRetries = remix.config.timers?.maxTransientRetries ?? 5;
    /** @type {number} Base delay multiplier for exponential backoff (ms) */
    this.retryBaseDelay = remix.config.timers?.retryBaseDelay ?? 15_000;

    // ── Ready flags ───────────────────────────────────────────────────────────
    this.botReady = false;
    this.settingsReady = false;

    // ── Expose convenience methods on the Remix instance ──────────────────────
    // These are referenced by the shutdown hooks and dashboard.
    remix._buildRecoveryState = () => this.buildRecoveryState();
    remix._writeRecoveryState = (state, label) => this.writeRecoveryState(state, label);
    remix._spawnPlayer = this.spawnPlayer.bind(this);
  }

  // ── Utility helpers ──────────────────────────────────────────────────────────

  normalizeChannelId(value) {
    return String(value ?? "").replace(/\D/g, "");
  }

  cloneRecoveryTrack(track) {
    try { return JSON.parse(JSON.stringify(track)); } catch { return track; }
  }

  // ── Recovery state persistence ───────────────────────────────────────────────

  buildRecoveryState() {
    const sessions = [];
    const seen = new Set();
    const { remix } = this;

    for (const [channelKey, player] of remix.players.playerMap.entries()) {
      try {
        if (!player || player._destroyed || player.leaving) continue;

        const guildId = this.normalizeChannelId(player._guildId);
        const channelId = this.normalizeChannelId(player._channelId ?? channelKey);
        if (!guildId || !channelId) continue;

        const dedupeKey = `${guildId}:${channelId}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        const current = player.queue.getCurrent();
        const queueData = player.queue.getQueue();
        const tracksToSave = [];
        if (current) tracksToSave.push(this.cloneRecoveryTrack(current));
        for (const track of queueData) tracksToSave.push(this.cloneRecoveryTrack(track));

        sessions.push({
          guildId,
          channelId,
          home247ChannelId: this.normalizeChannelId(player._home247Channel) || channelId,
          textChannelId: player.textChannel?.id ?? player.textChannel?._id ?? null,
          queue: tracksToSave,
          loopQueue: !!player.queue.loop,
          loopSong: !!player.queue.songLoop,
          preferredVolume: player.preferredVolume ?? 1,
          savedAt: Date.now(),
        });
      } catch (e) {
        logger.warn(`[Recovery] Failed to serialize session for channel ${channelKey}:`, e?.message ?? e);
      }
    }

    return sessions;
  }

  writeRecoveryState(state, sourceLabel) {
    if (!Array.isArray(state) || state.length === 0) {
      logger.recovery(`[${sourceLabel}] No active sessions to save.`);
      return false;
    }

    const tmpPath = `${this.recoveryPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
    fs.renameSync(tmpPath, this.recoveryPath);
    logger.recovery(`[${sourceLabel}] Saved ${state.length} active session(s) to ${this.recoveryPath}`);
    return true;
  }

  normalizeRecoverySessions(rawSessions) {
    if (!Array.isArray(rawSessions)) return [];

    const deduped = new Map();
    for (const session of rawSessions) {
      const guildId = this.normalizeChannelId(session?.guildId);
      const channelId = this.normalizeChannelId(session?.channelId ?? session?.home247ChannelId);
      if (!guildId || !channelId) continue;

      deduped.set(`${guildId}:${channelId}`, {
        ...session,
        guildId,
        channelId,
        home247ChannelId: this.normalizeChannelId(session?.home247ChannelId) || channelId,
        queue: Array.isArray(session?.queue)
            ? session.queue.filter(t => t && (t.encoded || t.uri || t.url))
            : [],
        loopQueue: !!session?.loopQueue,
        loopSong: !!session?.loopSong,
      });
    }

    return [...deduped.values()];
  }

  /**
   * Clean up all state for a guild the bot is no longer a member of.
   * Mirrors the GUILD_DELETE handler in GatewayHandler so that servers
   * kicked while offline are fully purged on the next boot.
   *
   * @param {string} guildId
   * @param {string} [reason="bot no longer in guild"]
   */
  cleanStaleGuild(guildId, reason = "bot no longer in guild") {
    const { remix } = this;
    const cleanId = String(guildId).replace(/\D/g, "");
    logger.recovery(`[Recovery] Cleaning stale guild ${cleanId} (${reason}).`);

    // Destroy any active players for this guild
    for (const [channelId, player] of remix.players.playerMap) {
      if (!player._guildId || String(player._guildId).replace(/\D/g, "") === cleanId) {
        remix.players.playerMap.delete(channelId);
        try { player.leave().catch(() => {}); } catch (_) {}
        try { player.destroy();               } catch (_) {}
      }
    }

    // Cancel any scheduled spawns for this guild
    for (const [channelId, entry] of this.scheduledSpawns) {
      if (String(entry.guildId).replace(/\D/g, "") === cleanId) {
        clearTimeout(entry.timer);
        this.scheduledSpawns.delete(channelId);
      }
    }

    // Clean voice-user observations
    for (const [userId, info] of [...remix.observedVoiceUsers]) {
      if (String(info.guildId).replace(/\D/g, "") === cleanId) remix.observedVoiceUsers.delete(userId);
    }
    for (const [userId, info] of [...remix.observedVoiceBots]) {
      if (String(info.guildId).replace(/\D/g, "") === cleanId) remix.observedVoiceBots.delete(userId);
    }

    // Remove from settings cache
    remix.settingsMgr.removeServer(cleanId);
    remix._announcementChannelCache?.delete?.(cleanId);
  }

  // ── Spawn scheduling ─────────────────────────────────────────────────────────

  /**
   * Schedule a delayed player spawn.  Cancels any previous scheduled spawn for
   * the same channel.
   *
   * @param {string} guildId
   * @param {string} channelId
   * @param {number} [delayMs=0]
   * @param {Object|null} [recoveryData=null]
   * @param {string} [reason="spawn"]
   * @param {number} [retryCount=0]  Current retry attempt number (0 = first try).
   */
  scheduleSpawn(guildId, channelId, delayMs = 0, recoveryData = null, reason = "spawn", retryCount = 0) {
    const cleanChannelId = this.normalizeChannelId(channelId);
    if (!cleanChannelId) return;

    const existing = this.scheduledSpawns.get(cleanChannelId);
    if (existing) clearTimeout(existing.timer);

    // Capture retryCount in the closure BEFORE the entry is deleted,
    // so spawnPlayer receives the correct count for exponential backoff.
    const capturedRetryCount = retryCount;
    const timer = setTimeout(() => {
      this.scheduledSpawns.delete(cleanChannelId);
      this.spawnPlayer(guildId, cleanChannelId, 0, recoveryData, capturedRetryCount).catch(e => {
        logger.warn(`[PlayerSpawn] Scheduled ${reason} failed for ${cleanChannelId}:`, e?.message ?? e);
      });
    }, Math.max(0, delayMs));

    this.scheduledSpawns.set(cleanChannelId, { timer, guildId, recoveryData, reason, retryCount });
  }

  /**
   * Calculate the exponential backoff delay for a given retry attempt.
   * Delay doubles each attempt: base, base*2, base*4, base*8, …
   * Capped at 5 minutes to avoid excessive waits.
   */
  getRetryDelay(retryCount) {
    const delay = this.retryBaseDelay * Math.pow(2, retryCount);
    return Math.min(delay, 300_000); // cap at 5 minutes
  }

  // ── Player spawning ──────────────────────────────────────────────────────────

  /**
   * Create a new Player, join the target voice channel, and optionally restore
   * recovery state.
   */
  async spawnPlayer(guildId, channelId, delayMs = 0, recoveryData = null, retryCount = 0) {
    const { remix } = this;

    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));

    const cleanChannelId = this.normalizeChannelId(channelId);
    if (!cleanChannelId) return;

    // Clean up any previously scheduled spawn for this channel.
    const scheduled = this.scheduledSpawns.get(cleanChannelId);
    if (scheduled) {
      clearTimeout(scheduled.timer);
      this.scheduledSpawns.delete(cleanChannelId);
    }

    // Use the passed-in retryCount (from scheduleSpawn's closure) rather
    // than reading from the now-deleted scheduledSpawns entry.

    // Only enforce 24/7 check if we are NOT recovering from a reboot
    if (!recoveryData) {
      const set = remix.settingsMgr.getServer(guildId);
      const raw = set.get("stay_247");
      if (!raw || raw === "none") return;

      const channels = Array.isArray(raw)
          ? new Set(raw.map(id => String(id).replace(/\D/g, "")).filter(Boolean))
          : new Set([String(raw).replace(/\D/g, "")]);
      if (!channels.has(cleanChannelId)) return;
    }

    // Atomic mutex check — blocks concurrent spawns for the same channel.
    if (remix.players.playerMap.has(cleanChannelId) || this.pendingSpawns.has(cleanChannelId)) return;
    this.pendingSpawns.add(cleanChannelId);

    try {
      let channel = remix.client.channels.get(cleanChannelId);
      if (!channel) {
        try {
          channel = await remix.client.channels.fetch(cleanChannelId);
        } catch (e) {
          logger.warn("[PlayerSpawn] Could not fetch channel", cleanChannelId, e.message);
          return;
        }
      }
      if (!channel) { logger.warn("[PlayerSpawn] Channel not found:", cleanChannelId); return; }
      remix.client.channels.set(cleanChannelId, channel);

      const p = new Player(remix.config.token, {
        client:           remix.client,
        config:           remix.config,
        nodelink:         remix.config.nodelink,
        moonlink:         remix.moonlink,
        settingsMgr:      remix.settingsMgr,
        observedVoiceUsers: remix.observedVoiceUsers,
      });
      remix.players.setupEvents(p, { channelId: cleanChannelId, guildId });

      // ── Autoleave handler ───────────────────────────────────────────────────
      p.on("autoleave", async () => {
        const activeChannelId = String(p._channelId ?? cleanChannelId).replace(/\D/g, "") || cleanChannelId;
        const homeChannelId = String(p._home247Channel ?? activeChannelId).replace(/\D/g, "") || activeChannelId;

        const raw2      = remix.settingsMgr.getServer(guildId).get("stay_247");
        const channels2 = (!raw2 || raw2 === "none")
            ? []
            : Array.isArray(raw2)
                ? raw2.map(id => String(id).replace(/\D/g, "")).filter(Boolean)
                : [String(raw2).replace(/\D/g, "")].filter(Boolean);
        const mode2 = remix.settingsMgr.getServer(guildId).get("stay_247_mode") ?? "auto";

        // Remove player from map and destroy it now that we've read the state.
        remix.players.playerMap.delete(activeChannelId);
        if (activeChannelId !== cleanChannelId) remix.players.playerMap.delete(cleanChannelId);
        p.destroy();

        if (channels2.includes(homeChannelId) || channels2.includes(activeChannelId)) {
          if (mode2 === "on" || mode2 === "auto") {
            this.scheduleSpawn(guildId, homeChannelId, this.T.rejoin247Delay, null, "247-autoleave");
          }
        } else {
          // 24/7 is off — send inactivity message with hint to enable 247
          try {
            const prefix = remix.handler?.getPrefix?.(guildId) ?? "%";
            const guild  = remix.client.guilds.get(guildId);
            const ch = guild?.channels?.find(c =>
                (c.isTextBased?.() ?? c.channel_type === "TextChannel" ?? true) &&
                (c.permissionsFor?.(remix.client.user)?.has?.("SendMessages") ?? true)
            );
            if (ch) {
              const embed = new EmbedBuilder()
                  .setColor(getGlobalColor())
                  .setDescription(
                      `Left channel <#${activeChannelId}> because of inactivity.\n` +
                      `If you want me to stay in voice, use \`${prefix}247 on/auto\``
                  )
                  .toJSON();
              ch.send({ embeds: [embed] }).catch(() => {});
            }
          } catch (_) {}
        }
      });

      // ── Song announcement handler ──────────────────────────────────────────
      p.on("message", (m) => {
        const raw      = remix.settingsMgr.getServer(guildId).get("songAnnouncements");
        const disabled = raw === false || raw === 0 ||
            ["false", "0", "no", "off", "disable"].includes(String(raw).toLowerCase().trim());
        if (disabled) return;

        const guild = remix.client.guilds.get(guildId);
        const serverSet  = remix.settingsMgr.getServer(guildId);
        const cachedChId = remix._announcementChannelCache.get(guildId)
            ?? serverSet.get("announcementChannelId")
            ?? null;
        let ch = cachedChId ? guild?.channels?.get(String(cachedChId)) : null;
        if (cachedChId && !ch) {
          remix._announcementChannelCache.delete(guildId);
        }
        if (!ch) {
          ch = guild?.channels?.find(c =>
              (c.isTextBased?.() ?? c.channel_type === "TextChannel" ?? true) &&
              (c.permissionsFor?.(remix.client.user)?.has?.("SendMessages") ?? true)
          );
          if (ch) {
            remix._announcementChannelCache.set(guildId, ch.id);
            if (serverSet.get("announcementChannelId") !== ch.id) {
              serverSet.set("announcementChannelId", ch.id);
            }
          }
        }
        ch?.send({ embeds: [{ description: String(m), color: getGlobalColor() }] }).catch(() => {});
      });

      // ── Join channel ───────────────────────────────────────────────────────
      // NOTE: playerMap.set happens AFTER join() succeeds so that other code
      // (alone-check, voice state handlers) never sees a non-connected player.
      try {
        await p.join(cleanChannelId);

        // Only add to playerMap once the join is confirmed successful.
        remix.players.playerMap.set(cleanChannelId, p);

        // Record the intended 247 home channel for this player.
        p._home247Channel = cleanChannelId;

        // ── Restore recovery state ───────────────────────────────────────────
        if (recoveryData) {
          if (recoveryData.textChannelId) {
            p.textChannel = remix.client.channels.get(recoveryData.textChannelId);
          }
          if (recoveryData.home247ChannelId) {
            p._home247Channel = this.normalizeChannelId(recoveryData.home247ChannelId) || cleanChannelId;
          }
          if (recoveryData.loopQueue) p.queue.setLoop(true);
          if (recoveryData.loopSong)  p.queue.setSongLoop(true);
          if (typeof recoveryData.preferredVolume === "number") {
            p.preferredVolume = recoveryData.preferredVolume;
          }

          if (recoveryData.queue && recoveryData.queue.length > 0) {
            p.queue.addMany(recoveryData.queue);

            const startPlayback = () => p.playNext().catch(e =>
              logger.warn("[Recovery] playNext failed:", e?.message)
            );

            if (remix.moonlink?._sessionId || remix.moonlink?.sessionId) {
              startPlayback();
            } else if (remix.moonlink) {
              remix.moonlink.once("ready", () => startPlayback());
            } else {
              startPlayback();
            }
          }
          logger.recovery(`[Recovery] Restored session in ${cleanChannelId} (${recoveryData.queue?.length ?? 0} track(s)).`);
        }
      } catch (e) {
        remix.players.playerMap.delete(cleanChannelId);
        try { p.destroy(); } catch (_) {}
        logger.warn("[PlayerSpawn] Failed to join channel", cleanChannelId, "guild", guildId, e.message);

        // ── Guild membership check for 401 errors ───────────────────────────
        // If the bot was kicked while offline (or between retries), the 401 will
        // keep repeating.  Verify the bot is still in the guild — if not, clean
        // up all state and skip retries entirely.
        if (e.message?.includes("401 Unauthorized") && !remix.client.guilds.has(guildId)) {
          logger.warn(
            `[PlayerSpawn] 401 on guild ${guildId} — bot no longer in server. ` +
            `Cleaning up and skipping retries.`
          );
          this.cleanStaleGuild(guildId, "401 and bot not in guild");
          return;
        }

        // Retry if the failure is a transient LiveKit race (with max retries + backoff)
        const isTransient = e.message?.includes("engine is closed") ||
            e.message?.includes("MediaPlayer after retry") ||
            e.message?.includes("LiveKit connection timeout") ||
            e.message?.includes("LiveKit failed") ||
            e.message?.includes("No room available") ||
            e.message?.includes("401 Unauthorized") ||
            e.message?.includes("signal failure");

        // Use the retryCount passed into spawnPlayer from scheduleSpawn's closure.
        const prevRetryCount = retryCount;

        const shouldRetry = isTransient && prevRetryCount < this.maxTransientRetries
            && (
                !recoveryData?.queue?.length
                    ? (() => {
                        try {
                            const raw = remix.settingsMgr.getServer(guildId)?.get("stay_247");
                            return raw && raw !== "none";
                        } catch (_) { return false; }
                    })()
                    : !!recoveryData
            );
        if (shouldRetry) {
          const nextRetry = prevRetryCount + 1;
          const retryDelay = this.getRetryDelay(prevRetryCount);
          logger.warn(
            `[PlayerSpawn] Transient join failure — retry ${nextRetry}/${this.maxTransientRetries} ` +
            `in ${retryDelay}ms (channel=${cleanChannelId})`
          );
          this.scheduleSpawn(guildId, cleanChannelId, retryDelay, recoveryData ?? null, "transient-join-retry", nextRetry);
        } else if (isTransient) {
          logger.error(
            `[PlayerSpawn] Giving up on channel ${cleanChannelId} after ${prevRetryCount} retry(es). ` +
            `Last error: ${e.message}`
          );
        }
      }

      return p;
    } finally {
      // Always release the mutex so future spawns aren't permanently blocked.
      this.pendingSpawns.delete(cleanChannelId);
    }
  }

  // ── Concurrency utility ──────────────────────────────────────────────────────

  /**
   * Run async tasks with bounded concurrency and staggered dispatch.
   *
   * Guarantees:
   *   - At most `concurrency` tasks in-flight at any time.
   *   - Minimum `staggerMs` gap between dispatching two consecutive tasks.
   *   - When a task finishes and a slot opens, the next dispatch happens
   *     after the remaining stagger time elapses (not immediately).
   *
   * @param {Array} items
   * @param {number} concurrency
   * @param {number} staggerMs
   * @param {(item) => Promise} fn
   */
  runWithConcurrency(items, concurrency, staggerMs, fn) {
    const errors = [];
    let idx = 0;
    let active = 0;
    let lastDispatchTime = -Infinity;
    let dispatchTimer = null;
    const total = items.length;

    if (total === 0) return Promise.resolve(errors);

    return new Promise((resolve) => {
      const tryDispatch = () => {
        if (dispatchTimer) { clearTimeout(dispatchTimer); dispatchTimer = null; }

        while (active < concurrency && idx < total) {
          const now = Date.now();
          const elapsed = now - lastDispatchTime;

          if (elapsed < staggerMs) {
            dispatchTimer = setTimeout(tryDispatch, staggerMs - elapsed);
            return;
          }

          const item = items[idx++];
          lastDispatchTime = Date.now();
          active++;

          fn(item)
            .catch((e) => errors.push({ ...item, error: e.message }))
            .finally(() => {
              active--;
              tryDispatch();
            });
        }

        if (idx >= total && active === 0) resolve(errors);
      };

      tryDispatch();
    });
  }

  // ── Auto-join on boot ────────────────────────────────────────────────────────

  /**
   * Called when both `botReady` and `settingsReady` are true.
   * Restores recovery sessions and auto-joins 24/7 channels.
   */
  async tryAutoJoin() {
    if (!this.botReady || !this.settingsReady) return;
    const { remix } = this;

    await new Promise(r => setTimeout(r, 2000));

    // Build a unified join list: recovery sessions + 24/7 channels
    const joinList = [];

    // 1. Recover standard reboot sessions
    let recoveryFileExisted = false;
    if (fs.existsSync(this.recoveryPath)) {
      logger.recovery("[Recovery] Found previous session data, restoring...");
      recoveryFileExisted = true;
      let data = null;
      try {
        data = JSON.parse(fs.readFileSync(this.recoveryPath, "utf8"));
      } catch (e) {
        logger.error("[Recovery] Failed to read/parse recovery file:", e);
      }
      // NOTE: File is deleted AFTER all spawns complete (see below).
      // This prevents data loss if the process crashes mid-recovery.
      const sessions = this.normalizeRecoverySessions(data);
      for (const session of sessions) {
        joinList.push({
          guildId: session.guildId,
          channelId: session.channelId,
          recoveryData: session,
        });
      }
    }

    // 2. Collect 24/7 channels (skip channels already covered by recovery)
    const recoveryChannels = new Set(joinList.map(j => j.channelId));
    for (const [guildId, serverSettings] of remix.settingsMgr.guilds) {
      const raw = serverSettings.get("stay_247");
      if (!raw || raw === "none") continue;
      const mode = serverSettings.get("stay_247_mode") ?? "auto";
      if (mode !== "auto" && mode !== "on") continue;

      const channelIds = Array.isArray(raw)
          ? raw.map(id => String(id).replace(/\D/g, "")).filter(Boolean)
          : [String(raw).replace(/\D/g, "")].filter(Boolean);

      for (const channelId of channelIds) {
        const clean = String(channelId).replace(/\D/g, "");
        if (clean && !recoveryChannels.has(clean)) {
          joinList.push({ guildId, channelId: clean, recoveryData: null });
        }
      }
    }

    // ── Filter out guilds the bot is no longer a member of ────────────────
    const filteredList = [];
    for (const item of joinList) {
      if (!remix.client.guilds.has(item.guildId)) {
        logger.recovery(
          `[Recovery] Skipping guild ${item.guildId} channel ${item.channelId} — bot is no longer in the server.`
        );
        this.cleanStaleGuild(item.guildId);
      } else {
        filteredList.push(item);
      }
    }

    if (filteredList.length === 0) return;

    const startTime = Date.now();
    logger.recovery(
      `[Recovery] Joining ${filteredList.length} session(s) ` +
      `(concurrency: ${this.T.recoveryConcurrency}, stagger: ${this.T.recoveryStaggerMs}ms)...`
    );

    const errors = await this.runWithConcurrency(
      filteredList,
      this.T.recoveryConcurrency,
      this.T.recoveryStaggerMs,
      async (item) => {
        await this.spawnPlayer(
          item.guildId,
          item.channelId,
          0, // stagger is handled by runWithConcurrency
          item.recoveryData,
        );
      },
    );

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const ok = filteredList.length - errors.length;
    if (errors.length > 0) {
      for (const err of errors) {
        logger.error("[Recovery] Failed to join channel", err.channelId, "guild", err.guildId, err.error);
      }
    }
    logger.recovery(
      `[Recovery] Processed ${filteredList.length} session(s) in ${elapsed}s ` +
      `(${ok} ok, ${errors.length} failed).`
    );

    // Delete recovery file AFTER all spawns have been attempted (success or fail).
    // If the process crashes mid-recovery, the file still exists for next boot.
    if (recoveryFileExisted) {
      try { fs.unlinkSync(this.recoveryPath); } catch (_) {}
    }
  }
}
