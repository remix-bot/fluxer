import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

export const command = new CommandBuilder()
    .setName("join")
    .setDescription("Make the bot join your voice channel, or specify one.")
    .setId("join")
    .setCategory("music")
    .addTextOption(option =>
        option.setName("channel")
            .setDescription("A voice channel mention, ID, or name to join.")
            .setRequired(false)
    );

export async function run(message, data) {
  const rawArg = data?.get?.("channel")?.value?.trim?.() ?? null;

  if (rawArg) {
    // Parse channel mention, ID, or name
    const mentionMatch = rawArg.match(/^<#(\d+)>$/);
    const idMatch      = rawArg.match(/^(\d{15,})$/);
    let resolvedId     = null;

    if (mentionMatch) {
      resolvedId = mentionMatch[1];
    } else if (idMatch) {
      resolvedId = idMatch[1];
    } else {
      // Lookup by name
      const serverId = message.channel?.server_id ?? message.channel?.serverId;
      const allChannels = [
        ...(this._commands?.client?.channels?.values?.() ??
            this._commands?.client?.channels?.cache?.values?.() ??
            this.client?.channels?.values?.() ??
            this.client?.channels?.cache?.values?.() ?? [])
      ];
      const match = allChannels.find(c => {
        const cServerId = c.server_id ?? c.serverId ?? c.guildId;
        const isVoice   = c.channel_type === "VoiceChannel" || c.type === "VoiceChannel" || c.type === 2;
        return isVoice && cServerId === serverId &&
            (c.name?.toLowerCase() === rawArg.toLowerCase());
      });
      if (match) resolvedId = match._id ?? match.id;
    }

    if (!resolvedId) {
      const embed = new EmbedBuilder().setColor(getGlobalColor())
          .setDescription("❌ Couldn't find that voice channel.")
          .toJSON();
      return message.replyEmbed({ embeds: [embed] });
    }

    return this.players.initPlayer(message, resolvedId);
  }

  // No argument — auto-detect (CRITICAL: must await here)
  const cid = await this.players.checkVoiceChannels(message);

  if (!cid) {
    const prefix = this._commands?.getPrefix?.(message.channel?.guild?.id ?? message.channel?.server_id ?? message.channel?.serverId) ?? "%";
    const embed = new EmbedBuilder().setColor(getGlobalColor())
        .setDescription(`❌ You're not in a voice channel. Please join one first, or specify a channel: \`${prefix}join <#channel>\``)
        .toJSON();
    return message.replyEmbed({ embeds: [embed] });
  }

  this.players.initPlayer(message, cid);
}