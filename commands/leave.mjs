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
  const guildId = msg.channel?.guild?.id ?? msg.message?.guildId;

  const userChannelId = this.players.checkVoiceChannels(msg);
  if (!userChannelId) return msg.replyEmbed(embed("⚠️ Please join a voice channel first."));

  const cid = String(userChannelId).replace(/\D/g, "");

  if (!this.players.playerMap.has(cid)) {
    const guildChannels = [...this.players.playerMap.entries()]
        .filter(([chId, p]) => p._guildId === guildId)
        .map(([chId]) => `<#${chId}>`);

    if (guildChannels.length === 0) return msg.replyEmbed(embed("I'm not in a voice channel."));
    if (guildChannels.length === 1) return msg.replyEmbed(embed(`⚠️ Please join ${guildChannels[0]} to use this command.`));
    return msg.replyEmbed(embed(
        `⚠️ I'm playing in multiple channels! Please join one of them:\n` +
        guildChannels.map(c => `• ${c}`).join("\n")
    ));
  }

  const player = this.players.playerMap.get(cid);
  if (!player?.connection) return msg.replyEmbed(embed("Player not initialized."));

  const set   = this.getSettings(msg);
  const raw   = set?.get("stay_247");
  const ch247 = (!raw || raw === "none")
      ? new Set()
      : Array.isArray(raw)
          ? new Set(raw.map(id => String(id).replace(/\D/g, "")).filter(Boolean))
          : new Set([String(raw).replace(/\D/g, "")]);

  if (ch247.has(cid)) {
    const mode = set?.get("stay_247_mode") ?? "auto";
    this.markIntentionalLeave(cid);
    this.players.playerMap.delete(cid);
    await player.leave().catch(() => {});
    player.destroy();

    if (mode === "auto") {
      msg.replyEmbed(embed(`✅ Successfully Left — rejoining <#${cid}> in 5 seconds.\nTo disable 24/7 mode permanently, use \`%247 off\`.`));
      const leave247Delay = this.config?.timers?.leave247RejoinDelay ?? 5000;
      setTimeout(() => {
        if (this._spawnPlayer) {
          this._spawnPlayer(guildId, cid).catch(e =>
              logger.warn("[leave] 247 rejoin failed for", cid, e.message)
          );
        }
      }, leave247Delay);
    } else {
      msg.replyEmbed(embed(`✅ Successfully Left.\nℹ️ 24/7 mode is **on** — bot won't rejoin automatically. Use \`%play\` to bring it back, or \`%247 off\` to fully disable.`));
    }
  } else {
    await this.leaveChannel(cid, guildId, msg);
  }
}
