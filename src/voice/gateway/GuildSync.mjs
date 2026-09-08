/**
 * @module src/voice/gateway/GuildSync
 * @description Guild synchronisation concern for {@link GatewayHandler}:
 * bot permission checks on guild create, voice-state cache seeding
 * (VoiceManager, guild cache, VoiceStateCache, LiveKit participants), REST
 * guild-cache stubbing for guilds without GUILD_CREATE, and confirmed
 * guild-delete cleanup.
 *
 * These methods are applied onto the GatewayHandler class prototype via
 * {@link applyMixins} — `this` is a GatewayHandler instance.
 */

import { getVoiceManager } from "@fluxerjs/voice";
import { logger } from "../../core/Logger.mjs";
import { REQUIRED_BOT_PERMISSIONS } from "../../ui/index.mjs";
import { cleanId } from "../../utils/Utils.mjs";
import { iterateVoiceStates } from "../VoiceStateResolver.mjs";

/**
 * @type {object}
 * @description Guild sync mixin — applied to GatewayHandler.
 */
const GuildSync = {
  /**
   * Check and warn about missing bot permissions in a guild.
   * Sends an embed to the system channel if critical or optional perms are missing.
   * @param {object} guild - The guild object.
   * @param {string} guildId - The guild ID.
   * @returns {Promise<void>}
   * @private
   */
  async _checkGuildPermissions(guild, guildId) {
    const { remix } = this;

    try {
      if (guild.members && !guild.members.me) {
        await guild.members.fetchMe();
      }
    } catch (e) { logger.warn("[GatewayHandler] fetchMe failed:", e?.message); }

    const channels = guild.channels;
    if (!channels) return;

    let targetChannel = null;
    if (guild.systemChannelId) {
      targetChannel = channels.get?.(guild.systemChannelId) ?? null;
    }
    if (!targetChannel) {
      for (const ch of (channels.values?.() ?? [])) {
        if (ch.isTextBased?.() || ch.type === 0 || ch.type === "GUILD_TEXT") {
          targetChannel = ch;
          break;
        }
      }
    }
    if (!targetChannel) return;

    const result = remix.messages.checkAllBotPermissions(targetChannel);
    if (result.missing.length === 0) return;

    const missingNames = result.missing.map(k => REQUIRED_BOT_PERMISSIONS.get(k)?.name ?? k);
    if (result.criticalMissing.length > 0) {
      logger.warn(
          `[GuildCreate] Server ${guildId} is missing CRITICAL bot permissions: ${result.criticalMissing.join(", ")}\n` +
          `  All missing: ${missingNames.join(", ")}`
      );
    } else {
      logger.guild(
          `[GuildCreate] Server ${guildId} is missing optional permissions: ${result.optionalMissing.join(", ")}`
      );
    }

    try {
      const permEmbed = remix.messages.buildPermissionEmbed(result.missing, guildId);
      await targetChannel.send({ embeds: [permEmbed], allowedMentions: { parse: [] } });
    } catch (e) {
      logger.warn(`[GuildCreate] Cannot send permission warning to server ${guildId}: ${e.message}`);
      try {
        const t = this.remix.locale?.translate?.bind(this.remix.locale);
        const guildIdStr = cleanId(guildId);
        await targetChannel.send({
          content: t ? t(guildIdStr, "responses.gateway.missingPermsFallback", { perms: missingNames.join("**, **") }) :
            "⚠️ I'm missing permissions I need to work properly! Missing: **" + missingNames.join("**, **") + "**. Please ask a server administrator to grant these permissions in Server Settings → Roles.",
          allowedMentions: { parse: [] },
        });
      } catch (e) {
        logger.warn(`[GuildCreate] Cannot send ANY notification to server ${guildId} — bot is missing SendMessages permission:`, e?.message);
      }
    }
  },

  /**
   * Seed the voice state cache from VoiceManager or guild cache on startup.
   * @private
   */
  seedVoiceStatesFromGuilds() {
    const { remix } = this;
    const client = remix.client;

    try {
      const vm = getVoiceManager(client);
      if (vm?.voiceStates && vm.voiceStates.size > 0) {
        let totalHumans = 0;
        let totalBots = 0;
        for (const [guildId, userMap] of vm.voiceStates) {
          if (!userMap || typeof userMap.forEach !== "function") continue;
          const cleanGuildId = cleanId(guildId);
          if (!cleanGuildId) continue;
          userMap.forEach((channelId, userId) => {
            if (!userId || !channelId) return;
            const botId = client.user?.id;
            if (userId === botId) {
              remix.voiceCache.updateUser({ guildId: cleanGuildId, userId, channelId, isBot: true });
              totalBots++;
            } else {
              const guild = client.guilds.get(cleanGuildId) ?? client.guilds.get(guildId);
              const member = guild?.members?.get?.(userId);
              const isBot = member?.user?.bot ?? false;
              remix.voiceCache.updateUser({ guildId: cleanGuildId, userId, channelId, isBot });
              if (isBot) totalBots++;
              else totalHumans++;
            }
          });
        }
        logger.voiceState(
            `[Seed] Seeded from VoiceManager.voiceStates — ` +
            `${totalHumans} humans, ${totalBots} bots across ${vm.voiceStates.size} guilds. ` +
            `Cache now: ${remix.voiceCache.observedVoiceUsersSize} humans, ${remix.voiceCache.observedVoiceBotsSize} bots.`
        );
        return;
      }
      logger.voiceState(`[Seed] VoiceManager.voiceStates is empty (${vm?.voiceStates?.size ?? "null"} guilds). ` +
          `This is expected if no users were in voice when the bot started. ` +
          `VoiceStatesSync handler will populate the cache as guilds become available.`);
    } catch (e) {
      logger.voiceState(`[Seed] VoiceManager seeding failed: ${e?.message} — falling back to guild cache.`);
    }

    for (const [gId, guild] of client.guilds) {
      for (const vs of iterateVoiceStates(guild)) {
        remix.voiceCache.updateUser({ guildId: gId, userId: vs.userId, channelId: vs.channelId, isBot: vs.isBot });
      }
    }
  },

  /**
   * Re-seed voice states for a specific channel from multiple sources.
   * Checks VoiceManager, guild cache, VoiceStateCache, and LiveKit participants.
   * @param {string} guildId - The guild ID.
   * @param {string} channelId - The channel ID.
   * @returns {number} Number of humans found in the channel.
   */
  reseedVoiceStatesForChannel(guildId, channelId) {
    const { remix } = this;
    const client = remix.client;

    const cleanGuild   = cleanId(guildId);
    const cleanChannel = cleanId(channelId);
    if (!cleanGuild || !cleanChannel) return 0;

    let humansFound = 0;
    const botId = client.user?.id;

    try {
      const vm = getVoiceManager(client);
      if (vm?.voiceStates) {
        const guildVoiceMap = vm.voiceStates.get(cleanGuild) ?? vm.voiceStates.get(guildId);
        if (guildVoiceMap && typeof guildVoiceMap.forEach === "function") {
          guildVoiceMap.forEach((userChannelId, userId) => {
            if (!userId || !userChannelId) return;
            const userChannel = cleanId(userChannelId);
            if (userChannel !== cleanChannel) return;
            if (userId === botId) {
              remix.voiceCache.updateUser({ guildId: cleanGuild, userId, channelId: cleanChannel, isBot: true });
            } else {
              const guild = client.guilds.get(cleanGuild) ?? client.guilds.get(guildId);
              const member = guild?.members?.get?.(userId);
              const isBot = member?.user?.bot ?? false;
              if (isBot) {
                remix.voiceCache.updateUser({ guildId: cleanGuild, userId, channelId: cleanChannel, isBot: true });
              } else {
                remix.voiceCache.updateUser({ guildId: cleanGuild, userId, channelId: cleanChannel, isBot: false });
                humansFound++;
                logger.voiceState(
                    `[Reseed] Found human ${userId} in channel ${cleanChannel} (guild ${cleanGuild}) via VoiceManager`
                );
              }
            }
          });

          if (botId) {
            remix.voiceCache.updateUser({ guildId: cleanGuild, userId: botId, channelId: cleanChannel, isBot: true });
          }

          logger.voiceState(
              `[Reseed] Channel ${cleanChannel} (guild ${cleanGuild}): ` +
              `found ${humansFound} human(s) via VoiceManager, observedVoiceUsers size now ${remix.voiceCache.observedVoiceUsersSize}`
          );

          if (humansFound > 0) return humansFound;
        }
      }
    } catch (e) {
      logger.voiceState(`[Reseed] VoiceManager lookup failed: ${e?.message} — falling back.`);
    }

    const guild = client.guilds.get(cleanGuild) ?? client.guilds.get(guildId);
    if (!guild) {
      logger.voiceState(
          `[Reseed] Guild ${cleanGuild} not in cache — cannot reseed voice states.`
      );
    } else {
      for (const vs of iterateVoiceStates(guild)) {
        if (vs.isBot) continue;
        if (vs.channelId === cleanChannel) {
          remix.voiceCache.updateUser({ guildId: cleanGuild, userId: vs.userId, channelId: vs.channelId, isBot: false });
          humansFound++;
          logger.voiceState(
              `[Reseed] Found human ${vs.userId} in channel ${cleanChannel} (guild ${cleanGuild})`
          );
        }
      }

      if (botId) {
        remix.voiceCache.updateUser({ guildId: cleanGuild, userId: botId, channelId: cleanChannel, isBot: true });
      }

      if (humansFound > 0) {
        logger.voiceState(
            `[Reseed] Channel ${cleanChannel} (guild ${cleanGuild}): ` +
            `found ${humansFound} human(s), observedVoiceUsers size now ${remix.voiceCache.observedVoiceUsersSize}`
        );
        return humansFound;
      }
    }

    if (humansFound === 0 && remix.voiceCache) {
      const humans = remix.voiceCache.getHumansInChannel(cleanGuild, cleanChannel);
      for (const uid of humans) {
        humansFound++;
        logger.voiceState(
            `[Reseed] Found human ${uid} in channel ${cleanChannel} (guild ${cleanGuild}) via VoiceStateCache`
        );
      }

      if (botId) {
        remix.voiceCache.updateUser({ guildId: cleanGuild, userId: botId, channelId: cleanChannel, isBot: true });
      }
    }

    if (humansFound === 0) {
      try {
        const player = remix.players.playerMap.get(cleanChannel);
        const room = player?.connection?.room;
        if (room?.isConnected && room.remoteParticipants) {
          for (const [, participant] of room.remoteParticipants) {
            const userId = participant?.identity ?? participant?.sid;
            if (userId) {
              humansFound++;
              remix.voiceCache.updateUser({ guildId: cleanGuild, userId, channelId: cleanChannel, isBot: false });
              logger.voiceState(
                  `[Reseed] Found human ${userId} in channel ${cleanChannel} (guild ${cleanGuild}) via LiveKit participants`
              );
            }
          }
        }
      } catch (e) {
        logger.voiceState(`[Reseed] LiveKit participant fallback error: ${e?.message}`);
      }
    }

    logger.voiceState(
        `[Reseed] Channel ${cleanChannel} (guild ${cleanGuild}): ` +
        `found ${humansFound} human(s), observedVoiceUsers size now ${remix.voiceCache.observedVoiceUsersSize}`
    );

    return humansFound;
  },

  /** @async @private Fetch all guilds the bot is in via REST and create stub entries in the client cache for any missing guilds. This ensures settings and 24/7 lookups work even for guilds that haven't sent GUILD_CREATE yet. */
  async seedGuildsFromRest() {
    const { remix } = this;
    const client    = remix.client;

    try {
      let after = null;
      let added = 0;

      while (true) {
        const url   = "/users/@me/guilds?limit=200" + (after ? "&after=" + after : "");
        const chunk = await client.rest.get(url);

        if (!Array.isArray(chunk) || chunk.length === 0) break;

        for (const g of chunk) {
          const id = g?.id;
          if (!id) continue;
          if (!client.guilds.has(id)) {
            try {
              const Guild = this._getGuildClass();
              if (Guild) {
                const stub = new Guild(client, { id, name: g.name ?? "unknown" });
                stub._stub = true;
                client.guilds.set(id, stub);
              } else {
                client.guilds.set(id, {
                  id,
                  name: g.name ?? "unknown",
                  _stub: true,
                  members: { set: () => {}, get: () => undefined, has: () => false, me: null },
                  channels: { set: () => {}, get: () => undefined, has: () => false },
                  roles: { set: () => {}, get: () => undefined, has: () => false },
                  emojis: { set: () => {}, get: () => undefined, has: () => false },
                  stickers: { set: () => {}, get: () => undefined, has: () => false },
                });
              }
            } catch (stubErr) {
              logger.guild(`[GuildSeed] Guild constructor failed for ${id}, using safe stub: ${stubErr?.message}`);
              client.guilds.set(id, {
                id,
                name: g.name ?? "unknown",
                _stub: true,
                members: { set: () => {}, get: () => undefined, has: () => false, me: null },
                channels: { set: () => {}, get: () => undefined, has: () => false },
                roles: { set: () => {}, get: () => undefined, has: () => false },
                emojis: { set: () => {}, get: () => undefined, has: () => false },
                stickers: { set: () => {}, get: () => undefined, has: () => false },
              });
            }
            added++;
          }
        }

        if (chunk.length < 200) break;
        after = chunk[chunk.length - 1].id;
      }

      if (added > 0) {
        logger.guild(`[GuildSeed] Added ${added} missing guild stub(s) from REST. Total: ${client.guilds.size}`);
      } else {
        logger.guild(`[GuildSeed] All guilds already cached. Total: ${client.guilds.size}`);
      }
    } catch (err) {
      logger.warn("[GuildSeed] REST guild seeding failed:", err?.message ?? err);
    }
  },

  /** @private @returns {Function|null} The Guild constructor class. */
  _getGuildClass() {
    if (this._GuildClass) return this._GuildClass;
    try {
      const { client } = this.remix;
      for (const guild of client.guilds.values()) {
        if (guild && !guild._stub && typeof guild.constructor === 'function' && guild.constructor.name === 'Guild') {
          this._GuildClass = guild.constructor;
          return this._GuildClass;
        }
      }
    } catch(e) { logger.warn("[Gateway] _getGuildClass failed:", e?.message); }
    this._GuildClass = null;
    return null;
  },

  /**
   * Process a confirmed guild deletion. Cleans up voice cache and previous state.
   * Does NOT delete 24/7 settings (preserved for re-invite).
   * @param {string} guildId - The deleted guild ID.
   * @private
   */
  _processGuildDelete(guildId) {
    const { remix } = this;
    const cleanGuildId = cleanId(guildId);

    logger.guild(
        `[GuildDelete] Received GuildDelete for server ${guildId} — ` +
        `skipping removal (24/7 removal system disabled). ` +
        `Settings and players are preserved. If the server truly removed the bot, ` +
        `the GuildCreate handler will re-initialise on re-invite.`
    );

    remix.voiceCache.removeGuild(cleanGuildId);
    for (const [stateKey, info] of [...this._prevVoiceState]) {
      if (cleanId(info.guildId) === cleanGuildId)
        this._prevVoiceState.delete(stateKey);
    }
    remix._announcementChannelCache?.delete(guildId);
  },
};

export default GuildSync;
export { GuildSync };
