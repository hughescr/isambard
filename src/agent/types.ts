/**
 * Agent SDK Stream Event Types
 *
 * Type definitions for events emitted by the Agent SDK's query() stream.
 * These are used to track agent progress and trigger presence updates.
 */

import { z } from 'zod';

// ============================================================================
// Platform-Agnostic Branded IDs
// ============================================================================

/**
 * ChannelId is a branded type representing a channel identifier.
 * Platform-agnostic — used by agent module for type safety.
 */
export const channelIdSchema = z
    .string()
    .min(1, 'Channel ID cannot be empty')
    .brand<'ChannelId'>();

export type ChannelId = z.infer<typeof channelIdSchema>;

/**
 * UserId is a branded type representing a user identifier.
 * Platform-agnostic — used by agent module for type safety.
 */
export const userIdSchema = z
    .string()
    .min(1, 'User ID cannot be empty')
    .brand<'UserId'>();

export type UserId = z.infer<typeof userIdSchema>;

/**
 * Creates a validated ChannelId from a string.
 * @throws {z.ZodError} If the channel ID is invalid
 */
export function createChannelId(id: string): ChannelId {
    return channelIdSchema.parse(id);
}

/**
 * Creates a validated UserId from a string.
 * @throws {z.ZodError} If the user ID is invalid
 */
export function createUserId(id: string): UserId {
    return userIdSchema.parse(id);
}

/**
 * Type guard to check if a value is a valid ChannelId.
 */
export function isChannelId(value: unknown): value is ChannelId {
    const result = channelIdSchema.safeParse(value);
    return result.success;
}

/**
 * Type guard to check if a value is a valid UserId.
 */
export function isUserId(value: unknown): value is UserId {
    const result = userIdSchema.safeParse(value);
    return result.success;
}

/**
 * Union type representing all possible events from the Agent SDK stream.
 *
 * These events are emitted as the agent processes a query, allowing
 * external systems to react to different stages of processing.
 */
export type AgentStreamEvent
    = | AssistantEvent
      | ToolProgressEvent
      | ToolResultEvent
      | ResultEvent
      | UserEvent
      | SystemEvent;

/**
 * Content block types that can appear in assistant messages.
 * - text: Text response content
 * - thinking: Extended thinking content (when enabled)
 * - tool_use: Tool invocation request
 * @internal Constituent of AgentStreamEvent; consumed only within src/agent/.
 */
interface ContentBlock {
    type:   string
    text?:  string
    id?:    string
    name?:  string
    input?: unknown
}

/**
 * Event emitted when the agent generates assistant content.
 * This can include thinking (no delta) or actual response text (with delta).
 * @internal Constituent of AgentStreamEvent; consumed only within src/agent/.
 */
export interface AssistantEvent {
    type:   'assistant'
    delta?: {
        text?: string
    }
    message?: {
        content?: ContentBlock[]
    }
}

/**
 * Event emitted when the agent starts or continues using a tool.
 * Includes the tool name and ID for tracking long-running operations.
 * @internal Constituent of AgentStreamEvent; consumed only within src/agent/.
 */
interface ToolProgressEvent {
    type:                  'tool_progress'
    tool_use_id?:          string
    tool_name?:            string
    elapsed_time_seconds?: number
}

/**
 * Event emitted when a tool execution completes.
 * Includes the tool name and result.
 * @internal Constituent of AgentStreamEvent; consumed only within src/agent/.
 */
interface ToolResultEvent {
    type:         'tool_result'
    tool_use_id?: string
    tool_name?:   string
}

/**
 * Event emitted when the agent stream completes.
 * Includes usage statistics and final status.
 * @internal Constituent of AgentStreamEvent; consumed only within src/agent/.
 */
interface ResultEvent {
    type:            'result'
    subtype?:        'success' | 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries'
    duration_ms?:    number
    total_cost_usd?: number
    /** True when this result reports an API/turn error rather than a completed reply. */
    is_error?:       boolean
    /** Main-loop token usage for this turn, when reported. */
    usage?: {
        input_tokens?:                number
        output_tokens?:               number
        cache_creation_input_tokens?: number
        cache_read_input_tokens?:     number
    }
    /** User-initiated sends still waiting in the command queue when this result was produced. */
    queued_turn_count?: number
}

/**
 * Event emitted for user messages (echoed back).
 * @internal Constituent of AgentStreamEvent; consumed only within src/agent/.
 */
interface UserEvent {
    type:     'user'
    message?: { content?: unknown }
}

