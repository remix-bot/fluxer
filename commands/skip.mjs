import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

export const command = new CommandBuilder()
    .setName("skip")
    .setDescription("Skip the current playing song.", "commands.skip")
    .addAliases("s")
    .setCategory("music");

export async function run(message) {
  const p = await this.getPlayer(message);
  if (!p) return;

  const current      = p.queue.getCurrent();
  const skippedTitle = current?.title ?? null;
  const skippedLink  = current ? (current.spotifyUrl || current.url || "") : "";

  const err = p.skip();
  if (err && err.includes("nothing playing")) {
    const embed = new EmbedBuilder().setColor(getGlobalColor()).setDescription(err).toJSON();
    return message.replyEmbed({ embeds: [embed] });
  }

  const desc = skippedTitle
    ? `⏭️ Skipped [${skippedTitle}](${skippedLink})`
    : "⏭️ Skipped";

  const embed = new EmbedBuilder()
    .setColor(getGlobalColor())
    .setDescription(desc)
    .toJSON();
  message.replyEmbed({ embeds: [embed] });
}
