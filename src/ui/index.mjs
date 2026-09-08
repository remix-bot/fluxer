/**
 * @module src/ui
 * @description Public surface of the message/embed UI layer.
 *
 * Import map from the old layout:
 * - `src/MessageHandler.mjs` → this module
 */

export { REQUIRED_BOT_PERMISSIONS, CRITICAL_PERMISSIONS, OPTIONAL_PERMISSIONS } from "./Permissions.mjs";
export { parseColor, setGlobalColor, getGlobalColor, getMessageGuildId } from "./Embeds.mjs";
export { Message, Channel } from "./Wrappers.mjs";
export { MessageHandler } from "./MessageHandler.mjs";
export { PageBuilder, RichPaginator, QueuePaginator } from "./Paginators.mjs";
export { HelpCommand } from "./HelpCommand.mjs";
export { cleanId } from "../utils/Utils.mjs";
