/**
 * VoiceStateCache — O(1) voice-state lookups with bounded memory.
 *
 * Replaces the raw `observedVoiceUsers` / `observedVoiceBots` Maps with a
 * composite-keyed, indexed, LRU-evicted cache that supports:
 *
 *   • O(1) lookup:  "is anyone in channel X?"   → channelMembers.get(guildId, channelId)
 *   • O(1) lookup:  "what channel is user X in?" → userLocations.get(guildId, userId)
 *   • O(1) lookup:  "how many humans in channel X?" → channelMembers.get(...).size
 *   • Bounded memory via LRU eviction (default 50 000 entries)
 *   • Composite keys (guildId:userId) so multi-guild users don't overwrite
 *   • Single update function used by both raw WS and high-level handlers
 *
 * Data structures:
 *   userLocations   — Map<"guildId:userId", {channelId, guildId, userId}>
 *   channelMembers  — Map<"guildId:channelId", Set<userId>>
 *   botLocations    — Map<"guildId:userId", {channelId, guildId, userId}>
 *   botChannelMembers — Map<"guildId:channelId", Set<userId>>
 *   _lruOrder       — String[]  (most-recently-updated keys, for eviction)
 */

import { logger } from "./Logger.mjs";

export class VoiceStateCache {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxUsers=50000]  Max human entries before LRU eviction
   * @param {number} [opts.maxBots=10000]   Max bot entries before LRU eviction
   */
  constructor(opts = {}) {
    /** @type {Map<string, {channelId, guildId, userId}>} keyed "guildId:userId" */
    this.userLocations = new Map();
    /** @type {Map<string, Set<string>>} keyed "guildId:channelId", values are userIds */
    this.channelMembers = new Map();

    /** @type {Map<string, {channelId, guildId, userId}>} keyed "guildId:userId" */
    this.botLocations = new Map();
    /** @type {Map<string, Set<string>>} keyed "guildId:channelId", values are userIds */
    this.botChannelMembers = new Map();

    this._maxUsers = opts.maxUsers ?? 50_000;
    this._maxBots  = opts.maxBots  ?? 10_000;
    /** @type {string[]} MRU-first list of user location keys */
    this._lruUserKeys = [];
    /** @type {string[]} MRU-first list of bot location keys */
    this._lruBotKeys = [];
  }

  /** Build composite key "guildId:userId" (both cleaned to digits only) */
  static userKey(guildId, userId) {
    return `${String(guildId ?? "").replace(/\D/g, "")}:${String(userId ?? "").replace(/\D/g, "")}`;
  }

  /** Build composite key "guildId:channelId" (both cleaned to digits only) */
  static channelKey(guildId, channelId) {
    return `${String(guildId ?? "").replace(/\D/g, "")}:${String(channelId ?? "").replace(/\D/g, "")}`;
  }

  /**
   * Update voice state for a user.
   *
   * @param {object} params
   * @param {string} params.guildId
   * @param {string} params.userId
   * @param {string|null} params.channelId  null = user left voice
   * @param {boolean} [params.isBot=false]
   */
  updateUser({ guildId, userId, channelId, isBot = false }) {
    const cleanGuild   = String(guildId ?? "").replace(/\D/g, "");
    const cleanUser    = String(userId ?? "").replace(/\D/g, "");
    const cleanChannel = channelId ? String(channelId).replace(/\D/g, "") : null;
    if (!cleanGuild || !cleanUser) return;

    const locations   = isBot ? this.botLocations   : this.userLocations;
    const channelIdx  = isBot ? this.botChannelMembers : this.channelMembers;
    const maxEntries  = isBot ? this._maxBots        : this._maxUsers;
    const lruKeys     = isBot ? this._lruBotKeys     : this._lruUserKeys;
    const uKey        = VoiceStateCache.userKey(cleanGuild, cleanUser);

    const prev = locations.get(uKey);
    if (prev) {
      const prevCKey = VoiceStateCache.channelKey(prev.guildId, prev.channelId);
      const prevSet  = channelIdx.get(prevCKey);
      if (prevSet) {
        prevSet.delete(cleanUser);
        if (prevSet.size === 0) channelIdx.delete(prevCKey);
      }
    }

    if (cleanChannel) {
      const cKey = VoiceStateCache.channelKey(cleanGuild, cleanChannel);
      let set = channelIdx.get(cKey);
      if (!set) { set = new Set(); channelIdx.set(cKey, set); }
      set.add(cleanUser);

      locations.delete(uKey);
      locations.set(uKey, { channelId: cleanChannel, guildId: cleanGuild, userId: cleanUser });

      const lruIdx = lruKeys.indexOf(uKey);
      if (lruIdx !== -1) lruKeys.splice(lruIdx, 1);
      lruKeys.push(uKey);

      while (locations.size > maxEntries) {
        let evicted = false;
        for (let i = 0; i < lruKeys.length; i++) {
          const evictKey = lruKeys[i];
          if (evictKey === uKey) continue;

          const evictEntry = locations.get(evictKey);
          if (evictEntry) {
            const evictCKey = VoiceStateCache.channelKey(evictEntry.guildId, evictEntry.channelId);
            const evictSet  = channelIdx.get(evictCKey);
            if (evictSet) {
              evictSet.delete(evictEntry.userId);
              if (evictSet.size === 0) channelIdx.delete(evictCKey);
            }
            locations.delete(evictKey);
          }
          lruKeys.splice(i, 1);
          evicted = true;
          break;
        }
        if (!evicted) break;
      }
    } else {
      locations.delete(uKey);
      const idx = lruKeys.indexOf(uKey);
      if (idx !== -1) lruKeys.splice(idx, 1);
    }
  }

  /**
   * Check if there are any human users in a specific channel.
   * O(1) via channelMembers index.
   *
   * @param {string} guildId
   * @param {string} channelId
   * @returns {boolean}
   */
  hasHumansInChannel(guildId, channelId) {
    const cKey = VoiceStateCache.channelKey(guildId, channelId);
    const set  = this.channelMembers.get(cKey);
    return set ? set.size > 0 : false;
  }

  /**
   * Get the number of human users in a specific channel.
   * O(1) via channelMembers index.
   *
   * @param {string} guildId
   * @param {string} channelId
   * @returns {number}
   */
  getHumanCount(guildId, channelId) {
    const cKey = VoiceStateCache.channelKey(guildId, channelId);
    const set  = this.channelMembers.get(cKey);
    return set ? set.size : 0;
  }

  /**
   * Get all human userIds in a specific channel.
   * O(1) lookup + Set iteration.
   *
   * @param {string} guildId
   * @param {string} channelId
   * @returns {string[]}
   */
  getHumansInChannel(guildId, channelId) {
    const cKey = VoiceStateCache.channelKey(guildId, channelId);
    const set  = this.channelMembers.get(cKey);
    return set ? [...set] : [];
  }

  /**
   * Get the channelId a human user is currently in (within a specific guild).
   * O(1) via userLocations index.
   *
   * @param {string} guildId
   * @param {string} userId
   * @returns {string|null}
   */
  getUserChannel(guildId, userId) {
    const uKey = VoiceStateCache.userKey(guildId, userId);
    const loc  = this.userLocations.get(uKey);
    return loc ? loc.channelId : null;
  }

  /**
   * Check if a human user is tracked in a specific guild.
   *
   * @param {string} guildId
   * @param {string} userId
   * @returns {boolean}
   */
  hasUser(guildId, userId) {
    return this.userLocations.has(VoiceStateCache.userKey(guildId, userId));
  }

  /**
   * Get user location info (channelId, guildId) for a human user.
   *
   * @param {string} guildId
   * @param {string} userId
   * @returns {{channelId: string, guildId: string, userId: string}|undefined}
   */
  getUserLocation(guildId, userId) {
    return this.userLocations.get(VoiceStateCache.userKey(guildId, userId));
  }

  /**
   * Seed a user into the cache (only if not already present).
   *
   * @param {string} guildId
   * @param {string} userId
   * @param {string} channelId
   * @param {boolean} [isBot=false]
   */
  seedUser(guildId, userId, channelId, isBot = false) {
    const uKey = VoiceStateCache.userKey(guildId, userId);
    const locations = isBot ? this.botLocations : this.userLocations;
    if (locations.has(uKey)) return;
    this.updateUser({ guildId, userId, channelId, isBot });
  }

  /**
   * Remove all entries for a specific guild (used on GuildDelete).
   *
   * @param {string} guildId
   */
  removeGuild(guildId) {
    const cleanGuild = String(guildId).replace(/\D/g, "");
    const prefix = cleanGuild + ":";

    for (const [uKey, loc] of this.userLocations) {
      if (uKey.startsWith(prefix)) {
        const cKey = VoiceStateCache.channelKey(loc.guildId, loc.channelId);
        const set  = this.channelMembers.get(cKey);
        if (set) { set.delete(loc.userId); if (set.size === 0) this.channelMembers.delete(cKey); }
        this.userLocations.delete(uKey);
      }
    }
    for (const [cKey, set] of this.channelMembers) {
      if (cKey.startsWith(prefix)) this.channelMembers.delete(cKey);
    }
    this._lruUserKeys = this._lruUserKeys.filter(k => !k.startsWith(prefix));

    for (const [uKey, loc] of this.botLocations) {
      if (uKey.startsWith(prefix)) {
        const cKey = VoiceStateCache.channelKey(loc.guildId, loc.channelId);
        const set  = this.botChannelMembers.get(cKey);
        if (set) { set.delete(loc.userId); if (set.size === 0) this.botChannelMembers.delete(cKey); }
        this.botLocations.delete(uKey);
      }
    }
    for (const [cKey, set] of this.botChannelMembers) {
      if (cKey.startsWith(prefix)) this.botChannelMembers.delete(cKey);
    }
    this._lruBotKeys = this._lruBotKeys.filter(k => !k.startsWith(prefix));
  }

  /**
   * Remove a specific channel's index entries (used when a player leaves).
   *
   * @param {string} guildId
   * @param {string} channelId
   */
  removeChannel(guildId, channelId) {
    const cKey = VoiceStateCache.channelKey(guildId, channelId);

    const humanSet = this.channelMembers.get(cKey);
    if (humanSet) {
      for (const userId of humanSet) {
        const uKey = VoiceStateCache.userKey(guildId, userId);
        const loc  = this.userLocations.get(uKey);
        if (loc && loc.channelId === String(channelId).replace(/\D/g, "")) {
          this.userLocations.delete(uKey);
        }
      }
      this.channelMembers.delete(cKey);
    }

    const botSet = this.botChannelMembers.get(cKey);
    if (botSet) {
      for (const userId of botSet) {
        const uKey = VoiceStateCache.userKey(guildId, userId);
        const loc  = this.botLocations.get(uKey);
        if (loc && loc.channelId === String(channelId).replace(/\D/g, "")) {
          this.botLocations.delete(uKey);
        }
      }
      this.botChannelMembers.delete(cKey);
    }
  }

  /**
   * Selectively remove entries for users whose IDs appear in a given set
   * (used during GuildCreate to purge stale entries being replaced).
   *
   * @param {string} guildId
   * @param {Set<string>} userIds  User IDs whose entries should be purged
   * @param {boolean} [botsOnly=false]  Only purge bot entries
   */
  purgeUsersInGuild(guildId, userIds, botsOnly = false) {
    const cleanGuild = String(guildId).replace(/\D/g, "");

    if (!botsOnly) {
      for (const userId of userIds) {
        const uKey = VoiceStateCache.userKey(cleanGuild, userId);
        const loc  = this.userLocations.get(uKey);
        if (loc) {
          const cKey = VoiceStateCache.channelKey(loc.guildId, loc.channelId);
          const set  = this.channelMembers.get(cKey);
          if (set) { set.delete(loc.userId); if (set.size === 0) this.channelMembers.delete(cKey); }
          this.userLocations.delete(uKey);
        }
      }
    }

    for (const userId of userIds) {
      const uKey = VoiceStateCache.userKey(cleanGuild, userId);
      const loc  = this.botLocations.get(uKey);
      if (loc) {
        const cKey = VoiceStateCache.channelKey(loc.guildId, loc.channelId);
        const set  = this.botChannelMembers.get(cKey);
        if (set) { set.delete(loc.userId); if (set.size === 0) this.botChannelMembers.delete(cKey); }
        this.botLocations.delete(uKey);
      }
    }
  }

  /**
   * Get the "observedVoiceUsers" size (human count).
   * Backward-compat with `this.observedVoiceUsers.size`
   */
  get observedVoiceUsersSize() { return this.userLocations.size; }

  /**
   * Get the "observedVoiceBots" size.
   * Backward-compat with `this.observedVoiceBots.size`
   */
  get observedVoiceBotsSize() { return this.botLocations.size; }

  /**
   * Iterate over all human user locations.
   * Yields [compositeKey, {channelId, guildId, userId}] — same shape as Map entries.
   * Backward-compat with `for (const [uid, info] of this.observedVoiceUsers)`.
   */
  *iterateHumanUsers() {
    for (const [uKey, loc] of this.userLocations) {
      yield [loc.userId, { channelId: loc.channelId, guildId: loc.guildId }];
    }
  }

  /**
   * Iterate over all bot user locations.
   * Yields [compositeKey, {channelId, guildId, userId}].
   * Backward-compat with `for (const [uid, info] of this.observedVoiceBots)`.
   */
  *iterateBotUsers() {
    for (const [uKey, loc] of this.botLocations) {
      yield [uKey, { channelId: loc.channelId, guildId: loc.guildId }];
    }
  }

  /**
   * Get a human user's location by userId and guildId.
   * If guildId is provided, uses O(1) composite key.
   * If guildId is null, falls back to O(n) scan (legacy compat).
   *
   * @param {string} userId
   * @param {string|null} [guildId=null]
   * @returns {{channelId: string, guildId: string}|undefined}
   */
  getHumanUser(userId, guildId = null) {
    if (guildId) {
      return this.userLocations.get(VoiceStateCache.userKey(guildId, userId));
    }
    const cleanUser = String(userId).replace(/\D/g, "");
    for (const [uKey, loc] of this.userLocations) {
      if (loc.userId === cleanUser) return { channelId: loc.channelId, guildId: loc.guildId };
    }
    return undefined;
  }

  /**
   * Set a human user's location (backward-compat with observedVoiceUsers.set).
   *
   * @param {string} userId
   * @param {{channelId: string, guildId: string}} info
   */
  setHumanUser(userId, info) {
    const guildId = info.guildId;
    const channelId = info.channelId;
    if (guildId && channelId) {
      this.updateUser({ guildId, userId, channelId, isBot: false });
    }
  }

  /**
   * Set a bot user's location (backward-compat with observedVoiceBots.set).
   *
   * @param {string} compositeKey  "guildId:userId" composite key
   * @param {{channelId: string, guildId: string}} info
   */
  setBotUser(compositeKey, info) {
    const guildId = info.guildId;
    const channelId = info.channelId;
    const userId = compositeKey.split(":").pop();
    if (guildId && channelId && userId) {
      this.updateUser({ guildId, userId, channelId, isBot: true });
    }
  }

  /**
   * Delete a human user by userId (scans all guilds if no guildId given).
   * Backward-compat with observedVoiceUsers.delete(userId).
   *
   * @param {string} userId
   * @param {string|null} [guildId=null]
   */
  deleteHumanUser(userId, guildId = null) {
    if (guildId) {
      this.updateUser({ guildId, userId, channelId: null, isBot: false });
    } else {
      const cleanUser = String(userId).replace(/\D/g, "");
      for (const [uKey, loc] of this.userLocations) {
        if (loc.userId === cleanUser) {
          this.updateUser({ guildId: loc.guildId, userId: cleanUser, channelId: null, isBot: false });
        }
      }
    }
  }

  /**
   * Delete a bot user by composite key.
   * Backward-compat with observedVoiceBots.delete(compositeKey).
   *
   * @param {string} compositeKey  "guildId:userId"
   */
  deleteBotUser(compositeKey) {
    const parts = compositeKey.split(":");
    const guildId = parts[0];
    const userId  = parts[1];
    if (guildId && userId) {
      this.updateUser({ guildId, userId, channelId: null, isBot: true });
    }
  }

  /**
   * Check if a human user exists in the cache.
   * Backward-compat with observedVoiceUsers.has(userId).
   *
   * @param {string} userId
   * @param {string|null} [guildId=null]
   * @returns {boolean}
   */
  hasHumanUser(userId, guildId = null) {
    if (guildId) {
      return this.userLocations.has(VoiceStateCache.userKey(guildId, userId));
    }
    const cleanUser = String(userId).replace(/\D/g, "");
    for (const [uKey, loc] of this.userLocations) {
      if (loc.userId === cleanUser) return true;
    }
    return false;
  }

  /**
   * Check if a bot user exists in the cache.
   * Backward-compat with observedVoiceBots.has(compositeKey).
   *
   * @param {string} compositeKey
   * @returns {boolean}
   */
  hasBotUser(compositeKey) {
    return this.botLocations.has(compositeKey);
  }

  /**
   * Default iterator — iterates human users.
   * Yields [userId, {channelId, guildId}] — same shape as old observedVoiceUsers Map.
   */
  *[Symbol.iterator]() {
    for (const [uKey, loc] of this.userLocations) {
      yield [loc.userId, { channelId: loc.channelId, guildId: loc.guildId }];
    }
  }

  /**
   * Backward-compat with `observedVoiceUsers.size`.
   */
  get size() { return this.userLocations.size; }

  /**
   * Backward-compat with `observedVoiceUsers.has(userId)`.
   * If called with a single argument (userId), scans all guilds.
   * If called with two arguments (userId, guildId), does O(1) lookup.
   *
   * @param {string} userId
   * @param {string} [guildId]
   * @returns {boolean}
   */
  has(userId, guildId) {
    if (guildId !== undefined) {
      return this.userLocations.has(VoiceStateCache.userKey(guildId, userId));
    }
    const cleanUser = String(userId).replace(/\D/g, "");
    for (const [, loc] of this.userLocations) {
      if (loc.userId === cleanUser) return true;
    }
    return false;
  }

  /**
   * Backward-compat with `observedVoiceUsers.get(userId)`.
   * If called with a single argument (userId), returns first match across all guilds.
   * If called with two arguments (userId, guildId), does O(1) lookup.
   *
   * @param {string} userId
   * @param {string} [guildId]
   * @returns {{channelId: string, guildId: string}|undefined}
   */
  get(userId, guildId) {
    if (guildId !== undefined) {
      const loc = this.userLocations.get(VoiceStateCache.userKey(guildId, userId));
      return loc ? { channelId: loc.channelId, guildId: loc.guildId } : undefined;
    }
    const cleanUser = String(userId).replace(/\D/g, "");
    for (const [, loc] of this.userLocations) {
      if (loc.userId === cleanUser) return { channelId: loc.channelId, guildId: loc.guildId };
    }
    return undefined;
  }

  /**
   * Backward-compat with `observedVoiceUsers.set(userId, {channelId, guildId})`.
   *
   * @param {string} userId
   * @param {{channelId: string, guildId: string}} info
   */
  set(userId, info) {
    const guildId   = info?.guildId;
    const channelId = info?.channelId;
    if (guildId && channelId) {
      this.updateUser({ guildId, userId, channelId, isBot: false });
    }
  }

  /**
   * Backward-compat with `observedVoiceUsers.delete(userId)`.
   *
   * @param {string} userId
   * @param {string} [guildId]
   */
  delete(userId, guildId) {
    if (guildId !== undefined) {
      this.updateUser({ guildId, userId, channelId: null, isBot: false });
    } else {
      const cleanUser = String(userId).replace(/\D/g, "");
      const toRemove = [];
      for (const [uKey, loc] of this.userLocations) {
        if (loc.userId === cleanUser) toRemove.push(loc);
      }
      for (const loc of toRemove) {
        this.updateUser({ guildId: loc.guildId, userId: cleanUser, channelId: null, isBot: false });
      }
    }
  }

  /**
   * Backward-compat with `observedVoiceUsers.forEach(fn)`.
   *
   * @param {Function} fn  callback(userId, info, cache)
   */
  forEach(fn) {
    for (const [userId, info] of this) {
      fn(userId, info, this);
    }
  }

  /**
   * Backward-compat with `observedVoiceUsers.entries()`.
   */
  *entries() {
    yield* this;
  }

  /**
   * Backward-compat with `observedVoiceUsers.keys()`.
   */
  *keys() {
    for (const [userId] of this) {
      yield userId;
    }
  }

  /**
   * Backward-compat with `observedVoiceUsers.values()`.
   */
  *values() {
    for (const [, info] of this) {
      yield info;
    }
  }

  get stats() {
    return {
      humanUsers: this.userLocations.size,
      botUsers: this.botLocations.size,
      humanChannels: this.channelMembers.size,
      botChannels: this.botChannelMembers.size,
      lruUserKeysLen: this._lruUserKeys.length,
      lruBotKeysLen: this._lruBotKeys.length,
    };
  }
}
