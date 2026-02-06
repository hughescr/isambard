/**
 * Agent module exports
 *
 * Provides Claude agent creation, memory MCP server, context building, and plugin loading.
 */

export { createClaudeAgent, type ClaudeAgent, type ClaudeAgentOptions } from './agent';
export { createContextBuilder, type ContextBuilder, type ContextBuilderOptions } from './context-builder';

/** @internal */
export { createEventDeltaTracker, type EventDeltaTracker } from './event-delta-tracker';

export { createMemoryMCPServer } from './memory-mcp-server';
export { createDiscordMCPServer, setConversationContext, clearConversationContext, type DiscordMCPServerContext } from './discord-mcp-server';
export { loadPlugins, type PluginsConfig } from './plugin-loader';

/** @internal */
export { buildMultimodalContent, hasImages, type ContentBlock, type TextContentBlock, type ImageContentBlock } from './multimodal-message-builder';

export { createTaskDirectoryCopier, getTaskDirectoryPath, type TaskDirectoryCopier, type TaskDirectoryCopierOptions } from './task-directory-copier';
export { createTaskPersistenceCoordinator, type TaskPersistenceCoordinator, type TaskPersistenceCoordinatorOptions } from './task-persistence-coordinator';
export { createTaskCleanupProcessor, type TaskCleanupProcessor, type TaskCleanupProcessorOptions, type TaskCleanupResult, type TaskCleanupDeps } from './task-cleanup-processor';
// Re-export SdkPluginConfig from SDK for consumers of this module
export type { SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';
