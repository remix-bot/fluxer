/** @module src/music/audio/StreamPositioner @description
 * FFmpeg-free stream positioning ("seek") for the trackstream pipeline.
 *
 * A Transform stream that consumes a WebM/Opus or Ogg/Opus byte stream and
 * re-emits it starting as close as possible to a target timestamp — by
 * dropping leading EBML clusters (WebM) or Ogg pages (Ogg) whose packets all
 * end before the target. Nothing is decoded or re-encoded: the byte layout
 * stays a valid WebM/Ogg stream, so @fluxerjs/voice's demuxer (prism-media)
 * consumes the output exactly like an unmodified stream.
 *
 * Precision: WebM ≈ one Opus block (20 ms) — blocks before the target inside
 * the first kept cluster are trimmed individually. Ogg ≈ one page (20–60 ms),
 * with the two most recently dropped pages re-emitted ahead of the first kept
 * page so packets that span page boundaries stay intact.
 *
 * Used by {@link module:src/music/audio/StreamPipeline} when a seek is
 * requested while the legacy /v4/loadstream route is disabled.
 */

import { Transform } from "node:stream";

/** @type {Buffer} @description WebM/Matroska EBML magic bytes. */
const WEBM_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

/** @type {Buffer} @description Ogg container magic ("OggS"). */
const OGG_MAGIC = Buffer.from("OggS", "ascii");

/** @type {Buffer} @description Matroska Cluster element ID (0x1F43B675). */
const ID_CLUSTER = Buffer.from("1f43b675", "hex");

/** @type {Buffer} @description Matroska SimpleBlock element ID (0xA3). */
const ID_SIMPLEBLOCK = Buffer.from("a3", "hex");

/** @type {Buffer} @description Matroska Cluster Timecode element ID (0xE7). */
const ID_TIMECODE = Buffer.from("e7", "hex");

/** @type {number} @description Hard cap for buffering one known-size cluster before falling back to pass-through. */
const MAX_KNOWN_CLUSTER_BYTES = 8 * 1024 * 1024;

/** @type {number} @description Hard cap for buffering an unknown-size cluster's decided prefix. */
const MAX_UNKNOWN_CLUSTER_BYTES = 4 * 1024 * 1024;

/** @type {number} @description Hard cap for buffering one Ogg page. */
const MAX_OGG_PAGE_BYTES = 4 * 1024 * 1024;

/** @type {number} @description Ogg pages kept back and replayed before the first kept page (packet-continuation safety). */
const OGG_REPLAY_PAGES = 2;

/** @type {number} @description Opus sample rate — Ogg granule positions are 48 kHz sample counts. */
const OPUS_SAMPLE_RATE = 48;

/**
 * Encode a Matroska variable-length size integer (finite size).
 * Same layout as WebMOpusMuxer's encoder — needed to rebuild a Cluster
 * header after trimming leading blocks.
 * @param {number} value - Size to encode (must be >= 0).
 * @returns {Buffer}
 */
function encodeSizeVint(value) {
  if (value <= 127) {
    const buf = Buffer.allocUnsafe(1);
    buf[0] = value | 0x80;
    return buf;
  }
  if (value <= 16383) {
    const buf = Buffer.allocUnsafe(2);
    buf[0] = ((value >> 8) & 0xff) | 0x40;
    buf[1] = value & 0xff;
    return buf;
  }
  if (value <= 2097151) {
    const buf = Buffer.allocUnsafe(3);
    buf[0] = ((value >> 16) & 0xff) | 0x20;
    buf[1] = (value >> 8) & 0xff;
    buf[2] = value & 0xff;
    return buf;
  }
  let length = 4;
  while (value > 2 ** (7 * length) - 1 && length < 8) length++;
  const buf = Buffer.alloc(length);
  for (let i = length - 1; i >= 0; i--) {
    buf[i] = value & 0xff;
    value = Math.floor(value / 256);
  }
  buf[0] |= 1 << (8 - length);
  return buf;
}

