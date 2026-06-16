/**
 * @file probe.mjs — Health probe — monitors NodeLink and LiveKit endpoint availability
 * @module src.probe
 */

import ffprobe from "ffprobe-static";
import { spawn } from "node:child_process";

const PROBE_TIMEOUT_MS = 15_000;

export default function probe(file) {
  return new Promise((res, rej) => {
    const args = [
      "-hide_banner",
      "-show_entries", "format_tags:format=duration",
      "-print_format", "json",
      "-i", file,
    ];
    const proc = spawn(ffprobe.path, args);
    const chunks = [];
    const errChunks = [];
    let settled = false;

    const cleanup = () => {
      settled = true;
      clearTimeout(timeoutHandle);
      try { proc.kill(); } catch(e) { /* process already exited */ }
    };

    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      cleanup();
      rej(new Error("[probe] ffprobe timed out after " + (PROBE_TIMEOUT_MS / 1000) + "s"));
    }, PROBE_TIMEOUT_MS);

    proc.stdout.on("data", (d) => { chunks.push(d); });
    proc.stderr.on("data", (d) => { errChunks.push(d); });

    proc.on("error", (err) => {
      if (settled) return;
      cleanup();
      rej(new Error("[probe] Failed to spawn ffprobe: " + err.message));
    });

    proc.on("close", (code) => {
      if (settled) return;
      cleanup();
      try {
        const raw = Buffer.concat(chunks).toString();
        if (!raw.trim()) {
          const errMsg = Buffer.concat(errChunks).toString().trim();
          return rej(new Error("[probe] ffprobe produced no output" + (errMsg ? ": " + errMsg : "")));
        }
        const data = JSON.parse(raw);
        res({
          album:    data.format?.tags?.album,
          artist:   data.format?.tags?.artist,
          title:    data.format?.tags?.StreamTitle || data.format?.tags?.title || "Unknown",
          duration: (data.format?.duration ?? 0) * 1000
        });
      } catch (e) {
        rej(new Error("[probe] Failed to parse ffprobe output: " + e.message));
      }
    });
  });
}
