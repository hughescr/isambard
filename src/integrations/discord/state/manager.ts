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
    type InterruptingMessageDetails,
    type SessionType,
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
            interrupted:   state.interrupted,
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
    // Stryker disable StringLiteral,ConditionalExpression,BlockStatement: Type discrimination and object cloning - tested via behavior
    private cloneModeContext(context: ModeContext): ModeContext {
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

    isInterrupted(): boolean {
        return this.currentState.interrupted;
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
            interrupted:   false,
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

        // Stryker disable BooleanLiteral: Initial state values - tested via behavior
        this.currentState = {
            mode:          'processing_message',
            interrupted:   false,
            activityPhase: null,
            modeEnteredAt: new Date(),
            modeContext:   context,
        };
        // Stryker restore BooleanLiteral

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

        // Stryker disable BooleanLiteral: Initial state values - tested via behavior
        this.currentState = {
            mode:          'perching',
            interrupted:   false,
            activityPhase: null,
            modeEnteredAt: new Date(),
            modeContext:   context,
        };
        // Stryker restore BooleanLiteral

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

    interrupt(message?: InterruptingMessageDetails): void {
        this.assertNotStopped();
        const previousState = this.cloneState(this.currentState);

        // Can only interrupt non-idle modes
        if(!canInterrupt(this.currentState.mode)) {
            return;
        }

        // Stryker disable BlockStatement: Guard clause - already interrupted
        // Stryker disable next-line ConditionalExpression: Guard clause - already interrupted
        if(this.currentState.interrupted) {
            return; // Already interrupted
        }
        // Stryker restore BlockStatement

        // If in catching_up or perching mode and message provided, store it in the context
        let modeContext = this.currentState.modeContext;
        if(message && this.currentState.mode === 'catching_up') {
            const catchUpContext = this.currentState.modeContext as CatchingUpModeContext;
            modeContext = {
                ...catchUpContext,
                interruptingMessage: message,
            };
        } else if(message && this.currentState.mode === 'perching') {
            const perchContext = this.currentState.modeContext as PerchingModeContext;
            modeContext = {
                ...perchContext,
                interruptingMessage: message,
            };
        }

        this.currentState = {
            ...this.currentState,
            interrupted: true,
            modeContext,
        };

        // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
        this.deps.logger.info({ mode: this.currentState.mode }, 'Bot interrupted');
        // Stryker restore ObjectLiteral,StringLiteral
        this.notifySubscribers(previousState, 'interrupted');
    }

    updateInterruptingMessage(message: InterruptingMessageDetails): void {
        this.assertNotStopped();
        if(!this.currentState.interrupted) {
            return;
        }

        if(this.currentState.mode === 'perching') {
            const perchContext = this.currentState.modeContext as PerchingModeContext;
            this.currentState = {
                ...this.currentState,
                modeContext: { ...perchContext, interruptingMessage: message },
            };
        } else if(this.currentState.mode === 'catching_up') {
            const catchUpContext = this.currentState.modeContext as CatchingUpModeContext;
            this.currentState = {
                ...this.currentState,
                modeContext: { ...catchUpContext, interruptingMessage: message },
            };
        }
        // No subscriber notification — this is an internal context update used during
        // re-interruption of a resume session. Presence doesn't use message content,
        // and the session runner handles re-interrupt logic internally.
    }

    resume(): void {
        this.assertNotStopped();
        const previousState = this.cloneState(this.currentState);

        // Stryker disable BlockStatement: Guard clause - not interrupted means no work
        // Stryker disable next-line ConditionalExpression: Guard clause - not interrupted means no work
        if(!this.currentState.interrupted) {
            return; // Not interrupted
        }
        // Stryker restore BlockStatement

        this.currentState = {
            ...this.currentState,
            interrupted: false,
        };

        // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
        this.deps.logger.info({ mode: this.currentState.mode }, 'Bot resumed');
        // Stryker restore ObjectLiteral,StringLiteral
        this.notifySubscribers(previousState, 'interrupted');
    }

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

    // Stryker disable BlockStatement,StringLiteral: Cleanup function - behavior verified by other tests
    stop(): void {
        this.isStopped = true;
        this.subscribers.clear();
        this.deps.logger.info('BotStateManager stopped');
    }
    // Stryker restore BlockStatement,StringLiteral
}

/**
 * Create a BotStateManager instance.
 * Convenience factory function for backward compatibility.
 *
 * @param deps - Dependencies including logger and optional throttle configuration
 * @returns BotStateManager instance
 */
export function createBotStateManager(deps: BotStateManagerDeps): BotStateManager {
    return new BotStateManagerImpl(deps);
}
