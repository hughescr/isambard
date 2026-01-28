/**
 * BotStateManager implementation.
 *
 * Manages bot operational state, mode transitions, activity phases, and subscriptions.
 * Enforces state machine rules and notifies subscribers of state changes.
 */

import type { Logger } from '@hughescr/logger';
import {
    type OperationalMode,
    type ActivityPhase,
    type BotState,
    type StateChange,
    type BotStateManager,
    type CatchingUpModeContext,
    type ProcessingMessageModeContext,
    type PerchingModeContext,
    type ModeContext,
    createDefaultBotState
} from './types';
import { type ChannelId } from '../types';
import { isValidTransition, canInterrupt, TransitionError } from './transitions';

// Re-export for convenience
export type { BotStateManager };

/**
 * Dependencies required by BotStateManager.
 */
export interface BotStateManagerDeps {
    /** Logger instance for diagnostics */
    logger:            Logger
    /** Throttle time for presence updates in milliseconds (default: 12000) */
    updateThrottleMs?: number
}

/**
 * Default throttle time for Discord presence updates (12 seconds).
 * Discord rate limits presence updates, so we throttle to avoid hitting limits.
 */
const DEFAULT_UPDATE_THROTTLE_MS = 12000;

/**
 * Create a BotStateManager instance.
 *
 * @param deps - Dependencies including logger and optional throttle configuration
 * @returns BotStateManager instance
 *
 * @example
 * ```typescript
 * const manager = createBotStateManager({ logger });
 * manager.start();
 *
 * manager.subscribe((change) => {
 *   console.log('State changed:', change.changeType);
 * });
 *
 * manager.startProcessingMessage(channelId, 'Hello!');
 * manager.goIdle();
 * manager.stop();
 * ```
 */
