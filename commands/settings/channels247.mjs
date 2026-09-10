/**
 * @module commands/settings/channels247
 * @description 24/7 channel storage, live-status panel rendering and
 * enable/disable/toggle handling for the settings command.
 *
 * The panel is localized (falls back to the default locale) and shows the
 * LIVE state of every saved channel:
 *    Connected   — a healthy player is attached
 *    Reconnecting — a bot-level rejoin is armed right now
 *    Offline      — no player; the watchdog sweep will re-arm a rejoin
 * plus the auto-recovery line so users can see the watchdog is watching.
 */


import { cleanId } from "../../src/ui/index.mjs";
import { isPlayerConnectionDead } from "../../src/utils/Helpers247.mjs";
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
 * Writes 'none' if the set is empty. The settings manager persists
 * stay_247 changes immediately (no debounce window) — see Settings.mjs.
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
 * @private
 * Live status of one saved 24/7 channel.
 * @param {object} ctx - The bot (Remix) context.
 * @param {string} guildId - The guild ID.
 * @param {string} channelId - The saved channel ID.
 * @param {object} t - Panel translation function.
 * @returns {{line: string, state: "connected"|"reconnecting"|"offline", order: number}}
 */
function channelStatus(ctx, guildId, channelId, t) {
  const player = ctx.players?.playerMap?.get(channelId)
      ?? [...(ctx.players?.playerMap?.values() ?? [])].find(p =>
        cleanId(p?._channelId ?? "") === channelId &&
        cleanId(p?._guildId ?? "") === cleanId(guildId)
      );

  const rejoinArmed = ctx._247RejoinTimers?.has?.(cleanId(channelId)) === true;
  const name = resolveChannelName(ctx.client, channelId);

  if (player && !isPlayerConnectionDead(player)) {
    return {
      state: "connected", order: 0,
      line: t("responses.settings.247Panel.statusConnected") + "  " +
            (name ? "**" + name + "** " : "") + "<#" + channelId + ">",
    };
  }
  if (rejoinArmed || player?._isJoining) {
    return {
      state: "reconnecting", order: 1,
      line: t("responses.settings.247Panel.statusReconnecting") + "  " +
            (name ? "**" + name + "** " : "") + "<#" + channelId + ">",
    };
  }
  return {
    state: "offline", order: 2,
    line: t("responses.settings.247Panel.statusOffline") + "  " +
          (name ? "**" + name + "** " : "") + "<#" + channelId + ">",
  };
}

/**
 * @private
 * Build the panel description text (localized, live status) without the
 * embed wrapper so callers can compose confirmations around it.
 * @param {ServerSettings} set - The guild settings instance.
 * @param {object} ctx - The bot (Remix) context.
 * @param {string} guildId - The guild ID.
 * @param {string|null} [justToggledId=null] - Channel just toggled (marked ←).
 * @returns {string} Description text for the panel embed.
 */
function build247PanelDescription(set, ctx, guildId, justToggledId = null) {
  const t = tWrap(ctx, guildId);
  const prefix = ctx.handler.getPrefix(guildId);
  const channels = [...get247Channels(set)];
  const panelKey = (k, vars = {}) => t("responses.settings.247Panel." + k, vars);

  const watchdog = ctx.gatewayHandler;
  const watchdogOn = watchdog?.isWatchdog247Running?.() === true;
  const sweepSeconds = Math.round((watchdog?._247WatchdogInterval ?? 60_000) / 1000);
  const recoveryLine = watchdogOn
      ? panelKey("autoRecoveryLine", { seconds: sweepSeconds })
      : panelKey("autoRecoveryDisabledLine");

  if (channels.length === 0) {
    return "\u274C 24/7 is **disabled**\n\n" +
        panelKey("allChannelsDisabled") + "\n\n" +
        panelKey("disabledHint", { prefix }) + "\n\n" +
        recoveryLine;
  }

  const statuses = channels
      .map(id => channelStatus(ctx, guildId, id, t))
      .sort((a, b) => a.order - b.order);

  const lines = statuses.map(s =>
    s.line + (justToggledId && s.line.includes("<#" + cleanId(justToggledId) + ">") ? " \u2190" : "")
  );

  const allConnected = statuses.every(s => s.state === "connected");

  return (channels.length === 1 && allConnected
          ? panelKey("enabledLine") + "\n\n"
          : "\u2705 24/7 active in " + channels.length + " channel(s):\n\n") +
      lines.join("\n") +
      "\n\n" + recoveryLine;
}

/**
 * Build a localized, live-status embed showing the current 24/7 state for
 * the guild: every saved channel with its connection state, plus the
 * auto-recovery line.
 * @param {ServerSettings} set - The guild settings instance.
 * @param {object} ctx - The bot (Remix) context.
 * @param {string} guildId - The guild ID.
 * @param {string|null} [justToggledId=null] - Channel that was just toggled
 *        (surfaced first and marked with ←).
 * @returns {object} Embed payload object for message.reply().
 */
export function build247Panel(set, ctx, guildId, justToggledId = null) {
  const t = tWrap(ctx, guildId);
  const prefix = ctx.handler.getPrefix(guildId);
  const panelKey = (k, vars = {}) => t("responses.settings.247Panel." + k, vars);
  return embed(
      build247PanelDescription(set, ctx, guildId, justToggledId),
      { title: panelKey("title"), footer: panelKey("footerLine", { prefix }) }
  );
}
/**
 * Disable 24/7 mode for a specific channel.
 * Removes the channel from stay_247, marks intentional leave (cancels any
 * armed rejoin), and destroys the player.
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
  ctx.cancel247Rejoin?.(id);
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

  if (channels.size >= MAX_247_CHANNELS) {
    for (const oldId of channels) {
      if (oldId !== id) {
        ctx.cancel247Rejoin?.(oldId);
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
 * otherwise, enable it for the user's current voice channel. Replies with an
 * explicit confirmation line plus the live-status panel.
 * @param {object} ctx - The bot (Remix) context.
 * @param {object} message - The command message.
 * @param {ServerSettings} set - The guild settings instance.
 * @param {string} guildId - The guild ID.
 * @returns {Promise<void>}
 */
export async function handle247Toggle(ctx, message, set, guildId) {
  const t = tWrap(ctx, guildId);
  const panelKey = (k, vars = {}) => t("responses.settings.247Panel." + k, vars);
  if (!guildId) return message.reply(embed(t("responses.settings.noServer")));

  const { channelId: userChannelId } = await ctx.players.checkVoiceChannels(message);
  if (!userChannelId) {
    return message.reply(build247Panel(set, ctx, guildId, null));
  }

  const id = cleanId(userChannelId);
  const channels = get247Channels(set);

  if (channels.has(id)) {
    await disable247(ctx, set, guildId, userChannelId);
    return message.reply(embed(
        panelKey("confirmDisabled", { channel: id }) + "\n\n" +
        build247PanelDescription(set, ctx, guildId, null),
        { title: panelKey("title") }
    ));
  }

  await enable247(ctx, set, guildId, userChannelId);
  return message.reply(embed(
      panelKey("confirmEnabled", { channel: id }) + "\n\n" +
      build247PanelDescription(set, ctx, guildId, id),
      { title: panelKey("title") }
  ));
}
