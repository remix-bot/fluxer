/**
 * @module commands/test
 * @description Owner-only diagnostic command to display voice channel user counts.
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";
import { logger } from "../src/constants/Logger.mjs";

/** @type {CommandBuilder} @description Command definition for the test command (owner-only). */
export const command = new CommandBuilder()
  .setName("test")
  .setDescription("Shows how many people are in each voice channel.")
  .setCategory("util")
  .setRequirement(r => r.setOwnerOnly(true));

/**
 * @async
 * Run handler for the test command.
 * Iterates the voice state cache and reports user counts per voice channel.
 * @param {object} msg - The command message wrapper.
 * @param {object} data - Parsed command data (unused).
 * @returns {Promise<void>}
 */
export async function run(msg, data) {
  const guild = msg.channel?.channel?.guild ?? msg.message?.guild;
  if (!guild) {
    const embed = new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.test.notInServer"));
    return msg.reply({ embeds: [embed] });
  }

  const channelCounts = new Map();

  const cache = this.voiceCache ?? this.observedVoiceUsers;
  if (cache) {
    if (typeof cache.iterateHumanUsers === "function") {
      for (const [, state] of cache.iterateHumanUsers()) {
        if (state.guildId !== guild.id) continue;
        channelCounts.set(state.channelId, (channelCounts.get(state.channelId) ?? 0) + 1);
      }
    } else {
      for (const [, state] of cache) {
        if (state.guildId !== guild.id) continue;
        channelCounts.set(state.channelId, (channelCounts.get(state.channelId) ?? 0) + 1);
      }
    }
    if (typeof cache.iterateBotUsers === "function") {
      for (const [, state] of cache.iterateBotUsers()) {
        if (state.guildId !== guild.id) continue;
        channelCounts.set(state.channelId, (channelCounts.get(state.channelId) ?? 0) + 1);
      }
    }
  }

  if (channelCounts.size === 0) {
    const embed = new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.test.noOneInVoice"));
    return msg.reply({ embeds: [embed] });
  }

  /**
   * @private
   * Resolve a channel ID to a human-readable channel name.
   * Tries cache, guild cache, then REST fetch as fallback.
   * @param {string} channelId - The voice channel ID.
   * @returns {Promise<string>} The channel name or a fallback string.
   */
  const getChannelName = async (channelId) => {
    const cached = this.client.channels.get(channelId);
    if (cached?.name) return cached.name;
    const guildCached = guild.channels?.get?.(channelId);
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
    } catch(e) { logger.warn("[Test] Error:", e?.message); }
    return `Unknown (${channelId})`;
  };

  let desc = "";
  for (const [channelId, total] of channelCounts) {
    const name = await getChannelName(channelId);
    const entry = this.t(msg, "responses.test.channelEntry", { name, count: total });
    if (desc.length + entry.length > 4080) break;
    desc += entry;
  }

  const embed = new EmbedBuilder()
    .setColor(getGlobalColor())
    .setTitle(this.t(msg, "responses.test.title"))
    .setDescription(desc.trim().slice(0, 4096))
    ;
  msg.reply({ embeds: [embed] }).catch(() => {});
}
