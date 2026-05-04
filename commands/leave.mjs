import { CommandBuilder } from "../src/CommandHandler.mjs";
import { logger } from "../src/constants/Logger.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

export const command = new CommandBuilder()
    .setName("leave")
    .setDescription("Make the bot leave your current voice channel", "commands.leave")
    .addAliases("l", "stop")
    .setCategory("music");

function embed(desc) {
  return { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(desc).toJSON()] };
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
  if (!userChannelId) return msg.replyEmbed(embed("⚠️ Please join a voice channel first."));

  const cid = String(userChannelId).replace(/\D/g, "");
  const cleanGuildId = String(guildId ?? "").replace(/\D/g, "");

  const player = this.players.playerMap.get(cid)
      ?? [...this.players.playerMap.values()].find(p =>
        String(p?._channelId ?? "").replace(/\D/g, "") === cid
      );

  if (!player) {
    const guildChannels = [...this.players.playerMap.entries()]
        .filter(([, p]) => String(p?._guildId ?? "").replace(/\D/g, "") === cleanGuildId)
        .map(([chId, p]) => `<#${String(p?._channelId ?? chId).replace(/\D/g, "")}>`);

    if (guildChannels.length === 0) return msg.replyEmbed(embed("I'm not in a voice channel."));
    if (guildChannels.length === 1) return msg.replyEmbed(embed(`⚠️ Please join ${guildChannels[0]} to use this command.`));
    return msg.replyEmbed(embed(
        `⚠️ I'm playing in multiple channels! Please join one of them:\n` +
        guildChannels.map(c => `• ${c}`).join("\n")
    ));
  }

  if (!player?.connection) return msg.replyEmbed(embed("Player not initialized."));
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
    const mode = set?.get("stay_247_mode") ?? "auto";
    this.markIntentionalLeave(activeChannelId);
    this.players.playerMap.delete(activeChannelId);
    if (activeChannelId !== cid) this.players.playerMap.delete(cid);
    if (homeChannelId !== activeChannelId) this.players.playerMap.delete(homeChannelId);
    await player.leave().catch(() => {});
    player.destroy();

    if (mode === "auto") {
      msg.replyEmbed(embed(`✅ Successfully Left — rejoining <#${cid}> in 5 seconds.\nTo disable 24/7 mode permanently, use \`%247 off\`.`));
      const leave247Delay = this.config?.timers?.leave247RejoinDelay ?? 5000;
      setTimeout(() => {
        if (this._spawnPlayer) {
          this._spawnPlayer(guildId, homeChannelId).catch(e =>
              logger.warn("[leave] 247 rejoin failed for", homeChannelId, e.message)
          );
        }
      }, leave247Delay);
    } else {
      msg.replyEmbed(embed(`✅ Successfully Left.\nℹ️ 24/7 mode is **on** — bot won't rejoin automatically. Use \`%play\` to bring it back, or \`%247 off\` to fully disable.`));
    }
  } else {
    await this.leaveChannel(activeChannelId, guildId, msg);
  }
}
