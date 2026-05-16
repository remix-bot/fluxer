import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";
import { logger } from "../src/constants/Logger.mjs";
import Player from "../src/Player.mjs";

function getGuildId(message) {
  return message?.channel?.guildId
      ?? message?.channel?.guild?.id
      ?? message?.message?.guildId
      ?? message?.message?.guild?.id
      ?? message?.channel?.server_id
      ?? message?.channel?.serverId
      ?? null;
}

function cleanId(value) {
  return String(value ?? "").replace(/\D/g, "");
}

export async function joinChannel(message, cid, cb = () => {}, ecb = () => {}) {
  if (!this.client.channels.has(cid)) {
    ecb();
    const embed = new EmbedBuilder().setColor(getGlobalColor())
        .setDescription(this.t(message, "responses.join.channelNotFound", { channel: cid }));
    return message.reply({ embeds: [embed] });
  }
  const cleanChannelId = cleanId(cid);
  const existing = this.players.playerMap.get(cleanChannelId)
      ?? [...this.players.playerMap.values()].find((player) => cleanId(player?._channelId) === cleanChannelId);
  if (existing) {
    cb(existing);
    const embed = new EmbedBuilder().setColor(getGlobalColor())
        .setDescription(this.t(message, "responses.join.alreadyJoined", { channel: cid }));
    return message.reply({ embeds: [embed] });
  }

  // Guard: moonlink must be ready before we can play anything
  if (!this.moonlink) {
    const embed = new EmbedBuilder().setColor(getGlobalColor())
        .setDescription(this.t(message, "responses.join.audioNodeConnecting"));
    ecb();
    return message.reply({ embeds: [embed] });
  }

  const p = new Player(this.config.token, {
    client:             this.client,
    config:             this.config,
    nodelink:           this.config.nodelink,
    moonlink:           this.moonlink ?? null,
    revoice:            this.revoice ?? null,
    messageChannel:     message.channel,
    settingsMgr:        this.settingsMgr ?? this.settings ?? null,
    observedVoiceUsers: this.observedVoiceUsers ?? null,
  });

  p.on("autoleave", () => {
    const activeChannelId = String(p._channelId ?? cid).replace(/\D/g, "") || cid;
    const homeChannelId = String(p._home247Channel ?? activeChannelId).replace(/\D/g, "") || activeChannelId;
    const guildId = getGuildId(message);

    // Check 24/7 mode for this channel
    const is247 = (() => {
      try {
        const raw = this.settingsMgr?.getServer?.(guildId)?.get?.("stay_247");
        return raw && raw !== "none";
      } catch (_) { return false; }
    })();

    // Determine per-channel mode
    const mode247 = (() => {
      if (!is247) return "off";
      try {
        const set = this.settingsMgr?.getServer?.(guildId);
        const modes = set?.get?.("stay_247_modes");
        const matchCh = homeChannelId || activeChannelId;
        if (modes && typeof modes === "object" && !Array.isArray(modes) && modes[matchCh]) {
          return modes[matchCh];
        }
        return set?.get?.("stay_247_mode") ?? "off";
      } catch (_) { return "off"; }
    })();

    this.players.playerMap.delete(activeChannelId);
    if (activeChannelId !== cid) this.players.playerMap.delete(cid);
    if (homeChannelId !== activeChannelId) this.players.playerMap.delete(homeChannelId);
    p.destroy();

    if (is247 && (mode247 === "on" || mode247 === "auto")) {
      // 24/7 mode — auto-rejoin after a delay
      const rejoinDelay = this.config?.timers?.rejoin247Delay ?? 3_000;
      const prefix = (() => {
        try { return this._commands?.getPrefix?.(guildId) ?? "%"; } catch (_) { return "%"; }
      })();
      const embed = new EmbedBuilder().setColor(getGlobalColor())
          .setDescription(this.t(message, "responses.join.autoLeaveInactive247", { channel: activeChannelId, prefix }));
      message.channel.send({ embeds: [embed] }).catch(() => {});
      setTimeout(async () => {
        try {
          if (typeof this._spawnPlayer === "function") {
            await this._spawnPlayer(guildId, homeChannelId);
          }
        } catch (e) {
          logger.warn(`[join/autoleave] 24/7 auto-rejoin failed for ${homeChannelId}: ${e.message}`);
        }
      }, rejoinDelay);
    } else {
      // Not 24/7 — send inactivity message
      const prefix = (() => {
        try { return this._commands?.getPrefix?.(guildId) ?? "%"; } catch (_) { return "%"; }
      })();
      const embed2 = new EmbedBuilder().setColor(getGlobalColor())
          .setDescription(this.t(message, "responses.join.autoLeaveInactive", { channel: activeChannelId }));
      message.channel.send({ embeds: [embed2] }).catch(() => {});
    }
  });

  p.on("message", m => {
    const guildId  = getGuildId(message);
    const raw      = this.settingsMgr?.getServer?.(guildId)?.get("songAnnouncements");
    const disabled = raw === false || raw === 0 ||
        ["false","0","no","off","disable"].includes(String(raw).toLowerCase().trim());
    if (disabled) return;
    const embed = new EmbedBuilder().setColor(getGlobalColor()).setDescription(m);
    message.channel.send({ embeds: [embed] });
  });

  // Mark as pending so concurrent commands see the channel is taken,
  // but don't add to playerMap until join() succeeds to avoid phantom
  // entries inflating the player count.
  this.players._pendingJoins.add(cleanChannelId);

  const joiningEmbed = new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(message, "responses.join.joining"));
  const statusMsg = await message.reply({ embeds: [joiningEmbed] });
  try {
    await p.join(cleanChannelId);
    // Only add to playerMap after join succeeds
    this.players.playerMap.set(cleanChannelId, p);
    this.players._pendingJoins.delete(cleanChannelId);
    const okEmbed = new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(message, "responses.join.joined", { channel: cid }));
    await statusMsg.edit({ embeds: [okEmbed] });
    cb(p);
  } catch (e) {
    this.players._pendingJoins.delete(cleanChannelId);
    this.players.playerMap.delete(cleanChannelId);
    p.destroy();
    const errEmbed = new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(message, "responses.join.joinFailed", { error: e.message }));
    await statusMsg.edit({ embeds: [errEmbed] });
    ecb(e);
  }
}

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

