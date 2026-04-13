import ffprobe from "ffprobe-static";
import { spawn } from "node:child_process";

export default function probe(file) {
  return new Promise((res, rej) => {
    // Pass args as an array — splitting a string on " " breaks paths that contain spaces.
    const args = [
      "-hide_banner",
      "-show_entries", "format_tags:format=duration",
      "-print_format", "json",
      "-i", file,
    ];
    const proc = spawn(ffprobe.path, args);
    const chunks = [];
    const errChunks = [];

    proc.stdout.on("data", (d) => { chunks.push(d); });
    proc.stderr.on("data", (d) => { errChunks.push(d); });

    proc.on("error", (err) => {
      rej(new Error("[probe] Failed to spawn ffprobe: " + err.message));
    });

    proc.on("close", (code) => {
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
