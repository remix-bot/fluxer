import { logger } from "./constants/Logger.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "./MessageHandler.mjs";
import Player from "./Player.mjs";
import { get247ChannelMode } from "./constants/Helpers247.mjs";

/**
 * RecoveryManager — handles 24/7 auto-join on boot and player spawning.
 *
 * The boot-time recovery system (session persistence via recovery.json) has
 * been removed. On restart the bot starts clean; only 24/7 channels configured
 * in each guild's settings are automatically rejoined.
 *
 * This module still provides:
 *   - spawnPlayer()       — create a Player, join a voice channel (used by 24/7)
 *   - scheduleSpawn()     — delayed player spawn (used by 24/7 autoleave rejoin)
 *   - cleanStaleGuild()   — purge all state for a guild the bot left
 *   - tryAutoJoin()       — auto-join 24/7 channels when bot + settings are ready
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
      aloneCheckInterval: timers.aloneCheckInterval  ?? 30_000,
      aloneCheckDebounce: timers.aloneCheckDebounce  ?? 500,
      rejoin247Delay:     timers.rejoin247Delay       ?? 3_000,
    };

    // ── Internal state ────────────────────────────────────────────────────────
    /** @type {Set<string>} Per-channel spawn mutex */
    this.pendingSpawns = new Set();
    /** @type {Map<string, {timer, guildId, reason}>} Scheduled delayed spawns */
    this.scheduledSpawns = new Map();

    // ── Ready flags ───────────────────────────────────────────────────────────
    this.botReady = false;
    this.settingsReady = false;

    // ── Auto-join guard ───────────────────────────────────────────────────────
    this._autoJoinRunning = false;
    this._autoJoinDone    = false;

    // ── 401 error tracking ──────────────────────────────────────────────────────
    /** @type {Map<string, number>} Guild ID → timestamp when 401 ban expires.
     *  After 3 consecutive 401s, the guild is banned from further retries for
     *  5 minutes to avoid infinite retry loops. */
    this._guild401Ban = new Map();
    /** @type {Map<string, number>} Guild ID → consecutive 401 retry count.
     *  Used for exponential backoff: 1st retry after 15s, 2nd after 45s, 3rd = ban. */
    this._guild401Retries = new Map();

    // ── Expose convenience methods on the Remix instance ──────────────────────
    remix._spawnPlayer = this.spawnPlayer.bind(this);

    // ── GatewayHandler reference (set after construction) ────────────────────
    this.gatewayHandler = null;
  }

  // ── Utility helpers ──────────────────────────────────────────────────────────

  normalizeChannelId(value) {
    return String(value ?? "").replace(/\D/g, "");
  }

  /**
   * Clean up all state for a guild the bot is no longer a member of.
   *
   * @param {string} guildId
   * @param {string} [reason="bot no longer in guild"]
   */
  cleanStaleGuild(guildId, reason = "bot no longer in guild") {
    const { remix } = this;
    const cleanId = String(guildId).replace(/\D/g, "");
    logger.recovery(`[SpawnManager] Cleaning stale guild ${cleanId} (${reason}).`);

    // Destroy any active players for this guild
    for (const [channelId, player] of remix.players.playerMap) {
      if (String(player._guildId ?? "").replace(/\D/g, "") === cleanId) {
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
   * @param {string} [reason="spawn"]
   */
  scheduleSpawn(guildId, channelId, delayMs = 0, reason = "spawn") {
    const cleanChannelId = this.normalizeChannelId(channelId);
    if (!cleanChannelId) return;

    const existing = this.scheduledSpawns.get(cleanChannelId);
    if (existing) clearTimeout(existing.timer);

    const timer = setTimeout(() => {
      this.scheduledSpawns.delete(cleanChannelId);
      this.spawnPlayer(guildId, cleanChannelId).catch(e => {
        logger.warn(`[PlayerSpawn] Scheduled ${reason} failed for ${cleanChannelId}:`, e?.message ?? e);
      });
    }, Math.max(0, delayMs));

    this.scheduledSpawns.set(cleanChannelId, { timer, guildId, reason });
  }

  // ── Player spawning ──────────────────────────────────────────────────────────

  /**
   * Create a new Player and join the target voice channel.
   * Used primarily for 24/7 auto-join (boot + autoleave rejoin).
   */
  async spawnPlayer(guildId, channelId) {
    const { remix } = this;

    const cleanChannelId = this.normalizeChannelId(channelId);
    if (!cleanChannelId) return;

    // Clean up any previously scheduled spawn for this channel.
    const scheduled = this.scheduledSpawns.get(cleanChannelId);
    if (scheduled) {
      clearTimeout(scheduled.timer);
      this.scheduledSpawns.delete(cleanChannelId);
    }

    const cleanGuildId = String(guildId).replace(/\D/g, "");

    // ── Pre-flight: verify bot is still in the guild ─────────────────────
    // During startup, the guild cache may not be populated yet because
    // GuildCreate events haven't arrived. In that case, DON'T call
    // cleanStaleGuild — it would nuke the in-memory settings cache for a
    // guild the bot IS still in, causing unnecessary churn and scary log
    // messages.  The GuildCreate handler will schedule the 24/7 spawn for
    // late-arriving guilds.  cleanStaleGuild is only appropriate when we
    // know for sure the bot was kicked (i.e. a GuildDelete was received).
    if (!remix.client.guilds.has(guildId) && !remix.client.guilds.has(cleanGuildId)) {
      if (this._autoJoinRunning || !this._autoJoinDone) {
        // Startup phase — guild cache not populated yet, just skip
        logger.recovery(
          `[PlayerSpawn] Skipping channel ${cleanChannelId} in guild ${cleanGuildId} — ` +
          `guild cache not populated yet (startup race). GuildCreate will schedule spawn.`
        );
      } else {
        // Runtime — bot was actually removed from the guild
        logger.recovery(
          `[PlayerSpawn] Skipping channel ${cleanChannelId} in guild ${cleanGuildId} — ` +
          `bot is no longer in this guild.`
        );
        this.cleanStaleGuild(guildId, "bot removed before spawn attempt");
      }
      return;
    }

    // ── 24/7 check ──────────────────────────────────────────────────────
    // Only spawn if this channel is in the stay_247 list.
    let set = remix.settingsMgr.getServer(guildId);
    let raw = set?.get("stay_247");
    if ((!raw || raw === "none") && String(guildId).replace(/\D/g, "") !== String(guildId)) {
      const cleanGId = String(guildId).replace(/\D/g, "");
      set = remix.settingsMgr.getServer(cleanGId);
      raw = set?.get("stay_247");
    }
    if (!raw || raw === "none") {
      logger.recovery(
        `[PlayerSpawn] Skipping channel ${cleanChannelId} in guild ${guildId}: ` +
        `stay_247=${JSON.stringify(raw)}.`
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

    // Atomic mutex check — blocks concurrent spawns for the same channel.
    if (remix.players.playerMap.has(cleanChannelId) || this.pendingSpawns.has(cleanChannelId)) return;

    // ── Duplicate player cleanup for same guild ──────────────────────────
    for (const [mapKey, existingPlayer] of remix.players.playerMap) {
      if (existingPlayer._destroyed || existingPlayer.leaving) {
        remix.players.playerMap.delete(mapKey);
        try { existingPlayer.destroy(); } catch (_) {}
        continue;
      }
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
          this.scheduleSpawn(guildId, homeChannelId, this.T.rejoin247Delay, "247-autoleave");
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
                      `Use \`${prefix}247\` to view and manage all saved channels.`
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
      try {
        await p.join(cleanChannelId);

        // Only add to playerMap once the join is confirmed successful.
        remix.players.playerMap.set(cleanChannelId, p);

        // Record the intended 247 home channel for this player.
        p._home247Channel = cleanChannelId;

        // ── Re-seed voice states for this channel ────────────────────────────
        try {
          const humansFound = this.gatewayHandler.reseedVoiceStatesForChannel(guildId, cleanChannelId);
          if (humansFound > 0) {
            logger.recovery(
              `[Spawn] Re-seeded voice states for ${cleanChannelId}: ` +
              `${humansFound} human(s) already present — cancelling inactivity timer.`
            );
            if (typeof p._stopInactivityTimer === "function") {
              p._stopInactivityTimer();
            }
          }
        } catch (reseedErr) {
          logger.warn("[PlayerSpawn] Voice state reseed failed:", reseedErr?.message);
        }

        // ── Restore saved volume from guild settings ─────────────────────────
        try {
          const savedVol = remix.settingsMgr.getServer(guildId)?.get("volume");
          if (savedVol !== undefined && savedVol !== null) {
            const vol = Number(savedVol);
            if (!isNaN(vol)) p.preferredVolume = vol / 100;
          }
        } catch (_) {}

        logger.recovery(`[Spawn] Joined 24/7 channel ${cleanChannelId} in guild ${cleanGuildId}.`);

        // Join succeeded — clear any 401 retry counters for this guild
        this._guild401Retries.delete(cleanGuildId);
        this._guild401Ban.delete(cleanGuildId);
      } catch (e) {
        remix.players.playerMap.delete(cleanChannelId);
        try { p.destroy(); } catch (_) {}
        logger.warn("[PlayerSpawn] Failed to join channel", cleanChannelId, "guild", guildId, e.message);

        // ── 401 Unauthorized handling ─────────────────────────────────────
        const is401Error = /\b401\b/.test(e.message) ||
            e.message?.includes("Unauthorized") ||
            e.message?.includes("no permissions to access the room") ||
            e.message?.includes("signal failure: client error");

        if (is401Error) {
          // Bot not in guild cache — but during startup, the cache might not
          // be populated yet. Same race as the pre-flight check.
          if (!remix.client.guilds.has(guildId) && !remix.client.guilds.has(cleanGuildId)) {
            if (this._autoJoinRunning || !this._autoJoinDone) {
              logger.warn(
                `[PlayerSpawn] 401 on guild ${guildId} — guild cache not populated yet (startup race). Will retry.`
              );
              // Schedule a retry — don't clean up
              const retryCount = (this._guild401Retries.get(cleanGuildId) ?? 0) + 1;
              this._guild401Retries.set(cleanGuildId, retryCount);
              if (retryCount < 3) {
                this.scheduleSpawn(guildId, cleanChannelId, 15_000, `401-startup-retry-${retryCount}`);
              }
              return;
            }
            // Runtime — bot was actually removed
            logger.warn(
              `[PlayerSpawn] 401 on guild ${guildId} — bot no longer in server. Cleaning up.`
            );
            this.cleanStaleGuild(guildId, "401 and bot not in guild");
            return;
          }

          // Bot IS still in the guild — the 401 may be transient (gateway slow
          // to provision voice room). Retry with exponential backoff instead of
          // permanently giving up on the first failure.
          const retryCount = (this._guild401Retries.get(cleanGuildId) ?? 0) + 1;
          this._guild401Retries.set(cleanGuildId, retryCount);

          if (retryCount >= 3) {
            // After 3 consecutive 401s, ban this guild for 5 minutes to avoid
            // infinite retry loops. The FluxerRevoice 45s cooldown + this ban
            // prevent wasting resources on guilds where voice is truly broken.
            const banDuration = 5 * 60 * 1000; // 5 minutes
            this._guild401Ban.set(cleanGuildId, Date.now() + banDuration);
            this._guild401Retries.delete(cleanGuildId);
            logger.warn(
              `[PlayerSpawn] 401 for guild ${cleanGuildId} — ` +
              `${retryCount} consecutive failures. Banning for 5 minutes.`
            );
            return;
          }

          // Exponential backoff: 1st retry after 15s, 2nd after 45s
          const backoffMs = retryCount === 1 ? 15_000 : 45_000;
          logger.warn(
            `[PlayerSpawn] 401 for guild ${cleanGuildId} — ` +
            `transient? Retry ${retryCount}/3 in ${backoffMs / 1000}s.`
          );
          this.scheduleSpawn(guildId, cleanChannelId, backoffMs, `401-retry-${retryCount}`);
          return;
        }

        // Non-401 error — clear the 401 retry counter for this guild since
        // this was a different kind of failure.
        this._guild401Retries.delete(cleanGuildId);
      }

      return p;
    } finally {
      // Always release the mutex so future spawns aren't permanently blocked.
      this.pendingSpawns.delete(cleanChannelId);
    }
  }

  // ── Auto-join on boot (24/7 only) ────────────────────────────────────────────

  /**
   * Called when both `botReady` and `settingsReady` are true.
   * Auto-joins all 24/7 channels based on current guild settings.
   * No session persistence or recovery from previous boot.
   */
  async tryAutoJoin() {
    if (!this.botReady || !this.settingsReady) return;
    if (this._autoJoinRunning || this._autoJoinDone) return;
    this._autoJoinRunning = true;

    const { remix } = this;
    const joinList = [];

    // Collect all 24/7 channels from loaded guild settings
    for (const [guildId, serverSettings] of remix.settingsMgr.guilds) {
      try {
        const raw = serverSettings.get("stay_247");
        if (!raw || raw === "none") continue;

        const channels = Array.isArray(raw)
            ? raw.map(id => String(id).replace(/\D/g, "")).filter(id => id.length >= 15)
            : [String(raw).replace(/\D/g, "")].filter(id => id.length >= 15);

        for (const chId of channels) {
          const mode = get247ChannelMode(serverSettings, chId);
          if (mode !== "on" && mode !== "auto") continue;
          if (!remix.players.playerMap.has(chId) && !this.pendingSpawns.has(chId)) {
            joinList.push({ guildId, channelId: chId });
          }
        }
      } catch (_) {}
    }

    logger.recovery(
      `[AutoJoin] Found ${joinList.length} 24/7 channel(s) to join.`
    );

    // Schedule all 24/7 spawns immediately (no stagger). The FluxerRevoice
    // global join queue handles serialization — only one join is in-flight
    // at a time across all guilds, with a 3s gap between each. Staggering
    // here is no longer needed and just adds unnecessary delay before the
    // joins start queuing.
    for (let i = 0; i < joinList.length; i++) {
      const { guildId, channelId } = joinList[i];
      this.scheduleSpawn(guildId, channelId, 0, "247-autojoin");
    }

    this._autoJoinDone = true;
    this._autoJoinRunning = false;
  }
}
