/**
 * @module commands/search
 * @description Search for tracks across providers and pick one to play via reaction selection.
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { Message } from "../src/ui/index.mjs";
import { EmbedBuilder }   from "@fluxerjs/core";
import { PROVIDER_CHOICES, PROVIDER_NAMES, parseInlineProvider } from "../src/music/providers.mjs";
import { NUMBER_EMOJIS, CANCEL_EMOJI } from "../src/utils/UI.mjs";
import { Utils } from "../src/utils/Utils.mjs";
import { logger } from "../src/core/Logger.mjs";

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
        "$prefixsearch pop",
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
            .setDescription("The song, artist, or music genre to search for; provider prefixes such as `sp: song name` also work.", "options.search.query")
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

  let providerIcon = "🔍";
  if (provider === "sp" || provider === "spotify") providerIcon = "🟢";
  else if (provider === "sc" || provider === "soundcloud") providerIcon = "🟠";
  else if (provider === "yt" || provider === "ytm" || provider === "youtube") providerIcon = "▶️";

  const authorTitle = `${providerIcon} ${this.t(msg, "responses.search.resultsTitle", { provider: name })}`;

  /**
   * @private
   * Build a search result embed.
   * @param {string} description - The embed description text.
   * @param {string|null} footerText - Optional footer text.
   * @param {string} [authorLabel=authorTitle] - The author field label.
   * @param {string|null} [thumbnail=null] - Optional thumbnail URL.
   * @returns {EmbedBuilder} The constructed embed.
   */
  const makeEmbed = (description, footerText, authorLabel = authorTitle, thumbnail = null) => {
    const b = new EmbedBuilder()
        .setColor(0xe9196c)
        .setAuthor({ name: authorLabel })
        .setDescription(description);
    if (thumbnail) b.setThumbnail(thumbnail);
    if (footerText) b.setFooter({ text: footerText });
    return b;
  };

  const nativeMsg = msg.message ?? msg;
  const rawMsg = await nativeMsg.reply(
      { embeds: [makeEmbed(this.t(msg, "responses.search.loadingResults"), this.t(msg, "responses.play.searchingProvider", { provider: name }), authorTitle)]},
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

  const cancelText = this.t(msg, "responses.search.cancelOption") || "Cancel";
  let desc = "";
  results.forEach((v, i) => {
    const dur       = v.duration ? p.getDuration(v.duration) : "?:??";
    const rawAuthor = v.artist || (typeof v.author === "object" ? v.author?.name : v.author);
    const authorStr = rawAuthor ? ` • ${Utils.truncate(rawAuthor, 30)}` : "";
    const title     = Utils.truncate(v.title || this.t(msg, "responses.play.unknownTrack"), 50);
    const url       = v.url || "";
    const titleFmt  = url ? `[${title}](${url})` : title;
    desc += `${NUMBER_EMOJIS[i]} **${titleFmt}**${authorStr} • \`${dur}\`\n\n`;
  });
  desc += `${CANCEL_EMOJI} ${cancelText}`;

  await rawMsg.edit({
    embeds: [makeEmbed(
        desc.trim(),
        this.t(msg, "responses.search.reactHint"),
        authorTitle,
        results[0]?.thumbnail || null
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
      p.searches.delete(msg.authorId);
      rawMsg.edit({
        embeds: [makeEmbed(this.t(msg, "responses.search.cancelled"), null, authorTitle)]
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
          authorTitle,
          v.thumbnail || null
      )]
    }).catch(() => {});
  });

  const SESSION_MS = this.config?.timers?.searchSessionTimeout ?? 30_000;
  const timer = setTimeout(() => {
    unobserve();
    p.searches.delete(msg.authorId);
    clearReactions().catch(() => {});
    rawMsg.edit({
      embeds: [makeEmbed(this.t(msg, "responses.search.timedOut"), this.t(msg, "responses.search.sessionClosed"), authorTitle)]
    }).catch(() => {});
  }, SESSION_MS);
}
