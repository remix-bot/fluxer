/**
 * @module commands/debug
 * @description Owner-only debug command for voice diagnostics, ghost connection detection, and forced rejoin.
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor, cleanId } from "../src/MessageHandler.mjs";
import { logger } from "../src/constants/Logger.mjs";
import { getVoiceManager } from "@fluxerjs/voice";
import { ERROR_COLOR, WARN_COLOR, SUCCESS_COLOR, DANGER_COLOR, EMOJI_REMOVE_TIMEOUT } from "../src/constants/UI.mjs";

const REJOIN_DELAY_MS = 2_000;
const INTENTIONAL_LEAVE_TTL = 30_000;
const MAX_DESC = 4096;

/**
 * Get a human-readable label for a voice room's connection state.
 * @private
 * @param {object|null} room - The voice room object.
 * @returns {string} Connection state label.
 */
function roomStateLabel(room) {
  if (!room) return "none";
  const cs = room.connectionState;
  if (cs === 0 || cs === "CONN_DISCONNECTED") return "disconnected(0)";
  if (cs === 1 || cs === "CONN_CONNECTED") return "connected(1)";
  if (cs === 2) return room.isConnected ? "connected(2)" : "reconnecting(2)";
  if (cs === "CONN_RECONNECTING") return "reconnecting";
  if (cs === 3) return "reconnecting(3)";
  if (cs === 4) return "signal_reconnecting(4)";
  if (typeof cs === "string") return cs;
  return String(cs);
}

/**
 * Check if a player has a ghost connection (appears in voice but WebSocket is dead).
 * @private
 * @param {object} player - The player instance.
 * @returns {boolean} True if the player has a ghost connection.
 */
function isGhostConnection(player) {
  const conn = player.connection;
  if (!conn) return false;
  if (player._destroyed || player.leaving || player._isJoining) return false;

  const room = conn.room;
  if (!room) {
    return !conn._destroyed;
  }

  if (!room.isConnected) return true;

  const cs = room.connectionState;
  if (cs === 0 || cs === "CONN_DISCONNECTED") return true;
  if (cs === "CONN_RECONNECTING" || cs === 3 || cs === 4) return true;

  return false;
}

/**
 * Get the bot's voice channel state from the Discord gateway cache.
 * @private
 * @param {object} client - The Discord client instance.
 * @param {string} guildId - The guild ID to check.
 * @returns {{ userId: string, channelId: string }|null} Bot's voice state or null.
 */
function getBotGatewayVoiceState(client, guildId) {
  const botId = client.user?.id;
  if (!botId || !guildId) return null;

  try {
    const vm = getVoiceManager(client);
    if (vm?.voiceStates) {
      const cleanGuild = cleanId(guildId);
      const guildVoiceMap = vm.voiceStates.get(cleanGuild) ?? vm.voiceStates.get(guildId);
      if (guildVoiceMap && typeof guildVoiceMap.get === "function") {
        const channelId = guildVoiceMap.get(botId);
        if (channelId) return { userId: botId, channelId: cleanId(channelId) };
      }
    }
  } catch (e) { logger.warn("[Debug] getBotGatewayVoiceState (VoiceManager):", e?.message); }

  try {
    const cleanGuild = cleanId(guildId);
    const guild = client.guilds.get(cleanGuild) ?? client.guilds.get(guildId);
    const voiceStates = guild?.voice_states ?? guild?.voiceStates ?? null;
    if (!voiceStates) return null;

    const entries = Array.isArray(voiceStates)
        ? voiceStates
        : typeof voiceStates.values === "function"
            ? [...voiceStates.values()]
            : Object.entries(voiceStates).map(([uid, val]) => {
              if (typeof val === "string") return { user_id: uid, channel_id: val };
              const obj = typeof val === "object" && val !== null ? val : {};
              return { user_id: uid, channel_id: obj.channelId ?? obj.channel_id ?? null, ...obj };
            });

    for (const state of entries) {
      const uid = state?.user_id ?? state?.userId ?? state?.id;
      if (uid === botId) {
        const chId = state?.channel_id ?? state?.channelId ?? null;
        if (chId) return { userId: botId, channelId: cleanId(chId) };
      }
    }
  } catch (e) { logger.warn("[Debug] getBotGatewayVoiceState (guild cache):", e?.message); }

  return null;
}

