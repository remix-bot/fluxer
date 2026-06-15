/**
 * @file VoiceStateResolver.mjs — VoiceStateResolver — unified voice state enumeration across Map/Array/Object guild voice_states with human-detection fallbacks
 * @module src.constants.VoiceStateResolver
 */

/**
 * VoiceStateResolver.mjs — Unified voice state enumeration.
 *
 * Eliminates the 12+ duplicated voice-state-iteration blocks scattered
 * across Player.mjs, PlayerManager.mjs, GatewayHandler.mjs, and Dashboard.mjs.
 *
 * Fluxer's guild.voice_states can be a Map, an Array, or a plain Object
 * depending on the client version and cache state. This module normalises
 * all three into a single iteration interface.
 */

import { logger } from "./Logger.mjs";

/**
 * Iterate over all voice states for a guild, yielding objects with
 * { userId, channelId, isBot } regardless of the underlying data structure.
 *
 * @param {import("@fluxerjs/core").Guild} guild
 * @yields {{ userId: string, channelId: string, isBot: boolean }}
 */
export function* iterateVoiceStates(guild) {
  if (!guild) return;

  const voiceStates = guild.voice_states;
  if (!voiceStates) return;

  let entries;
  try {
    if (Array.isArray(voiceStates)) {
      entries = voiceStates;
    } else if (typeof voiceStates.values === "function") {
      entries = voiceStates.values();
    } else if (typeof voiceStates[Symbol.iterator] === "function") {
      entries = voiceStates;
    } else {
      entries = Object.values(voiceStates);
    }
  } catch (e) {
    logger.warn("[VoiceStateResolver] Failed to enumerate voice states:", e?.message);
    return;
  }

  for (const state of entries) {
    if (!state) continue;
    const userId    = state.userId ?? state.user_id;
    const channelId = state.channelId ?? state.channel_id;
    if (!userId || !channelId) continue;

    const member = guild.members?.get?.(userId);
    const isBot  = member?.user?.bot ?? false;

    yield { userId: String(userId), channelId: String(channelId), isBot };
  }
}

/**
 * Check whether a guild's voice channel contains any non-bot users.
 * Uses three fallback strategies: VoiceStateCache, guild.voice_states,
 * and LiveKit remote participants.
 *
 * @param {object} opts
 * @param {string} opts.guildId  - Clean guild ID
 * @param {string} opts.channelId - Clean channel ID
 * @param {object} [opts.client]  - Fluxer client (for guild cache)
 * @param {object} [opts.voiceCache] - VoiceStateCache instance
 * @param {Map}    [opts.observedVoiceUsers] - Observed voice users map
 * @param {object} [opts.room]    - LiveKit Room (for remote participants)
 * @param {string} [opts.botId]   - Bot user ID (to exclude from LiveKit check)
 * @returns {boolean}
 */
export function hasHumansInChannel({ guildId, channelId, client, voiceCache, observedVoiceUsers, room, botId }) {
  if (!channelId || !guildId) return false;


  if (voiceCache && typeof voiceCache.hasHumansInChannel === "function") {
    if (voiceCache.hasHumansInChannel(guildId, channelId)) return true;
  }


  if (observedVoiceUsers) {
    try {
      const iterator = typeof observedVoiceUsers.iterateHumanUsers === "function"
        ? observedVoiceUsers.iterateHumanUsers()
        : observedVoiceUsers.entries();

      for (const [, info] of iterator) {
        const gId = String(info.guildId ?? "");
        const cId = String(info.channelId ?? "");
        if (gId === guildId && cId === channelId) return true;
      }
    } catch (e) {
      logger.warn("[VoiceStateResolver] ObservedVoiceUsers check failed:", e?.message);
    }
  }


  if (client) {
    try {
      const guild = client.guilds?.get?.(guildId);
      if (guild) {
        for (const vs of iterateVoiceStates(guild)) {
          if (vs.channelId === channelId && !vs.isBot) return true;
        }
      }
    } catch (e) {
      logger.warn("[VoiceStateResolver] Guild voice_states check failed:", e?.message);
    }
  }


  if (room?.isConnected && room.remoteParticipants) {
    try {
      for (const [, participant] of room.remoteParticipants) {
        const pId = participant?.identity || participant?.sid;
        if (pId && pId !== botId) return true;
      }
    } catch (e) {
      logger.warn("[VoiceStateResolver] LiveKit participants check failed:", e?.message);
    }
  }

  return false;
}

/**
 * Get all channel IDs that have at least one human user in voice.
 *
 * @param {import("@fluxerjs/core").Guild} guild
 * @returns {Set<string>} Set of channel IDs with human users
 */
export function getChannelsWithHumans(guild) {
  const channels = new Set();
  for (const vs of iterateVoiceStates(guild)) {
    if (!vs.isBot) channels.add(vs.channelId);
  }
  return channels;
}

/**
 * Get all user IDs in a specific voice channel (including bots).
 *
 * @param {import("@fluxerjs/core").Guild} guild
 * @param {string} channelId
 * @returns {string[]}
 */
export function getUsersInChannel(guild, channelId) {
  const users = [];
  for (const vs of iterateVoiceStates(guild)) {
    if (vs.channelId === channelId) users.push(vs.userId);
  }
  return users;
}
