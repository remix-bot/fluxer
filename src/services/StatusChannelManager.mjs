/**
 * @module src/services/StatusChannelManager
 * @description Dedicated status channel and automated incident management for Remix.
 * Manages two core operational components:
 * 1. A self-editing live status card in a designated Fluxer channel,
 *    reporting real-time gateway latency, active music channels, listeners,
 *    RAM/CPU metrics with visual Unicode progress bars, and subsystem status.
 * 2. An event-driven incident monitor tracking Gateway, Audio Node (NodeLink),
 *    Database, Dashboard, and REST API availability with automatic downtime
 *    calculation and dual-color lifecycle embeds (🔴 Outage / ✅ Resolved).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EmbedBuilder } from "@fluxerjs/core";
import { logger } from "../core/Logger.mjs";

/** @type {string} Default API endpoint for direct REST fallback */
const DEFAULT_API_BASE = "https://fluxer.com/api/v1";

/**
 * @class StatusChannelManager
 * @description Oversees public status notifications and live health telemetry.
 */
export class StatusChannelManager {
  /**
   * @param {object} remix - The main Remix bot instance.
   * @param {object} [config] - The statusChannel config section.
   */
  constructor(remix, config = {}) {
    this.remix = remix;
    this.client = remix.client;
    this.config = config || {};

    this.enabled = this.config.enabled === true;
    this.channelId = typeof this.config.channelId === "string" && this.config.channelId.trim()
      ? this.config.channelId.trim()
      : null;
    this.mentionRoleId = typeof this.config.mentionRoleId === "string" && this.config.mentionRoleId.trim()
      ? this.config.mentionRoleId.trim()
      : null;

    const rawInterval = Number(this.config.updateIntervalSeconds);
    this.updateIntervalMs = Math.max(60, Number.isFinite(rawInterval) && rawInterval > 0 ? rawInterval : 300) * 1000;

    this.statusPageUrl = typeof this.config.statusPageUrl === "string" && this.config.statusPageUrl.trim()
      ? this.config.statusPageUrl.trim()
      : "status.remix.bot";

    this.statePath = path.join(process.cwd(), "storage", "status_card.json");
    this.liveMessageId = typeof this.config.liveMessageId === "string" && this.config.liveMessageId.trim()
      ? this.config.liveMessageId.trim()
      : null;

    this.apiBase = remix.config?.instanceUrl
      ? String(remix.config.instanceUrl).trim().replace(/\/+$/, "")
      : DEFAULT_API_BASE;

    this._timer = null;
    this._dashboardProbeTimer = null;
    this._isUpdating = false;
    this._lastCpuUsage = null;
    this._lastCpuTime = null;

    this.incidents = new Map([
      ["gateway",   { name: "Fluxer Gateway",          down: false, startedAt: 0, impact: "Critical" }],
      ["audioNode", { name: "Audio Engine (NodeLink)", down: false, startedAt: 0, impact: "High"     }],
      ["database",  { name: "Database (MySQL)",       down: false, startedAt: 0, impact: "High"     }],
      ["dashboard", { name: "Web Dashboard",          down: false, startedAt: 0, impact: "Low"      }],
      ["api",       { name: "Fluxer REST API",        down: false, startedAt: 0, impact: "Critical" }],
    ]);

    this._loadState();
  }

  /**
   * Translate a key using the Remix locale system.
   * @param {string} key
   * @param {object} [data]
   * @returns {string}
   */
  t(key, data = {}) {
    return this.remix?.locale?.translate?.(null, key, data) ?? key;
  }

  /**
   * Start the periodic health card update loop and dashboard probing.
   */
  start() {
    if (!this.enabled || !this.channelId) {
      logger.info("[StatusChannel] Disabled (enabled=false or missing channelId).");
      return;
    }

    logger.info(`[StatusChannel] Active — monitoring channel ${this.channelId} (interval: ${this.updateIntervalMs / 1000}s).`);

    /* Initial update delayed slightly so initial connections settle */
    setTimeout(() => {
      this.updateLiveCard().catch((err) => {
        logger.warn("[StatusChannel] Initial live card update failed:", err?.message);
      });
    }, 5000);

    if (this._timer) clearInterval(this._timer);
    this._timer = setInterval(() => {
      this.updateLiveCard().catch((err) => {
        logger.warn("[StatusChannel] Periodic live card update failed:", err?.message);
      });
    }, this.updateIntervalMs);
    this._timer.unref?.();

    this._setupDashboardProbe();
  }

