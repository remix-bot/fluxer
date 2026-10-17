/**
 * @module commands/playnext
 * @description Play a song and insert it at the top of the queue instead of the end.
 * Supports inline provider prefixes and flag-based provider selection.
 * Audio files attached to the command message (Opus, OGG, WebM, MP3, ...) are
 * queued at the top directly when no text query is given.
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/ui/index.mjs";
import { logger } from "../src/core/Logger.mjs";
import { PROVIDER_CHOICES, parseInlineProvider } from "../src/music/providers.mjs";
import { getAudioAttachments, attachmentTitle, attachmentTrackMeta, attachmentUrl } from "../src/music/attachments.mjs";
import { ERROR_COLOR } from "../src/utils/UI.mjs";


/**
 * @type {CommandBuilder}
 * @description Command definition for the playnext command.
 */
export const command = new CommandBuilder()
    .setName("playnext")
    .setId("playnext")
    .setDescription("Same as $prefixplay but adds the result to the top of the queue. Attach an audio file to play it next.", "commands.playnext")
    .setCategory("music")
    .addExamples(
        "$prefixplaynext blinding lights",
        "$prefixplaynext sp: blinding lights",
        "$prefixplaynext -p dz get lucky",
        "$prefixplaynext (attach an Opus/MP3 audio file, no text needed)"
    )
    .addTextOption(option =>
        option.setName("query")
            .setDescription("A search query, URL, or provider-prefixed query like `sp: song name`. Leave empty when attaching an audio file.", "options.playnext.query")
            .setRequired(false)
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
  const rawQuery = data.get("query")?.value ?? "";

  /* Audio file attachments — `%playnext` with an attached audio file and no
     text queues it at the top of the queue through the audio bridge. */
  if (!rawQuery.trim()) {
    const attachments = getAudioAttachments(message);

    if (attachments.length === 0) {
      const hasAnyAttachment = (message.message?.attachments?.size ?? 0) > 0;
      return message.reply({
        embeds: [new EmbedBuilder().setColor(ERROR_COLOR).setDescription(
          this.t(message, hasAnyAttachment ? "responses.play.attachmentNotAudio" : "responses.play.noQuery")
        )]
      });
    }

    const p = await this.getPlayer(message, true, true, true);
    if (!p) return;

    const statusEmbed = new EmbedBuilder()
      .setColor(getGlobalColor())
      .setDescription(attachments.length === 1
        ? this.t(message, "responses.play.loadingAttachment", { filename: attachmentTitle(attachments[0]) })
        : this.t(message, "responses.play.loadingAttachments", { count: attachments.length }));
    let statusMsg = null;
    try { statusMsg = await message.reply({ embeds: [statusEmbed] }); } catch(e) { logger.warn("[PlayNext] Error:", e?.message); }

    const post = (desc) => {
      const embed = new EmbedBuilder().setColor(getGlobalColor()).setDescription(desc);
      if (statusMsg) { statusMsg.edit({ embeds: [embed] }).catch(() => {}); }
      else { message.reply({ embeds: [embed] }).catch(() => {}); }
    };

    attachments.forEach((att, i) => {
      /* First file jumps to the top; the rest queue behind it in order. */
      const top = i === 0;
      p.playExternal(attachmentUrl(att), attachmentTitle(att), null, top, "external", attachmentTrackMeta(att))
        .on("message", post);
    });
    return;
  }

  const p = await this.getPlayer(message, true, true, true);
  if (!p) return;

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