/**
 * Read an EBML variable-length integer.
 * @param {Buffer} buf - Buffer to read from.
 * @param {number} off - Byte offset.
 * @param {boolean} keepMarker - true for element IDs (keep VINT_MARKER bit),
 *   false for sizes (strip it).
 * @returns {{value: number, length: number, unknown: boolean}|null} Parsed
 *   vint, or null when more bytes are needed.
 */
function readVint(buf, off, keepMarker) {
  const b0 = buf[off];
  if (b0 === undefined) return null;
  let len = 0;
  for (let i = 0; i < 8; i++) {
    if ((b0 >> (7 - i)) & 1) { len = i + 1; break; }
  }
  if (len === 0 || off + len > buf.length) return null;
  let value = keepMarker ? b0 : b0 & ((1 << (8 - len)) - 1);
  // Unknown = all VALUE bits set (first byte's value portion + rest 0xFF),
  // e.g. Matroska streaming size "01 FF FF FF FF FF FF FF".
  let unknown = !keepMarker && (b0 & ((1 << (8 - len)) - 1)) === ((1 << (8 - len)) - 1);
  for (let i = 1; i < len; i++) {
    if (buf[off + i] !== 0xff) unknown = false;
    value = value * 256 + buf[off + i];
  }
  return { value, length: len, unknown };
}

/**
 * Compare an EBML ID read from `buf` against a known ID constant.
 * @param {Buffer} buf - Buffer containing the ID bytes.
 * @param {number} off - Offset of the ID.
 * @param {number} len - ID length.
 * @param {Buffer} id - Known ID constant.
 * @returns {boolean}
 */
function idEquals(buf, off, len, id) {
  if (len !== id.length) return false;
  for (let i = 0; i < len; i++) {
    if (buf[off + i] !== id[i]) return false;
  }
  return true;
}

/**
 * Streaming WebM/Ogg positioner.
 * @extends {Transform}
 */
export class StreamPositioner extends Transform {
  /**
   * @param {object} [options]
   * @param {"webm"|"ogg"} [options.kind="webm"] - Container kind (magic-byte sniffed upstream).
   * @param {number} [options.seekMs=0] - Target position in milliseconds. <= 0 → pure pass-through.
   */
  constructor(options = {}) {
    super();
    this._kind = options.kind === "ogg" ? "ogg" : "webm";
    this._targetMs = Math.max(0, Math.floor(options.seekMs ?? 0));

    this._buf = Buffer.alloc(0);
    this._done = this._targetMs <= 0; // nothing to drop → pass everything through

    // WebM state
    this._state = "scan"; // scan | pass | cluster | clusterUnknown | passthrough
    this._passRemaining = 0;
    this._returnState = null; // state to resume after a "drop" finishes
    this._clusterSize = 0;
    this._clusterTc = 0;

    // Ogg state
    this._oggPagesKept = 0;
    this._oggReplay = []; // last dropped pages, replayed before the first kept page
  }

  /** @param {Buffer} chunk @param {string} _enc @param {Function} cb @protected */
  _transform(chunk, _enc, cb) {
    try {
      if (this._done) {
        this.push(chunk);
        return cb();
      }
      if (this._kind === "ogg") this._feedOgg(chunk);
      else this._feedWebm(chunk);
      cb();
    } catch (err) {
      cb(err);
    }
  }

  /** @param {Function} cb @protected */
  _flush(cb) {
    // A truncated header-only stream (target past EOF) is still valid output.
    cb();
  }

  /** Enter permanent pass-through mode and flush any pending bytes. @private */
  _startPassthrough(pending) {
    this._done = true;
    this._state = "passthrough";
    if (pending && pending.length) this.push(pending);
    if (this._buf.length) {
      this.push(this._buf);
      this._buf = Buffer.alloc(0);
    }
  }

  // ─── WebM ─────────────────────────────────────────────────────────────────

