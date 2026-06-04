import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";
import { getVoiceManager } from "@fluxerjs/voice";

const EMOJI_REMOVE_TIMEOUT = 60_000;
const REJOIN_DELAY_MS = 2_000;
const INTENTIONAL_LEAVE_TTL = 30_000;

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

  if (cs === 2 && !room.isConnected) return true;

  return false;
}

function getBotGatewayVoiceState(client, guildId) {
  const botId = client.user?.id;
  if (!botId || !guildId) return null;
  try {
    const vm = getVoiceManager(client);
    if (vm?.voiceStates) {
      const cleanGuild = String(guildId).replace(/\D/g, "");
      const guildVoiceMap = vm.voiceStates.get(cleanGuild) ?? vm.voiceStates.get(guildId);
      if (guildVoiceMap && typeof guildVoiceMap.get === "function") {
        const channelId = guildVoiceMap.get(botId);
        if (channelId) return { userId: botId, channelId: String(channelId).replace(/\D/g, "") };
      }
    }
  } catch (_) {}
  try {
    const cleanGuild = String(guildId).replace(/\D/g, "");
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
        if (chId) return { userId: botId, channelId: String(chId).replace(/\D/g, "") };
      }
    }
  } catch (_) {}
  return null;
}

function isStaleGatewayPresence(client, player) {
  const guildId = player._guildId ?? player._resolveGuildId?.();
  if (!guildId) return false;

  const gatewayState = getBotGatewayVoiceState(client, guildId);
  if (!gatewayState) return false;

  const playerChannel = String(player._channelId ?? player._home247Channel ?? "").replace(/\D/g, "");
  const gatewayChannel = gatewayState.channelId;

  if (!playerChannel) return true;
  if (playerChannel !== gatewayChannel) return true;

  return false;
}

async function forceRejoinPlayer(ctx, player) {
  const channelId = player._channelId ?? player._home247Channel;
  const guildId = player._guildId ?? player._resolveGuildId?.();
  if (!channelId || !guildId) return { success: false, reason: "no channel or guild id" };

  const cleanChannelId = String(channelId).replace(/\D/g, "");
  const cleanGuildId = String(guildId).replace(/\D/g, "");

  const currentTrack = player.queue?.getCurrent();
  const queueTracks = player.queue?.data ? [...player.queue.data] : [];
  const wasPaused = player._paused;
  const wasAutoplay = player._autoplay;

  try {
    ctx.markIntentionalLeave?.(cleanChannelId, INTENTIONAL_LEAVE_TTL);
    ctx.revoice?.markIntentionalDisconnect(cleanChannelId);

    ctx.players.playerMap.delete(cleanChannelId);
    ctx.players._unindexPlayer?.(cleanGuildId, cleanChannelId);

    const altIds = [player._channelId, player._home247Channel]
        .filter(Boolean)
        .map(id => String(id).replace(/\D/g, ""))
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

    const revoiceConn = ctx.revoice?.connections?.get(cleanChannelId);
    if (revoiceConn) {
      try { await ctx.revoice._destroyStaleConnection(cleanChannelId, revoiceConn); } catch (_) {}
    } else if (player.connection) {
      try { player.connection.removeAllListeners(); } catch (_) {}
      try { ctx.revoice?._leaveGateway?.(cleanChannelId, cleanGuildId); } catch (_) {}
      try { ctx.revoice?.deleteConnection?.(cleanChannelId); } catch (_) {}
      try { await player.connection.disconnect(); } catch (_) {}
    }

    try { await player.leave(); } catch (_) {}
    try { player.destroy(); } catch (_) {}

    await new Promise(r => setTimeout(r, REJOIN_DELAY_MS));

    const newPlayer = await ctx._spawnPlayer(cleanGuildId, cleanChannelId);

    if (!newPlayer) {
      return { success: false, reason: "_spawnPlayer returned null", channelId: cleanChannelId };
    }

    if (currentTrack && newPlayer.queue) {
      try {
        newPlayer.queue.data = queueTracks;
        newPlayer.queue.current = null;
        await newPlayer.playNext();
        if (wasPaused) newPlayer.pause();
      } catch (_) {}
    }

    if (wasAutoplay) newPlayer._autoplay = true;

    const newRoom = newPlayer.connection?.room;
    return {
      success: !!(newPlayer.connection && newRoom?.isConnected),
      roomConnected: newRoom?.isConnected ?? false,
      roomState: roomStateLabel(newRoom),
      resumedPlayback: !!(currentTrack && newPlayer.queue?.getCurrent()),
      channelId: cleanChannelId,
    };
  } catch (err) {
    return { success: false, reason: err.message, channelId: cleanChannelId };
  }
}

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

