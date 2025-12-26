/**
 * Agent module exports
 *
 * Provides Claude agent creation, memory tool integration, and context building.
 */

export { createClaudeClient } from './client';
export { createClaudeAgent, type ClaudeAgent, type ClaudeAgentOptions } from './agent';
export { createMemoryTool, createDynamoDBMemoryHandlers } from './claude';
export { createContextBuilder, type ContextBuilder, type ContextBuilderOptions } from './context-builder';