/**
 * Event emitted by the system at various lifecycle points.
 * The 'init' subtype is emitted at query start and contains the session_id.
 * The 'compact_boundary' subtype is emitted when context compaction occurs.
 * The 'task_started' subtype is emitted by the SDK when a background Task sub-agent launches,
 * carrying both the task_id and the tool_use_id that links it to the originating Task tool_use block.
 * @internal Constituent of AgentStreamEvent; consumed only within src/agent/.
 */
export interface SystemEvent {
    type:             'system'
    subtype?:         'init' | 'status' | 'compact_boundary' | 'hook_response' | 'task_progress' | 'task_started' | 'task_notification' | 'background_tasks_changed' | 'hook_started'
    session_id?:      string
    /** Unique task ID — present on task_started, task_progress and task_notification subtypes */
    task_id?:         string
    /** tool_use_id that links this task_started event back to the originating Task tool_use block */
    tool_use_id?:     string
    /** AI-generated progress summary for subagent tasks (when agentProgressSummaries enabled) */
    summary?:         string
    /** Human-readable description of what the subagent is doing */
    description?:     string
    /** Last tool the subagent used */
    last_tool_name?:  string
    /** Task type, e.g. 'local_agent' | 'local_workflow' | 'local_bash' — present on task_started */
    task_type?:       string
    /** Terminal status of a background task — present on task_notification */
    status?:          'completed' | 'failed' | 'stopped'
    /** Whether the task was registered in the background — present on task_started */
    is_backgrounded?: boolean
    /** Subagent type for Task-tool subagents — present on task_started */
    subagent_type?:   string
    /** Full live background-task set (REPLACE semantics) — present on background_tasks_changed */
    tasks?:           { task_id: string, task_type: string, description: string, ambient?: boolean }[]
    /** Housekeeping/ambient task, hidden from user-facing activity indicators */
    ambient?:         boolean
    /** Token/tool-call usage for the task — present on task_notification and task_progress */
    usage?: {
        total_tokens?: number
        tool_uses?:    number
        duration_ms?:  number
    }
}

/**
 * Attachment metadata for platform-agnostic message handling.
 * Renamed from AttachmentMetadata to disambiguate from Discord's AttachmentMetadata.
 * Structurally equivalent but decouples the agent module from platform-specific types.
 * @internal Used only within MessageContext; no external file imports this by name.
 */
interface PlatformAttachmentMetadata {
    url:         string
    filename:    string
    contentType: string
    size:        number
    width?:      number
    height?:     number
}

/**
 * Platform-agnostic message context for agent input.
 * Replaces DiscordMessageContext in the agent module.
 */
export interface MessageContext {
    channelId:    string
    userId:       string
    messageId:    string
    content:      string
    timestamp:    string  // ISO 8601
    botUserId:    string
    guildId?:     string
    attachments?: PlatformAttachmentMetadata[]
}

/**
 * Platform-agnostic image data for multimodal input.
 * Replaces FetchedImage in the agent module.
 */
export interface PlatformImage {
    filename:     string
    mediaType:    'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
    base64Data:   string
    originalSize: number
    width?:       number
    height?:      number
}

// ============================================================================
// Platform-Agnostic MCP Server Interfaces
//
// These interfaces abstract the Discord-specific implementations that the
// Discord and Inbox MCP servers depend on. The composition root
// (src/app/mcp-servers.ts) wires up Discord implementations to these.
// ============================================================================

/**
 * Minimal channel info shape used by MCP server interfaces.
 * Avoids importing Discord-specific ChannelMetadata.
 */
export interface MCPChannelInfo {
    channelId:    ChannelId
    channelName:  string
    guildId:      string
    isMuted:      boolean
    isWellKnown?: string
}

/**
 * Platform-agnostic channel registry interface for MCP servers.
 * Abstracts the Discord ChannelRegistryManager.
 */
export interface MCPChannelRegistry {
    /** Resolve a channel name (#general) or numeric ID string to a ChannelId */
    resolveChannelId(nameOrId: string): ChannelId
    /** Mute a channel */
    muteChannel(channelId: ChannelId): Promise<void>
    /** Unmute a channel */
    unmuteChannel(channelId: ChannelId): Promise<void>
    /** Get all tracked channels */
    getAllChannels(): MCPChannelInfo[]
    /** Get all unmuted channels */
    getUnmutedChannels(): Promise<MCPChannelInfo[]>
}

/**
 * Platform-agnostic DM tracker interface for the Discord MCP server.
 * Abstracts DMTracker's username-to-channel resolution.
 */
