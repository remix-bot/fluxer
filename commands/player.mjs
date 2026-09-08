/**
 * @module commands/player
 * @description Create an interactive player control panel with live progress, reaction controls,
 * and embedded lyrics viewer. The panel embed construction, display constants and the lyrics
 * viewer live in commands/player/; run() below owns the session lifecycle (timers, player
 * event wiring and the control-reaction dispatcher).
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { Utils } from "../src/utils/Utils.mjs";
import { getGlobalColor } from "../src/ui/index.mjs";
import { EMOJI_REMOVE_TIMEOUT } from "../src/utils/UI.mjs";
import { logger } from "../src/core/Logger.mjs";
import { CONTROLS, buildPlayerEmbed, openLyricsViewer, clearLyricsReactions } from "./player/index.mjs";

/** @type {CommandBuilder} @description Command definition for the player command. */
export const command = new CommandBuilder()
    .setName("player")
    .setDescription("Create an interactive player control panel with live progress", "commands.player")
    .setCategory("music");

/**
 * @async
 * Run handler for the player command.
 * Creates an interactive embed panel with playback controls, progress bar,
 * volume display, and an embedded lyrics viewer.
 * @param {object} msg - The command message wrapper.
 * @returns {Promise<void>}
 */
export async function run(msg) {
  const player = await this.getPlayer(msg, false, false, false);
  if (!player) return;

  const timeout = Math.max(60_000, this.config?.timers?.playerSessionTimeout ?? this.config?.playerAFKTimeout ?? 300000);
  const controlsLayout = [
    [CONTROLS.prev, CONTROLS.play, CONTROLS.pause, CONTROLS.stop, CONTROLS.next],
    [CONTROLS.loop, CONTROLS.shuffle, CONTROLS.volDown, CONTROLS.volUp, CONTROLS.lyrics],
    [CONTROLS.filter, CONTROLS.close]
  ];

  const allControls = controlsLayout.flat();
  const controlEmojis = allControls.map(c => c.emoji);

  const message = await msg.reply({ embeds: [buildPlayerEmbed(this, msg, player, timeout)] });
  if (!message?.message) return;

  for (const row of controlsLayout) {
    for (const control of row) {
      try {
        await message.message.react(control.emoji);
        await Utils.sleep(50);
      } catch(e) { logger.warn("[Player] Error:", e?.message); }
    }
  }

  let sessionTimeout;
  let updateInterval;
  let emojiRemoveTimeout;
  let lastState = {};

  /** @private @type {object} Shared lyrics-viewer session state (cleaned up by closeSession). */
  const lyrics = { activeLyricsMsg: null, unobserve: null, emojiTimeout: null };

  /**
   * @private
   * Remove all control reactions from the player panel message.
   * @returns {Promise<void>}
   */
  const clearReactions = async () => {
    try {
      await message.message.removeAllReactions();
    } catch (e) {
      for (const emoji of controlEmojis) {
        try {
          await message.message.removeReaction(emoji);
        } catch(e) { logger.warn("[Player] Error:", e?.message); }
      }
    }
  };

  /**
   * @private
   * Reset the emoji removal timeout for the player panel controls.
   * @returns {void}
   */
  const resetEmojiTimer = () => {
    clearTimeout(emojiRemoveTimeout);
    emojiRemoveTimeout = setTimeout(async () => {
      await clearReactions();
      const disabledEmbed = buildPlayerEmbed(this, msg, player, timeout, { message: this.t(msg, "responses.player.controlsDisabled") });
      disabledEmbed.footer = { text: this.t(msg, "responses._common.controlsExpired") };
      await message.edit({ embeds: [disabledEmbed] }).catch(() => {});
    }, EMOJI_REMOVE_TIMEOUT);
  };

  let editFailures = 0;

  /**
   * @private
   * Rebuild and edit the player panel embed with updated state.
   * @param {object} [extra={}] - Additional state data to merge (e.g. status message).
   * @returns {void}
   */
  const refresh = (extra = {}) => {
    const embed = buildPlayerEmbed(this, msg, player, timeout, extra);
    message.edit({ embeds: [embed] })
        .then(() => { editFailures = 0; })
        .catch(() => {
          if (++editFailures >= 3) {
            clearInterval(updateInterval);
            updateInterval = null;
          }
        });
    lastState = extra;
  };

  let _sessionClosed = false;

  /**
   * @private
   * @async
   * Tear down the entire player session: clear timers, remove listeners,
   * clean up reactions, and edit the embed to show the closed state.
   * @param {string} [reason="timeout"] - The reason for closing ("timeout", "user", "disconnected").
   * @returns {Promise<void>}
   */
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

    if (lyrics.unobserve) {
      lyrics.unobserve();
      clearTimeout(lyrics.emojiTimeout);
    }
    if (lyrics.activeLyricsMsg) {
      await clearLyricsReactions(lyrics.activeLyricsMsg);
    }

    await clearReactions();

    const closedEmbed = buildPlayerEmbed(this, msg, player, timeout, {
      message: this.t(msg, "responses.player.sessionClosed", { reason: reason !== "timeout" ? ` • ${reason}` : "" })
    });
    closedEmbed.setColor(getGlobalColor());
    closedEmbed.setFooter({ text: this.t(msg, "responses._common.sessionEnded") });
    closedEmbed.setTitle(this.t(msg, "responses.player.inactiveTitle"));

    await message.edit({
      embeds: [closedEmbed],
      content: reason === "user" ? this.t(msg, "responses.player.closedByUser") : undefined
    }).catch(() => {});
  };

  /**
   * @private
   * Reset the session inactivity timeout timer.
   * @returns {void}
   */
  const resetTimeout = () => {
    clearTimeout(sessionTimeout);
    sessionTimeout = setTimeout(() => closeSession("timeout"), timeout);
  };

  updateInterval = setInterval(() => {
    if (player._destroyed || player.leaving) {
      clearInterval(updateInterval);
      updateInterval = null;
      return;
    }
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
          reply = this.t(msg, "responses.player.previousNotAvailable");
          break;

        case "resume":
          if (player.paused) {
            reply = player.resume();
          } else if (!player.queue.getCurrent() && !player.queue.isEmpty()) {
            player.playNext().catch(() => {});
            reply = this.t(msg, "responses.player.startingPlayback");
          } else {
            reply = this.t(msg, "responses.player.alreadyPlaying");
          }
          break;

        case "pause":
          reply = player.pause();
          break;

        case "stop":
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
          const newVolDown = Utils.clamp((player.preferredVolume ?? 1) - 0.1, 0, 1);
          reply = player.setVolume(newVolDown);
          break;
        }

        case "volup": {
          const newVolUp = Utils.clamp((player.preferredVolume ?? 1) + 0.1, 0, 1);
          reply = player.setVolume(newVolUp);
          break;
        }

        case "filter":
          reply = this.t(msg, "responses.player.openingFilterPicker");
          shouldUpdate = true;
          try {
            const { run: runFilter } = await import("./filter.mjs");
            await runFilter.call(this, msg);
          } catch (err) {
            reply = this.t(msg, "responses.player.filterError", { error: Utils.truncate(err.message, 50) });
          }
          break;

        case "lyrics":
          reply = await openLyricsViewer(this, msg, player, refresh, lyrics);
          shouldUpdate = true;
          break;

        case "close":
          await closeSession("user");
          return;
      }
    } catch (err) {
      reply = this.t(msg, "responses.player.errorGeneric", { error: err.message });
    }

    if (shouldUpdate) refresh({ message: reply });
  });

  resetTimeout();
  resetEmojiTimer();
}
