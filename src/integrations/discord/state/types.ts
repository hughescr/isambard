/**
 * Domain types for bot state management.
 *
 * This module defines the core state machine for the Discord bot, including:
 * - Operational modes (idle, catching_up, processing_message, perching)
 * - Activity phases (thinking, using_tool, responding)
 * - State transitions and change notifications
 * - Mode-specific context types
 *
 * The state machine coordinates presence updates, session management,
 * and behavior changes across different operational modes.
 */

import { z } from 'zod';
import { channelIdSchema, type ChannelId } from '../types';
// eslint-disable-next-line boundaries/dependencies -- discord/state/types imports CompactionStateManager for getCompactionStateManager(); direct import avoids circular dep through agent index
import type { CompactionStateManager } from '@/agent/hooks/compaction';
// eslint-disable-next-line boundaries/dependencies -- discord/state/types re-exports agent OperationalMode; direct import avoids circular dep through agent index
import type { OperationalMode } from '@/agent/types';

// eslint-disable-next-line boundaries/dependencies -- discord/state/types re-exports agent OperationalMode; direct import avoids circular dep through agent index
export type { OperationalMode } from '@/agent/types';

// ============================================================================
// Operational Mode - Top-level bot state
// ============================================================================

/**
 * The bot's operational mode determines its primary behavior and context.
 * Re-exported from agent/types for backwards-compatibility.
 *
 * State transitions (idle-hub pattern — all modes must pass through idle):
 * - idle: Normal operation, no active conversation. Entry: `goIdle()`. Allows
 *   transition to any other mode.
 * - catching_up: Processing backlog of unread messages. Entered via
 *   `startCatchUp()`, exited to idle via `goIdle()`. Session can be suspended
 *   to process an interrupting message and resumed afterwards.
 * - processing_message: Actively responding to a single user message. Entered
 *   via `startProcessingMessage()`, exited to idle via `goIdle()`.
 * - perching: Autonomous scheduled activity (perch session). Entered via
 *   `startPerching()` from `PerchSessionRunner.startPerch()` and
 *   `resumeAfterSuspension()` in `src/agent/perch/session-runner.ts`. Exited
 *   to idle via `goIdle()` on normal completion, timeout wrap-up, error, or
 *   suspension. Downstream effects when mode is `'perching'`:
 *   - `agent-context-builder.ts` injects `PERCHING_PREAMBLE` system prompt and
 *     enables memory + discord MCP servers (inbox disabled).
 *   - `agent.ts` passes `specialMode: 'perching'` to `handleInput`, which
 *     selects the perch prompt instead of a normal user message.
 *   - `response-sender.ts` / `response-router.ts` route agent output to the
 *     `'perch-time'` well-known Discord channel.
 *   - `handlers.ts` interrupts the perch session when a user message arrives.
 *   - `presence/status-generator-active.ts` prefixes status with 🦉.
 *
 * @example
 * ```typescript
 * const mode: OperationalMode = 'idle';
 * const mode2: OperationalMode = 'catching_up';
 * ```
 */

/**
 * Zod schema for validating operational modes.
 */
// Stryker disable StringLiteral,ArrayDeclaration: Zod schema definition - enum values tested through usage
export const operationalModeSchema = z.enum(['idle', 'catching_up', 'processing_message', 'perching']);
// Stryker restore StringLiteral,ArrayDeclaration

// ============================================================================
// Activity Phase - Within-mode activity state
// ============================================================================

/**
 * Discriminated union representing the current activity phase during message processing.
 * Each phase maps to different Discord presence status and behavior.
 *
 * Phases:
 * - thinking: Bot is processing the user's message and formulating a response
 * - using_tool: Bot is executing a specific tool (memory search, file read, etc.)
 * - responding: Bot is generating and sending the response text
 *
 * @example
 * ```typescript
 * const thinkingPhase: ActivityPhase = {
 *   type: 'thinking',
 *   startedAt: new Date(),
 *   userMessage: 'What is the weather?'
 * };
 *
 * const toolPhase: ActivityPhase = {
 *   type: 'using_tool',
 *   toolName: 'memory_tool',
 *   startedAt: new Date(),
 *   generatedStatus: 'Searching memories...'
 * };
 * ```
 */
export type ActivityPhase
    = | { type: 'thinking', startedAt: Date, userMessage?: string, generatedStatus?: string }
      | { type: 'using_tool', toolName: string, startedAt: Date, generatedStatus?: string }
      | { type: 'responding', startedAt: Date, generatedStatus?: string }
      | { type: 'compacting', startedAt: Date, trigger?: 'manual' | 'auto' };

/**
 * Zod schema for validating activity phases.
 * Uses discriminated union for type-safe validation.
 */
