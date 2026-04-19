/**
 * MoonlinkManager.mjs
 *
 * Wraps moonlink.js Manager with a custom connector for Fluxer.
 * FIXED: Correct payload format for packetUpdate
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
    this.setMaxListeners(50); // reconnects temporarily stack listeners during re-init
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

    // Set up voice state forwarding from Fluxer to moonlink
    this._setupVoiceForwarding(client);

    // Forward key events
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
   * Send voice payload to Fluxer's WebSocket
   * @param {string} guildId
   * @param {{ op: number, d: object }} payload
   * @private
   */
  _sendPayload(guildId, payload) {
    try {
      // Prefer the public ws.send(shardId, payload) API — shards is a private field
      // in @fluxerjs/ws and accessing it directly risks breaking on internal refactors.
      if (typeof this._client?.ws?.send === "function") {
        this._client.ws.send(0, payload);
        return;
      }

      // Fallback: access shard directly only if the public API is unavailable
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
    // @fluxerjs/core emits VoiceStateUpdate with a SINGLE argument:
    // (data: GatewayVoiceStateUpdateDispatchData) — raw gateway snake_case fields.
    client.on(Events.VoiceStateUpdate, (data) => {
      try {
        // data is the raw GatewayVoiceStateUpdateDispatchData — always snake_case
        const guildId = data.guild_id;
        if (!guildId) {
          logger.warn("[MoonlinkManager] voiceStateUpdate: No guild_id found in data", data);
          return;
        }

        // Build the proper payload format that moonlink expects:
        // { op: 0, t: "VOICE_STATE_UPDATE", d: { guild_id, user_id, channel_id, ... } }
        const payload = {
          op: 0,  // Dispatch
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

    // Raw WS — only for VOICE_SERVER_UPDATE (VOICE_STATE_UPDATE is handled above via Events listener)
    // Store the handler reference so we can remove the stale listener before re-attaching
    // on gateway reconnects. Without this, each reconnect stacks another handler on the socket.
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

        // Skip re-attaching if it's the same socket object (spurious Ready re-fire)
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

        // Absorb socket-level errors so they don't escape to uncaughtException.
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
    // Re-attach after every gateway reconnect so the new socket gets the listener
    client.on(Events.Ready, attachRawWs);
  }

  /**
   * Call after client.login() resolves and client.user.id is available.
   * Safe to call on every reconnect — removes stale internal listeners before re-init
   * to prevent the MaxListenersExceededWarning that moonlink.js triggers by adding
   * a new nodeReady/nodeConnected listener to the node socket on every init() call.
   * @param {string} clientId
   */
  async init(clientId) {
    // Raise the limit on both this emitter and the internal manager so reconnects
    // don't spam MaxListenersExceededWarning while we're between socket teardown
    // and the re-init completing.
    this.setMaxListeners(50);
    try { this.manager.setMaxListeners?.(50); } catch (_) {}

    // Strip any stale nodeReady listeners the previous init() call registered
    // so they don't stack up across gateway reconnects.
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

  /**
   * Search for tracks. Returns a moonlink SearchResult.
   * @param {string} query
   * @param {string} [source]  e.g. "ytmsearch", "spsearch"
   * @param {*} [requester]
   */
  search(query, source, requester) {
    return this.manager.search({ query, source, requester });
  }

  /**
   * Get or create a moonlink Player for a guild.
   * @param {{ guildId: string, voiceChannelId: string, textChannelId?: string, volume?: number }} opts
   * @returns {import("moonlink.js").Player}
   */
  createPlayer(opts) {
    return this.manager.players.create(opts);
  }

  /**
   * Get an existing player by guildId.
   * @param {string} guildId
   * @returns {import("moonlink.js").Player|undefined}
   */
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