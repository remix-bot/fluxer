/**
 * @module commands/leave
 * @description Make the bot leave a voice channel, with 24/7 cleanup and player destruction.
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { logger } from "../src/constants/Logger.mjs";
import { getGlobalColor, cleanId } from "../src/MessageHandler.mjs";

/** @type {CommandBuilder} @description Command definition for the leave/stop command. */
export const command = new CommandBuilder()
    .setName("leave")
    .setDescription("Make the bot leave a voice channel", "commands.leave")
    .addAliases("l", "stop")
    .setCategory("music")
    .addChannelOption(o =>
      o.setName("channel")
        .setDescription("The voice channel to leave (defaults to your current channel)")
        .setRequired(false)
    );


/**
 * Resolve the guild ID from a player, its map key, or the channel object.
 * @param {Player} player - The player instance.
 * @param {string} mapKey - The key under which the player is stored in playerMap.
 * @param {import('@fluxerjs/core').Client} client - The Discord/Fluxer client.
 * @returns {string} Cleaned guild ID, or empty string if unresolvable.
 */
function resolvePlayerGuildId(player, mapKey, client) {
  const direct = cleanId(player?._guildId);
  if (direct) return direct;
  const cid = cleanId(player?._channelId ?? mapKey);
  if (!cid) return "";
  const ch = client?.channels?.get?.(cid);
  return cleanId(ch?.guildId ?? ch?.guild?.id ?? ch?.server_id ?? ch?.serverId);
}

/**
 * Run handler for the leave/stop command.
 * Finds the target player, removes 24/7 if enabled, destroys the player,
 * and sends a confirmation message.
 * @param {object} msg - The command message wrapper.
 * @param {object} data - Parsed command data containing option values.
 * @returns {Promise<void>}
 */
export async function run(msg, data) {
  const guildId = msg.channel?.guild?.id
      ?? msg.channel?.guildId
      ?? msg.channel?.server_id
      ?? msg.channel?.serverId
      ?? msg.message?.guildId
      ?? msg.message?.server_id
      ?? msg.message?.serverId;
  const cleanGuildId = cleanId(guildId);

  const client = this.client;
  const guildPlayers = [...this.players.playerMap.entries()].filter(([mapKey, p]) => {
    if (p?._destroyed) return false;
    return resolvePlayerGuildId(p, mapKey, client) === cleanGuildId;
  });

  const specifiedChannel = data?.get("channel")?.value;
  let targetChannelId = null;

  if (specifiedChannel) {
    targetChannelId = cleanId(specifiedChannel);
  } else {
    const { channelId: userChannelId } = await this.players.checkVoiceChannels(msg);
    if (userChannelId) targetChannelId = cleanId(userChannelId);
  }

  if (!targetChannelId) {
    if (guildPlayers.length === 0) {
      return msg.reply(this.t(msg, "responses.leave.notInVoice"));
    }
    const channelList = guildPlayers.map(([mapKey, p]) => {
      const id = cleanId(p._channelId ?? mapKey);
      return id ? `<#${id}>` : "\`unknown\`";
    });
    return msg.reply(
        this.t(msg, "responses.leave.specifyChannel", {
          channels: channelList.map(c => `• ${c}`).join("\n"),
          prefix: this.handler.getPrefix(msg.message?.guildId ?? msg.channel?.guild?.id)
        })
    );
  }

  const player = this.players.playerMap.get(targetChannelId)
      ?? guildPlayers.find(([mapKey, p]) =>
          cleanId(p._channelId) === targetChannelId || cleanId(mapKey) === targetChannelId
      )?.[1]
      ?? null;

  if (!player) {
    if (guildPlayers.length === 0) {
      return msg.reply(this.t(msg, "responses.leave.notInVoice"));
    }
    const channelList = guildPlayers.map(([mapKey, p]) => {
      const id = cleanId(p._channelId ?? mapKey);
      return id ? `<#${id}>` : "\`unknown\`";
    });
    return msg.reply(
        this.t(msg, "responses.leave.noPlayerInChannel", {
          channel: `<#${targetChannelId}>`,
          channels: channelList.map(c => `• ${c}`).join("\n")
        })
    );
  }

  if (!player?.connection) return msg.reply(this.t(msg, "responses.leave.playerNotInit"));

  const activeChannelId = cleanId(player._channelId) || targetChannelId;
  const homeChannelId = cleanId(player._home247Channel) || activeChannelId;

  // If this channel has 24/7 enabled, remove it from the saved list first.
  // This prevents the disconnect handler from scheduling an auto-rejoin loop.
  const set = this.getSettings(msg);
  const raw = set?.get("stay_247");
  const ch247 = (!raw || raw === "none")
      ? new Set()
      : Array.isArray(raw)
          ? new Set(raw.map(id => cleanId(id)).filter(Boolean))
          : new Set([cleanId(raw)]);

  const was247 = ch247.has(activeChannelId) || ch247.has(homeChannelId);

  if (was247) {
    const target = ch247.has(activeChannelId) ? activeChannelId : homeChannelId;
    ch247.delete(target);
    set.set("stay_247", ch247.size > 0 ? [...ch247] : "none");
  }

  // Mark as intentional leave so the disconnect handler doesn't also try to rejoin
  this.markIntentionalLeave(activeChannelId);
  this.players.playerMap.delete(activeChannelId);
  this.players._unindexPlayer(player._guildId, activeChannelId);
  if (activeChannelId !== targetChannelId) this.players.playerMap.delete(targetChannelId);
  if (homeChannelId !== activeChannelId) this.players.playerMap.delete(homeChannelId);

  const pendingScrobble = this.players._pendingScrobbleTimers?.get(activeChannelId);
  if (pendingScrobble) {
    clearTimeout(pendingScrobble.timer);
    this.players._pendingScrobbleTimers.delete(activeChannelId);
  }

  await player.leave().catch(() => {});
  player.destroy();

  const label247 = was247 ? " 24/7 disabled." : "";
  msg.reply(this.t(msg, "responses.leave.left") + label247);
}
