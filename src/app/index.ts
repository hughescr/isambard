// App composition root - factory functions for createApp() decomposition

export { createCatchUpSignalAdapter, type CatchUpSignalAdapter } from './catchup-signal-adapter';
export { createStorageLayer, type StorageLayer } from './storage-layer';
export { createContextLayer, type ContextLayer } from './context-layer';
export { createDiscordInfrastructure, type DiscordInfrastructure, type DiscordInfrastructureOptions } from './discord-infrastructure';
export { createMCPServers, type MCPServers, type MCPServersOptions } from './mcp-servers';
export { loadIdentityContext } from './identity-loader';
