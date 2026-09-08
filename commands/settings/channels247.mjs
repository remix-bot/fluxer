/**
 * @module commands/settings/channels247
 * @description 24/7 channel storage, panel
 * rendering and enable/disable/toggle handling for the settings command.
 * Bodies are verbatim from the original single-file command.
 */


import { cleanId } from "../../src/ui/index.mjs";
import { isValidFluxerId, MAX_247_CHANNELS, embed, tWrap } from "./utils.mjs";

/**
 * Parse the stay_247 setting into a Set of validated channel IDs.
 * @param {ServerSettings} set - The guild settings instance.
 * @returns {Set<string>} Set of cleaned, valid channel IDs.
 */
export function get247Channels(set) {
  const raw = set.get("stay_247");
  if (!raw || raw === "none") return new Set();
  if (typeof raw === "string") {
    const id = cleanId(raw);
    return (id && isValidFluxerId(id)) ? new Set([id]) : new Set();
  }
  if (Array.isArray(raw)) {
    return new Set(raw.map(id => cleanId(id)).filter(id => id && isValidFluxerId(id)));
  }
  return new Set();
}
/**
 * Save a Set of channel IDs back to the stay_247 setting.
 * Writes 'none' if the set is empty.
 * @param {ServerSettings} set - The guild settings instance.
 * @param {Set<string>} channels - The channel IDs to save.
 */
export function save247Channels(set, channels) {
  const arr = [...channels].filter(id => id && isValidFluxerId(id));
  set.set("stay_247", arr.length > 0 ? arr : "none");
}
/**
 * @private
 * Resolve a channel ID to a human-readable channel name from the client cache.
 * @param {import('@fluxerjs/core').Client} client - The Fluxer client.
 * @param {string} channelId - The channel ID to look up.
 * @returns {string|null} The channel name, or null if not found.
 */
function resolveChannelName(client, channelId) {
  try {
    const ch = client?.channels?.get?.(channelId);
    if (ch?.name) return ch.name;
  } catch (_) {}
  return null;
}

/**
 * Build an embed payload showing the current 24/7 status for the guild.
 * @param {ServerSettings} set - The guild settings instance.
 * @param {object} ctx - The bot (Remix) context.
 * @param {string} guildId - The guild ID.
 * @param {string|null} channelId - The channel ID (for active indicator), or null.
 * @returns {object} Embed payload object for message.reply().
 */
export function build247Panel(set, ctx, guildId, channelId) {
  const channels = [...get247Channels(set)];
  const prefix = ctx.handler.getPrefix(guildId);

  if (channels.length > 0) {
    const lines = channels.map(id => {
      const name = resolveChannelName(ctx.client, id);
      const isActive = id === channelId;
      return (isActive ? "\u25b6 " : "\u2022 ") + (name ? "**" + name + "** " : "") + "<#" + id + ">";
    });
    return embed(
      channels.length === 1 && channelId
        ? "\u2705 24/7 is now **enabled** in <#" + channelId + ">\n\n" +
          "The bot will stay connected and auto-rejoin if disconnected."
        : "\u2705 24/7 active in " + channels.length + " channel(s):\n\n" + lines.join("\n"),
      { title: "\u2705 24/7 Mode" }
    );
  }

  return embed(
    "\u274c 24/7 is **disabled**\n\n" +
    "The bot will leave voice channels when idle.\n\n" +
    "Join a voice channel and use `" + prefix + "247` to enable.",
    { title: "\u274c 24/7 Mode" }
  );
}
/**
 * Disable 24/7 mode for a specific channel.
 * Removes the channel from stay_247, marks intentional leave, and destroys the player.
 * @param {object} ctx - The bot (Remix) context.
 * @param {ServerSettings} set - The guild settings instance.
 * @param {string} guildId - The guild ID.
 * @param {string} channelId - The channel ID to disable.
 * @returns {Promise<void>}
 */
