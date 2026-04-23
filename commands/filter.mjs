import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder }   from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";
import { Utils }          from "../src/Utils.mjs";

// ── Filter catalogue ──────────────────────────────────────────────────────────
const FILTERS = [
  {
    emoji:   "🔇",
    key:     "off",
    label:   "Off",
    desc:    "Remove all filters — restore original audio",
    payload: {},
  },
  {
    emoji:   "🔊",
    key:     "bassboost",
    label:   "Bass Boost",
    desc:    "Heavy low-end boost — thumping bass",
    payload: {
      equalizer: [
        { band: 0,  gain:  0.60 },
        { band: 1,  gain:  0.70 },
        { band: 2,  gain:  0.50 },
        { band: 3,  gain:  0.25 },
        { band: 4,  gain:  0.00 },
        { band: 5,  gain: -0.25 },
        { band: 6,  gain: -0.45 },
        { band: 7,  gain: -0.55 },
        { band: 8,  gain: -0.60 },
        { band: 9,  gain: -0.65 },
        { band: 10, gain: -0.70 },
        { band: 11, gain: -0.75 },
        { band: 12, gain: -0.70 },
        { band: 13, gain: -0.65 },
      ],
    },
  },
  {
    emoji:   "🌙",
    key:     "nightcore",
    label:   "Nightcore",
    desc:    "Sped-up + pitch-shifted — classic anime edit",
    payload: {
      timescale: { speed: 1.3, pitch: 1.3, rate: 1.0 },
    },
  },
  {
    emoji:   "🌊",
    key:     "vaporwave",
    label:   "Vaporwave",
    desc:    "Slowed + pitch-down with warm bass",
    payload: {
      timescale: { speed: 0.85, pitch: 0.85, rate: 1.0 },
      equalizer: [
        { band: 0, gain: 0.3 },
        { band: 1, gain: 0.3 },
      ],
    },
  },
  {
    emoji:   "🎧",
    key:     "8d",
    label:   "8D Audio",
    desc:    "Rotating stereo panning — best with headphones",
    payload: {
      rotation: { rotationHz: 0.2 },
    },
  },
  {
    emoji:   "🎤",
    key:     "karaoke",
    label:   "Karaoke",
    desc:    "Attempts vocal removal — instrumental feel",
    payload: {
      karaoke: {
        level:       1.0,
        monoLevel:   1.0,
        filterBand:  220.0,
        filterWidth: 100.0,
      },
    },
  },
  {
    emoji:   "〰️",
    key:     "tremolo",
    label:   "Tremolo",
    desc:    "Rapid volume oscillation — wavering effect",
    payload: {
      tremolo: { frequency: 2.0, depth: 0.5 },
    },
  },
  {
    emoji:   "🎸",
    key:     "vibrato",
    label:   "Vibrato",
    desc:    "Rapid pitch oscillation — guitar vibrato",
    payload: {
      vibrato: { frequency: 4.0, depth: 0.75 },
    },
  },
  {
    emoji:   "⚡",
    key:     "distortion",
    label:   "Distortion",
    desc:    "Gritty waveshaping distortion",
    payload: {
      distortion: {
        sinOffset: 0.0, sinScale: 1.0,
        cosOffset: 0.0, cosScale: 1.0,
        tanOffset: 0.0, tanScale: 1.0,
        offset:    0.0, scale:    1.0,
      },
    },
  },
  {
    emoji:   "🍃",
    key:     "soft",
    label:   "Soft",
    desc:    "Low-pass filter — smooths harsh highs",
    payload: {
      lowPass: { smoothing: 20.0 },
    },
  },
  {
    emoji:   "⏩",
    key:     "doubletime",
    label:   "Double Time",
    desc:    "2× speed, same pitch",
    payload: {
      timescale: { speed: 2.0, pitch: 1.0, rate: 1.0 },
    },
  },
  {
    emoji:   "🐢",
    key:     "slowmo",
    label:   "Slow Mo",
    desc:    "Half speed, original pitch",
    payload: {
      timescale: { speed: 0.5, pitch: 1.0, rate: 1.0 },
    },
  },
  {
    emoji:   "🐿️",
    key:     "chipmunk",
    label:   "Chipmunk",
    desc:    "Extreme pitch-up — squeaky voices",
    payload: {
      timescale: { speed: 1.05, pitch: 1.35, rate: 1.25 },
    },
  },
  {
    emoji:   "🗣️",
    key:     "deepvoice",
    label:   "Deep Voice",
    desc:    "Pitch-down for a big, low sound",
    payload: {
      timescale: { speed: 1.0, pitch: 0.65, rate: 1.0 },
    },
  },
];

const PAGE_SIZE    = 9;
const PREV_EMOJI   = "⬅️";
const NEXT_EMOJI   = "➡️";
const CANCEL_EMOJI = "❌";
const NAV_EMOJIS   = [PREV_EMOJI, NEXT_EMOJI, CANCEL_EMOJI];

