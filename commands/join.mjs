import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";
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
  if (!this.client.channels.cache.has(cid)) {
    ecb();
    const embed = new EmbedBuilder().setColor(getGlobalColor())
        .setDescription("Couldn't find the channel `" + cid + "`\nUse the help command to learn more about this. (`%help join`)")
        .toJSON();
    return message.replyEmbed({ embeds: [embed] });
  }
  const cleanChannelId = cleanId(cid);
  const existing = this.players.playerMap.get(cleanChannelId)
    ?? [...this.players.playerMap.values()].find((player) => cleanId(player?._channelId) === cleanChannelId);
  if (existing) {
    cb(existing);
    const embed = new EmbedBuilder().setColor(getGlobalColor())
        .setDescription("Already joined <#" + cid + ">.")
        .toJSON();
    return message.replyEmbed({ embeds: [embed] });
  }

  // Guard: moonlink must be ready before we can play anything
  if (!this.moonlink) {
    const embed = new EmbedBuilder().setColor(getGlobalColor())
        .setDescription("⚠️ Audio node is still connecting — please try again in a few seconds.")
        .toJSON();
    ecb();
    return message.replyEmbed({ embeds: [embed] });
  }

  const p = new Player(this.config.token, {
    client:             this.client,
    config:             this.config,
    nodelink:           this.config.nodelink,
    moonlink:           this.moonlink ?? null,
    messageChannel:     message.channel,
    settingsMgr:        this.settingsMgr ?? this.settings ?? null,
    observedVoiceUsers: this.observedVoiceUsers ?? null,
  });

  p.on("autoleave", () => {
    const activeChannelId = String(p._channelId ?? cid).replace(/\D/g, "") || cid;
    const homeChannelId = String(p._home247Channel ?? activeChannelId).replace(/\D/g, "") || activeChannelId;
      const guildId = getGuildId(message);
    const is247 = (() => {
      try {
        const raw = this.settingsMgr?.getServer?.(guildId)?.get?.("stay_247");
        return raw && raw !== "none";
      } catch (_) { return false; }
    })();
    const prefix = (() => {
      try {
        return this._commands?.getPrefix?.(guildId) ?? "%";
      } catch (_) { return "%"; }
    })();
    const desc = is247
        ? `Left channel <#${activeChannelId}> because of inactivity.`
        : `Left channel <#${activeChannelId}> because of inactivity.\nIf you want me to stay in voice, use \`${prefix}247 on/auto\``;
    const embed = new EmbedBuilder().setColor(getGlobalColor())
        .setDescription(desc)
        .toJSON();
    message.channel.sendEmbed({ embeds: [embed] });
    this.players.playerMap.delete(activeChannelId);
    if (activeChannelId !== cid) this.players.playerMap.delete(cid);
    if (homeChannelId !== activeChannelId) this.players.playerMap.delete(homeChannelId);
    p.destroy();
  });

  p.on("message", m => {
    const guildId  = getGuildId(message);
    const raw      = this.settingsMgr?.getServer?.(guildId)?.get("songAnnouncements");
    const disabled = raw === false || raw === 0 ||
        ["false","0","no","off","disable"].includes(String(raw).toLowerCase().trim());
    if (disabled) return;
    const embed = new EmbedBuilder().setColor(getGlobalColor()).setDescription(m).toJSON();
    message.channel.sendEmbed({ embeds: [embed] });
  });

  this.players.playerMap.set(cleanChannelId, p);

  const joiningEmbed = new EmbedBuilder().setColor(getGlobalColor()).setDescription("⏳ Joining Channel...").toJSON();
  const statusMsg = await message.replyEmbed({ embeds: [joiningEmbed] });
  try {
    await p.join(cleanChannelId);
    const okEmbed = new EmbedBuilder().setColor(getGlobalColor()).setDescription(`✅ Successfully joined <#${cid}>`).toJSON();
    await statusMsg.editEmbed({ embeds: [okEmbed] });
    cb(p);
  } catch (e) {
    this.players.playerMap.delete(cleanChannelId);
    p.destroy();
    const errEmbed = new EmbedBuilder().setColor(getGlobalColor()).setDescription(`❌ Failed to join: ${e.message}`).toJSON();
    await statusMsg.editEmbed({ embeds: [errEmbed] });
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

export function run(message, data) {
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
        ...(this._commands?.client?.channels?.values?.() ??
            this._commands?.client?.channels?.cache?.values?.() ??
            this.client?.channels?.values?.() ??
            this.client?.channels?.cache?.values?.() ?? [])
      ];
      const match = allChannels.find(c => {
        const cServerId = cleanId(c.guildId ?? c.guild?.id ?? c.server_id ?? c.serverId);
        const isVoice   = c.channel_type === "VoiceChannel" || c.type === "VoiceChannel" || c.type === 2;
        return isVoice && cServerId === guildId &&
            (c.name?.toLowerCase() === rawArg.toLowerCase());
      });
      if (match) resolvedId = match._id ?? match.id;
    }

    if (!resolvedId) {
      const embed = new EmbedBuilder().setColor(getGlobalColor())
          .setDescription("❌ Couldn't find that voice channel. Try using a mention like `<#channelid>` or the exact channel name.")
          .toJSON();
      return message.replyEmbed({ embeds: [embed] });
    }

    return this.players.initPlayer(message, resolvedId);
  }

  // No argument — auto-detect the user's current voice channel
  const cid = this.players.checkVoiceChannels(message);

  if (!cid) {
    const prefix = this._commands?.getPrefix?.(getGuildId(message)) ?? "%";
    const embed = new EmbedBuilder().setColor(getGlobalColor())
        .setDescription(`❌ You're not in a voice channel. Please join one first, or specify a channel: \`${prefix}join <#channel>\``)
        .toJSON();
    return message.replyEmbed({ embeds: [embed] });
  }

  this.players.initPlayer(message, cid);
}

export const exportDef = {
  name: "joinChannel",
  object: joinChannel
};
