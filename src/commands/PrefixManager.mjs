/**
 * @module src/commands/PrefixManager
 * @description Per-guild command prefix resolution (guild setting → config → "%").
 */

/**
 * @class PrefixManager
 * @description Manages per-guild command prefixes, falling back to the
 * configured prefix and finally to "%".
 */
export class PrefixManager {
  /** @type {import('../db/Settings.mjs').RemoteSettingsManager} */
  settings;
  /** @type {string|null} */
  configPrefix;

  /**
   * @param {import('../db/Settings.mjs').RemoteSettingsManager} settings
   * @param {string|null} [configPrefix=null]
   */
  constructor(settings, configPrefix = null) {
    this.settings = settings;
    this.configPrefix = configPrefix;
  }

  /**
   * Get the command prefix for a guild. DMs and any other context without a
   * real guildId skip the settings lookup entirely — falling through to
   * getServer(undefined) would create and permanently cache a phantom
   * "undefined" guild entry in the settings store, which then shows up in
   * every guilds-map iteration (24/7 watchdog, shutdown save-all, etc.).
   * @param {string|null|undefined} guildId
   * @returns {string}
   */
  getPrefix(guildId) {
    if (!guildId) return this.configPrefix ?? "%";
    const serverPrefix = this.settings.getServer(guildId).get("prefix");
    return serverPrefix ?? this.configPrefix ?? "%";
  }
}
