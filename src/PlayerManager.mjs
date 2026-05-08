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
    this.spawnPlayer  = config.spawnPlayer ?? null;   // RecoveryManager.spawnPlayer — for 24/7 rejoin on autoleave
    this.timers       = config.timers ?? {};
  }

  /**
   * Forward player lifecycle/state events to the dashboard pub/sub channels.
   *
   * IMPORTANT: Events are sent in Stoat-compatible { type, data } format so
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

    // ── Per-player channel: Stoat-compatible { type, data } format ────────
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
    //
    // CRITICAL: After a bot reload, guild.voice_states may not yet contain all
    // users who are in the channel (only the bot's own state may be present).
    // The observedVoiceUsers map is seeded from READY/GUILD_CREATE and IS
    // reliable — so we use it as a fallback to ensure all users are announced.
    const sendUserUpdates = (eventType) => {
      if (!this.dashboard?.enabled) return;
      const channelId = getPlayerChannelId(player, context.channelId);
      const guildId = cleanId(player._guildId ?? context.guildId);
      const channel = player.client?.channels?.get(channelId);
      const guild = player.client?.guilds?.get(guildId);
      const sentUserIds = new Set(); // Deduplicate across both sources

      // ── Source 1: guild.voice_states (real-time Discord data) ──────────
      if (guild) {
        const voiceStates = guild.voice_states ?? guild.voiceStates ?? null;
        if (voiceStates) {
          const entries = Array.isArray(voiceStates)
            ? voiceStates
            : typeof voiceStates.values === "function"
              ? [...voiceStates.values()]
              : Object.values(voiceStates);
          for (const state of entries) {
            if (!state?.channelId && !state?.channel_id) continue;
            const stateChannelId = cleanId(state.channelId ?? state.channel_id);
            if (stateChannelId !== channelId) continue;
            const userId = String(state.userId ?? state.user_id ?? "");
            if (!userId) continue;
            const member = guild.members?.get?.(userId);
            if (!member?.user || member.user?.bot) continue;
            sentUserIds.add(userId);
            emit(eventType, member.user.id);
            this.dashboard.userUpdate({
              type: eventType,
              guildId,
              channelId,
            }, member.user);
          }
        }
      }

      // ── Source 2: observedVoiceUsers (seeded from READY/GUILD_CREATE) ──
      // This catches users who were already in the channel when the bot
      // reloaded but whose voice states aren't in guild.voice_states yet.
      // After a bot restart, guild.voice_states may only contain the bot's
      // own voice state, while observedVoiceUsers was populated from the
      // READY payload and contains ALL humans who were already in voice.
      if (eventType === "join" && this.observedVoiceUsers) {
        const botUserId = player.client?.user?.id;
        for (const [mapUserId, info] of this.observedVoiceUsers) {
          if (sentUserIds.has(mapUserId)) continue; // Already sent from voice_states
          const infoChannelId = cleanId(info.channelId ?? "");
          const infoGuildId = cleanId(info.guildId ?? "");
          if (infoChannelId !== channelId || infoGuildId !== guildId) continue;
          // Skip the bot itself — it's not a "user" to announce
          if (botUserId && String(mapUserId) === String(botUserId)) continue;
          // Skip bots (check observedVoiceBots if available)
          const botKey = `${infoGuildId}:${mapUserId}`;
          if (this.observedVoiceBots?.has?.(botKey)) continue;
          sentUserIds.add(mapUserId);
          // Try to get user object from cache first, then fetch asynchronously
          const cachedUser = player.client?.users?.get?.(mapUserId);
          emit(eventType, String(mapUserId));
          if (cachedUser) {
            this.dashboard.userUpdate({
              type: eventType,
              guildId,
              channelId,
            }, cachedUser);
          } else {
            // User not in cache — fetch async and send update when available
            player.client?.users?.fetch?.(mapUserId)?.then?.((userObj) => {
              if (userObj) {
                this.dashboard.userUpdate({
                  type: eventType,
                  guildId,
                  channelId,
                }, userObj);
              }
            })?.catch?.(() => {});
          }
        }
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
      // calculate elapsed time accurately (matches Stoat behaviour)
      emit("streamStartPlay", Date.now());
      // Also broadcast on global channel for full state update
      this.dashboard.playerUpdate({ type: "startplay" }, player);
    });

    player.on("stopplay", () => {
      emit("stopplay", null);
      this.dashboard.playerUpdate({ type: "stopplay" }, player);
    });

    player.on("playback", (playing) => {
      // Stoat sends "pause" or "resume" with { elapsedTime } — match that
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
      // Filter events are Fluxer-specific — no Stoat equivalent.
      // Send as a custom event type; the backend will ignore unknown types.
      emit("filter", filter);
    });

    player.on("update", (scope) => {
      // Generic update — send full player state on global channel
      this.dashboard.playerUpdate({ type: "update" }, player);
    });

    player.on("message", (message) => {
      // No Stoat equivalent — skip per-player, only global broadcast
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
   * Safely send a message to a text channel.
   *
   * In Fluxer.js, VoiceChannel does NOT have a .send() method — only
   * TextChannel and DMChannel do.  If player.textChannel is a voice
   * channel (or any object without .send()), we fall back to
   * client.channels.send(channelId, payload) which works on any
   * channel type.
   *
   * @param {Object} ch - Channel object (player.textChannel)
   * @param {Object} payload - Message payload (embed, content, etc.)
   * @returns {Promise<any>}
   */
  async _sendToTextChannel(ch, payload) {
    // ── Check if the channel is actually a text channel ────────────────
    // Fluxer.js voice channels have a .send() method that throws
    // CANNOT_SEND_MESSAGES_IN_NON_TEXT_CHANNEL when called. We need to
    // detect this BEFORE calling .send() and fall back to a real text
    // channel from the same guild.
    const isTextChannel = (c) => {
      if (!c) return false;
      // type 0 = text channel in Fluxer/Discord; type 2 = voice; type 13 = stage
      if (c.type != null) return c.type === 0 || c.type === 5 || c.type === 13;
      // isText() method if available
      if (typeof c.isText === "function") return c.isText();
      // If the channel has isVoice() and it returns true, it's NOT a text channel
      if (typeof c.isVoice === "function" && c.isVoice()) return false;
      return false;
    };

    // Method 1: channel.send() — only if it's a real text channel
    if (ch && isTextChannel(ch) && typeof ch.send === "function") {
      try {
        return await ch.send(payload);
      } catch (e) {
        // Send failed even though we thought it was a text channel —
        // fall through to the guild text channel search below
        logger.warn("[PlayerManager] _sendToTextChannel: send() failed on type-0 channel:", e.message);
      }
    }

    // Method 2: Find a suitable text channel from the same guild
    const channelId = ch?.id ?? ch?._id;
    const guildId = ch?.guildId ?? ch?.guild?.id ?? ch?.server_id ?? ch?.serverId;

    if (guildId && this.commands?.client) {
      const guild = this.commands.client.guilds.get(guildId);
      if (guild?.channels) {
        const channelValues = typeof guild.channels.values === "function"
            ? [...guild.channels.values()]
            : Array.isArray(guild.channels) ? guild.channels : Object.values(guild.channels);

        // Prefer: system channel > first text channel the bot can send to
        const sysCh = guild.systemChannelId
            ? channelValues.find(c => (c.id ?? c._id) === guild.systemChannelId)
            : null;
        if (sysCh && isTextChannel(sysCh) && typeof sysCh.send === "function") {
          try { return await sysCh.send(payload); } catch (_) {}
        }

        // Fall back to the first text channel
        const textCh = channelValues.find(c => isTextChannel(c));
        if (textCh && typeof textCh.send === "function") {
          try { return await textCh.send(payload); } catch (_) {}
        }
      }
    }

    // Method 3: client.channels.send(id, payload) — last resort
    if (channelId && this.commands?.client?.channels?.send) {
      try {
        return await this.commands.client.channels.send(channelId, payload);
      } catch (_) {}
    }

    logger.warn("[PlayerManager] _sendToTextChannel: no valid text channel found for guild", guildId ?? channelId ?? "(unknown)");
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

    const liveGuildPlayers = [...this.playerMap.entries()].filter(([channelId, player]) => {
      const fallbackChannel =
        this.commands.client?.channels?.get?.(channelId) ??
        null;
      return getPlayerGuildId(player, fallbackChannel) === cleanGuild;
    });
    if (liveGuildPlayers.length === 1) {
      return getPlayerChannelId(liveGuildPlayers[0][1], liveGuildPlayers[0][0]) || cleanId(liveGuildPlayers[0][0]);
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
        return player;
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
            msg.author
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
      }, msg.author);
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

    const player = new Player(this.config.token, {
      ...this.playerConfig,
      client:             this.commands.client,
      config:             this.config,
      nodelink:           this.config.nodelink,
      moonlink:           this.playerConfig?.moonlink ?? null,
      settingsMgr:        this.settings,
      observedVoiceUsers: this.observedVoiceUsers ?? null,
      locale:             this.locale ?? null,
    });

    player.textChannel = message.channel;
    this.setupEvents(player, {
      channelId: cleanChannelId,
      guildId: cleanId(channel.guildId ?? getMessageGuildId(message)),
    });

    player.on("autoleave", async () => {
      const activeChannelId = getPlayerChannelId(player, cleanChannelId) || cleanChannelId;
      const homeChannelId = cleanId(player._home247Channel) || activeChannelId;
      const ch       = player.textChannel;
      const guildId = cleanId(player._guildId ?? ch?.guildId ?? ch?.guild?.id ?? getMessageGuildId({ channel: ch }));

      // Check 24/7 settings for this channel
      const raw247 = (() => {
        try { return this.settings.getServer(guildId)?.get("stay_247"); } catch (_) { return null; }
      })();
      const mode247 = (() => {
        try { return this.settings.getServer(guildId)?.get("stay_247_mode") ?? "off"; } catch (_) { return "off"; }
      })();
      const isIn247List = (() => {
        if (!raw247 || raw247 === "none") return false;
        const channels = Array.isArray(raw247)
            ? raw247.map(id => String(id).replace(/\D/g, "")).filter(Boolean)
            : [String(raw247).replace(/\D/g, "")].filter(Boolean);
        return channels.includes(homeChannelId) || channels.includes(activeChannelId);
      })();

      // Remove player from map and destroy
      this.playerMap.delete(activeChannelId);
      if (activeChannelId !== cleanChannelId) this.playerMap.delete(cleanChannelId);
      if (homeChannelId !== activeChannelId) this.playerMap.delete(homeChannelId);
      player.destroy();

      if (isIn247List && (mode247 === "on" || mode247 === "auto")) {
        // 24/7 is active — rejoin after a short delay (same as RecoveryManager.spawnPlayer autoleave)
        const delay = this.timers?.rejoin247Delay ?? 3000;
        if (this.spawnPlayer) {
          logger.recovery(`[AutoLeave] 24/7 rejoin scheduled for ${homeChannelId} in ${delay}ms`);
          setTimeout(() => {
            this.spawnPlayer(guildId, homeChannelId, 0, null, "initplayer-autoleave").catch(e =>
              logger.warn("[AutoLeave] 24/7 rejoin failed for", homeChannelId, e.message)
            );
          }, delay);
        }
      } else {
        // Not 24/7 — send inactivity message
        const prefix = (() => {
          try { return this.settings.getServer(guildId)?.get("prefix") ?? "%"; } catch (_) { return "%"; }
        })();
        const desc = this.locale?.translate(guildId, "responses.join.autoLeaveInactive247", { channel: `<#${activeChannelId}>`, prefix })
          ?? `Left channel <#${activeChannelId}> because of inactivity.\nIf you want me to stay in voice, use \`${prefix}247 on/auto\``;
        try {
          await this._sendToTextChannel(ch, mkEmbed(desc));
        } catch (e) {
          logger.warn("[PlayerManager] autoleave send failed:", e.message);
        }
      }
    });

    player.on("leave", () => {});

    player.on("message", async (m) => {
      const ch       = player.textChannel;
      const guildId = cleanId(player._guildId ?? ch?.guildId ?? ch?.guild?.id ?? getMessageGuildId({ channel: ch }));
      const raw      = this.settings.getServer(guildId)?.get("songAnnouncements");
      const disabled = raw === false || raw === 0 ||
          ["false","0","no","off","disable"].includes(String(raw).toLowerCase().trim());
      if (disabled) return;
      try {
        await this._sendToTextChannel(ch, typeof m === "object" && Array.isArray(m.embeds) ? m : mkEmbed(m));
      } catch (e) {
        logger.warn("[PlayerManager] message send failed:", e.message);
      }
    });

    this.playerMap.set(cleanChannelId, player);

    (async () => {
      let statusMsg;
      try {
        statusMsg = await message.reply(mkEmbed(this._t(message, "responses.join.joining")));
      } catch (e) {
        logger.warn("[PlayerManager] statusMsg reply failed:", e.message);
      }
      try {
        await player.join(cid);
        if (statusMsg?.edit) {
          try { await statusMsg.edit(mkEmbed(this._t(message, "responses.join.joined", { channel: cid }))); } catch (_) {}
        }

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
        if (statusMsg?.edit) {
          try { await statusMsg.edit(mkEmbed(errorMsg)); } catch (_) {}
        }
        this.playerMap.delete(cleanChannelId);
        player.destroy();
      }
    })();
  }

}
