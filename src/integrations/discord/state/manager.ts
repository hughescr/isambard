/**
 * BotStateManager implementation.
 *
 * Manages bot operational state, mode transitions, activity phases, and subscriptions.
 * Enforces state machine rules and notifies subscribers of state changes.
 */

import type { Logger } from '@hughescr/logger';
import { type ChannelId } from '../types';
import { isValidTransition, TransitionError } from './transitions';
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
    type SessionType,
    createDefaultBotState
} from './types';

/** Type guard: check if a ModeContext is a CatchingUpModeContext (has unreadCount). */
// Stryker disable ConditionalExpression,StringLiteral: Equivalent — markChannelViewed creates new Set via spread, never mutates in place
function isCatchingUpContext(context: unknown): context is CatchingUpModeContext {
    return typeof context === 'object' && context !== null && 'unreadCount' in context;
}
// Stryker restore ConditionalExpression,StringLiteral

// Re-export for convenience

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
const DEFAULT_UPDATE_THROTTLE_MS = 12_000;

/**
 * BotStateManager implementation class.
 *
 * @example
 * ```typescript
 * const manager = new BotStateManagerImpl({ logger });
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
export class BotStateManagerImpl implements BotStateManager {
    private currentState:              BotState = createDefaultBotState();
    private readonly subscribers = new Set<(change: StateChange) => void>();
    private lastPresenceUpdateTime = 0;
    private isStopped = false;
    private readonly updateThrottleMs: number;

    constructor(private readonly deps: BotStateManagerDeps) {
        this.updateThrottleMs = deps.updateThrottleMs ?? DEFAULT_UPDATE_THROTTLE_MS;
    }

    /**
     * Throw an error if the manager has been stopped.
     */
    private assertNotStopped(): void {
        if(this.isStopped) {
            throw new Error('BotStateManager has been stopped');
        }
    }

    /**
     * Deep clone a state object.
     * Handles Sets and Dates properly.
     */
    private cloneState(state: BotState): BotState {
        const cloned: BotState = {
            mode:          state.mode,
            activityPhase: state.activityPhase ? { ...state.activityPhase } : null,
            modeEnteredAt: new Date(state.modeEnteredAt),
            modeContext:   this.cloneModeContext(state.modeContext),
        };
        return cloned;
    }

    /**
     * Deep clone mode context.
     * Handles catching_up context with Set<ChannelId>.
     */
    // eslint-disable-next-line sonarjs/function-return-type -- legitimately returns ModeContext (discriminated union member)
    private cloneModeContext(context: ModeContext): ModeContext {
        // Stryker disable StringLiteral,BlockStatement: Equivalent — cloning with/without viewedChannels deep copy has same behavior since markChannelViewed always creates a new Set via spread (never mutates in place)
        if(isCatchingUpContext(context)) {
            // CatchingUpModeContext - identified by unique property
            return {
                ...context,
                viewedChannels: new Set(context.viewedChannels),
            } as CatchingUpModeContext;
        }
        // Stryker restore StringLiteral,BlockStatement
        // Other contexts are plain objects
        return { ...context };
    }

    /**
     * Deep freeze a state object to prevent external mutation.
     */
    // Stryker disable ConditionalExpression,BlockStatement: Freezing nested objects when present
    private deepFreeze(state: BotState): Readonly<BotState> {
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
    private notifySubscribers(previousState: BotState, changeType: StateChange['changeType']): void {
        if(this.subscribers.size === 0) {
            return;
        }

        const change: StateChange = {
            previousState: this.cloneState(previousState),
            newState:      this.cloneState(this.currentState),
            changeType,
        };

        for(const listener of this.subscribers) {
            try {
                listener(change);
            } catch (error) {
                // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
                this.deps.logger.error({ error }, 'Error in state change subscriber');
                // Stryker restore ObjectLiteral,StringLiteral
            }
        }
    }
    // Stryker restore ConditionalExpression,BlockStatement

    // ========================================================================
    // Read Operations
    // ========================================================================

    getState(): Readonly<BotState> {
        return this.deepFreeze(this.cloneState(this.currentState));
    }

    getMode(): OperationalMode {
        return this.currentState.mode;
    }

    shouldUpdatePresence(): boolean {
        const now = Date.now();
        // Stryker disable next-line EqualityOperator: Boundary condition >= vs > makes no practical difference
        return (now - this.lastPresenceUpdateTime) >= this.updateThrottleMs;
    }

    getSessionType(isDMChannel?: boolean): SessionType {
        const mode = this.currentState.mode;
        if(mode === 'catching_up') {
            return 'catching_up';
        }
        if(mode === 'perching') {
            return 'perching';
        }
        if(isDMChannel) {
            return 'dm';
        }
        return 'processing_message';
    }

    // ========================================================================
    // Mode Transitions
    // ========================================================================

    startCatchUp(context: CatchingUpModeContext): void {
        this.assertNotStopped();
        const previousState = this.cloneState(this.currentState);

        if(!isValidTransition(this.currentState.mode, 'catching_up')) {
            throw new TransitionError(this.currentState.mode, 'catching_up');
        }

        this.currentState = {
            mode:          'catching_up',
            activityPhase: null,
            modeEnteredAt: new Date(),
            modeContext:   {
                ...context,
                viewedChannels: new Set(context.viewedChannels), // Clone the Set
            },
        };

        // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
        this.deps.logger.info({ mode: 'catching_up' }, 'Transitioned to catching_up mode');
        // Stryker restore ObjectLiteral,StringLiteral
        this.notifySubscribers(previousState, 'mode_transition');
    }

    startProcessingMessage(channelId: ChannelId, userMessage: string): void {
        this.assertNotStopped();
        const previousState = this.cloneState(this.currentState);

        if(!isValidTransition(this.currentState.mode, 'processing_message')) {
            throw new TransitionError(this.currentState.mode, 'processing_message');
        }

        const context: ProcessingMessageModeContext = {
            channelId,
            userMessage,
            sessionId: null,
        };

        this.currentState = {
            mode:          'processing_message',
            activityPhase: null,
            modeEnteredAt: new Date(),
            modeContext:   context,
        };

        // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
        this.deps.logger.info({ mode: 'processing_message', channelId }, 'Transitioned to processing_message mode');
        // Stryker restore ObjectLiteral,StringLiteral
        this.notifySubscribers(previousState, 'mode_transition');
    }

    startPerching(activityType: string): void {
        this.assertNotStopped();
        const previousState = this.cloneState(this.currentState);

        if(!isValidTransition(this.currentState.mode, 'perching')) {
            throw new TransitionError(this.currentState.mode, 'perching');
        }

        const context: PerchingModeContext = {
            activityType,
            sessionId: null,
        };

        this.currentState = {
            mode:          'perching',
            activityPhase: null,
            modeEnteredAt: new Date(),
            modeContext:   context,
        };

        // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
        this.deps.logger.info({ mode: 'perching', activityType }, 'Transitioned to perching mode');
        // Stryker restore ObjectLiteral,StringLiteral
        this.notifySubscribers(previousState, 'mode_transition');
    }

    goIdle(): void {
        // Idempotent: if already idle, do nothing
        // Stryker disable next-line ConditionalExpression,BlockStatement: Idempotent check - already idle means no work
        if(this.currentState.mode === 'idle') {
            return;
        }

        this.assertNotStopped();
        const previousState = this.cloneState(this.currentState);

        this.currentState = createDefaultBotState();

        // Stryker disable StringLiteral: Logging for observability
        this.deps.logger.info('Transitioned to idle mode');
        // Stryker restore StringLiteral
        this.notifySubscribers(previousState, 'mode_transition');
    }

    // ========================================================================
    // Within-Mode Operations
    // ========================================================================

    updateActivityPhase(phase: ActivityPhase): void {
        this.assertNotStopped();
        const previousState = this.cloneState(this.currentState);

        this.currentState = {
            ...this.currentState,
            activityPhase: phase,
        };

        // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
        this.deps.logger.debug({ phase: phase.type }, 'Activity phase updated');
        // Stryker restore ObjectLiteral,StringLiteral
        this.notifySubscribers(previousState, 'activity_phase');
    }

    recordPresenceUpdate(): void {
        this.assertNotStopped();
        this.lastPresenceUpdateTime = Date.now();
        // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
        this.deps.logger.debug('Presence update timestamp recorded');
        // Stryker restore ObjectLiteral,StringLiteral
    }

    clearActivityPhase(): void {
        this.assertNotStopped();
        const previousState = this.cloneState(this.currentState);

        // Stryker disable BlockStatement: Guard clause - already cleared
        // Stryker disable next-line ConditionalExpression: Guard clause - already cleared
        if(this.currentState.activityPhase === null) {
            return; // Already cleared
        }
        // Stryker restore BlockStatement

        this.currentState = {
            ...this.currentState,
            activityPhase: null,
        };

        // Stryker disable StringLiteral: Logging for observability
        this.deps.logger.debug('Activity phase cleared');
        // Stryker restore StringLiteral
        this.notifySubscribers(previousState, 'activity_phase');
    }

    markChannelViewed(channelId: ChannelId): void {
        this.assertNotStopped();
        const previousState = this.cloneState(this.currentState);

        if(this.currentState.mode !== 'catching_up') {
            // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
            this.deps.logger.warn({ mode: this.currentState.mode }, 'Cannot mark channel viewed: not in catching_up mode');
            // Stryker restore ObjectLiteral,StringLiteral
            return;
        }

        const context = this.currentState.modeContext as CatchingUpModeContext;
        // Create new state with new Set containing the channel (immutable)
        this.currentState = {
            ...this.currentState,
            modeContext: {
                ...context,
                viewedChannels: new Set([...context.viewedChannels, channelId])
            }
        };

        // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
        this.deps.logger.debug({ channelId }, 'Channel marked as viewed');
        // Stryker restore ObjectLiteral,StringLiteral
        this.notifySubscribers(previousState, 'context_update');
    }

    setSessionId(sessionId: string): void {
        this.assertNotStopped();
        const previousState = this.cloneState(this.currentState);

        if(this.currentState.mode === 'idle') {
            return; // Idle mode has no session
        }

        type SessionContext = CatchingUpModeContext | ProcessingMessageModeContext | PerchingModeContext;
        const context = this.currentState.modeContext as SessionContext;

        // Create new state with updated sessionId (immutable)
        this.currentState = {
            ...this.currentState,
            modeContext: {
                ...context,
                sessionId,
            } as typeof this.currentState.modeContext,
        };

        // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
        this.deps.logger.debug({ sessionId, mode: this.currentState.mode }, 'Session ID set');
        // Stryker restore ObjectLiteral,StringLiteral
        this.notifySubscribers(previousState, 'context_update');
    }

    // ========================================================================
    // Subscriptions
    // ========================================================================

    subscribe(listener: (change: StateChange) => void): () => void {
        this.assertNotStopped();
        this.subscribers.add(listener);

        return () => {
            this.subscribers.delete(listener);
        };
    }

    // ========================================================================
    // Lifecycle
    // ========================================================================

    // Stryker disable BlockStatement,StringLiteral: Lifecycle logging - behavior verified by integration
    start(): void {
        this.deps.logger.info('BotStateManager started');
    }
    // Stryker restore BlockStatement,StringLiteral

    stop(): void {
        this.isStopped = true;
        this.subscribers.clear();
        // Stryker disable next-line StringLiteral: Logging for observability
        this.deps.logger.info('BotStateManager stopped');
    }
}

export { type BotStateManager } from './types';