  /** Feed one chunk into the WebM state machine. @private */
  _feedWebm(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;

    for (;;) {
      if (this._state === "scan") {
        const id = readVint(this._buf, 0, true);
        if (!id) return;
        const size = readVint(this._buf, id.length, false);
        if (!size) return;
        const headerLen = id.length + size.length;

        if (idEquals(this._buf, 0, id.length, ID_CLUSTER)) {
          if (size.unknown) {
            this._state = "clusterUnknown";
            this._clusterTc = null;
            this._unknownPrefix = Buffer.from(this._buf.subarray(0, headerLen));
            this._consume(headerLen);
            continue;
          }
          if (size.value > MAX_KNOWN_CLUSTER_BYTES) {
            // Abnormally large cluster — do not buffer; keep from here on.
            this._startPassthrough();
            return;
          }
          if (this._buf.length < headerLen + size.value) return; // wait for full cluster
          this._clusterSize = size.value;
          this._handleKnownCluster(headerLen);
          continue;
        }

        // Non-cluster element: pass ID + size through, then its payload.
        this.push(Buffer.from(this._buf.subarray(0, headerLen)));
        this._consume(headerLen);
        if (!size.unknown) {
          this._passRemaining = size.value;
          this._state = "pass";
          continue; // pass loop drains below / on next chunks
        }
        // Unknown-size container (e.g. Segment): keep scanning its children.
        continue;
      }

      if (this._state === "pass") {
        if (this._buf.length === 0) return;
        const n = Math.min(this._passRemaining, this._buf.length);
        this.push(Buffer.from(this._buf.subarray(0, n)));
        this._consume(n);
        this._passRemaining -= n;
        if (this._passRemaining === 0) this._state = "scan";
        if (this._buf.length === 0) return;
        continue;
      }

      if (this._state === "clusterUnknown") {
        if (!this._scanUnknownClusterChildren()) return;
        continue;
      }

      if (this._state === "drop") {
        if (this._buf.length === 0) return;
        const n = Math.min(this._passRemaining, this._buf.length);
        this._consume(n);
        this._passRemaining -= n;
        if (this._passRemaining === 0) this._state = this._returnState ?? "scan";
        continue;
      }

      return; // passthrough / cluster handled elsewhere
    }
  }

  /**
   * Process one fully buffered known-size cluster: drop it when every packet
   * ends before the target; otherwise emit its header + surviving blocks and
   * switch to permanent pass-through.
   * @param {number} headerLen - Bytes of the Cluster ID + size vint at buffer start.
   * @private
   */
  _handleKnownCluster(headerLen) {
    const cluster = this._buf.subarray(0, headerLen + this._clusterSize);

    // Parse children: Timecode (E7) then SimpleBlocks (A3). Anything else → keep whole cluster.
    let pos = headerLen;
    let tc = null;
    let firstKeptOffset = -1; // offset of first block child whose abs time >= target
    let firstBlockRegionStart = -1; // offset where block children begin (end of Timecode element)
    let conservative = false;

    while (pos < cluster.length) {
      const id = readVint(cluster, pos, true);
      if (!id) { conservative = true; break; }
      const size = readVint(cluster, pos + id.length, false);
      if (!size || size.unknown) { conservative = true; break; }
      const childStart = pos;
      const payloadOff = pos + id.length + size.length;
      const nextPos = payloadOff + size.value;
      if (nextPos > cluster.length) { conservative = true; break; }

      if (idEquals(cluster, pos, id.length, ID_TIMECODE)) {
        tc = 0;
        for (let i = 0; i < size.value && i < 6; i++) tc = tc * 256 + cluster[payloadOff + i];
        if (firstBlockRegionStart === -1) firstBlockRegionStart = nextPos;
      } else if (idEquals(cluster, pos, id.length, ID_SIMPLEBLOCK)) {
        const rel = this._simpleBlockRelTime(cluster, payloadOff, size.value);
        if (rel === null) { conservative = true; break; }
        const abs = (tc ?? 0) + rel;
        if (abs >= this._targetMs && firstKeptOffset === -1) {
          firstKeptOffset = childStart;
          break; // every later block is >= target too (blocks are time-ordered)
        }
      } else {
        conservative = true;
        break;
      }
      pos = nextPos;
    }

    if (conservative || firstBlockRegionStart === -1) {
      // Unparsed structure — keep the whole cluster to stay safe.
      this._consume(cluster.length);
      this._startPassthrough(Buffer.from(cluster));
      return;
    }

    if (firstKeptOffset === -1) {
      // Whole cluster ends before the target → drop it.
      this._consume(cluster.length);
      return;
    }

    // Emit: cluster header (+ Timecode) then from the first surviving block on.
    const skipped = firstKeptOffset - firstBlockRegionStart;
    this._consume(firstKeptOffset); // buffer now starts at the surviving block
    if (skipped > 0) {
      // Blocks were trimmed — the original size vint would now overstate the
      // payload and desync the demuxer. Rebuild the header with the real size.
      const keptPayload =
          (firstBlockRegionStart - headerLen) + (cluster.length - firstKeptOffset);
      this.push(Buffer.concat([
        ID_CLUSTER,
        encodeSizeVint(keptPayload),
        Buffer.from(cluster.subarray(headerLen, firstBlockRegionStart)),
        Buffer.from(cluster.subarray(firstKeptOffset)),
      ]));
      this._consume(cluster.length - firstKeptOffset);
    } else {
      this.push(Buffer.from(cluster));
      this._consume(cluster.length);
    }
    this._startPassthrough();
  }

