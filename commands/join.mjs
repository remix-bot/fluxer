/**
 * @module commands/join
 * @description Makes the bot join a voice channel. Supports explicit channel argument
 * (mention, ID, or name) or auto-detects the user’s current voice channel.
 * All player spawning goes through PlayerManager.initPlayer() for consistent
 * 24/7 handling, event binding, and permission checks.
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor, cleanId, getMessageGuildId } from "../src/MessageHandler.mjs";

/**
 * @type {CommandBuilder}
 * @description Command definition for the join command.
 */
export const command = new CommandBuilder()
    .setName("join")
    .setDescription("Make the bot join your voice channel, or specify one.", "commands.join")
    .setId("join")
    .setCategory("music")
    .addTextOption(option =>
        option.setName("channel")
            .setDescription("A voice channel mention, ID, or name to join. Defaults to your current channel.")
            .setRequired(false)
    );

/**
 * Resolve a user-provided channel string to a channel ID.
 * Supports <#ID> mentions, raw numeric IDs, and channel name matching.
 *
 * @param {string} rawArg - The raw argument string from the command.
 * @param {object} ctx - The bot context (Remix instance).
 * @param {object} message - The command message (used to resolve the guild ID for name lookups).
 * @returns {string|null} The resolved channel ID, or null if not found.
 */
function resolveChannelId(rawArg, ctx, message) {
  if (!rawArg) return null;
  const mentionMatch = rawArg.match(/^<(#|&)?(\d+)>$/);
  const idMatch = rawArg.match(/^(\d{15,})$/);

  if (mentionMatch) return mentionMatch[2];
  if (idMatch) return idMatch[1];

  // Try name-based lookup — use the actual message to resolve the guild ID
  const guildId = cleanId(getMessageGuildId(message));
  if (!guildId) return null;

  const allChannels = [...(ctx.client?.channels?.values?.() ?? [])];
  const match = allChannels.find(c => {
    const cServerId = cleanId(c.guildId ?? c.guild?.id ?? c.server_id ?? c.serverId);
    return c.type === 2 && cServerId === guildId && c.name?.toLowerCase() === rawArg.toLowerCase();
  });
  return match?.id ?? null;
}

/**
 * Run handler for the join command.
 * Resolves the target voice channel and delegates to PlayerManager.initPlayer().
 *
 * @param {object} message - The command message wrapper.
 * @param {object} data - Parsed command data containing option values.
 * @returns {Promise<Player|null>} The spawned player, or null on failure.
 */
export async function run(message, data) {
  const rawArg = data?.get?.("channel")?.value?.trim?.() ?? null;

  if (rawArg) {
    const resolvedId = resolveChannelId(rawArg, this, message);
    if (!resolvedId) {
      const embed = new EmbedBuilder().setColor(getGlobalColor())
          .setDescription(this.t(message, "responses.join.voiceChannelNotFound"));
      return message.reply({ embeds: [embed] });
    }
    return this.players.initPlayer(message, resolvedId);
  }

  // No argument — auto-detect the user's current voice channel
  const { channelId: cid } = await this.players.checkVoiceChannels(message);
  if (!cid) {
    const prefix = this.handler.getPrefix(getMessageGuildId(message));
    const embed = new EmbedBuilder().setColor(getGlobalColor())
        .setDescription(this.t(message, "responses.join.noVoiceChannel", { prefix }));
    return message.reply({ embeds: [embed] });
  }

  return this.players.initPlayer(message, cid);
}
