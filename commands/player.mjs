import { CommandBuilder } from "../src/CommandHandler.mjs";
import { Utils } from "../src/Utils.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

export const command = new CommandBuilder()
    .setName("player")
    .setDescription("Create an interactive player control panel with live progress", "commands.player")
    .setCategory("music");

// Visual states
const STATES = {
  playing: "🎵",
  paused: "⏸️",
  stopped: "🔇",
  loading: "⏳"
};

// Control layout
const CONTROLS = {
  prev: { emoji: "⏮️", action: "previous", desc: "Previous" },
  play: { emoji: "▶️", action: "resume", desc: "Play" },
  pause: { emoji: "⏸️", action: "pause", desc: "Pause" },
  stop: { emoji: "⏹️", action: "stop", desc: "Stop" },
  next: { emoji: "⏭️", action: "skip", desc: "Skip" },
  loop: { emoji: "🔁", action: "loop", desc: "Loop" },
  shuffle: { emoji: "🔀", action: "shuffle", desc: "Shuffle" },
  volDown: { emoji: "🔉", action: "voldown", desc: "Volume Down" },
  volUp: { emoji: "🔊", action: "volup", desc: "Volume Up" },
  lyrics: { emoji: "📜", action: "lyrics", desc: "Lyrics" },
  filter: { emoji: "🎛️", action: "filter", desc: "Audio Filters" },
  close: { emoji: "❌", action: "close", desc: "Close" }
};

// Progress bar characters
const PROGRESS = {
  filled: "▰",
  empty: "▱",
  indicator: "●",
  start: "▏",
  end: "▕"
};

// Auto-remove timer: 1 minute
const EMOJI_REMOVE_TIMEOUT = 60000;

