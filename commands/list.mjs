/**
 * @module commands/list
 * @description List the songs in the queue of the current voice channel with pagination.
 */

import { CommandBuilder }  from "../src/commands/index.mjs";
import { QueuePaginator } from "../src/ui/index.mjs";
import { EmbedBuilder }    from "@fluxerjs/core";

const PAGE_SIZE  = 10;
const SESSION_MS = 30 * 1000;

/**
 * @type {CommandBuilder}
 * @description Command definition for the list (queue) command.
 */
export const command = new CommandBuilder()
    .setName("list")
    .setDescription("List the songs in the queue of your current voice channel.", "commands.list")
    .setCategory("music")
    .addAliases("queue", "q")
    .addNumberOption(o =>
        o.setName("page")
            .setDescription("Page number to jump to.")
            .setRequired(false)
    );

/**
 * Run handler for the list command.
 * Displays the current queue with pagination, showing now-playing info and track list.
 *
 * @param {object} message - The command message wrapper.
 * @param {object} data - Parsed command data containing the page option.
 * @returns {Promise<void>}
 */
export async function run(message, data) {
  const p = await this.getPlayer(message);
  if (!p) return;

  const current     = p.queue.getCurrent();
  const totalTracks = p.queue.size();
  const prefix      = this.handler.getPrefix(message.message?.guildId ?? message.channel?.guildId) || "%";

  if (!current && totalTracks === 0) {
    const embed = new EmbedBuilder()
      .setColor(0xe9196c)
      .setAuthor({ name: this.t(message, "responses.list.queueTitle") })
      .setDescription(this.t(message, "responses.list.empty", { prefix }))
      .setFooter({ text: this.t(message, "responses.play.controlsHint", { prefix }) });
    return message.reply({ embeds: [embed] });
  }

  const totalPages = totalTracks > 0
      ? Math.max(1, Math.ceil(totalTracks / PAGE_SIZE))
      : 1;

  const pageVal   = data.get("page")?.value;
  const startPage = Math.max(1, Math.min((!pageVal || isNaN(pageVal)) ? 1 : pageVal, totalPages));

  const buildEmbed = (page) => {
    const safePage  = (isNaN(page) || page < 1) ? 1 : Math.min(Math.floor(page), totalPages);
    const loopState = p.queue.songLoop
      ? `🔂 ${this.t(message, "responses.play.loopSongLabel")}`
      : p.queue.loop
        ? `🔄 ${this.t(message, "responses.play.loopQueueLabel")}`
        : this.t(message, "responses.play.loopOffLabel");

    let desc = "";

    const remaining = p.getQueueRemainingTime();
    const pluralStr = totalTracks === 1 ? this.t(message, "responses.play.trackSingle") : this.t(message, "responses.play.trackPlural");
    const headerStr = this.t(message, "responses.list.tracksCount", { count: totalTracks, plural: pluralStr });
    desc += `📋 **${headerStr}** • ⏱️ ` + "`" + remaining + "`" + "\n";

    if (current) {
      const elapsed = p.getCurrentElapsedDuration();
      const total   = p.getCurrentDuration();
      const link    = current.spotifyUrl || current.url || "";
      let   title   = current.title ?? this.t(message, "responses.play.unknownTrack");
      if (title.length > 50) title = title.slice(0, 47) + "...";
      const titleFmt = link ? `[${title}](${link})` : title;
      const rawAuthor = current.artist || (typeof current.author === "object" ? current.author?.name : current.author);
      const authorStr = rawAuthor ? ` • ${rawAuthor}` : "";

      desc += `\n▶️ **${this.t(message, "responses.list.nowPlayingHeader")}:**\n`;
      desc += `${titleFmt}${authorStr} • ` + "`" + elapsed + " / " + total + "`" + "\n";
    }

    desc += `\n`;

    if (totalTracks === 0) {
      desc += this.t(message, "responses.list.emptyInline");
    } else {
      desc += `**${this.t(message, "responses.list.upNextHeader")}:**\n`;
      const { items, start } = p.queue.getPage(safePage, PAGE_SIZE);

      items.forEach((vid, i) => {
        const index   = start + i + 1;
        const dur     = vid.duration ? p.getDuration(vid.duration) : "?:??";
        const link    = vid.spotifyUrl || vid.url || "";
        let   title   = vid.title ?? this.t(message, "responses.play.unknownTrack");
        if (title.length > 45) title = title.slice(0, 42) + "...";
        title = link ? `[${title}](${link})` : title;
        const rawAuthor = vid.artist || (typeof vid.author === "object" ? vid.author?.name : vid.author);
        const authorStr = rawAuthor ? ` • ${rawAuthor}` : "";
        desc += "`#" + index + "` " + `**${title}**${authorStr} • ` + "`" + dur + "`" + "\n";
      });
    }

    const footerText = `${this.t(message, "responses.list.pageFooter", { page: safePage, totalPages, loopState })} • ${this.t(message, "responses.play.controlsHint", { prefix })}`;

    const builder = new EmbedBuilder()
        .setColor(0xe9196c)
        .setAuthor({ name: this.t(message, "responses.list.queueTitle") })
        .setDescription(desc.trim())
        .setFooter({ text: footerText });

    if (current?.thumbnail) {
      builder.setThumbnail(current.thumbnail);
    }

    return builder;
  };

  new QueuePaginator(message, this.messages, this.client)
      .setTimeout(SESSION_MS)
      .send(buildEmbed, totalPages, startPage)
      .catch(() => {});
}
