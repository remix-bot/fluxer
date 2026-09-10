/**
 * @module src/music/PlayerEventsMixin
 * @description Dashboard event wiring concern for {@link PlayerManager}:
 * binds dashboard update/queue/message events onto spawned players,
 * forwards now-playing updates to Last.fm with scrobble scheduling, and
 * translates locale keys for message contexts.
 *
 * These methods are applied onto the PlayerManager class prototype via
 * {@link applyMixins} (see src/music/PlayerManager.mjs) — `this` is a
 * PlayerManager instance.
 */

import { cleanId } from "../utils/Utils.mjs";
import { getMessageGuildId } from "../ui/index.mjs";
import { Dashboard } from "../dashboard/Dashboard.mjs";

/** @private @param {Player} player @param {object|null} [fallbackChannel=null] @returns {string} Cleaned guild ID. */
function getPlayerGuildId(player, fallbackChannel = null) {
  return cleanId(
    player?._guildId ??
    fallbackChannel?.guildId ??
    fallbackChannel?.guild?.id ??
    fallbackChannel?.server_id ??
    fallbackChannel?.serverId
  );
}

/** @private @param {Player} player @param {string|null} [fallbackChannelId=null] @returns {string} Cleaned channel ID. */
function getPlayerChannelId(player, fallbackChannelId = null) {
  return cleanId(player?._channelId ?? player?._home247Channel ?? fallbackChannelId);
}
export { getPlayerGuildId, getPlayerChannelId };

/**
 * @type {object}
 * @description Player events mixin — applied to PlayerManager.
 */
