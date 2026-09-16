/**
 * @module commands/ping
 * @description Show the bot's latency: REST roundtrip, gateway heartbeat and audio node ping.
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/ui/index.mjs";

/**
 * @type {CommandBuilder}
 * @description Command definition for the ping command.
 */
export const command = new CommandBuilder()
    .setName("ping")
    .setDescription("Check the bot's latency and connection health.", "commands.ping")
    .addAliases("latency", "pong")
    .setCategory("util");

/**
 * Safely read the gateway heartbeat latency (`client.ws.ping`).
 * Returns -1 when unavailable (not logged in yet, or no heartbeat ACK received yet).
 * @private
 * @param {object} client - The bot client.
 * @returns {number} Gateway latency in ms, or -1.
 */
function readGatewayPing(client) {
  try {
    const ping = client?.ws?.ping;
    return typeof ping === "number" && Number.isFinite(ping) ? ping : -1;
  } catch (_) {
    return -1;
  }
}

/**
 * Safely read the audio node latency from the connected NodeLink/Lavalink node.
 * `node.stats.ping` is the node's own gateway heartbeat latency; it can be -1
 * or undefined while the node has no playing players.
 * @private
 * @param {object} lavalink - The LavalinkManager instance.
 * @returns {object|null} `{ connected: true, ping: number|null }`, or null when no node is available.
 */
function readNodePing(lavalink) {
  try {
    const node = lavalink?.getNode?.();
    if (!node) return null;
    const ping = node?.stats?.ping;
    return {
      connected: true,
      ping: (typeof ping === "number" && Number.isFinite(ping) && ping >= 0) ? ping : null,
    };
  } catch (_) {
    return null;
  }
}

/**
 * Run handler for the ping command.
 * Replies with a placeholder embed (which measures the REST roundtrip), then
 * edits it with the roundtrip time, the gateway heartbeat latency and the
 * audio node ping when available.
 *
 * @param {object} message - The command message wrapper.
 * @returns {Promise<void>}
 */
export async function run(message) {
  const t = (...a) => this.t(message, ...a);

  const waitingEmbed = new EmbedBuilder()
      .setColor(getGlobalColor())
      .setDescription(t("responses.ping.measuring"));

  const t0 = Date.now();
  let sent;
  try {
    sent = await message.reply({ embeds: [waitingEmbed] });
  } catch (e) {
    return; // couldn't even send the placeholder — nothing to edit
  }
  const roundtrip = Date.now() - t0;

  const lines = [
    `${t("responses.ping.roundtrip")} — \`${roundtrip}ms\``,
  ];

  const gateway = readGatewayPing(this.client);
  if (gateway >= 0) lines.push(`${t("responses.ping.gateway")} — \`${gateway}ms\``);

  const node = readNodePing(this.lavalink);
  if (node) {
    lines.push(`${t("responses.ping.node")} — \`${node.ping !== null ? node.ping + "ms" : "connected"}\``);
  }

  const embed = new EmbedBuilder()
      .setColor(getGlobalColor())
      .setAuthor({
        name: t("responses.ping.title"),
        iconURL: this.client?.user?.displayAvatarURL?.() || null,
      })
      .setDescription(lines.join("\n"));

  sent.edit({ embeds: [embed] }).catch(() => {});
}
