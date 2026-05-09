import { CommandBuilder } from "../src/CommandHandler.mjs";
import { logger } from "../src/constants/Logger.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";
import { get247ChannelMode } from "../src/constants/Helpers247.mjs";

export const command = new CommandBuilder()
    .setName("leave")
    .setDescription("Make the bot leave your current voice channel", "commands.leave")
    .addAliases("l", "stop")
    .setCategory("music");

function embed(desc) {
  return { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(desc)] };
}

export async function run(msg) {
  const guildId = msg.channel?.guild?.id
      ?? msg.channel?.guildId
      ?? msg.channel?.server_id
      ?? msg.channel?.serverId
      ?? msg.message?.guildId
      ?? msg.message?.server_id
      ?? msg.message?.serverId;

  const userChannelId = this.players.checkVoiceChannels(msg);
  if (!userChannelId) return msg.reply(embed(this.t(msg, "responses.leave.noVoiceChannel")));

  const cid = String(userChannelId).replace(/\D/g, "");
  const cleanGuildId = String(guildId ?? "").replace(/\D/g, "");
  const guildPlayers = [...this.players.playerMap.values()].filter(p =>
    String(p?._guildId ?? "").replace(/\D/g, "") === cleanGuildId &&
    !p?._destroyed
  );

  const player = this.players.playerMap.get(cid)
      ?? [...this.players.playerMap.values()].find(p =>
        String(p?._channelId ?? "").replace(/\D/g, "") === cid
      )
      ?? (guildPlayers.length === 1 ? guildPlayers[0] : null);

  if (!player) {
    const guildChannels = guildPlayers.map((p) => {
      const liveId = String(p?._channelId ?? "").replace(/\D/g, "");
      return liveId ? `<#${liveId}>` : "`unknown voice channel`";
    });

    if (guildChannels.length === 0) return msg.reply(embed(this.t(msg, "responses.leave.notInVoice")));
    if (guildChannels.length === 1) return msg.reply(embed(this.t(msg, "responses.leave.joinChannel", { channel: guildChannels[0] })));
    return msg.reply(embed(
        this.t(msg, "responses.leave.multipleChannels", { channels: guildChannels.map(c => `• ${c}`).join("\n") })
    ));
  }

  if (!player?.connection) return msg.reply(embed(this.t(msg, "responses.leave.playerNotInit")));
  const activeChannelId = String(player._channelId ?? cid).replace(/\D/g, "") || cid;
  const homeChannelId = String(player._home247Channel ?? activeChannelId).replace(/\D/g, "") || activeChannelId;

  const set   = this.getSettings(msg);
  const raw   = set?.get("stay_247");
  const ch247 = (!raw || raw === "none")
      ? new Set()
      : Array.isArray(raw)
          ? new Set(raw.map(id => String(id).replace(/\D/g, "")).filter(Boolean))
          : new Set([String(raw).replace(/\D/g, "")]);

  if (ch247.has(activeChannelId) || ch247.has(homeChannelId)) {
    const matchChannel = ch247.has(homeChannelId) ? homeChannelId
        : ch247.has(activeChannelId) ? activeChannelId
        : null;
    const mode = matchChannel ? get247ChannelMode(set, matchChannel) : "off";
    this.markIntentionalLeave(activeChannelId);
    this.players.playerMap.delete(activeChannelId);
    if (activeChannelId !== cid) this.players.playerMap.delete(cid);
    if (homeChannelId !== activeChannelId) this.players.playerMap.delete(homeChannelId);
    await player.leave().catch(() => {});
    player.destroy();

    if (mode === "auto") {
      msg.reply(embed(this.t(msg, "responses.leave.leftRejoin247", { channel: cid })));
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