export async function disable247(ctx, set, guildId, channelId) {
  const id = cleanId(channelId);
  const channels = get247Channels(set);
  channels.delete(id);
  save247Channels(set, channels);
  ctx.markIntentionalLeave?.(id);
  const player = ctx.players.playerMap.get(id)
      ?? [...ctx.players.playerMap.values()].find(p =>
        cleanId(p?._channelId ?? "") === id &&
        cleanId(p?._guildId ?? "") === cleanId(guildId)
      );
  if (player) {
    const activeId = cleanId(player._channelId ?? id);
    ctx.players.playerMap.delete(activeId);
    if (activeId !== id) ctx.players.playerMap.delete(id);
    await player.leave().catch(() => {});
    player.destroy();
  }
}
/**
 * Enable 24/7 mode for a specific channel.
 * Enforces MAX_247_CHANNELS (1) by disabling any existing 24/7 channel first,
 * then saves the new channel and spawns a player if none exists.
 * @param {object} ctx - The bot (Remix) context.
 * @param {ServerSettings} set - The guild settings instance.
 * @param {string} guildId - The guild ID.
 * @param {string} channelId - The channel ID to enable.
 * @returns {Promise<void>}
 */
async function enable247(ctx, set, guildId, channelId) {
  const id = cleanId(channelId);
  const channels = get247Channels(set);
  if (channels.has(id)) return;

  // Platform only supports 1 voice channel per bot per guild.
  // If another channel already has 24/7, disable it first.
  if (channels.size >= MAX_247_CHANNELS) {
    for (const oldId of channels) {
      if (oldId !== id) {
        ctx.markIntentionalLeave?.(oldId);
        const oldPlayer = ctx.players.playerMap.get(oldId)
            ?? [...ctx.players.playerMap.values()].find(p =>
              cleanId(p?._channelId ?? "") === oldId &&
              cleanId(p?._guildId ?? "") === cleanId(guildId)
            );
        if (oldPlayer) {
          const activeId = cleanId(oldPlayer._channelId ?? oldId);
          ctx.players.playerMap.delete(activeId);
          if (activeId !== oldId) ctx.players.playerMap.delete(oldId);
          await oldPlayer.leave().catch(() => {});
          oldPlayer.destroy();
        }
        channels.delete(oldId);
      }
    }
  }

  channels.add(id);
  save247Channels(set, channels);
  const playerExists = ctx.players.playerMap.has(id) ||
      [...ctx.players.playerMap.values()].some(p =>
        cleanId(p?._channelId ?? "") === id && cleanId(p?._guildId ?? "") === cleanId(guildId)
      );
  if (!playerExists) {
    try { await ctx._spawnPlayer(guildId, id); } catch (_) {}
  }
}
/**
 * Handle the !247 toggle command. If the user is in a 24/7 channel, disable it;
 * otherwise, enable it for the user's current voice channel.
 * @param {object} ctx - The bot (Remix) context.
 * @param {object} message - The command message.
 * @param {ServerSettings} set - The guild settings instance.
 * @param {string} guildId - The guild ID.
 * @returns {Promise<void>}
 */
export async function handle247Toggle(ctx, message, set, guildId) {
  const loc = tWrap(ctx, guildId);
  if (!guildId) return message.reply(embed(loc("responses.settings.noServer")));

  const { channelId: userChannelId } = await ctx.players.checkVoiceChannels(message);
  if (!userChannelId) {
    return message.reply(build247Panel(set, ctx, guildId, null));
  }

  const id = cleanId(userChannelId);
  const channels = get247Channels(set);

  if (channels.has(id)) {
    await disable247(ctx, set, guildId, userChannelId);
    return message.reply(build247Panel(set, ctx, guildId, id));
  }

  const result = await enable247(ctx, set, guildId, userChannelId);
  if (result?.max) {
    return message.reply(embed(
      loc("responses.settings.max247Channels", { max: MAX_247_CHANNELS, prefix: ctx.handler.getPrefix(guildId) })
    ));
  }

  return message.reply(build247Panel(set, ctx, guildId, id));
}
