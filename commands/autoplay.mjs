/**
 * @file autoplay command — Toggle autoplay to automatically play similar tracks when the queue ends
 * @module commands/autoplay
 */

import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

export const command = new CommandBuilder()
  .setName("autoplay")
  .setDescription("Toggle autoplay — automatically play similar tracks when the queue ends.", "commands.autoplay")
  .setCategory("music")
  .addAliases("ap");

/**
 * Execute the autoplay command.
 * @param {import("../src/MessageHandler.mjs").Message} msg - The incoming message
 * @param {Map<string, {value: *}>} data - Slash-command options map
 * @returns {Promise<void>}
 */
export async function run(msg, data) {
  const p = await this.getPlayer(msg, true, true, false);
  if (!p) return;

  p._autoplay = !p._autoplay;

  if (p._autoplay) {
    if (!p._autoplayHandler) {
      p._autoplayHandler = async () => {
        if (!p._autoplay) return;
        if (p.queue?.getCurrent() && !p.queue?.isEmpty()) return;

        const lastTrack = p._lastPlayedTrack;
        if (!lastTrack) return;

        const artist = lastTrack.lastfm?.artist ?? lastTrack.requestedArtist ?? lastTrack.artist ?? lastTrack.artists?.[0]?.name;
        const name = lastTrack.lastfm?.name ?? lastTrack.requestedTitle ?? lastTrack.title ?? lastTrack.name;

        try {
          p._stopInactivityTimer();

          let query = null;

          const lf = this.lastfm;
          if (lf?.enabled && artist && name) {
            try {
              const similar = await lf.getSimilarTracks(artist, name, 5);
              if (similar.length) {
                const pick = similar[Math.floor(Math.random() * Math.min(3, similar.length))];
                query = `${pick.name} ${pick.artist}`.trim();
              }
            } catch(e) {  }
          }

          if (!query) {
            if (artist && name) {
              query = `${artist} music`;
            } else if (name) {
              query = `${name} similar`;
            } else {
              if (!p._is247Enabled()) {
                p._startInactivityTimer();
              }
              return;
            }
          }

          const resolved = await p.workerJob("generalQuery", {
            query,
            provider: "yt",
          });

          let track = null;
          if (resolved?.type === "video" && resolved.data) {
            track = resolved.data;
          } else if (resolved?.type === "list" && resolved.data?.length) {
            const idx = Math.floor(Math.random() * Math.min(5, resolved.data.length));
            track = resolved.data[idx];
          }

          if (track) {
            p.addToQueue(track, false);
            if (!p.queue.getCurrent()) {
              p.playNext().catch(() => {});
            }
          } else {
            if (!p._is247Enabled()) {
              p._startInactivityTimer();
            }
          }
        } catch (err) {
          if (!p.queue?.getCurrent() && p.queue?.isEmpty() && !p._is247Enabled()) {
            p._startInactivityTimer();
          }
        }
      };

      p.on("queueEnd", p._autoplayHandler);
    }

    return msg.reply({
      embeds: [new EmbedBuilder()
        .setColor(getGlobalColor())
        .setDescription(this.t(msg, "responses.autoplay.enabled"))]
    });
  } else {
    if (p._autoplayHandler) {
      p.removeListener("queueEnd", p._autoplayHandler);
      p._autoplayHandler = null;
    }

    return msg.reply({
      embeds: [new EmbedBuilder()
        .setColor(getGlobalColor())
        .setDescription(this.t(msg, "responses.autoplay.disabled"))]
    });
  }
}