const SESSION_MS = 60_000;

/**
 * Merge multiple active filter payloads into a single Lavalink filters object.
 * Categories that overlap are overwritten by the last filter in the list.
 * The special "off" key is skipped — it carries an empty payload and is handled
 * by clearing activeKeys before this function is called.
 */
function mergeFilterPayloads(keys) {
  const merged = {};
  for (const key of keys) {
    if (key === "off") continue; // "off" clears everything — handled upstream
    const f = FILTERS.find(f => f.key === key);
    if (!f || !f.payload || Object.keys(f.payload).length === 0) continue;
    for (const [category, settings] of Object.entries(f.payload)) {
      merged[category] = settings;
    }
  }
  return merged;
}

// ── Command definition ────────────────────────────────────────────────────────
export const command = new CommandBuilder()
    .setName("filter")
    .setDescription(
        "Open an interactive filter picker — react with an emoji to apply an audio effect.",
        "commands.filter"
    )
    .setCategory("music")
    .addAliases("filters", "fx", "effect");

// ── Build page embed ──────────────────────────────────────────────────────────
function buildPageEmbed(page, activeKeys, current) {
  const totalPages = Math.ceil(FILTERS.length / PAGE_SIZE);
  const start      = page * PAGE_SIZE;
  const pageItems  = FILTERS.slice(start, start + PAGE_SIZE);

  const trackLine = current
      ? `🎵 **${Utils.truncate(current.title, 45)}**`
      : "*Nothing playing*";

  // Show active filter indicators
  const activeSet = new Set(activeKeys);
  const lines = pageItems.map(f => {
    const isActive = activeSet.has(f.key);
    const active = isActive ? " **← active**" : "";
    return `${f.emoji} **${f.label}**${active} — *${f.desc}*`;
  });

  const navHint = totalPages > 1
      ? `\n\n${PREV_EMOJI} Prev  ${NEXT_EMOJI} Next  ${CANCEL_EMOJI} Close`
      : `\n\n${CANCEL_EMOJI} Close`;

  // Build active summary line
  let activeSummary = "";
  if (activeKeys.length > 0) {
    const activeLabels = activeKeys.map(k => {
      const f = FILTERS.find(f => f.key === k);
      return f ? `${f.emoji} ${f.label}` : k;
    });
    activeSummary = `\n🔥 Active: ${activeLabels.join(" + ")}\n`;
  }

  return new EmbedBuilder()
      .setColor(getGlobalColor())
      .setAuthor({ name: "🎛️ Audio Filter Picker" })
      .setDescription(
          `${trackLine}\n${activeSummary}\n` +
          lines.join("\n") +
          navHint
      )
      .setFooter({
        text: `Page ${page + 1}/${totalPages} • React with a filter emoji to toggle it`
      })
      .toJSON();
}

