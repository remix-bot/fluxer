/**
 * @module src/music/player/Queue
 * @description Queue data structure: track list, loop modes (song/queue),
 * add/remove/move/shuffle/pagination, and queue events.
 */

import { EventEmitter } from "node:events";
import { Utils } from "../../utils/Utils.mjs";

/**
 * @class Queue
 * @description Internal queue data structure that tracks tracks, loop state,
 * and emits queue events.
 * @extends {EventEmitter}
 *
 * Events (all emitted as `"queue"` with `{ type, data }`):
 * - `update` — the current track advanced
 * - `remove` / `move` / `add` / `addMany` / `shuffle`
 */
export class Queue extends EventEmitter {
  /** @type {Array<object>} The queued track objects. */
  data = [];
  /** @type {object|null} The currently playing track. */
  current = null;
  /** @type {boolean} Whether queue loop is enabled. */
  loop = false;
  /** @type {boolean} Whether single-song loop is enabled. */
  songLoop = false;

  /** Initialize an empty queue with no loop enabled. */
  constructor() {
    super();
  }

  /** @returns {boolean} Whether the queue has no tracks. */
  isEmpty() { return this.data.length === 0; }
  /** @returns {number} Number of tracks in the queue (excluding current). */
  size()    { return this.data.length; }

  /**
   * Advance to the next track in the queue. If songLoop is active, returns
   * the current track. If queue loop is active, re-appends the current track.
   * @returns {object|null} The next track, or null if the queue is empty.
   */
  next() {
    const previous = this.current;

    if (this.songLoop && this.current) return this.current;
    if (this.loop && this.current) this.data.push(this.current);

    if (this.isEmpty()) {
      this.current = null;
      return null;
    }

    this.current = this.data.shift();
    this.emit("queue", {
      type: "update",
      data: { current: this.current, old: previous, loop: this.loop }
    });
    return this.current;
  }

  /**
   * Remove a track from the queue by index.
   * @param {number} idx - Zero-based index of the track to remove.
   * @returns {string} Result message indicating success or out-of-bounds error.
   */
  remove(idx) {
    if (idx < 0 || idx >= this.data.length) return "Index out of bounds";
    const title = this.data[idx].title;
    const removed = this.data.splice(idx, 1);
    this.emit("queue", { type: "remove", data: { index: idx, old: this.data.slice(), removed, new: this.data } });
    return `Successfully removed **${title}** from the queue.`;
  }

  /**
   * Move a track from one position to another (0-based indices).
   * @param {number} from - Source index.
   * @param {number} to - Destination index.
   * @returns {string} Result message indicating success or error.
   */
  move(from, to) {
    if (from < 0 || from >= this.data.length) return "Source index out of bounds";
    if (to < 0 || to >= this.data.length)     return "Target index out of bounds";
    if (from === to)                            return "Track is already in that position";
    const [track] = this.data.splice(from, 1);
    this.data.splice(to, 0, track);
    this.emit("queue", { type: "move", data: { from, to, track } });
    return `Moved **${track.title}** from position ${from + 1} to ${to + 1}.`;
  }

  /**
   * Add a single track to the queue.
   * @param {object} data - Track data object.
   * @param {boolean} [top=false] - If true, insert at the front of the queue.
   * @returns {number} The new length of the queue.
   */
  add(data, top = false) {
    this.emit("queue", { type: "add", data: { append: !top, data } });
    return top ? this.data.unshift(data) : this.data.push(data);
  }

  /**
   * Add multiple tracks to the queue (up to 1000).
   * @param {Array<object>} tracks - Array of track data objects.
   * @param {boolean} [top=false] - If true, insert at the front of the queue.
   * @returns {number} Number of tracks actually added.
   */
  addMany(tracks, top = false) {
    if (!tracks?.length) return 0;
    if (!Array.isArray(tracks)) tracks = [];
    const count = Math.min(tracks.length, 1000);
    if (top) {
      for (let i = count - 1; i >= 0; i--) this.data.unshift(tracks[i]);
    } else {
      for (let i = 0; i < count; i++) this.data.push(tracks[i]);
    }
    this.emit("queue", { type: "addMany", data: { append: !top, tracks: tracks.slice(0, count) } });
    return count;
  }

  /** Remove all tracks from the queue. */
  clear() { this.data.length = 0; }
  /** Clear the queue and reset all state (current, loops). */
  reset() { this.clear(); this.current = null; this.songLoop = false; this.loop = false; }

  /** @param {boolean} bool - Enable or disable song loop. */
  setSongLoop(bool) { this.songLoop = bool; }
  /** @param {boolean} bool - Enable or disable queue loop. */
  setLoop(bool)     { this.loop = bool; }

  /**
   * Toggle a loop mode on or off.
   * @param {"song"|"queue"} loop - The type of loop to toggle.
   * @returns {boolean|null} The new loop state, or null if the loop type is invalid.
   */
  toggleLoop(loop) {
    if (loop === "song")  { this.setSongLoop(!this.songLoop); return this.songLoop; }
    if (loop === "queue") { this.setLoop(!this.loop);         return this.loop; }
    return null;
  }

  /** Shuffle the queue in place and emit a queue event. */
  shuffle() {
    Utils.shuffleArr(this.data);
    this.emit("queue", { type: "shuffle", data: this.data });
  }

  /** @returns {object|null} The currently playing track. */
  getCurrent() { return this.current; }
  /** @returns {Array<object>} A copy of the queue array. */
  getQueue()   { return this.data; }

  /**
   * Get a paginated slice of the queue.
   * @param {number} [page=1] - 1-based page number (clamped to valid range).
   * @param {number} [pageSize=10] - Number of tracks per page.
   * @returns {object} Page result with items, page, totalPages, total, start.
   */
  getPage(page = 1, pageSize = 10) {
    const total      = this.data.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage   = Utils.clamp(page, 1, totalPages);
    const start      = (safePage - 1) * pageSize;
    return { items: this.data.slice(start, start + pageSize), page: safePage, totalPages, total, start };
  }
}
