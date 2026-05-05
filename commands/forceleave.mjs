import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

export const command = new CommandBuilder()
  .setName("forceleave")
  .addAlias("fl")
  .setDescription("Make Remix leave a channel even if you're not in it.")
  .setRequirement(r => r.addPermission("ManageChannels"))
  .setCategory("music")
  .addChannelOption(o =>
    o.setName("channelId")
      .setDescription("The channel that should be left.")
      .setRequired(true)
  );

function embed(desc) {
  return { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(desc)] };
}

function cleanId(value) {
  return String(value ?? "").replace(/\D/g, "");
}

export async function run(msg, data) {
  const cid = cleanId(data.get("channelId").value);
  const targetChannel = this.client.channels.get(cid);
  if (!targetChannel) return msg.reply(embed(this.t(msg, "responses.forceleave.channelNotFound")));
  if (cleanId(msg.message.guildId) !== cleanId(targetChannel.guildId))
    return msg.reply(embed(this.t(msg, "responses.forceleave.wrongServer")));
  const p = this.players.playerMap.get(cid)
    ?? [...this.players.playerMap.values()].find((player) => cleanId(player?._channelId) === cid);
  if (!p) return msg.reply(embed(this.t(msg, "responses.forceleave.playerNotFound")));
  if (!p.connection) return msg.reply(embed(this.t(msg, "responses.forceleave.playerNotInit")));
  await this.players.leave(msg, cid);
}
