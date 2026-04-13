import { CommandBuilder } from "../src/CommandHandler.mjs";
import { Message, getGlobalColor } from "../src/MessageHandler.mjs";
import { EmbedBuilder }   from "@fluxerjs/core";
import { PROVIDER_CHOICES, PROVIDER_NAMES } from "../src/constants/providers.mjs";

const NUMBER_EMOJIS = ["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣"];
const CANCEL_EMOJI  = "❌";
// SESSION_MS is now read from config.timers.searchSessionTimeout (fallback: 30s)

function parseInlineProvider(raw) {
  const match = raw.match(/^([a-z]+):\s*(.+)$/i);
  if (!match) return { provider: null, query: raw.trim() };
  const maybeProvider = match[1].toLowerCase();
  if (PROVIDER_CHOICES.includes(maybeProvider))
    return { provider: maybeProvider, query: match[2].trim() };
  return { provider: null, query: raw.trim() };
}

export const command = new CommandBuilder()
    .setName("search")
    .setDescription(
        "Display search results for a query and pick one to play.\n" +
        "Supports all providers — use inline prefix e.g. `sp: song` or `-p dz`.",
        "commands.search"
    )
    .setCategory("music")
    .addExamples(
        "$prefixsearch never gonna give you up",
        "$prefixsearch sp: blinding lights",
        "$prefixsearch -p dz get lucky"
    )
    .addChoiceOption(o =>
            o.setName("provider")
                .setDescription("The search provider. Default: YouTube Music.", "options.search.provider")
                .addChoices(...PROVIDER_CHOICES)
                .setDefault("ytm")
                .addFlagAliases("p", "u", "use")
        , true)
    .addTextOption(o =>
        o.setName("query")
            .setDescription("The query to search for, or a provider-prefixed query like `sp: song name`.", "options.search.query")
            .setRequired(true)
    );

export async function run(msg, data) {
  const p = await this.getPlayer(msg, true, true, true);
  if (!p) return;

  const rawQuery     = data.get("query").value;
  const flagProvider = data.get("provider")?.value;
  const { provider: inlineProvider, query } = parseInlineProvider(rawQuery);
  const provider = inlineProvider ?? flagProvider ?? "ytm";

  const name = PROVIDER_NAMES[provider] ?? "YouTube Music";

  // Send loading embed
  const channel = msg.channel?.channel ?? msg.message?.channel;
  if (!channel?.send) return;

  /**
   * Build a search-result embed using EmbedBuilder.
   * @param {string} description
   * @param {string} [footerText]
   * @param {string} [authorLabel] - defaults to `name` (provider name)
   */
  const makeEmbed = (description, footerText, authorLabel = name) => {
    const b = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setAuthor({ name: authorLabel })
        .setDescription(description);
    if (footerText) b.setFooter({ text: footerText });
    return b.toJSON();
  };

  const nativeMsg = msg.message ?? msg;
  const rawMsg = await nativeMsg.reply(
      { embeds: [makeEmbed("⏳ Loading results...", null, `Searching ${name}...`)] },
      { ping: false }
  ).catch(() => null);
  if (!rawMsg) return;

  // Fetch results
  const res = await p.fetchResults(query, msg.authorId, provider);
  if (!res?.count) {
    rawMsg.edit({ embeds: [makeEmbed("❌ No results found.")] }).catch(() => {});
    return;
  }

  // Build results embed
  const results   = p.searches.get(msg.authorId) ?? [];
  const reactions = NUMBER_EMOJIS.slice(0, res.count);

  let desc = "";
  results.forEach((v, i) => {
    const dur   = v.duration ? p.getDuration(v.duration) : "?:??";
    const title = v.title || "Unknown";
    const url   = v.url || "";
    desc += `${NUMBER_EMOJIS[i]} [${title}](${url}) — \`${dur}\`\n`;
  });
  desc += `\n${CANCEL_EMOJI} Cancel`;

  await rawMsg.edit({
    embeds: [makeEmbed(
        desc,
        "React with a number to add to queue • ❌ to cancel • 30s timeout",
        `${name} — Search Results`
    )]
  }).catch(() => {});

  // Add reactions
  for (const emoji of [...reactions, CANCEL_EMOJI]) {
    await rawMsg.react(emoji).catch(() => {});
  }

  const allReactions = [...reactions, CANCEL_EMOJI];
  const client       = this.client;
  const channelId    = rawMsg.channelId ?? rawMsg.channel_id ?? rawMsg.channel?.id;
  const msgId        = rawMsg.id;

  const clearReactions = async () => {
    try {
      await rawMsg.removeAllReactions();
    } catch (_) {}
  };

  const wrapped  = new Message(rawMsg, this.messages);
  const authorId = msg.message?.author?.id ?? msg.authorId;

  const unobserve = wrapped.onReaction(allReactions, async (e, reactionMsg) => {
    // Only react to the command author
    if (e.user_id && e.user_id !== authorId) return;

    clearTimeout(timer);
    unobserve();
    await clearReactions();

    if (e.emoji_id === CANCEL_EMOJI) {
      rawMsg.edit({
        embeds: [makeEmbed("❌ Cancelled.", null, `${name} — Search Results`)]
      }).catch(() => {});
      return;
    }

    const idx = reactions.indexOf(e.emoji_id);
    if (idx === -1) return;

    const v = p.playResult(msg.authorId, idx);
    if (!v) return;

    rawMsg.edit({
      embeds: [makeEmbed(
          `✅ Added [${v.title}](${v.url}) to the queue!`,
          null,
          `${name} — Search Results`
      )]
    }).catch(() => {});
  });

  // Read session timeout from config (fallback 30 s)
  const SESSION_MS = this.config?.timers?.searchSessionTimeout ?? 30_000;
  const timer = setTimeout(() => {
    unobserve();
    clearReactions().catch(() => {});
    rawMsg.edit({
      embeds: [makeEmbed("⏰ Search timed out.", "Session closed", `${name} — Search Results`)]
    }).catch(() => {});
  }, SESSION_MS); // configurable via config.timers.searchSessionTimeout
}
