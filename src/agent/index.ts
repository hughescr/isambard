/**
 * Agent module exports
 *
 * Provides Claude agent creation, memory MCP server, context building, and plugin loading.
 */

export { createClaudeAgent, type ClaudeAgent, type ClaudeAgentOptions } from './agent';
export { createContextBuilder, type ContextBuilder, type ContextBuilderOptions } from './context-builder';
export { createMemoryMCPServer } from './memory-mcp-server';
export { loadPlugins, type PluginEntry, type PluginsConfig } from './plugin-loader';
