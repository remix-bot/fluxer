import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

export const command = new CommandBuilder()
    .setName("np")
    .setDescription("Request the name and url of the currently playing song.", "commands.np")
    .addAliases("current", "nowplaying");

export async function run(msg) {
  const p = await this.getPlayer(msg);
  if (!p) return;

  const loadingEmbed = new EmbedBuilder()
    .setColor(getGlobalColor())
    .setDescription("⏳ Loading...")
    .toJSON();
  const loadingMsg = await msg.replyEmbed({ embeds: [loadingEmbed] });

  const data = await p.nowPlaying();

  const embed = new EmbedBuilder()
    .setColor(getGlobalColor())
    .setDescription(data.msg);
  if (data.image) embed.setThumbnail(data.image);

  loadingMsg.editEmbed({ embeds: [embed.toJSON()] }).catch(() => {});
}
