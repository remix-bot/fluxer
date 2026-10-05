/**
 * @module src/voice/gateway/RejoinBackoff
 * @description Per-channel failure memory for 24/7 rejoin attempts.
 *
 * The 24/7 watchdog sweeps every minute and re-arms a rejoin for every saved channel that has
 * no live player. For a channel that can never be joined (the bot lost the Connect permission,
 * the channel is full or locked) that meant a join attempt - three of them, with retries - every
 * minute, forever. This keeps a small escalating cool-down per channel: after each failed attempt
 * cycle the watchdog skips the channel for 2, 4, 8, 16, 32 minutes, then once an hour. Any
 * successful join clears the entry. Event-driven rejoins (the bot was just disconnected) are
 * deliberately NOT throttled by this.
 */
export class RejoinBackoff {
  /**
   * @param {object} [o]
   * @param {number} [o.baseMs=120000] - Cool-down after the first failed attempt cycle (doubles each time).
   * @param {number} [o.maxMs=3600000] - Upper bound for the cool-down.
   * @param {number} [o.maxEntries=5000] - Safety cap on remembered channels (oldest evicted first).
   * @param {() => number} [o.now] - Clock (injectable for tests).
   */
  constructor({ baseMs = 120_000, maxMs = 3_600_000, maxEntries = 5_000, now = Date.now } = {}) {
    this.baseMs = baseMs;
    this.maxMs = maxMs;
    this.maxEntries = maxEntries;
    this.now = now;
    /** @type {Map<string, {failures: number, nextAt: number}>} */
    this._entries = new Map();
  }

  /**
   * Record a failed attempt cycle for a channel.
   * @param {string} channelId
   * @returns {{failures: number, delayMs: number}} The new failure count and the cool-down applied.
   */
  recordFailure(channelId) {
    const key = String(channelId);
    const failures = (this._entries.get(key)?.failures ?? 0) + 1;
    const delayMs = Math.min(this.maxMs, this.baseMs * 2 ** (failures - 1));
    this._entries.delete(key);
    this._entries.set(key, { failures, nextAt: this.now() + delayMs });
    while (this._entries.size > this.maxEntries) this._entries.delete(this._entries.keys().next().value);
    return { failures, delayMs };
  }

  /** Forget a channel (a join succeeded, or the channel is no longer relevant). */
  recordSuccess(channelId) {
    this._entries.delete(String(channelId));
  }

  /** @returns {number} Milliseconds until the watchdog may try this channel again (0 = go ahead). */
  remainingMs(channelId) {
    const e = this._entries.get(String(channelId));
    return e ? Math.max(0, e.nextAt - this.now()) : 0;
  }

  /** @returns {number} Consecutive failed attempt cycles recorded for the channel. */
  failures(channelId) {
    return this._entries.get(String(channelId))?.failures ?? 0;
  }

  get size() { return this._entries.size; }
}

export default RejoinBackoff;