  /**
   * Stop background timers and release resources.
   */
  destroy() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this._dashboardProbeTimer) {
      clearInterval(this._dashboardProbeTimer);
      this._dashboardProbeTimer = null;
    }
  }

  /**
   * Trigger an incident for a given subsystem.
   * @param {"gateway"|"audioNode"|"database"|"dashboard"|"api"} key
   * @param {string} [reason]
   */
  async triggerIncident(key, reason = "") {
    if (!this.enabled || !this.channelId) return;

    const inc = this.incidents.get(key);
    if (!inc || inc.down) return;

    inc.down = true;
    inc.startedAt = Date.now();
    const startedSec = Math.floor(inc.startedAt / 1000);

    const desc = reason || this.t("responses.statusChannel.incidentDefaultDesc", { name: inc.name });

    const embed = new EmbedBuilder()
      .setColor(0xe74c3c)
      .setAuthor({ name: this.t("responses.statusChannel.incidentAuthor") })
      .setTitle(this.t("responses.statusChannel.incidentTitle", { name: inc.name }))
      .setDescription(desc)
      .addFields(
        { name: this.t("responses.statusChannel.startedField"),  value: `<t:${startedSec}:f> (<t:${startedSec}:R>)`, inline: true },
        { name: this.t("responses.statusChannel.statusField"),   value: this.t("responses.statusChannel.investigating"), inline: true },
        { name: this.t("responses.statusChannel.severityField"), value: inc.impact, inline: true }
      )
      .setFooter({ text: `Remix Incident Monitor • ${this.statusPageUrl}` })
      .setTimestamp(new Date());

    const payload = {
      embeds: [embed],
    };
    if (this.mentionRoleId) {
      payload.content = `<@&${this.mentionRoleId}>`;
    }

    try {
      await this._postMessage(payload);
      logger.warn(`[StatusChannel] Incident published for ${inc.name}: ${desc}`);
    } catch (err) {
      logger.warn(`[StatusChannel] Failed to post incident for ${inc.name}:`, err?.message);
    }

    /* Force an immediate edit on the live card to reflect degraded/critical state */
    this.updateLiveCard().catch(() => {});
  }

  /**
   * Resolve an ongoing incident for a given subsystem.
   * @param {"gateway"|"audioNode"|"database"|"dashboard"|"api"} key
   * @param {string} [resolutionNote]
   */
  async resolveIncident(key, resolutionNote = "") {
    if (!this.enabled || !this.channelId) return;

    const inc = this.incidents.get(key);
    if (!inc || !inc.down) return;

    const resolvedAt = Date.now();
    const durationMs = Math.max(1000, resolvedAt - (inc.startedAt || resolvedAt));
    inc.down = false;
    inc.startedAt = 0;

    const resolvedSec = Math.floor(resolvedAt / 1000);
    const downtimeStr = this._formatDuration(durationMs);
    const desc = resolutionNote || this.t("responses.statusChannel.resolvedDefaultDesc", { name: inc.name });

    const embed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setAuthor({ name: this.t("responses.statusChannel.resolvedAuthor") })
      .setTitle(this.t("responses.statusChannel.resolvedTitle", { name: inc.name }))
      .setDescription(desc)
      .addFields(
        { name: this.t("responses.statusChannel.downtimeField"), value: `**${downtimeStr}**`, inline: true },
        { name: this.t("responses.statusChannel.resolvedField"), value: `<t:${resolvedSec}:f> (<t:${resolvedSec}:R>)`, inline: true },
        { name: this.t("responses.statusChannel.statusField"),   value: this.t("responses.statusChannel.stable"), inline: true }
      )
      .setFooter({ text: `Remix Incident Monitor • ${this.statusPageUrl}` })
      .setTimestamp(new Date());

    try {
      await this._postMessage({ embeds: [embed] });
      logger.info(`[StatusChannel] Incident resolved for ${inc.name} (Downtime: ${downtimeStr})`);
    } catch (err) {
      logger.warn(`[StatusChannel] Failed to post incident resolution for ${inc.name}:`, err?.message);
    }

    /* Update live card back to operational */
    this.updateLiveCard().catch(() => {});
  }

  /**
   * Build and update the live status card in the configured channel.
   * @returns {Promise<void>}
   */
  async updateLiveCard() {
    if (!this.enabled || !this.channelId || this._isUpdating) return;
    this._isUpdating = true;

    try {
      const embed = this._buildLiveCardEmbed();

      if (this.liveMessageId) {
        try {
          await this._patchMessage(this.liveMessageId, { embeds: [embed] });
          return;
        } catch (err) {
          const status = err?.statusCode ?? err?.status;
          /* If message was deleted (404), fall through to post a fresh one */
          if (status !== 404) {
            logger.warn("[StatusChannel] Failed to patch status card:", err?.message);
            return;
          }
          this.liveMessageId = null;
        }
      }

      /* Post a new live card message and persist ID */
      const sent = await this._postMessage({ embeds: [embed] });
      const newId = sent?.id ?? sent?.message?.id ?? null;
      if (newId) {
        this.liveMessageId = String(newId);
        this._saveState();
        logger.info(`[StatusChannel] New status card created (ID: ${this.liveMessageId})`);
      }
    } finally {
      this._isUpdating = false;
    }
  }

  /**
   * Constructs the live status embed with current system and bot metrics.
   * @private
   * @returns {EmbedBuilder}
   */
  _buildLiveCardEmbed() {
    const ping = Math.round(Number(this.client?.ws?.ping ?? this.client?.ping ?? 0));
    const uptimeMs = process.uptime() * 1000;
    const uptimeStr = this._formatUptime(uptimeMs);

    /* Active music playback metrics */
    const playerMap = this.remix.players?.playerMap;
    const activePlayers = playerMap ? [...new Set(playerMap.values())].filter((p) => p && !p._destroyed && !p.leaving).length : 0;
    let totalListeners = 0;
    if (playerMap) {
      for (const p of playerMap.values()) {
        if (!p || p._destroyed) continue;
        const members = p.getVoiceMembers?.();
        if (Array.isArray(members)) {
          totalListeners += members.filter((m) => !m.bot).length;
        }
      }
    }

    /* Hardware metrics */
    const mem = this._getMemoryInfo();
    const cpuPct = this._getCpuUsagePercent();
    const cpuCores = os.cpus()?.length || 1;
    const ramBar = this._createProgressBar(mem.systemPct, 10);
    const cpuBar = this._createProgressBar(cpuPct, 10);

    /* Subsystem status synthesis */
    const { list: subsystems, overallState } = this._getSubsystemsHealth();

    let color = 0x2ecc71;
    let stateBadge = this.t("responses.statusChannel.operationalDesc");
    if (overallState === "critical") {
      color = 0xe74c3c;
      stateBadge = this.t("responses.statusChannel.criticalDesc");
    } else if (overallState === "degraded") {
      color = 0xf1c40f;
      stateBadge = this.t("responses.statusChannel.degradedDesc");
    }

    const guildCount = this.client?.guilds?.cache?.size ?? this.client?.guilds?.size ?? 0;
    const intervalSec = Math.round(this.updateIntervalMs / 1000);

    const embed = new EmbedBuilder()
      .setColor(color)
      .setAuthor({
        name: this.t("responses.statusChannel.liveCardAuthor"),
        icon_url: this.client?.user?.avatarURL?.() ?? null,
      })
      .setTitle(this.t("responses.statusChannel.liveCardTitle"))
      .setDescription(stateBadge)
      .addFields(
        { name: this.t("responses.statusChannel.gatewayField"),   value: `${ping > 0 ? ping : "< 1"} ms`, inline: true },
        { name: this.t("responses.statusChannel.uptimeField"),    value: uptimeStr, inline: true },
        { name: this.t("responses.statusChannel.sessionsField"),  value: `${activePlayers} active (${totalListeners} listeners)`, inline: true },
        { name: this.t("responses.statusChannel.ramField"),       value: `\`${ramBar}\` ${mem.systemPct}%\n${mem.rssMb} MB / ${mem.totalMemMb} MB`, inline: true },
        { name: this.t("responses.statusChannel.cpuField"),       value: `\`${cpuBar}\` ${cpuPct}%\n${cpuCores} cores available`, inline: true },
        { name: this.t("responses.statusChannel.guildsField"),    value: `${guildCount.toLocaleString()} communities`, inline: true },
        {
          name: this.t("responses.statusChannel.subsystemsField"),
          value: subsystems.map((s) => `• **${s.name}**: ${s.status}`).join("\n"),
          inline: false,
        }
      )
      .setFooter({ text: `Auto-updates every ${intervalSec}s • ${this.statusPageUrl}` })
      .setTimestamp(new Date());

    return embed;
  }

  /**
   * Computes the health overview of monitored dependencies.
   * @private
   * @returns {{list: Array<{name: string, status: string}>, overallState: "operational"|"degraded"|"critical"}}
   */
  _getSubsystemsHealth() {
    let hasCriticalDown = false;
    let hasMinorDown = false;
    const list = [];

    for (const [key, inc] of this.incidents) {
      if (key === "dashboard" && !this.remix.config?.dashboard?.enabled) {
        list.push({ name: inc.name, status: `⚪ ${this.t("responses.statusChannel.disabled")}` });
        continue;
      }
      if (inc.down) {
        list.push({ name: inc.name, status: `🔴 ${this.t("responses.statusChannel.outage")}` });
        if (inc.impact === "Critical") hasCriticalDown = true;
        else hasMinorDown = true;
      } else {
        list.push({ name: inc.name, status: `🟢 ${this.t("responses.statusChannel.operational")}` });
      }
    }

    let overallState = "operational";
    if (hasCriticalDown) overallState = "critical";
    else if (hasMinorDown) overallState = "degraded";

    return { list, overallState };
  }

  /**
   * Background probe for the Web Dashboard if enabled.
   * @private
   */
  _setupDashboardProbe() {
    if (!this.remix.config?.dashboard?.enabled) return;

    const probe = async () => {
      try {
        const port = this.remix.dashboard?.port || 3000;
        const res = await fetch(`http://127.0.0.1:${port}/`, {
          signal: AbortSignal.timeout(4000),
        });
        if (res.ok || res.status === 401 || res.status === 403 || res.status === 302) {
          this.resolveIncident("dashboard");
        } else {
          this.triggerIncident("dashboard", `Dashboard HTTP check returned status ${res.status}`);
        }
      } catch (err) {
        this.triggerIncident("dashboard", `Dashboard is unreachable (${err?.message})`);
      }
    };

    this._dashboardProbeTimer = setInterval(probe, 60_000);
    this._dashboardProbeTimer.unref?.();
  }

  /**
   * Helper to format millisecond durations into clean time strings.
   * @private
   * @param {number} ms
   * @returns {string}
   */
  _formatDuration(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  /**
   * Formats process uptime into human-readable strings.
   * @private
   * @param {number} ms
   * @returns {string}
   */
  _formatUptime(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(totalSec / 86400);
    const h = Math.floor((totalSec % 86400) / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  /**
   * Generate a visual Unicode progress bar.
   * @private
   * @param {number} percent
   * @param {number} [length=10]
   * @returns {string}
   */
  _createProgressBar(percent, length = 10) {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    const filled = Math.round((clamped / 100) * length);
    const empty = Math.max(0, length - filled);
    return "█".repeat(filled) + "░".repeat(empty);
  }

  /**
   * Measures delta CPU percentage over the elapsed update window.
   * @private
   * @returns {number}
   */
  _getCpuUsagePercent() {
    const currentUsage = process.cpuUsage();
    const now = Date.now();
    if (!this._lastCpuUsage || !this._lastCpuTime) {
      this._lastCpuUsage = currentUsage;
      this._lastCpuTime = now;
      return 0;
    }
    const elapsedMs = now - this._lastCpuTime;
    const userDiff = (currentUsage.user - this._lastCpuUsage.user) / 1000;
    const sysDiff = (currentUsage.system - this._lastCpuUsage.system) / 1000;
    const totalDiff = userDiff + sysDiff;

    this._lastCpuUsage = currentUsage;
    this._lastCpuTime = now;

    if (elapsedMs <= 0) return 0;
    const cores = os.cpus()?.length || 1;
    return Math.min(100, Math.max(0, Math.round((totalDiff / (elapsedMs * cores)) * 100)));
  }

  /**
   * Memory statistics for the host and current process.
   * @private
   * @returns {{rssMb: number, totalMemMb: number, systemPct: number}}
   */
  _getMemoryInfo() {
    const mem = process.memoryUsage();
    const rssMb = Math.round(mem.rss / (1024 * 1024));
    const totalMemMb = Math.round(os.totalmem() / (1024 * 1024));
    const freeMemMb = Math.round(os.freemem() / (1024 * 1024));
    const usedSys = Math.max(0, totalMemMb - freeMemMb);
    const systemPct = Math.min(100, Math.max(0, Math.round((usedSys / totalMemMb) * 100)));
    return { rssMb, totalMemMb, systemPct };
  }

  /**
   * Normalizes payload for client REST or raw fetch calls.
   * @private
   * @param {object} data
   * @returns {object}
   */
  _normalizePayload(data) {
    if (data && typeof data === "object") {
      if (Array.isArray(data.embeds)) {
        return {
          ...data,
          embeds: data.embeds.map((e) => (typeof e?.toJSON === "function" ? e.toJSON() : e)),
        };
      }
      if (data.embed) {
        const raw = typeof data.embed.toJSON === "function" ? data.embed.toJSON() : data.embed;
        return { embeds: [raw] };
      }
      if (typeof data.toJSON === "function") {
        return { embeds: [data.toJSON()] };
      }
      return data;
    }
    return { content: String(data ?? "") };
  }

  /**
   * Post a message to the status channel with raw fetch fallback.
   * @private
   * @param {object} payload
   * @returns {Promise<object>}
   */
  async _postMessage(payload) {
    const body = this._normalizePayload(payload);
    const rest = this.client?.rest;
    if (typeof rest?.post === "function") {
      return await rest.post(`/channels/${this.channelId}/messages`, { body });
    }
    const token = this.client?.token || this.remix.config?.token;
    const res = await fetch(`${this.apiBase}/channels/${this.channelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json().catch(() => ({}));
  }

  /**
   * Patch an existing message in the status channel with raw fetch fallback.
   * @private
   * @param {string} messageId
   * @param {object} payload
   * @returns {Promise<object>}
   */
  async _patchMessage(messageId, payload) {
    const body = this._normalizePayload(payload);
    const rest = this.client?.rest;
    if (typeof rest?.patch === "function") {
      return await rest.patch(`/channels/${this.channelId}/messages/${messageId}`, { body });
    }
    const token = this.client?.token || this.remix.config?.token;
    const res = await fetch(`${this.apiBase}/channels/${this.channelId}/messages/${messageId}`, {
      method: "PATCH",
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json().catch(() => ({}));
  }

  /**
   * Load persisted card ID from disk.
   * @private
   */
  _loadState() {
    try {
      if (fs.existsSync(this.statePath)) {
        const raw = fs.readFileSync(this.statePath, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed?.liveMessageId) {
          this.liveMessageId = String(parsed.liveMessageId).trim();
        }
      }
    } catch (_) {}
  }

  /**
   * Save card ID to disk.
   * @private
   */
  _saveState() {
    try {
      const dir = path.dirname(this.statePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        this.statePath,
        JSON.stringify(
          {
            liveMessageId: this.liveMessageId,
            updatedAt: new Date().toISOString(),
          },
          null,
          2
        ),
        "utf8"
      );
    } catch (_) {}
  }
}

export default StatusChannelManager;