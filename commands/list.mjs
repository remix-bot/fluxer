import { CommandBuilder }  from "../src/CommandHandler.mjs";
import { QueuePaginator, getGlobalColor }  from "../src/MessageHandler.mjs";
import { EmbedBuilder }    from "@fluxerjs/core";

const PAGE_SIZE  = 10;
const SESSION_MS = 30 * 1000;

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

export async function run(message, data) {
  const p = await this.getPlayer(message);
  if (!p) return;

  const current     = p.queue.getCurrent();
  const totalTracks = p.queue.size();

  if (!current && totalTracks === 0) {
    const embed = new EmbedBuilder().setColor(getGlobalColor()).setDescription("📭 The queue is empty. Use `%play` to add songs!").toJSON();
    return message.replyEmbed({ embeds: [embed] });
  }

  const totalPages = totalTracks > 0
      ? Math.max(1, Math.ceil(totalTracks / PAGE_SIZE))
      : 1;

  const pageVal   = data.get("page")?.value;
  const startPage = Math.max(1, Math.min((!pageVal || isNaN(pageVal)) ? 1 : pageVal, totalPages));

  const buildEmbed = (page) => {
    const safePage  = (isNaN(page) || page < 1) ? 1 : Math.min(Math.floor(page), totalPages);
    const loopState = p.queue.songLoop ? "🔂 Song" : p.queue.loop ? "🔁 Queue" : "🛑 Off";

    let desc = "";

    // ── Header: track count + remaining time ──────────────────────────────
    const remaining = p.getQueueRemainingTime();
    desc += `📋 **${totalTracks} track${totalTracks !== 1 ? "s" : ""} in queue** • ⏱️ \`${remaining}\`\n`;

    // ── Now Playing block ─────────────────────────────────────────────────
    if (current) {
      const elapsed = p.getCurrentElapsedDuration();
      const total   = p.getCurrentDuration();
      const link    = current.spotifyUrl || current.url || "";
      let   title   = current.title;
      if (title.length > 50) title = title.slice(0, 47) + "...";
      const titleFmt = link ? `[${title}](${link})` : title;

      desc += `\n🎵 **Now Playing**\n`;
      desc += `${titleFmt} • \`${elapsed} / ${total}\`\n`;
    }

    desc += `\n`;

    // ── Queue list ────────────────────────────────────────────────────────
    if (totalTracks === 0) {
      desc += "_Queue is empty._";
    } else {
      const { items, start } = p.queue.getPage(safePage, PAGE_SIZE);

      items.forEach((vid, i) => {
        const index = String(start + i + 1).padStart(2, " ");
        const dur   = vid.duration ? p.getDuration(vid.duration) : "?:??";
        const link  = vid.spotifyUrl || vid.url || "";
        let   title = vid.title;
        if (title.length > 45) title = title.slice(0, 42) + "...";
        title = link ? `[${title}](${link})` : title;
        desc += `\`${index}.\` ${title} • \`${dur}\`\n`;
      });
    }

    return new EmbedBuilder()
        .setColor(getGlobalColor())
        .setAuthor({ name: "🎧 Queue" })
        .setDescription(desc.trim())
        .setFooter({ text: `Page ${safePage}/${totalPages} • ${loopState}` })
        .toJSON();
  };

  new QueuePaginator(message, this.messages, this.client)
      .setTimeout(SESSION_MS)
      .send(buildEmbed, totalPages, startPage);
}
