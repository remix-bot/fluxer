/**
 * PlayerManager.mjs — Manages voice channel players across servers
 *
 * Updated for moonlink.js: passes the MoonlinkManager instance into every
 * new Player so it can resolve tracks and retrieve session IDs.
 */

import Player from "./Player.mjs";
import { CommandHandler } from "./CommandHandler.mjs";
import { Message } from "./MessageHandler.mjs";
import { SettingsManager } from "./Settings.mjs";
import { Utils } from "./Utils.mjs";
import { logger } from "./constants/Logger.mjs";
import { get247ChannelMode } from "./constants/Helpers247.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getVoiceManager } from "@fluxerjs/voice";
import { getGlobalColor } from "./MessageHandler.mjs";
import { Dashboard } from "./dashboard/Dashboard.mjs";

/** Helper — build a plain embed payload from a description string */
function mkEmbed(desc) {
  return { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(desc)] };
}

function cleanId(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function getMessageGuildId(message) {
  return message?.channel?.guildId ??
    message?.channel?.guild?.id ??
    message?.message?.guildId ??
    message?.message?.guild?.id ??
    message?.channel?.server_id ??
    message?.channel?.serverId ??
    message?.message?.server_id ??
    message?.message?.serverId ??
    null;
}

function getPlayerGuildId(player, fallbackChannel = null) {
  return cleanId(
    player?._guildId ??
    fallbackChannel?.guildId ??
    fallbackChannel?.guild?.id ??
    fallbackChannel?.server_id ??
    fallbackChannel?.serverId
  );
}

function getPlayerChannelId(player, fallbackChannelId = null) {
  return cleanId(player?._channelId ?? player?._home247Channel ?? fallbackChannelId);
}

/**
 * Sanitize raw voice-join error messages into user-friendly text.
 * Raw errors like "401 Unauthorized - no permissions to access the room"
 * are confusing to users — map them to clear, translatable messages.
 */
function sanitizeJoinError(err) {
  const msg = String(err?.message ?? err ?? "");
  if (msg.includes("401") || msg.includes("Unauthorized")) {
    return "PERMISSION";
  }
  if (msg.includes("permission") || msg.includes("Permission")) {
    return "PERMISSION";
  }
  if (msg.includes("not found") || msg.includes("Unknown channel")) {
    return "NOT_FOUND";
  }
  if (msg.includes("timeout") || msg.includes("timed out")) {
    return "TIMEOUT";
  }
  return null; // unknown — fall back to raw message
}

export class PlayerManager {
  /** @type {SettingsManager} */
  settings;

  /** @type {CommandHandler} */
  commands;

  /** @type {Map<string, Player>} */
  playerMap = new Map();

  /** @type {Set<string>} Channel IDs currently being joined (not yet in playerMap) */
  _pendingJoins = new Set();

  /** @type {Map<string, {timer, songUrl, startedAtMs}>} Pending scrobble timers keyed by channel ID.
   *  Prevents duplicate scrobbles when startplay fires multiple times. */
  _pendingScrobbleTimers = new Map();

  /** @type {Object} */
  config;

  /** @type {Object} */
  playerConfig;

  /** @type {import("./constants/Locale.mjs").Locale|null} */
  locale = null;

  /** @type {import("./dashboard/Dashboard.mjs").Dashboard|null} */
  dashboard = null;

  /**
   * @param {SettingsManager} settings
   * @param {CommandHandler} commands
   * @param {Object} config
   * @param {Object} config.config  - Parsed config.json
   * @param {Object} config.player  - Config data passed to new Player instances
   */
  constructor(settings, commands, config) {
    this.commands     = commands;
    this.settings     = settings;
    this.config       = config.config;
    this.playerConfig = config.player;
    this.dashboard    = config.dashboard ?? null;
    this.locale       = config.locale ?? null;
    this.timers       = config.timers ?? {};
    this._lastfm      = null;   // Set later by Remix class after init
  }

  /**
   * Forward player lifecycle/state events to the dashboard pub/sub channels.
   *
   * IMPORTANT: Events are sent in standard { type, data } format so
   * the backend (backend-master) PlayerManager can parse them correctly.
   *
   * Two channels are used:
   *   {platform}:players         — global, for init/close lifecycle events
   *   {platform}:player_{id}     — per-player, for playback/queue/volume events
   *
   * @param {Player} player
   * @param {Object} [context]
   * @param {string|null} [context.channelId]
   * @param {string|null} [context.guildId]
   * @returns {Player}
   */
  setupEvents(player, context = {}) {
    if (!player || player._dashboardEventsBound) return player;

    Object.defineProperty(player, "_dashboardEventsBound", {
      value: true,
      configurable: true,
      enumerable: false,
      writable: true,
    });

    // ── Per-player channel: standard { type, data } format ────────
    // The backend PlayerManager.setupEvents() expects:
    //   { type: "startplay",  data: serialisedVideo }
    //   { type: "stopplay",   data: null }
    //   { type: "pause",      data: { elapsedTime: ms } }
    //   { type: "resume",     data: { elapsedTime: ms } }
    //   { type: "volume",     data: number }
    //   { type: "queue",      data: serialisedQueueEvent }
    //   { type: "join",       data: userId }
    //   { type: "leave",      data: userId }

    const emit = (type, data) => {
      if (!this.dashboard?.enabled) return;
      this.dashboard.updatePlayer({ type, data }, player);
    };

    // ── Global channel: lifecycle events ──────────────────────────────────
    // The backend PlayerManager.initChannels() expects:
    //   { type: "init",  player: serialisedPlayer }  — when player connects
    //   { type: "close", player: serialisedPlayer }  — when player disconnects

    const emitGlobal = (type) => {
      if (!this.dashboard?.enabled) return;
      this.dashboard.playerUpdate({ type }, player);
    };

    // Broadcast user list changes to the global :users channel when
    // someone joins or leaves the player's voice channel.
    const sendUserUpdates = (eventType) => {
      if (!this.dashboard?.enabled) return;
      const channelId = getPlayerChannelId(player, context.channelId);
      const channel = player.client?.channels?.get(channelId);
      const guild = player.client?.guilds?.get(cleanId(player._guildId ?? context.guildId));
      if (!guild) return;
      const voiceStates = guild.voice_states ?? guild.voiceStates ?? null;
      if (!voiceStates) return;
      const entries = Array.isArray(voiceStates)
        ? voiceStates
        : typeof voiceStates.values === "function"
          ? [...voiceStates.values()]
          : Object.values(voiceStates);
      for (const state of entries) {
        if (!state?.channelId && !state?.channel_id) continue;
        const stateChannelId = cleanId(state.channelId ?? state.channel_id);
        if (stateChannelId !== channelId) continue;
        const member = guild.members?.get?.(state.userId ?? state.user_id);
        if (!member?.user || member.user?.bot) continue;
        // Send per-player channel "join"/"leave" event with just the user ID
        // (matching standard format where data = userId string)
        emit(eventType, member.user.id);
        // Also send global user update
        this.dashboard.userUpdate({
          type: eventType,
          guildId: cleanId(player._guildId ?? context.guildId),
          channelId,
        }, member.user);
      }
    };

    // ── Player event handlers ─────────────────────────────────────────────

    player.on("roomfetched", () => {
      // Player connected — send "init" on the global channel
      emitGlobal("init");
      sendUserUpdates("join");
    });

    player.on("startplay", (song) => {
      // Send the serialised video to the per-player channel
      emit("startplay", Dashboard.convertVideo(song ?? player.queue?.current));
      // Emit streamStartPlay with current timestamp so the backend can
      // calculate elapsed time accurately (standard behaviour)
      emit("streamStartPlay", Date.now());
      // Also broadcast on global channel for full state update
      this.dashboard.playerUpdate({ type: "startplay" }, player);

      // ── Last.fm: now-playing notification + deferred scrobble ────────────
      if (this._lastfm?.enabled && song) {
        this._handleLastFmStartPlay(player, song);
      }
    });

    player.on("stopplay", () => {
      emit("stopplay", null);
      this.dashboard.playerUpdate({ type: "stopplay" }, player);
    });

    player.on("playback", (playing) => {
      // Sends "pause" or "resume" with { elapsedTime } — match that format
      const elapsedMs = player._pausedAt
          ? (player._pausedAt.getTime?.() ?? Number(player._pausedAt)) -
            (player.startedPlaying?.getTime?.() ?? Number(player.startedPlaying ?? 0))
          : Date.now() - (player.startedPlaying?.getTime?.() ?? Number(player.startedPlaying ?? 0));
      const type = playing ? "resume" : "pause";
      emit(type, { elapsedTime: Math.max(0, elapsedMs) });
      this.dashboard.playerUpdate({ type }, player);
    });

    player.on("volume", (volume) => {
      emit("volume", volume);
      this.dashboard.playerUpdate({ type: "volume" }, player);
    });

    player.on("filter", (filter) => {
      // Filter events are Fluxer-specific.
      // Send as a custom event type; the backend will ignore unknown types.
      emit("filter", filter);
    });

    player.on("update", (scope) => {
      // Generic update — send full player state on global channel
      this.dashboard.playerUpdate({ type: "update" }, player);
    });

    player.on("message", (message) => {
      // No per-player equivalent — skip, only global broadcast
    });

    player.on("autoleave", () => {
      sendUserUpdates("leave");
      // Send "close" on global channel so backend removes the player
      emitGlobal("close");
      emit("stopplay", null);
    });

    player.on("leave", () => {
      sendUserUpdates("leave");
      // Send "close" on global channel so backend removes the player
      emitGlobal("close");
      emit("stopplay", null);
    });

    // ── Queue event handler ───────────────────────────────────────────────
    // Queue events must be serialised with Dashboard.convertVideo() to match
    // the format the backend Queue.update() method expects.

    player.queue?.on("queue", (queueEvent) => {
      const serialised = { type: queueEvent.type };
      switch (queueEvent.type) {
        case "add":
          serialised.data = {
            append: queueEvent.data?.append,
            data: Dashboard.convertVideo(queueEvent.data?.data),
          };
          break;
        case "addMany":
          serialised.data = {
            append: queueEvent.data?.append,
            tracks: (queueEvent.data?.tracks ?? []).map(v => Dashboard.convertVideo(v)),
          };
          break;
        case "remove":
          serialised.data = {
            index: queueEvent.data?.index,
            removed: Dashboard.convertVideo(queueEvent.data?.removed),
            old: (queueEvent.data?.old ?? []).map(v => Dashboard.convertVideo(v)),
            new: (queueEvent.data?.new ?? []).map(v => Dashboard.convertVideo(v)),
          };
          break;
        case "move":
          serialised.data = {
            from: queueEvent.data?.from,
            to: queueEvent.data?.to,
            track: Dashboard.convertVideo(queueEvent.data?.track),
          };
          break;
        case "shuffle":
          serialised.data = (queueEvent.data ?? []).map(v => Dashboard.convertVideo(v));
          break;
        case "update":
          serialised.data = {
            current: Dashboard.convertVideo(queueEvent.data?.current),
            old: Dashboard.convertVideo(queueEvent.data?.old),
            loop: queueEvent.data?.loop,
          };
          break;
        default:
          // Unknown queue event — pass through as-is
          serialised.data = queueEvent.data;
          break;
      }

      emit("queue", serialised);
      this.dashboard.playerUpdate({ type: "queue" }, player);
    });

    return player;
  }

  /**
   * Translate a locale key using the message's guild locale.
   * @param {Object} message
   * @param {string} key
   * @param {Object} [replacements={}]
   * @returns {string}
   */
  _t(message, key, replacements = {}) {
    if (!this.locale) return key;
    const guildId = getMessageGuildId(message);
    return this.locale.translate(guildId, key, replacements);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Voice Channel Detection
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Attempt to detect the voice channel a user is currently in.
   * @param {Message} message
   * @returns {string|null} Voice channel ID or null
   */
  checkVoiceChannels(message) {
    if (!message) return null;

    const userId = message.author?.id ?? message.message?.author?.id;
    const guildId = getMessageGuildId(message);

    if (!userId) return null;
    if (!guildId) return null;

    const cleanGuild = cleanId(guildId);
    const seedObserved = (channelId) => {
      const cleanChannelId = cleanId(channelId);
      if (!cleanChannelId) return null;
      if (!this.observedVoiceUsers?.has(userId)) {
        this.observedVoiceUsers?.set(userId, { channelId: cleanChannelId, guildId: cleanGuild });
      }
      return cleanId(this.observedVoiceUsers?.get(userId)?.channelId) || cleanChannelId;
    };

    const observed = this.observedVoiceUsers?.get?.(userId);
    if (cleanId(observed?.guildId) === cleanGuild) {
      const observedChannelId = cleanId(observed?.channelId);
      if (observedChannelId) return observedChannelId;
    }

    try {
      const vm = getVoiceManager(this.commands.client);
      const voiceChannelId = vm?.getVoiceChannelId?.(guildId, userId);
      const seeded = seedObserved(voiceChannelId);
      if (seeded) return seeded;
    } catch (_) {}

    // ── Fallback: VoiceManager.voiceStates direct lookup ────────────────
    // After a reboot, getVoiceChannelId() may return null if the
    // VoiceManager hasn't synced yet, but voiceStates (populated from
    // READY / GUILD_CREATE raw gateway events) may already have the data.
    try {
      const vm = getVoiceManager(this.commands.client);
      if (vm?.voiceStates) {
        const guildVoiceMap = vm.voiceStates.get(cleanGuild) ?? vm.voiceStates.get(guildId);
        if (guildVoiceMap && typeof guildVoiceMap.get === "function") {
          const vmChannelId = guildVoiceMap.get(userId);
          const seeded = seedObserved(vmChannelId);
          if (seeded) return seeded;
        }
      }
    } catch (_) {}

    const memberVoiceChannelId =
      message?.member?.voice?.channelId ??
      message?.message?.member?.voice?.channelId ??
      null;
    {
      const seeded = seedObserved(memberVoiceChannelId);
      if (seeded) return seeded;
    }

    try {
      const guild =
        this.commands.client?.guilds?.get?.(guildId) ??
        this.commands.client?.guilds?.get?.(cleanGuild);
      const voiceStates = guild?.voice_states ?? guild?.voiceStates ?? null;
      if (voiceStates) {
        if (!Array.isArray(voiceStates) && typeof voiceStates === "object") {
          const direct = voiceStates[userId];
          const directChannelId =
            typeof direct === "string"
              ? direct
              : direct?.channelId ?? direct?.channel_id ?? null;
          const seeded = seedObserved(directChannelId);
          if (seeded) return seeded;
        }

        const entries = Array.isArray(voiceStates)
          ? voiceStates
          : typeof voiceStates.values === "function"
            ? voiceStates.values()
            : Object.values(voiceStates);

        for (const state of entries) {
          const stateUserId = state?.userId ?? state?.user_id ?? state?.id;
          const stateGuildId = cleanId(state?.guildId ?? state?.guild_id ?? guildId);
          if (stateUserId !== userId || stateGuildId !== cleanGuild) continue;
          const seeded = seedObserved(state?.channelId ?? state?.channel_id);
          if (seeded) return seeded;
        }
      }
    } catch (_) {}

    // ── Fallback: match user to any active player in the guild ──────────
    // After a reboot with 24/7, voice states may not be fully populated.
    // If the guild has active players, check if any of them have the user
    // as a remote participant in their LiveKit room.
    const liveGuildPlayers = [...this.playerMap.entries()].filter(([channelId, player]) => {
      const fallbackChannel =
        this.commands.client?.channels?.get?.(channelId) ??
        null;
      return getPlayerGuildId(player, fallbackChannel) === cleanGuild && !player?._destroyed;
    });
    if (liveGuildPlayers.length === 1) {
      return getPlayerChannelId(liveGuildPlayers[0][1], liveGuildPlayers[0][0]) || cleanId(liveGuildPlayers[0][0]);
    }
    // Multiple players — try LiveKit remote participants to find which
    // channel the user is actually in.
    if (liveGuildPlayers.length > 1) {
      for (const [mapKey, player] of liveGuildPlayers) {
        try {
          const room = player?.connection?.room;
          if (!room?.isConnected || !room.remoteParticipants) continue;
          for (const [, participant] of room.remoteParticipants) {
            const pId = participant?.identity ?? participant?.sid;
            if (pId === userId) {
              const found = getPlayerChannelId(player, mapKey) || cleanId(mapKey);
              seedObserved(found);
              return found;
            }
          }
        } catch (_) {}
      }
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Player Retrieval
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get or create a player for the user's voice channel.
   * @param {Message} message
   * @param {boolean} [promptJoin=true]
   * @param {boolean} [verifyUser=true]
   * @param {boolean} [shouldJoin=false]
   * @returns {Promise<Player|null>}
   */
  async getPlayer(message, promptJoin = true, verifyUser = true, shouldJoin = false) {
    const guildId = getMessageGuildId(message);
    const cleanGuildId = cleanId(guildId);

    const userChannelId = this.checkVoiceChannels(message);
    const cleanUserChannelId = cleanId(userChannelId);

    if (cleanUserChannelId) {
      const player = this.playerMap.get(cleanUserChannelId)
          ?? [...this.playerMap.values()].find(p =>
            getPlayerChannelId(p) === cleanUserChannelId
          );
      if (player) {
        player.textChannel = message.channel;
        try {
          const guildId = getMessageGuildId(message);
          const textChannelId = message?.channel?.id ?? message?.channel?.channel?.id ?? null;
          if (guildId && textChannelId) {
            this.settings.getServer(guildId)?.set("announcementChannelId", textChannelId);
          }
        } catch (_) {}
        return player;
      }
      // Also check if a join is in-progress for this channel
      if (this._pendingJoins.has(cleanUserChannelId)) {
        return null; // A player is being created — caller should retry
      }
    }

    const serverPlayers = cleanGuildId
        ? [...this.playerMap.entries()].filter(([, player]) => {
          return getPlayerGuildId(player) === cleanGuildId;
        })
        : [];

    if (serverPlayers.length > 0) {
      const channelList = serverPlayers.map(([chId]) => `<#${chId}>`).join(" or ");

      if (!userChannelId) {
        // verifyUser=false: allow controlling the bot without being in voice
        // (e.g. volume, clear, remove — admin-style controls).
        if (!verifyUser) {
          const first = serverPlayers[0];
          first[1].textChannel = message.channel;
          return first[1];
        }
        message.reply(mkEmbed(this._t(message, "responses._common.noVoiceStrict")));
        return null;
      }

      const match = serverPlayers.find(([, player]) =>
        String(player?._channelId ?? "").replace(/\D/g, "") === cleanUserChannelId
      );
      if (match) {
        match[1].textChannel = message.channel;
        try {
          const textChannelId = message?.channel?.id ?? message?.channel?.channel?.id ?? null;
          if (cleanGuildId && textChannelId) {
            this.settings.getServer(cleanGuildId)?.set("announcementChannelId", textChannelId);
          }
        } catch (_) {}
        return match[1];
      }

      // User is in a different channel than existing players.
      if (shouldJoin) {
        return new Promise((resolve) => {
          this.initPlayer(message, userChannelId, (p) => resolve(p));
        });
      }

      const prefix = (() => {
        try {
          return this.settings.getServer(guildId)?.get("prefix") ?? "%";
        } catch (_) { return "%"; }
      })();
      message.reply(mkEmbed(this._t(message, "responses._common.alreadyInChannel", { channels: channelList, prefix })));
      return null;
    }

    if (!userChannelId) {
      if (shouldJoin) {
        // Auto-detect failed — fall back to interactive channel selection prompt
        return this.promptVC(message);
      }
      message.reply(mkEmbed(this._t(message, "responses._common.noVoiceChannel")));
      return null;
    }

    if (shouldJoin) {
      return new Promise((resolve) => {
        this.initPlayer(message, userChannelId, (p) => resolve(p));
      });
    }

    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Channel Selection Prompt
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Prompt the user to select a voice channel.
   * @param {Message} msg
   * @returns {Promise<string|false>}
   */
  async promptVC(msg) {
    const autoDetected = this.checkVoiceChannels(msg);
    if (autoDetected) {
      return new Promise(resolve => this.initPlayer(msg, autoDetected, (p) => resolve(p)));
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
    const selectionMsg = await msg.reply(mkEmbed(
        (channelSelection ? channelSelection + "\n**..or** " + hint : "Please " + hint)
    ));

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
        msg.reply(mkEmbed(this._t(msg, "responses._common.voiceSelectionTimedOut")));
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
              this.initPlayer(msg, cid, (p) => resolve(p));
            },
            promptUser
        );
      }

      unsubscribeMessages = msg.channel.onMessageUser((m) => {
        const content = m.content?.toLowerCase() ?? "";
        if (content === "x") {
          clearTimeout(timeout);
          cleanup();
          m.reply(mkEmbed(this._t(m, "voice.join.cancelled")));
          resolve(false);
          return;
        }
        if (!this.commands.validateInput("voiceChannel", m.content, m)) {
          m.reply(mkEmbed(this._t(m, "responses._common.voiceSelectionInvalid")));
          return;
        }
        const channel = this.commands.formatInput("voiceChannel", m.content, m);
        clearTimeout(timeout);
        cleanup();
        this.initPlayer(m, channel, (p) => resolve(p));
      }, promptUser);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Leave
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Make the player leave its current voice channel.
   * @param {Message} msg
   * @param {string} [cid]
   */
  async leave(msg, cid) {
    if (!cid) {
      const guildId = getMessageGuildId(msg);
      if (guildId) {
        const matchedEntry = [...this.playerMap.entries()].find(([, player]) =>
          getPlayerGuildId(player) === cleanId(guildId)
        );
        cid = getPlayerChannelId(matchedEntry?.[1], matchedEntry?.[0]) || matchedEntry?.[0] || null;
      }
    }

    const cleanChannelId = cleanId(cid);
    const player = cleanChannelId
      ? this.playerMap.get(cleanChannelId) ??
        [...this.playerMap.values()].find((entry) => getPlayerChannelId(entry) === cleanChannelId)
      : null;
    if (!player) return msg.reply(mkEmbed(this._t(msg, "responses._common.notInVoice")));

    const activeChannelId = getPlayerChannelId(player, cleanChannelId) || cleanChannelId;
    this.playerMap.delete(activeChannelId);
    // Clean up pending scrobble timer
    const pendingScrobble = this._pendingScrobbleTimers.get(activeChannelId);
    if (pendingScrobble) { clearTimeout(pendingScrobble.timer); this._pendingScrobbleTimers.delete(activeChannelId); }
    if (activeChannelId !== cleanChannelId) this.playerMap.delete(cleanChannelId);
    await msg.reply(mkEmbed(this._t(msg, "responses._common.successfullyLeft")));
    await player.leave();
    player.destroy();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Player Initialisation
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Create and register a new Player for the given voice channel.
   * @param {Message} message
   * @param {string} cid - Voice channel ID
   * @param {Function} [cb]
   */
  initPlayer(message, cid, cb = () => {}) {
    const channel = this.commands.client?.channels?.get(cid);

    if (!channel) {
      return message.reply(mkEmbed(
          this._t(message, "responses.join.channelNotFound", { channel: cid })
      ));
    }

    const isVoice = channel.type === 2;

    if (!isVoice) {
      return message.reply(mkEmbed(this._t(message, "responses._common.voiceChannelRequired")));
    }

    const cleanChannelId = cleanId(cid);
    const existing = this.playerMap.get(cleanChannelId)
      ?? [...this.playerMap.values()].find((entry) => getPlayerChannelId(entry) === cleanChannelId);
    if (existing) {
      existing.textChannel = message.channel;
      cb(existing);
      return message.reply(mkEmbed(this._t(message, "responses.join.alreadyJoined", { channel: cid })));
    }
    // Also block if a join is already in-progress for this channel
    if (this._pendingJoins.has(cleanChannelId)) {
      return message.reply(mkEmbed(this._t(message, "responses.join.joining")));
    }

    const player = new Player(this.config.token, {
      ...this.playerConfig,
      client:             this.commands.client,
      config:             this.config,
      nodelink:           this.config.nodelink,
      moonlink:           this.playerConfig?.moonlink ?? null,
      revoice:            this.playerConfig?.revoice ?? null,
      settingsMgr:        this.settings,
      observedVoiceUsers: this.observedVoiceUsers ?? null,
      locale:             this.locale ?? null,
    });

    player.textChannel = message.channel;
    this.setupEvents(player, {
      channelId: cleanChannelId,
      guildId: cleanId(channel.guildId ?? getMessageGuildId(message)),
    });

    player.on("autoleave", () => {
      const activeChannelId = getPlayerChannelId(player, cleanChannelId) || cleanChannelId;
      const homeChannelId = cleanId(player._home247Channel) || activeChannelId;
      const ch       = player.textChannel;
      const guildId = cleanId(player._guildId ?? ch?.guildId ?? ch?.guild?.id ?? getMessageGuildId({ channel: ch }));

      // Check 24/7 settings for this channel (per-channel mode)
      const raw247 = (() => {
        try { return this.settings.getServer(guildId)?.get("stay_247"); } catch (_) { return null; }
      })();
      const isIn247List = (() => {
        if (!raw247 || raw247 === "none") return false;
        const channels = Array.isArray(raw247)
            ? raw247.map(id => String(id).replace(/\D/g, "")).filter(Boolean)
            : [String(raw247).replace(/\D/g, "")].filter(Boolean);
        return channels.includes(homeChannelId) || channels.includes(activeChannelId);
      })();

      // Per-channel mode: check the mode for this specific channel
      const matchChannel = isIn247List
          ? (channels247list => channels247list.includes(homeChannelId) ? homeChannelId : activeChannelId)(
              Array.isArray(raw247) ? raw247.map(id => String(id).replace(/\D/g, "")) : [String(raw247).replace(/\D/g, "")]
            )
          : null;
      const mode247 = matchChannel
          ? get247ChannelMode(this.settings.getServer(guildId), matchChannel)
          : "off";

      // Remove player from map and destroy
      this.playerMap.delete(activeChannelId);
      // Clean up pending scrobble timer
      const pendingScrobble = this._pendingScrobbleTimers.get(activeChannelId);
      if (pendingScrobble) { clearTimeout(pendingScrobble.timer); this._pendingScrobbleTimers.delete(activeChannelId); }
      if (activeChannelId !== cleanChannelId) this.playerMap.delete(cleanChannelId);
      if (homeChannelId !== activeChannelId) this.playerMap.delete(homeChannelId);
      player.destroy();

      // Notify the channel that the bot left.
      // For %247 on: bot will rejoin on reboot (but not on disconnect)
      // For %247 auto: bot will rejoin automatically after disconnect
      // For non-247: user must manually re-invoke the join command
      const prefix = (() => {
        try { return this.settings.getServer(guildId)?.get("prefix") ?? "%"; } catch (_) { return "%"; }
      })();

      let desc;
      if (mode247 === "on") {
        desc = this.locale?.translate(guildId, "responses.join.autoLeave247On", { channel: `<#${activeChannelId}>` })
          ?? `Left channel <#${activeChannelId}> because of inactivity.\nI'll rejoin automatically when the bot restarts (%247 on mode).`;
      } else if (mode247 === "auto") {
        desc = this.locale?.translate(guildId, "responses.join.autoLeave247Auto", { channel: `<#${activeChannelId}>` })
          ?? `Left channel <#${activeChannelId}> — reconnecting automatically (%247 auto mode)...`;
      } else {
        desc = this.locale?.translate(guildId, "responses.join.autoLeaveInactive247", { channel: `<#${activeChannelId}>`, prefix })
          ?? `Left channel <#${activeChannelId}> because of inactivity.\nIf you want me to stay in voice, use \`${prefix}247 on/auto\``;
      }
      if (typeof ch?.send === "function") ch.send(mkEmbed(desc));
    });

    player.on("leave", () => {});

    player.on("message", (m) => {
      const ch       = player.textChannel;
      const guildId = cleanId(player._guildId ?? ch?.guildId ?? ch?.guild?.id ?? getMessageGuildId({ channel: ch }));
      const raw      = this.settings.getServer(guildId)?.get("songAnnouncements");
      const disabled = raw === false || raw === 0 ||
          ["false","0","no","off","disable"].includes(String(raw).toLowerCase().trim());
      if (disabled) return;
      if (typeof ch?.send === "function") ch.send(typeof m === "object" && Array.isArray(m.embeds) ? m : mkEmbed(m));
    });

    // Mark as "pending join" so concurrent getPlayer() / checkVoiceChannels()
    // calls can see a player is being created for this channel, but stats
    // won't count it until the join actually succeeds.
    this._pendingJoins.add(cleanChannelId);

    (async () => {
      const statusMsg = await message.reply(mkEmbed(this._t(message, "responses.join.joining")));
      try {
        await player.join(cid);

        // Only add to playerMap after join succeeds — this prevents phantom
        // entries from inflating the player count.
        this.playerMap.set(cleanChannelId, player);
        this._pendingJoins.delete(cleanChannelId);

        await statusMsg.edit(mkEmbed(this._t(message, "responses.join.joined", { channel: cid })));

        const guildId = cleanId(channel.guildId ?? getMessageGuildId(message));
        if (guildId) {
          const savedVol = this.settings.getServer(guildId)?.get("volume");
          if (savedVol !== undefined && savedVol !== null) {
            const vol = Number(savedVol);
            if (!isNaN(vol)) player.setVolume(vol / 100);
          }
        }

        cb(player);
      } catch (err) {
        this._pendingJoins.delete(cleanChannelId);

        const errCode = sanitizeJoinError(err);
        let errorMsg;
        if (errCode === "PERMISSION") {
          errorMsg = this._t(message, "responses.join.joinFailedPerms", { channel: `<#${cleanChannelId}>` });
        } else if (errCode === "NOT_FOUND") {
          errorMsg = this._t(message, "responses.join.joinFailedNotFound");
        } else if (errCode === "TIMEOUT") {
          errorMsg = this._t(message, "responses.join.joinFailed");
        } else {
          errorMsg = this._t(message, "responses.join.joinFailed", { error: err.message });
        }
        await statusMsg.edit(mkEmbed(errorMsg)).catch(() => {});
        this.playerMap.delete(cleanChannelId);
        player.destroy();
      }
    })();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Last.fm Scrobbling
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Handle the "startplay" event for Last.fm: send now-playing notification
   * to all linked users in the voice channel, and schedule a deferred scrobble
   * after the track has played for long enough (50% duration or 4 min).
   *
   * @param {Player} player
   * @param {Object} song - Track object
   */
  _handleLastFmStartPlay(player, song) {
    const lastfm = this._lastfm;
    if (!lastfm?.enabled) return;

    const guildId = cleanId(player._guildId);
    if (!guildId) return;

    // Find all human users in the voice channel
    const channelId = getPlayerChannelId(player);
    const humanUserIds = [];

    // Check observedVoiceUsers first
    if (this.observedVoiceUsers) {
      for (const [uid, info] of this.observedVoiceUsers) {
        if (cleanId(info.guildId) === guildId && cleanId(info.channelId) === channelId) {
          humanUserIds.push(uid);
        }
      }
    }

    // Also check guild voice states as fallback
    const guild = player.client?.guilds?.get(guildId);
    if (guild) {
      const voiceStates = guild.voice_states ?? guild.voiceStates ?? null;
      if (voiceStates) {
        const entries = Array.isArray(voiceStates)
          ? voiceStates
          : typeof voiceStates.values === "function"
            ? [...voiceStates.values()]
            : Object.values(voiceStates ?? {});
        for (const state of entries) {
          const uid = state?.userId ?? state?.user_id;
          const chId = cleanId(state?.channelId ?? state?.channel_id);
          if (uid && chId === channelId) {
            // Skip bots
            const member = guild.members?.get?.(uid);
            if (member?.user?.bot) continue;
            if (!humanUserIds.includes(uid)) humanUserIds.push(uid);
          }
        }
      }
    }

    const startedAtMs = player.startedPlaying;

    // ── Cancel any previous pending scrobble timer for this channel ───────
    // Prevents duplicate scrobbles when startplay fires multiple times
    // (e.g. recovery rejoining, track restart, queue loop).
    const pendingKey = channelId;
    const existing = this._pendingScrobbleTimers.get(pendingKey);
    if (existing) {
      clearTimeout(existing.timer);
      this._pendingScrobbleTimers.delete(pendingKey);
    }

    // Send now-playing for each linked user
    for (const userId of humanUserIds) {
      lastfm.updateNowPlaying(userId, song).catch(() => {});
    }

    // Schedule deferred scrobble after threshold
    const durationMs = (() => {
      const d = song.duration;
      if (!d) return null;
      if (typeof d === "object" && d.seconds) return d.seconds * 1000;
      if (typeof d === "number") return d;
      return null;
    })();

    if (durationMs && durationMs >= 30_000) {
      const thresholdMs = Math.min(
        durationMs * lastfm.scrobbleThreshold,
        lastfm.scrobbleMinMs
      );
      // Don't schedule if threshold is too far out (cap at 10 min)
      if (thresholdMs <= 600_000) {
        const timer = setTimeout(() => {
          this._pendingScrobbleTimers.delete(pendingKey);
          // Only scrobble if the same song is still playing
          const current = player.queue?.getCurrent();
          if (!current || player._destroyed || player.leaving) return;
          if (current.title !== song.title || current.url !== song.url) return;
          if (player._paused) return; // don't scrobble if paused

          const playedMs = Date.now() - (player.startedPlaying ?? startedAtMs ?? Date.now());
          if (lastfm.shouldScrobble(song, playedMs)) {
            for (const userId of humanUserIds) {
              lastfm.scrobble(userId, song, startedAtMs).catch(() => {});
            }
          }
        }, thresholdMs);

        // Store the timer so we can cancel it if startplay fires again
        this._pendingScrobbleTimers.set(pendingKey, { timer, songUrl: song.url, startedAtMs });
      }
    }
  }

}
