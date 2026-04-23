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
  return { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(desc).toJSON()] };
}

export async function run(msg, data) {
  const cid = data.get("channelId").value;
  const targetChannel = this.client.channels.cache.get(cid);
  if (!targetChannel) return msg.replyEmbed(embed("❌ Channel not found."));
  if (msg.message.guildId !== targetChannel.guildId)
    return msg.replyEmbed(embed("❌ This command has to be run in the same server as the voice channel."));
  const p = this.players.playerMap.get(cid);
  if (!p) return msg.replyEmbed(embed("❌ Player not found."));
  if (!p.connection) return msg.replyEmbed(embed("❌ Player not initialized."));
  await this.players.leave(msg, cid);
}