/**
 * Check if the gateway voice state is stale (mismatches the player's channel).
 * @private
 * @param {object} client - The Discord client instance.
 * @param {object} player - The player instance.
 * @returns {boolean} True if the gateway presence is stale.
 */
function isStaleGatewayPresence(client, player) {
  const guildId = player._guildId ?? player._resolveGuildId?.();
  if (!guildId) return false;

  const gatewayState = getBotGatewayVoiceState(client, guildId);
  if (!gatewayState) return false;

  const playerChannel = cleanId(player._channelId ?? player._home247Channel);
  const gatewayChannel = gatewayState.channelId;

  return !playerChannel || playerChannel !== gatewayChannel;
}

/**
 * Build a human-readable label for a player (guild name / #channel name).
 * @private
 * @param {object} client - The Discord client instance.
 * @param {string} channelId - The voice channel ID.
 * @param {object} player - The player instance.
 * @returns {string} Formatted label string.
 */
function buildPlayerLabel(client, channelId, player) {
  const channel = client.channels.get(channelId);
  const gId = player._guildId ?? channel?.guildId;
  const guild = gId ? client.guilds.get(cleanId(gId)) : null;
  return `${guild?.name ?? "unknown"} / #${channel?.name ?? channelId}`;
}

/**
 * Force a player to leave and rejoin, restoring queue and playback state.
 * @private
 * @async
 * @param {object} ctx - The bot (Remix) instance context.
 * @param {object} player - The player to rejoin.
 * @returns {Promise<object>} Result object with success status, room state, and details.
 */
