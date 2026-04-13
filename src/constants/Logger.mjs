/**
 * Logger — configurable console output for Fluxer.
 *
 * Categories (all under config.logging):
 *   enabled       — master switch; false silences everything except errors
 *   player        — voice connect/disconnect, stream start, volume restore
 *   inactivity    — alone-check, inactivity timer, human detection
 *   voice247      — 24/7 rejoin, auto-save channel, intentional leave skip
 *   voiceState    — raw VOICE_STATE_UPDATE events (human join/leave detection)
 *   mediaplayer   — MediaPlayer publish, LiveKit room state, connection recovery
 *   commands      — command load, module load, error IDs
 *   guild         — GuildCreate / GuildDelete lifecycle
 *   recovery      — session save/restore on reboot
 *   settings      — settings DB load, remote update errors
 *   worker        — worker URL cleaning, result logging
 *   moonlink      — moonlink node events
 *   errors        — always on; console.error calls (cannot be disabled)
 */

let _config = null;

/**
 * Call once at startup with the loaded config object.
 * @param {object} config
 */
export function initLogger(config) {
  _config = config?.logging ?? {};
}

function isEnabled(category) {
  if (!_config) return true; // default on if not yet initialised
  if (_config.enabled === false) return false;
  // If the category key is missing, default to true
  return _config[category] !== false;
}

function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export const logger = {
  // ── always-on (errors / warnings critical to operation) ──────────────────
  error(tag, ...args) {
    console.error(`[${ts()}] ${tag}`, ...args);
  },
  warn(tag, ...args) {
    // warnings are on unless master switch is off
    if (_config?.enabled === false) return;
    console.warn(`[${ts()}] ${tag}`, ...args);
  },

  // ── categorised logs ─────────────────────────────────────────────────────
  player(...args)      { if (isEnabled("player"))      console.log(`[${ts()}]`, ...args); },
  inactivity(...args)  { if (isEnabled("inactivity"))  console.log(`[${ts()}]`, ...args); },
  voice247(...args)    { if (isEnabled("voice247"))     console.log(`[${ts()}]`, ...args); },
  voiceState(...args)  { if (isEnabled("voiceState"))   console.log(`[${ts()}]`, ...args); },
  mediaplayer(...args) { if (isEnabled("mediaplayer"))  console.log(`[${ts()}]`, ...args); },
  commands(...args)    { if (isEnabled("commands"))     console.log(`[${ts()}]`, ...args); },
  guild(...args)       { if (isEnabled("guild"))        console.log(`[${ts()}]`, ...args); },
  recovery(...args)    { if (isEnabled("recovery"))     console.log(`[${ts()}]`, ...args); },
  settings(...args)    { if (isEnabled("settings"))     console.log(`[${ts()}]`, ...args); },
  worker(...args)      { if (isEnabled("worker"))       console.log(`[${ts()}]`, ...args); },
  moonlink(...args)    { if (isEnabled("moonlink"))     console.log(`[${ts()}]`, ...args); },
  aloneCheck(...args)  { if (isEnabled("inactivity"))  console.log(`[${ts()}]`, ...args); },
};