// ── Command handler ───────────────────────────────────────────────────────────
export async function run(msg) {
  const player = await this.getPlayer(msg, false, false, false);
  if (!player) return;

  // Track multiple active filters (stackable)
  let activeKeys = player.activeFilter?.key
      ? player.activeFilter.key.split("+").filter(Boolean)
      : [];
  let page = 0;

  const totalPages = Math.ceil(FILTERS.length / PAGE_SIZE);

  const getPageItems = (p) => FILTERS.slice(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE);

  const allEmojisForPage = (p) => [
    ...getPageItems(p).map(f => f.emoji),
    ...NAV_EMOJIS,
  ];

  const current = player.queue.getCurrent();
  const menuMsg = await msg.replyEmbed({
    embeds: [buildPageEmbed(page, activeKeys, current)]
  });
  if (!menuMsg?.message) return;

  const addReactions = async (p) => {
    for (const emoji of allEmojisForPage(p)) {
      try {
        await menuMsg.message.react(emoji);
        await Utils.sleep(150);
      } catch (_) {}
    }
  };

  await addReactions(page);

  let settled = false;
  let sessionTimer;

  const clearReactions = async () => {
    try {
      await menuMsg.message.removeAllReactions();
    } catch (_) {
      for (const emoji of [...FILTERS.map(f => f.emoji), ...NAV_EMOJIS]) {
        try { await menuMsg.message.removeReaction(emoji); } catch (_) {}
      }
    }
  };

  const close = async (reason) => {
    if (settled) return;
    settled = true;
    clearTimeout(sessionTimer);
    unobserve?.();
    await clearReactions();

    const activeLabel = activeKeys.length > 0
        ? FILTERS.find(f => f.key === activeKeys[0])?.label ?? activeKeys[0]
        : null;

    const closedEmbed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setAuthor({ name: "🎛️ Audio Filter Picker" })
        .setDescription(
            activeKeys.length > 0
                ? `✅ Filters active: **${activeKeys.map(k => FILTERS.find(f => f.key === k)?.label ?? k).join(" + ")}**.\n\n${reason}`
                : `🔇 No filter active.\n\n${reason}`
        )
        .setFooter({ text: "Session ended" })
        .toJSON();

    await menuMsg.editEmbed({ embeds: [closedEmbed] }).catch(() => {});
  };

  const resetTimer = () => {
    clearTimeout(sessionTimer);
    sessionTimer = setTimeout(() => close("⌛ Session timed out."), SESSION_MS);
  };

  const allPossibleEmojis = [...new Set([
    ...FILTERS.map(f => f.emoji),
    ...NAV_EMOJIS,
  ])];

  const unobserve = menuMsg.onReaction(allPossibleEmojis, async (e) => {
    if (settled) return;

    resetTimer();

    // Normalise emoji identifier across Fluxer reaction event shapes
    const emoji = e.emoji_id ?? e.emoji?.name ?? e.emoji?.id ?? e.emoji;

    // ── Navigation ──────────────────────────────────────────────────────────
    if (emoji === CANCEL_EMOJI) {
      return close("👋 Filter picker closed.");
    }

    if (emoji === PREV_EMOJI) {
      page = (page - 1 + totalPages) % totalPages;
      await menuMsg.editEmbed({
        embeds: [buildPageEmbed(page, activeKeys, player.queue.getCurrent())]
      }).catch(() => {});
      return;
    }

    if (emoji === NEXT_EMOJI) {
      page = (page + 1) % totalPages;
      await menuMsg.editEmbed({
        embeds: [buildPageEmbed(page, activeKeys, player.queue.getCurrent())]
      }).catch(() => {});
      return;
    }

    // ── Filter selection ────────────────────────────────────────────────────
    const filter = FILTERS.find(f => f.emoji === emoji);
    if (!filter) return;

    const track = player.queue.getCurrent();
    if (!track) {
      await menuMsg.editEmbed({
        embeds: [buildPageEmbed(page, activeKeys, null)]
      }).catch(() => {});
      const errEmbed = new EmbedBuilder()
          .setColor(getGlobalColor())
          .setDescription("❌ Nothing is playing right now.")
          .toJSON();
      await menuMsg.editEmbed({ embeds: [errEmbed] }).catch(() => {});
      await Utils.sleep(2000);
      await menuMsg.editEmbed({
        embeds: [buildPageEmbed(page, activeKeys, null)]
      }).catch(() => {});
      return;
    }

    // Toggle behavior: if already active, remove it; otherwise add it
    // "off" always clears everything
    if (filter.key === "off") {
      activeKeys = [];
    } else {
      const idx = activeKeys.indexOf(filter.key);
      if (idx !== -1) {
        activeKeys.splice(idx, 1); // Toggle off
      } else {
        activeKeys.push(filter.key); // Toggle on
      }
    }

    // Build merged payload from all active keys
    const mergedPayload = mergeFilterPayloads(activeKeys);
    const meta = activeKeys.length > 0
        ? {
          key: activeKeys.join("+"),
          label: activeKeys.map(k => FILTERS.find(f => f.key === k)?.label ?? k).join(" + "),
          emoji: filter.emoji,
        }
        : null;

    const { ok, reason } = await player.applyFilter(mergedPayload, meta);

    if (!ok) {
      const errEmbed = new EmbedBuilder()
          .setColor(getGlobalColor())
          .setDescription(
              `❌ Failed to apply **${filter.label}**: \`${reason}\`\n\n` +
              `Make sure your NodeLink node has filters enabled.`
          )
          .toJSON();
      await menuMsg.editEmbed({ embeds: [errEmbed] }).catch(() => {});
      await Utils.sleep(3000);
      await menuMsg.editEmbed({
        embeds: [buildPageEmbed(page, activeKeys, track)]
      }).catch(() => {});
      return;
    }

    // Update active key and refresh embed (player.activeFilter is already updated by applyFilter)
    activeKeys = meta ? meta.key.split("+") : [];

    const successMsg = filter.key === "off"
        ? "🔇 Filters cleared — original audio restored."
        : activeKeys.includes(filter.key)
            ? `${filter.emoji} **${filter.label}** applied!`
            : `${filter.emoji} **${filter.label}** removed.`;

    const confirmEmbed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setDescription(
            `${successMsg}\n\n` +
            `*${filter.desc}*\n\n` +
            `💡 React again to toggle, or ${CANCEL_EMOJI} to close.`
        )
        .toJSON();

    await menuMsg.editEmbed({ embeds: [confirmEmbed] }).catch(() => {});
    await Utils.sleep(2500);

    // Restore picker (session stays open)
    if (!settled) {
      await menuMsg.editEmbed({
        embeds: [buildPageEmbed(page, activeKeys, player.queue.getCurrent())]
      }).catch(() => {});
    }
  });

  resetTimer();
}