  /**
   * Stream children of an unknown-size cluster, dropping SimpleBlocks before
   * the target and emitting the saved header + first surviving block.
   * @returns {boolean} true when the state machine can make progress with the
   *   current buffer; false when more bytes are needed.
   * @private
   */
  _scanUnknownClusterChildren() {
    const id = readVint(this._buf, 0, true);
    if (!id) return false;
    const size = readVint(this._buf, id.length, false);
    if (!size) return false;
    const headerLen = id.length + size.length;

    if (idEquals(this._buf, 0, id.length, ID_TIMECODE)) {
      if (size.unknown) { this._startPassthrough(this._unknownPrefix); return false; }
      if (this._buf.length < headerLen + size.value) return false;
      let tc = 0;
      for (let i = 0; i < size.value && i < 6; i++) tc = tc * 256 + this._buf[headerLen + i];
      this._clusterTc = tc;
      this._unknownPrefix = Buffer.concat([this._unknownPrefix, Buffer.from(this._buf.subarray(0, headerLen + size.value))]);
      this._consume(headerLen + size.value);
      return true;
    }

    if (idEquals(this._buf, 0, id.length, ID_SIMPLEBLOCK) && !size.unknown) {
      // Wait until enough of the payload is buffered to read the rel timestamp.
      if (this._buf.length < headerLen + Math.min(size.value, 6)) return false;
      const rel = this._simpleBlockRelTime(this._buf, headerLen, size.value);
      if (rel !== null) {
        const abs = (this._clusterTc ?? 0) + rel;
        if (abs >= this._targetMs) {
          // First surviving block: emit saved header + Timecode + this block's
          // header, then pass everything (payload included) through.
          const childHeader = Buffer.from(this._buf.subarray(0, headerLen));
          this._consume(headerLen); // buffer now starts at the block payload
          this._startPassthrough(Buffer.concat([this._unknownPrefix, childHeader]));
          return true;
        }
        if (this._unknownPrefix.length > MAX_UNKNOWN_CLUSTER_BYTES) {
          this._startPassthrough();
          return false;
        }
        if (this._buf.length < headerLen + size.value) {
          // Block payload spans chunks — drop what is here, discard the rest
          // of the payload in "drop" state as it arrives.
          const avail = this._buf.length;
          this._passRemaining = size.value - (avail - headerLen);
          this._consume(avail);
          this._state = "drop";
          this._returnState = "clusterUnknown"; // still inside the cluster
          return true;
        }
        this._consume(headerLen + size.value);
        return true;
      }
    }

    // Any other child (BlockGroup, ...) → keep from here on.
    const childHeader = Buffer.from(this._buf.subarray(0, headerLen));
    this._consume(headerLen);
    this._startPassthrough(Buffer.concat([this._unknownPrefix, childHeader]));
    return true;
  }

