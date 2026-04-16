import { CommandBuilder } from "../src/CommandHandler.mjs";
import { Utils } from "../src/Utils.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

export const command = new CommandBuilder()
    .setName("stats")
    .setDescription("Display stats about the bot like the uptime.", "commands.stats")
    .addAliases("info")
    .setCategory("util");

// ── User count ────────────────────────────────────────────────────────────────

async function fetchUserCount(client) {
  // client.rest is a concept and is not available on @fluxerjs/core.
  // Use guild.memberCount (a cached integer Fluxer exposes on every Guild object)
  // instead of paginating the REST members endpoint.
  // Falls back to 0 per guild if the property is absent so the stat still renders.
  try {
    let total = 0;
    for (const guild of client.guilds.cache.values()) {
      total += guild.memberCount ?? guild.member_count ?? 0;
    }
    return total;
  } catch { return 0; }
}

// ── Embed builder ─────────────────────────────────────────────────────────────

function buildEmbed({ guildCount, userCount, playerCount, ping, uptime, comHash, comLink, reason, footer, loading }) {
  const num = (v) => Number(v).toLocaleString();
  const ld  = (v) => loading ? "..." : v;

  const description = [
    `📂  **Servers** — \`${num(guildCount)}\``,
    `👥  **Users** — \`${ld(num(userCount))}\``,
    `🎧  **Players** — \`${num(playerCount)}\``,
    `🏓  **Ping** — \`${ld(`${ping}ms`)}\``,
    `⏱️  **Uptime** — \`${uptime}\``,
    `🔧  **Build** — [\`${comHash}\`](${comLink})`,
    reason ? `🪛  **Last restart** — \`${reason}\`` : null,
    ``,
    `☕ [Support us on Ko-fi](https://ko-fi.com/remixbot)`,
    `💬 [Community](https://fluxer.gg/Remix)`,
  ].filter(l => l !== null).join("\n");

  const builder = new EmbedBuilder()
      .setColor(getGlobalColor())
      .setAuthor({ name: "Remix Music Bot" })
      .setDescription(description)
      .setFooter({ text: footer || "Remix Music Bot" });
  // setTimestamp() is not verified on @fluxerjs/core's EmbedBuilder — call it only
  // if the method exists so the command doesn't throw when building the embed.
  if (typeof builder.setTimestamp === "function") builder.setTimestamp();
  return builder.toJSON();
}

// ── Runner ────────────────────────────────────────────────────────────────────

export async function run(message) {
  const shared = {
    guildCount:  this.client.guilds.cache.size,
    playerCount: this.players.playerMap.size,
    uptime:      Utils.prettifyMS(Math.round(process.uptime()) * 1000),
    comHash:     this.comHash,
    comLink:     this.comLink,
    reason:      this.config.restart ?? null,
    footer:      this.config.customStatsFooter || null,
  };

  const start = Date.now();

  const msg = await message.replyEmbed({
    embeds: [buildEmbed({ ...shared, userCount: 0, ping: 0, loading: true })]
  });

  const ping  = Date.now() - start;
  const users = await fetchUserCount(this.client);

  await msg.editEmbed({
    embeds: [buildEmbed({ ...shared, userCount: users, ping, loading: false })]
  }).catch(() => {});
}