export async function run(message, data) {
  // Check if a channel argument was provided (mention like <#123456>, bare ID, or name)
  const rawArg = data?.get?.("channel")?.value?.trim?.() ?? null;

  if (rawArg) {
    // Parse channel mention <#ID>, bare numeric ID, or channel name
    const mentionMatch = rawArg.match(/^<#(\d+)>$/);
    const idMatch      = rawArg.match(/^(\d{15,})$/);
    let resolvedId     = null;

    if (mentionMatch) {
      resolvedId = mentionMatch[1];
    } else if (idMatch) {
      resolvedId = idMatch[1];
    } else {
      // Try to look up by name
      const guildId = cleanId(getGuildId(message));
      const allChannels = [
        ...(this.client?.channels?.values?.() ?? [])
      ];
      const match = allChannels.find(c => {
        const cServerId = cleanId(c.guildId ?? c.guild?.id ?? c.server_id ?? c.serverId);
        // Fluxer uses numeric channel types: 0=text, 2=voice, 4=category, 5=link
        const isVoice = c.type === 2;
        return isVoice && cServerId === guildId &&
            (c.name?.toLowerCase() === rawArg.toLowerCase());
      });
      if (match) resolvedId = match.id;
    }

    if (!resolvedId) {
      const embed = new EmbedBuilder().setColor(getGlobalColor())
          .setDescription(this.t(message, "responses.join.voiceChannelNotFound"));
      return message.reply({ embeds: [embed] });
    }

    return this.players.initPlayer(message, resolvedId);
  }

  // No argument — auto-detect the user's current voice channel
  const cid = this.players.checkVoiceChannels(message);

  if (!cid) {
    const prefix = this._commands?.getPrefix?.(getGuildId(message)) ?? "%";
    const embed = new EmbedBuilder().setColor(getGlobalColor())
        .setDescription(this.t(message, "responses.join.noVoiceChannel", { prefix }));
    return message.reply({ embeds: [embed] });
  }

  this.players.initPlayer(message, cid);
}

export const exportDef = {
  name: "joinChannel",
  object: joinChannel
};