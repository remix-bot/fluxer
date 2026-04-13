import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";
import { PROVIDER_CHOICES } from "../src/constants/providers.mjs";

function parseInlineProvider(raw) {
  const match = raw.match(/^([a-z]+):\s*(.+)$/i);
  if (!match) return { provider: null, query: raw.trim() };
  const maybeProvider = match[1].toLowerCase();
  if (PROVIDER_CHOICES.includes(maybeProvider)) {
    return { provider: maybeProvider, query: match[2].trim() };
  }
  return { provider: null, query: raw.trim() };
}

export const command = new CommandBuilder()
    .setName("play")
    .setId("play")
    .setCategory("music")
    .setDescription(
        "Play a song or playlist from a URL or search query.\n" +
        "Supports YouTube, Spotify, SoundCloud, Deezer, Apple Music, Tidal, and more.\n" +
        "Default search: YouTube Music. Use `-p <provider>` or inline prefix e.g. `sp: blinding lights`.",
        "commands.play"
    )
    .addExamples(
        "$prefixplay take over league of legends",
        "$prefixplay sp: blinding lights",
        "$prefixplay dz: get lucky",
        "$prefixplay -p yt take over league of legends",
        "$prefixplay https://open.spotify.com/track/...",
        "$prefixp take over league of legends"
    )
    .addTextOption(option =>
        option.setName("query")
            .setDescription("A search query, URL, or provider-prefixed query like `sp: song name`.", "options.play.query")
            .setRequired(true)
    )
    .addChoiceOption(o =>
            o.setName("provider")
                .setDescription("The search provider. Default: YouTube Music. Or use inline prefix: sp:, dz:, am:, yt:, sc: etc.", "options.play.provider")
                .addFlagAliases("p", "u", "use")
                .addChoices(...PROVIDER_CHOICES)
                .setDefault("yt")
        , true)
    .addAlias("p");

export async function run(message, data) {
  const p = await this.getPlayer(message, true, true, true);
  if (!p) return;

  const rawQuery     = data.get("query").value;
  const flagProvider = data.get("provider")?.value;
  const { provider: inlineProvider, query } = parseInlineProvider(rawQuery);
  const provider = inlineProvider ?? flagProvider ?? "ytm";

  const searchEmbed = new EmbedBuilder()
    .setColor(getGlobalColor())
    .setDescription("🔍 Searching...")
    .toJSON();
  const statusMsg = await message.replyEmbed({ embeds: [searchEmbed] });

  const messages = p.play(query, false, provider);
  messages.on("message", d => {
    const embed = new EmbedBuilder().setColor(getGlobalColor()).setDescription(d).toJSON();
    statusMsg.editEmbed({ embeds: [embed] }).catch(() => {});
  });
}
