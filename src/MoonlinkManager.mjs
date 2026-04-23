/**
 * MoonlinkManager.mjs
 *
 * Wraps moonlink.js Manager with a custom connector for Fluxer.
 */

import { Manager } from "moonlink.js";
import { logger } from "./constants/Logger.mjs";
import { EventEmitter } from "node:events";
import { Events } from "@fluxerjs/core";

// ═══════════════════════════════════════════════════════════════════════════════
// MoonlinkManager ──────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

export class MoonlinkManager extends EventEmitter {
  /** @type {Manager} */
  manager = null;
  /** @type {string|null} */
  sessionId = null;
  /** @type {import("@fluxerjs/core").Client} */
  _client = null;

  /**
   * @param {{ host: string, port: number, password: string, secure?: boolean }} nodeCfg
   * @param {import("@fluxerjs/core").Client} client
   */
  constructor(nodeCfg, client) {
    super();
    this.setMaxListeners(50);
    this._nodeCfg = nodeCfg;
    this._client = client;

    this.manager = new Manager({
      nodes: [
        {
          host:       nodeCfg.host       ?? "localhost",
          port:       nodeCfg.port       ?? 3000,
          password:   nodeCfg.password   ?? "youshallnotpass",
          secure:     nodeCfg.secure     ?? false,
          identifier: "main",
        }
      ],
      options: {
        resume: true,
        resumeTimeout: 60_000,
        defaultPlayer: {
          volume:    100,
          selfDeaf:  true,
          selfMute:  false,
          autoPlay:  false,
          autoLeave: false,
        },
        search: {
          defaultPlatform: "ytmsearch",
        },
        send: (guildId, payload) => this._sendPayload(guildId, payload),
      },
    });

    this._setupVoiceForwarding(client);

    this.manager.on("nodeReady", (node) => {
      this.sessionId = node.sessionId ?? null;
      logger.moonlink(`[Moonlink] Node ready: ${node.identifier} | session: ${this.sessionId}`);
      this.emit("ready", this.sessionId);
    });

    this.manager.on("nodeConnected", (node) => {
      logger.moonlink(`[Moonlink] Node connected: ${node.identifier}`);
    });

    this.manager.on("nodeDisconnect", (node, reason) => {
      logger.warn("[Moonlink] Node disconnected:", node.identifier, reason);
    });

    this.manager.on("nodeError", (node, err) => {
      logger.error("[Moonlink] Node error:", node.identifier, err?.message ?? err);
    });

    this.manager.on("trackStart", (player, track) => {
      this.emit("trackStart", player, track);
    });

    this.manager.on("trackEnd", (player, track, reason) => {
      this.emit("trackEnd", player, track, reason);
    });

    this.manager.on("queueEnd", (player) => {
      this.emit("queueEnd", player);
    });

    this.manager.on("playerDisconnected", (player) => {
      this.emit("playerDisconnected", player);
    });
  }

  /**
   * Get the current live session ID from the connected node.
   * Walks active nodes to find a valid session, fallback to cached.
   * @returns {string|null}
   */
  getLiveSessionId() {
    try {
      for (const node of this.manager.nodes?.nodes?.values?.() ?? []) {
        if (node.sessionId) return node.sessionId;
        if (node.ws?.sessionId) return node.ws.sessionId;
      }
    } catch (_) {}
    return this.sessionId;
  }

  /**
   * Send voice payload to Fluxer's WebSocket
   * @param {string} guildId
   * @param {{ op: number, d: object }} payload
   * @private
   */
  _sendPayload(guildId, payload) {
    try {
      if (typeof this._client?.ws?.send === "function") {
        this._client.ws.send(0, payload);
        return;
      }

      const shard = this._client?.ws?.shards?.get?.(0);
      if (!shard) {
        logger.warn("[MoonlinkManager] No WebSocket shard available");
        return;
      }

      if (typeof shard.send === "function") {
        shard.send(payload);
      } else if (shard.ws?.send) {
        shard.ws.send(JSON.stringify(payload));
      } else {
        logger.warn("[MoonlinkManager] Cannot send - no valid send method found");
      }
    } catch (e) {
      logger.warn("[MoonlinkManager] Send error:", e.message);
    }
  }

