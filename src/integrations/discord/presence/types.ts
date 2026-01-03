/**
 * Domain types for Discord presence management
 *
 * This module defines the core domain concepts for managing Discord bot presence,
 * including status phases, activity updates, and configuration.
 */

import { z } from 'zod';
import type { ActivitiesOptions } from 'discord.js';

// ============================================================================
// Presence Phase - State Machine
// ============================================================================

/**
 * Discriminated union representing the current activity phase of the bot.
 * Each phase maps to a different Discord presence status.
 *
 * @example
 * ```typescript
 * const thinkingPhase: PresencePhase = { type: 'thinking', startedAt: new Date() };
 * const toolPhase: PresencePhase = { type: 'using_tool', toolName: 'memory_tool', startedAt: new Date() };
 * ```
 */
export type PresencePhase
    = | { type: 'idle', since: Date }
      | { type: 'thinking', startedAt: Date, userMessage?: string, generatedStatus?: string }
      | { type: 'using_tool', toolName: string, startedAt: Date, generatedStatus?: string }
      | { type: 'responding', startedAt: Date, generatedStatus?: string };

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
export const ToolStatusMap: Record<string, string> = {
    mcp__memory__view:            'Remembering...',
    mcp__memory__storeSelf:       'Recording self-knowledge...',
    mcp__memory__storeUserMemory: 'Recording user memory...',
    mcp__memory__logEvent:        'Logging event...',
    mcp__memory__search:          'Searching memories...',
    // Future tools can be added here
};

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

/**
 * Configuration schema for presence management.
 * Defines rate limiting, refresh intervals, and timing constraints.
 */
export const PresenceConfigSchema = z.object({
    /**
     * Minimum milliseconds between active phase Discord presence updates (throttle cooldown).
     * Uses leading-edge throttle: first update fires immediately, subsequent updates within
     * the cooldown window are dropped (not queued). This prevents status flickering during
     * rapid phase transitions while ensuring the first status is always visible.
     */
    updateThrottleMs: z.number().int().positive().default(10000), // 10 seconds

    /** Milliseconds to wait before showing idle status after last activity */
    idleTimeoutMs: z.number().int().positive().default(60000), // 1 minute

    /** How often to refresh idle status text (milliseconds) */
    idleRefreshIntervalMs: z.number().int().positive().default(300000), // 5 minutes
});

/**
 * Inferred TypeScript type from the presence configuration schema.
 */
export type PresenceConfig = z.infer<typeof PresenceConfigSchema>;