async function forceRejoinPlayer(ctx, player) {
  const channelId = player._channelId ?? player._home247Channel;
  const guildId = player._guildId ?? player._resolveGuildId?.();
  if (!channelId || !guildId) return { success: false, reason: "no channel or guild id" };

  const cleanChannelId = cleanId(channelId);
  const cleanGuildId = cleanId(guildId);

  const currentTrack = player.queue?.getCurrent();
  const queueTracks = player.queue?.data ? [...player.queue.data] : [];
  const wasPaused = player._paused;
  const wasAutoplay = player._autoplay;
  const wasLoop = player.queue?.loop ?? false;
  const wasSongLoop = player.queue?.songLoop ?? false;
  const savedVolume = player.preferredVolume ?? 1;
  const savedFilter = player.activeFilter ?? null;
  const savedFilterPayload = player.activeFilterPayload ?? null;

  try {
    ctx.markIntentionalLeave?.(cleanChannelId, INTENTIONAL_LEAVE_TTL);

    ctx.players.playerMap.delete(cleanChannelId);
    ctx.players._unindexPlayer?.(cleanGuildId, cleanChannelId);

    const altIds = [player._channelId, player._home247Channel]
        .filter(Boolean)
        .map(id => cleanId(id))
        .filter(id => id !== cleanChannelId);
    for (const altId of altIds) {
      ctx.players.playerMap.delete(altId);
      ctx.players._unindexPlayer?.(cleanGuildId, altId);
    }

    const pendingScrobble = ctx.players._pendingScrobbleTimers?.get(cleanChannelId);
    if (pendingScrobble) {
      clearTimeout(pendingScrobble.timer);
      ctx.players._pendingScrobbleTimers.delete(cleanChannelId);
    }

    ctx.players._pendingJoins?.delete?.(cleanChannelId);

    if (player.connection) {
      try { player.connection.removeAllListeners(); } catch (e) { logger.warn("[Debug] connection listener removal:", e?.message); }
      try { await player.connection.disconnect(); } catch (e) { logger.warn("[Debug] connection disconnect:", e?.message); }
    }

    try { await player.leave(); } catch (e) { logger.warn("[Debug] player leave:", e?.message); }
    try { player.destroy(); } catch (e) { logger.warn("[Debug] player destroy:", e?.message); }

    await new Promise(r => setTimeout(r, REJOIN_DELAY_MS));

    const newPlayer = await ctx._spawnPlayer(cleanGuildId, cleanChannelId);

    if (!newPlayer) {
      return { success: false, reason: "_spawnPlayer returned null", channelId: cleanChannelId };
    }

    if (newPlayer.preferredVolume !== savedVolume) {
      newPlayer.setVolume(savedVolume);
    }

    if (wasLoop) newPlayer.queue?.setLoop?.(true);
    if (wasSongLoop) newPlayer.queue?.setSongLoop?.(true);

    if (savedFilter && savedFilterPayload) {
      newPlayer.activeFilter = savedFilter;
      newPlayer.activeFilterPayload = savedFilterPayload;
    }

    if (currentTrack && newPlayer.queue) {
      try {
        newPlayer.queue.data = queueTracks;
        newPlayer.queue.current = null;
        await newPlayer.playNext();
        if (wasPaused) newPlayer.pause();
      } catch (e) { logger.warn("[Debug] queue restore:", e?.message); }
    }

    if (wasAutoplay) {
      newPlayer._autoplay = true;
      newPlayer._autoplayHistory = player._autoplayHistory ?? [];
      try {
        const { attachAutoplay } = await import("./autoplay.mjs");
        attachAutoplay(newPlayer, ctx);
      } catch (e) {
        logger.warn("[Debug] autoplay re-attach failed:", e?.message);
      }
    }

    const newRoom = newPlayer.connection?.room;
    return {
      success: !!(newPlayer.connection && newRoom?.isConnected),
      roomConnected: newRoom?.isConnected ?? false,
      roomState: roomStateLabel(newRoom),
      resumedPlayback: !!(currentTrack && newPlayer.queue?.getCurrent()),
      channelId: cleanChannelId,
    };
  } catch (err) {
    logger.warn("[Debug] forceRejoinPlayer error:", err?.message);
    return { success: false, reason: err.message, channelId: cleanChannelId };
  }
}

/**
 * Process a batch of players for force-rejoin, updating a status message with progress.
 * @private
 * @async
 * @param {object} ctx - The bot (Remix) instance context.
 * @param {Array} entries - Array of [channelId, player] tuples.
 * @param {object} statusMsg - The message to update with progress.
 * @param {string} title - The title for the progress display.
 * @returns {Promise<object[]>} Array of rejoin results.
 */
async function processRejoinBatch(ctx, entries, statusMsg, title) {
  const results = [];

  for (let i = 0; i < entries.length; i++) {
    const [cid, player] = entries[i];
    const label = buildPlayerLabel(ctx.client, cid, player);

    const progressLines = [
      `🔄 **${title}** — Processing ${i + 1}/${entries.length}`,
      `Currently rejoining: \`${label}\``,
      ``,
    ];
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      const icon = r.success ? "✅" : "❌";
      progressLines.push(`${icon} \`${r.label}\`${r.success ? ` — room:${r.roomState}` : ` — failed (${r.reason ?? "?"})`}`);
    }
    await statusMsg.edit({ embeds: [new EmbedBuilder().setColor(WARN_COLOR).setTitle(`Debug — ${title}`).setDescription(progressLines.join("\n").slice(0, MAX_DESC))] }).catch(() => {});

    const result = await forceRejoinPlayer(ctx, player);
    result.label = label;
    results.push(result);

    if (i < entries.length - 1) {
      await new Promise(r => setTimeout(r, REJOIN_DELAY_MS));
    }
  }

  return results;
}

/**
 * Build the final embed summarizing rejoin results.
 * @private
 * @param {object[]} results - Array of rejoin result objects.
 * @param {string} title - The title for the embed.
 * @param {string} noun - The noun describing the rejoin targets.
 * @returns {object} Message payload with embed.
 */
