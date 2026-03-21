/**
 * Agent module exports
 *
 * Provides Claude agent creation, memory MCP server, context building, and plugin loading.
 */

export { createClaudeAgent, type ClaudeAgent, extractToolUses, redactSensitiveArgs } from './agent';
export { createContextBuilder, type ContextBuilder, type EmailService, type BskyDMService, type CalendarService } from './context-builder';
export { EventDeltaTracker } from './event-delta-tracker';
export { summarizeEventBatches } from './event-summarizer';
export { createMemoryMCPServer } from './memory-mcp-server';
export { createDiscordMCPServer, setConversationContext, clearConversationContext } from './discord-mcp-server';
export { loadPlugins } from './plugin-loader';
export type { MessageContext, PlatformImage, AgentStreamEvent } from './types';

export { createTaskDirectoryCopier } from './task-directory-copier';
export { createTaskPersistenceCoordinator, type TaskPersistenceCoordinator } from './task-persistence-coordinator';
export { createTaskCleanupProcessor } from './task-cleanup-processor';
export { createTaskListReader } from './task-list-reader';

// Question Registry
export { QuestionRegistry, type QuestionOption, type QuestionAnswer } from './question-registry';

// Answer Classifier
export { AnswerClassifier, classifyWithHaiku } from './answer-classifier';

// Perch
export * from './perch';

// Session Cleanup
export { cleanupAllStaleSessions } from './session-cleanup';

// Skill/Agent Loader
export { syncAgentsAndSkills } from './skill-agent-loader';

// Text Generator
export { generateText, generateTextWithSystemPrompt } from './text-generator';

// Email MCP Server
export { createEmailMCPServer } from './email-mcp-server';

// Inbox MCP Server
export { createInboxMCPServer } from './inbox-mcp-server';

// Bsky MCP Server
export { createBskyMCPServer } from './bsky-mcp-server';

// CalDAV MCP Server
export { createCaldavMCPServer } from './caldav-mcp-server';

// Wikipedia MCP Server
export { createWikipediaMCPServer } from './wikipedia-mcp-server';

// Stream Tracker
export { StreamTracker, type StreamProgress } from './stream-tracker';

// Resume Prompt Builder
export { type ResumeContext } from './resume-prompt-builder';
