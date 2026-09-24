/**
 * Agent SDK Stream Event Types
 *
 * Type definitions for events emitted by the Agent SDK's query() stream.
 * These are used to track agent progress and trigger presence updates.
 */

import type { TextBlock, ThinkingBlock, ToolUseBlock } from './stream-extractors';
import { channelIdSchema, userIdSchema, type ChannelId, type UserId } from '@/config';

export { channelIdSchema, userIdSchema } from '@/config';
export type { ChannelId, UserId } from '@/config';

/** Information about a resolved user, including the validated platform ID. */
export interface ResolvedUser {
    userId:      UserId
    username:    string
    displayName: string
    nickname:    string | null
}

/** Result of resolving a human-readable name to a user. */
export type UserResolveResult
    = | { status: 'resolved', user: ResolvedUser }
      | { status: 'ambiguous', matches: Omit<ResolvedUser, 'userId'>[] }
      | { status: 'not_found' };

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
        content?: (Pick<TextBlock, 'type' | 'text'> | Pick<ThinkingBlock, 'type' | 'thinking'> | Pick<ToolUseBlock, 'type' | 'id' | 'name' | 'input'>)[]
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
    subtype?:         string
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
    status?:          unknown
    /** Whether the task was registered in the background — present on task_started */
    is_backgrounded?: boolean
    /** Subagent type for Task-tool subagents — present on task_started */
    subagent_type?:   string
    /** `meta.name` from the workflow script — present on task_started when task_type is 'local_workflow' */
    workflow_name?:   string
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

/** Only the source fields consumed by the Discord envelope builder and resume context. */
export interface EnvelopeSourceMessage {
    messageId: string
    content:   string
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
