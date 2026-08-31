/** @module constants/Locale */

import { readFileSync, readdirSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "./Logger.mjs";

/** @private */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** @private */
const LOCALES_DIR = path.resolve(__dirname, "../../storage/locales/bot");

/**
 * Locale/i18n manager that loads JSON locale files from disk and provides
 * dot-notation key lookups with `{{placeholder}}` and `$prefix` substitution.
 * @class
 */
export class Locale {
  /**
   * @param {string} [defaultPrefix="%"] - Fallback prefix used when no prefix
   *   resolver is registered and the settings manager yields no prefix.
   */
  constructor(defaultPrefix = "%") {
    /** @private */ this.locales = new Map();
    /** @private */ this._resolved = new Map();
    /** @type {string} */ this.defaultLocale = "en";
    /** @private */ this.settingsMgr = null;
    /** @private */ this._getPrefixFn = null;
    /** @private */ this._defaultPrefix = defaultPrefix;
    /** @private */ this._maxResolvedCache = 5000;
  }

  /**
   * Bind a settings manager so the locale resolver can look up per-guild locale preferences.
   * @param {object} settingsMgr - Settings manager exposing `guilds.get(guildId)`.
   */
  bind(settingsMgr) {
    this.settingsMgr = settingsMgr;
  }

  /**
   * Load all `.json` locale files from the locales directory.
   * Clears any previously loaded data and the resolved-cache.
   */
  load() {
    this.locales.clear();
    this._resolved.clear();

    if (!existsSync(LOCALES_DIR)) {
      logger.warn("[Locale] Locales directory not found:", LOCALES_DIR);
      return;
    }

    let files;
    try {
      files = readdirSync(LOCALES_DIR).filter(f => f.endsWith(".json"));
    } catch (e) {
      logger.warn("[Locale] Failed to read locales directory:", e.message);
      return;
    }

    for (const file of files) {
      const filePath = path.join(LOCALES_DIR, file);
      const code = file.replace(".json", "");
      try {
        const data = JSON.parse(readFileSync(filePath, "utf8"));
        this.locales.set(code, data);
      } catch (e) {
        logger.warn("[Locale] Failed to load " + file + ":", e.message);
      }
    }

    logger.info("[Locale] Loaded " + this.locales.size + " locale(s): " + [...this.locales.keys()].join(", "));
  }

  /**
   * Return the set of loaded locale codes.
   * @returns {Set<string>}
   */
  availableLocales() {
    return new Set(this.locales.keys());
  }

  /**
   * Resolve the locale data object for a guild, using per-guild settings or falling
   * back to the default locale. Results are cached with an LRU-style cap.
   * @private
   * @param {string} guildId
   * @returns {object} The locale data object.
   */
  _getLocaleData(guildId) {
    if (!guildId) return this.locales.get(this.defaultLocale) ?? {};

    const cached = this._resolved.get(guildId);
    if (cached) return cached;

    let code = this.defaultLocale;
    try {
      const serverSettings = this.settingsMgr?.guilds?.get?.(guildId);
      if (serverSettings) {
        const setting = serverSettings.get("locale");
        if (setting && this.locales.has(setting)) {
          code = setting;
        }
      }
    } catch(e) { logger.warn("[Locale] Error:", e?.message); }

    const data = this.locales.get(code) ?? this.locales.get(this.defaultLocale) ?? {};
    this._resolved.set(guildId, data);

    while (this._resolved.size > this._maxResolvedCache) {
      const oldestKey = this._resolved.keys().next().value;
      this._resolved.delete(oldestKey);
    }

    return data;
  }

  /**
   * Invalidate the resolved-cache for a specific guild or all guilds.
   * @param {string} [guildId] - Omit to clear the entire cache.
   */
  invalidateCache(guildId) {
    if (guildId) {
      this._resolved.delete(guildId);
    } else {
      this._resolved.clear();
    }
  }

  /**
   * Register a custom prefix resolver function.
   * @param {function(string): string} fn - Receives `guildId`, returns the prefix string.
   */
  setPrefixResolver(fn) {
    this._getPrefixFn = fn;
  }

  /**
   * Resolve the command prefix for a guild.
   * @private
   * @param {string} guildId
   * @returns {string}
   */
  _getPrefix(guildId) {
    if (this._getPrefixFn) return this._getPrefixFn(guildId);
    try {
      const serverSettings = this.settingsMgr?.getServer?.(guildId);
      if (serverSettings) {
        const prefix = serverSettings.get("prefix");
        if (prefix) return prefix;
      }
    } catch(e) { logger.warn("[Locale] Error:", e?.message); }
    return this._defaultPrefix || "!";
  }

  /**
   * Resolve a dot-notation key against a nested object.
   * @private
   * @param {object} obj
   * @param {string} key - e.g. "commands.play.description"
   * @returns {*}
   */
  _resolve(obj, key) {
    const parts = key.split(".");
    let current = obj;
    for (const part of parts) {
      if (current == null || typeof current !== "object") return undefined;
      current = current[part];
    }
    return current;
  }

  /**
   * Translate a locale key for a guild, applying `{{placeholder}}` replacements
   * and `$prefix` substitution. Falls back to the default locale, then the raw key.
   * @param {string} guildId
   * @param {string} key - Dot-notation locale key.
   * @param {Object<string, *>} [replacements={}] - Placeholder values to substitute.
   * @returns {string} The translated (or fallback) string.
   */
  translate(guildId, key, replacements = {}) {
    const localeData = this._getLocaleData(guildId);

    let value = this._resolve(localeData, key);

    if (value === undefined) {
      value = this._resolve(this.locales.get(this.defaultLocale) ?? {}, key);
    }

    if (value === undefined) return key;
    if (typeof value !== "string") return key;

    for (const [placeholder, val] of Object.entries(replacements)) {
      const escaped = placeholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const replacement = String(val ?? "");
      value = value.replace(
        new RegExp(`\\{\\{${escaped}\\}\\}`, "g"),
        () => replacement
      );
    }

    if (value.includes("$prefix")) {
      const prefix = this._getPrefix(guildId);
      value = value.replace(/\$prefix/gi, prefix);
    }

    return value;
  }
}
