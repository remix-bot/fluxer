import ffprobe from "ffprobe-static";
import { spawn } from "node:child_process";

export default function probe(file) {
  return new Promise(res => {
    const options = "-hide_banner -show_entries format_tags:format=duration -print_format json -i " + file;
    const proc = spawn(ffprobe.path, options.split(" "));
    const chunks = [];
    proc.stdout.on("data", (d) => { chunks.push(d); });
    proc.stdout.on("end", () => {
      const data = JSON.parse(Buffer.concat(chunks).toString());
      res({
        album: data.format?.tags?.album,
        artist: data.format?.tags?.artist,
        title: data.format?.tags?.title || data.format?.tags?.StreamTitle,
        duration: data.format.duration * 1000
      });
    });
  });
}
