/**
 * @module commands/forceleave
 * @description Force the bot to leave a voice channel (requires ManageChannels permission).
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { cleanId } from "../src/ui/index.mjs";
import { resolveChannelCached } from "../src/utils/Helpers247.mjs";

/**
 * @type {CommandBuilder}
 * @description Command definition for the forceleave command.
 */
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
 * Run handler for the forceleave command.
 * Validates the target channel and forces the bot to leave.
 *
 * @param {object} msg - The command message wrapper.
 * @param {object} data - Parsed command data containing the channelId option.
 * @returns {Promise<void>}
 */
export async function run(msg, data) {
  const cid = cleanId(data.get("channelId").value);
  const targetChannel = await resolveChannelCached(this.client, cid);
  if (!targetChannel) return msg.reply(this.t(msg, "responses.forceleave.channelNotFound"));
  if (cleanId(msg.message?.guildId) !== cleanId(targetChannel.guildId))
    return msg.reply(this.t(msg, "responses.forceleave.wrongServer"));
  const p = this.players.playerMap.get(cid)
    ?? [...this.players.playerMap.values()].find((player) => cleanId(player?._channelId) === cid);
  if (!p) return msg.reply(this.t(msg, "responses.forceleave.playerNotFound"));
  if (!p.connection) return msg.reply(this.t(msg, "responses.forceleave.playerNotInit"));
  await this.players.leave(msg, cid);
}
