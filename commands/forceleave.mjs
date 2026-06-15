/**
 * @file forceleave command — Force the bot to leave a voice channel (requires ManageChannels)
 * @module commands/forceleave
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";
import { cleanId } from "../src/MessageHandler.mjs";

export const command = new CommandBuilder()
  .setName("forceleave")
  .addAliases("fl")
  .setDescription("Make Remix leave a channel even if you're not in it.")
  .setRequirement(r => r.addPermission("ManageChannels"))
  .setCategory("music")
  .addChannelOption(o =>
    o.setName("channelId")
      .setDescription("The channel that should be left.")
      .setRequired(true)
  );


/**
 * Execute the forceleave command.
 * @param {import("../src/MessageHandler.mjs").Message} msg - The incoming message
 * @param {Map<string, {value: *}>} data - Slash-command options map
 * @returns {Promise<void>}
 */
export async function run(msg, data) {
  const cid = cleanId(data.get("channelId").value);
  const targetChannel = this.client.channels.get(cid);
  if (!targetChannel) return msg.reply(this.t(msg, "responses.forceleave.channelNotFound"));
  if (cleanId(msg.message?.guildId) !== cleanId(targetChannel.guildId))
    return msg.reply(this.t(msg, "responses.forceleave.wrongServer"));
  const p = this.players.playerMap.get(cid)
    ?? [...this.players.playerMap.values()].find((player) => cleanId(player?._channelId) === cid);
  if (!p) return msg.reply(this.t(msg, "responses.forceleave.playerNotFound"));
  if (!p.connection) return msg.reply(this.t(msg, "responses.forceleave.playerNotInit"));
  await this.players.leave(msg, cid);
}
