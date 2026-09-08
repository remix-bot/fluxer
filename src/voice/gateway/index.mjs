/**
 * @module src/voice/gateway
 * @description Barrel for the gateway layer: re-exports the GatewayHandler
 * base class with its applied mixins (VoiceStateRouting, GuildSync,
 * RejoinManager).
 */

export { GatewayHandler } from "./GatewayHandler.mjs";
