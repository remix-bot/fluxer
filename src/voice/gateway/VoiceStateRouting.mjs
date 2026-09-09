/**
 * @module src/voice/gateway/VoiceStateRouting
 * @description Voice-state routing concern for {@link GatewayHandler}:
 * VOICE_STATE_UPDATE dispatch (human vs. bot paths), VOICE_STATES_SYNC bulk
 * seeding, previous-state map maintenance, voice cache updates, inactivity
 * timers on human join/leave, dashboard updates, and 24/7 bot move-away /
 * disconnect handling.
 *
 * These methods are applied onto the GatewayHandler class prototype via
 * {@link applyMixins} — `this` is a GatewayHandler instance.
 */

import { logger } from "../../core/Logger.mjs";
import { get247ChannelMode, isPlayerConnectionDead } from "../../utils/Helpers247.mjs";
import { VoiceStateCache } from "../VoiceStateCache.mjs";
import { cleanId } from "../../utils/Utils.mjs";

/**
 * @type {object}
 * @description Voice-state routing mixin — applied to GatewayHandler.
 */
const VoiceStateRouting = {
  /**
   * Main handler for VOICE_STATE_UPDATE events. Routes to human or bot sub-handlers.
   * @param {object} data - The voice state update payload from the gateway.
   * @returns {Promise<void>}
   * @private
   */
  async _handleVoiceStateUpdate(data) {
    const { remix } = this;
    const client = remix.client;

    const userId = data?.user_id;
    if (!userId) return;

    const newChannelId = data?.channel_id ?? null;
    const vsuGuildId   = data?.guild_id;
    const isBot        = data?.member?.user?.bot ?? null;


    const prevEntry    = this.findPrevVoiceStateEntry(userId, vsuGuildId);
    const prev         = prevEntry.value;
    const prevSameGuild = prev &&
        cleanId(prev.guildId ?? "") === cleanId(vsuGuildId ?? "");
    const oldChannelId = prevSameGuild ? (prev?.channelId ?? null) : null;


    this._updatePreviousStates(userId, vsuGuildId, oldChannelId, newChannelId, isBot, prevEntry, prev);
    this._updateVoiceStateCache(userId, vsuGuildId, oldChannelId, newChannelId, isBot, prev);


    const { player, playerGuildId, homeChannelId } = this._findAffectedPlayer(vsuGuildId, oldChannelId, newChannelId);

    const isBotUser = isBot === true && userId === client.user?.id;

    if (!isBotUser) {

      this._handleInactivityOnVoiceChange(player, playerGuildId, homeChannelId, userId, oldChannelId, newChannelId, vsuGuildId, data);
      return;
    }


    this._handleBotVoiceChange(player, playerGuildId, homeChannelId, oldChannelId, newChannelId, vsuGuildId, data);
  },

  /** Handle VoiceStatesSync bulk event from the gateway. @param {object} data - Sync payload with voiceStates array. @private */
  _handleVoiceStatesSync(data) {
    const { remix } = this;
    const client = remix.client;
    const guildId = data?.guildId;
    if (!guildId || !Array.isArray(data?.voiceStates)) return;

    const botId = client.user?.id;
    let humansAdded = 0;
    let botsAdded = 0;

    for (const vs of data.voiceStates) {
      const userId = vs.user_id;
      const channelId = vs.channel_id;
      if (!userId || !channelId) continue;

      const isBot = vs.member?.user?.bot ?? (userId === botId);

      remix.voiceCache.updateUser({ guildId, userId, channelId, isBot });
      if (isBot) {
        botsAdded++;
      } else {
        humansAdded++;
      }
    }

    if (humansAdded > 0 || botsAdded > 0) {
      logger.voiceState(
          `[VoiceStatesSync] Guild ${guildId}: seeded ${humansAdded} humans, ${botsAdded} bots ` +
          `(${data.voiceStates.length} total states).`
      );
    }
  },

  /** @private Update the voice state cache for a user joining/leaving. @param {string} userId @param {string} guildId @param {string|null} oldChannelId @param {string|null} newChannelId @param {boolean} isBot @param {object|null} prev */
  _updateVoiceStateCache(userId, guildId, oldChannelId, newChannelId, isBot, prev) {
    const { remix } = this;

    if (newChannelId) {
      remix.voiceCache.updateUser({ guildId: guildId ?? prev?.guildId, userId, channelId: newChannelId, isBot: isBot === true });
    } else {
      const resolvedGuildId = guildId ?? prev?.guildId;
      if (resolvedGuildId) {
        remix.voiceCache.deleteHumanUser(userId, resolvedGuildId);
        remix.voiceCache.deleteBotUser(VoiceStateCache.userKey(resolvedGuildId, userId));
      }
    }
  },

  /** @private Update the previous-voice-state map and evict stale entries. @param {string} userId @param {string} guildId @param {string|null} oldChannelId @param {string|null} newChannelId @param {boolean} isBot @param {object} prevEntry @param {object|null} prev */
  _updatePreviousStates(userId, guildId, oldChannelId, newChannelId, isBot, prevEntry, prev) {
    const { remix } = this;
    const prevKey = prevEntry.key;
    const nextKey = this.getPrevVoiceStateKey(userId, guildId ?? prev?.guildId);

    if (newChannelId) {
      if (prevKey && prevKey !== nextKey) {
        const prevGuildPart = prevKey.split(":")[0];
        const nextGuildPart = nextKey.split(":")[0];
        if (prevGuildPart === nextGuildPart) {
          this._prevVoiceState.delete(prevKey);
        }
      }
      if (nextKey && this._prevVoiceState.size >= 10_000 && !this._prevVoiceState.has(nextKey)) {
        const evictKey = this._prevVoiceState.keys().next().value;
        const evictEntry = this._prevVoiceState.get(evictKey);
        this._prevVoiceState.delete(evictKey);
        if (evictEntry) {
          const evictGuildId = evictEntry.guildId;
          const evictUserId = evictKey.split(":")[1];
          if (evictGuildId && evictUserId) {
            const currentLoc = remix.voiceCache.getUserLocation(evictGuildId, evictUserId);
            if (currentLoc && currentLoc.channelId === evictEntry.channelId) {
              remix.voiceCache.updateUser({ guildId: evictGuildId, userId: evictUserId, channelId: null, isBot: evictEntry.isBot ?? false });
            }
          }
        }
      }
      if (nextKey) this._prevVoiceState.set(nextKey, { channelId: newChannelId, guildId: guildId ?? prev?.guildId, isBot: isBot === true });
    } else {
      if (prevKey) this._prevVoiceState.delete(prevKey);
    }
  },

  /** @private Find a player affected by a voice state change. @param {string} guildId @param {string|null} oldChannelId @param {string|null} newChannelId @returns {{player: Player|null, playerGuildId: string|null, homeChannelId: string|null}} */
  _findAffectedPlayer(guildId, oldChannelId, newChannelId) {
    const { remix } = this;


    if (oldChannelId) {
      const cleanOld = cleanId(oldChannelId);
      const player = remix.players.playerMap.get(cleanOld);
      if (player) {
        return { player, playerGuildId: player._guildId, homeChannelId: player._home247Channel };
      }
    }


    if (newChannelId) {
      const cleanNew = cleanId(newChannelId);
      const player = remix.players.playerMap.get(cleanNew);
      if (player) {
        return { player, playerGuildId: player._guildId, homeChannelId: player._home247Channel };
      }
    }

    return { player: null, playerGuildId: null, homeChannelId: null };
  },

  /** @private Manage inactivity timers when a human joins or leaves a voice channel. @param {Player|null} player @param {string|null} playerGuildId @param {string|null} homeChannelId @param {string} userId @param {string|null} oldChannelId @param {string|null} newChannelId @param {string} vsuGuildId @param {object} vsu */
  async _handleInactivityOnVoiceChange(player, playerGuildId, homeChannelId, userId, oldChannelId, newChannelId, vsuGuildId, vsu) {
    const { remix } = this;
    const client = remix.client;
    const resolvedGuildId = vsuGuildId ?? playerGuildId;
    if (!resolvedGuildId) return;

    if (newChannelId) {
      try {
        const cleanId247 = cleanId(newChannelId);
        const player247  = remix.players.playerMap.get(cleanId247);
        if (player247 && typeof player247._stopInactivityTimer === "function") {
          logger.voiceState(`[VoiceState] Human joined 247 channel ${cleanId247}, stopping inactivity timer`);
          player247._stopInactivityTimer();
        }
      } catch(e) { logger.warn("[VoiceState] 247 inactivity timer stop failed:", e?.message); }
    }

    if (oldChannelId && oldChannelId !== newChannelId) {
      try {
        const cleanOld = cleanId(oldChannelId);
        const oldPlayer = remix.players.playerMap.get(cleanOld);
        if (oldPlayer && typeof oldPlayer._startInactivityTimer === "function") {
          setTimeout(() => {
            if (!oldPlayer._hasHumansInChannel()) {
              logger.voiceState(`[VoiceState] Last human left ${cleanOld}, starting inactivity timer`);
              oldPlayer._startInactivityTimer();
            }
          }, this.T.aloneCheckDebounce);
        }
      } catch(e) { logger.warn("[VoiceState] Inactivity timer start failed:", e?.message); }
    }

    if (newChannelId) {
      try {
        const cleanChId = cleanId(newChannelId);
        const newPlayer = remix.players.playerMap.get(cleanChId);
        if (newPlayer && typeof newPlayer._stopInactivityTimer === "function") {
          logger.voiceState(`[VoiceState] Human joined ${cleanChId}, stopping inactivity timer`);
          newPlayer._stopInactivityTimer();
        }
      } catch(e) { logger.warn("[VoiceState] Inactivity timer stop failed:", e?.message); }
    }

    if (remix.dashboard?.enabled) {
      try {
        let userObj = vsu?.member?.user;
        if (!userObj) {
          try { userObj = await client.users.fetch(userId).catch(() => null); } catch(e) { logger.warn("[VoiceState] Dashboard user fetch failed:", e?.message); }
        }
        if (userObj) {
          const details = {
            type: newChannelId ? "join" : "leave",
            guildId: resolvedGuildId,
            channelId: newChannelId ?? null,
            oldChannelId: oldChannelId ?? null,
          };
          remix.dashboard.updateUser(details, userObj);
        }

        const refChannel = newChannelId ?? oldChannelId;
        const cleanId_ref = refChannel ? cleanId(refChannel) : null;

        if (cleanId_ref) {
          const dashPlayer = remix.players.playerMap.get(cleanId_ref);
          if (dashPlayer) {
            const eventType = newChannelId ? "join" : "leave";
            remix.dashboard.updatePlayer({
              type: eventType,
              data: userId,
            }, dashPlayer);

            remix.dashboard.playerUpdate({
              type: eventType,
            }, dashPlayer);
          }
        }
      } catch(e) { logger.warn("[VoiceState] Dashboard update failed:", e?.message); }
    }
  },

  /**
   * Handle a voice state update for the bot itself.
   * Detects move-away from 24/7 channels and unexpected disconnects.
   * @param {Player|null} player - The affected player (if any).
   * @param {string|null} playerGuildId - The guild ID from the player.
   * @param {string|null} homeChannelId - The 24/7 home channel ID from the player.
   * @param {string|null} oldChannelId - The channel the bot was in.
   * @param {string|null} newChannelId - The channel the bot moved to (null if disconnected).
   * @param {string} vsuGuildId - The guild ID from the VSU event.
   * @param {object} vsu - The raw VSU payload.
   * @private
   */
  _handleBotVoiceChange(player, playerGuildId, homeChannelId, oldChannelId, newChannelId, vsuGuildId, vsu) {
    const { remix } = this;
    const client = remix.client;
    const guildId = vsuGuildId;

    if (newChannelId && guildId && oldChannelId && oldChannelId !== newChannelId) {
      // During boot recovery, ignore move events — the recovery loop handles rejoining.
      if (this._bootRecoveryActive) {
        logger.voice247(
            `[247] Ignoring bot move ${cleanId(oldChannelId)} → ${cleanId(newChannelId)} during boot recovery.`
        );
        return;
      }
      try {
        const cleanNew = cleanId(newChannelId);
        const cleanOld = cleanId(oldChannelId);

        // Check if old channel is a saved 24/7 channel
        const oldIs247 = (() => {
          try {
            const set = remix.settingsMgr.getServer(guildId);
            return get247ChannelMode(set, cleanOld) === "on";
          } catch (_) { return false; }
        })();

        // Check if new channel is a saved 24/7 channel or has a pending spawn
        const newChannelSaved = (() => {
          try {
            const set = remix.settingsMgr.getServer(guildId);
            return get247ChannelMode(set, cleanNew) === "on";
          } catch (_) { return false; }
        })();
        const newChannelPendingSpawn = remix.players?._pendingJoins?.has?.(cleanNew) || false;

        const existingPlayer = remix.players.playerMap.get(cleanOld);

        if (oldIs247 && existingPlayer) {
          // Old channel is 24/7 — bot physically moved away, so the voice
          // connection to old channel is dead. Destroy the old player and
          // schedule a fresh rejoin so it gets a new live connection.
          logger.voice247(
              `[247] Bot moved away from 24/7 channel ${cleanOld} → ${cleanNew}. ` +
              `Destroying stale player, scheduling rejoin for ${cleanOld}.`
          );
          remix.players.playerMap.delete(cleanOld);
          const homeCh = cleanId(existingPlayer._home247Channel ?? "");
          if (homeCh && homeCh !== cleanOld) remix.players.playerMap.delete(homeCh);
          try { existingPlayer.destroy(); } catch (_) {}
          if (typeof remix.schedule247Rejoin === "function") {
            remix.schedule247Rejoin(cleanOld, cleanId(guildId));
          } else {
            const rejoinDelay = this.T.rejoin247Delay ?? 3_000;
            setTimeout(() => {
              this._rejoinChannel(cleanId(guildId), cleanOld).catch(err => {
                logger.warn(`[247] Failed to rejoin ${cleanOld} after move-away:`, err.message);
              });
            }, rejoinDelay);
          }
        } else if (newChannelSaved || newChannelPendingSpawn) {
          // New channel is already 24/7 or being spawned — keep both, don't rekey.
          logger.voice247(
              `[247] Keeping both channels ${cleanOld} and ${cleanNew} ` +
              `(saved=${newChannelSaved} pending=${newChannelPendingSpawn})`
          );
        } else if (existingPlayer && cleanNew !== cleanOld) {
          // Neither channel is 24/7 — safe to rekey the player.
          const targetChannel = client.channels.get(cleanNew)
              ?? client.channels.get?.(cleanNew)
              ?? null;
          const targetGuildId = cleanId(targetChannel?.guildId ?? targetChannel?.guild?.id ?? guildId ?? "");

          const playerAtNewKey = remix.players.playerMap.get(cleanNew);
          if (!playerAtNewKey || playerAtNewKey === existingPlayer) {
            remix.players.playerMap.delete(cleanOld);
            remix.players.playerMap.set(cleanNew, existingPlayer);
            existingPlayer._channelId = cleanNew;
            existingPlayer._home247Channel = cleanNew;
            if (targetGuildId) existingPlayer._guildId = targetGuildId;
            logger.voice247(`[247] Re-keyed playerMap ${cleanOld} → ${cleanNew}`);
          } else {
            logger.voice247(
                `[247] Skipped re-key ${cleanOld} → ${cleanNew} (new key occupied by another player)`
            );
          }
        }

        // Simplified 24/7: stay_247 list only changes via !247 command.
        // Do NOT auto-add/remove channels on bot move.
      } catch (e) {
        logger.warn("[247] Bot move handler failed:", e.message);
      }
    }


    if (!newChannelId && oldChannelId && guildId) {
      try {
        const cleanOld = cleanId(oldChannelId);
        const cleanGuild = cleanId(guildId);

        if (this._inStartupGrace) {
          const bootPlayer = remix.players.playerMap.get(cleanOld);
          const playerAlive = !!bootPlayer && !bootPlayer._destroyed && !isPlayerConnectionDead(bootPlayer);
          if (playerAlive) {
            logger.voiceState(
                `[VoiceState] Bot disconnected from ${cleanOld} during startup grace — ` +
                `player still active, ignoring stale disconnect.`
            );
            return;
          }

          // Player missing or already dead. The old code just dropped the
          // event ("deferring until grace period ends" — nothing ever
          // replayed it), so a 24/7 channel killed during boot never came
          // back. Arm a deferred bot-level rejoin for just after the grace
          // window instead.
          const graceSet = remix.settingsMgr.getServer(guildId);
          const graceMode = graceSet ? get247ChannelMode(graceSet, cleanOld) : "off";
          if (graceMode === "on" && typeof remix.schedule247Rejoin === "function") {
            const graceStarted = this._graceStartedAt ?? Date.now();
            const graceRemaining = Math.max(0, this._startupDeleteGraceMs - (Date.now() - graceStarted));
            const rejoinDelay = remix.config?.timers?.rejoin247Delay ?? this.T.rejoin247Delay ?? 3_000;
            logger.voice247(
                `[VoiceState] Bot disconnected from ${cleanOld} during startup grace with a dead player — ` +
                `arming deferred 24/7 rejoin in ${Math.round((graceRemaining + rejoinDelay) / 1000)}s.`
            );
            remix.schedule247Rejoin(cleanOld, cleanGuild, graceRemaining + rejoinDelay);
          } else {
            logger.voiceState(
                `[VoiceState] Bot disconnected from ${cleanOld} during startup grace — ` +
                `deferring until grace period ends.`
            );
          }
          return;
        }

        if (remix.intentionalLeaves.has(cleanOld)) {
          logger.voiceState(`[VoiceState] Bot disconnected from ${cleanOld} — intentional leave.`);
        } else if (this._isGuildMoveInProgress(cleanGuild, cleanOld)) {
          logger.voiceState(`[VoiceState] Bot disconnected from ${cleanOld} — guild move in progress, skipping.`);
        } else if (this._bootRecoveryActive) {
          logger.voiceState(`[VoiceState] Bot disconnected from ${cleanOld} — boot recovery active, skipping.`);
        } else {
          const set = remix.settingsMgr.getServer(guildId);
          const mode = set ? get247ChannelMode(set, cleanOld) : "off";
          const wsInduced = this.isWsReconnectRecent();

          if (mode === "on" || wsInduced) {
            const reason = wsInduced && mode !== "on"
                ? `WS reconnect detected (${Math.round((Date.now() - this._lastReadyAt) / 1000)}s ago) — treating as transient, scheduling rejoin`
                : `24/7 mode — scheduling rejoin`;
            logger.voice247(
                `[VoiceState] Bot unexpectedly disconnected from ${cleanOld} — ${reason}.`
            );
            const discPlayer = remix.players.playerMap.get(cleanOld);
            if (discPlayer && !discPlayer._destroyed) {
              remix.players.playerMap.delete(cleanOld);
              const homeChannel = cleanId(discPlayer._home247Channel ?? "");
              if (homeChannel && homeChannel !== cleanOld) {
                remix.players.playerMap.delete(homeChannel);
              }
              try { discPlayer.destroy(); } catch(e) { logger.warn("[VoiceState] Player destroy failed:", e?.message); }
              const pendingScrobble = remix.players._pendingScrobbleTimers?.get(cleanOld);
              if (pendingScrobble) {
                clearTimeout(pendingScrobble.timer);
                remix.players._pendingScrobbleTimers.delete(cleanOld);
              }
            }
            const rejoinDelay = this.T.rejoin247Delay ?? 3_000;
            if (typeof remix.schedule247Rejoin === "function") {
              remix.schedule247Rejoin(cleanOld, cleanGuild);
            } else {
              setTimeout(() => {
                this._rejoinChannel(cleanGuild, cleanOld).catch(err => {
                  logger.warn(`[VoiceState] Failed to rejoin ${cleanOld} after disconnect:`, err.message);
                });
              }, rejoinDelay);
            }
          } else {
            const leavePlayer = remix.players.playerMap.get(cleanOld);
            if (leavePlayer && !leavePlayer.leaving && !leavePlayer._destroyed) {
              logger.voiceState(
                  `[VoiceState] Bot disconnected from ${cleanOld} (24/7 mode: ${mode}) — emitting autoleave.`
              );
              leavePlayer.emit("autoleave");
            }
          }
        }
      } catch (e) {
        logger.warn("[VoiceState] Bot disconnect handler failed:", e.message);
      }
    }
  },
};

export default VoiceStateRouting;
export { VoiceStateRouting };
