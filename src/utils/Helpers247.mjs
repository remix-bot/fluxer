/** @module src/utils/Helpers247 */

import { cleanId } from "./Utils.mjs";

/**
 * Runtime liveness check for a player's voice connection — the runtime
 * counterpart of the debug command's isGhostConnection(). A player can sit
 * in the playerMap with _destroyed === false while its LiveKit/voice session
 * is long gone (serverLeave zeroes _voiceConn/connection). Such zombies
 * historically blocked every 24/7 rejoin path ("already has a player —
 * skipping"), which is why 24/7 silently died.
 *
 * Dead when: destroyed/leaving, or no connection objects at all, or the
 * room reports disconnected. Alive while _isJoining (mid-join) — the
 * connection may not exist yet.
 *
 * @param {object|null} player - Player instance (duck-typed; safe on stubs).
 * @returns {boolean} True when the player cannot possibly be producing audio.
 */
export function isPlayerConnectionDead(player) {
  if (!player) return true;
  if (player._destroyed || player.leaving) return true;
  if (player._isJoining) return false;

  const conn = player._voiceConn ?? player.connection ?? null;
  if (!conn) return true;

  const room = conn.room ?? null;
  if (!room) {
    try { return conn.isConnected?.() === false; } catch (_) { return false; }
  }
  if (room.isConnected === false) return true;

  const cs = room.connectionState;
  if (cs === 0 || cs === "CONN_DISCONNECTED") return true;

  return false;
}

/**
 * Simplified 24/7 helpers — single mode (on/off), no per-channel modes.
 * get247ChannelMode is used by Player.mjs, PlayerManager.mjs, GatewayHandler.mjs, leave.mjs.
 * remove247ChannelMode and set247ChannelMode are kept as no-ops for backward compat
 * (original files in the zip still import them).
 */

/**
 * Check if a channel has 24/7 enabled.
 * @param {object} set - ServerSettings instance
 * @param {string} channelId
 * @returns {"on"|"off"}
 */
export function get247ChannelMode(set, channelId) {
  if (!set?.get) return "off";
  const raw = set.get("stay_247");
  if (!raw || raw === "none") return "off";
  const channels = Array.isArray(raw)
    ? raw.map(id => String(id).trim()).filter(Boolean)
    : [String(raw).trim()];
  return channels.includes(channelId) ? "on" : "off";
}

/**
 * No-op: per-channel modes removed. Kept for backward compatibility.
 * Original GatewayHandler.mjs and index.mjs still import this.
 */
export function remove247ChannelMode(set, channelId, currentChannels) {
}

/**
 * No-op: per-channel modes removed. Kept for backward compatibility.
 */
export function set247ChannelMode(set, channelId, mode) {
}

/**
 * Evict a player from every manager index (playerMap active + home keys,
 * guild index, pending scrobble timers) WITHOUT destroying it. Shared by the
 * serverLeave rejoin path, the rejoin self-healing path and _spawnPlayer's
 * zombie replacement, so they all clean up identically.
 *
 * @param {object} remix - The bot (Remix) context.
 * @param {object} player - The player to detach.
 * @param {string} [fallbackChannelId] - Channel key to also clear if the
 *        player carries no ids.
 * @returns {string|null} The primary channel key that was cleared.
 */
export function detachPlayerFromManager(remix, player, fallbackChannelId = null) {
  if (!remix?.players?.playerMap || !player) return null;

  const activeCh = cleanId(player._channelId ?? "") || cleanId(fallbackChannelId ?? "") || null;
  const homeCh   = cleanId(player._home247Channel ?? "") || null;
  const guildId  = cleanId(player._guildId ?? "");

  const keys = new Set([activeCh, homeCh].filter(Boolean));
  for (const key of keys) {
    if (remix.players.playerMap.get(key) === player) remix.players.playerMap.delete(key);
  }

  for (const key of keys) {
    try { remix.players._unindexPlayer?.(guildId, key); } catch (_) {}
  }

  for (const key of keys) {
    const pendingScrobble = remix.players._pendingScrobbleTimers?.get(key);
    if (pendingScrobble) {
      clearTimeout(pendingScrobble.timer);
      remix.players._pendingScrobbleTimers.delete(key);
    }
  }

  return activeCh;
}