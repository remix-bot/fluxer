/**
 * @module commands/playnext
 * @description Play a song and insert it at the top of the queue instead of the end.
 * Supports inline provider prefixes and flag-based provider selection.
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/ui/index.mjs";
import { PROVIDER_CHOICES, parseInlineProvider } from "../src/music/providers.mjs";


/**
 * @type {CommandBuilder}
 * @description Command definition for the playnext command.
 */
export const command = new CommandBuilder()
    .setName("playnext")
    .setId("playnext")
    .setDescription("Same as $prefixplay but adds the result to the top of the queue.", "commands.playnext")
    .setCategory("music")
    .addExamples(
        "$prefixplaynext blinding lights",
        "$prefixplaynext sp: blinding lights",
        "$prefixplaynext -p dz get lucky"
    )
    .addTextOption(option =>
        option.setName("query")
            .setDescription("A search query, URL, or provider-prefixed query like `sp: song name`.", "options.playnext.query")
            .setRequired(true)
    )
    .addChoiceOption(o =>
            o.setName("provider")
                .setDescription("The search provider. Default: YouTube Music.", "options.playnext.provider")
                .addFlagAliases("p", "u", "use")
                .addChoices(...PROVIDER_CHOICES)
                .setDefault("ytm")
        , true)
    .addAlias("pn");

/**
 * Run handler for the playnext command.
 * Searches for a track and adds the result to the top of the queue.
 *
 * @param {object} message - The command message wrapper.
 * @param {object} data - Parsed command data containing query and provider options.
 * @returns {Promise<void>}
 */
export async function run(message, data) {
  const p = await this.getPlayer(message, true, true, true);
  if (!p) return;

  const rawQuery     = data.get("query").value;
  const flagProvider = data.get("provider")?.value;
  const { provider: inlineProvider, query } = parseInlineProvider(rawQuery);
  const provider = inlineProvider ?? flagProvider ?? "ytm";

  const searchEmbed = new EmbedBuilder()
    .setColor(getGlobalColor())
    .setAuthor({ name: `🔎 ${this.t(message, "responses.playnext.searching")}` })
    .setDescription(this.t(message, "responses.playnext.searching"));

  let statusMsg;
  try {
    statusMsg = await message.reply({ embeds: [searchEmbed] });
  } catch (_e) {
    return;
  }

  const requester = message.author?.id ?? message.authorId ?? null;
  const messages = p.playFirst(query, provider, { requester });
  messages.on("message", d => {
    let embed;
    if (d instanceof EmbedBuilder) {
      embed = d;
    } else if (d?.embeds?.[0]) {
      embed = d.embeds[0];
    } else {
      embed = new EmbedBuilder().setColor(getGlobalColor()).setDescription(String(d));
    }

    /* Set Playing Next author tag on the added track embed */
    const authorName = embed.data?.author?.name || "";
    if (authorName.includes("Added to Queue") || !authorName) {
      embed.setAuthor({ name: this.t(message, "responses.playnext.playingNext") });
    }

    if (statusMsg) statusMsg.edit({ embeds: [embed] }).catch(() => {});
  });
}
