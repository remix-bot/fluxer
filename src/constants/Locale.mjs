import { readFileSync, readdirSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.resolve(__dirname, "../../storage/locales/bot");

/**
 * Lightweight i18n locale loader.
 *
 * Loads all JSON files from storage/locales/bot/ at startup and provides
 * a `t(guildId, key, replacements?)` translation function.
 *
 * Usage in commands (where `this` is the Remix bot instance):
 *   this.t(msg, "responses.play.noResults")
 *   this.t(msg, "responses.clear.cleared", { count: 5 })
 */
export class Locale {
  constructor() {
    /** @type {Map<string, Object>} locale code → parsed JSON */
    this.locales = new Map();
    /** @type {Map<string, Object>} guildId → locale JSON (resolved & cached) */
    this._resolved = new Map();
    /** Default fallback locale */
    this.defaultLocale = "en";
    /** settingsMgr reference — set after construction via bind() */
    this.settingsMgr = null;
  }

  /**
   * Bind a settings manager so translate() can look up per-guild locale settings.
   * @param {object} settingsMgr - RemoteSettingsManager instance
   */
  bind(settingsMgr) {
    this.settingsMgr = settingsMgr;
  }

  /**
   * Load all locale JSON files from the locales directory.
   * Call once at startup after config is available.
   */
  load() {
    this.locales.clear();
    this._resolved.clear();

    if (!existsSync(LOCALES_DIR)) {
      console.warn(`[Locale] Locales directory not found: ${LOCALES_DIR}`);
      return;
    }

    let files;
    try {
      files = readdirSync(LOCALES_DIR).filter(f => f.endsWith(".json"));
    } catch (e) {
      console.warn(`[Locale] Failed to read locales directory: ${e.message}`);
      return;
    }

    for (const file of files) {
      const filePath = path.join(LOCALES_DIR, file);
      const code = file.replace(".json", "");
      try {
        const data = JSON.parse(readFileSync(filePath, "utf8"));
        this.locales.set(code, data);
      } catch (e) {
        console.warn(`[Locale] Failed to load ${file}: ${e.message}`);
      }
    }

    console.log(
      `[Locale] Loaded ${this.locales.size} locale(s): ${[...this.locales.keys()].join(", ")}`
    );
  }

  /**
   * Return the set of available locale codes.
   * Useful for validation (e.g. the settings command).
   * @returns {Set<string>}
   */
  availableLocales() {
    return new Set(this.locales.keys());
  }

  /**
   * Resolve the locale data for a guild.
   * Checks the per-guild "locale" setting from the DB, falls back to English.
   * Results are cached per guildId.
   *
   * @param {string} guildId
   * @returns {Object}
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
    } catch (_) {}

    const data = this.locales.get(code) ?? this.locales.get(this.defaultLocale) ?? {};
    this._resolved.set(guildId, data);
    return data;
  }

  /**
   * Clear the resolved locale cache (call when locale setting changes).
   * @param {string} [guildId] - Specific guild to invalidate, or omit for all.
   */
  invalidateCache(guildId) {
    if (guildId) {
      this._resolved.delete(guildId);
    } else {
      this._resolved.clear();
    }
  }

  /**
   * Look up a dotted key in a nested object.
   * @param {Object} obj
   * @param {string} key  e.g. "responses.play.noResults"
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
   * Translate a key with optional {{placeholder}} replacements.
   *
   * @param {string} guildId
   * @param {string} key        Dotted key, e.g. "responses.play.noResults"
   * @param {Object} [replacements={}]  e.g. { count: 5, channel: "#general" }
   * @returns {string} Translated string, or the key itself if not found
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
      value = value.replace(
        new RegExp(`\\{\\{${escaped}\\}\\}`, "g"),
        String(val ?? "")
      );
    }

    return value;
  }
}
