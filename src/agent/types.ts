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
export type AgentStreamEvent =
  | AssistantEvent
  | ToolProgressEvent
  | ToolResultEvent
  | ResultEvent
  | UserEvent;

/**
 * Event emitted when the agent generates assistant content.
 * This can include thinking (no delta) or actual response text (with delta).
 */
export interface AssistantEvent {
  type: 'assistant';
  delta?: {
    text?: string;
  };
  message?: {
    content?: Array<{
      type: string;
      text?: string;
    }>;
  };
}

/**
 * Event emitted when the agent starts or continues using a tool.
 * Includes the tool name and ID for tracking long-running operations.
 */
export interface ToolProgressEvent {
  type: 'tool_progress';
  tool_use_id?: string;
  tool_name?: string;
  elapsed_time_seconds?: number;
}

/**
 * Event emitted when a tool execution completes.
 * Includes the tool name and result.
 */
export interface ToolResultEvent {
  type: 'tool_result';
  tool_use_id?: string;
  tool_name?: string;
}

/**
 * Event emitted when the agent stream completes.
 * Includes usage statistics and final status.
 */
export interface ResultEvent {
  type: 'result';
  subtype?: 'success' | 'error_during_execution' | 'error_max_turns';
  duration_ms?: number;
  total_cost_usd?: number;
}

/**
 * Event emitted for user messages (echoed back).
 */
export interface UserEvent {
  type: 'user';
  message?: any;
}
