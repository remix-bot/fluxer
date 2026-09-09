/**
 * @module src/core/BotVoiceMixin
 * @description Channel & voice operations for the {@link Remix} bot class:
 * voice-channel resolution (checkVoiceChannels), 24/7 player spawning with
 * announcements, programmatic channel leave, shared-server listing, and
 * small translation/settings/pagination helpers.
 *
 * These methods are applied onto the Remix class prototype via
 * {@link applyMixins} — `this` is a Remix instance.
 */

import { EmbedBuilder } from "@fluxerjs/core";
import { getVoiceManager } from "@fluxerjs/voice";
import { getGlobalColor, PageBuilder } from "../ui/index.mjs";
import { cleanId } from "../utils/Utils.mjs";
import { remove247ChannelMode, isPlayerConnectionDead, detachPlayerFromManager } from "../utils/Helpers247.mjs";
import { logger } from "./Logger.mjs";
import { Dashboard } from "../dashboard/Dashboard.mjs";

/**
 * @type {object}
 * @description Voice/channel mixin — applied to Remix.
 */
const BotVoiceMixin = {
  /**
   * Resolve the user's voice channel for a command invocation. Tries, in
   * order: the voice-state cache, the VoiceManager, guild voice states, a
   * cache scan, REST member fetch, and a raw REST member lookup.
   * @this {import('./Bot.mjs').Remix}
   * @param {object} message - Message wrapper.
   * @returns {Promise<{channelId: string|null, alreadyInVoice: boolean, hasHumans: boolean}>}
   */
  async _checkVoiceChannelsImpl(message) {
    const userId  = message?.author?.id   ?? message?.message?.author?.id;
    const guildId =
        message?.channel?.guildId ??
        message?.channel?.guild?.id ??
        message?.channel?.server_id ??
        message?.channel?.serverId ??
        message?.message?.guildId ??
        message?.message?.guild?.id ??
        message?.message?.channel?.guildId ??
        message?.message?.channel?.guild?.id ??
        message?.message?.channel?.server_id ??
        message?.message?.channel?.serverId;

    const _empty = { channelId: null, alreadyInVoice: false, hasHumans: false };

    if (!userId || !guildId) {
      logger.voice(`[checkVC] BAIL — missing userId or guildId`);
      return _empty;
    }

    const cleanGuild = cleanId(guildId);

    const makeResult = (channelId) => {
      const cId = cleanId(channelId);
      return {
        channelId: cId,
        alreadyInVoice: this.players.playerMap.has(cId),
        hasHumans: this.voiceCache.hasHumansInChannel(cleanGuild, cId),
      };
    };

    const seedCache = (channelId) => {
      if (!this.voiceCache.hasHumanUser(userId, cleanGuild)) {
        this.voiceCache.updateUser({ guildId: cleanGuild, userId, channelId, isBot: false });
      }
    };

    logger.voice(`[checkVC] userId=${userId} guildId=${guildId} cleanGuild=${cleanGuild}`);

    const observed = this.voiceCache.getUserLocation(cleanGuild, userId);
    if (observed && observed.channelId) {
      logger.voice(`[checkVC] HIT voiceCache → ${observed.channelId}`);
      return makeResult(observed.channelId);
    }

    try {
      const vm = getVoiceManager(this.client);
      const channelId = vm?.getVoiceChannelId?.(guildId, userId) ?? vm?.getVoiceChannelId?.(cleanGuild, userId);
      logger.voice(`[checkVC] vm.getVoiceChannelId → ${channelId}`);
      if (channelId) {
        seedCache(channelId);
        return makeResult(channelId);
      }
    } catch (e) { logger.voice(`[checkVC] vm error: ${e.message}`); }

    try {
      const guild = this.client.guilds.get(guildId) ?? this.client.guilds.get(cleanGuild);
      const voiceStates = guild?.voice_states ?? guild?.voiceStates ?? null;
      if (voiceStates) {
        const entries = Array.isArray(voiceStates)
            ? voiceStates
            : typeof voiceStates.values === "function"
                ? [...voiceStates.values()]
                : Object.values(voiceStates);
        for (const state of entries) {
          const sid = state?.userId ?? state?.user_id ?? state?.id;
          const sch = state?.channelId ?? state?.channel_id;
          if ((sid === userId || sid === cleanId(userId)) && sch) {
            logger.voice(`[checkVC] HIT guild.voice_states → ${sch}`);
            seedCache(sch);
            return makeResult(sch);
          }
        }
      }
    } catch (e) { logger.voice(`[checkVC] guild error: ${e.message}`); }

    try {
      const loc = this.voiceCache.getHumanUser(userId, cleanGuild);
      if (loc && loc.channelId) {
        logger.voice(`[checkVC] HIT voiceCache scan → ${loc.channelId}`);
        return makeResult(loc.channelId);
      }
    } catch (e) { logger.voice(`[checkVC] scan error: ${e.message}`); }

    try {
      const guild = this.client.guilds.get(guildId) ?? this.client.guilds.get(cleanGuild);
      if (guild && typeof guild.fetchMember === "function") {
        logger.voice(`[checkVC] Trying REST fetchMember fallback for user ${userId}`);
        const member = await guild.fetchMember(userId);
        const voiceState = member?.voice ?? member?.voiceState ?? null;
        const restChannelId = voiceState?.channelId ?? voiceState?.channel_id ?? null;
        if (restChannelId) {
          logger.voice(`[checkVC] HIT REST member.voice → ${restChannelId}`);
          seedCache(restChannelId);
          return makeResult(restChannelId);
        }
      }
    } catch (e) { logger.voice(`[checkVC] REST fallback error: ${e.message}`); }

    try {
      const guild = this.client.guilds.get(guildId) ?? this.client.guilds.get(cleanGuild);
      if (guild && typeof this.client.rest?.get === "function") {
        logger.voice(`[checkVC] Trying raw REST /guilds/${cleanGuild}/members/${userId}`);
        const memberData = await this.client.rest.get(`/guilds/${cleanGuild}/members/${userId}`);
        const restChannelId = memberData?.voice_state?.channel_id ?? memberData?.channel_id ?? null;
        if (restChannelId) {
          logger.voice(`[checkVC] HIT raw REST → ${restChannelId}`);
          seedCache(restChannelId);
          return makeResult(restChannelId);
        }
      }
    } catch (e) { logger.voice(`[checkVC] raw REST error: ${e.message}`); }

    logger.voice(`[checkVC] MISS — returning empty`);
    return _empty;
  },

  /**
   * Mark a channel leave as intentional (user-initiated) to prevent the 24/7
   * auto-rejoin system from rejoining.
   * @this {import('./Bot.mjs').Remix}
   * @param {string} channelId - The channel ID.
   * @param {number|null} [ttlMs=null] - TTL in ms (default: config.timers.intentionalLeaveTTL or 10s).
   */
  markIntentionalLeave(channelId, ttlMs = null) {
    const cleanChId = cleanId(channelId);
    if (!cleanChId) return;
    // A user-initiated leave must also cancel any rejoin already armed for
    // this channel — otherwise the bot would come back 3s after !leave.
    this.cancel247Rejoin?.(cleanChId);
    if (ttlMs === null) ttlMs = this.config?.timers?.intentionalLeaveTTL ?? 10_000;
    const existing = this.intentionalLeaves.get(cleanChId);
    if (existing) clearTimeout(existing);
    this.intentionalLeaves.set(cleanChId, setTimeout(() => {
      this.intentionalLeaves.delete(cleanChId);
    }, ttlMs));
  },

  /**
   * Arm a BOT-LEVEL 24/7 rejoin timer for a channel. The timer lives on the
   * Remix context (not on any Player instance), so it survives player
   * destruction — the previous per-player timer was cancelled by the very
   * destroy() that the recovery required. Deduplicates per channel and
   * respects intentional leaves at arm-time and at fire-time.
   * @this {import('./Bot.mjs').Remix}
   * @param {string} channelId - The channel to rejoin.
   * @param {string} guildId - The guild ID (for the rejoin call).
   * @param {number|null} [delayMs=null] - Delay override (default: config.timers.rejoin247Delay or 3s).
   */
  schedule247Rejoin(channelId, guildId, delayMs = null) {
    const cleanCh = cleanId(channelId);
    const cleanG  = cleanId(guildId);
    if (!cleanCh || !cleanG) return;

    if (this.intentionalLeaves.has(cleanCh)) {
      logger.voice247(`[247] Rejoin for ${cleanCh} not armed — intentional leave registered`);
      return;
    }

    if (!this._247RejoinTimers) this._247RejoinTimers = new Map();
    if (this._247RejoinTimers.has(cleanCh)) return; // already armed — keep the earliest

    const delay = delayMs ?? this.config?.timers?.rejoin247Delay ?? 3_000;
    logger.voice247(`[247] Arming bot-level rejoin for ${cleanCh} (guild ${cleanG}) in ${delay / 1000}s`);

    const timer = setTimeout(() => {
      this._247RejoinTimers?.delete(cleanCh);
      if (this.intentionalLeaves.has(cleanCh)) {
        logger.voice247(`[247] Rejoin for ${cleanCh} cancelled — intentional leave registered`);
        return;
      }
      try {
        const p = this.gatewayHandler?._rejoinChannel?.(cleanG, cleanCh);
        if (p && typeof p.catch === "function") {
          p.catch(err => logger.warn(`[247] Rejoin failed for channel ${cleanCh}:`, err?.message ?? err));
        }
      } catch (err) {
        logger.warn(`[247] Rejoin failed for channel ${cleanCh}:`, err?.message ?? err);
      }
    }, delay);

    this._247RejoinTimers.set(cleanCh, timer);
  },

  /**
   * Cancel a pending bot-level 24/7 rejoin timer for a channel.
   * @this {import('./Bot.mjs').Remix}
   * @param {string} channelId - The channel ID.
   */
  cancel247Rejoin(channelId) {
    const cleanCh = cleanId(channelId);
    if (!cleanCh || !this._247RejoinTimers) return;
    const timer = this._247RejoinTimers.get(cleanCh);
    if (timer) {
      clearTimeout(timer);
      this._247RejoinTimers.delete(cleanCh);
      logger.voice247(`[247] Cancelled pending rejoin for ${cleanCh}`);
    }
  },

  /**
   * Spawn a new Player for a channel. Used by 24/7 boot recovery and
   * enable247. Guards against duplicate players, missing channels, and
   * pending joins.
   * @this {import('./Bot.mjs').Remix}
   * @param {string} guildId - The guild ID.
   * @param {string} channelId - The target voice channel ID.
   * @returns {Promise<import('../music/player/Player.mjs').Player>}
   * @throws {Error} If channel not found, not a voice channel, or join fails.
   */
  async _spawnPlayer(guildId, channelId) {
    const cleanGuildId   = cleanId(guildId);
    const cleanChannelId = cleanId(channelId);

    if (!cleanChannelId) throw new Error("_spawnPlayer: invalid channelId");

    const existing = this.players.playerMap.get(cleanChannelId)
        ?? this.players.getPlayerByGuildAndChannel(cleanGuildId, cleanChannelId);
    if (existing) {
      if (!isPlayerConnectionDead(existing)) return existing;
      // A connection-less zombie (e.g. a 24/7 player whose LiveKit session
      // died without a serverLeave reaching us) is worse than useless: it
      // blocks rejoins AND swallows !play. Evict it and spawn a live one.
      logger.voice247(
          `[_spawnPlayer] Existing player for ${cleanChannelId} has a dead connection — evicting and respawning.`
      );
      detachPlayerFromManager(this, existing, cleanChannelId);
      try { existing.destroy(); } catch (_) {}
    }

    if (!this.lavalink) throw new Error("Audio node not ready yet — try again in a moment");

    const channel = this.client?.channels?.get?.(cleanChannelId);
    if (!channel) throw new Error("Channel not found");
    if (channel.type !== 2) throw new Error("Not a voice channel");

    if (this.players._pendingJoins?.has?.(cleanChannelId)) {
      throw new Error("Join already in progress for this channel");
    }

    const Player = (await import("../music/player/index.mjs")).default;

    const player = new Player(this.config.token, {
      client:             this.client,
      config:             this.config,
      lavalink:           this.lavalink ?? null,
      settingsMgr:        this.settingsMgr ?? this.settings ?? null,
      getPrefix:          (guildId) => this.handler.getPrefix(guildId),
      observedVoiceUsers: this.observedVoiceUsers ?? null,
      voiceCache:          this.voiceCache ?? null,
      locale:             this.locale ?? null,
      trackOptions:       this.trackOptions ?? null,
    });

    player._home247Channel = cleanChannelId;

    this.players.setupEvents(player, {
      channelId: cleanChannelId,
      guildId:   cleanGuildId,
    });

    player.on("autoleave", () => {
      const mode = player._get247Mode();
      if (mode === "on") {
        logger.inactivity(`[_spawnPlayer] autoleave suppressed for 24/7 channel ${cleanChannelId} (guild ${cleanGuildId})`);
        return;
      }
      if (player._hasHumansInChannel()) {
        logger.inactivity(`[_spawnPlayer] autoleave suppressed — humans in channel ${cleanChannelId}`);
        return;
      }
      if (player.queue?.getCurrent() || !player.queue?.isEmpty()) {
        logger.inactivity(`[_spawnPlayer] autoleave suppressed — queue has songs in channel ${cleanChannelId}`);
        return;
      }

      const activeChId = cleanId(player._channelId ?? cleanChannelId) || cleanChannelId;
      const homeChId   = cleanId(player._home247Channel ?? activeChId) || activeChId;
      this.players.playerMap.delete(activeChId);
      this.players._unindexPlayer?.(cleanGuildId, activeChId);
      const pendingScrobble = this.players._pendingScrobbleTimers?.get(cleanChannelId);
      if (pendingScrobble) { clearTimeout(pendingScrobble.timer); this.players._pendingScrobbleTimers.delete(cleanChannelId); }
      if (activeChId !== cleanChannelId) this.players.playerMap.delete(cleanChannelId);
      if (homeChId !== activeChId) this.players.playerMap.delete(homeChId);
      player.destroy();
    });

    player.on("message", async (m) => {
      try {
        const serverSettings = this.settingsMgr?.getServer?.(cleanGuildId);
        const raw = serverSettings?.get?.("songAnnouncements");
        const disabled = raw === false || raw === 0 ||
            ["false","0","no","off","disable"].includes(String(raw).toLowerCase().trim());
        if (disabled) return;

        const chMgr = this.client?.channels ?? null;
        const canPostById = (c) => !!c?.id && !!chMgr && typeof chMgr.send === "function";
        const asSendable = (c) => {
          if (!c || typeof c === "string" || typeof c.send === "function") return c;
          if (!canPostById(c)) return c;
          const target = { id: c.id, type: c.type };
          target.isTextBased = () => true;
          target.send = (options) => chMgr.send(c.id, options);
          return target;
        };
        const usable = (c) => !!c && typeof c === "object" &&
            (typeof c.send === "function" || canPostById(c));

        const _tc = player.textChannel;
        let ch = (_tc && typeof _tc === "object" && _tc.channel && typeof _tc.channel === "object")
          ? _tc.channel
          : _tc;
        if (!usable(ch)) {
          const savedAnnChId = serverSettings?.get?.("announcementChannelId");
          if (savedAnnChId) {
            ch = this.client?.channels?.get?.(cleanId(savedAnnChId)) ?? null;
          }
        }
        if (!usable(ch)) {
          const guild = this.client?.guilds?.get?.(cleanGuildId);
          if (guild?.systemChannelId) {
            ch = guild.channels?.get?.(guild.systemChannelId) ?? null;
          }
        }
        if (!usable(ch)) {
          const guild = this.client?.guilds?.get?.(cleanGuildId);
          if (guild?.channels) {
            for (const c of (guild.channels.values?.() ?? [])) {
              if (c.isTextBased?.() || c.type === 0 || c.type === "GUILD_TEXT") {
                ch = c;
                break;
              }
            }
          }
        }
        if (!usable(ch)) return;

        ch = asSendable(ch);
        if (!player.textChannel) player.textChannel = ch;

        const payload = typeof m === "object" && Array.isArray(m.embeds)
          ? { ...m, allowedMentions: { parse: [] } }
          : { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(m)], allowedMentions: { parse: [] } };
        ch.send(payload).catch(err => {
          if (err.code === 'MISSING_PERMISSIONS' || err.statusCode === 403) {
            logger.warn(`[_spawnPlayer] Cannot send announcement in channel ${ch.id} — missing permissions`);
          } else {
            logger.warn(`[_spawnPlayer] Failed to send announcement in channel ${ch.id}:`, err?.message ?? err);
          }
        });
      } catch(e) {
        logger.warn("[Player] Song announcement error:", e?.message);
      }
    });

    if (this.players._pendingJoins) {
      this.players._pendingJoins.add(cleanChannelId);
    }

    try {
      await player.join(cleanChannelId);

      this.players.playerMap.set(cleanChannelId, player);
      this.players._indexPlayer(cleanGuildId, cleanChannelId);
      if (this.players._pendingJoins) {
        this.players._pendingJoins.delete(cleanChannelId);
      }

      const savedVol = this.settingsMgr?.getServer?.(cleanGuildId)?.get?.("volume");
      if (savedVol !== undefined && savedVol !== null) {
        const vol = Number(savedVol);
        if (!isNaN(vol)) player.setVolume(vol / 100);
      }

      logger.player(`[_spawnPlayer] Spawned player for channel ${cleanChannelId} in guild ${cleanGuildId}`);
      return player;
    } catch (err) {
      if (this.players._pendingJoins) {
        this.players._pendingJoins.delete(cleanChannelId);
      }
      this.players.playerMap.delete(cleanChannelId);
      try { player.destroy(); } catch(e) { logger.warn("[_spawnPlayer] Cleanup destroy error:", e?.message); }
      logger.warn(`[_spawnPlayer] Failed to spawn player for channel ${cleanChannelId}:`, err.message);
      throw err;
    }
  },

  /**
   * Leave a voice channel programmatically. Removes 24/7 if active, destroys
   * the player, and optionally sends a confirmation message.
   * @this {import('./Bot.mjs').Remix}
   * @param {string} channelId - The channel ID to leave.
   * @param {string} guildId - The guild ID.
   * @param {object} [message=null] - Optional message for reply confirmation.
   * @param {boolean} [force=false] - Whether to force-leave regardless of 24/7 status.
   * @returns {Promise<boolean>} True on success.
   */
  async leaveChannel(channelId, guildId, message, force = false) {
    const cleanChId = cleanId(channelId);
    const cleanGuildId = cleanId(guildId);
    const set     = this.settingsMgr.getServer(cleanGuildId);
    const raw     = set?.get("stay_247");

    const channels = (!raw || raw === "none")
        ? new Set()
        : Array.isArray(raw)
            ? new Set(raw.map(id => cleanId(id)).filter(Boolean))
            : new Set([cleanId(raw)]);

    if (channels.has(cleanChId)) {
      channels.delete(cleanChId);
      set.set("stay_247", channels.size > 0 ? [...channels] : "none");
      remove247ChannelMode(set, cleanChId, channels);
    }

    this.markIntentionalLeave(cleanChId);

    const player = this.players.playerMap.get(cleanChId);
    if (player) {
      this.players.playerMap.delete(cleanChId);
      this.players._unindexPlayer(player._guildId, cleanChId);
      const pendingScrobble = this.players._pendingScrobbleTimers?.get(cleanChId);
      if (pendingScrobble) { clearTimeout(pendingScrobble.timer); this.players._pendingScrobbleTimers.delete(cleanChId); }
      await player.leave().catch(() => {});
      player.destroy();
    }

    if (message) {
      const guildIdForLocale = message?.channel?.channel?.guildId ?? message?.guildId ?? cleanGuildId;
      message.replyEmbed(this.locale.translate(guildIdForLocale, "responses._common.successfullyLeft"));
    }

    return true;
  },

  /**
   * Get the server settings for the guild associated with a message.
   * @this {import('./Bot.mjs').Remix}
   * @param {object} message - The incoming message wrapper.
   * @returns {object} The ServerSettings for the guild, or a fallback.
   */
  getSettings(message) {
    const guildId = message?.channel?.channel?.guildId ?? message?.guildId ?? null;
    return this.settingsMgr.getServer(guildId);
  },

  /**
   * Shorthand to translate a locale key for the guild of a given message.
   * @this {import('./Bot.mjs').Remix}
   * @param {object} message - The message wrapper (used to resolve guild ID).
   * @param {string} key - The locale key.
   * @param {object} [data={}] - Interpolation data.
   * @returns {string} The localised string.
   */
  t(message, key, data = {}) {
    const guildId = message?.channel?.channel?.guildId
        ?? message?.message?.guildId
        ?? message?.guildId
        ?? null;
    return this.locale.translate(guildId, key, data);
  },

  /**
   * Get or create a player for the given message context.
   * @this {import('./Bot.mjs').Remix}
   * @param {object} message - The message wrapper.
   * @param {boolean} promptJoin - Whether to prompt the user to join a voice channel.
   * @param {boolean} verifyUser - Whether to verify the user is in a voice channel.
   * @param {boolean} shouldJoin - Whether to auto-join the voice channel.
   * @returns {Promise<object>} The Player instance.
   */
  getPlayer(message, promptJoin, verifyUser, shouldJoin) {
    return this.players.getPlayer(message, promptJoin, verifyUser, shouldJoin);
  },

  /**
   * Get all servers the bot and the given user share (i.e. the user is a
   * member). Used by the dashboard to determine which servers a user can
   * manage.
   * @this {import('./Bot.mjs').Remix}
   * @param {object} user - The Fluxer user.
   * @returns {Promise<Array<object>>} Array of server summaries with channels.
   */
  async getSharedServers(user) {
    if (!user) return [];

    const shared = [];

    for (const guild of this.client.guilds?.values?.() ?? []) {
      let isMember = false;

      if (guild.members?.has?.(user.id)) {
        isMember = true;
      }

      if (!isMember) {
        const cleanGuildId = cleanId(guild.id);
        const userLoc = this.voiceCache.getUserLocation(cleanGuildId, user.id);
        if (userLoc) isMember = true;
      }

      if (!isMember) {
        try {
          const member = await guild.members.fetch(user.id).catch(() => null);
          if (member) isMember = true;
        } catch (e) { logger.warn(`[getSharedServers] Member fetch error for ${user.id}:`, e?.message); }
      }

      if (!isMember) continue;

      const guildChannels = guild.channels
        ? [...guild.channels.values()]
        : [];
      const allChannels = guildChannels
        .map(c => Dashboard.convertChannel(c))
        .filter(c => !c.isCategory);
      const channelIds = guildChannels.map(c => c.id);

      shared.push({
        name:   guild.name,
        id:     guild.id,
        icon:   guild.icon
            ? `https://cdn.fluxer.app/icons/${guild.id}/${guild.icon}.webp`
            : null,
        description: guild.description ?? null,
        ownerId: guild.ownerId ?? null,
        channels: allChannels,
        channelIds: channelIds,
        voiceChannels: allChannels.filter(c => c.isVoice),
      });
    }

    return shared;
  },

  /**
   * Create and attach a paginated message to the given message.
   * @this {import('./Bot.mjs').Remix}
   * @param {string} form - The form/locale key for the page title.
   * @param {string} content - The full content to paginate.
   * @param {object} msg - The message wrapper.
   * @param {number} linesPerPage - Maximum lines per page.
   */
  pagination(form, content, msg, linesPerPage) {
    this.messages.initPagination(
        new PageBuilder(content).setForm(form).setMaxLines(linesPerPage),
        msg
    );
  },
};

export default BotVoiceMixin;
export { BotVoiceMixin };