export async function run(msg) {
  const player = await this.getPlayer(msg, false, false, false);
  if (!player) return;

  const timeout = this.config?.timers?.playerSessionTimeout ?? this.config.playerAFKTimeout ?? 300000;
  const controlsLayout = [
    [CONTROLS.prev, CONTROLS.play, CONTROLS.pause, CONTROLS.stop, CONTROLS.next],
    [CONTROLS.loop, CONTROLS.shuffle, CONTROLS.volDown, CONTROLS.volUp, CONTROLS.lyrics],
    [CONTROLS.filter, CONTROLS.close]
  ];

  const allControls = controlsLayout.flat();
  const controlEmojis = allControls.map(c => c.emoji);

  const buildEmbed = (state = {}) => {
    const current = player.queue.getCurrent();
    const isPlaying = !player.paused && current;
    const statusEmoji = isPlaying ? STATES.playing : player.paused ? STATES.paused : STATES.stopped;

    let progressBar = "";
    let timeDisplay = "`0:00 / 0:00`";

    if (current?.duration && player.startedPlaying) {
      const elapsed = Date.now() - player.startedPlaying;
      const totalMs = typeof current.duration === "object"
          ? (current.duration.seconds ?? 0) * 1000
          : current.duration;

      const progress = Math.min(elapsed / totalMs, 1);
      const barLength = 20;
      const filled = Math.floor(progress * barLength);
      const position = Math.min(Math.max(filled, 0), barLength - 1);
      const emptyCount = Math.max(barLength - position - 1, 0);

      progressBar = PROGRESS.start +
          PROGRESS.filled.repeat(position) +
          (isPlaying ? PROGRESS.indicator : PROGRESS.filled) +
          PROGRESS.empty.repeat(emptyCount) +
          PROGRESS.end;

      const elapsedStr = Utils.prettifyMS(elapsed);
      const totalStr = Utils.prettifyMS(totalMs);
      timeDisplay = `\`${elapsedStr} / ${totalStr}\``;
    } else {
      progressBar = PROGRESS.start + PROGRESS.empty.repeat(20) + PROGRESS.end;
    }

    const volPercent = Math.round((player.preferredVolume || 1) * 100);
    const volBars = Math.ceil(volPercent / 10);
    const volumeBar = "█".repeat(volBars) + "░".repeat(10 - volBars);

    const queueSize = player.queue.size();
    const loopStatus = player.queue.songLoop ? "🔂 Song" : player.queue.loop ? "🔁 Queue" : "❌ Off";

    // FIXED: Show stacked filters if multiple are active
    let filterStatus = "🔇 Off";
    if (player.activeFilter) {
      if (player.activeFilter.label.includes("+")) {
        filterStatus = `🔥 **${player.activeFilter.label}**`;
      } else {
        filterStatus = `${player.activeFilter.emoji ?? "🎛️"} **${player.activeFilter.label}**`;
      }
    }

    const nowPlaying = current
        ? `[${Utils.truncate(current.title, 45)}](${current.spotifyUrl || current.url})`
        : this.t(msg, "responses.filter.nothingPlayingInline");

    const description = [
      `${statusEmoji} ${this.t(msg, "responses.player.nowPlayingLabel")}`,
      `${nowPlaying}`,
      ``,
      `${progressBar}`,
      `${timeDisplay}`,
      ``,
      `🔊 Volume: \`${volPercent}%\` ${volumeBar}`,
      `📋 Queue: \`${queueSize}\` tracks | Loop: ${loopStatus} | Filter: ${filterStatus}`,
      ``,
      state.message ? `💬 *${state.message}*` : `💡 *${this.t(msg, "responses.player.reactHint")}*`,
      ``,
      this.t(msg, "responses.player.sessionExpires", { minutes: Math.ceil(timeout / 60000) })
    ].join("\n");

    const avatarUrl = typeof msg.author?.avatarURL === "function"
        ? msg.author.avatarURL()
        : msg.author?.avatarURL ?? null;

    const builder = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle(this.t(msg, "responses.player.title"))
        .setDescription(description)
        .setFooter({
          text: this.t(msg, "responses.player.requestedBy", { username: msg.author?.username || "Unknown" }),
          iconURL: avatarUrl
        });
    if (typeof builder.setTimestamp === "function") builder.setTimestamp();
    if (current?.thumbnail) builder.setThumbnail(current.thumbnail);
    return builder;
  };

  const message = await msg.reply({ embeds: [buildEmbed()] });
  if (!message?.message) return;

  for (const row of controlsLayout) {
    for (const control of row) {
      try {
        await message.message.react(control.emoji);
        await Utils.sleep(50);
      } catch (_) {}
    }
  }

  let sessionTimeout;
  let updateInterval;
  let emojiRemoveTimeout;
  let lastState = {};

  let activeLyricsMsg = null;
  let lyricsUnobserve = null;
  let lyricsEmojiTimeout = null;

  const clearReactions = async () => {
    try {
      await message.message.removeAllReactions();
    } catch (e) {
      for (const emoji of controlEmojis) {
        try {
          await message.message.removeReaction(emoji);
        } catch (_) {}
      }
    }
  };

  const resetEmojiTimer = () => {
    clearTimeout(emojiRemoveTimeout);
    emojiRemoveTimeout = setTimeout(async () => {
      await clearReactions();
      const disabledEmbed = buildEmbed({ message: this.t(msg, "responses.player.controlsDisabled") });
      disabledEmbed.footer = { text: this.t(msg, "responses._common.controlsExpired") + " • React to refresh" };
      await message.edit({ embeds: [disabledEmbed] }).catch(() => {});
    }, EMOJI_REMOVE_TIMEOUT);
  };

  const clearLyricsReactions = async (lyricsMsg) => {
    if (!lyricsMsg?.message) return;
    try {
      await lyricsMsg.message.removeAllReactions();
    } catch (e) {
      for (const emoji of ["⬅️", "➡️", "❌"]) {
        try {
          await lyricsMsg.message.removeReaction(emoji);
        } catch (_) {}
      }
    }
  };

  const refresh = (extra = {}) => {
    const embed = buildEmbed(extra);
    message.edit({ embeds: [embed] }).catch(() => {});
    lastState = extra;
  };

  let _sessionClosed = false;

  const closeSession = async (reason = "timeout") => {
    if (_sessionClosed) return;
    _sessionClosed = true;

    clearTimeout(sessionTimeout);
    clearTimeout(emojiRemoveTimeout);
    clearInterval(updateInterval);
    unobserve?.();

    player.off("startplay", onStartPlay);
    player.off("playback",  onPlayback);
    player.off("stopplay",  onStopPlay);
    player.off("queue",     onQueue);
    player.off("volume",    onVolume);
    player.off("filter",    onFilter);
    player.off("autoleave", onAutoLeave);

    if (lyricsUnobserve) {
      lyricsUnobserve();
      clearTimeout(lyricsEmojiTimeout);
    }
    if (activeLyricsMsg) {
      await clearLyricsReactions(activeLyricsMsg);
    }

    await clearReactions();

    const closedEmbed = buildEmbed({
      message: this.t(msg, "responses.player.sessionClosed", { reason: reason !== "timeout" ? ` • ${reason}` : "" })
    });
    closedEmbed.color  = getGlobalColor();
    closedEmbed.footer = { text: this.t(msg, "responses._common.sessionEnded") };
    closedEmbed.title  = this.t(msg, "responses.player.inactiveTitle");

    await message.edit({
      embeds: [closedEmbed],
      content: reason === "user" ? this.t(msg, "responses.player.closedByUser") : undefined
    }).catch(() => {});
  };

  const resetTimeout = () => {
    clearTimeout(sessionTimeout);
    sessionTimeout = setTimeout(() => closeSession("timeout"), timeout);
  };

  updateInterval = setInterval(() => {
    if (!player.paused && player.queue.getCurrent()) {
      refresh(lastState);
    }
  }, this.config?.timers?.playerUpdateInterval ?? 5000);

  const onStartPlay  = ()       => refresh({ message: this.t(msg, "responses.player.startedPlaying") });
  const onPlayback   = (playing) => refresh({ message: playing ? this.t(msg, "responses.player.resumed") : this.t(msg, "responses.player.pausedState") });
  const onStopPlay   = ()       => refresh({ message: this.t(msg, "responses.player.stopped") });
  const onQueue      = (e)      => {
    if (e.type === "shuffle") refresh({ message: this.t(msg, "responses.player.shuffled") });
    if (e.type === "add") refresh({ message: this.t(msg, "responses.player.added", { title: Utils.truncate(e.data.data.title, 30) }) });
  };
  const onVolume     = (v)      => refresh({ message: this.t(msg, "responses.player.volumeChanged", { volume: Math.round(v * 100) }) });
  const onFilter     = (f)      => {
    if (!f) {
      refresh({ message: this.t(msg, "responses.player.filtersCleared") });
    } else if (f.label.includes("+")) {
      refresh({ message: this.t(msg, "responses.player.filterStackedApplied", { label: f.label }) });
    } else {
      refresh({ message: this.t(msg, "responses.player.filterApplied", { emoji: f.emoji ?? "🎛️", label: f.label }) });
    }
  };
  const onAutoLeave  = ()       => closeSession("disconnected");

  player.on("startplay",  onStartPlay);
  player.on("playback",   onPlayback);
  player.on("stopplay",   onStopPlay);
  player.on("queue",      onQueue);
  player.on("volume",     onVolume);
  player.on("filter",     onFilter);
  player.on("autoleave",  onAutoLeave);

  const unobserve = message.onReaction(controlEmojis, async (e) => {
    const control = allControls.find(c => c.emoji === e.emoji_id);
    if (!control) return;

    resetEmojiTimer();
    resetTimeout();

    let reply = "";
    let shouldUpdate = true;

    try {
      switch (control.action) {
        case "previous":
          reply = this.t(msg, "responses.player.previousNotImplemented");
          break;

        case "resume":
          if (player.paused) {
            reply = player.resume();
          } else if (!player.queue.getCurrent() && !player.queue.isEmpty()) {
            player.playNext();
            reply = this.t(msg, "responses.player.startingPlayback");
          } else {
            reply = this.t(msg, "responses.player.alreadyPlaying");
          }
          break;

        case "pause":
          reply = player.pause();
          break;

        case "stop":
          await player._stopMediaPlayer();
          player.queue.reset();
          reply = this.t(msg, "responses.player.stoppedCleared");
          break;

        case "skip":
          reply = player.skip();
          break;

        case "loop": {
          const currentLoop = player.queue.loop;
          const currentSongLoop = player.queue.songLoop;
          if (!currentLoop && !currentSongLoop) {
            player.queue.setSongLoop(true);
            reply = this.t(msg, "responses.player.songLoopEnabled");
          } else if (currentSongLoop) {
            player.queue.setSongLoop(false);
            player.queue.setLoop(true);
            reply = this.t(msg, "responses.player.queueLoopEnabled");
          } else {
            player.queue.setLoop(false);
            reply = this.t(msg, "responses.player.loopDisabled");
          }
          break;
        }

        case "shuffle":
          reply = player.shuffle();
          break;

        case "voldown": {
          const newVolDown = Utils.clamp((player.preferredVolume || 1) - 0.1, 0, 1);
          reply = player.setVolume(newVolDown);
          break;
        }

        case "volup": {
          const newVolUp = Utils.clamp((player.preferredVolume || 1) + 0.1, 0, 1);
          reply = player.setVolume(newVolUp);
          break;
        }

        case "filter":
          reply = this.t(msg, "responses.player.openingFilterPicker");
          shouldUpdate = true;
          try {
            const { run: runFilter } = await import("./filter.mjs");
            runFilter.call(this, msg);
          } catch (err) {
            reply = this.t(msg, "responses.player.filterError", { error: Utils.truncate(err.message, 50) });
          }
          break;

        case "lyrics":
          reply = this.t(msg, "responses.player.fetchingLyrics");
          refresh({ message: reply });

          try {
            if (lyricsUnobserve) {
              lyricsUnobserve();
              clearTimeout(lyricsEmojiTimeout);
              if (activeLyricsMsg) await clearLyricsReactions(activeLyricsMsg);
            }

            const lyricsResult = await player.lyrics();
            if (!lyricsResult) {
              reply = this.t(msg, "responses.player.noLyricsFound");
              shouldUpdate = true;
              break;
            }

            const syncBadge = lyricsResult.synced ? " ⏱️ Synced" : "";
            const lines = lyricsResult.text.split('\n');
            const totalLines = lines.length;
            const LINES_PER_PAGE = 25;
            const totalPages = Math.ceil(totalLines / LINES_PER_PAGE);

            const pages = [];
            for (let i = 0; i < totalLines; i += LINES_PER_PAGE) {
              pages.push(lines.slice(i, i + LINES_PER_PAGE).join('\n'));
            }

            let currentPage = 0;

            const buildLyricsContent = (pageIdx, expired = false, closed = false) => {
              const title = Utils.truncate(
                  player.queue.getCurrent()?.title?.replace(/\(Official.*?\)/gi, '').trim() ?? '',
                  50
              );
              const footerText = closed
                  ? `👋 Lyrics closed • NodeLink • ${totalLines} lines`
                  : expired
                      ? `⌛ Controls expired • NodeLink • ${totalLines} lines`
                      : `NodeLink • ${totalLines} lines total${lyricsResult.synced ? ' • Synced' : ''}`;
              const desc = [
                `**${title}**${syncBadge} • Page ${pageIdx + 1}/${totalPages}`,
                ``,
                '```',
                pages[pageIdx],
                totalPages > 1 && !expired && !closed ? `\n\n💡 ⬅️ ➡️ Navigate • ❌ Close` : '',
                '```'
              ].join('\n');
              return { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(desc).setFooter({ text: footerText })] };
            };

            activeLyricsMsg = await msg.reply(buildLyricsContent(0));

            if (activeLyricsMsg?.message && totalPages > 1) {
              const navEmojis = ["⬅️", "➡️", "❌"];
              for (const emoji of navEmojis) {
                await activeLyricsMsg.message.react(emoji).catch(() => {});
              }

              const resetLyricsTimer = () => {
                clearTimeout(lyricsEmojiTimeout);
                lyricsEmojiTimeout = setTimeout(async () => {
                  await clearLyricsReactions(activeLyricsMsg);
                  await activeLyricsMsg.edit(buildLyricsContent(currentPage, true, false)).catch(() => {});
                }, EMOJI_REMOVE_TIMEOUT);
              };

              lyricsUnobserve = activeLyricsMsg.onReaction(navEmojis, async (e) => {
                if (e.emoji_id === "❌") {
                  lyricsUnobserve();
                  clearTimeout(lyricsEmojiTimeout);
                  await clearLyricsReactions(activeLyricsMsg);
                  await activeLyricsMsg.edit(buildLyricsContent(currentPage, false, true)).catch(() => {});
                  return;
                }

                resetLyricsTimer();

                if (e.emoji_id === "⬅️") {
                  currentPage = currentPage > 0 ? currentPage - 1 : totalPages - 1;
                } else if (e.emoji_id === "➡️") {
                  currentPage = currentPage < totalPages - 1 ? currentPage + 1 : 0;
                }

                await activeLyricsMsg.edit(buildLyricsContent(currentPage));
              });

              resetLyricsTimer();
            } else if (activeLyricsMsg?.message) {
              await activeLyricsMsg.message.react("❌").catch(() => {});

              const resetLyricsTimer = () => {
                clearTimeout(lyricsEmojiTimeout);
                lyricsEmojiTimeout = setTimeout(async () => {
                  await clearLyricsReactions(activeLyricsMsg);
                  await activeLyricsMsg.edit(buildLyricsContent(0, true, false)).catch(() => {});
                }, EMOJI_REMOVE_TIMEOUT);
              };

              lyricsUnobserve = activeLyricsMsg.onReaction(["❌"], async (e) => {
                if (e.emoji_id === "❌") {
                  lyricsUnobserve();
                  clearTimeout(lyricsEmojiTimeout);
                  await clearLyricsReactions(activeLyricsMsg);
                  await activeLyricsMsg.edit(buildLyricsContent(0, false, true)).catch(() => {});
                }
              });

              resetLyricsTimer();
            }

            reply = this.t(msg, "responses.player.lyricsDisplayed", { lines: totalLines, pages: totalPages });

          } catch (err) {
            reply = this.t(msg, "responses.player.lyricsError", { error: Utils.truncate(err.message, 50) });
          }
          shouldUpdate = true;
          break;

        case "close":
          await closeSession("user");
          return;
      }
    } catch (err) {
      reply = `⚠️ Error: ${err.message}`;
    }

    if (shouldUpdate) refresh({ message: reply });
  });

  resetTimeout();
  resetEmojiTimer();
}