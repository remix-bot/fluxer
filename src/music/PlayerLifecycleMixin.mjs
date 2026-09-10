/**
 * @module src/music/PlayerLifecycleMixin
 * @description Voice-channel resolution & player lifecycle concern for
 * {@link PlayerManager}: author voice-channel detection, interactive
 * voice-channel selection prompt, leave, saved-volume restore, and
 * spawn/join of Player instances (including join retries and the autoleave
 * / now-playing announcement handlers wired inside initPlayer).
 *
 * These methods are applied onto the PlayerManager class prototype via
 * {@link applyMixins} (see src/music/PlayerManager.mjs) — `this` is a
 * PlayerManager instance.
 */

import Player from "./player/index.mjs";
import { cleanId } from "../utils/Utils.mjs";
import { logger } from "../core/Logger.mjs";
import { get247ChannelMode, isPlayerConnectionDead, detachPlayerFromManager, resolveChannelCached } from "../utils/Helpers247.mjs";
import { EmbedBuilder, PermissionFlags } from "@fluxerjs/core";
import { getVoiceManager } from "@fluxerjs/voice";
import { getGlobalColor, getMessageGuildId } from "../ui/index.mjs";
import { hasHumansInChannel, iterateVoiceStates } from "../voice/VoiceStateResolver.mjs";
import { getPlayerChannelId } from "./PlayerEventsMixin.mjs";

/** @private Check whether the bot has required voice permissions in a channel. @param {object} client @param {string} channelId @returns {boolean} True if the bot can connect, speak, and use VAD. */
function botHasVoicePermissions(client, channelId) {
  try {
    const channel = client?.channels?.get?.(channelId);
    if (!channel) return true;
    const me = channel.guild?.members?.me;
    if (!me) return true;
    const perms = me.permissionsIn?.(channel);
    if (!perms) return true;
    if (perms.has(PermissionFlags.Administrator)) return true;
    return perms.has(PermissionFlags.Connect)
        && perms.has(PermissionFlags.Speak)
        && perms.has(PermissionFlags.UseVad);
  } catch (e) {
    logger.warn("[PlayerManager] botHasVoicePermissions check failed:", e?.message);
    return true;
  }
}

/** @private Classify a join error into a known error code for user-facing messages. @param {Error} err @param {object} [client=null] @param {string} [channelId=null] @returns {string|null} Error code ('PERMISSION'|'NOT_FOUND'|'TIMEOUT'|'SESSION_RACE') or null. */
function sanitizeJoinError(err, client = null, channelId = null) {
  const msg = String(err?.message ?? err ?? "");
  if (msg.includes("401") || msg.includes("Unauthorized")) {
    if (client && channelId && !botHasVoicePermissions(client, channelId)) {
      return "PERMISSION";
    }
    return "SESSION_RACE";
  }
  if (msg.includes("permission") || msg.includes("Permission")) {
    if (client && channelId && !botHasVoicePermissions(client, channelId)) {
      return "PERMISSION";
    }
    return "SESSION_RACE";
  }
  if (msg.includes("not found") || msg.includes("Unknown channel")) {
    return "NOT_FOUND";
  }
  if (msg.includes("timeout") || msg.includes("timed out")) {
    return "TIMEOUT";
  }
  return null;
}

/**
 * @type {object}
 * @description Player lifecycle mixin — applied to PlayerManager.
 */