// Stryker disable StringLiteral,ObjectLiteral: Zod schema definition - discriminated union values tested through usage
export const activityPhaseSchema = z.discriminatedUnion('type', [
    z.object({
        type:            z.literal('thinking'),
        startedAt:       z.date(),
        userMessage:     z.string().optional(),
        generatedStatus: z.string().optional(),
    }),
    z.object({
        type:            z.literal('using_tool'),
        toolName:        z.string(),
        startedAt:       z.date(),
        generatedStatus: z.string().optional(),
    }),
    z.object({
        type:            z.literal('responding'),
        startedAt:       z.date(),
        generatedStatus: z.string().optional(),
    }),
    z.object({
        type:      z.literal('compacting'),
        startedAt: z.date(),
        // Stryker disable next-line ArrayDeclaration: Zod enum values are validated at runtime; array mutation produces a Zod error, not a silent pass
        trigger:   z.enum(['manual', 'auto']).optional(),
    }),
// Stryker restore StringLiteral,ObjectLiteral
]);

// ============================================================================
// Mode Context - Mode-specific state data
// ============================================================================

/**
 * Context for idle mode.
 * Idle mode has no specific context - the bot is waiting for activity.
 */
export type IdleModeContext = Record<string, never>;

/**
 * Zod schema for idle mode context.
 */
const idleModeContextSchema = z.object({}).strict();

/**
 * Details about a message that interrupted a catch-up session.
 * Re-exported from agent/types for backwards-compatibility.
 */
// eslint-disable-next-line boundaries/dependencies -- discord/state/types re-exports agent InterruptingMessageDetails; direct import avoids circular dep through agent index
export type { InterruptingMessageDetails } from '@/agent/types';

/**
 * Context for catch-up mode.
 * Contains state for processing unread message backlog.
 *
 * @example
 * ```typescript
 * const context: CatchingUpModeContext = {
 *   viewedChannels: new Set([channelId1, channelId2]),
 *   sessionId: 'session-123',
 *   startedAt: new Date(),
 *   unreadCount: 42,
 *   channelNames: ['general', 'random'],
 *   topAuthors: ['Alice', 'Bob', 'Charlie'],
 *   timeSinceLastActive: '3 hours'
 * };
 * ```
 */
export interface CatchingUpModeContext {
    /** Channels that have been viewed during this catch-up session */
    viewedChannels:      Set<ChannelId>
    /** Claude agent session ID for this catch-up session */
    sessionId:           string | null
    /** When catch-up mode was entered */
    startedAt:           Date
    /** Initial count of unread messages when catch-up started */
    unreadCount:         number
    /** Names of channels with unread messages */
    channelNames:        string[]
    /** Top authors who sent messages (up to 3) */
    topAuthors:          string[]
    /** Human-readable time since last active (e.g., "3 hours", "overnight") */
    timeSinceLastActive: string | null
}

/**
 * Zod schema for catching_up mode context.
 */
// Stryker disable ObjectLiteral: Zod schema definition - structure tested through usage
const catchingUpModeContextSchema = z.object({
    viewedChannels:      z.set(channelIdSchema),
    sessionId:           z.string().nullable(),
    startedAt:           z.date(),
    unreadCount:         z.number().int().nonnegative(),
    channelNames:        z.array(z.string()),
    topAuthors:          z.array(z.string()),
    timeSinceLastActive: z.string().nullable(),
});
// Stryker restore ObjectLiteral

/**
 * Context for processing_message mode.
 * Contains state for handling a single user message.
 *
 * @example
 * ```typescript
 * const context: ProcessingMessageModeContext = {
 *   channelId: channelId,
 *   userMessage: 'Hello, how are you?',
 *   sessionId: 'session-456'
 * };
 * ```
 */
export interface ProcessingMessageModeContext {
    /** Channel where the message was sent */
    channelId:   ChannelId
    /** The user's message text */
    userMessage: string
    /** Claude agent session ID for this conversation */
    sessionId:   string | null
}

/**
 * Zod schema for processing_message mode context.
 */
// Stryker disable ObjectLiteral: Zod schema definition - structure tested through usage
const processingMessageModeContextSchema = z.object({
    channelId:   channelIdSchema,
    userMessage: z.string(),
    sessionId:   z.string().nullable(),
});
// Stryker restore ObjectLiteral

/**
 * Context for perching mode — the bot's autonomous scheduled activity state.
 *
 * Perching mode is entered by `PerchSessionRunner.startPerch()` and
 * `resumeAfterSuspension()` (`src/agent/perch/session-runner.ts`) via
 * `BotStateManager.startPerching(activityType)`.
 *
 * The `activityType` string is set to `"Perch time: <slot>"` (e.g.
 * `"Perch time: morning"`) and is used by presence status generators.
 * The `sessionId` is populated via `BotStateManager.setSessionId()` once
 * the Claude agent session starts, and is used to resume a suspended perch
 * in the same conversation thread.
 *
 * @internal Used by BotStateManager for mode context tracking.
 *
 * @example
 * ```typescript
 * const context: PerchingModeContext = {
 *   activityType: 'Perch time: morning',
 *   sessionId: null
 * };
 * ```
 */
