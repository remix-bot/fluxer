import { CommandBuilder } from "../src/CommandHandler.mjs";
import { logger } from "../src/constants/Logger.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";
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

function embed(desc) {
  return { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(desc)] };
}

function cleanId(value) {
  return String(value ?? "").replace(/\D/g, "");
}

/**
 * Resolve the guild ID from a player entry.
 * Uses _guildId if set (populated after join() completes), otherwise falls
 * back to the client channel cache. This is necessary because in the
 * multi-voice scenario _guildId can still be null for a freshly-joined player,
 * which caused guildPlayers to be empty and leave to report "not in voice".
 */
function resolvePlayerGuildId(player, mapKey, client) {
  const direct = cleanId(player?._guildId);
  if (direct) return direct;
  const cid = cleanId(player?._channelId ?? mapKey);
  if (!cid) return "";
  const ch = client?.channels?.get?.(cid);
  return cleanId(ch?.guildId ?? ch?.guild?.id ?? ch?.server_id ?? ch?.serverId);
}

export async function run(msg, data) {
  const guildId = msg.channel?.guild?.id
      ?? msg.channel?.guildId
      ?? msg.channel?.server_id
      ?? msg.channel?.serverId
      ?? msg.message?.guildId
      ?? msg.message?.server_id
      ?? msg.message?.serverId;
  const cleanGuildId = cleanId(guildId);

  // Gather all active players in this guild.
  // resolvePlayerGuildId handles players whose _guildId is still null by
  // checking the channel cache — critical for the multi-voice use case where
  // a player may have been joined before _guildId was written.
  const client = this.client;
  const guildPlayers = [...this.players.playerMap.entries()].filter(([mapKey, p]) => {
    if (p?._destroyed) return false;
    return resolvePlayerGuildId(p, mapKey, client) === cleanGuildId;
  });

  // Resolve the target channel to leave:
  // 1. If a channel option was provided, use that
  // 2. Otherwise, use the user's current voice channel
  const specifiedChannel = data?.get("channel")?.value;
  let targetChannelId = null;

  if (specifiedChannel) {
    targetChannelId = cleanId(specifiedChannel);
  } else {
    const userChannelId = this.players.checkVoiceChannels(msg);
    if (userChannelId) targetChannelId = cleanId(userChannelId);
  }

  // If we still don't have a target channel
  if (!targetChannelId) {
    if (guildPlayers.length === 0) {
      return msg.reply(embed(this.t(msg, "responses.leave.notInVoice")));
    }
    // User not in voice and no channel specified — list all channels the bot is in
    const channelList = guildPlayers.map(([mapKey, p]) => {
      const id = cleanId(p._channelId ?? mapKey);
      return id ? `<#${id}>` : "`unknown`";
    });
    return msg.reply(embed(
        this.t(msg, "responses.leave.specifyChannel", {
          channels: channelList.map(c => `• ${c}`).join("\n"),
          prefix: this.getSettings(msg)?.get("prefix") ?? "%"
        })
    ));
  }

  // Find the player for the target channel.
  // Match against both the map key and _channelId because after a voice-move
  // these can differ (the map key stays as the original join channel ID while
  // _channelId updates to the new channel).
  const player = this.players.playerMap.get(targetChannelId)
      ?? guildPlayers.find(([mapKey, p]) =>
          cleanId(p._channelId) === targetChannelId || cleanId(mapKey) === targetChannelId
      )?.[1]
      ?? null;

  if (!player) {
    // No player in that channel — check if user picked a non-voice channel
    if (guildPlayers.length === 0) {
      return msg.reply(embed(this.t(msg, "responses.leave.notInVoice")));
    }
    const channelList = guildPlayers.map(([mapKey, p]) => {
      const id = cleanId(p._channelId ?? mapKey);
      return id ? `<#${id}>` : "`unknown`";
    });
    return msg.reply(embed(
        this.t(msg, "responses.leave.noPlayerInChannel", {
          channel: `<#${targetChannelId}>`,
          channels: channelList.map(c => `• ${c}`).join("\n")
        })
    ));
  }

  if (!player?.connection) return msg.reply(embed(this.t(msg, "responses.leave.playerNotInit")));

  const activeChannelId = cleanId(player._channelId) || targetChannelId;
  const homeChannelId = cleanId(player._home247Channel) || activeChannelId;

  // ── 24/7 handling ────────────────────────────────────────────────────────
  const set = this.getSettings(msg);
  const raw = set?.get("stay_247");
  const ch247 = (!raw || raw === "none")
      ? new Set()
      : Array.isArray(raw)
          ? new Set(raw.map(id => cleanId(id)).filter(Boolean))
          : new Set([cleanId(raw)]);

  if (ch247.has(activeChannelId) || ch247.has(homeChannelId)) {
    const matchChannel = ch247.has(homeChannelId) ? homeChannelId
        : ch247.has(activeChannelId) ? activeChannelId
        : null;
    const mode = matchChannel ? get247ChannelMode(set, matchChannel) : "off";
    this.markIntentionalLeave(activeChannelId);
    this.players.playerMap.delete(activeChannelId);
    if (activeChannelId !== targetChannelId) this.players.playerMap.delete(targetChannelId);
    if (homeChannelId !== activeChannelId) this.players.playerMap.delete(homeChannelId);
    await player.leave().catch(() => {});
    player.destroy();

    if (mode === "auto") {
      msg.reply(embed(this.t(msg, "responses.leave.leftRejoin247", { channel: targetChannelId })));
      const leave247Delay = this.config?.timers?.leave247RejoinDelay ?? 5000;
      setTimeout(() => {
        if (this._spawnPlayer) {
          this._spawnPlayer(guildId, homeChannelId).catch(e =>
              logger.warn("[leave] 247 rejoin failed for", homeChannelId, e.message)
          );
        }
      }, leave247Delay);
    } else {
      msg.reply(embed(this.t(msg, "responses.leave.left247On")));
    }
  } else {
    await this.leaveChannel(activeChannelId, guildId, msg);
  }
}
