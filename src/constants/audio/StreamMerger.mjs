import { logger } from "../Logger.mjs";
import ffmpeg from "ffmpeg-static";
import { Transform } from "node:stream";
import { spawn } from "node:child_process";

class StreamMerger extends Transform {
  ffmpegPath = ffmpeg;
  ffmpeg = null;
  streamTree = [];

  constructor(streamOptions) {
    super(streamOptions);
  }
  _transform(chunk, _enc, cb) {
    if (!this.ffmpeg) { this.push(chunk); return cb(); }
    this.ffmpeg.stdio[3].write(chunk);
    cb();
  }
  pipe(stream) {
    return super.pipe(stream);
  }
  setupBaseFfmpeg() {
    this.ffmpeg = this.spawnFfmpeg();
    this.ffmpeg.stderr.on("data", (chunk) => { logger.mediaplayer("[ffmpeg]", chunk.toString().trim()); });
    this.ffmpeg.stdout.on("data", (chunk) => { this.push(chunk); });
  }
  spawnFfmpeg() {
    const args = "-i pipe:3 -re -i pipe:4 -vn -fflags nobuffer -filter_complex amix=inputs=2:duration=longest pipe:1".split(" ");
    return spawn(this.ffmpegPath, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"]
    });
  }
  findOpenNode() {
    if (this.streamTree.length === 0) {
      this.streamTree.push({ process: this.ffmpeg, pipes: [4], available: true, children: [] });
      return this.streamTree[0];
    }
    const findChild = (node) => {
      if (node.available) return node;
      for (const child of node.children) {
        const c = findChild(child);
        if (c) return c;
      }
      return null;
    };
    for (const node of this.streamTree) {
      const firstChild = findChild(node);
      if (firstChild) return firstChild;
    }
    return null;
  }
  addStream(s) {
    if (!this.ffmpeg) this.setupBaseFfmpeg();
    const open = this.findOpenNode();
    if (!open) throw "Impossible case detected. No free merge node found.";
    const p = this.spawnFfmpeg();
    const node = { process: p, pipes: [4], available: true, parent: open, children: [] };
    open.children.push(node);
    s.pipe(p.stdio[3]);
    p.stderr.on("data", (c) => { logger.mediaplayer("[ffmpeg]", c.toString().trim()); });
    p.stdio[4].write(Buffer.alloc(1024, 0));
    p.stdout.pipe(open.process.stdio[open.pipes[0]]);
    const pipeNumber = open.pipes[0].valueOf();
    open.pipes.splice(0, 1);
    if (open.pipes.length === 0) open.available = false;
    p.on("exit", () => {
      open.pipes.push(pipeNumber);
      open.available = true;
      const idx = open.children.findIndex(c => c === node);
      if (idx === -1) throw "Impossible case detected. Damaged node structure.";
      open.children.splice(idx, 1);
    });
  }
}

export default StreamMerger;
