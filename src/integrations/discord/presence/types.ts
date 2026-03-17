/**
 * Domain types for Discord presence management
 *
 * This module defines the core domain concepts for managing Discord bot presence,
 * including status phases, activity updates, and configuration.
 */

import type { ActivitiesOptions } from 'discord.js';
import type { ActivityPhase } from '../state/types.js';

// ============================================================================
// Presence Phase - State Machine
// ============================================================================

/**
 * Discriminated union representing the current presence phase of the bot.
 * Extends ActivityPhase with an additional 'idle' state for Discord presence.
 *
 * ActivityPhase represents active processing states (thinking, using_tool, responding).
 * PresencePhase adds the 'idle' state to represent when the bot is not actively processing.
 *
 * @example
 * ```typescript
 * const idlePhase: PresencePhase = { type: 'idle', since: new Date() };
 * const thinkingPhase: PresencePhase = { type: 'thinking', startedAt: new Date() };
 * const toolPhase: PresencePhase = { type: 'using_tool', toolName: 'memory_tool', startedAt: new Date() };
 * ```
 */
export type PresencePhase
    = | ActivityPhase
      | { type: 'idle', since: Date };

// ============================================================================
// Presence Display Mode - For status prefix generation
// ============================================================================

/**
 * Presence display mode state for presence status prefix generation.
 *
 * ## Design Rationale
 *
 * PresenceManager uses simple enum values to:
 * - Generate status emoji prefixes (📥, 💬, 🦅)
 * - Map directly to status text templates
 * - Avoid complex conditional logic in status generation
 *
 * ## Mapping from BotStateManager
 *
 * The bot.ts integration layer maps BotState to PresenceDisplayMode:
 * - `mode='catching_up'` → `'catching_up'` (📥 prefix)
 * - `mode='processing_message'` → `'processing_message'` (💬 prefix)
 * - `mode='perching'` → `'perching'` (🦅 prefix)
 * - `mode='idle'` → `'none'` (no prefix)
 *
 * ## Discord Status Mapping
 *
 * Maps to emoji prefixes shown in Discord status:
 * - `'none'`: No special prefix (normal operation)
 * - `'catching_up'`: 📥 prefix (processing backlog)
 * - `'processing_message'`: 💬 prefix (normal message handling)
 * - `'perching'`: 🦉 prefix (autonomous perch time)
 *
 * @see BotState in src/integrations/discord/state/types.ts for the authoritative state model
 * @see bot.ts for the mapping logic between these type systems
 *
 * @example
 * ```typescript
 * // In bot.ts mapping logic:
 * const presenceDisplayMode: PresenceDisplayMode = state.mode === 'catching_up'
 *   ? 'catching_up'
 *   : (state.mode === 'processing_message' ? 'processing_message' : 'none');
 * ```
 */
export type PresenceDisplayMode = 'none' | 'catching_up' | 'processing_message' | 'perching';

// ============================================================================
// Synopsis Context - For LLM status generation
// ============================================================================

/**
 * Context provided to the LLM for generating dynamic status synopses.
 * Used when generating contextual presence status messages.
 */
export interface SynopsisContext {
    /** The current phase type */
    phase:             'thinking' | 'using_tool' | 'responding'
    /** The user's original message being processed */
    userMessage:       string
    /** The name of the tool being used (only for 'using_tool' phase) */
    toolName?:         string
    /** A fragment of the response being generated (only for 'responding' phase) */
    responseFragment?: string
    /** The tool's arguments (redacted for sensitive data) */
    toolInput?:        unknown
    /** Human-readable description of what the tool does */
    toolDescription?:  string
    /** Recent response text Izzy has been composing */
    accumulatedText?:  string
    /** Content from thinking blocks (truncated to 500 chars) */
    thinkingContent?:  string
    /** Recent tool calls (last 3 tools, most recent first) */
    recentToolCalls?:  string[]
    /** AI-generated progress summary from a running subagent */
    subagentSummary?:  string
}

/**
 * Context for generating catch-up status synopses.
 * Provides rich information about the inbox state when entering catch-up mode.
 */
export interface CatchUpSynopsisContext {
    /** Total number of unread messages */
    totalUnread:         number
    /** Number of channels with unread messages */
    channelCount:        number
    /** Names of channels with unread messages (e.g., ["general", "DM"]) */
    channelNames:        string[]
    /** Top authors who sent messages (up to 3) */
    topAuthors:          string[]
    /** Human-readable time since last active (e.g., "3 hours", "overnight", "2 days") */
    timeSinceLastActive: string
    /** Time of day (morning, afternoon, evening, night) */
    timeOfDay:           string
    /** Day of week (e.g., "Monday", "Saturday") */
    dayOfWeek:           string
}

// ============================================================================
// Status Update - What to show users
// ============================================================================

/**
 * Represents a complete status update to be applied to Discord presence.
 */
export interface StatusUpdate {
    /** Discord activity configuration */
    activity: ActivitiesOptions
    /** If true, show typing indicator */
    typing:   boolean
}

// ============================================================================
// Tool Mapping - Tool name → Status text
// ============================================================================

/**
 * Maps tool names to human-readable status text.
 * Extensible - add new tools here as they're integrated.
 */
// Stryker disable all: Display strings for Discord presence - not behavioral
export const ToolStatusMap: Record<string, string> = {
    mcp__memory__view:            'Remembering...',
    mcp__memory__storeSelf:       'Recording self-knowledge...',
    mcp__memory__storeUserMemory: 'Recording user memory...',
    mcp__memory__logEvent:        'Logging event...',
    mcp__memory__search:          'Searching memories...',
    // Future tools can be added here
};
// Stryker restore all

/**
 * Maps tool names to human-readable descriptions of what the tool does.
 * Used to provide context to the LLM when generating dynamic status synopses.
 */
export const ToolDescriptions: Record<string, string> = {
    mcp__memory__view:            'Reading from memory storage',
    mcp__memory__search:          'Searching through memories',
    mcp__memory__storeSelf:       'Storing self-knowledge',
    mcp__memory__storeUserMemory: 'Recording user preferences',
    mcp__memory__logEvent:        'Logging an event',
    mcp__discord__searchMessages: 'Searching Discord history',
    Read:                         'Reading a file',
    Glob:                         'Finding files by pattern',
    Grep:                         'Searching file contents',
    WebSearch:                    'Searching the web',
    WebFetch:                     'Fetching a webpage',
    Bash:                         'Running a command',
    Task:                         'Delegating to a sub-agent',
};

/**
 * Returns the human-readable description for a tool, or undefined if not found.
 *
 * @param toolName - The name of the tool to look up
 * @returns The tool's description, or undefined if the tool is not in the map
 *
 * @example
 * ```typescript
 * getToolDescription('Read'); // 'Reading a file'
 * getToolDescription('unknown_tool'); // undefined
 * getToolDescription(undefined); // undefined
 * ```
 */
export function getToolDescription(toolName: string | undefined): string | undefined {
    // Stryker disable next-line ConditionalExpression,BlockStatement: Defensive guard clause - ToolDescriptions[undefined] returns undefined anyway
    if(!toolName) {
        return undefined;
    }
    return ToolDescriptions[toolName];
}

// ============================================================================
// Configuration
// ============================================================================

export { PresenceConfigSchema, type PresenceConfig } from '@/config';
