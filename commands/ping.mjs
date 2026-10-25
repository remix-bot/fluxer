/**
 * @module commands/ping
 * @description Show the bot's latency: REST roundtrip, gateway heartbeat and audio node ping.
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { EmbedBuilder } from "@fluxerjs/core";

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
      .setColor(0xe9196c)
      .setDescription(t("responses.ping.measuring"));

  const t0 = Date.now();
  let sent;
  try {
    sent = await message.reply({ embeds: [waitingEmbed] });
  } catch (e) {
    return;
  }
  const roundtrip = Date.now() - t0;

  const gateway = readGatewayPing(this.client);
  const node = readNodePing(this.lavalink);

  const restLabel = t("responses.ping.restApi") || "REST API";
  const gatewayLabel = t("responses.ping.gatewayWs") || "Gateway WebSocket";
  const nodeLabel = t("responses.ping.audioNode") || "Audio Node";

  const lines = [
    `⚡ **${restLabel}** — \`${roundtrip}ms\``,
  ];
  if (gateway >= 0) lines.push(`🌐 **${gatewayLabel}** — \`${gateway}ms\``);
  if (node) {
    lines.push(`🎵 **${nodeLabel}** — \`${node.ping !== null ? node.ping + "ms" : "connected"}\``);
  }

  const embed = new EmbedBuilder()
      .setColor(0xe9196c)
      .setAuthor({
        name: `🏓 ${t("responses.ping.pingDashboard") || t("responses.ping.title")}`,
        iconURL: this.client?.user?.displayAvatarURL?.() || null,
      })
      .setTitle(`🟢 ${t("responses.ping.operational") || "Operational"}`)
      .setDescription(lines.join("\n\n"))
      .setFooter({ text: `Shard #${this.client?.shardId ?? 0} • NodeLink DSP` });

  sent.edit({ embeds: [embed] }).catch(() => {});
}
