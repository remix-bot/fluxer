/**
 * @module commands/search
 * @description Search for tracks across providers and pick one to play via reaction selection.
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";
import { Message, getGlobalColor } from "../src/MessageHandler.mjs";
import { EmbedBuilder }   from "@fluxerjs/core";
import { PROVIDER_CHOICES, PROVIDER_NAMES, parseInlineProvider } from "../src/constants/providers.mjs";
import { NUMBER_EMOJIS, CANCEL_EMOJI } from "../src/constants/UI.mjs";
import { logger } from "../src/constants/Logger.mjs";

/** @type {CommandBuilder} @description Command definition for the search command. */
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

/**
 * @async
 * Run handler for the search command.
 * Searches for tracks, displays results as an embed with number reactions,
 * and adds the selected track to the queue.
 * @param {object} msg - The command message wrapper.
 * @param {object} data - Parsed command data containing provider and query options.
 * @returns {Promise<void>}
 */
export async function run(msg, data) {
  const p = await this.getPlayer(msg, true, true, true);
  if (!p) return;

  const rawQuery     = data.get("query").value;
  const flagProvider = data.get("provider")?.value;
  const { provider: inlineProvider, query } = parseInlineProvider(rawQuery);
  const provider = inlineProvider ?? flagProvider ?? "ytm";

  const name = PROVIDER_NAMES[provider] ?? "YouTube Music";

  const channel = msg.channel?.channel ?? msg.message?.channel;
  if (!channel?.send) return;

  /**
   * @private
   * Build a search result embed.
   * @param {string} description - The embed description text.
   * @param {string|null} footerText - Optional footer text.
   * @param {string} [authorLabel=name] - The author field label (provider name).
   * @returns {EmbedBuilder} The constructed embed.
   */
  const makeEmbed = (description, footerText, authorLabel = name) => {
    const b = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setAuthor({ name: authorLabel })
        .setDescription(description);
    if (footerText) b.setFooter({ text: footerText });
    return b;
  };

  const nativeMsg = msg.message ?? msg;
  const rawMsg = await nativeMsg.reply(
      { embeds: [makeEmbed(this.t(msg, "responses.search.loadingResults"), this.t(msg, "responses.play.searchingProvider", { provider: name }), this.t(msg, "responses.search.resultsTitle", { provider: name }))]},
      { ping: false }
  ).catch(() => null);
  if (!rawMsg) return;

  const res = await p.fetchResults(query, msg.authorId, provider);
  if (!res?.count) {
    rawMsg.edit({ embeds: [makeEmbed(this.t(msg, "responses.search.noResults"))] }).catch(() => {});
    return;
  }

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
        this.t(msg, "responses.search.reactHint"),
        this.t(msg, "responses.search.resultsTitle", { provider: name })
    )]
  }).catch(() => {});

  for (const emoji of [...reactions, CANCEL_EMOJI]) {
    await rawMsg.react(emoji).catch(() => {});
  }

  const allReactions = [...reactions, CANCEL_EMOJI];
  const client       = this.client;
  const channelId    = rawMsg.channelId ?? rawMsg.channel_id ?? rawMsg.channel?.id;
  const msgId        = rawMsg.id;

  /**
   * @private
   * Remove all reactions from the search result message.
   * @returns {Promise<void>}
   */
  const clearReactions = async () => {
    try {
      await rawMsg.removeAllReactions();
    } catch(e) { logger.warn("[Search] Error:", e?.message); }
  };

  const wrapped  = new Message(rawMsg, this.messages);
  const authorId = msg.message?.author?.id ?? msg.authorId;

  const unobserve = wrapped.onReaction(allReactions, async (e, reactionMsg) => {
    const reactorId = e.user_id ?? e.userId ?? e.user?.id ?? null;
    if (reactorId && reactorId !== authorId) return;

    clearTimeout(timer);
    unobserve();
    await clearReactions();

    if (e.emoji_id === CANCEL_EMOJI) {
      rawMsg.edit({
        embeds: [makeEmbed(this.t(msg, "responses.search.cancelled"), null, this.t(msg, "responses.search.resultsTitle", { provider: name }))]
      }).catch(() => {});
      return;
    }

    const idx = reactions.indexOf(e.emoji_id);
    if (idx === -1) return;

    const v = p.playResult(msg.authorId, idx);
    if (!v) return;

    rawMsg.edit({
      embeds: [makeEmbed(
          this.t(msg, "responses.search.added", { title: v.title, url: v.url }),
          null,
          this.t(msg, "responses.search.resultsTitle", { provider: name })
      )]
    }).catch(() => {});
  });

  const SESSION_MS = this.config?.timers?.searchSessionTimeout ?? 30_000;
  const timer = setTimeout(() => {
    unobserve();
    clearReactions().catch(() => {});
    rawMsg.edit({
      embeds: [makeEmbed(this.t(msg, "responses.search.timedOut"), this.t(msg, "responses.search.sessionClosed"), this.t(msg, "responses.search.resultsTitle", { provider: name }))]
    }).catch(() => {});
  }, SESSION_MS);
}
