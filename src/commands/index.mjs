/**
 * @module src/commands
 * @description Public surface of the command framework layer.
 *
 * Import map from the old layout:
 * - `src/CommandHandler.mjs` → this module
 */

export { CommandBuilder, CommandRequirement } from "./CommandBuilder.mjs";
export { Option, Flag } from "./Option.mjs";
export { PrefixManager } from "./PrefixManager.mjs";
export { HelpHandler } from "./HelpHandler.mjs";
export { CommandHandler } from "./CommandHandler.mjs";
export { CommandLoader } from "./CommandLoader.mjs";
