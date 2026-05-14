import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";
import { get247ChannelMode } from "../src/constants/Helpers247.mjs";

export const command = new CommandBuilder()
    .setName("leave")
    .setDescription("Make the bot leave a voice channel", "commands.leave")
    .addAliases("l", "stop")
    .setCategory("music")
    .addChannelOption(o =>
      o.setName("channel")
        .setDescription("The voice channel to leave (defaults to your current channel)")
        .setRequired(false)
    );

function embed(desc) {
  return { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(desc)] };
}

function cleanId(value) {
  return String(value ?? "").replace(/\D/g, "");
}

export async function run(msg, data) {
  const guildId = msg.channel?.guild?.id
      ?? msg.channel?.guildId
      ?? msg.channel?.server_id
      ?? msg.channel?.serverId
      ?? msg.message?.guildId
      ?? msg.message?.server_id
      ?? msg.message?.serverId;
  const cleanGuildId = cleanId(guildId);

  const guildPlayers = this.players.findGuildPlayers(cleanGuildId);

  // Resolve the target channel to leave:
  // 1. If a channel option was provided, use that
  // 2. Otherwise, use the user's current voice channel
  const specifiedChannel = data?.get("channel")?.value;
  let targetChannelId = null;

  if (specifiedChannel) {
    targetChannelId = cleanId(specifiedChannel);
  } else {
    const userChannelId = this.players.checkVoiceChannels(msg);
    if (userChannelId) targetChannelId = cleanId(userChannelId);
  }

  // If we still don't have a target channel
  if (!targetChannelId) {
    if (guildPlayers.length === 0) {
      return msg.reply(embed(this.t(msg, "responses.leave.notInVoice")));
    }
    // User not in voice and no channel specified — list all channels the bot is in
    const channelList = guildPlayers.map(([mapKey, p]) => {
      const id = cleanId(p._channelId ?? mapKey);
      return id ? `<#${id}>` : "`unknown`";
    });
    return msg.reply(embed(
        this.t(msg, "responses.leave.specifyChannel", {
          channels: channelList.map(c => `• ${c}`).join("\n"),
          prefix: this.getSettings(msg)?.get("prefix") ?? "%"
        })
    ));
  }

  // Find the player for the target channel.
  // Match against both the map key and _channelId because after a voice-move
  // these can differ (the map key stays as the original join channel ID while
  // _channelId updates to the new channel).
  const playerEntry = this.players.findPlayerEntryByChannelId(targetChannelId);
  const player = playerEntry?.player ?? null;

  if (!player) {
    // No player in that channel — check if user picked a non-voice channel
    if (guildPlayers.length === 0) {
      return msg.reply(embed(this.t(msg, "responses.leave.notInVoice")));
    }
    const channelList = guildPlayers.map(([mapKey, p]) => {
      const id = cleanId(p._channelId ?? mapKey);
      return id ? `<#${id}>` : "`unknown`";
    });
    return msg.reply(embed(
        this.t(msg, "responses.leave.noPlayerInChannel", {
          channel: `<#${targetChannelId}>`,
          channels: channelList.map(c => `• ${c}`).join("\n")
        })
    ));
  }

  if (!player?.connection) return msg.reply(embed(this.t(msg, "responses.leave.playerNotInit")));

  const activeChannelId = cleanId(player._channelId) || targetChannelId;
  const homeChannelId = cleanId(player._home247Channel) || activeChannelId;

  // ── 24/7 handling ────────────────────────────────────────────────────────
  const set = this.getSettings(msg);
  const raw = set?.get("stay_247");
  const ch247 = (!raw || raw === "none")
      ? new Set()
      : Array.isArray(raw)
          ? new Set(raw.map(id => cleanId(id)).filter(Boolean))
          : new Set([cleanId(raw)]);

  // ── Snapshot all 247 auto channels in this guild BEFORE leaving ────────
  // When the bot leaves one channel, the gateway may send a guild-level
  // disconnect that kills ALL voice connections in the guild (not just the
  // target).  By snapshotting beforehand, we can schedule rejoins for every
  // 24/7 auto channel that was collateral-disconnected.
  const other247AutoChannels = [...ch247].filter(id => {
    if (id === activeChannelId || id === homeChannelId || id === targetChannelId) return false;
    const mode = get247ChannelMode(set, id);
    return mode === "auto";
  });

  const matchChannel = ch247.has(homeChannelId) ? homeChannelId
      : ch247.has(activeChannelId) ? activeChannelId
      : null;
  const mode = matchChannel ? get247ChannelMode(set, matchChannel) : "off";

  if (matchChannel) {
    this.markIntentionalLeave(activeChannelId);
    if (homeChannelId !== activeChannelId) this.markIntentionalLeave(homeChannelId);

    this.players.detachPlayer(player, targetChannelId);
    await player.leave().catch(() => {});
    player.destroy();

    const respawnBaseDelay = this.config?.timers?.leave247RejoinDelay ?? 5000;
    const respawnStagger = this.config?.timers?.rejoin247Delay ?? 3000;

    if (mode === "auto") {
      msg.reply(embed(this.t(msg, "responses.leave.leftRejoin247", { channel: targetChannelId, prefix: set?.get("prefix") ?? "%" })));
      this.players.schedule247Respawns(guildId, [homeChannelId, ...other247AutoChannels], {
        baseDelay: respawnBaseDelay,
        stagger: respawnStagger,
        source: "leave",
      });
    } else {
      msg.reply(embed(this.t(msg, "responses.leave.left247On", { prefix: set?.get("prefix") ?? "%" })));
      this.players.schedule247Respawns(guildId, other247AutoChannels, {
        baseDelay: respawnBaseDelay,
        stagger: respawnStagger,
        source: "leave",
      });
    }
  } else {
    await this.leaveChannel(activeChannelId, guildId, msg);
  }
}
