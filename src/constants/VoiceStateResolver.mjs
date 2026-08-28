/** @module constants/VoiceStateResolver */

import { logger } from "./Logger.mjs";

/**
 * Iterate over a guild's voice states, normalising different data shapes.
 * Yields objects with `{ userId, channelId, isBot }` for each member in a voice channel.
 * @param {object} guild - Discord guild object with a `voice_states` property.
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
 * Check whether any non-bot humans are currently in a voice channel.
 * Checks, in order: VoiceStateCache → ObservedVoiceUsers → guild voice_states → LiveKit participants.
 * @param {object} opts
 * @param {string} opts.guildId
 * @param {string} opts.channelId
 * @param {object} [opts.client] - Discord client with `guilds`.
 * @param {VoiceStateCache} [opts.voiceCache]
 * @param {Map} [opts.observedVoiceUsers]
 * @param {object} [opts.room] - LiveKit room with `remoteParticipants`.
 * @param {string} [opts.botId]
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
 * Get the set of channel IDs that contain at least one human user.
 * @param {object} guild - Discord guild object.
 * @returns {Set<string>}
 */
export function getChannelsWithHumans(guild) {
  const channels = new Set();
  for (const vs of iterateVoiceStates(guild)) {
    if (!vs.isBot) channels.add(vs.channelId);
  }
  return channels;
}

/**
 * Get the list of user IDs present in a specific voice channel.
 * @param {object} guild - Discord guild object.
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