export interface MCPDMTracker {
    /** Get or create a DM channel by username. Returns null if user not found. */
    getOrCreateDMByUsername(username: string): Promise<ChannelId | null>
}

/**
 * Platform-agnostic message splitter for the Discord MCP server.
 * Splits long messages into chunks that fit platform limits.
 * @internal Only consumed by src/agent/discord-mcp-server.ts.
 */
export interface MCPMessageSplitter {
    /** Split a message string into chunks */
    splitMessage(content: string): string[]
}

/**
 * Platform-agnostic question button builder for the Discord MCP server.
 * Returns platform-specific button components for attaching to messages.
 * @internal Only consumed by src/agent/discord-mcp-server.ts.
 */
export interface MCPQuestionButtonBuilder {
    /** Build button components for a question with options */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- platform components returned as unknown to avoid Discord.js dependency
    buildQuestionButtons(config: { questionId: string, options: { label: string, value: string }[] }): any[]
}

/**
 * Platform-agnostic retry helper for MCP servers.
 * Wraps Discord API calls with retry logic.
 * @internal Only consumed by src/agent/discord-mcp-server.ts.
 */
export interface MCPRetryHelper {
    /** Execute a function with retry on transient failures */
    withRetry<T>(fn: () => Promise<T>): Promise<T>
}

/**
 * Platform-agnostic message search service interface for the Discord MCP server.
 * Abstracts MessageSearchService from Discord message history.
 * Return types are kept as unknown to avoid importing Discord-specific types.
 */
export interface MCPMessageSearchService {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- search results contain Discord-specific types; passed through as JSON
    searchMessages(params: { channelId?: string, query?: string, startTime?: Date, endTime?: Date, limit?: number }): Promise<{ messages: any[], overflowCount?: number, [key: string]: unknown }>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- search results contain Discord-specific types; passed through as JSON
    getRecentMessages(channelId: string, limit?: number): Promise<{ messages: any[], [key: string]: unknown }>
    getMessageById(channelId: string, messageId: string): Promise<{ localTimestamp?: string, timestamp: string, [key: string]: unknown } | null>
    getMessagesById(channelId: string, messageIds: string[]): Promise<{ localTimestamp?: string, timestamp: string, [key: string]: unknown }[]>
}

/**
 * Platform-agnostic unread message shape for inbox MCP server.
 * Mirrors Discord UnreadMessage without importing from integrations.
 * @internal Only consumed within src/agent/ (MCPInboxManager interface).
 */
interface MCPUnreadMessage {
    id:          string
    channelId:   ChannelId
    channelName: string
    guildId:     string
    author:      string
    content:     string
    timestamp:   string
    isRead:      boolean
}

/**
 * Platform-agnostic message metadata shape for inbox MCP server.
 * @internal Only consumed by src/agent/inbox-mcp-server.ts.
 */
export interface MCPMessageMetadata {
    id:        string
    author:    string
    timestamp: string
    sizeChars: number
}

/**
 * Platform-agnostic unread overview shape for inbox MCP server.
 * @internal Only consumed within src/agent/ (MCPInboxManager interface).
 */
interface MCPUnreadOverview {
    totalUnread: number
    channels:    { channelId: ChannelId, channelName: string, messageCount: number }[]
}

/**
 * Platform-agnostic channel summary response shape for inbox MCP server.
 * @internal Only consumed by src/agent/inbox-mcp-server.ts.
 */
export interface MCPChannelSummaryResponse {
    channelId:    ChannelId
    channelName:  string
    messageCount: number
    summary:      string
    authors:      string[]
    timeRange:    { start: string, end: string }
    messages:     MCPMessageMetadata[]
}

/**
 * Platform-agnostic inbox manager interface for the inbox MCP server.
 * Abstracts InboxManager.
 * @internal Only consumed by src/agent/inbox-mcp-server.ts.
 */
export interface MCPInboxManager {
    /** Get a high-level overview of unread messages across all channels */
    getUnreadOverview(): MCPUnreadOverview
    /** Get all unread messages in a specific channel */
    getChannelMessages(channelId: ChannelId): MCPUnreadMessage[]
    /** Get a specific message by channel and message ID */
    getMessage(channelId: ChannelId, messageId: string): MCPUnreadMessage | undefined
    /** Mark specific messages as read */
    markAsRead(channelId: ChannelId, messageIds: string[]): Promise<void>
    /** Mark all messages in a channel as read */
    markChannelRead(channelId: ChannelId): Promise<void>
}