export interface PerchingModeContext {
    /** Type of perching activity, e.g. "Perch time: morning" */
    activityType: string
    /** Claude agent session ID for resuming a suspended perch; null until session starts */
    sessionId:    string | null
}

/**
 * Zod schema for perching mode context.
 */
// Stryker disable ObjectLiteral: Zod schema definition - structure tested through usage
const perchingModeContextSchema = z.object({
    activityType: z.string(),
    sessionId:    z.string().nullable(),
});
// Stryker restore ObjectLiteral

/**
 * Union type of all mode context types.
 * The actual context type depends on the current operational mode.
 */
export type ModeContext
    = | IdleModeContext
      | CatchingUpModeContext
      | ProcessingMessageModeContext
      | PerchingModeContext;

/**
 * Zod schema for validating mode context.
 * Uses union of all context schemas.
 */
export const modeContextSchema = z.union([
    idleModeContextSchema,
    catchingUpModeContextSchema,
    processingMessageModeContextSchema,
    perchingModeContextSchema,
]);

// ============================================================================
// Bot State - Complete state representation
// ============================================================================

/**
 * Complete bot state including mode, activity, and context.
 * This is the single source of truth for bot behavior.
 *
 * @example
 * ```typescript
 * const state: BotState = {
 *   mode: 'idle',
 *   activityPhase: null,
 *   modeEnteredAt: new Date(),
 *   modeContext: {}
 * };
 * ```
 */
export interface BotState {
    /** Current operational mode */
    mode:          OperationalMode
    /** Current activity phase, or null if no active phase */
    activityPhase: ActivityPhase | null
    /** When the current mode was entered */
    modeEnteredAt: Date
    /** Mode-specific context data */
    modeContext:   ModeContext
}

/**
 * Zod schema for validating complete bot state.
 */
// Stryker disable ObjectLiteral: Zod schema definition - structure tested through usage
export const botStateSchema = z.object({
    mode:          operationalModeSchema,
    activityPhase: activityPhaseSchema.nullable(),
    modeEnteredAt: z.date(),
    modeContext:   modeContextSchema,
});
// Stryker restore ObjectLiteral

// ============================================================================
// State Change - For subscriber notifications
// ============================================================================

/**
 * Describes a state change for subscriber notifications.
 * Allows subscribers to react to specific types of changes.
 *
 * Change types:
 * - mode_transition: Mode changed (e.g., idle → processing_message)
 * - activity_phase: Activity phase changed (e.g., thinking → using_tool)
 * - context_update: Mode context was updated
 *
 * @example
 * ```typescript
 * const change: StateChange = {
 *   previousState: oldState,
 *   newState: newState,
 *   changeType: 'mode_transition'
 * };
 * ```
 */
export interface StateChange {
    /** State before the change */
    previousState: BotState
    /** State after the change */
    newState:      BotState
    /** Type of change that occurred */
    changeType:    'mode_transition' | 'activity_phase' | 'context_update'
}

/**
 * Zod schema for validating state changes.
 */
// Stryker disable StringLiteral,ObjectLiteral,ArrayDeclaration: Zod schema definition - enum values tested through usage
export const stateChangeSchema = z.object({
    previousState: botStateSchema,
    newState:      botStateSchema,
    changeType:    z.enum(['mode_transition', 'activity_phase', 'context_update']),
});
// Stryker restore StringLiteral,ObjectLiteral,ArrayDeclaration

// ============================================================================
// Session Type
// ============================================================================

/**
 * Session type for routing responses.
 * Determines which channel responses should be sent to.
 */
export type SessionType = 'processing_message' | 'catching_up' | 'perching' | 'dm';

// ============================================================================
// BotStateManager Interface
// ============================================================================

/**
 * Manager interface for bot state.
 * Provides read access, mode transitions, within-mode operations, and subscriptions.
 *
 * Lifecycle:
 * 1. Create manager
 * 2. Subscribe to state changes
 * 3. Call start() to begin operation
 * 4. Use transition methods to change state
 * 5. Call stop() when shutting down
 *
 * @example
 * ```typescript
 * const manager = new BotStateManagerImpl({ logger });
 * const unsubscribe = manager.subscribe((change) => {
 *   console.log('State changed:', change.changeType);
 * });
 *
 * manager.start();
 * manager.startProcessingMessage(channelId, 'Hello!');
 * manager.updateActivityPhase({ type: 'thinking', startedAt: new Date() });
 * manager.goIdle();
 * manager.stop();
 *
 * unsubscribe();
 * ```
 */
export interface BotStateManager {
    // ========================================================================
    // Read Operations
    // ========================================================================

