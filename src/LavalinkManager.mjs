/** @module src/LavalinkManager @description Manages Lavalink/NodeLink connection, voice forwarding, and audio search functionality. */

import { LavalinkManager as LavalinkClientManager, NodeType } from "lavalink-client";
import { logger, _wsErrorCooldown } from "./constants/Logger.mjs";
import { EventEmitter } from "node:events";
import { Events } from "@fluxerjs/core";
import { getVoiceManager } from "@fluxerjs/voice";

/** @class LavalinkManager @description Manages Lavalink/NodeLink connection, voice forwarding, and audio search functionality. Wraps the lavalink-client library and provides node lifecycle management, search, player creation, and WebSocket payload interception. @extends {EventEmitter} */
export class LavalinkManager extends EventEmitter {
  /** @type {LavalinkClientManager} @description The underlying lavalink-client manager instance. */
  lavalink = null;
  /** @type {string|null} @description Current Lavalink session ID. */
  _sessionId = null;
  /** @type {object} @description Bot client reference. */
  _client = null;
  /** @type {object} @description Node configuration (id, host, port, password, secure). */
  _nodeCfg = null;
  /** @type {boolean} @description Whether a node is currently connected. */
  _nodeConnected = false;
  /** @private @type {Set<string>} @description Guild IDs with pending leave requests. */
  _pendingLeaves = new Set();
  /** @private @type {Map<string, object>} @description Cached VOICE_SERVER_UPDATE payloads keyed by guild ID. */
  _cachedVoiceServerUpdates = new Map();

/** Create a new LavalinkManager and initialize the underlying lavalink-client connection. @param {object} nodeCfg - Node configuration (id, host, port, password, secure). @param {object} client - Discord bot client instance. @param {object} user - Bot user object with id and username. */
  constructor(nodeCfg, client, user) {
    super();
    this.setMaxListeners(50);
    this._nodeCfg = nodeCfg;
    this._client = client;
    const requestSignalTimeoutMS = Number(nodeCfg.requestTimeout ?? 60_000);

    this.lavalink = new LavalinkClientManager({
      nodes: [
        {
          id:           nodeCfg.id       ?? "main",
          host:         nodeCfg.host     ?? "localhost",
          port:         nodeCfg.port     ?? 2333,
          authorization:nodeCfg.password ?? "youshallnotpass",
          secure:       nodeCfg.secure   ?? false,
          nodeType:     NodeType.NodeLink,
          requestSignalTimeoutMS: Number.isFinite(requestSignalTimeoutMS) ? requestSignalTimeoutMS : 60_000,
        },
      ],
      client: {
        id:       user?.id       ?? "0",
        username: user?.username ?? "bot",
      },
      sendToShard: (guildId, payload) => {
        this._sendPayload(guildId, payload);
      },
      autoSkip: true,
      playerOptions: {
        volumeDecrementer: 1,
      },
    });

    this._setupVoiceForwarding(client);
    this._setupLavalinkEvents();
  }

  /** @private Set up internal Lavalink event forwarding (node connect/disconnect/error, track events). */
  _setupLavalinkEvents() {

    const nodeMgr = this.lavalink.nodeManager ?? this.lavalink.nodes;
    if (nodeMgr) {
      try {
        nodeMgr.on("error", (node, err) => {
          logger.error("[Lavalink] NodeManager error:", node?.id, err?.message ?? err);
        });
        nodeMgr.on("connect", (node) => {
          this._nodeConnected = true;
          logger.lavalink("[Lavalink] Node connected (nodeManager): " + node.id);
        });
        nodeMgr.on("disconnect", (node, reason) => {
          this._nodeConnected = false;
          logger.warn("[Lavalink] Node disconnected (nodeManager):", node?.id, reason);
        });
        nodeMgr.on("reconnect", (node) => {
          this._nodeConnected = true;
          logger.lavalink("[Lavalink] Node reconnecting (nodeManager): " + node.id);
        });
      } catch (e) {
        logger.warn("[Lavalink] nodeManager event setup error:", e?.message);
      }
    } else {
      logger.warn("[Lavalink] Neither nodeManager nor nodes found on lavalink-client instance");
    }

    this.lavalink.on("nodeConnect", (node) => {
      this._nodeConnected = true;
      logger.lavalink("[Lavalink] Node connected (manager): " + node.id);
    });

    this.lavalink.on("nodeReconnect", (node) => {
      this._nodeConnected = true;
      logger.lavalink("[Lavalink] Node reconnecting (manager): " + node.id);
    });

    this.lavalink.on("nodeDisconnect", (node, reason) => {
      this._nodeConnected = false;
      logger.warn("[Lavalink] Node disconnected (manager):", node.id, reason);
    });

    this.lavalink.on("nodeError", (node, err) => {
      logger.error("[Lavalink] Node error (manager):", node.id, err?.message ?? err);
    });


    this.lavalink.on("playerCreate", (player) => {
      logger.lavalink(`[Lavalink] Player created: ${player.guildId}`);
    });

    this.lavalink.on("playerDestroy", (player) => {
      logger.lavalink(`[Lavalink] Player destroyed: ${player.guildId}`);
    });

    this.lavalink.on("trackStart", (player, track) => {
      this.emit("trackStart", player, track);
    });

    this.lavalink.on("trackEnd", (player, track, payload) => {
      const reason = payload?.reason ?? "FINISHED";
      this.emit("trackEnd", player, track, reason);
    });

    this.lavalink.on("queueEnd", (player) => {
      this.emit("queueEnd", player);
    });

    this.lavalink.on("playerDisconnect", (player) => {
      this.emit("playerDisconnected", player);
    });

    this.lavalink.on("playerMove", (player, oldChannelId, newChannelId) => {
      logger.lavalink(
        `[Lavalink] Player moved in ${player.guildId}: ${oldChannelId} → ${newChannelId}`
      );
    });
  }