const PlayerLifecycleMixin = {
  /** Detect which voice channel the message author is in. @async @this {import('./PlayerManager.mjs').PlayerManager} @param {object} message @param {object} settings @returns {Promise<{channelId: string|null, alreadyInVoice: boolean, hasHumans: boolean}>} */
  async checkVoiceChannels(message, settings) {
    const guildId = message?.guildId ?? message?.channel?.guildId ?? getMessageGuildId(message);
    const userId  = message?.author?.id ?? message?.member?.user?.id;
    const cleanGuildId = cleanId(guildId);
    if (!guildId || !userId) return { channelId: null, alreadyInVoice: false, hasHumans: false };

    const guild = this.commands?.client?.guilds?.get?.(cleanGuildId);


    if (this.voiceCache) {
      const observed = this.voiceCache.getUserLocation(cleanGuildId, userId);
      if (observed && observed.channelId) {
        const alreadyInVoice = this.playerMap.has(cleanId(observed.channelId));
        const hasHumans = this.voiceCache.hasHumansInChannel(cleanGuildId, cleanId(observed.channelId));
        return { channelId: observed.channelId, alreadyInVoice, hasHumans };
      }
    }


    let channelId = message?.member?.voice?.channelId ?? null;


    if (!channelId && guild) {
      for (const vs of iterateVoiceStates(guild)) {
        if (vs.userId === String(userId) && !vs.isBot) {
          channelId = vs.channelId;
          break;
        }
      }
    }


    if (!channelId) {
      try {
        const vm = getVoiceManager(this.commands?.client);
        channelId = vm?.getVoiceChannelId?.(guildId, userId) ?? null;
      } catch (e) {
        logger.warn("[PlayerManager] VoiceManager lookup failed:", e?.message);
      }
    }


    if (!channelId && this.voiceCache) {
      const loc = this.voiceCache.getHumanUser(userId);
      if (loc && cleanId(loc.guildId) === cleanGuildId) {
        channelId = loc.channelId;
      }
    }

    if (!channelId) return { channelId: null, alreadyInVoice: false, hasHumans: false };

    const alreadyInVoice = this.playerMap.has(cleanId(channelId));

    const hasHumansResult = hasHumansInChannel({
      guildId: cleanGuildId,
      channelId: cleanId(channelId),
      client: this.commands?.client,
      voiceCache: this.voiceCache,
      observedVoiceUsers: this.observedVoiceUsers,
      room: this.playerMap.get(cleanId(channelId))?.connection?.room,
      botId: this.commands?.client?.user?.id,
    });

    return { channelId, alreadyInVoice, hasHumans: hasHumansResult };
  },

  /** Prompt the user to select a voice channel via reactions or text input. @async @this {import('./PlayerManager.mjs').PlayerManager} @param {object} msg @returns {Promise<Player|false>} */
  async promptVC(msg) {
    const { channelId: autoDetected } = await this.checkVoiceChannels(msg);
    if (autoDetected) {
      return this.initPlayer(msg, autoDetected);
    }

    const guildId = getMessageGuildId(msg);
    const cleanGuildId = cleanId(guildId);
    const allChannels = cleanGuildId
        ? [...(this.commands.client?.channels?.values?.() ?? [])]
            .filter(c => {
              const channelGuildId = cleanId(c.guildId ?? c.guild?.id ?? c.server_id ?? c.serverId);
              const isVoice = c.type === 2;
              return channelGuildId === cleanGuildId && isVoice;
            })
        : [];

    const reactions  = ["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣"];
    const channelArr = allChannels.slice(0, 9);

    let channelSelection = "";
    if (channelArr.length > 0) {
      channelSelection = this._t(msg, "responses._common.voiceSelectionPrompt") + "\n\n";
      channelArr.forEach((c, i) => { channelSelection += `${i + 1}. <#${c._id ?? c.id}>\n`; });
    }

    const hint = this._t(msg, "responses._common.voiceSelectionHint");
    const selectionMsg = await msg.reply(
        (channelSelection ? channelSelection + "\n**..or** " + hint : "Please " + hint)
    );

    return new Promise(resolve => {
      let unsubscribeReactions;
      let unsubscribeMessages;
      const promptUser = msg.author ?? msg.message?.author ?? null;

      const cleanup = () => {
        unsubscribeMessages?.();
        unsubscribeReactions?.();
      };

      const timeout = setTimeout(() => {
        cleanup();
        msg.reply(this._t(msg, "responses._common.voiceSelectionTimedOut"));
        resolve(false);
      }, 30_000);

      if (typeof selectionMsg?.onReaction === "function" && channelArr.length > 0) {
        unsubscribeReactions = selectionMsg.onReaction(
            reactions.slice(0, channelArr.length),
            (e) => {
              const idx     = reactions.indexOf(e.emoji_id ?? e.emoji?.id ?? e.emoji);
              const channel = channelArr[idx];
              if (!channel) return;
              clearTimeout(timeout);
              cleanup();
              const cid = channel._id ?? channel.id;
              this.initPlayer(msg, cid).then(p => resolve(p));
            },
            promptUser
        );
      }

      unsubscribeMessages = msg.channel.onMessageUser((m) => {
        const content = m.content?.toLowerCase() ?? "";
        if (content === "x") {
          clearTimeout(timeout);
          cleanup();
          m.reply(this._t(m, "voice.join.cancelled"));
          resolve(false);
          return;
        }
        if (!this.commands.validateInput("voiceChannel", m.content, m)) {
          m.reply(this._t(m, "responses._common.voiceSelectionInvalid"));
          return;
        }
        const channel = this.commands.formatInput("voiceChannel", m.content, m);
        clearTimeout(timeout);
        cleanup();
        this.initPlayer(m, channel).then(p => resolve(p));
      }, promptUser);
    });
  },

  /** Leave a voice channel, destroy the player, and send a confirmation. @async @this {import('./PlayerManager.mjs').PlayerManager} @param {object} msg @param {string} [cid] @returns {Promise<void>} */
  async leave(msg, cid) {
    if (!cid) {
      const guildId = getMessageGuildId(msg);
      if (guildId) {
        const guildPlayers = this.getGuildPlayers(cleanId(guildId));
        if (guildPlayers.length > 0) {
          const [, firstPlayer] = guildPlayers[0];
          cid = getPlayerChannelId(firstPlayer, guildPlayers[0][0]) || guildPlayers[0][0];
        }
      }
    }

    const cleanChannelId = cleanId(cid);
    const player = cleanChannelId
      ? this.playerMap.get(cleanChannelId) ??
        this.getPlayerByChannelId(cleanChannelId)
      : null;
    if (!player) return msg.reply(this._t(msg, "responses._common.notInVoice"));

    const activeChannelId = getPlayerChannelId(player, cleanChannelId) || cleanChannelId;
    this.playerMap.delete(activeChannelId);
    this._unindexPlayer(player._guildId, activeChannelId);
    const pendingScrobble = this._pendingScrobbleTimers.get(activeChannelId);
    if (pendingScrobble) { clearTimeout(pendingScrobble.timer); this._pendingScrobbleTimers.delete(activeChannelId); }
    if (activeChannelId !== cleanChannelId) this.playerMap.delete(cleanChannelId);
    try {
      await player.leave();
    } catch (e) {
      logger.warn("[PlayerManager] leave() error (non-fatal):", e.message);
    }
    player.destroy();
    await msg.reply(this._t(msg, "responses._common.successfullyLeft"));
  },

  /** @private Restore saved volume for a player from guild settings. @this {import('./PlayerManager.mjs').PlayerManager} @param {Player} player @param {string} guildId */
  _restorePlayerVolume(player, guildId) {
    const savedVol = this.settings?.getServer?.(guildId)?.get?.("volume");
    if (savedVol !== undefined && savedVol !== null) {
      const vol = Number(savedVol);
      if (!isNaN(vol)) player.setVolume(vol / 100);
    }
  },

  /** Create a new Player, join the voice channel, and set up events. The target channel is resolved cache-first with a REST fallback (the channels cache is FIFO-bounded, so a miss does not prove the channel is gone). @async @this {import('./PlayerManager.mjs').PlayerManager} @param {object} message @param {string} cid @returns {Promise<Player|null>} The spawned player, or null on failure. */
  async initPlayer(message, cid) {
    const channel = await resolveChannelCached(this.commands.client, cid);

    if (!channel) {
      message.reply(
          this._t(message, "responses.join.channelNotFound", { channel: cid })
      );
      return null;
    }

    const isVoice = channel.type === 2;

    if (!isVoice) {
      message.reply(this._t(message, "responses._common.voiceChannelRequired"));
      return null;
    }

    if (!botHasVoicePermissions(this.commands?.client, cid)) {
      message.reply(
          this._t(message, "responses.join.joinFailedPerms", { channel: cleanId(cid) })
      );
      return null;
    }

    const cleanChannelId = cleanId(cid);
    const existing = this.playerMap.get(cleanChannelId)
      ?? this.getPlayerByChannelId(cleanChannelId);
    if (existing) {
      if (isPlayerConnectionDead(existing)) {
        logger.voice247(
            `[PlayerManager] Existing player for ${cleanChannelId} has a dead connection — evicting before initPlayer.`
        );
        const remix = this.commands?.client?._remix ?? null;
        detachPlayerFromManager(remix ?? { players: this }, existing, cleanChannelId);
        try { existing.destroy(); } catch (_) {}
      } else {
        existing.textChannel = message.channel?.channel ?? message.channel;
        try {
          const textChannelId = message?.channel?.id ?? message?.channel?.channel?.id ?? null;
          const existingGuildId = getMessageGuildId(message);
          if (existingGuildId && textChannelId) {
            this.settings.getServer(existingGuildId)?.set("announcementChannelId", textChannelId);
          }
        } catch(e) {
          logger.warn("[PlayerManager] Failed to save announcement channel ID:", e?.message);
        }
        message.reply(this._t(message, "responses.join.alreadyJoined", { channel: cid }));
        return existing;
      }
    }
    if (this._pendingJoins.has(cleanChannelId)) {
      message.reply(this._t(message, "responses.join.joining"));
      return null;
    }
    this._pendingJoins.add(cleanChannelId);

    const player = new Player(this.config.token, {
      ...this.playerConfig,
      client:             this.commands.client,
      config:             this.config,
      lavalink:           this.playerConfig?.lavalink ?? null,
      settingsMgr:        this.settings,
      getPrefix:          (guildId) => this.commands.getPrefix(guildId),
      observedVoiceUsers: this.observedVoiceUsers ?? null,
      voiceCache:          this.voiceCache ?? null,
      locale:             this.locale ?? null,
      trackOptions:       this.trackOptions ?? null,
    });

    player.textChannel = message.channel?.channel ?? message.channel;
    try {
      const textChannelId = message?.channel?.id ?? message?.channel?.channel?.id ?? null;
      const newGuildId = getMessageGuildId(message);
      if (newGuildId && textChannelId) {
        this.settings.getServer(newGuildId)?.set("announcementChannelId", textChannelId);
      }
    } catch(e) {
      logger.warn("[PlayerManager] Failed to save announcement channel ID:", e?.message);
    }
    this.setupEvents(player, {
      channelId: cleanChannelId,
      guildId: cleanId(channel.guildId ?? getMessageGuildId(message)),
    });

    player.on("autoleave", () => {
      const activeChannelId = getPlayerChannelId(player, cleanChannelId) || cleanChannelId;
      const homeChannelId = cleanId(player._home247Channel) || activeChannelId;
      const ch       = player.textChannel;
      const guildId = cleanId(player._guildId ?? ch?.guildId ?? ch?.guild?.id ?? getMessageGuildId({ channel: ch }));

      const raw247 = (() => {
        try { return this.settings.getServer(guildId)?.get("stay_247"); } catch (e) { logger.warn("[PlayerManager] Failed to read 24/7 setting:", e?.message); return null; }
      })();
      const isIn247List = (() => {
        if (!raw247 || raw247 === "none") return false;
        const channels = Array.isArray(raw247)
            ? raw247.map(id => cleanId(id)).filter(Boolean)
            : [cleanId(raw247)].filter(Boolean);
        return channels.includes(homeChannelId) || channels.includes(activeChannelId);
      })();

      const matchChannel = isIn247List
          ? (channels247list => channels247list.includes(homeChannelId) ? homeChannelId : activeChannelId)(
              Array.isArray(raw247) ? raw247.map(id => cleanId(id)) : [cleanId(raw247)]
            )
          : null;
      const mode247 = matchChannel
          ? get247ChannelMode(this.settings.getServer(guildId), matchChannel)
          : "off";

      if (mode247 === "on") {
        logger.inactivity(`[PlayerManager] autoleave suppressed for 24/7 channel ${activeChannelId} (guild ${guildId})`);
        return;
      }
      if (player._hasHumansInChannel()) {
        logger.inactivity(`[PlayerManager] autoleave suppressed — humans still in channel ${activeChannelId} (guild ${guildId})`);
        return;
      }
      if (player.queue?.getCurrent() || !player.queue?.isEmpty()) {
        logger.inactivity(`[PlayerManager] autoleave suppressed — queue has songs in channel ${activeChannelId} (guild ${guildId})`);
        return;
      }

      this.playerMap.delete(activeChannelId);
      this._unindexPlayer(player._guildId, activeChannelId);
      const pendingScrobble = this._pendingScrobbleTimers.get(activeChannelId);
      if (pendingScrobble) { clearTimeout(pendingScrobble.timer); this._pendingScrobbleTimers.delete(activeChannelId); }
      if (activeChannelId !== cleanChannelId) this.playerMap.delete(cleanChannelId);
      if (homeChannelId !== activeChannelId) this.playerMap.delete(homeChannelId);
      player.destroy();

      const prefix = this.commands.getPrefix(guildId);

      const desc = this.locale?.translate(guildId, "responses.join.autoLeaveInactive", { channel: activeChannelId, prefix })
          ?? `Left channel <#${activeChannelId}> because of inactivity.\nIf you want me to stay in voice, use \`${prefix}247\``;
      const autoleaveChMgr = this.commands?.client?.channels ?? null;
      let leaveCh = (ch && typeof ch === "object" && typeof ch.send !== "function" && ch.id &&
          autoleaveChMgr && typeof autoleaveChMgr.send === "function")
        ? (() => { const t = { id: ch.id, type: ch.type }; t.send = (o) => autoleaveChMgr.send(ch.id, o); return t; })()
        : ch;
      if (typeof leaveCh?.send === "function") {
        leaveCh.send({ embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(desc)], allowedMentions: { parse: [] } }).catch(err => {
          if (err.code === 'MISSING_PERMISSIONS' || err.statusCode === 403) {
            logger.warn(`[PlayerManager] Cannot send autoleave message in channel ${leaveCh.id} — missing permissions`);
          }
        });
      }
    });

    player.on("message", (m) => {
      const unwrapChannel = (c) =>
        (c && typeof c === "object" && c.channel && typeof c.channel === "object") ? c.channel : c;

      const chMgr = this.commands?.client?.channels ?? null;
      const canPostById = (c) => !!c?.id && !!chMgr && typeof chMgr.send === "function";
      const asSendable = (c) => {
        if (!c || typeof c === "string" || typeof c.send === "function") return c;
        if (!canPostById(c)) return c;
        const target = { id: c.id, type: c.type };
        target.isTextBased = () => true;
        target.send = (options) => chMgr.send(c.id, options);
        return target;
      };

      const isTextChannel = (c) => {
        c = unwrapChannel(c);
        if (!c) return false;
        if (c.type === undefined || c.type === null) return false;
        const voiceTypes = [2, 13, "GUILD_VOICE", "GUILD_STAGE_VOICE", "STAGE", "voice", "stage"];
        if (voiceTypes.includes(c.type)) return canPostById(c);
        if (typeof c.isTextBased === "function") return c.isTextBased();
        const textTypes = [0, 5, 10, 11, 12, "GUILD_TEXT", "GUILD_ANNOUNCEMENT", "text"];
        if (textTypes.includes(c.type)) return true;
        logger.warn(`[PlayerManager] isTextChannel: unknown channel type=${c.type} id=${c.id}, rejecting`);
        return false;
      };

      let ch       = asSendable(unwrapChannel(player.textChannel));
      const guildId = cleanId(player._guildId ?? ch?.guildId ?? ch?.guild?.id ?? getMessageGuildId({ channel: ch }));

      const raw      = this.settings.getServer(guildId)?.get("songAnnouncements");
      const disabled = raw === false || raw === 0 ||
          ["false","0","no","off","disable"].includes(String(raw).toLowerCase().trim());
      if (disabled) return;

      if (!isTextChannel(ch)) {
        try {
          const serverSettings = this.settings.getServer(guildId);
          const savedAnnChId = serverSettings?.get?.("announcementChannelId");
          if (savedAnnChId) {
            const resolved = this.commands?.client?.channels?.get?.(cleanId(savedAnnChId)) ?? null;
            if (isTextChannel(resolved)) ch = asSendable(resolved);
          }
        } catch(e) {
          logger.warn("[PlayerManager] Failed to resolve announcement channel:", e?.message);
        }
      }
      if (!isTextChannel(ch)) {
        try {
          const guild = this.commands?.client?.guilds?.get?.(guildId);
          if (guild?.systemChannelId) {
            const resolved = guild.channels?.get?.(guild.systemChannelId) ?? null;
            if (isTextChannel(resolved)) ch = asSendable(resolved);
          }
        } catch(e) {
          logger.warn("[PlayerManager] Failed to resolve system channel:", e?.message);
        }
      }
      if (!isTextChannel(ch)) {
        try {
          const guild = this.commands?.client?.guilds?.get?.(guildId);
          if (guild?.channels) {
            for (const c of (guild.channels.values?.() ?? [])) {
              if (isTextChannel(c)) {
                ch = asSendable(c);
                break;
              }
            }
          }
        } catch(e) {
          logger.warn("[PlayerManager] Failed to find fallback text channel:", e?.message);
        }
      }
      if (!isTextChannel(ch)) {
        logger.warn(`[PlayerManager] Could not resolve any text channel to send now-playing announcement (guild ${guildId})`);
        return;
      }

      if (!player.textChannel || !isTextChannel(player.textChannel)) player.textChannel = ch;

      const payload = typeof m === "object" && Array.isArray(m.embeds)
        ? { ...m, allowedMentions: { parse: [] } }
        : { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(m)], allowedMentions: { parse: [] } };
      ch = asSendable(ch);
      ch.send(payload).catch(err => {
        if (err.code === 'MISSING_PERMISSIONS' || err.statusCode === 403) {
          logger.warn(`[PlayerManager] Cannot send player message in channel ${ch.id} — missing permissions`);
        } else {
          logger.warn(`[PlayerManager] Failed to send player message in channel ${ch.id}:`, err?.message ?? err);
        }
      });
    });

    const statusMsg = await message.reply(this._t(message, "responses.join.joining"));
    try {
      await player.join(cid);

      this.playerMap.set(cleanChannelId, player);
      this._indexPlayer(channel.guildId ?? getMessageGuildId(message), cleanChannelId);
      this._pendingJoins.delete(cleanChannelId);

      await statusMsg.edit(this._t(message, "responses.join.joined", { channel: cid }));

      const guildId = cleanId(channel.guildId ?? getMessageGuildId(message));
      this._restorePlayerVolume(player, guildId);

      return player;
    } catch (err) {
      this._pendingJoins.delete(cleanChannelId);

      const errCode = sanitizeJoinError(err, this.commands?.client, cleanChannelId);
      let errorMsg;
      if (errCode === "SESSION_RACE") {
        logger.warn(`[PlayerManager] Stale voice session detected for channel ${cleanChannelId}, retrying in 2s...`);
        try {
          await new Promise(r => setTimeout(r, 2_000));
          await player.join(cid);

          this.playerMap.set(cleanChannelId, player);
          this._indexPlayer(channel.guildId ?? getMessageGuildId(message), cleanChannelId);
          await statusMsg.edit(this._t(message, "responses.join.joined", { channel: cid }));

          const retryGuildId = cleanId(channel.guildId ?? getMessageGuildId(message));
          this._restorePlayerVolume(player, retryGuildId);
          return player;
        } catch (retryErr) {
          logger.warn(`[PlayerManager] Retry also failed for channel ${cleanChannelId}: ${retryErr.message}`);
          errorMsg = this._t(message, "responses.join.joinFailedGeneric");
        }
      } else if (errCode === "PERMISSION") {
        errorMsg = this._t(message, "responses.join.joinFailedPerms", { channel: cleanChannelId });
      } else if (errCode === "NOT_FOUND") {
        errorMsg = this._t(message, "responses.join.joinFailedNotFound");
      } else if (errCode === "TIMEOUT") {
        errorMsg = this._t(message, "responses.join.joinFailed");
      } else {
        errorMsg = this._t(message, "responses.join.joinFailed", { error: err.message });
      }
      await statusMsg.edit(errorMsg).catch(() => {});
      this.playerMap.delete(cleanChannelId);
      this._unindexPlayer(channel.guildId ?? getMessageGuildId(message), cleanChannelId);
      player.destroy();
      return null;
    }
  },
};

export default PlayerLifecycleMixin;
export { PlayerLifecycleMixin };
