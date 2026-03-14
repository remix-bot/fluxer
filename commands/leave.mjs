import { CommandBuilder } from "../src/CommandHandler.mjs";

export function leaveChannel(msg, cid, p) {
  return new Promise(async res => {
    this.playerMap.delete(cid);
    const m = await msg.replyEmbed("Leaving...");
    const left = p.leave();
    p.destroy();
    m.editEmbed(left ? `✅ Successfully Left` : `Not connected to any voice channel`);
    res();
  });
}

export const command = new CommandBuilder()
  .setName("leave")
  .setDescription("Make the bot leave your current voice channel", "commands.leave")
  .addAliases("l", "stop");

export async function run(msg) {
  const p = await this.getPlayer(msg, false, false);
  if (!p) return;
  if (!p.connection) return msg.replyEmbed("Player not initialized.");
  const cid = p.connection.channelId;
  this.players.leave(msg, cid);
}

export const exportDef = {
  name: "leaveChannel",
  object: leaveChannel
};
