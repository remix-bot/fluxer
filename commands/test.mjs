import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

export const command = new CommandBuilder()
  .setName("test")
  .setDescription("Shows how many people are in each voice channel.")
  .setRequirement(r => r.setOwnerOnly(true));

export async function run(msg, data) {
  const guild = msg.channel?.channel?.guild ?? msg.message?.guild;
  if (!guild) {
    const embed = new EmbedBuilder().setColor(getGlobalColor()).setDescription("❌ Must be used in a server.").toJSON();
    return msg.replyEmbed({ embeds: [embed] });
  }

  const channelCounts = new Map();

  for (const [, state] of this.observedVoiceUsers) {
    if (state.guildId !== guild.id) continue;
    channelCounts.set(state.channelId, (channelCounts.get(state.channelId) ?? 0) + 1);
  }
  for (const [, state] of this.observedVoiceBots) {
    if (state.guildId !== guild.id) continue;
    channelCounts.set(state.channelId, (channelCounts.get(state.channelId) ?? 0) + 1);
  }

  if (channelCounts.size === 0) {
    const embed = new EmbedBuilder().setColor(getGlobalColor()).setDescription("No one is in voice.").toJSON();
    return msg.replyEmbed({ embeds: [embed] });
  }

  const getChannelName = async (channelId) => {
    const cached = this.client.channels.cache.get(channelId);
    if (cached?.name) return cached.name;
    const guildCached = guild.channels?.cache?.get?.(channelId) ?? guild.channels?.get?.(channelId);
    if (guildCached?.name) return guildCached.name;
    if (guild.channels) {
      const all = typeof guild.channels.values === "function"
        ? [...guild.channels.values()] : Object.values(guild.channels);
      const found = all.find(c => (c.id ?? c.channel_id) === channelId);
      if (found?.name) return found.name;
    }
    try {
      const fetched = await this.client.channels.fetch(channelId);
      if (fetched?.name) return fetched.name;
    } catch (_) {}
    return `Unknown (${channelId})`;
  };

  let desc = "";
  for (const [channelId, total] of channelCounts) {
    const name = await getChannelName(channelId);
    desc += `🔊 **${name}**: ${total} member${total !== 1 ? "s" : ""}\n`;
  }

  const embed = new EmbedBuilder()
    .setColor(getGlobalColor())
    .setTitle("🎙️ Voice Channel Members")
    .setDescription(desc.trim())
    .toJSON();
  msg.replyEmbed({ embeds: [embed] });
}