function buildRejoinResultEmbed(results, title, noun) {
  const resultLines = [
    `🔄 **${title} Complete**`,
    `${noun.charAt(0).toUpperCase() + noun.slice(1)} processed: **${results.length}**`,
    ``,
  ];

  let rejoinedCount = 0;
  let resumedCount = 0;
  let failedCount = 0;

  for (const r of results) {
    if (r.success) {
      rejoinedCount++;
      if (r.resumedPlayback) resumedCount++;
      resultLines.push(`✅ \`${r.label}\` — rejoined (room:${r.roomState}, playback:${r.resumedPlayback ? "resumed" : "no track"})`);
    } else {
      failedCount++;
      resultLines.push(`❌ \`${r.label}\` — failed${r.reason ? ` (${r.reason})` : ""}`);
    }
  }

  if (failedCount === 0) {
    resultLines.push("", `All **${rejoinedCount}** ${noun} restored.${resumedCount > 0 ? ` ${resumedCount} had playback resumed.` : ""}`);
  } else {
    resultLines.push("", `⚠️ **${failedCount}** ${noun} could not be restored.`);
  }

  const finalColor = failedCount === 0 ? SUCCESS_COLOR : DANGER_COLOR;
  return { embeds: [new EmbedBuilder().setColor(finalColor).setTitle(`Debug — ${title}`).setDescription(resultLines.join("\n").slice(0, MAX_DESC))] };
}

/**
 * @type {CommandBuilder}
 * @description Command definition for the debug command (owner-only).
 */
export const command = new CommandBuilder()
    .setName("debug")
    .setDescription("A debug command for various purposes.")
    .setRequirement(r => r.setOwnerOnly(true))
    .setCategory("util")
    .addChoiceOption(o =>
        o.setName("target")
            .setDescription("The target that should be examined.")
            .addChoices("voice", "voice-rejoin", "247-rejoin")
            .setRequired(true));

/**
 * Run handler for the debug command.
 * Routes to the appropriate debug subcommand based on the target option.
 *
 * @param {object} msg - The command message wrapper.
 * @param {object} data - Parsed command data containing the target option.
 * @returns {Promise<void>}
 */
export async function run(msg, data) {
  const target = data.get("target").value;

  switch (target) {
    case "247-rejoin": {
      return await runBatchRejoin.call(this, msg, "247-rejoin", "24/7 Rejoin", "24/7 channel(s)", p => !!p._home247Channel);
    }

    case "voice-rejoin": {
      return await runBatchRejoin.call(this, msg, "voice-rejoin", "Voice Rejoin", "ghost connection(s)", isGhostConnection, true);
    }

    case "voice": {
      return await runVoiceDiagnostic.call(this, msg);
    }

    default: {
      const embed = new EmbedBuilder()
          .setColor(ERROR_COLOR)
          .setTitle("Debug — Unknown Target")
          .setDescription(`Unknown debug target: \`${target}\`.\nValid options: \`voice\`, \`voice-rejoin\`, \`247-rejoin\`.`)
      ;
      return msg.reply({ embeds: [embed] });
    }
  }
}

/**
 * Run a batch rejoin operation on matching players.
 * @private
 * @async
 * @param {object} msg - The command message wrapper.
 * @param {string} key - Identifier key for the rejoin type.
 * @param {string} title - Display title for the operation.
 * @param {string} noun - Noun describing the targets.
 * @param {Function} filter - Function to filter which players to rejoin.
 * @param {boolean} [showHintIfEmpty=false] - Whether to show a hint if no matches found.
 * @returns {Promise<void>}
 */