const PlayerEventsMixin = {
  /** Bind dashboard update and message-sending events on a player. @this {import('./PlayerManager.mjs').PlayerManager} @param {Player} player @param {object} [context={}] @returns {Player} The same player, with events bound. */
  setupEvents(player, context = {}) {
    if (!player || player._dashboardEventsBound) return player;

    Object.defineProperty(player, "_dashboardEventsBound", {
      value: true,
      configurable: true,
      enumerable: false,
      writable: true,
    });

    const emit = (type, data) => {
      if (!this.dashboard?.enabled) return;
      this.dashboard.updatePlayer({ type, data }, player);
    };

    const emitGlobal = (type) => {
      if (!this.dashboard?.enabled) return;
      this.dashboard.playerUpdate({ type }, player);
    };

    const sendUserUpdates = (eventType) => {
      if (!this.dashboard?.enabled) return;
      const channelId = getPlayerChannelId(player, context.channelId);
      const channel = player.client?.channels?.get(channelId);
      const guild = player.client?.guilds?.get(cleanId(player._guildId ?? context.guildId));
      if (!guild) return;
      const voiceStates = guild.voice_states ?? guild.voiceStates ?? null;
      if (!voiceStates) return;
      const entries = Array.isArray(voiceStates)
        ? voiceStates
        : typeof voiceStates.values === "function"
          ? [...voiceStates.values()]
          : Object.values(voiceStates);
      for (const state of entries) {
        if (!state?.channelId && !state?.channel_id) continue;
        const stateChannelId = cleanId(state.channelId ?? state.channel_id);
        if (stateChannelId !== channelId) continue;
        const member = guild.members?.get?.(state.userId ?? state.user_id);
        if (!member?.user || member.user?.bot) continue;
        emit(eventType, member.user.id);
        this.dashboard.userUpdate({
          type: eventType,
          guildId: cleanId(player._guildId ?? context.guildId),
          channelId,
        }, member.user);
      }
    };

    player.on("roomfetched", () => {
      emitGlobal("init");
      sendUserUpdates("join");
    });

    player.on("startplay", (song) => {
      emit("startplay", Dashboard.convertVideo(song ?? player.queue?.current));
      emit("streamStartPlay", Date.now());
      this.dashboard.playerUpdate({ type: "startplay" }, player);

      if (this._lastfm?.enabled && song) {
        this._handleLastFmStartPlay(player, song);
      }
    });

    player.on("stopplay", () => {
      emit("stopplay", null);
      this.dashboard.playerUpdate({ type: "stopplay" }, player);
    });

    player.on("playback", (playing) => {
      const elapsedMs = player._pausedAt
          ? (player._pausedAt.getTime?.() ?? Number(player._pausedAt)) -
            (player.startedPlaying?.getTime?.() ?? Number(player.startedPlaying ?? 0))
          : Date.now() - (player.startedPlaying?.getTime?.() ?? Number(player.startedPlaying ?? 0));
      const type = playing ? "resume" : "pause";
      emit(type, { elapsedTime: Math.max(0, elapsedMs) });
      this.dashboard.playerUpdate({ type }, player);
    });

    player.on("volume", (volume) => {
      emit("volume", volume);
      this.dashboard.playerUpdate({ type: "volume" }, player);
    });

    player.on("filter", (filter) => {
      emit("filter", filter);
    });

    player.on("update", (scope) => {
      this.dashboard.playerUpdate({ type: "update" }, player);
    });

    player.on("autoleave", () => {
      sendUserUpdates("leave");
      emitGlobal("close");
      emit("stopplay", null);
    });

    player.on("leave", () => {
      sendUserUpdates("leave");
      emitGlobal("close");
      emit("stopplay", null);
    });

    player.queue?.on("queue", (queueEvent) => {
      const serialised = { type: queueEvent.type };
      switch (queueEvent.type) {
        case "add":
          serialised.data = {
            append: queueEvent.data?.append,
            data: Dashboard.convertVideo(queueEvent.data?.data),
          };
          break;
        case "addMany":
          serialised.data = {
            append: queueEvent.data?.append,
            tracks: (queueEvent.data?.tracks ?? []).map(v => Dashboard.convertVideo(v)),
          };
          break;
        case "remove":
          serialised.data = {
            index: queueEvent.data?.index,
            removed: Dashboard.convertVideo(queueEvent.data?.removed),
            old: (queueEvent.data?.old ?? []).map(v => Dashboard.convertVideo(v)),
            new: (queueEvent.data?.new ?? []).map(v => Dashboard.convertVideo(v)),
          };
          break;
        case "move":
          serialised.data = {
            from: queueEvent.data?.from,
            to: queueEvent.data?.to,
            track: Dashboard.convertVideo(queueEvent.data?.track),
          };
          break;
        case "shuffle":
          serialised.data = (queueEvent.data ?? []).map(v => Dashboard.convertVideo(v));
          break;
        case "update":
          serialised.data = {
            current: Dashboard.convertVideo(queueEvent.data?.current),
            old: Dashboard.convertVideo(queueEvent.data?.old),
            loop: queueEvent.data?.loop,
          };
          break;
        default:
          serialised.data = queueEvent.data;
          break;
      }

      emit("queue", serialised);
      this.dashboard.playerUpdate({ type: "queue" }, player);
    });

    return player;
  },

  /** @private Translate a locale key for a message context. @this {import('./PlayerManager.mjs').PlayerManager} @param {object} message @param {string} key @param {object} [replacements={}] @returns {string} */
  _t(message, key, replacements = {}) {
    if (!this.locale) return key;
    const guildId = getMessageGuildId(message);
    return this.locale.translate(guildId, key, replacements);
  },

  /** @private Handle Last.fm now-playing update and schedule scrobble timer. @this {import('./PlayerManager.mjs').PlayerManager} @param {Player} player @param {object} song */
  _handleLastFmStartPlay(player, song) {
    const lastfm = this._lastfm;
    if (!lastfm?.enabled) return;

    const guildId = cleanId(player._guildId);
    if (!guildId) return;

    const channelId = getPlayerChannelId(player);
    const humanUserIds = [];

    if (this.voiceCache) {
      const users = this.voiceCache.getHumansInChannel(guildId, channelId);
      humanUserIds.push(...users);
    } else if (this.observedVoiceUsers) {
      for (const [uid, info] of this.observedVoiceUsers) {
        if (cleanId(info.guildId) === guildId && cleanId(info.channelId) === channelId) {
          humanUserIds.push(uid);
        }
      }
    }

    const guild = player.client?.guilds?.get(guildId);
    if (guild) {
      const voiceStates = guild.voice_states ?? guild.voiceStates ?? null;
      if (voiceStates) {
        const entries = Array.isArray(voiceStates)
          ? voiceStates
          : typeof voiceStates.values === "function"
            ? [...voiceStates.values()]
            : Object.values(voiceStates ?? {});
        for (const state of entries) {
          const uid = state?.userId ?? state?.user_id;
          const chId = cleanId(state?.channelId ?? state?.channel_id);
          if (uid && chId === channelId) {
            const member = guild.members?.get?.(uid);
            if (member?.user?.bot) continue;
            if (!humanUserIds.includes(uid)) humanUserIds.push(uid);
          }
        }
      }
    }

    const startedAtMs = player.startedPlaying;

    const pendingKey = channelId;
    const existing = this._pendingScrobbleTimers.get(pendingKey);
    if (existing) {
      clearTimeout(existing.timer);
      this._pendingScrobbleTimers.delete(pendingKey);
    }

    for (const userId of humanUserIds) {
      lastfm.updateNowPlaying(userId, song).catch(() => {});
    }

    const durationMs = (() => {
      const d = song.duration;
      if (!d) return null;
      if (typeof d === "object" && d.seconds) return d.seconds * 1000;
      if (typeof d === "number") return d;
      return null;
    })();

    if (durationMs && durationMs >= 30_000) {
      const thresholdMs = Math.min(
        durationMs * lastfm.scrobbleThreshold,
        lastfm.scrobbleMinMs
      );
      if (thresholdMs <= 600_000) {
        const timer = setTimeout(() => {
          this._pendingScrobbleTimers.delete(pendingKey);
          const current = player.queue?.getCurrent();
          if (!current || player._destroyed || player.leaving) return;
          if (current.title !== song.title || current.url !== song.url) return;
          if (player._paused) return;

          const playedMs = Date.now() - (player.startedPlaying ?? startedAtMs ?? Date.now());
          if (lastfm.shouldScrobble(song, playedMs)) {
            for (const userId of humanUserIds) {
              lastfm.scrobble(userId, song, startedAtMs).catch(() => {});
            }
          }
        }, thresholdMs);

        this._pendingScrobbleTimers.set(pendingKey, { timer, songUrl: song.url, startedAtMs });
      }
    }
  },
};

export default PlayerEventsMixin;
export { PlayerEventsMixin };