  /** @private Intercept and forward gateway payloads to Lavalink. Blocks op4 voice joins (handled by vm.join). */
  _sendPayload(guildId, payload) {
    try {
      if (payload?.op === 4 && payload?.d) {
        const d = payload.d;
        const channelId = d.channel_id;

        if (channelId) {
          logger.lavalink(
            "[LavalinkManager] sendToShard op4 join BLOCKED — voice joins go through vm.join() in Player.join()"
          );
          return;
        } else {
          const guildKey = String(guildId);
          if (!this._pendingLeaves.has(guildKey)) {
            logger.lavalink("[LavalinkManager] sendToShard op4 leave BLOCKED — no explicit leave request for guild " + guildKey);
            return;
          }
          this._pendingLeaves.delete(guildKey);

          const vm = getVoiceManager(this._client);
          if (vm) {
            logger.lavalink("[LavalinkManager] sendToShard op4: routing voice leave via vm.leaveChannel");
            try {
              const player = this.lavalink?.players?.get?.(guildKey);
              const chId = player?.voiceChannelId;
              if (chId) {
                vm.leaveChannel(chId);
              }
              return;
            } catch (e) {
              logger.warn("[LavalinkManager] vm.leaveChannel failed:", e.message);
            }
          }
        }
      }

      if (typeof this._client?.ws?.send === "function") {
        this._client.ws.send(0, payload);
        return;
      }

      const shard = this._client?.ws?.shards?.get?.(0);
      if (!shard) {
        logger.warn("[LavalinkManager] No WebSocket shard available");
        return;
      }

      if (typeof shard.send === "function") {
        shard.send(payload);
      } else if (shard.ws?.send) {
        shard.ws.send(JSON.stringify(payload));
      } else {
        logger.warn("[LavalinkManager] Cannot send - no valid send method found");
      }
    } catch (e) {
      logger.warn("[LavalinkManager] Send error:", e.message);
    }
  }

