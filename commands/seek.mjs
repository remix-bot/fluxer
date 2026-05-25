import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

export const command = new CommandBuilder()
  .setName("seek")
  .setDescription("Seek to a specific position in the current track.", "commands.seek")
  .setCategory("music")
  .addTextOption(o =>
    o.setName("position")
      .setDescription("Position to seek to (e.g. 1:30, 90, or 1:30:00 for hours)")
      .setRequired(true)
  );

export async function run(msg, data) {
  const positionInput = data.get("position")?.value;

  const p = await this.getPlayer(msg, true, true, false);
  if (!p) return;

  if (!p.queue?.getCurrent()) {
    return msg.reply({ embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.seek.nothingPlaying"))] });
  }

  if (p._paused) {
    return msg.reply({ embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.seek.paused"))] });
  }

  let seekMs = parseSeekPosition(positionInput);
  if (seekMs === null || seekMs < 0) {
    return msg.reply({ embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.seek.invalidFormat"))] });
  }

  const trackDuration = p._getTrackDurationMs(p.queue.getCurrent());

  if (trackDuration > 0 && seekMs >= trackDuration) {
    const maxStr = formatDuration(trackDuration);
    return msg.reply({ embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.seek.exceedsDuration", { duration: maxStr }))] });
  }

  try {
    const result = await p.seekToPosition(seekMs);
    if (result) {
      const seekStr = formatDuration(seekMs);
      const totalStr = trackDuration > 0 ? formatDuration(trackDuration) : "∞";
      return msg.reply({ embeds: [new EmbedBuilder().setColor(getGlobalColor()).setDescription(this.t(msg, "responses.seek.seeked", { position: seekStr }))] });
    } else {
      return msg.reply({ embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.seek.notSupported"))] });
    }
  } catch (err) {
    return msg.reply({ embeds: [new EmbedBuilder().setColor("#ff0000").setDescription(this.t(msg, "responses.seek.failed", { error: err.message }))] });
  }
}

function parseSeekPosition(str) {
  if (!str || typeof str !== "string") return null;
  str = str.trim();

  if (/^\d+$/.test(str)) {
    return parseInt(str, 10) * 1000;
  }

  const parts = str.split(":").map(Number);
  if (parts.some(isNaN)) return null;

  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    if (seconds >= 60) return null;
    return (minutes * 60 + seconds) * 1000;
  }

  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    if (minutes >= 60 || seconds >= 60) return null;
    return (hours * 3600 + minutes * 60 + seconds) * 1000;
  }

  return null;
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
