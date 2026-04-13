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
  const guildIds = Array.from(client.guilds.cache.keys());
  if (guildIds.length === 0) return 0;
  try {
    const counts = await Promise.all(guildIds.map(async (id) => {
      let total = 0, after = "0", done = false;
      try {
        while (!done) {
          const batch = await client.rest?.get(`/guilds/${id}/members?limit=1000&after=${after}`);
          if (!batch?.length) { done = true; }
          else {
            total += batch.length;
            done = batch.length < 1000;
            if (!done) after = batch[batch.length - 1].user.id;
          }
        }
        return total;
      } catch { return 0; }
    }));
    return counts.reduce((a, b) => a + b, 0);
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

  return new EmbedBuilder()
      .setColor(getGlobalColor())
      .setAuthor({ name: "Remix Music Bot" })
      .setDescription(description)
      .setFooter({ text: footer || "Remix Music Bot" })
      .setTimestamp()
      .toJSON();
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