  /** @private Attach raw WebSocket listeners to cache VOICE_SERVER_UPDATE events and handle errors. */
  _setupVoiceForwarding(client) {

    const attachRawWs = () => {
      try {
        const shard0 = client.ws?.shards?.get?.(0);
        const wsObj  = shard0?.ws ?? null;
        if (!wsObj) return;

        if (this._rawWsHandler && this._rawWsObj && this._rawWsObj !== wsObj) {
          try {
            if (typeof this._rawWsObj.removeEventListener === "function") {
              this._rawWsObj.removeEventListener(
                "message",
                this._rawWsMessageListener ?? this._rawWsHandler
              );
              this._rawWsObj.removeEventListener("error", this._rawWsErrorHandler);
            } else if (typeof this._rawWsObj.off === "function") {
              this._rawWsObj.off(
                "message",
                this._rawWsMessageListener ?? this._rawWsHandler
              );
              this._rawWsObj.off("error", this._rawWsErrorHandler);
            }
          } catch (e) {
            logger.warn(
              "[LavalinkManager] Raw WS listener cleanup:",
              e?.message
            );
          }
        }

        if (wsObj === this._rawWsObj) return;

        const botId = this._client?.user?.id;
        let _vsuLogCooldown = 0;
        let _vsuBotLogCooldown = 0;
        this._rawWsHandler = (rawData) => {
          try {
            const text    = typeof rawData === "string" ? rawData : rawData?.data;
            const payload = typeof text === "string" ? JSON.parse(text) : rawData;

            if (payload?.t === "VOICE_SERVER_UPDATE") {
              if (!payload.d?.guild_id) {
                logger.warn(
                  "[LavalinkManager] VOICE_SERVER_UPDATE: Missing guild_id",
                  payload
                );
                return;
              }
              const guildKey = String(payload.d.guild_id);
              const now = Date.now();
              logger.lavalink("[LavalinkManager] VOICE_SERVER_UPDATE for guild " + guildKey +
                " endpoint=" + (payload.d.endpoint || "none") +
                " token=" + (typeof payload.d.token === "string" ? payload.d.token.substring(0, 12) + "..." : "none"));
              if (now - _vsuLogCooldown > 5_000) {
                _vsuLogCooldown = now;
              }
              this._cachedVoiceServerUpdates.set(guildKey, payload);
              if (this._cachedVoiceServerUpdates.size > 500) {
                const oldest = this._cachedVoiceServerUpdates.keys().next().value;
                if (oldest !== undefined) this._cachedVoiceServerUpdates.delete(oldest);
              }
            }

          } catch (e) {
            logger.warn(
              "[LavalinkManager] Raw WS message parse error:",
              e?.message
            );
          }
        };

        this._rawWsErrorHandler = (errOrEvent) => {
          if (typeof errOrEvent?.preventDefault === "function")
            errOrEvent.preventDefault();
          const err = errOrEvent?.error ?? errOrEvent?.message ?? errOrEvent;
          const now = Date.now();
          if (now - _wsErrorCooldown.lastLogged < _wsErrorCooldown.COOLDOWN_MS)
            return;
          _wsErrorCooldown.lastLogged = now;
          logger.warn(
            "[LavalinkManager] Raw WS socket error (will reconnect):",
            err?.message ?? err
          );
        };

        this._rawWsMessageListener = (event) =>
          this._rawWsHandler(event?.data ?? event);

        if (typeof wsObj.addEventListener === "function") {
          wsObj.addEventListener("message", this._rawWsMessageListener);
          wsObj.addEventListener("error", this._rawWsErrorHandler);
        } else if (typeof wsObj.on === "function") {
          wsObj.on("message", this._rawWsMessageListener);
          wsObj.on("error", this._rawWsErrorHandler);
        }

        this._rawWsObj = wsObj;
      } catch (e) {
        logger.warn("[LavalinkManager] Raw WS setup error:", e.message);
      }
    };

    if (this.lavalink) {
      logger.lavalink("[LavalinkManager] lavalink.sendRawData type: " + typeof this.lavalink.sendRawData);
      logger.lavalink("[LavalinkManager] lavalink players type: " + typeof this.lavalink.players);
      try {
        const pSize = this.lavalink.players?.size ?? this.lavalink.players?.length ?? "unknown";
        logger.lavalink("[LavalinkManager] lavalink players size: " + pSize);
      } catch(_) {}
    }

    attachRawWs();
    client.on(Events.Ready, attachRawWs);
  }

  /** @private Forward a raw payload to the Lavalink node via sendRawData. */
  _forwardToLavalink(payload, guildKey, label) {
    try {
      if (typeof this.lavalink.sendRawData !== "function") {
        logger.error("[LavalinkManager] sendRawData is NOT a function! type=" + typeof this.lavalink.sendRawData);
        return;
      }

      const player = this.lavalink.players?.get?.(guildKey);
      logger.lavalink("[LavalinkManager] _forwardToLavalink " + label +
        " guild=" + guildKey +
        " playerExists=" + !!player +
        " playerConnected=" + (player?.connected ?? "noPlayer"));

      this.lavalink.sendRawData(payload);

      const playerAfter = this.lavalink.players?.get?.(guildKey);
      if (playerAfter) {
        const vs = playerAfter.voiceServer;
        logger.lavalink("[LavalinkManager] After sendRawData(" + label + "):" +
          " voiceServer=" + (vs ? "endpoint=" + (vs.endpoint || "none") : "none") +
          " connected=" + (playerAfter.connected ?? "undefined"));
      } else {
        logger.lavalink("[LavalinkManager] After sendRawData(" + label + "): player not found!");
      }
    } catch (e) {
      logger.error("[LavalinkManager] _forwardToLavalink(" + label + ") error:", e.message, e.stack?.substring(0, 200));
    }
  }


