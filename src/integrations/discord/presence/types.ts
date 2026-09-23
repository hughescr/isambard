/**
 * Domain types for Discord presence management
 *
 * Presence is modelled as a `PresenceView` composed from the conversation and perch session
 * ledgers (`presence-view.ts`: `composePresence`, rendered by `renderPresenceText`) and applied
 * to Discord by `PresenceManager.applyView`. This module owns the value types that model
 * shares: the `PresencePhase` state union, `StatusUpdate`, the tool status map, and the presence
 * config. (The turn synopsis's `SynopsisContext` and tool descriptions live in the session core,
 * `src/agent/session/synopsis-generator.ts`.)
 */

import type { ActivitiesOptions } from 'discord.js';
import type { ActivityPhase } from '@/agent';

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

export { PresenceConfigSchema, type PresenceConfig } from '@/config';
