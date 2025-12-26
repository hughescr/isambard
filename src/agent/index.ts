/**
 * Agent module exports
 *
 * Provides Claude agent creation, memory MCP server, and context building.
 */

export { createClaudeAgent, type ClaudeAgent, type ClaudeAgentOptions } from './agent';
export { createContextBuilder, type ContextBuilder, type ContextBuilderOptions } from './context-builder';
export { createMemoryMCPServer } from './memory-mcp-server';
