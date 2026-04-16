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
    [CONTROLS.close]
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

      // Use Utils.prettifyMS instead of local formatTime
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

    const nowPlaying = current
        // Use Utils.truncate instead of local truncate
        ? `[${Utils.truncate(current.title, 45)}](${current.spotifyUrl || current.url})`
        : "*Nothing playing*";

    const description = [
      `${statusEmoji} **Now Playing**`,
      `${nowPlaying}`,
      ``,
      `${progressBar}`,
      `${timeDisplay}`,
      ``,
      `🔊 Volume: \`${volPercent}%\` ${volumeBar}`,
      `📋 Queue: \`${queueSize}\` tracks | Loop: ${loopStatus}`,
      ``,
      state.message ? `💬 *${state.message}*` : "💡 *React to control playback*",
      ``,
      `⏱️ Session expires in ${Math.ceil(timeout / 60000)}m of inactivity`
    ].join("\n");

    // avatarURL may be a plain property (Fluxer) or a method— call it if
    // it's a function, otherwise use it as-is so the footer icon works in both cases.
    const avatarUrl = typeof msg.author?.avatarURL === "function"
        ? msg.author.avatarURL()
        : msg.author?.avatarURL ?? null;

    const builder = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle("🎧 Music Player Controls")
        .setDescription(description)
        .setFooter({
          text: `Requested by ${msg.author?.username || "Unknown"} • Controls active`,
          iconURL: avatarUrl
        });
    // setTimestamp() is not verified on @fluxerjs/core's EmbedBuilder — guard it.
    if (typeof builder.setTimestamp === "function") builder.setTimestamp();
    if (current?.thumbnail) builder.setThumbnail(current.thumbnail);
    return builder.toJSON();
  };

  const message = await msg.replyEmbed({ embeds: [buildEmbed()] });
  if (!message?.message) return;

  // Add reactions with staggered animation
  for (const row of controlsLayout) {
    for (const control of row) {
      try {
        await message.message.react(control.emoji);
        await Utils.sleep(200); // Use Utils.sleep instead of inline Promise
      } catch (_) {}
    }
  }

  let sessionTimeout;
  let updateInterval;
  let emojiRemoveTimeout;
  let lastState = {};

  // Track active lyrics message
  let activeLyricsMsg = null;
  let lyricsUnobserve = null;
  let lyricsEmojiTimeout = null;

  // Helper: Clear all reactions
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

  // Helper: Reset emoji removal timer
  const resetEmojiTimer = () => {
    clearTimeout(emojiRemoveTimeout);
    emojiRemoveTimeout = setTimeout(async () => {
      await clearReactions();
      const disabledEmbed = buildEmbed({ message: "⌛ Controls disabled (react to re-enable)" });
      disabledEmbed.footer = { text: "Controls expired • React to refresh" };
      await message.editEmbed({ embeds: [disabledEmbed] }).catch(() => {});
    }, EMOJI_REMOVE_TIMEOUT);
  };

  // Helper: Clear lyrics reactions
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
    message.editEmbed({ embeds: [embed] }).catch(() => {});
    lastState = extra;
  };

  const closeSession = async (reason = "timeout") => {
    clearTimeout(sessionTimeout);
    clearTimeout(emojiRemoveTimeout);
    clearInterval(updateInterval);
    unobserve?.();

    // Remove all player event listeners added by this session
    player.off("startplay", onStartPlay);
    player.off("playback",  onPlayback);
    player.off("stopplay",  onStopPlay);
    player.off("queue",     onQueue);
    player.off("volume",    onVolume);
    player.off("autoleave", onAutoLeave);

    // Cleanup any active lyrics
    if (lyricsUnobserve) {
      lyricsUnobserve();
      clearTimeout(lyricsEmojiTimeout);
    }
    if (activeLyricsMsg) {
      await clearLyricsReactions(activeLyricsMsg);
    }

    await clearReactions();

    const closedEmbed = buildEmbed({
      message: `Session closed${reason !== "timeout" ? ` • ${reason}` : " due to inactivity"}`
    });
    // Override title and footer on the plain object returned by toJSON()
    closedEmbed.color  = getGlobalColor();
    closedEmbed.footer = { text: "Session ended" };
    closedEmbed.title  = "🎧 Music Player (Inactive)";

    await message.editEmbed({
      embeds: [closedEmbed],
      content: reason === "user" ? "👋 Player controls closed" : undefined
    }).catch(() => {});
  };

  const resetTimeout = () => {
    clearTimeout(sessionTimeout);
    sessionTimeout = setTimeout(() => closeSession("timeout"), timeout);
  };

  // Live progress updates
  updateInterval = setInterval(() => {
    if (!player.paused && player.queue.getCurrent()) {
      refresh(lastState);
    }
  }, this.config?.timers?.playerUpdateInterval ?? 5000);

  // Player events — store named handlers so we can remove them on closeSession
  const onStartPlay  = ()       => refresh({ message: "▶️ Started playing" });
  const onPlayback   = (playing) => refresh({ message: playing ? "▶️ Resumed" : "⏸️ Paused" });
  const onStopPlay   = ()       => refresh({ message: "⏹️ Stopped" });
  const onQueue      = (e)      => {
    if (e.type === "shuffle") refresh({ message: "🔀 Queue shuffled" });
    if (e.type === "add") refresh({ message: `➕ Added: ${Utils.truncate(e.data.data.title, 30)}` });
  };
  const onVolume     = (v)      => refresh({ message: `🔊 Volume: ${Math.round(v * 100)}%` });
  const onAutoLeave  = ()       => closeSession("disconnected");

  player.on("startplay",  onStartPlay);
  player.on("playback",   onPlayback);
  player.on("stopplay",   onStopPlay);
  player.on("queue",      onQueue);
  player.on("volume",     onVolume);
  player.on("autoleave",  onAutoLeave);

  // Reaction handler
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
          reply = "⏮️ Previous track (not implemented)";
          break;

        case "resume":
          if (player.paused) {
            reply = player.resume();
          } else if (!player.queue.getCurrent() && !player.queue.isEmpty()) {
            player.playNext();
            reply = "▶️ Starting playback";
          } else {
            reply = "▶️ Already playing";
          }
          break;

        case "pause":
          reply = player.pause();
          break;

        case "stop":
          await player._stopMediaPlayer();
          player.queue.reset();
          reply = "⏹️ Stopped and cleared";
          break;

        case "skip":
          reply = player.skip();
          break;

        case "loop": {
          const currentLoop = player.queue.loop;
          const currentSongLoop = player.queue.songLoop;
          if (!currentLoop && !currentSongLoop) {
            player.queue.setSongLoop(true);
            reply = "🔂 Song loop enabled";
          } else if (currentSongLoop) {
            player.queue.setSongLoop(false);
            player.queue.setLoop(true);
            reply = "🔁 Queue loop enabled";
          } else {
            player.queue.setLoop(false);
            reply = "❌ Loop disabled";
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

        case "lyrics":
          reply = "📜 Fetching lyrics...";
          refresh({ message: reply });

          try {
            // Cleanup previous lyrics
            if (lyricsUnobserve) {
              lyricsUnobserve();
              clearTimeout(lyricsEmojiTimeout);
              if (activeLyricsMsg) await clearLyricsReactions(activeLyricsMsg);
            }

            const lyricsResult = await player.lyrics();
            if (!lyricsResult) {
              reply = "❌ No lyrics found in NodeLink";
              shouldUpdate = true;
              break;
            }

            const syncBadge = lyricsResult.synced ? " ⏱️ Synced" : "";
            const lines = lyricsResult.text.split('\n');
            const totalLines = lines.length;
            const LINES_PER_PAGE = 25;
            const totalPages = Math.ceil(totalLines / LINES_PER_PAGE);

            // Build pages
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
              return { embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(desc).setFooter({ text: footerText }).toJSON()] };
            };

            // Send initial lyrics
            activeLyricsMsg = await msg.replyEmbed(buildLyricsContent(0));

            // Add pagination and close button if needed
            if (activeLyricsMsg?.message && totalPages > 1) {
              const navEmojis = ["⬅️", "➡️", "❌"];
              for (const emoji of navEmojis) {
                await activeLyricsMsg.message.react(emoji).catch(() => {});
              }

              // Reset timer helper
              const resetLyricsTimer = () => {
                clearTimeout(lyricsEmojiTimeout);
                lyricsEmojiTimeout = setTimeout(async () => {
                  await clearLyricsReactions(activeLyricsMsg);
                  await activeLyricsMsg.editEmbed(buildLyricsContent(currentPage, true, false)).catch(() => {});
                }, EMOJI_REMOVE_TIMEOUT);
              };

              // Navigation handler
              lyricsUnobserve = activeLyricsMsg.onReaction(navEmojis, async (e) => {
                // Close button
                if (e.emoji_id === "❌") {
                  lyricsUnobserve();
                  clearTimeout(lyricsEmojiTimeout);
                  await clearLyricsReactions(activeLyricsMsg);
                  await activeLyricsMsg.editEmbed(buildLyricsContent(currentPage, false, true)).catch(() => {});
                  return;
                }

                // Reset timer on navigation
                resetLyricsTimer();

                if (e.emoji_id === "⬅️") {
                  currentPage = currentPage > 0 ? currentPage - 1 : totalPages - 1;
                } else if (e.emoji_id === "➡️") {
                  currentPage = currentPage < totalPages - 1 ? currentPage + 1 : 0;
                }

                await activeLyricsMsg.editEmbed(buildLyricsContent(currentPage));
              });

              // Start 1 minute timer
              resetLyricsTimer();
            } else if (activeLyricsMsg?.message) {
              // Single page - just add close button
              await activeLyricsMsg.message.react("❌").catch(() => {});

              const resetLyricsTimer = () => {
                clearTimeout(lyricsEmojiTimeout);
                lyricsEmojiTimeout = setTimeout(async () => {
                  await clearLyricsReactions(activeLyricsMsg);
                  await activeLyricsMsg.editEmbed(buildLyricsContent(0, true, false)).catch(() => {});
                }, EMOJI_REMOVE_TIMEOUT);
              };

              lyricsUnobserve = activeLyricsMsg.onReaction(["❌"], async (e) => {
                if (e.emoji_id === "❌") {
                  lyricsUnobserve();
                  clearTimeout(lyricsEmojiTimeout);
                  await clearLyricsReactions(activeLyricsMsg);
                  await activeLyricsMsg.editEmbed(buildLyricsContent(0, false, true)).catch(() => {});
                }
              });

              resetLyricsTimer();
            }

            reply = `Lyrics displayed (${totalLines} lines, ${totalPages} pages)`;

          } catch (err) {
            // Use Utils.truncate instead of local truncate
            reply = `⚠️ Lyrics error: ${Utils.truncate(err.message, 50)}`;
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

  // Start timers
  resetTimeout();
  resetEmojiTimer();
}