  /**
   * Extract the signed 16-bit cluster-relative timestamp from a SimpleBlock payload.
   * @param {Buffer} buf - Buffer holding the payload at `off`.
   * @param {number} off - Payload start offset.
   * @param {number} size - Payload size.
   * @returns {number|null} Relative ms, or null when it cannot be read safely.
   * @private
   */
  _simpleBlockRelTime(buf, off, size) {
    if (size < 4) return null;
    const tb = readVint(buf, off, true);
    if (!tb || tb.length > 2) return null;
    if (off + tb.length + 2 > buf.length) return null;
    return buf.readInt16BE(off + tb.length);
  }

  // ─── Ogg ──────────────────────────────────────────────────────────────────

  /** Feed one chunk into the Ogg state machine. @private */
  _feedOgg(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;

    for (;;) {
      if (this._buf.length < OGG_MAGIC.length) return; // need more bytes
      if (!this._startsWith(OGG_MAGIC)) {
        // Not a page boundary at buffer start — corrupt/resync: pass through.
        this._startPassthrough();
        return;
      }
      if (this._buf.length < 27) return;
      const segCount = this._buf[26];
      const headerLen = 27 + segCount;
      if (this._buf.length < headerLen) return;
      let payload = 0;
      for (let i = 0; i < segCount; i++) payload += this._buf[27 + i];
      const pageLen = headerLen + payload;
      if (pageLen > MAX_OGG_PAGE_BYTES) { this._startPassthrough(); return; }
      if (this._buf.length < pageLen) return;

      const granule = Number(this._buf.readBigUInt64LE(6));
      const page = Buffer.from(this._buf.subarray(0, pageLen));
      this._consume(pageLen);

      if (this._oggPagesKept < 2) {
        // OpusHead (BOS) + OpusTags pages must survive for the demuxer.
        this._oggPagesKept++;
        this.push(page);
        continue;
      }

      const isFiller = granule === -1n || granule === 0xffffffffffffffffn;
      if (!isFiller && granule >= this._targetMs * OPUS_SAMPLE_RATE) {
        for (const p of this._oggReplay) this.push(p);
        this._oggReplay = [];
        this._startPassthrough(page);
        return;
      }

      // Page ends before the target → drop, but remember recent ones so
      // packets spanning into the kept page stay complete.
      this._oggReplay.push(page);
      while (this._oggReplay.length > OGG_REPLAY_PAGES) this._oggReplay.shift();
    }
  }

  /**
   * @param {Buffer} magic
   * @returns {boolean}
   * @private
   */
  _startsWith(magic) {
    if (this._buf.length < magic.length) return false;
    return this._buf.subarray(0, magic.length).equals(magic);
  }

  /**
   * Drop `n` consumed bytes from the internal buffer.
   * @param {number} n
   * @private
   */
  _consume(n) {
    if (n <= 0) return;
    if (n >= this._buf.length) {
      this._buf = Buffer.alloc(0);
      return;
    }
    this._buf = Buffer.from(this._buf.subarray(n));
  }

  /** Validate magic bytes once on the first chunk. @internal */
  static sniffKind(head) {
    if (head.length >= 4 && head.subarray(0, 4).equals(WEBM_MAGIC)) return "webm";
    if (head.length >= 4 && head.subarray(0, 4).equals(OGG_MAGIC)) return "ogg";
    return null;
  }
}

export default StreamPositioner;
