/** @module src/constants/audio/WebMOpusMuxer @description Minimal streaming WebM/Matroska muxer for Opus packets. Produces streams consumable by prism-media's WebmDemuxer (what @fluxerjs/voice uses internally) — no FFmpeg required. */

import { Transform } from "node:stream";

/** @type {number} @description Opus frame duration in milliseconds (20ms = 960 samples @ 48kHz). */
export const OPUS_FRAME_MS = 20;

/** @type {number} @description Blocks per cluster before a new Cluster element is started. */
const BLOCKS_PER_CLUSTER = 250;

/** @type {number} @description Force a cluster flush when buffered blocks exceed this size. */
const CLUSTER_FLUSH_BYTES = 64 * 1024;

/**
 * Encode a Matroska variable-length size integer (finite size).
 * @param {number} value - Size to encode (must be >= 0).
 * @returns {Buffer}
 */
function encodeSizeVint(value) {
  let length = 1;
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
 * Build a single EBML element from an ID hex string and a payload Buffer.
 * @param {string} idHex - EBML element ID as hex (e.g. "1a45dfa3").
 * @param {Buffer} payload
 * @returns {Buffer}
 */
function element(idHex, payload) {
  return Buffer.concat([Buffer.from(idHex, "hex"), encodeSizeVint(payload.length), payload]);
}

/**
 * Encode an unsigned integer EBML payload using minimal bytes.
 * @param {number} value
 * @returns {Buffer}
 */
function uintPayload(value) {
  let bytes = 1;
  while (value >= 2 ** (8 * bytes)) bytes++;
  const buf = Buffer.alloc(bytes);
  buf.writeUIntBE(value, 0, bytes);
  return buf;
}

/**
 * Build the OpusHead codec private data (Matroska-embedded OpusHead).
 * @param {number} sampleRate - Input sample rate (48000).
 * @param {number} channels - Channel count (2).
 * @returns {Buffer}
 */
export function buildOpusHead(sampleRate, channels) {
  const buf = Buffer.alloc(19);
  buf.write("OpusHead", 0, "ascii");
  buf.writeUInt8(1, 8);          // version
  buf.writeUInt8(channels, 9);
  buf.writeUInt16LE(0, 10);      // pre-skip (we encode ourselves; no trimming)
  buf.writeUInt32LE(sampleRate, 12);
  buf.writeInt16LE(0, 16);       // output gain
  buf.writeUInt8(0, 18);         // mapping family (mono/stereo)
  return buf;
}

/**
 * Build the WebM stream header: EBML + Segment start + Info + Tracks.
 * The Segment element uses an unknown (streaming) size so clusters can be
 * appended indefinitely.
 * @param {number} sampleRate
 * @param {number} channels
 * @returns {Buffer}
 */
function buildHeader(sampleRate, channels) {
  const ebml = element("1a45dfa3", Buffer.concat([
    element("4286", uintPayload(1)),                      // EBMLVersion
    element("42f7", uintPayload(1)),                      // EBMLReadVersion
    element("42f2", uintPayload(4)),                      // EBMLMaxIDLength
    element("42f3", uintPayload(8)),                      // EBMLMaxSizeLength
    element("4282", Buffer.from("webm", "ascii")),        // DocType
    element("4287", uintPayload(2)),                      // DocTypeVersion
    element("4285", uintPayload(2)),                      // DocTypeReadVersion
  ]));

  const info = element("1549a966", Buffer.concat([
    element("2ad7b1", uintPayload(1000000)),              // TimecodeScale (1ms)
    element("4d80", Buffer.from("fluxer-remix", "ascii")),// MuxingApp
    element("5741", Buffer.from("fluxer-remix", "ascii")),// WritingApp
  ]));

  const floatBuf = Buffer.alloc(4);
  floatBuf.writeFloatBE(sampleRate, 0);
  const audio = element("e1", Buffer.concat([
    element("b5", floatBuf),                               // SamplingFrequency
    element("9f", uintPayload(channels)),                  // Channels
  ]));

  const trackEntry = element("ae", Buffer.concat([
    element("d7", uintPayload(1)),                         // TrackNumber (must be 1 — demuxer masks data[0] & 0xF)
    element("73c5", uintPayload(1)),                       // TrackUID
    element("83", uintPayload(2)),                         // TrackType: audio
    element("86", Buffer.from("A_OPUS", "ascii")),         // CodecID
    element("63a2", buildOpusHead(sampleRate, channels)),  // CodecPrivate: OpusHead
    audio,
  ]));
  const tracks = element("1654ae6b", trackEntry);

  // Streaming Segment size: a huge finite vint (0x01 + 7x0xFF = 2^56-1). The
  // canonical all-0xFF unknown-size marker is misparsed by prism-media's
  // vintLength (it reads 0xFF as a 1-byte vint), so we use this equivalent form.
  const segmentStart = Buffer.concat([
    Buffer.from("18538067", "hex"),
    Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
  ]);

  return Buffer.concat([ebml, segmentStart, info, tracks]);
}

/**
 * Build a SimpleBlock element for one Opus packet.
 * @param {Buffer} packet - Raw Opus packet.
 * @param {number} relTimeMs - Cluster-relative timestamp in ms.
 * @returns {Buffer}
 */
function buildSimpleBlock(packet, relTimeMs) {
  const clamped = Math.max(-32768, Math.min(32767, relTimeMs));
  const header = Buffer.from([0x81, (clamped >> 8) & 0xff, clamped & 0xff, 0x80]);
  return element("a3", Buffer.concat([header, packet]));
}

/**
 * Streaming WebM muxer: consumes Opus packets (object mode) and emits a
 * WebM/Opus byte stream compatible with prism-media's WebmDemuxer — the exact
 * format @fluxerjs/voice's VoiceConnection.play() expects as input.
 * @extends {Transform}
 */
export class WebMOpusMuxer extends Transform {
  /**
   * @param {object} [options]
   * @param {number} [options.sampleRate=48000]
   * @param {number} [options.channels=2]
   */
  constructor(options = {}) {
    super({ writableObjectMode: true });
    this._sampleRate = options.sampleRate ?? 48000;
    this._channels = options.channels ?? 2;
    this._header = buildHeader(this._sampleRate, this._channels);
    this._blocks = [];
    this._blocksBytes = 0;
    this._blockIndex = 0;
    this._clusterIndex = 0;
    this._headerSent = false;
  }

  /**
   * Feed one Opus packet into the current cluster.
   * @param {Buffer} packet
   */
  _addBlock(packet) {
    if (!this._headerSent) {
      this.push(this._header);
      this._headerSent = true;
    }
    const relTime = (this._blockIndex % BLOCKS_PER_CLUSTER) * OPUS_FRAME_MS;
    const block = buildSimpleBlock(packet, relTime);
    this._blocks.push(block);
    this._blocksBytes += block.length;
    this._blockIndex++;
    if (this._blocks.length >= BLOCKS_PER_CLUSTER || this._blocksBytes >= CLUSTER_FLUSH_BYTES) {
      this._flushCluster();
    }
  }

  /** Emit the current cluster as a complete EBML element. */
  _flushCluster() {
    if (this._blocks.length === 0) return;
    const timecode = element("e7", uintPayload(this._clusterIndex * BLOCKS_PER_CLUSTER * OPUS_FRAME_MS));
    const cluster = element("1f43b675", Buffer.concat([timecode, ...this._blocks]));
    this._blocks = [];
    this._blocksBytes = 0;
    this._clusterIndex++;
    this.push(cluster);
  }

  /**
   * @param {Buffer} packet
   * @param {string} _encoding
   * @param {Function} callback
   * @protected
   */
  _transform(packet, _encoding, callback) {
    try {
      if (Buffer.isBuffer(packet) && packet.length > 0) {
        this._addBlock(packet);
      }
      callback();
    } catch (err) {
      callback(err);
    }
  }

  /**
   * @param {Function} callback
   * @protected
   */
  _final(callback) {
    try {
      this._flushCluster();
      callback();
    } catch (err) {
      callback(err);
    }
  }
}