    /**
     * Get the current state (read-only).
     * Returns a frozen copy to prevent external mutation.
     */
    getState(): Readonly<BotState>

    /**
     * Get the current operational mode.
     */
    getMode(): OperationalMode

    /**
     * Check if presence should be updated.
     * Returns true if enough time has passed since the last presence update
     * to avoid hitting Discord rate limits.
     */
    shouldUpdatePresence(): boolean

    /**
     * Record that a presence update was successfully made.
     * Call this AFTER a successful presence update to track the timestamp
     * for throttle calculations.
     */
    recordPresenceUpdate(): void

    /**
     * Get the session type based on current mode and optional channel context.
     * Used for routing responses to the correct channel.
     *
     * @param isDMChannel - Whether the channel is a DM channel (optional)
     * @returns Session type for response routing
     */
    getSessionType(isDMChannel?: boolean): SessionType

    // ========================================================================
    // Mode Transitions
    // ========================================================================

    /**
     * Start catch-up mode for processing unread messages.
     * Transition: idle → catching_up
     *
     * @param context - Initial catch-up context
     */
    startCatchUp(context: CatchingUpModeContext): void

    /**
     * Start processing a single user message.
     * Transition: idle → processing_message
     *
     * @param channelId - Channel where message was sent
     * @param userMessage - The user's message text
     */
    startProcessingMessage(channelId: ChannelId, userMessage: string): void

    /**
     * Start perching mode for passive observation.
     * Transition: idle → perching
     *
     * @param activityType - Description of perching activity
     */
    startPerching(activityType: string): void

    /**
     * Return to idle mode.
     * Transition: any → idle
     */
    goIdle(): void

    // ========================================================================
    // Within-Mode Operations
    // ========================================================================

    /**
     * Update the current activity phase.
     * Only valid when in a mode that supports activity phases.
     *
     * @param phase - New activity phase
     */
    updateActivityPhase(phase: ActivityPhase): void

    /**
     * Clear the current activity phase.
     */
    clearActivityPhase(): void

    /**
     * Mark a channel as viewed during catch-up.
     * Only valid in catching_up mode.
     *
     * @param channelId - Channel that was viewed
     */
    markChannelViewed(channelId: ChannelId): void

    /**
     * Set the Claude agent session ID.
     * Updates the session ID in the current mode context if applicable.
     *
     * @param sessionId - The session ID to set
     */
    setSessionId(sessionId: string): void
    // ========================================================================
    // Subscriptions
    // ========================================================================

    /**
     * Subscribe to state changes.
     * The listener will be called whenever state changes occur.
     *
     * @param listener - Function to call on state changes
     * @returns Unsubscribe function
     */
    subscribe(listener: (change: StateChange) => void): () => void

    // ========================================================================
    // Lifecycle
    // ========================================================================

    /**
     * Start the state manager.
     * Must be called before using the manager.
     */
    start(): void

    /**
     * Stop the state manager and clean up resources.
     */
    stop(): void

    // ========================================================================
    // Narrow Interface Accessors
    // ========================================================================

    /**
     * Return a narrow CompactionStateManager view of this manager.
     *
     * Used to pass a type-safe reference to createCompactionHooks() without requiring
     * the caller to use `as unknown as CompactionStateManager` unsafe double-casts.
     * The returned object is structurally identical to `this` — BotStateManagerImpl
     * satisfies CompactionStateManager directly.
     */
    getCompactionStateManager(): CompactionStateManager
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard to check if a value is a valid ActivityPhase.
 *
 * @param value - Value to check
 * @returns True if value is an ActivityPhase
 *
 * @example
 * ```typescript
 * if (isActivityPhase(phase)) {
 *   console.log('Phase type:', phase.type);
 * }
 * ```
 */
export function isActivityPhase(value: unknown): value is ActivityPhase {
    const result = activityPhaseSchema.safeParse(value);
    return result.success;
}

/**
 * Type guard to check if a value is a valid ModeContext.
 *
 * @param value - Value to check
 * @returns True if value is a ModeContext
 *
 * @example
 * ```typescript
 * if (isModeContext(context)) {
 *   // context is a valid ModeContext
 * }
 * ```
 */
export function isModeContext(value: unknown): value is ModeContext {
    const result = modeContextSchema.safeParse(value);
    return result.success;
}

// ============================================================================
// Default State Factory
// ============================================================================

/**
 * Create a default bot state (idle mode).
 * Useful for initialization and testing.
 *
 * @returns Default idle state
 *
 * @example
 * ```typescript
 * const initialState = createDefaultBotState();
 * console.log(initialState.mode); // 'idle'
 * ```
 */
export function createDefaultBotState(): BotState {
    return {
        mode:          'idle',
        activityPhase: null,
        modeEnteredAt: new Date(),
        modeContext:   {},
    };
}
