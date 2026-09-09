// App composition root - factory functions for createApp() decomposition

export { createStorageLayer } from './storage-layer';
export { createContextLayer } from './context-layer';
export { createDiscordInfrastructure } from './discord-infrastructure';
export { createMcpSharedDeps, createMcpServerInstances } from './mcp-servers';
export type { McpSharedDeps, McpServerRole, CreateMcpServerInstancesOptions } from './mcp-servers';
export { loadIdentityContext } from './identity-loader';
export {
    createConversationConductor, type CreateConversationConductorParams, type ConversationConductorResult,
    createPerchConductor, type CreatePerchConductorParams, type PerchConductorResult,
    createSessionAmbience, type CreateSessionAmbienceParams, type SessionAmbience
} from './sessions';
export {
    registerSignalHandlers,
    createDiscordRecoveryHandler,
    type RegisterSignalHandlersParams,
    type CreateDiscordRecoveryHandlerParams
} from './lifecycle';
export {
    registerHotReloadInstance,
    stopPreviousHotReloadInstance,
    HOT_RELOAD_KEY,
    type HotReloadInstance,
    type HotReloadLogger
} from './hot-reload-guard';