async function runBatchRejoin(msg, key, title, noun, filter, showHintIfEmpty = false) {
  const allPlayers = [...this.players.playerMap.entries()];
  const matching = allPlayers.filter(([, player]) => filter(player));

  if (matching.length === 0) {
    const has247 = allPlayers.some(([, player]) => player._home247Channel);
    const hintLine = showHintIfEmpty && has247
        ? `\n\n💡 No ghosts auto-detected, but 24/7 channels with dead WebSockets may still report as "connected".\nUse \`%debug 247-rejoin\` to force-rejoin all 24/7 channels.`
        : "";
    const embed = new EmbedBuilder()
        .setColor(SUCCESS_COLOR)
        .setTitle(`Debug — ${title}`)
        .setDescription(`No ${noun} found. All voice connections appear healthy.${hintLine}`)
    ;
    return msg.reply({ embeds: [embed] });
  }

  const statusLines = [
    `🔄 **${title}** — Found **${matching.length}** ${noun}`,
    `Destroying stale connections and respawning fresh players...`,
    ``,
  ];

  for (let i = 0; i < matching.length; i++) {
    const [cid, player] = matching[i];
    const label = buildPlayerLabel(this.client, cid, player);
    const ghost = isGhostConnection(player) ? " 👻GHOST" : "";
    const roomLabel = player.connection?.room ? roomStateLabel(player.connection.room) : "none";
    const connectedLabel = player.connection?.room?.isConnected ? "yes" : "no";
    statusLines.push(`${i + 1}. \`${label}\` — room:${roomLabel} isConnected:${connectedLabel}${ghost}`);
  }

  const statusEmbed = new EmbedBuilder()
      .setColor(WARN_COLOR)
      .setTitle(`Debug — ${title}`)
      .setDescription(statusLines.join("\n").slice(0, MAX_DESC))
  ;
  const statusMsg = await msg.reply({ embeds: [statusEmbed] });

  const results = await processRejoinBatch(this, matching, statusMsg, title);

  const finalPayload = buildRejoinResultEmbed(results, title, noun);
  await statusMsg.edit(finalPayload).catch(() => {
    msg.reply(finalPayload);
  });
}

/**
 * Run a full voice diagnostic, displaying player states and ghost connections.
 * @private
 * @async
 * @param {object} msg - The command message wrapper.
 * @returns {Promise<void>}
 */