  /**
   * Replay a cached VOICE_SERVER_UPDATE payload to the Lavalink node.
   * @param {string} guildId - The guild ID.
   * @returns {boolean} True if a cached update was found and replayed.
   */
  replayVoiceServerUpdate(guildId) {
    const guildKey = String(guildId);
    const cached = this._cachedVoiceServerUpdates.get(guildKey);
    if (!cached) {
      logger.lavalink("[LavalinkManager] No cached VOICE_SERVER_UPDATE to replay for guild " + guildKey);
      return false;
    }
    try {
      logger.lavalink("[LavalinkManager] Replaying cached VOICE_SERVER_UPDATE for guild " + guildKey);
      this.lavalink.sendRawData(cached);
      return true;
    } catch (e) {
      logger.warn("[LavalinkManager] Replay VOICE_SERVER_UPDATE error:", e.message);
      return false;
    }
  }

/** @async Initialize the Lavalink connection. Sets up session handling, registers node connect listeners, and warns if the node is unreachable after 3 seconds. @returns {Promise<void>} */
  async init() {
    this.setMaxListeners(50);
    try {
      this.lavalink?.setMaxListeners?.(50);
    } catch (e) {
      logger.warn("[Lavalink] init setMaxListeners:", e?.message);
    }

    const cfg = this._nodeCfg;
    logger.lavalink(
      `[Lavalink] Initializing — node: ${cfg?.id ?? "main"} @ ${cfg?.host ?? "localhost"}:${cfg?.port ?? 2333} (secure: ${cfg?.secure ?? false}, type: NodeLink)`
    );

    try {
      this.lavalink.init({
        id:       this._client?.user?.id       ?? "0",
        username: this._client?.user?.username ?? "bot",
      });
    } catch (e) {
      logger.warn("[Lavalink] init error:", e?.message);
    }

    const onNodeConnect = (node) => {
      this._nodeConnected = true;
      try {
        node.updateSession(true, 300_000);
        this._sessionId = node.sessionId ?? this._sessionId;
        logger.lavalink(
          "[Lavalink] Node ready: " + node.id + " | session: " + this._sessionId
        );
        this.emit("ready", this._sessionId);
      } catch (e) {
        logger.warn(
          "[Lavalink] nodeConnect handler error:",
          e?.message
        );
      }
    };

    this.lavalink.on("nodeConnect", onNodeConnect);

    setTimeout(() => {
      if (!this._nodeConnected) {
        const h = cfg?.host || "localhost";
        const p = cfg?.port || 2333;
        logger.warn(
          "[Lavalink] Node at " + h + ":" + p + " is NOT connected yet. " +
          "Make sure your NodeLink/Lavalink server is running. " +
          "The bot will retry when a voice join is attempted."
        );
      }
    }, 3_000);
  }
/** @async Search for tracks on the Lavalink node. Tries player-based search first, then falls back to direct node lookup. @param {string} query - The search query string or URL. @param {object} [options] - Search options. @param {string} [options.source] - Lavalink source identifier (e.g. 'ytmsearch'). @param {string} [options.requester] - Requester identifier. @returns {Promise<object>} Lavalink search result with tracks array. @throws {Error} If no connected node is available. */
  async search(query, options = {}) {
    try {
      const players = this.lavalink?.players;
      if (players?.size > 0) {
        const firstPlayer = players.values?.().next?.().value;
        if (firstPlayer?.node) {
          logger.lavalink("[Lavalink] search via player.node for guild " + firstPlayer.guildId);
          if (options.source) {
            return firstPlayer.node.search({ query, source: options.source });
          }
          return firstPlayer.node.search(query);
        }
      }
    } catch (_) { /* fall through to node-based search */ }

    const node = this._getConnectedNode();
    if (node) {
      logger.lavalink("[Lavalink] search via _getConnectedNode()");
      if (options.source) {
        return node.search({ query, source: options.source });
      }
      return node.search(query);
    }

    try {
      const nodes = this.lavalink?.nodes;
      const nodeId = this._nodeCfg?.id ?? "main";
      const node = nodes?.get?.(nodeId) ?? nodes?.cache?.get?.(nodeId);
      if (node) {
        logger.lavalink("[Lavalink] search via fallback node.get()");
        if (options.source) {
          return node.search({ query, source: options.source });
        }
        return node.search(query);
      }
    } catch (_) {}

    throw new Error("No connected Lavalink node available for search");
  }

/** Get the Lavalink player for a guild. @param {string} guildId - The guild ID. @returns {object|null} The Lavalink player, or null if not found. */
  getPlayer(guildId) {
    return this.lavalink.players.get(String(guildId));
  }

