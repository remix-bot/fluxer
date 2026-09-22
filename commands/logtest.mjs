/**
 * @module commands/logtest
 * @description Owner-only diagnostic command that posts a test entry into the
 * configured error-log channel (see config.errorLogChannel), so the owner can
 * verify the ErrorChannel wiring end to end: tap -> queue -> REST delivery.
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/ui/index.mjs";
import { logger } from "../src/core/Logger.mjs";
import { isLogChannelEnabled } from "../src/core/ErrorChannel.mjs";

/** @type {CommandBuilder} @description Command definition for the logtest command (owner-only). */
export const command = new CommandBuilder()
  .setName("logtest")
  .setDescription("Sends a test entry to your error-log channel.")
  .setCategory("util")
  .setRequirement(r => r.setOwnerOnly(true));

/**
 * @async
 * Run handler for the logtest command. Reports the ErrorChannel status and,
 * when enabled, pushes one deliberately distinctive test line through
 * logger.error so it travels the exact same path a real error would.
 * @param {object} msg - The command message wrapper.
 * @returns {Promise<void>}
 */
export async function run(msg) {
  if (!isLogChannelEnabled()) {
    const embed = new EmbedBuilder().setColor(getGlobalColor()).setDescription(
      "❌ The error-log channel is **disabled**.\n" +
      "Set `errorLogChannel.enabled` to `true` and `errorLogChannel.channelId` to your log channel ID in config.json, then restart the bot."
    );
    return msg.reply({ embeds: [embed] });
  }

  const who = msg.author?.username ?? msg.message?.author?.username ?? "owner";
  logger.error(
    "[LogTest]",
    `Manual test entry requested by ${who} — if you can read this in the log channel, error forwarding is working.`
  );

  const embed = new EmbedBuilder().setColor(getGlobalColor()).setDescription(
    "📨 Test entry queued — check the log channel; it should arrive within a few seconds."
  );
  return msg.reply({ embeds: [embed] }).catch(() => {});
}
