/**
 * @module commands/player/consts
 * @description Pure display constants for the player control panel: state
 * emoji indicators, control button definitions and progress-bar characters.
 */

/** @type {Object.<string, string>} Emoji indicators for player states. */
export const STATES = {
  playing: "🎵",
  paused: "⏸️",
  stopped: "🔇",
  loading: "⏳"
};

/** @type {Object.<string, {emoji: string, action: string, desc: string}>} Available control button definitions. */
export const CONTROLS = {
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

/** @type {Object.<string, string>} Progress bar character set. */
export const PROGRESS = {
  filled: "▰",
  empty: "▱",
  indicator: "●",
  start: "▏",
  end: "▕"
};
