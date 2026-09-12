/**
 * @module commands/settings/setters
 * @description Value application (applySet) and
 * shortcut dispatch (handleShortcut) for the settings command. Bodies are
 * verbatim from the original single-file command.
 */


import { cleanId, getMessageGuildId } from "../../src/ui/index.mjs";
import runnables from "../../settings/runnables.mjs";
import {
  parseBool, displayValue, getGuildName, embed, tWrap, prettifySettingLabel,
  BOOL_SETTINGS, VALID_LOCALES, VOLUME_MIN, VOLUME_MAX, PREFIX_MAX, SHORTCUTS,
  VOTE_SKIP_THRESHOLD_MIN, VOTE_SKIP_THRESHOLD_MAX,
} from "./utils.mjs";
import {
  get247Channels, save247Channels, build247Panel, disable247, handle247Toggle,
} from "./channels247.mjs";

/**
 * Apply a new value to a setting, with type-specific validation.
 * @param {object} ctx - The bot (Remix) context.
 * @param {object} message - The command message.
 * @param {ServerSettings} set - The guild settings instance.
 * @param {string} key - The setting key.
 * @param {string} rawValue - The raw string value from the command.
 * @returns {Promise<string|null>} Error message string, or null on success.
 */
export async function applySet(ctx, message, set, key, rawValue) {
  if (BOOL_SETTINGS.has(key)) {
    const bool = parseBool(rawValue);
    if (bool === null) {
      return ctx.t(message, "responses.settings.mustBeBool", { setting: key });
    }
    set.set(key, bool);
    return null;
  }

  if (key === "volume") {
    const num = parseInt(rawValue, 10);
    if (isNaN(num) || num < VOLUME_MIN || num > VOLUME_MAX) {
      return ctx.t(message, "responses.settings.volumeRange");
    }
    set.set(key, num);
    return null;
  }

  if (key === "voteSkipThreshold") {
    const num = parseInt(rawValue, 10);
    if (isNaN(num) || num < VOTE_SKIP_THRESHOLD_MIN || num > VOTE_SKIP_THRESHOLD_MAX) {
      return ctx.t(message, "responses.settings.voteSkipThresholdRange", {
        min: VOTE_SKIP_THRESHOLD_MIN,
        max: VOTE_SKIP_THRESHOLD_MAX,
      });
    }
    set.set(key, num);
    return null;
  }

  if (key === "locale") {
    if (!VALID_LOCALES.has(rawValue)) {
      return ctx.t(message, "responses.settings.invalidLocale", {
          locale: rawValue,
          locales: [...VALID_LOCALES].map(l => "`" + l + "`").join(", ")
      });
    }
    set.set(key, rawValue);
    const gid = getMessageGuildId(message);
    if (gid) ctx.locale.invalidateCache(gid);
    return null;
  }

  if (key === "prefix") {
    if (!rawValue || rawValue.length > PREFIX_MAX) {
      return ctx.t(message, "responses.settings.prefixLength");
    }
    if (/\s/.test(rawValue)) {
      return ctx.t(message, "responses.settings.prefixSpaces");
    }
  }

  if (runnables[key]) {
    const err = runnables[key].call(ctx, rawValue, { msg: message });
    if (err) return "\u274c " + err;
  }

  set.set(key, rawValue);
  return null;
}
/**
 * @private
 * @async
 * Handle a settings shortcut command (e.g. `prefix`, `247`).
 * Dispatches to 24/7 toggle, value display, or value set depending on arguments.
 * @param {object} ctx - The bot (Remix) context.
 * @param {object} message - The command message.
 * @param {string} settingKey - The resolved setting key.
 * @param {string[]} valueTokens - Remaining argument tokens after the shortcut alias.
 * @returns {Promise<void>}
 */
export async function handleShortcut(ctx, message, settingKey, valueTokens) {
  const set     = ctx.getSettings(message);
  const guildId = getMessageGuildId(message);
  const t247    = ctx.locale?.translate?.bind(ctx.locale);

  if (valueTokens.length === 0) {
    if (settingKey === "stay_247") {
      return handle247Toggle(ctx, message, set, guildId);
    }
    const val   = set.get(settingKey);
    const label = prettifySettingLabel(settingKey, t247, guildId);
    return message.reply(embed("**" + label + "**\nValue: " + displayValue(settingKey, val)));
  }

  const rawValue = valueTokens.join(" ");

  if (settingKey === "stay_247") {
    const mode = rawValue.toLowerCase().trim();
    if (mode === "off" || mode === "false" || mode === "disable" || mode === "0") {
      const loc = tWrap(ctx, guildId);
      const panelKey = (k, vars = {}) => loc("responses.settings.247Panel." + k, vars);
      if (!guildId) return message.reply(embed(loc("responses.settings.noServer")));
      const { channelId } = await ctx.players.checkVoiceChannels(message);
      if (channelId) {
        await disable247(ctx, set, guildId, channelId);
        return message.reply(embed(
            panelKey("confirmDisabled", { channel: "<#" + cleanId(channelId) + ">" }) + "\n\n" +
            loc("responses.settings.247Disabled", { channel: cleanId(channelId), prefix: ctx.handler.getPrefix(guildId) }),
            { title: panelKey("title") }
        ));
      }
      for (const [chId, player] of [...ctx.players.playerMap.entries()]) {
        if (cleanId(player?._guildId ?? "") === cleanId(guildId)) {
          const activeId = cleanId(player._channelId ?? chId);
          ctx.markIntentionalLeave?.(activeId);
          ctx.players.playerMap.delete(activeId);
          if (activeId !== chId) ctx.players.playerMap.delete(chId);
          await player.leave().catch(() => {});
          player.destroy();
        }
      }
      save247Channels(set, new Set());
      return message.reply(embed(
          panelKey("confirmDisabledAll") + "\n\n" +
          loc("responses.settings.247DisabledAll"),
          { title: panelKey("title") }
      ));
    }
    return handle247Toggle(ctx, message, set, guildId);
  }

  const err = await applySet(ctx, message, set, settingKey, rawValue);
  if (err) return message.reply(embed(err));

  const val   = set.get(settingKey);
  const label = prettifySettingLabel(settingKey, t247, guildId);
  return message.reply(embed(ctx.t(message, "responses.settings.setSuccess", { label, value: displayValue(settingKey, val) })));
}