export async function run(msg, data) {
  switch (data.get("target").value) {
    case "247-rejoin": {
      const allPlayers = [...this.players.playerMap.entries()];
      const channels247 = allPlayers.filter(([, player]) => player._home247Channel);

      if (channels247.length === 0) {
        const embed = new EmbedBuilder()
            .setColor(0xFFAA00)
            .setTitle("Debug — 24/7 Rejoin")
            .setDescription("No 24/7 channels found in the player map.")
        ;
        return msg.reply({ embeds: [embed] });
      }

      const statusLines = [
        `🔄 **24/7 Force Rejoin** — Found **${channels247.length}** 24/7 channel(s)`,
        `Destroying stale connections and respawning fresh players...`,
        ``,
      ];

      for (let i = 0; i < channels247.length; i++) {
        const [cid, player] = channels247[i];
        const channel = this.client.channels.get(cid);
        const gId = player._guildId ?? channel?.guildId;
        const guild = gId ? this.client.guilds.get(String(gId).replace(/\D/g, "")) : null;
        const label = `${guild?.name ?? "unknown"} / #${channel?.name ?? cid}`;
        const ghost = isGhostConnection(player) ? " 👻GHOST" : "";
        const roomLabel = player.connection?.room ? roomStateLabel(player.connection.room) : "none";
        const connectedLabel = player.connection?.room?.isConnected ? "yes" : "no";
        statusLines.push(`${i + 1}. \`${label}\` — room:${roomLabel} isConnected:${connectedLabel}${ghost}`);
      }

      const statusEmbed = new EmbedBuilder()
          .setColor(0xFFAA00)
          .setTitle("Debug — 24/7 Rejoin")
          .setDescription(statusLines.join("\n").slice(0, 4096))
      ;
      const statusMsg = await msg.reply({ embeds: [statusEmbed] });

      const results = [];

      for (let i = 0; i < channels247.length; i++) {
        const [cid, player] = channels247[i];
        const channel = this.client.channels.get(cid);
        const gId = player._guildId ?? channel?.guildId;
        const guild = gId ? this.client.guilds.get(String(gId).replace(/\D/g, "")) : null;
        const label = `${guild?.name ?? "unknown"} / #${channel?.name ?? cid}`;

        const result = await forceRejoinPlayer(this, player);
        result.label = label;
        results.push(result);

        if (i < channels247.length - 1) {
          await new Promise(r => setTimeout(r, REJOIN_DELAY_MS));
        }
      }

      const resultLines = [
        `🔄 **24/7 Rejoin Complete**`,
        `Channels processed: **${channels247.length}**`,
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
        resultLines.push("", `All **${rejoinedCount}** 24/7 channel(s) restored.${resumedCount > 0 ? ` ${resumedCount} had playback resumed.` : ""}`);
      } else {
        resultLines.push("", `⚠️ **${failedCount}** channel(s) could not be restored.`);
      }

      const finalColor = failedCount === 0 ? 0x00CC66 : 0xFF4444;
      const finalEmbed = new EmbedBuilder()
          .setColor(finalColor)
          .setTitle("Debug — 24/7 Rejoin")
          .setDescription(resultLines.join("\n").slice(0, 4096))
      ;
      await statusMsg.edit({ embeds: [finalEmbed] }).catch(() => {
        msg.reply({ embeds: [finalEmbed] });
      });
      break;
    }

    case "voice-rejoin": {
      const allPlayers = [...this.players.playerMap.entries()];
      const ghostEntries = allPlayers.filter(([, player]) => isGhostConnection(player));

      if (ghostEntries.length === 0) {
        const has247 = allPlayers.some(([, player]) => player._home247Channel);
        const hintLine = has247
            ? `\n\n💡 No ghosts auto-detected, but 24/7 channels with dead WebSockets may still report as "connected".\nUse \`%debug 247-rejoin\` to force-rejoin all 24/7 channels.`
            : "";
        const embed = new EmbedBuilder()
            .setColor(0x00CC66)
            .setTitle("Debug — Voice Rejoin")
            .setDescription(`No ghost connections found. All voice connections appear healthy.${hintLine}`)
        ;
        return msg.reply({ embeds: [embed] });
      }

      const statusLines = [
        `🔍 **Voice Rejoin** — Found **${ghostEntries.length}** ghost connection(s)`,
        `Destroying stale connections and respawning fresh players...`,
        ``,
      ];

      for (let i = 0; i < ghostEntries.length; i++) {
        const [cid, player] = ghostEntries[i];
        const channel = this.client.channels.get(cid);
        const gId = player._guildId ?? channel?.guildId;
        const guild = gId ? this.client.guilds.get(String(gId).replace(/\D/g, "")) : null;
        const label = `${guild?.name ?? "unknown"} / #${channel?.name ?? cid}`;
        const is247 = player._home247Channel ? "yes" : "no";
        const hasTrack = player.queue?.getCurrent() ? "yes" : "no";
        statusLines.push(`👻 \`${label}\` — 247:${is247} hasTrack:${hasTrack}`);
      }

      const statusEmbed = new EmbedBuilder()
          .setColor(0xFFAA00)
          .setTitle("Debug — Voice Rejoin")
          .setDescription(statusLines.join("\n").slice(0, 4096))
      ;
      const statusMsg = await msg.reply({ embeds: [statusEmbed] });

      const results = [];

      for (let i = 0; i < ghostEntries.length; i++) {
        const [cid, player] = ghostEntries[i];
        const channel = this.client.channels.get(cid);
        const gId = player._guildId ?? channel?.guildId;
        const guild = gId ? this.client.guilds.get(String(gId).replace(/\D/g, "")) : null;
        const label = `${guild?.name ?? "unknown"} / #${channel?.name ?? cid}`;

        const result = await forceRejoinPlayer(this, player);
        result.label = label;
        results.push(result);

        if (i < ghostEntries.length - 1) {
          await new Promise(r => setTimeout(r, REJOIN_DELAY_MS));
        }
      }

      const resultLines = [
        `🔍 **Voice Rejoin Complete**`,
        `Ghosts found: **${ghostEntries.length}**`,
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
        resultLines.push("", `All **${rejoinedCount}** ghost connection(s) restored.${resumedCount > 0 ? ` ${resumedCount} had playback resumed.` : ""}`);
      } else {
        resultLines.push("", `⚠️ **${failedCount}** connection(s) could not be restored.`);
      }

      const finalColor = failedCount === 0 ? 0x00CC66 : 0xFF4444;
      const finalEmbed = new EmbedBuilder()
          .setColor(finalColor)
          .setTitle("Debug — Voice Rejoin")
          .setDescription(resultLines.join("\n").slice(0, 4096))
      ;
      await statusMsg.edit({ embeds: [finalEmbed] }).catch(() => {
        msg.reply({ embeds: [finalEmbed] });
      });
      break;
    }

    case "voice": {
      const servers = [...this.players.playerMap.entries()].map(([cid, s]) => {
        const channel = this.client.channels.get(cid);
        const guildId = s._guildId ?? channel?.guildId ?? channel?.guild_id;
        const guild   = guildId ? this.client.guilds.get(String(guildId).replace(/\D/g, "")) : null;
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

      const MAX_DESC = 4096;

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

      {
        let groupJson = "";

        let i = 0;
        for (i = 0; i < servers.length; i++) {
          const singleJson = JSON.stringify(servers[i], null, 2);
          const candidate = groupJson
              ? groupJson.slice(0, -1) + ",\n" + singleJson.slice(1)
              : singleJson;

          if (("```json\n" + candidate + "\n```").length > MAX_DESC && groupJson) {
            pages.push(("```json\n" + groupJson + "\n```").slice(0, MAX_DESC));
            groupJson = singleJson;
          } else if (("```json\n" + candidate + "\n```").length > MAX_DESC) {
            const budget = MAX_DESC - 12;
            groupJson = singleJson.slice(0, budget);
            pages.push(("```json\n" + groupJson + "\n```").slice(0, MAX_DESC));
            groupJson = "";
          } else {
            groupJson = candidate;
          }
        }
        if (groupJson) {
          pages.push(("```json\n" + groupJson + "\n```").slice(0, MAX_DESC));
        }
      }

      if (pages.length === 1) {
        const embedColor = ghostConnections.length > 0 ? 0xFF4444 : getGlobalColor();
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
        const pageLabel = pageIdx === 0
            ? "Summary"
            : `Player Detail${pages[pageIdx].includes(",") ? "s" : ""}`;
        const footerText = expired
            ? this.t(msg, "responses._common.controlsExpired")
            : `${this.t(msg, "responses.eval.pageLabel", { page: pageIdx + 1, total: totalPages })} • ${this.t(msg, "responses.eval.navigateHint")}`;

        const embedColor = (pageIdx === 0 && ghostConnections.length > 0) ? 0xFF4444 : getGlobalColor();
        const titleSuffix = (pageIdx === 0 && ghostConnections.length > 0) ? ` — ${ghostConnections.length} Ghost(s) Detected!` : "";

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
        } catch {
          for (const emoji of navEmojis) {
            try { await replyMsg.message.removeReaction(emoji); } catch {}
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
        if (e.emoji_id === "❌") {
          clearTimeout(emojiTimeout);
          unobserve?.();
          await replyMsg.message.delete().catch(() => {});
          return;
        }

        resetTimer();

        if (e.emoji_id === "⬅️") {
          currentPage = currentPage > 0 ? currentPage - 1 : totalPages - 1;
        } else if (e.emoji_id === "➡️") {
          currentPage = currentPage < totalPages - 1 ? currentPage + 1 : 0;
        }

        await replyMsg.edit(buildPage(currentPage)).catch(() => {});
      });

      resetTimer();
      break;
    }
  }
}
