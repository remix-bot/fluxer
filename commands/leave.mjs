/**
 * @file leave.mjs — Leave the current voice channel and stop playback
 * @module commands.leave
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";
import { logger } from "../src/constants/Logger.mjs";
import { getGlobalColor, cleanId } from "../src/MessageHandler.mjs";
import { get247ChannelMode } from "../src/constants/Helpers247.mjs";

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


function resolvePlayerGuildId(player, mapKey, client) {
  const direct = cleanId(player?._guildId);
  if (direct) return direct;
  const cid = cleanId(player?._channelId ?? mapKey);
  if (!cid) return "";
  const ch = client?.channels?.get?.(cid);
  return cleanId(ch?.guildId ?? ch?.guild?.id ?? ch?.server_id ?? ch?.serverId);
}

/**
 * Execute the leave command.
 * @param {import("../src/MessageHandler.mjs").Message} msg - The incoming message
 * @param {Map<string, {value: *}>} data - Slash-command options map
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
      return id ? `<#${id}>` : "`unknown`";
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
      return id ? `<#${id}>` : "`unknown`";
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

  const set = this.getSettings(msg);
  const raw = set?.get("stay_247");
  const ch247 = (!raw || raw === "none")
      ? new Set()
      : Array.isArray(raw)
          ? new Set(raw.map(id => cleanId(id)).filter(Boolean))
          : new Set([cleanId(raw)]);

  const is247 = ch247.has(activeChannelId) || ch247.has(homeChannelId);

  if (is247) {
    const matchChannel = ch247.has(homeChannelId) ? homeChannelId
        : ch247.has(activeChannelId) ? activeChannelId
        : null;
    const mode = matchChannel ? get247ChannelMode(set, matchChannel) : "off";
    const prefix = this.handler.getPrefix(msg.message?.guildId ?? msg.channel?.guild?.id);

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

    if (mode === "auto") {
      msg.reply(this.t(msg, "responses.leave.leftRejoin247", { channel: targetChannelId, prefix }));
      const rejoinDelay = this.config?.timers?.leave247RejoinDelay ?? 5000;
      setTimeout(() => {
        if (this._spawnPlayer) {
          this._spawnPlayer(guildId, homeChannelId).catch(e =>
              logger.warn("[leave] 247 rejoin failed for", homeChannelId, e.message)
          );
        }
      }, rejoinDelay);
    } else {
      msg.reply(this.t(msg, "responses.leave.left247On", { prefix }));
    }
  } else {
    await this.leaveChannel(activeChannelId, guildId, msg);
  }
}
