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
   * Get the command prefix for a guild.
   * @param {string} guildId
   * @returns {string}
   */
  getPrefix(guildId) {
    const serverPrefix = this.settings.getServer(guildId).get("prefix");
    return serverPrefix ?? this.configPrefix ?? "%";
  }
}
