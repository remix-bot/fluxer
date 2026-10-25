/**
 * @module commands/loop
 * @description Toggle looping of the current song or the entire queue.
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { Utils } from "../src/utils/Utils.mjs";

/** @type {CommandBuilder} @description Command definition for the loop command. */
export const command = new CommandBuilder()
    .setName("loop")
    .setDescription("Toggle the looping of your queue/song.", "commands.loop")
    .setCategory("music")
    .addChoiceOption(opt =>
        opt.setName("type")
            .addChoices("queue", "song")
            .setDescription("Specifies what loop should be toggled.", "options.loop.type")
            .setRequired(true));

/**
 * @async
 * Run handler for the loop command.
 * Toggles loop mode for the queue or the current song.
 * @param {object} message - The command message wrapper.
 * @param {object} data - Parsed command data containing the loop type option.
 * @returns {Promise<void>}
 */
export async function run(message, data) {
  const p = await this.getPlayer(message);
  if (!p) return;

  const type = data.get("type").value;
  const current = p.queue.getCurrent();
  const prefix = this.handler.getPrefix(message.message?.guildId ?? message.channel?.guildId) || "%";

  const state = p.queue.toggleLoop(type);

  let badge = this.t(message, "responses.loop.loopOffBadge");
  let desc = this.t(message, "responses.loop.loopOffDesc");
  let icon = "⏹️";

  if (state) {
    if (type === "song") {
      badge = this.t(message, "responses.loop.songLoopBadge");
      desc = this.t(message, "responses.loop.songLoopDesc");
      icon = "🔂";
    } else {
      badge = this.t(message, "responses.loop.queueLoopBadge");
      desc = this.t(message, "responses.loop.queueLoopDesc");
      icon = "🔄";
    }
  }

  if (current?.title) {
    const rawAuthor = current.artist || (typeof current.author === "object" ? current.author?.name : current.author);
    const authorStr = rawAuthor ? ` • ${rawAuthor}` : "";
    desc += `\n**${Utils.truncate(current.title, 45)}**${authorStr}`;
  }

  const embed = new EmbedBuilder()
    .setColor(0xe9196c)
    .setAuthor({ name: `${icon} ${this.t(message, "responses.loop.loopTitle")}` })
    .setTitle(badge)
    .setDescription(desc)
    .setFooter({ text: this.t(message, "responses.loop.cycleFooter", { prefix }) });

  if (current?.thumbnail) {
    embed.setThumbnail(current.thumbnail);
  }

  message.reply({ embeds: [embed] }).catch(() => {});
}