async function runVoiceDiagnostic(msg) {
  const servers = [...this.players.playerMap.entries()].map(([cid, s]) => {
    const channel = this.client.channels.get(cid);
    const guildId = s._guildId ?? channel?.guildId ?? channel?.guild_id;
    const guild   = guildId ? this.client.guilds.get(cleanId(guildId)) : null;
    const conn = s.connection;
    const room = conn?.room;
    const ghost = isGhostConnection(s);
    const staleGateway = ghost ? isStaleGatewayPresence(this.client, s) : false;
    const gatewayVoiceState = getBotGatewayVoiceState(this.client, guildId);
    return {
      name:      channel?.name ?? "unknown",
      id:        channel?.id ?? cid,
      channelId: s._channelId ?? cid,
      guildId:   guildId ?? "unknown",
      guildname: guild?.name ?? channel?.guild?.name ?? "unknown",
      conn:      conn ? "yes" : "null",
      connDestroyed: conn?._destroyed ?? null,
      roomConnected: room?.isConnected ?? null,
      roomState: roomStateLabel(room),
      mediaPlayer: !!s._mediaPlayer && !s._mediaPlayer?.destroyed ? "alive" : (s._mediaPlayer?.destroyed ? "destroyed" : "none"),
      destroyed: s._destroyed ?? false,
      leaving:   s.leaving ?? false,
      joining:   s._isJoining ?? false,
      recovering: s._isRecovering ?? false,
      paused:    s._paused ?? false,
      hasQueue:  !!(s.queue?.getCurrent() || !s.queue?.isEmpty()),
      home247:   s._home247Channel ?? null,
      ghost,
      staleGateway,
      gatewayVoiceChannel: gatewayVoiceState?.channelId ?? null,
    };
  });
  const pending = [...(this.players._pendingJoins ?? [])];

  const ghostConnections = servers.filter(s => s.ghost);
  const livePlayers = servers.filter(s => s.conn === "yes" && !s.destroyed && !s.leaving);
  const actuallyConnected = livePlayers.filter(s => !s.ghost);
  const channels247 = servers.filter(s => s.home247);

  const summary = {
    playerMapSize: this.players.playerMap.size,
    livePlayers: livePlayers.length,
    actuallyConnected: actuallyConnected.length,
    ghostConnections: ghostConnections.length,
    channels247: channels247.length,
    pendingJoins: pending.length,
    pendingChannels: pending,
  };

  const pages = [];

  const summaryLines = [
    `📊 **Summary**`,
    `Players in map:       **${summary.playerMapSize}**`,
    `Live players:         **${summary.livePlayers}**`,
    `Actually connected:   **${summary.actuallyConnected}**`,
    `Ghost connections:    **${summary.ghostConnections}**`,
    `24/7 channels:        **${summary.channels247}**`,
    `Pending joins:        **${summary.pendingJoins}**${summary.pendingChannels.length ? ` (\`${summary.pendingChannels.join("`, `")}\`)` : ""}`,
  ];

  if (ghostConnections.length > 0) {
    summaryLines.push("", `👻 **Ghost Connections (${ghostConnections.length}):**`, "These players *appear* in voice but their WebSocket/LiveKit room is dead:");
    summaryLines.push(`Use \`%debug voice-rejoin\` to rejoin detected ghosts, or \`%debug 247-rejoin\` to force-rejoin all 24/7 channels.`);
    for (const g of ghostConnections) {
      const gatewayInfo = g.staleGateway
          ? `gateway:stale(ch:${g.gatewayVoiceChannel ?? "?"})`
          : `gateway:present(ch:${g.gatewayVoiceChannel ?? "?"})`;
      const detail = `  👻 \`${g.guildname}\` / \`#${g.name}\` — room:${g.roomState} connected:${g.roomConnected} media:${g.mediaPlayer} ${gatewayInfo} 247:${g.home247 ?? "no"}`;
      if (summaryLines.join("\n").length + detail.length + 1 > MAX_DESC - 60) {
        summaryLines.push(`  … and more ghosts (see JSON details)`);
        break;
      }
      summaryLines.push(detail);
    }
  }

  if (channels247.length > 0 && ghostConnections.length === 0) {
    summaryLines.push("", `ℹ️ **24/7 Channels (${channels247.length}):**`, `WebSocket deaths can leave 24/7 channels as invisible ghosts (room reports healthy but transport is dead).`);
    summaryLines.push(`Use \`%debug 247-rejoin\` to force-rejoin all 24/7 channels if you suspect ghost connections.`);
  }

  summaryLines.push("", "**Players:**");
  for (let i = 0; i < servers.length; i++) {
    const s = servers[i];
    let status;
    if (s.ghost) {
      status = "👻";
    } else if (s.conn === "yes" && !s.destroyed && !s.leaving) {
      status = "🟢";
    } else {
      status = "🔴";
    }
    const ghostTag = s.ghost ? " ⚠️GHOST" : "";
    const staleTag = s.staleGateway ? " ⚠️STALE_GW" : "";
    const tag247 = s.home247 ? " 🔄247" : "";
    const line = `${status} \`${s.guildname}\` / \`#${s.name}\` — conn:${s.conn} room:${s.roomState} connected:${s.roomConnected} media:${s.mediaPlayer}${ghostTag}${staleTag}${tag247}`;
    if (summaryLines.join("\n").length + line.length + 1 > MAX_DESC - 30) {
      summaryLines.push(`… and ${servers.length - i} more (see next pages)`);
      break;
    }
    summaryLines.push(line);
  }
  pages.push(summaryLines.join("\n"));

  let groupJson = "";
  for (let i = 0; i < servers.length; i++) {
    const singleJson = JSON.stringify(servers[i], null, 2);
    const candidate = groupJson
        ? groupJson.slice(0, -1) + ",\n" + singleJson.slice(1)
        : singleJson;

    const candidateLen = ("```json\n" + candidate + "\n```").length;

    if (candidateLen > MAX_DESC && groupJson) {
      pages.push(("```json\n" + groupJson + "\n```").slice(0, MAX_DESC));
      groupJson = singleJson;
    } else if (candidateLen > MAX_DESC) {
      const budget = MAX_DESC - 12;
      pages.push(("```json\n" + singleJson.slice(0, budget) + "\n```").slice(0, MAX_DESC));
      groupJson = "";
    } else {
      groupJson = candidate;
    }
  }
  if (groupJson) {
    pages.push(("```json\n" + groupJson + "\n```").slice(0, MAX_DESC));
  }

  if (pages.length === 1) {
    const embedColor = ghostConnections.length > 0 ? DANGER_COLOR : getGlobalColor();
    const embed = new EmbedBuilder()
        .setColor(embedColor)
        .setTitle(this.t(msg, "responses.debug.voiceTitle") + (ghostConnections.length > 0 ? ` — ${ghostConnections.length} Ghost(s) Detected!` : ""))
        .setDescription(pages[0].slice(0, MAX_DESC))
    ;
    return msg.reply({ embeds: [embed] });
  }

  const totalPages = pages.length;
  let currentPage = 0;

  const buildPage = (pageIdx, expired = false) => {
    const isSummaryPage = pageIdx === 0;
    const pageLabel = isSummaryPage
        ? "Summary"
        : `Player Detail${pages[pageIdx].split(`"name":`).length - 1 > 1 ? "s" : ""}`;
    const footerText = expired
        ? this.t(msg, "responses._common.controlsExpired")
        : `${this.t(msg, "responses.debug.pageLabel", { page: pageIdx + 1, total: totalPages })} • ${this.t(msg, "responses.eval.navigateHint")}`;

    const embedColor = (isSummaryPage && ghostConnections.length > 0) ? DANGER_COLOR : getGlobalColor();
    const titleSuffix = (isSummaryPage && ghostConnections.length > 0) ? ` — ${ghostConnections.length} Ghost(s) Detected!` : "";

    const embed = new EmbedBuilder()
        .setColor(embedColor)
        .setTitle(this.t(msg, "responses.debug.voiceTitle") + titleSuffix + ` — ${pageLabel}`)
        .setDescription(pages[pageIdx].slice(0, MAX_DESC))
        .setFooter({ text: footerText })
    ;
    return { embeds: [embed] };
  };

  const replyMsg = await msg.reply(buildPage(0));
  if (!replyMsg?.message) return;

  const navEmojis = ["⬅️", "➡️", "❌"];
  for (const emoji of navEmojis) {
    await replyMsg.message.react(emoji).catch(() => {});
  }

  const clearReactions = async () => {
    try {
      await replyMsg.message.removeAllReactions();
    } catch (e) {
      for (const emoji of navEmojis) {
        try { await replyMsg.message.removeReaction(emoji); } catch (err) { logger.warn("[Debug] removeReaction fallback:", err?.message); }
      }
    }
  };

  let emojiTimeout;
  const resetTimer = () => {
    clearTimeout(emojiTimeout);
    emojiTimeout = setTimeout(async () => {
      unobserve?.();
      await clearReactions();
      await replyMsg.edit(buildPage(currentPage, true)).catch(() => {});
    }, EMOJI_REMOVE_TIMEOUT);
  };

  const unobserve = replyMsg.onReaction(navEmojis, async (e) => {
    const emoji = e?.emoji_id ?? e?.emoji?.id ?? e?.emoji;

    if (emoji === "❌") {
      clearTimeout(emojiTimeout);
      unobserve?.();
      await replyMsg.message.delete().catch(() => {});
      return;
    }

    resetTimer();

    if (emoji === "⬅️") {
      currentPage = currentPage > 0 ? currentPage - 1 : totalPages - 1;
    } else if (emoji === "➡️") {
      currentPage = currentPage < totalPages - 1 ? currentPage + 1 : 0;
    }

    await replyMsg.edit(buildPage(currentPage)).catch(() => {});
  });

  resetTimer();
}
