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

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration schema for presence management.
 * Defines rate limiting, refresh intervals, and timing constraints.
 */
export const PresenceConfigSchema = z.object({
    /** Minimum milliseconds between Discord presence updates (rate limiting) */
    updateDebounceMs: z.number().int().positive().default(2000),

    /** Milliseconds to wait before showing idle status after last activity */
    idleTimeoutMs: z.number().int().positive().default(60000), // 1 minute

    /** How often to refresh idle status text (milliseconds) */
    idleRefreshIntervalMs: z.number().int().positive().default(300000), // 5 minutes
});

/**
 * Inferred TypeScript type from the presence configuration schema.
 */
export type PresenceConfig = z.infer<typeof PresenceConfigSchema>;
