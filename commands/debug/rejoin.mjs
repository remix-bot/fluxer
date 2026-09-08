/**
 * @module commands/debug/rejoin
 * @description Force-rejoin machinery for the debug command (forceRejoinPlayer, batch processing, result embed, runBatchRejoin entry). Verbatim from the original single-file command; the relative dynamic import of autoplay.mjs was adjusted for the deeper directory.
 */

import { EmbedBuilder } from "@fluxerjs/core";
import { logger } from "../../src/core/Logger.mjs";
import { cleanId } from "../../src/ui/index.mjs";
import { WARN_COLOR, SUCCESS_COLOR, DANGER_COLOR } from "../../src/utils/UI.mjs";
import { REJOIN_DELAY_MS, INTENTIONAL_LEAVE_TTL, MAX_DESC } from "./consts.mjs";
import { roomStateLabel, isGhostConnection, buildPlayerLabel } from "./gateway.mjs";

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
        const { attachAutoplay } = await import("../autoplay.mjs");
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
export async function runBatchRejoin(msg, key, title, noun, filter, showHintIfEmpty = false) {
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
