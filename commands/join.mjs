import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";
import Player from "../src/Player.mjs";

export async function joinChannel(message, cid, cb = () => {}, ecb = () => {}) {
  if (!this.client.channels.cache.has(cid)) {
    ecb();
    const embed = new EmbedBuilder().setColor(getGlobalColor())
        .setDescription("Couldn't find the channel `" + cid + "`\nUse the help command to learn more about this. (`%help join`)")
        .toJSON();
    return message.replyEmbed({ embeds: [embed] });
  }
  if (this.players.playerMap.has(cid)) {
    cb(this.players.playerMap.get(cid));
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
    const guildId = message.channel?.guildId
        ?? message.channel?.guild?.id
        ?? message.message?.guildId
        ?? message.channel?.server_id
        ?? message.channel?.serverId;
    const is247 = (() => {
      try {
        const raw = this.settingsMgr?.getServer?.(guildId)?.get?.("stay_247");
        return raw && raw !== "none";
      } catch (_) { return false; }
    })();
    const prefix = (() => {
      try {
        return this._commands?.getPrefix?.(message.channel?.guild?.id) ?? "%";
      } catch (_) { return "%"; }
    })();
    const desc = is247
      ? `Left channel <#${cid}> because of inactivity.`
      : `Left channel <#${cid}> because of inactivity.\nIf you want me to stay in voice, use \`${prefix}247 on/auto\``;
    const embed = new EmbedBuilder().setColor(getGlobalColor())
        .setDescription(desc)
        .toJSON();
    message.channel.sendEmbed({ embeds: [embed] });
    this.players.playerMap.delete(cid);
    p.destroy();
  });

  p.on("message", m => {
    const guildId  = message.channel?.guild?.id ?? message.channel?.server_id ?? message.channel?.serverId;
    const raw      = this.settingsMgr?.getServer?.(guildId)?.get("songAnnouncements");
    const disabled = raw === false || raw === 0 ||
        ["false","0","no","off","disable"].includes(String(raw).toLowerCase().trim());
    if (disabled) return;
    const embed = new EmbedBuilder().setColor(getGlobalColor()).setDescription(m).toJSON();
    message.channel.sendEmbed({ embeds: [embed] });
  });

  this.players.playerMap.set(cid, p);

  const joiningEmbed = new EmbedBuilder().setColor(getGlobalColor()).setDescription("⏳ Joining Channel...").toJSON();
  const statusMsg = await message.replyEmbed({ embeds: [joiningEmbed] });
  try {
    await p.join(cid);
    const okEmbed = new EmbedBuilder().setColor(getGlobalColor()).setDescription(`✅ Successfully joined <#${cid}>`).toJSON();
    await statusMsg.editEmbed({ embeds: [okEmbed] });
    cb(p);
  } catch (e) {
    this.players.playerMap.delete(cid);
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
    .setCategory("music");

export function run(message) {
  // @fluxerjs/core Message has no .member property — voice channel detection
  // is handled entirely by checkVoiceChannels() via the VoiceManager state map.
  const cid = this.players.checkVoiceChannels(message);

  if (!cid) {
    const embed = new EmbedBuilder().setColor(getGlobalColor())
        .setDescription("❌ You're not in a voice channel. Please join one first.")
        .toJSON();
    return message.replyEmbed({ embeds: [embed] });
  }

  this.players.initPlayer(message, cid);
}

export const exportDef = {
  name: "joinChannel",
  object: joinChannel
};
