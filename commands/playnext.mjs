/**
 * @module commands/playnext
 * @description Play a song and insert it at the top of the queue instead of the end.
 * Supports inline provider prefixes and flag-based provider selection.
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";
import { PROVIDER_CHOICES, parseInlineProvider } from "../src/constants/providers.mjs";


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
    .setDescription(this.t(message, "responses.playnext.searching"))
    ;

  let statusMsg;
  try {
    statusMsg = await message.reply({ embeds: [searchEmbed] });
  } catch (_e) {
    return;
  }

  const messages = p.playFirst(query, provider);
  messages.on("message", d => {
    const embed = new EmbedBuilder().setColor(getGlobalColor()).setDescription(d);
    if (statusMsg) statusMsg.edit({ embeds: [embed] }).catch(() => {});
  });
}
