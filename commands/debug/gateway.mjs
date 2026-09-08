/**
 * @module commands/debug/gateway
 * @description Gateway/voice state inspection helpers (room labels, ghost detection, bot gateway voice state, stale presence, player labels). Verbatim from the original single-file command.
 */

import { getVoiceManager } from "@fluxerjs/voice";
import { logger } from "../../src/core/Logger.mjs";
import { cleanId } from "../../src/ui/index.mjs";

/**
 * Get a human-readable label for a voice room's connection state.
 * @private
 * @param {object|null} room - The voice room object.
 * @returns {string} Connection state label.
 */
export function roomStateLabel(room) {
  if (!room) return "none";
  const cs = room.connectionState;
  if (cs === 0 || cs === "CONN_DISCONNECTED") return "disconnected(0)";
  if (cs === 1 || cs === "CONN_CONNECTED") return "connected(1)";
  if (cs === 2) return room.isConnected ? "connected(2)" : "reconnecting(2)";
  if (cs === "CONN_RECONNECTING") return "reconnecting";
  if (cs === 3) return "reconnecting(3)";
  if (cs === 4) return "signal_reconnecting(4)";
  if (typeof cs === "string") return cs;
  return String(cs);
}
/**
 * Check if a player has a ghost connection (appears in voice but WebSocket is dead).
 * @private
 * @param {object} player - The player instance.
 * @returns {boolean} True if the player has a ghost connection.
 */
export function isGhostConnection(player) {
  const conn = player.connection;
  if (!conn) return false;
  if (player._destroyed || player.leaving || player._isJoining) return false;

  const room = conn.room;
  if (!room) {
    return !conn._destroyed;
  }

  if (!room.isConnected) return true;

  const cs = room.connectionState;
  if (cs === 0 || cs === "CONN_DISCONNECTED") return true;
  if (cs === "CONN_RECONNECTING" || cs === 3 || cs === 4) return true;

  return false;
}
/**
 * Get the bot's voice channel state from the gateway cache.
 * @private
 * @param {object} client - The client instance.
 * @param {string} guildId - The guild ID to check.
 * @returns {{ userId: string, channelId: string }|null} Bot's voice state or null.
 */
export function getBotGatewayVoiceState(client, guildId) {
  const botId = client.user?.id;
  if (!botId || !guildId) return null;

  try {
    const vm = getVoiceManager(client);
    if (vm?.voiceStates) {
      const cleanGuild = cleanId(guildId);
      const guildVoiceMap = vm.voiceStates.get(cleanGuild) ?? vm.voiceStates.get(guildId);
      if (guildVoiceMap && typeof guildVoiceMap.get === "function") {
        const channelId = guildVoiceMap.get(botId);
        if (channelId) return { userId: botId, channelId: cleanId(channelId) };
      }
    }
  } catch (e) { logger.warn("[Debug] getBotGatewayVoiceState (VoiceManager):", e?.message); }

  try {
    const cleanGuild = cleanId(guildId);
    const guild = client.guilds.get(cleanGuild) ?? client.guilds.get(guildId);
    const voiceStates = guild?.voice_states ?? guild?.voiceStates ?? null;
    if (!voiceStates) return null;

    const entries = Array.isArray(voiceStates)
        ? voiceStates
        : typeof voiceStates.values === "function"
            ? [...voiceStates.values()]
            : Object.entries(voiceStates).map(([uid, val]) => {
              if (typeof val === "string") return { user_id: uid, channel_id: val };
              const obj = typeof val === "object" && val !== null ? val : {};
              return { user_id: uid, channel_id: obj.channelId ?? obj.channel_id ?? null, ...obj };
            });

    for (const state of entries) {
      const uid = state?.user_id ?? state?.userId ?? state?.id;
      if (uid === botId) {
        const chId = state?.channel_id ?? state?.channelId ?? null;
        if (chId) return { userId: botId, channelId: cleanId(chId) };
      }
    }
  } catch (e) { logger.warn("[Debug] getBotGatewayVoiceState (guild cache):", e?.message); }

  return null;
}
/**
 * Check if the gateway voice state is stale (mismatches the player's channel).
 * @private
 * @param {object} client - The client instance.
 * @param {object} player - The player instance.
 * @returns {boolean} True if the gateway presence is stale.
 */
export function isStaleGatewayPresence(client, player) {
  const guildId = player._guildId ?? player._resolveGuildId?.();
  if (!guildId) return false;

  const gatewayState = getBotGatewayVoiceState(client, guildId);
  if (!gatewayState) return false;

  const playerChannel = cleanId(player._channelId ?? player._home247Channel);
  const gatewayChannel = gatewayState.channelId;

  return !playerChannel || playerChannel !== gatewayChannel;
}
/**
 * Build a human-readable label for a player (guild name / #channel name).
 * @private
 * @param {object} client - The client instance.
 * @param {string} channelId - The voice channel ID.
 * @param {object} player - The player instance.
 * @returns {string} Formatted label string.
 */
export function buildPlayerLabel(client, channelId, player) {
  const channel = client.channels.get(channelId);
  const gId = player._guildId ?? channel?.guildId;
  const guild = gId ? client.guilds.get(cleanId(gId)) : null;
  return `${guild?.name ?? "unknown"} / #${channel?.name ?? channelId}`;
}
