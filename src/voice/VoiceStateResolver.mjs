/** @module src/voice/VoiceStateResolver */

import { logger } from "../core/Logger.mjs";

/**
 * Decide whether a voice-state user is a bot, using every available signal:
 * explicit self-bot id, the state's own member payload, the guild member
 * cache, and the global user cache. Never trusts a single missing flag —
 * a voice state without a `member.user` payload used to be classified as
 * human, which made third-party bots count toward vote-skip thresholds.
 * @param {object} opts
 * @param {string} opts.userId
 * @param {object} [opts.member] - Member object from the voice state payload (if any).
 * @param {object} [opts.guild] - Cached guild object (for the member cache fallback).
 * @param {object} [opts.client] - Client (for the global user cache fallback).
 * @param {string} [opts.botId] - This bot's own user id.
 * @returns {boolean}
 */
export function resolveIsBotUser({ userId, member, guild, client, botId }) {
  const id = String(userId ?? "");
  if (!id) return false;
  if (botId && id === String(botId)) return true;

  const candidates = [
    member?.user,
    guild?.members?.get?.(id)?.user,
    client?.users?.cache?.get?.(id) ?? client?.users?.get?.(id),
  ];
  for (const user of candidates) {
    if (user && typeof user === "object" && typeof user.bot === "boolean") return user.bot;
  }
  return false;
}

/**
 * Iterate over a guild's voice states, normalising different data shapes.
 * Yields objects with `{ userId, channelId, isBot }` for each member in a voice channel.
 * @param {object} guild - guild object with a `voice_states` property.
 * @param {object} [classifier] - Optional extras for bot detection (see resolveIsBotUser).
 * @param {object} [classifier.client]
 * @param {string} [classifier.botId]
 * @yields {{ userId: string, channelId: string, isBot: boolean }}
 */
export function* iterateVoiceStates(guild, classifier = {}) {
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
    const isBot  = resolveIsBotUser({
      userId,
      member,
      guild,
      client: classifier.client,
      botId:  classifier.botId,
    });

    yield { userId: String(userId), channelId: String(channelId), isBot };
  }
}

/**
 * Check whether any non-bot humans are currently in a voice channel.
 * Checks, in order: VoiceStateCache → ObservedVoiceUsers → guild voice_states → LiveKit participants.
 * @param {object} opts
 * @param {string} opts.guildId
 * @param {string} opts.channelId
 * @param {object} [opts.client] - client with `guilds`.
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


  if (observedVoiceUsers && observedVoiceUsers !== voiceCache) {
    if (typeof observedVoiceUsers.hasHumansInChannel === "function") {
      if (observedVoiceUsers.hasHumansInChannel(guildId, channelId)) return true;
    } else {
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
  }


  if (client) {
    try {
      const guild = client.guilds?.get?.(guildId);
      if (guild) {
        for (const vs of iterateVoiceStates(guild, { client, botId })) {
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
 * Count the number of distinct non-bot humans currently in a voice channel.
 * Checks, in order: VoiceStateCache (exact count) → guild voice_states (live
 * count) → ObservedVoiceUsers (falls back to a 0/1 presence check only).
 * @param {object} opts
 * @param {string} opts.guildId
 * @param {string} opts.channelId
 * @param {object} [opts.client] - client with `guilds`.
 * @param {VoiceStateCache} [opts.voiceCache]
 * @param {Map} [opts.observedVoiceUsers]
 * @param {string} [opts.botId] - This bot's own user id.
 * @returns {number}
 */
export function countHumansInChannel({ guildId, channelId, client, voiceCache, observedVoiceUsers, botId }) {
  if (!channelId || !guildId) return 0;

  if (voiceCache && typeof voiceCache.getHumanCount === "function") {
    return voiceCache.getHumanCount(guildId, channelId);
  }

  if (client) {
    try {
      const guild = client.guilds?.get?.(guildId);
      if (guild) {
        const users = new Set();
        for (const vs of iterateVoiceStates(guild, { client, botId })) {
          if (vs.channelId === channelId && !vs.isBot) users.add(vs.userId);
        }
        return users.size;
      }
    } catch (e) {
      logger.warn("[VoiceStateResolver] countHumansInChannel guild fallback failed:", e?.message);
    }
  }

  if (observedVoiceUsers) {
    try {
      const users = new Set();
      const iterator = typeof observedVoiceUsers.iterateHumanUsers === "function"
        ? observedVoiceUsers.iterateHumanUsers()
        : observedVoiceUsers.entries();
      for (const [userId, info] of iterator) {
        if (String(info.guildId ?? "") === guildId && String(info.channelId ?? "") === channelId) {
          users.add(userId);
        }
      }
      return users.size;
    } catch (e) {
      logger.warn("[VoiceStateResolver] countHumansInChannel observedVoiceUsers fallback failed:", e?.message);
    }
  }

  return 0;
}

/**
 * Get the set of channel IDs that contain at least one human user.
 * @param {object} guild - guild object.
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
 * @param {object} guild - guild object.
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
