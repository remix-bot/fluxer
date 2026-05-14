import { logger } from "./constants/Logger.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "./MessageHandler.mjs";
import Player from "./Player.mjs";
import { get247ChannelMode } from "./constants/Helpers247.mjs";

/**
 * RecoveryManager — handles player spawning without background recovery loops.
 *
 * The boot-time recovery system (session persistence via recovery.json) has
 * been removed. On restart the bot starts clean; only 24/7 channels configured
 * in each guild's settings are automatically rejoined.
 *
 * This module still provides:
 *   - spawnPlayer()       — create a Player and join a voice channel when explicitly requested
 *   - cleanStaleGuild()   — purge all state for a guild the bot left
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
      startupGuildGrace:  timers.startupGuildGrace    ?? 45_000,
    };

    // ── Internal state ────────────────────────────────────────────────────────
    /** @type {Set<string>} Per-channel spawn mutex */
    this.pendingSpawns = new Set();
    /** @type {Map<string, {timer, guildId, reason}>} Scheduled delayed spawns */
    this.scheduledSpawns = new Map();

    // ── Ready flags ───────────────────────────────────────────────────────────
    this.botReady = false;
    this.settingsReady = false;
    this._botReadyAt = 0;

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
    this._spawnQueue = Promise.resolve();

    // ── Expose convenience methods on the Remix instance ──────────────────────
    remix._spawnPlayer = this.spawnPlayer.bind(this);

    // ── GatewayHandler reference (set after construction) ────────────────────
    this.gatewayHandler = null;
  }

  // ── Utility helpers ──────────────────────────────────────────────────────────

  normalizeChannelId(value) {
    return String(value ?? "").replace(/\D/g, "");
  }

  _inStartupGuildGrace() {
    return this._botReadyAt > 0 && (Date.now() - this._botReadyAt) < this.T.startupGuildGrace;
  }

  _isGuildAvailable(guildId) {
    const { remix } = this;
    const cleanGuildId = String(guildId).replace(/\D/g, "");
    return remix.client.guilds.has(guildId) || remix.client.guilds.has(cleanGuildId);
  }

  _enqueueSpawn(guildId, channelId, reason = "spawn") {
    const cleanChannelId = this.normalizeChannelId(channelId);
    if (!cleanChannelId) return Promise.resolve();

    const run = async () => {
      try {
        await this.spawnPlayer(guildId, cleanChannelId);
      } catch (e) {
        logger.warn(`[PlayerSpawn] Scheduled ${reason} failed for ${cleanChannelId}:`, e?.message ?? e);
      }
    };

    const queued = this._spawnQueue.then(run, run);
    this._spawnQueue = queued.catch(() => {});
    return queued;
  }

  _disable247Channel(guildId, channelId, reason = "disabled") {
    const { remix } = this;
    const cleanGuildId = String(guildId).replace(/\D/g, "");
    const cleanChannelId = this.normalizeChannelId(channelId);
    if (!cleanGuildId || !cleanChannelId) return false;

    const set = remix.settingsMgr.getServer(guildId) ?? remix.settingsMgr.getServer(cleanGuildId);
    if (!set) return false;

    const raw = set.get("stay_247");
    if (!raw || raw === "none") return false;

    const channels = Array.isArray(raw)
      ? raw.map(id => String(id).replace(/\D/g, "")).filter(Boolean)
      : [String(raw).replace(/\D/g, "")].filter(Boolean);

    const nextChannels = channels.filter(id => id !== cleanChannelId);
    const changed = nextChannels.length !== channels.length;

    if (!changed) return false;

    set.set("stay_247", nextChannels.length > 0 ? nextChannels : "none");

    const modes = set.get("stay_247_modes");
    if (modes && typeof modes === "object" && !Array.isArray(modes)) {
      delete modes[cleanChannelId];
      set.set("stay_247_modes", modes);
    }

    if (nextChannels.length === 0) {
      set.set("stay_247_mode", "off");
    } else {
      const first = nextChannels[0];
      const nextMode = (modes && typeof modes === "object" && !Array.isArray(modes))
        ? (modes[first] ?? "auto")
        : "auto";
      set.set("stay_247_mode", nextMode);
    }

    logger.warn(
      `[247] Removed channel ${cleanChannelId} from stay_247 in guild ${cleanGuildId} (${reason}).`
    );
    return true;
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
      this._enqueueSpawn(guildId, cleanChannelId, reason);
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
    if (!this._isGuildAvailable(guildId)) {
      if (this._autoJoinRunning || !this._autoJoinDone || this._inStartupGuildGrace()) {
        // Startup phase — guild cache not populated yet, just skip quietly.
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
        locale:           remix.locale ?? null,
      });
      remix.players.setupEvents(p, { channelId: cleanChannelId, guildId });

      // ── Set a default textChannel so song announcements have somewhere to go ──
      // After a reboot, spawned players don't have a user message to set
      // textChannel from. Find the guild's announcement channel or the first
      // available text channel as a fallback.
      try {
        const guild = remix.client.guilds.get(cleanGuildId) ?? remix.client.guilds.get(guildId);
        const serverSet = remix.settingsMgr.getServer(guildId);
        const cachedChId = remix._announcementChannelCache?.get?.(guildId)
            ?? serverSet?.get("announcementChannelId")
            ?? null;
        let textCh = cachedChId ? guild?.channels?.get(String(cachedChId)) : null;
        if (!textCh && guild) {
          textCh = [...(guild.channels?.values?.() ?? [])].find(c =>
              (c.isTextBased?.() ?? c.channel_type === "TextChannel" ?? true) &&
              (c.permissionsFor?.(remix.client.user)?.has?.("SendMessages") ?? true)
          );
        }
        if (textCh) {
          p.textChannel = textCh;
          if (!cachedChId && serverSet) {
            remix._announcementChannelCache?.set?.(guildId, textCh.id);
            if (serverSet.get("announcementChannelId") !== textCh.id) {
              serverSet.set("announcementChannelId", textCh.id);
            }
          }
        }
      } catch (_) {}

      // ── Autoleave handler ───────────────────────────────────────────────────
      p.on("autoleave", async () => {
        const { activeChannelId, homeChannelId } = remix.players.detachPlayer?.(p, cleanChannelId)
          ?? {
            activeChannelId: String(p._channelId ?? cleanChannelId).replace(/\D/g, "") || cleanChannelId,
            homeChannelId: String(p._home247Channel ?? cleanChannelId).replace(/\D/g, "") || cleanChannelId,
          };

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

        p.destroy();

        if (matchChannel && (mode2 === "on" || mode2 === "auto")) {
          remix.players.schedule247Respawns?.(guildId, [homeChannelId], {
            baseDelay: this.T.rejoin247Delay,
            stagger: 0,
            source: "247-autoleave",
          });
        } else {
          try {
            const prefix = remix.handler?.getPrefix?.(guildId) ?? "%";
            const guild  = remix.client.guilds.get(guildId);
            const ch = guild?.channels?.find(c =>
                (c.isTextBased?.() ?? c.channel_type === "TextChannel" ?? true) &&
                (c.permissionsFor?.(remix.client.user)?.has?.("SendMessages") ?? true)
            );
            if (ch) {
              const desc = remix.locale?.translate(guildId, "responses.join.autoLeaveInactive247", {
                channel: `<#${activeChannelId}>`,
                prefix
              }) ?? `Left channel <#${activeChannelId}> because of inactivity.\nIf you want me to stay in voice, use \`${prefix}247 on\` or \`${prefix}247 auto\`\nUse \`${prefix}247\` to view and manage all saved channels.`;
              const embed = new EmbedBuilder()
                  .setColor(getGlobalColor())
                  .setDescription(desc)
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
        let ch = p.textChannel?.channel ?? p.textChannel ?? null;
        if (typeof ch?.send !== "function") {
          ch = cachedChId ? guild?.channels?.get(String(cachedChId)) : null;
        }
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
        if (typeof ch?.send === "function") {
          const payload = (typeof m === "object" && Array.isArray(m?.embeds))
              ? m
              : { embeds: [{ description: String(m), color: getGlobalColor() }] };
          ch.send(payload).catch(() => {});
        }
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
        const errMsg = String(e?.message ?? e ?? "");
        const isCooldownBlock = errMsg.includes("active 401 cooldown");
        const is401Error = !isCooldownBlock && (
            /\b401\b/.test(errMsg) ||
            errMsg.includes("Unauthorized") ||
            errMsg.includes("no permissions to access the room") ||
            errMsg.includes("signal failure: client error")
        );

        if (is401Error) {
          this._disable247Channel(cleanGuildId, cleanChannelId, "401 room permission failure");
          logger.warn(
            `[PlayerSpawn] 401 for guild ${cleanGuildId} on channel ${cleanChannelId}. ` +
            "Channel removed from 24/7 autojoin; leaving it disconnected until re-enabled manually."
          );
          return;
        }

        if (isCooldownBlock) {
          logger.warn(
            `[PlayerSpawn] Cooldown blocked autojoin for channel ${cleanChannelId} in guild ${cleanGuildId}. ` +
            "Keeping 24/7 setting unchanged."
          );
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
    if (!this._botReadyAt) this._botReadyAt = Date.now();
    this._autoJoinRunning = true;

    const { remix } = this;
    const joinList = [];

    for (const [guildId, serverSettings] of remix.settingsMgr.guilds) {
      try {
        if (!this._isGuildAvailable(guildId)) continue;

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

    for (let i = 0; i < joinList.length; i++) {
      const { guildId, channelId } = joinList[i];
      this.scheduleSpawn(guildId, channelId, 0, "247-autojoin");
    }

    this._autoJoinDone = true;
    this._autoJoinRunning = false;
  }
}
