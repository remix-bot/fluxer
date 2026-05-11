import * as fs from "fs";
import { logger } from "./constants/Logger.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "./MessageHandler.mjs";
import Player from "./Player.mjs";
import { get247ChannelMode } from "./constants/Helpers247.mjs";

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
      recoveryStaggerMs:   timers.recoveryStaggerMs    ?? 3_000,
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
    /** @type {Map<string, number>} Per-guild 401 failure count for circuit breaker */
    this._guild401Count = new Map();
    /** @type {number} Max 401 failures per guild before circuit breaker trips */
    this._guild401Max = 2;

    // ── Ready flags ───────────────────────────────────────────────────────────
    this.botReady = false;
    this.settingsReady = false;

    // ── Auto-join guard ───────────────────────────────────────────────────────
    // Prevents concurrent tryAutoJoin() calls.  Both settings "ready" and
    // Events.Ready can trigger tryAutoJoin(); without this guard, two calls
    // could overlap and attempt to spawn duplicate players.
    this._autoJoinRunning = false;
    this._autoJoinDone    = false;

    // ── Expose convenience methods on the Remix instance ──────────────────────
    // These are referenced by the shutdown hooks and dashboard.
    remix._buildRecoveryState = () => this.buildRecoveryState();
    remix._writeRecoveryState = (state, label) => this.writeRecoveryState(state, label);
    remix._spawnPlayer = this.spawnPlayer.bind(this);

    // ── GatewayHandler reference (set after construction) ────────────────────
    // RecoveryManager is created before GatewayHandler, so we can't pass it
    // in the constructor. Instead, index.mjs sets this reference after both
    // objects are constructed.
    this.gatewayHandler = null;
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

        // ── Save ALL active sessions including 24/7 ──────────────────────
        // Previously, 24/7 channels were skipped because tryAutoJoin()
        // handles reconnection on boot.  However, this meant queue data
        // (current track, queue, loop state) was lost on restart.
        // Now we save 24/7 channels too, with their mode stored in the
        // recovery data so tryAutoJoin() can restore both the connection
        // and the music state.

        const dedupeKey = `${guildId}:${channelId}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        // Determine if this is a 24/7 channel and get its per-channel mode
        let is247 = false;
        let mode247 = null;
        try {
          const set = remix.settingsMgr.getServer(guildId);
          if (set) {
            const raw247 = set.get("stay_247");
            if (raw247 && raw247 !== "none") {
              const homeChannel = this.normalizeChannelId(player._home247Channel) || channelId;
              const channels247 = Array.isArray(raw247)
                  ? raw247.map(id => this.normalizeChannelId(id)).filter(Boolean)
                  : [this.normalizeChannelId(raw247)].filter(Boolean);
              if (channels247.includes(channelId) || channels247.includes(homeChannel)) {
                is247 = true;
                mode247 = get247ChannelMode(set, homeChannel || channelId);
              }
            }
          }
        } catch (_) {}

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
          is247,
          mode247,   // "on" | "auto" | null
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
      // Try the guildId as-is first, then the cleaned version.
      // The settingsMgr Map key might differ from the guildId format
      // passed in (e.g. string vs number, or cleaned vs raw).
      let set = remix.settingsMgr.getServer(guildId);
      let raw = set.get("stay_247");
      if ((!raw || raw === "none") && String(guildId).replace(/\D/g, "") !== String(guildId)) {
        const cleanGId = String(guildId).replace(/\D/g, "");
        set = remix.settingsMgr.getServer(cleanGId);
        raw = set.get("stay_247");
      }
      if (!raw || raw === "none") {
        // Diagnostic: log why we're skipping
        logger.recovery(
          `[PlayerSpawn] Skipping 24/7 channel ${cleanChannelId} in guild ${guildId}: ` +
          `stay_247=${JSON.stringify(raw)}. ` +
          `SettingsMgr has this guild: ${remix.settingsMgr.guilds.has(guildId)}`
        );
        return;
      }

      const channels = Array.isArray(raw)
          ? new Set(raw.map(id => String(id).replace(/\D/g, "")).filter(Boolean))
          : new Set([String(raw).replace(/\D/g, "")]);
      if (!channels.has(cleanChannelId)) {
        logger.recovery(
          `[PlayerSpawn] Skipping channel ${cleanChannelId}: not in stay_247 list [${[...channels].join(", ")}]`
        );
        return;
      }
    }

    // Atomic mutex check — blocks concurrent spawns for the same channel.
    if (remix.players.playerMap.has(cleanChannelId) || this.pendingSpawns.has(cleanChannelId)) return;
    
    // ── Duplicate player cleanup for same guild ──────────────────────────
    // If there's already a player for a different channel in this guild
    // that has the SAME _channelId (e.g. due to a stale playerMap entry
    // from a previous failed recovery), clean it up before spawning.
    // This prevents the "multiple players per guild" conflict that causes
    // "skipped re-key" and gateway force-disconnects.
    const cleanGuildId = String(guildId).replace(/\D/g, "");
    for (const [mapKey, existingPlayer] of remix.players.playerMap) {
      if (existingPlayer._destroyed || existingPlayer.leaving) {
        remix.players.playerMap.delete(mapKey);
        try { existingPlayer.destroy(); } catch (_) {}
        continue;
      }
      // Check if an existing player in this guild has the same channel ID
      // as the one we're about to spawn (stale state from a move/recovery)
      const existingChannelId = String(existingPlayer._channelId ?? mapKey).replace(/\D/g, "");
      const existingGuildId = String(existingPlayer._guildId ?? "").replace(/\D/g, "");
      if (existingGuildId === cleanGuildId && existingChannelId === cleanChannelId) {
        logger.warn(
          `[PlayerSpawn] Found existing player for channel ${cleanChannelId} ` +
          `in guild ${cleanGuildId} (mapKey=${mapKey}) — destroying duplicate before spawning new player`
        );
        remix.players.playerMap.delete(mapKey);
        try { existingPlayer.leave().catch(() => {}); } catch (_) {}
        try { existingPlayer.destroy(); } catch (_) {}
      }
    }
    
    this.pendingSpawns.add(cleanChannelId);

    try {
      let channel = remix.client.channels.get(cleanChannelId);
      if (!channel) {
        try {
          channel = await remix.client.channels.fetch(cleanChannelId);
        } catch (e) {
          throw new Error(`Could not fetch channel ${cleanChannelId}: ${e.message}`);
        }
      }
      if (!channel) { throw new Error(`Channel not found: ${cleanChannelId}`); }
      remix.client.channels.set(cleanChannelId, channel);

      const p = new Player(remix.config.token, {
        client:           remix.client,
        config:           remix.config,
        nodelink:         remix.config.nodelink,
        moonlink:         remix.moonlink,
        revoice:          remix.revoice,
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

        // Per-channel mode: check the mode for this specific channel
        const matchChannel = channels2.includes(homeChannelId) ? homeChannelId
            : channels2.includes(activeChannelId) ? activeChannelId
            : null;
        const mode2 = matchChannel
            ? get247ChannelMode(remix.settingsMgr.getServer(guildId), matchChannel)
            : "off";

        // Remove player from map and destroy it now that we've read the state.
        remix.players.playerMap.delete(activeChannelId);
        if (activeChannelId !== cleanChannelId) remix.players.playerMap.delete(cleanChannelId);
        p.destroy();

        if (matchChannel && (mode2 === "on" || mode2 === "auto")) {
          this.scheduleSpawn(guildId, homeChannelId, this.T.rejoin247Delay, null, "247-autoleave");
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
                      `If you want me to stay in voice, use \`${prefix}247 on\` or \`${prefix}247 auto\`\n` +
                      `💡 Use \`${prefix}247\` to view and manage all saved channels.`
                  )
                  .toJSON();
              if (typeof ch?.send === "function") ch.send({ embeds: [embed] }).catch(() => {});
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
        if (typeof ch?.send === "function") ch.send({ embeds: [{ description: String(m), color: getGlobalColor() }] }).catch(() => {});
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

        // ── Re-seed voice states for this channel ────────────────────────────
        // After joining, the bot needs to know who's already in the channel.
        // The initial seedVoiceStatesFromGuilds() may have missed users because
        // sends voice states during GUILD_CREATE before the bot processes them.
        // This re-reads the guild's voice_states cache and updates the
        // observedVoiceUsers map so the bot detects humans already present.
        try {
          const humansFound = this.gatewayHandler.reseedVoiceStatesForChannel(guildId, cleanChannelId);
          if (humansFound > 0) {
            logger.recovery(
              `[Recovery] Re-seeded voice states for ${cleanChannelId}: ` +
              `${humansFound} human(s) already present — cancelling inactivity timer.`
            );
            // Humans are present — stop any inactivity timer that Player.join()
            // may have started (it starts one if the queue is empty).
            if (typeof p._stopInactivityTimer === "function") {
              p._stopInactivityTimer();
            }
          }
        } catch (reseedErr) {
          logger.warn("[PlayerSpawn] Voice state reseed failed:", reseedErr?.message);
        }

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
        // ── 401 Unauthorized handling with circuit breaker ─────────────────
        if (e.message?.includes("401 Unauthorized")) {
          const cleanGId = String(guildId).replace(/\D/g, "");
          
          // Bot no longer in guild → clean up entirely
          if (!remix.client.guilds.has(guildId) && !remix.client.guilds.has(cleanGId)) {
            logger.warn(
              `[PlayerSpawn] 401 on guild ${guildId} — bot no longer in server. ` +
              `Cleaning up and skipping retries.`
            );
            this.cleanStaleGuild(guildId, "401 and bot not in guild");
            return;
          }

          // Guild-level circuit breaker: if this guild has hit the 401 threshold,
          // stop retrying all channels in it during this recovery cycle.
          const prev401 = this._guild401Count.get(cleanGId) ?? 0;
          const new401 = prev401 + 1;
          this._guild401Count.set(cleanGId, new401);

          if (new401 >= this._guild401Max) {
            logger.warn(
              `[PlayerSpawn] 401 circuit breaker tripped for guild ${cleanGId} ` +
              `(${new401} failures ≥ ${this._guild401Max}). Skipping all further ` +
              `retries for this guild in the current recovery cycle.`
            );
            // Cancel any other scheduled spawns for this guild
            for (const [chId, entry] of this.scheduledSpawns) {
              if (String(entry.guildId).replace(/\D/g, "") === cleanGId) {
                clearTimeout(entry.timer);
                this.scheduledSpawns.delete(chId);
                logger.warn(`[PlayerSpawn] Circuit breaker cancelled spawn for channel ${chId}`);
              }
            }
            return;
          }

          // First 401 in guild — log with context but don't retry
          // (401 is permission-based, retrying immediately won't help)
          logger.warn(
            `[PlayerSpawn] 401 Unauthorized for channel ${cleanChannelId} in guild ${cleanGId} ` +
            `(${new401}/${this._guild401Max} before circuit breaker). ` +
            `Bot is still in guild — permissions may have been revoked. ` +
            `Skipping retry (401 is persistent, not transient).`
          );
          return;
        }

        // Retry if the failure is a transient LiveKit race (with max retries + backoff)
        // IMPORTANT: 401 Unauthorized is NOT transient — it's a permission error
        // that will keep failing. It's already handled above with the circuit
        // breaker. The "signal failure" pattern is excluded here because it
        // includes 401 errors (e.g. "engine: signal failure: client error: 401
        // Unauthorized") — retrying those just creates more 401 errors.
        const isTransient = (e.message?.includes("engine is closed") ||
            e.message?.includes("MediaPlayer after retry") ||
            e.message?.includes("LiveKit connection timeout") ||
            e.message?.includes("LiveKit failed") ||
            e.message?.includes("No room available")) &&
            !e.message?.includes("401") &&
            !e.message?.includes("Unauthorized");

        // Use the retryCount passed into spawnPlayer from scheduleSpawn's closure.
        const prevRetryCount = retryCount;

        // Determine if this channel should be retried.
        // A channel is retry-eligible if:
        //   1. It has recovery data (boot recovery session) — always retry.
        //   2. It was a 24/7 auto-join — retry if 24/7 is still enabled.
        //   3. Fallback: if the guild still exists, give at least 1 retry
        //      even when settings lookup fails (handles the race where the bot
        //      was in the guild when the join list was built but settings cache
        //      is momentarily unavailable).
        const isRetryEligible = (() => {
          if (recoveryData) return true; // boot recovery — always retry
          try {
            const raw = remix.settingsMgr.getServer(guildId)?.get("stay_247");
            if (raw && raw !== "none") return true; // 24/7 enabled
          } catch (_) {}
          // Fallback: if the bot is still in the guild, the channel is likely
          // a legitimate 24/7 or recovery channel — give it at least 1 retry.
          // This fixes the "Giving up after 0 retries" bug that occurs when
          // settingsMgr.getServer returns null during transient failures.
          if (prevRetryCount === 0 && remix.client.guilds.has(guildId)) return true;
          return false;
        })();

        const shouldRetry = isTransient && prevRetryCount < this.maxTransientRetries && isRetryEligible;
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
    if (this._autoJoinDone || this._autoJoinRunning) return;
    this._autoJoinRunning = true;
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

      const channelIds = Array.isArray(raw)
          ? raw.map(id => String(id).replace(/\D/g, "")).filter(Boolean)
          : [String(raw).replace(/\D/g, "")].filter(Boolean);

      for (const channelId of channelIds) {
        const clean = String(channelId).replace(/\D/g, "");
        // Per-channel mode: only join if this specific channel is on/auto
        const mode = get247ChannelMode(serverSettings, clean);
        if (mode !== "auto" && mode !== "on") continue;

        if (clean && !recoveryChannels.has(clean)) {
          joinList.push({ guildId, channelId: clean, recoveryData: null });
          logger.recovery(
            `[Recovery] Added 24/7 channel ${clean} (guild ${guildId}, mode ${mode}) to join list`
          );
        }
      }
    }

    logger.recovery(
      `[Recovery] Join list built: ${joinList.length} channel(s) ` +
      `(${joinList.filter(j => j.recoveryData).length} recovery, ` +
      `${joinList.filter(j => !j.recoveryData).length} 24/7)`
    );

    // ── Filter out guilds the bot is no longer a member of ────────────────
    const filteredList = [];
    for (const item of joinList) {
      // Try both the raw guildId and the cleaned (digits-only) version.
      // The settings Map might use a different format than client.guilds
      // (e.g. string vs number, or with/without non-digit chars).
      const cleanGId = String(item.guildId).replace(/\D/g, "");
      const hasRaw   = remix.client.guilds.has(item.guildId);
      const hasClean = cleanGId && cleanGId !== String(item.guildId) && remix.client.guilds.has(cleanGId);

      if (!hasRaw && !hasClean) {
        logger.recovery(
          `[Recovery] Skipping guild ${item.guildId} channel ${item.channelId} — bot is no longer in the server. ` +
          `(hasRaw=${hasRaw}, hasClean=${hasClean}, cleanGId=${cleanGId}, ` +
          `clientGuildsSample=[${[...remix.client.guilds.keys()].slice(0, 3).join(", ")}])`
        );
        this.cleanStaleGuild(item.guildId);
      } else {
        if (hasClean && !hasRaw) {
          item.guildId = cleanGId;
        }
        filteredList.push(item);
      }
    }

    if (filteredList.length === 0) return;

    // ── Sort join list by guild ID ──────────────────────────────────────────
    // Group channels by guild so that same-guild joins are dispatched
    // sequentially rather than concurrently. This is critical because the
    // Fluxer gateway needs time to process each voice state transition
    // before the next one — concurrent same-guild joins cause 401 errors.
    filteredList.sort((a, b) => {
      const ga = String(a.guildId).replace(/\D/g, "");
      const gb = String(b.guildId).replace(/\D/g, "");
      if (ga !== gb) return ga.localeCompare(gb);
      // Within the same guild, maintain original order
      return 0;
    });

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
    // Count how many sessions are currently active (joined successfully on first
    // attempt or after transient retry). Transient failures are retried
    // asynchronously by scheduleSpawn, so they don't appear here — log them
    // separately instead of claiming 0 failures.
    const immediateOk = [...remix.players.playerMap.values()].filter(p =>
      filteredList.some(item => this.normalizeChannelId(item.channelId) === this.normalizeChannelId(p._channelId ?? p._home247Channel))
    ).length;
    const immediateFail = filteredList.length - immediateOk;
    const retryPending = this.scheduledSpawns.size;

    if (errors.length > 0) {
      for (const err of errors) {
        logger.error("[Recovery] Failed to join channel", err.channelId, "guild", err.guildId, err.error);
      }
    }
    logger.recovery(
      `[Recovery] Processed ${filteredList.length} session(s) in ${elapsed}s ` +
      `(${immediateOk} joined, ${immediateFail} pending/failed` +
      (retryPending > 0 ? `, ${retryPending} retry scheduled` : "") + `).`
    );

    // Delete recovery file AFTER all spawns have been attempted (success or fail).
    // If the process crashes mid-recovery, the file still exists for next boot.
    if (recoveryFileExisted) {
      try { fs.unlinkSync(this.recoveryPath); } catch (_) {}
    }

    // Reset 401 circuit breaker for next boot cycle
    this._guild401Count.clear();
    this._autoJoinRunning = false;
    this._autoJoinDone = true;
  }
}
