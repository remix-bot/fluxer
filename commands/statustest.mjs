/**
 * @module commands/statustest
 * @description Owner-only diagnostic command to test the public status channel,
 * force-refresh the live health card, and simulate subsystem incidents / resolutions.
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/ui/index.mjs";

/** @type {CommandBuilder} @description Command definition for statustest (owner-only). */
export const command = new CommandBuilder()
  .setName("statustest")
  .setDescription("Test public status channel updates, live cards, and incidents.", "commands.statustest")
  .setCategory("util")
  .setRequirement(r => r.setOwnerOnly(true));

/**
 * @async
 * Run handler for the statustest command.
 * @param {object} msg - The command message wrapper.
 * @returns {Promise<void>}
 */
export async function run(msg) {
  const statusMgr = this.statusChannel;
  if (!statusMgr || !statusMgr.enabled || !statusMgr.channelId) {
    const embed = new EmbedBuilder()
      .setColor(getGlobalColor())
      .setAuthor({ name: this.t(msg, "responses.statustest.disabledAuthor") })
      .setTitle(this.t(msg, "responses.statustest.disabledTitle"))
      .setDescription(this.t(msg, "responses.statustest.disabledDesc"));
    return msg.reply({ embeds: [embed] });
  }

  const prefix = this.commands?.getPrefix?.(msg.message?.guildId) || "%";
  const args = (msg.args || []).map(a => String(a).trim().toLowerCase());
  const subCommand = args[0] || "help";

  if (subCommand === "refresh") {
    await statusMgr.updateLiveCard();
    const embed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle(this.t(msg, "responses.statustest.refreshedTitle"))
      .setDescription(this.t(msg, "responses.statustest.refreshedDesc", {
        channelId: statusMgr.channelId,
        messageId: statusMgr.liveMessageId || "New",
      }));
    return msg.reply({ embeds: [embed] });
  }

  if (subCommand === "incident") {
    const target = args[1] || "gateway";
    const customReason = msg.args.slice(2).join(" ") || "Manual test incident triggered by bot owner.";
    await statusMgr.triggerIncident(target, customReason);
    const embed = new EmbedBuilder()
      .setColor(0xe74c3c)
      .setTitle(this.t(msg, "responses.statustest.incidentTitle"))
      .setDescription(this.t(msg, "responses.statustest.incidentDesc", {
        target,
        channelId: statusMgr.channelId,
        prefix,
      }));
    return msg.reply({ embeds: [embed] });
  }

  if (subCommand === "resolve") {
    const target = args[1] || "gateway";
    const customNote = msg.args.slice(2).join(" ") || "Manual test resolution confirmed stable.";
    await statusMgr.resolveIncident(target, customNote);
    const embed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle(this.t(msg, "responses.statustest.resolvedTitle"))
      .setDescription(this.t(msg, "responses.statustest.resolvedDesc", {
        target,
        channelId: statusMgr.channelId,
      }));
    return msg.reply({ embeds: [embed] });
  }

  /* Default Help */
  const embed = new EmbedBuilder()
    .setColor(getGlobalColor())
    .setAuthor({ name: this.t(msg, "responses.statustest.author") })
    .setTitle(this.t(msg, "responses.statustest.helpTitle"))
    .setDescription(this.t(msg, "responses.statustest.helpDesc", {
      channelId: statusMgr.channelId,
      cardId: statusMgr.liveMessageId || "Not yet created",
      prefix,
    }));
  return msg.reply({ embeds: [embed] });
}