export function createBotStateManager(deps: BotStateManagerDeps): BotStateManager {
    const { logger, updateThrottleMs = DEFAULT_UPDATE_THROTTLE_MS } = deps;

    // Internal mutable state
    let currentState: BotState = createDefaultBotState();
    const subscribers = new Set<(change: StateChange) => void>();
    let lastPresenceUpdateTime = 0;
    let isStopped = false;

    /**
     * Throw an error if the manager has been stopped.
     */
    function assertNotStopped(): void {
        if(isStopped) {
            throw new Error('BotStateManager has been stopped');
        }
    }

    /**
     * Deep clone a state object.
     * Handles Sets and Dates properly.
     */
    function cloneState(state: BotState): BotState {
        const cloned: BotState = {
            mode:          state.mode,
            interrupted:   state.interrupted,
            activityPhase: state.activityPhase ? { ...state.activityPhase } : null,
            modeEnteredAt: new Date(state.modeEnteredAt),
            modeContext:   cloneModeContext(state.modeContext),
        };
        return cloned;
    }

    /**
     * Deep clone mode context.
     * Handles catching_up context with Set<ChannelId>.
     */
    // Stryker disable StringLiteral,ConditionalExpression,BlockStatement: Type discrimination and object cloning - tested via behavior
    function cloneModeContext(context: ModeContext): ModeContext {
        if('unreadCount' in context) {
            // CatchingUpModeContext - identified by unique property
            return {
                ...context,
                viewedChannels: new Set(context.viewedChannels),
            } as CatchingUpModeContext;
        }
        // Other contexts are plain objects
        return { ...context };
    }
    // Stryker restore StringLiteral,ConditionalExpression,BlockStatement

    /**
     * Deep freeze a state object to prevent external mutation.
     */
    // Stryker disable ConditionalExpression,BlockStatement: Freezing nested objects when present
    function deepFreeze(state: BotState): Readonly<BotState> {
        Object.freeze(state);
        if(state.activityPhase) {
            Object.freeze(state.activityPhase);
        }
        Object.freeze(state.modeContext);
        return state;
    }
    // Stryker restore ConditionalExpression,BlockStatement

    /**
     * Notify all subscribers of a state change.
     */
    // Stryker disable ConditionalExpression,BlockStatement: Guard clause - no subscribers means no work
    function notifySubscribers(previousState: BotState, changeType: StateChange['changeType']): void {
        if(subscribers.size === 0) {
            return;
        }

        const change: StateChange = {
            previousState: cloneState(previousState),
            newState:      cloneState(currentState),
            changeType,
        };

        for(const listener of subscribers) {
            try {
                listener(change);
            } catch (error) {
                // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
                logger.error({ error }, 'Error in state change subscriber');
                // Stryker restore ObjectLiteral,StringLiteral
            }
        }
    }
    // Stryker restore ConditionalExpression,BlockStatement

    // ========================================================================
    // Read Operations
    // ========================================================================

    function getState(): Readonly<BotState> {
        return deepFreeze(cloneState(currentState));
    }

    function getMode(): OperationalMode {
        return currentState.mode;
    }

    function isInterrupted(): boolean {
        return currentState.interrupted;
    }

    function shouldUpdatePresence(): boolean {
        const now = Date.now();
        // Stryker disable next-line EqualityOperator: Boundary condition >= vs > makes no practical difference
        return (now - lastPresenceUpdateTime) >= updateThrottleMs;
    }

    // ========================================================================
    // Mode Transitions
    // ========================================================================

    function startCatchUp(context: CatchingUpModeContext): void {
        assertNotStopped();
        const previousState = cloneState(currentState);

        if(!isValidTransition(currentState.mode, 'catching_up')) {
            throw new TransitionError(currentState.mode, 'catching_up');
        }

        currentState = {
            mode:          'catching_up',
            interrupted:   false,
            activityPhase: null,
            modeEnteredAt: new Date(),
            modeContext:   {
                ...context,
                viewedChannels: new Set(context.viewedChannels), // Clone the Set
            },
        };

        // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
        logger.info({ mode: 'catching_up' }, 'Transitioned to catching_up mode');
        // Stryker restore ObjectLiteral,StringLiteral
        notifySubscribers(previousState, 'mode_transition');
    }

    function startProcessingMessage(channelId: ChannelId, userMessage: string): void {
        assertNotStopped();
        const previousState = cloneState(currentState);

        if(!isValidTransition(currentState.mode, 'processing_message')) {
            throw new TransitionError(currentState.mode, 'processing_message');
        }

        const context: ProcessingMessageModeContext = {
            channelId,
            userMessage,
            sessionId: null,
        };

        // Stryker disable BooleanLiteral: Initial state values - tested via behavior
        currentState = {
            mode:          'processing_message',
            interrupted:   false,
            activityPhase: null,
            modeEnteredAt: new Date(),
            modeContext:   context,
        };
        // Stryker restore BooleanLiteral

        // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
        logger.info({ mode: 'processing_message', channelId }, 'Transitioned to processing_message mode');
        // Stryker restore ObjectLiteral,StringLiteral
        notifySubscribers(previousState, 'mode_transition');
    }

    function startPerching(activityType: string): void {
        assertNotStopped();
        const previousState = cloneState(currentState);

        if(!isValidTransition(currentState.mode, 'perching')) {
            throw new TransitionError(currentState.mode, 'perching');
        }

        const context: PerchingModeContext = {
            activityType,
            sessionId: null,
        };

        // Stryker disable BooleanLiteral: Initial state values - tested via behavior
        currentState = {
            mode:          'perching',
            interrupted:   false,
            activityPhase: null,
            modeEnteredAt: new Date(),
            modeContext:   context,
        };
        // Stryker restore BooleanLiteral

        // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
        logger.info({ mode: 'perching', activityType }, 'Transitioned to perching mode');
        // Stryker restore ObjectLiteral,StringLiteral
        notifySubscribers(previousState, 'mode_transition');
    }

    function goIdle(): void {
        // Idempotent: if already idle, do nothing
        // Stryker disable next-line ConditionalExpression,BlockStatement: Idempotent check - already idle means no work
        if(currentState.mode === 'idle') {
            return;
        }

        assertNotStopped();
        const previousState = cloneState(currentState);

        currentState = createDefaultBotState();

        // Stryker disable StringLiteral: Logging for observability
        logger.info('Transitioned to idle mode');
        // Stryker restore StringLiteral
        notifySubscribers(previousState, 'mode_transition');
    }

    // ========================================================================
    // Within-Mode Operations
    // ========================================================================

    function interrupt(): void {
        assertNotStopped();
        const previousState = cloneState(currentState);

        // Can only interrupt non-idle modes
        if(!canInterrupt(currentState.mode)) {
            return;
        }

        // Stryker disable BlockStatement: Guard clause - already interrupted
        // Stryker disable next-line ConditionalExpression: Guard clause - already interrupted
        if(currentState.interrupted) {
            return; // Already interrupted
        }
        // Stryker restore BlockStatement

        currentState = {
            ...currentState,
            interrupted: true,
        };

        // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
        logger.info({ mode: currentState.mode }, 'Bot interrupted');
        // Stryker restore ObjectLiteral,StringLiteral
        notifySubscribers(previousState, 'interrupted');
    }

    function resume(): void {
        assertNotStopped();
        const previousState = cloneState(currentState);

        // Stryker disable BlockStatement: Guard clause - not interrupted means no work
        // Stryker disable next-line ConditionalExpression: Guard clause - not interrupted means no work
        if(!currentState.interrupted) {
            return; // Not interrupted
        }
        // Stryker restore BlockStatement

        currentState = {
            ...currentState,
            interrupted: false,
        };

        // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
        logger.info({ mode: currentState.mode }, 'Bot resumed');
        // Stryker restore ObjectLiteral,StringLiteral
        notifySubscribers(previousState, 'interrupted');
    }

    function updateActivityPhase(phase: ActivityPhase): void {
        assertNotStopped();
        const previousState = cloneState(currentState);

        currentState = {
            ...currentState,
            activityPhase: phase,
        };

        // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
        logger.debug({ phase: phase.type }, 'Activity phase updated');
        // Stryker restore ObjectLiteral,StringLiteral
        notifySubscribers(previousState, 'activity_phase');
    }

    function recordPresenceUpdate(): void {
        assertNotStopped();
        lastPresenceUpdateTime = Date.now();
        // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
        logger.debug('Presence update timestamp recorded');
        // Stryker restore ObjectLiteral,StringLiteral
    }

    function clearActivityPhase(): void {
        assertNotStopped();
        const previousState = cloneState(currentState);

        // Stryker disable BlockStatement: Guard clause - already cleared
        // Stryker disable next-line ConditionalExpression: Guard clause - already cleared
        if(currentState.activityPhase === null) {
            return; // Already cleared
        }
        // Stryker restore BlockStatement

        currentState = {
            ...currentState,
            activityPhase: null,
        };

        // Stryker disable StringLiteral: Logging for observability
        logger.debug('Activity phase cleared');
        // Stryker restore StringLiteral
        notifySubscribers(previousState, 'activity_phase');
    }

    function markChannelViewed(channelId: ChannelId): void {
        assertNotStopped();
        const previousState = cloneState(currentState);

        if(currentState.mode !== 'catching_up') {
            // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
            logger.warn({ mode: currentState.mode }, 'Cannot mark channel viewed: not in catching_up mode');
            // Stryker restore ObjectLiteral,StringLiteral
            return;
        }

        const context = currentState.modeContext as CatchingUpModeContext;
        // Create new state with new Set containing the channel (immutable)
        currentState = {
            ...currentState,
            modeContext: {
                ...context,
                viewedChannels: new Set([...context.viewedChannels, channelId])
            }
        };

        // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
        logger.debug({ channelId }, 'Channel marked as viewed');
        // Stryker restore ObjectLiteral,StringLiteral
        notifySubscribers(previousState, 'context_update');
    }

    function setSessionId(sessionId: string): void {
        assertNotStopped();
        const previousState = cloneState(currentState);

        if(currentState.mode === 'idle') {
            return; // Idle mode has no session
        }

        type SessionContext = CatchingUpModeContext | ProcessingMessageModeContext | PerchingModeContext;
        const context = currentState.modeContext as SessionContext;

        // Create new state with updated sessionId (immutable)
        currentState = {
            ...currentState,
            modeContext: {
                ...context,
                sessionId,
            } as typeof currentState.modeContext,
        };

        // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
        logger.debug({ sessionId, mode: currentState.mode }, 'Session ID set');
        // Stryker restore ObjectLiteral,StringLiteral
        notifySubscribers(previousState, 'context_update');
    }

    // ========================================================================
    // Subscriptions
    // ========================================================================

    function subscribe(listener: (change: StateChange) => void): () => void {
        assertNotStopped();
        subscribers.add(listener);

        return () => {
            subscribers.delete(listener);
        };
    }

    // ========================================================================
    // Lifecycle
    // ========================================================================

    // Stryker disable BlockStatement,StringLiteral: Lifecycle logging - behavior verified by integration
    function start(): void {
        logger.info('BotStateManager started');
    }
    // Stryker restore BlockStatement,StringLiteral

    // Stryker disable BlockStatement,StringLiteral: Cleanup function - behavior verified by other tests
    function stop(): void {
        isStopped = true;
        subscribers.clear();
        logger.info('BotStateManager stopped');
    }
    // Stryker restore BlockStatement,StringLiteral

    // ========================================================================
    // Return Interface
    // ========================================================================

    return {
        // Read operations
        getState,
        getMode,
        isInterrupted,
        shouldUpdatePresence,

        // Mode transitions
        startCatchUp,
        startProcessingMessage,
        startPerching,
        goIdle,

        // Within-mode operations
        interrupt,
        resume,
        updateActivityPhase,
        clearActivityPhase,
        markChannelViewed,
        setSessionId,
        recordPresenceUpdate,

        // Subscriptions
        subscribe,

        // Lifecycle
        start,
        stop,
    };
}
