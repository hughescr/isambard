/**
 * Agent module exports
 *
 * Provides Claude agent creation, memory MCP server, context building, and plugin loading.
 */

export { formatTimeHeader } from './time-header';
export { extractToolUses, redactSensitiveArgs } from './stream-extractors';
export type { AssistantContentBlock, AssistantFrame, TextBlock, ThinkingBlock, ToolUseBlock } from './stream-extractors';
export { createStreamEventLogger, createRoleLogger, type StreamEventLogger, type FieldLogger } from './stream-event-logger';
export { createCompactionHooks, type CompactionSink } from './hooks/compaction';
export { createBootBundleHooks } from './hooks/boot-bundle';
export { createSessionLifecycleHooks, type SessionLifecycleHooksDeps } from './hooks/lifecycle';
export { createTaskTrackingHooks } from './hooks/task-tracking';
export { createTaskLaunchHooks, type CreateTaskLaunchHooksParams } from './hooks/task-launch';
export { createAgentNamingHooks, type CreateAgentNamingHooksParams } from './hooks/agent-naming';
export { createPeerMessageHooks, parsePeerMessage, type CreatePeerMessageHooksParams } from './hooks/peer-message';
export { mergeHookMaps } from './hooks/index';
export { createContextBuilder, type ContextBuilder, type EmailService, type BskyDMService, type CalendarService } from './context-builder';
export { summarizeEventBatches } from './event-summarizer';
export { createMemoryMCPServer } from './memory-mcp-server';
export { createDiscordMCPServer } from './discord-mcp-server';
export { loadPlugins } from './plugin-loader';
export { buildSessionSystemPrompt, type BuildSessionSystemPromptOptions, buildSubagentSystemPrompt, type BuildSubagentSystemPromptOptions } from './prompts/index.js';
export type { EnvelopeSourceMessage, ResolvedUser, UserResolveResult, PlatformImage, AgentStreamEvent, ChannelId } from './types';
export type { DiscordMcpChannelRegistry, DiscordMcpChannelInfo, MCPMessageSearchService, MCPDMTracker } from './discord-ports';

export { createTaskListReader, getTaskDirectoryPath } from './task-list-reader';

// Question Registry
export { QuestionRegistry, type QuestionOption, type QuestionAnswer } from './question-registry';

// Answer Classifier
export { AnswerClassifier, classifyWithHaiku } from './answer-classifier';

// Perch
export * from './perch';

// Long-lived session core
export * from './session';

// Skill/Agent Loader
export { syncAgentsAndSkills } from './skill-agent-loader';

// Text Generator
export { generateText, generateTextWithSystemPrompt } from './text-generator';

// Email MCP Server
export { createEmailMCPServer } from './email-mcp-server';

// Discord Inbox MCP Server
export { createDiscordInboxMCPServer } from './discord-inbox-mcp-server';

// Bsky MCP Server
export { createBskyMCPServer } from './bsky-mcp-server';

// CalDAV MCP Server
export { createCaldavMCPServer } from './caldav-mcp-server';

// Media MCP Server
export { createMediaMCPServer } from './media-mcp-server';

// Wikipedia MCP Server
export { createWikipediaMCPServer } from './wikipedia-mcp-server';

// Health MCP Server
export { createHealthMCPServer } from './health-mcp-server';

// Contacts MCP Server
export { createContactsMCPServer } from './contacts-mcp-server';

// Person Context MCP Server
export { createPersonContextMCPServer } from './person-context-mcp-server';

// Browser MCP Server
export { createBrowserMCPServer } from './browser-mcp-server';
export type { BrowserAdapter, BrowserHostPolicy } from './browser';
export { createWebViewAdapter } from './browser';

// Identity Cache
export { IdentityCache, type IdentityLoader } from './identity-cache';

// Live Signals
export { LiveSignals, type Signal, type RecentTool, type RecentChannel, type LiveSignalsDeps } from './live-signals';

// Stream Tracker
export { StreamTracker, type StreamProgress } from './stream-tracker';

// Continuation Prompt Builder
export { type ContinuationContext, buildContinuationNote } from './continuation-prompt-builder';

// Activity Logger
export { createActivityLogger, type ActivityLogger, type AppActivityLogger, type ActivityType } from './activity-types';

// History Providers
export type { HistoryEntry, HistoryFetchParams, KnownPlatform, PlatformHistoryProvider } from './history-providers';
export { PersonHistoryCoordinator } from './history-providers';