  /**
   * Forward voice state updates from Fluxer to moonlink
   * @param {import("@fluxerjs/core").Client} client
   * @private
   */
  _setupVoiceForwarding(client) {
    client.on(Events.VoiceStateUpdate, (data) => {
      try {
        const guildId = data.guild_id;
        if (!guildId) {
          logger.warn("[MoonlinkManager] voiceStateUpdate: No guild_id found in data", data);
          return;
        }

        const payload = {
          op: 0,
          t: "VOICE_STATE_UPDATE",
          d: {
            guild_id:   guildId,
            channel_id: data.channel_id  ?? null,
            user_id:    data.user_id,
            session_id: data.session_id  ?? "",
            deaf:       data.deaf        ?? false,
            mute:       data.mute        ?? false,
            self_deaf:  data.self_deaf   ?? false,
            self_mute:  data.self_mute   ?? false,
            self_stream: data.self_stream ?? false,
            self_video: data.self_video  ?? false,
            suppress:   data.suppress    ?? false,
            member:     data.member      ?? null,
          }
        };

        this.manager.packetUpdate(payload);
      } catch (e) {
        logger.warn("[MoonlinkManager] voiceStateUpdate forward error:", e.message);
      }
    });

    const attachRawWs = () => {
      try {
        const shard0 = client.ws?.shards?.get?.(0);
        const wsObj  = shard0?.ws ?? null;
        if (!wsObj) return;
        if (this._rawWsHandler && this._rawWsObj && this._rawWsObj !== wsObj) {
          try {
            if (typeof this._rawWsObj.removeEventListener === "function") {
              this._rawWsObj.removeEventListener("message", this._rawWsHandler);
              this._rawWsObj.removeEventListener("error",   this._rawWsErrorHandler);
            } else if (typeof this._rawWsObj.off === "function") {
              this._rawWsObj.off("message", this._rawWsHandler);
              this._rawWsObj.off("error",   this._rawWsErrorHandler);
            }
          } catch (_) {}
        }

        if (wsObj === this._rawWsObj) return;

        this._rawWsHandler = (rawData) => {
          try {
            const text    = typeof rawData === "string" ? rawData : rawData?.data;
            const payload = typeof text === "string" ? JSON.parse(text) : rawData;
            if (payload?.t === "VOICE_SERVER_UPDATE") {
              if (!payload.d?.guild_id) {
                logger.warn("[MoonlinkManager] VOICE_SERVER_UPDATE: Missing guild_id", payload);
                return;
              }
              this.manager.packetUpdate(payload);
            }
          } catch (_) {}
        };

        this._rawWsErrorHandler = (err) => {
          logger.warn("[MoonlinkManager] Raw WS socket error (will reconnect):", err?.message ?? err);
        };

        if (typeof wsObj.addEventListener === "function") {
          wsObj.addEventListener("message", this._rawWsHandler);
          wsObj.addEventListener("error",   this._rawWsErrorHandler);
        } else if (typeof wsObj.on === "function") {
          wsObj.on("message", this._rawWsHandler);
          wsObj.on("error",   this._rawWsErrorHandler);
        }

        this._rawWsObj = wsObj;
      } catch (e) {
        logger.warn("[MoonlinkManager] Raw WS setup error:", e.message);
      }
    };

    attachRawWs();
    client.on(Events.Ready, attachRawWs);
  }

  async init(clientId) {
    this.setMaxListeners(50);
    try { this.manager.setMaxListeners?.(50); } catch (_) {}

    try {
      for (const node of this.manager.nodes?.nodes?.values?.() ?? []) {
        const sock = node.socket ?? node.ws ?? null;
        if (sock && typeof sock.removeAllListeners === "function") {
          sock.removeAllListeners("open");
          sock.removeAllListeners("close");
          sock.removeAllListeners("error");
          sock.removeAllListeners("message");
        }
      }
    } catch (_) {}

    await this.manager.init(clientId);
  }

  search(query, source, requester) {
    return this.manager.search({ query, source, requester });
  }

  createPlayer(opts) {
    return this.manager.players.create(opts);
  }

  getPlayer(guildId) {
    return this.manager.players.get(guildId);
  }

  destroy() {
    try {
      for (const node of this.manager.nodes.nodes.values()) {
        node.socket?.close?.();
      }
    } catch (_) {}
  }
}