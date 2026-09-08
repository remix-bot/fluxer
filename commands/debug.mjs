/**
 * @module commands/debug
 * @description Owner-only debug command for voice diagnostics, ghost connection
 * detection, and forced rejoin. The implementations live in commands/debug/
 * (gateway, rejoin, voiceDiagnostic); the builder and run() dispatch stay here.
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { ERROR_COLOR } from "../src/utils/UI.mjs";
import { isGhostConnection } from "./debug/gateway.mjs";
import { runBatchRejoin } from "./debug/rejoin.mjs";
import { runVoiceDiagnostic } from "./debug/voiceDiagnostic.mjs";

/**
 * @type {CommandBuilder}
 * @description Command definition for the debug command (owner-only).
 */
export const command = new CommandBuilder()
    .setName("debug")
    .setDescription("A debug command for various purposes.")
    .setRequirement(r => r.setOwnerOnly(true))
    .setCategory("util")
    .addChoiceOption(o =>
        o.setName("target")
            .setDescription("The target that should be examined.")
            .addChoices("voice", "voice-rejoin", "247-rejoin")
            .setRequired(true));


/**
 * Run handler for the debug command.
 * Routes to the appropriate debug subcommand based on the target option.
 *
 * @param {object} msg - The command message wrapper.
 * @param {object} data - Parsed command data containing the target option.
 * @returns {Promise<void>}
 */
export async function run(msg, data) {
  const target = data.get("target").value;

  switch (target) {
    case "247-rejoin": {
      return await runBatchRejoin.call(this, msg, "247-rejoin", "24/7 Rejoin", "24/7 channel(s)", p => !!p._home247Channel);
    }

    case "voice-rejoin": {
      return await runBatchRejoin.call(this, msg, "voice-rejoin", "Voice Rejoin", "ghost connection(s)", isGhostConnection, true);
    }

    case "voice": {
      return await runVoiceDiagnostic.call(this, msg);
    }

    default: {
      const embed = new EmbedBuilder()
          .setColor(ERROR_COLOR)
          .setTitle("Debug — Unknown Target")
          .setDescription(`Unknown debug target: \`${target}\`.\nValid options: \`voice\`, \`voice-rejoin\`, \`247-rejoin\`.`)
      ;
      return msg.reply({ embeds: [embed] });
    }
  }
}
