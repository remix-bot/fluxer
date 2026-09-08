/**
 * @module commands/debug/voiceDiagnostic
 * @description Full voice diagnostic renderer for the debug command. Verbatim from the original single-file command.
 */

import { EmbedBuilder } from "@fluxerjs/core";
import { logger } from "../../src/core/Logger.mjs";
import { getGlobalColor, cleanId } from "../../src/ui/index.mjs";
import { DANGER_COLOR, EMOJI_REMOVE_TIMEOUT } from "../../src/utils/UI.mjs";
import { MAX_DESC } from "./consts.mjs";
import {
  roomStateLabel, isGhostConnection, getBotGatewayVoiceState, isStaleGatewayPresence,
} from "./gateway.mjs";

/**
 * Run a full voice diagnostic, displaying player states and ghost connections.
 * @private
 * @async
 * @param {object} msg - The command message wrapper.
 * @returns {Promise<void>}
 */
export async function runVoiceDiagnostic(msg) {
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
