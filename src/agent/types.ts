/**
 * Agent SDK Stream Event Types
 *
 * Type definitions for events emitted by the Agent SDK's query() stream.
 * These are used to track agent progress and trigger presence updates.
 */

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
 */
export interface ContentBlock {
    type:   string
    text?:  string
    id?:    string
    name?:  string
    input?: unknown
}

/**
 * Event emitted when the agent generates assistant content.
 * This can include thinking (no delta) or actual response text (with delta).
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
 */
export interface ToolProgressEvent {
    type:                  'tool_progress'
    tool_use_id?:          string
    tool_name?:            string
    elapsed_time_seconds?: number
}

/**
 * Event emitted when a tool execution completes.
 * Includes the tool name and result.
 */
export interface ToolResultEvent {
    type:         'tool_result'
    tool_use_id?: string
    tool_name?:   string
}

/**
 * Event emitted when the agent stream completes.
 * Includes usage statistics and final status.
 */
export interface ResultEvent {
    type:            'result'
    subtype?:        'success' | 'error_during_execution' | 'error_max_turns'
    duration_ms?:    number
    total_cost_usd?: number
}

/**
 * Event emitted for user messages (echoed back).
 */
export interface UserEvent {
    type:     'user'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Agent SDK message type is not exported
    message?: any
}

/**
 * Event emitted by the system at various lifecycle points.
 * The 'init' subtype is emitted at query start and contains the session_id.
 * The 'compact_boundary' subtype is emitted when context compaction occurs.
 */
export interface SystemEvent {
    type:            'system'
    subtype?:        'init' | 'status' | 'compact_boundary' | 'hook_response' | 'task_progress'
    session_id?:     string
    /** AI-generated progress summary for subagent tasks (when agentProgressSummaries enabled) */
    summary?:        string
    /** Human-readable description of what the subagent is doing */
    description?:    string
    /** Last tool the subagent used */
    last_tool_name?: string
}

/**
 * Attachment metadata for platform-agnostic message handling.
 * Renamed from AttachmentMetadata to disambiguate from Discord's AttachmentMetadata.
 * Structurally equivalent but decouples the agent module from platform-specific types.
 */
export interface PlatformAttachmentMetadata {
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
