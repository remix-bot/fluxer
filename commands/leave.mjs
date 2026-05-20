import { CommandBuilder } from "../src/CommandHandler.mjs";
import { logger } from "../src/constants/Logger.mjs";
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

/**
 * Resolve the guild ID from a player entry.
 * Uses _guildId if set (populated after join() completes), otherwise falls
 * back to the client channel cache. This is necessary because in the
 * multi-voice scenario _guildId can still be null for a freshly-joined player,
 * which caused guildPlayers to be empty and leave to report "not in voice".
 */
function resolvePlayerGuildId(player, mapKey, client) {
  const direct = cleanId(player?._guildId);
  if (direct) return direct;
  const cid = cleanId(player?._channelId ?? mapKey);
  if (!cid) return "";
  const ch = client?.channels?.get?.(cid);
  return cleanId(ch?.guildId ?? ch?.guild?.id ?? ch?.server_id ?? ch?.serverId);
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

  const client = this.client;
  const guildPlayers = [...this.players.playerMap.entries()].filter(([mapKey, p]) => {
    if (p?._destroyed) return false;
    return resolvePlayerGuildId(p, mapKey, client) === cleanGuildId;
  });

  const specifiedChannel = data?.get("channel")?.value;
  let targetChannelId = null;

  if (specifiedChannel) {
    targetChannelId = cleanId(specifiedChannel);
  } else {
    const userChannelId = this.players.checkVoiceChannels(msg);
    if (userChannelId) targetChannelId = cleanId(userChannelId);
  }

  if (!targetChannelId) {
    if (guildPlayers.length === 0) {
      return msg.reply(embed(this.t(msg, "responses.leave.notInVoice")));
    }
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

  const player = this.players.playerMap.get(targetChannelId)
      ?? guildPlayers.find(([mapKey, p]) =>
          cleanId(p._channelId) === targetChannelId || cleanId(mapKey) === targetChannelId
      )?.[1]
      ?? null;

  if (!player) {
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

  const set = this.getSettings(msg);
  const raw = set?.get("stay_247");
  const ch247 = (!raw || raw === "none")
      ? new Set()
      : Array.isArray(raw)
          ? new Set(raw.map(id => cleanId(id)).filter(Boolean))
          : new Set([cleanId(raw)]);

  const other247AutoChannels = [...ch247].filter(id => {
    if (id === activeChannelId || id === homeChannelId || id === targetChannelId) return false;
    const mode = get247ChannelMode(set, id);
    return mode === "auto";
  });

  if (ch247.has(activeChannelId) || ch247.has(homeChannelId)) {
    const matchChannel = ch247.has(homeChannelId) ? homeChannelId
        : ch247.has(activeChannelId) ? activeChannelId
        : null;
    const mode = matchChannel ? get247ChannelMode(set, matchChannel) : "off";
    this.markIntentionalLeave(activeChannelId);
    this.players.playerMap.delete(activeChannelId);
    if (activeChannelId !== targetChannelId) this.players.playerMap.delete(targetChannelId);
    if (homeChannelId !== activeChannelId) this.players.playerMap.delete(homeChannelId);
    await player.leave().catch(() => {});
    player.destroy();

    if (mode === "auto") {
      msg.reply(embed(this.t(msg, "responses.leave.leftRejoin247", { channel: targetChannelId, prefix: set?.get("prefix") ?? "%" })));
      const leave247Delay = this.config?.timers?.leave247RejoinDelay ?? 5000;
      setTimeout(() => {
        if (this._spawnPlayer) {
          this._spawnPlayer(guildId, homeChannelId).catch(e =>
              logger.warn("[leave] 247 rejoin failed for", homeChannelId, e.message)
          );
        }
      }, leave247Delay);

      if (other247AutoChannels.length > 0) {
        const rejoinBaseDelay = leave247Delay;
        const rejoinStagger = this.config?.timers?.rejoin247Delay ?? 3000;
        for (let i = 0; i < other247AutoChannels.length; i++) {
          const otherChannelId = other247AutoChannels[i];
          const otherPlayer = this.players.playerMap.get(otherChannelId);
          if (!otherPlayer || otherPlayer._destroyed) {
            if (otherPlayer) {
              this.players.playerMap.delete(otherChannelId);
              try { otherPlayer.destroy(); } catch (_) {}
            }
            const delay = rejoinBaseDelay + (i + 1) * rejoinStagger;
            logger.recovery(
              `[leave] Scheduling 247 auto-rejoin for collateral-disconnected channel ${otherChannelId} in ${delay}ms`
            );
            setTimeout(() => {
              if (this._spawnPlayer) {
                this._spawnPlayer(guildId, otherChannelId).catch(e =>
                    logger.warn("[leave] 247 collateral rejoin failed for", otherChannelId, e.message)
                );
              }
            }, delay);
          }
        }
      }
    } else {
      msg.reply(embed(this.t(msg, "responses.leave.left247On", { prefix: set?.get("prefix") ?? "%" })));

      if (other247AutoChannels.length > 0) {
        const rejoinDelay = this.config?.timers?.leave247RejoinDelay ?? 5000;
        const rejoinStagger = this.config?.timers?.rejoin247Delay ?? 3000;
        for (let i = 0; i < other247AutoChannels.length; i++) {
          const otherChannelId = other247AutoChannels[i];
          const otherPlayer = this.players.playerMap.get(otherChannelId);
          if (!otherPlayer || otherPlayer._destroyed) {
            if (otherPlayer) {
              this.players.playerMap.delete(otherChannelId);
              try { otherPlayer.destroy(); } catch (_) {}
            }
            const delay = rejoinDelay + (i + 1) * rejoinStagger;
            logger.recovery(
              `[leave] Scheduling 247 auto-rejoin for collateral-disconnected channel ${otherChannelId} in ${delay}ms`
            );
            setTimeout(() => {
              if (this._spawnPlayer) {
                this._spawnPlayer(guildId, otherChannelId).catch(e =>
                    logger.warn("[leave] 247 collateral rejoin failed for", otherChannelId, e.message)
                );
              }
            }, delay);
          }
        }
      }
    }
  } else {
    await this.leaveChannel(activeChannelId, guildId, msg);
  }
}