  /** Close all node WebSocket connections and clean up. */
  destroy() {
    try {
      for (const [id, node] of this.lavalink?.nodes?.cache?.entries?.() ?? []) {
        try {
          node.socket?.close?.();
        } catch (e) {
          logger.warn(`[Lavalink] destroy node ${id}:`, e?.message);
        }
      }
    } catch (e) {
      logger.warn("[Lavalink] destroy:", e?.message);
    }
  }

/** Check whether at least one Lavalink node is currently connected. @returns {boolean} */
  hasConnectedNode() {
    return this._nodeConnected === true;
  }

/** @async Wait for a Lavalink node to become connected. Polls at 1-second intervals until connected or timeout. @param {object} [options] - Wait options. @param {number} [options.timeoutMs=15000] - Maximum time to wait in milliseconds. @param {number} [options.intervalMs=1000] - Polling interval in milliseconds. @returns {Promise<void>} Resolves when a node is connected. @throws {Error} If timeout is reached without a connected node. */
  waitForNode(options = {}) {
    const timeoutMs  = options.timeoutMs  ?? 15_000;
    const intervalMs = options.intervalMs ?? 1_000;
    const host = this._nodeCfg?.host || "???";
    const port = this._nodeCfg?.port || 2333;
    const errMsg =
      "[LavalinkManager] No Lavalink node connected after " +
      Math.round(timeoutMs / 1000) + "s. " +
      "Is your NodeLink/Lavalink server running at " + host + ":" + port + "? " +
      "Check: 1) Server is started, 2) Host/port/password are correct in config.json -> nodelink";

    return new Promise((resolve, reject) => {
      if (this._nodeConnected) return resolve();

      let elapsed = 0;
      const timer = setInterval(() => {
        elapsed += intervalMs;
        if (this._nodeConnected) {
          clearInterval(timer);
          return resolve();
        }
        if (elapsed >= timeoutMs) {
          clearInterval(timer);
          reject(new Error(errMsg));
        }
      }, intervalMs);
      timer.unref?.();
    });
  }

/** @private Get a connected Lavalink node, trying multiple strategies (cache, get, leastUsedNodes, leastLoadNodes). @returns {object|null} A connected node instance, or null if none available. */
  _getConnectedNode() {
    try {
      const nodes = this.lavalink?.nodeManager ?? this.lavalink?.nodes;
      if (!nodes) return null;

      let store = nodes.cache ?? null;
      if (store && typeof store.get === "function" && this._nodeConnected) {
        const nodeId = this._nodeCfg?.id ?? "main";
        const node = store.get(nodeId);
        if (node) return node;
        if (store.size > 0) {
          const first = store.values?.().next?.().value;
          if (first) return first;
        }
      }

      if (typeof nodes.get === "function" && this._nodeConnected) {
        const nodeId = this._nodeCfg?.id ?? "main";
        const node = nodes.get(nodeId);
        if (node) return node;
        if (nodes.size > 0) {
          const first = nodes.values?.().next?.().value;
          if (first) return first;
        }
      }

      if (this._nodeConnected) {
        try {
          const arr = nodes.leastUsedNodes?.();
          if (arr?.length) return arr[0];
        } catch (_) {}
        try {
          const arr = nodes.leastLoadNodes?.();
          if (arr?.length) return arr[0];
        } catch (_) {}
      }

      return null;
    } catch (e) {
      return null;
    }
  }

/** Get a connected Lavalink node. Public alias for _getConnectedNode. @returns {object|null} A connected node instance, or null. */
  getNode() {
    return this._getConnectedNode();
  }

  /** @type {string|null} @description Current Lavalink session ID. */
  get sessionId() {
    return this._sessionId;
  }

/**
 * Mark a guild as having a pending leave request so the intercepted op4 leave is allowed through.
 * @param {string} guildId - The guild ID.
 */
  requestLeave(guildId) {
    if (guildId) this._pendingLeaves.add(String(guildId));
  }

/** Get connection info for the configured NodeLink node. Useful for health checks and dashboard display. @returns {{host: string, port: number, sessionId: string|null, secure: boolean, password: string}|null} Connection info object, or null if no config. */
  getNodeLinkInfo() {
    const cfg = this._nodeCfg;
    if (!cfg) return null;
    return {
      host:     cfg.host     ?? "localhost",
      port:     cfg.port     ?? 2333,
      sessionId: this._sessionId ?? null,
      secure:   cfg.secure   ?? false,
      password: cfg.password  ?? "youshallnotpass",
    };
  }
}
