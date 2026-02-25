/**
 * Agent module exports
 *
 * Provides Claude agent creation, memory MCP server, context building, and plugin loading.
 */

export { createClaudeAgent, type ClaudeAgent, type ClaudeAgentOptions } from './agent';
export { createContextBuilder, formatMemoryPreview, type ContextBuilder, type ContextBuilderOptions, type RecentEventsResult, type EmailService, type WildDuckService } from './context-builder';
export { EventDeltaTracker } from './event-delta-tracker';
export { summarizeEventBatches, type EventBatchSummary, type SummarizeEventBatchesFn } from './event-summarizer';
export { createMemoryMCPServer } from './memory-mcp-server';
export { createDiscordMCPServer, setConversationContext, clearConversationContext, type DiscordMCPServerContext } from './discord-mcp-server';
export { loadPlugins, type PluginsConfig } from './plugin-loader';
export type { MessageContext, PlatformImage } from './types';

/** @internal */
export { buildMultimodalContent, hasImages, type ContentBlock, type TextContentBlock, type ImageContentBlock } from './multimodal-message-builder';

export { createTaskDirectoryCopier, getTaskDirectoryPath, type TaskDirectoryCopier, type TaskDirectoryCopierOptions } from './task-directory-copier';
export { createTaskPersistenceCoordinator, type TaskPersistenceCoordinator, type TaskPersistenceCoordinatorOptions } from './task-persistence-coordinator';
export { createTaskCleanupProcessor, type TaskCleanupProcessor, type TaskCleanupProcessorOptions, type TaskCleanupResult, type TaskCleanupDeps } from './task-cleanup-processor';
export { createTaskListReader, type TaskListReader } from './task-list-reader';
// Re-export SdkPluginConfig from SDK for consumers of this module
export type { SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';

// Question Registry
export { QuestionRegistry, questionOptionSchema, questionStateSchema, type QuestionOption, type QuestionState, type PendingQuestion, type QuestionAnswer, type QuestionResult, type QuestionRegistryConfig } from './question-registry';

// Answer Classifier
export { AnswerClassifier, classifyWithHaiku, classificationResultSchema, type ClassificationResult, type MessageToClassify, type ClassifierConfig } from './answer-classifier';

// Perch
export * from './perch';

// Session Cleanup
export { cleanupAllStaleSessions } from './session-cleanup';

// Skill/Agent Loader
export { syncAgentsAndSkills } from './skill-agent-loader';

// Text Generator
export { generateText, generateTextWithSystemPrompt, type TextGeneratorOptions } from './text-generator';

// Email MCP Server
export { createEmailMCPServer, type EmailMCPServerOptions, type RestrictedMailboxNotification } from './email-mcp-server';

// Inbox MCP Server
export { createInboxMCPServer } from './inbox-mcp-server';

// Stream Tracker
export { StreamTracker, type StreamProgress } from './stream-tracker';

// Resume Prompt Builder
export { buildResumePrompt, type ResumeContext } from './resume-prompt-builder';
