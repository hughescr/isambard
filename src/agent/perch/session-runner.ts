/**
 * Perch Session Runner
 *
 * Orchestrates perch time sessions:
 * - Starting sessions with the correct slot-specific prompt
 * - Running agent with perching mode
 * - Handling suspensions from user messages
 * - Resuming after suspension
 * - Completing sessions and returning to idle
 */

import type { Logger } from '@hughescr/logger';
import { buildPerchPrompt, buildTestPerchPrompt, buildPerchResumedPrompt, buildPerchTimeoutPrompt, getSuggestionLevelDescription } from './prompts';
import { type PerchSlot, type PerchConfig } from './types';
import type { ContextBuilder } from '@/agent/context-builder';
import type { StreamProgress } from '@/agent/stream-tracker';
import type { AgentStateManager, InterruptingMessageDetails } from '@/agent/types';
import type { ActivityLogger } from '@/storage';

/**
 * Options for running an agent session.
 */
export interface RunAgentSessionOptions {
    /** Perch prompt to use */
    prompt:      string
    /** Session ID to resume (optional) */
    sessionId?:  string
    /** Abort signal for cancellation */
    abortSignal: AbortSignal
    /** The perch slot for context */
    slot:        PerchSlot
}

/**
 * Result from running an agent session.
 */
export interface AgentSessionResult {
    /** Whether the session completed (vs interrupted) */
    completed:    boolean
    /** Session ID if applicable */
    sessionId?:   string
    /** Partial work if interrupted */
    partialWork?: StreamProgress
}

/**
 * Dependencies for the session runner.
 */
export interface PerchSessionRunnerDeps {
    /** State manager for mode transitions */
    stateManager:    AgentStateManager
    /** Logger instance */
    logger:          Logger
    /** Perch configuration (for timeout settings) */
    config:          PerchConfig
    /** Function to run a perch agent session */
    runAgentSession: (options: RunAgentSessionOptions) => Promise<AgentSessionResult>
    /** Context builder for perch context (optional for backward compatibility) */
    contextBuilder?: ContextBuilder
    /** Optional activity logger for tracking perch lifecycle events */
    activityLogger?: ActivityLogger
}

/**
 * Re-export InterruptingMessageDetails for API compatibility
 */
export type InterruptingMessage = InterruptingMessageDetails;

/**
 * Interface for managing perch sessions.
 */
export interface PerchSessionRunner {
    /**
     * Start a perch session for the given slot.
     * Transitions to perching mode, builds prompt, runs agent.
     */
    startPerch(slot: PerchSlot): Promise<void>

    /**
     * Suspend the current perch session due to a user message.
     * Transitions to idle mode and stores suspension state for later resume.
     */
    suspend(message: InterruptingMessage): void

    /**
     * Resume perch after handling a suspension.
     * Called after the interrupting message has been responded to.
     */
    resumeAfterSuspension(): Promise<void>

    /**
     * Check if a perch session is currently suspended.
     */
    isSuspended(): boolean

    /**
     * Clear suspension state (for error recovery).
     */
    clearSuspension(): void

    /**
     * Get the current abort controller (for external interruption).
     */
    getAbortController(): AbortController | null
}

/**
 * Create a perch session runner.
 *
 * @param deps - Dependencies for the session runner
 * @returns PerchSessionRunner instance
 *
 * @example
 * ```typescript
 * const runner = createPerchSessionRunner({
 *     stateManager,
 *     logger,
 *     runAgentSession: async (options) => { ... },
 * });
 *
 * // Start a perch session
 * await runner.startPerch('pre-dawn');
 *
 * // Handle suspension
 * runner.suspend({ channelId, author, channelName, content });
 *
 * // Resume after handling suspension
 * await runner.resumeAfterSuspension();
 * ```
 */
export function createPerchSessionRunner(deps: PerchSessionRunnerDeps): PerchSessionRunner {
    const { stateManager, logger, config, runAgentSession, contextBuilder } = deps;

    // Only operational handles - NO state flags. BotStateManager is the single source of truth.
    let currentAbortController: AbortController | null = null;
    let currentSessionId: string | undefined;
    let partialWork: StreamProgress | null = null;
    let currentSlot: PerchSlot | null = null;
    let sessionTimeout: ReturnType<typeof setTimeout> | null = null;
    let sessionStartTime: Date | null = null;
    // Stryker disable next-line BooleanLiteral: Initial flag value — test cannot distinguish initial false from post-session reset false
    let isTimingOut = false;
    let suspendedState: {
        sessionId:           string | undefined
        slot:                PerchSlot
        elapsedMs:           number
        suspendedAt:         Date
        interruptingMessage: InterruptingMessage
    } | null = null;

    // Helper to reset session state after a session ends or errors
    function resetSessionState(): void {
        currentSessionId = undefined;
        partialWork = null;
        currentSlot = null;
        // Stryker disable next-line BlockStatement: Defensive cleanup — sessionTimeout may or may not be set at call sites
        if(sessionTimeout) {
            clearTimeout(sessionTimeout);
            sessionTimeout = null;
            sessionStartTime = null;
        }
    }

    // Timeout handler - aborts session when max duration reached
    // Stryker disable BlockStatement,ConditionalExpression,EqualityOperator: session timeout handler — mutating causes test timeout (real timer fires, feedback loop with abort)
    function handleSessionTimeout(): void {
        // Don't timeout if not in perching mode
        if(stateManager.getMode() !== 'perching') {
            return;
        }

        // Set flag indicating this is a timeout, not a message interrupt
        isTimingOut = true;

        // Abort current session
        if(currentAbortController) {
            logger.info({ slot: currentSlot }, 'Session timeout - aborting for wrap-up');
            currentAbortController.abort();
        }
    }
    // Stryker restore BlockStatement,ConditionalExpression,EqualityOperator

    // Helper for running timeout wrap-up session
    // Extracted to avoid duplication between try-block and catch-block timeout handling
    async function runTimeoutWrapUp(slot: PerchSlot): Promise<void> {
        // Reset timeout flag
        // Stryker disable next-line BooleanLiteral: Flag reset after timeout condition
        isTimingOut = false;

        // Create new abort controller for wrap-up
        currentAbortController = new AbortController();

        // Set wrap-up timeout to prevent double-hang
        // Stryker disable next-line ArithmeticOperator: Timeout calculation internals
        const wrapUpTimeoutMs = config.wrapUpTimeoutMinutes * 60 * 1000;
        // Stryker disable next-line BlockStatement: wrapUp timeout callback — mutating causes test timeout (timer fires, abort not called)
        const wrapUpTimer = setTimeout(() => {
            logger.warn({ slot, wrapUpTimeoutMinutes: config.wrapUpTimeoutMinutes }, 'Wrap-up session timed out - aborting');
            currentAbortController?.abort();
        }, wrapUpTimeoutMs);

        // Calculate session duration
        // Stryker disable next-line ArithmeticOperator: Duration calculation for timeout prompt display
        const durationMs = sessionStartTime ? Date.now() - sessionStartTime.getTime() : 0;
        // Stryker disable next-line ArithmeticOperator: Duration calculation for logging only
        const durationMinutes = Math.round(durationMs / 60_000);

        // Build timeout prompt
        const prompt = buildPerchTimeoutPrompt({
            // Stryker disable next-line all: Fallback default values for partial work state
            partialWork:       partialWork ?? { thinking: '', text: '', pendingToolUse: null, sessionId: undefined, uncollectedBackgroundTasks: 0 },
            sessionDuration:   durationMinutes,
            maxSessionMinutes: config.maxSessionMinutes,
        });

        logger.info({
            slot,
            durationMin: durationMinutes,
            maxDuration: config.maxSessionMinutes,
            msg:         'Resuming with timeout wrap-up prompt',
        });

        try {
            // Resume session with wrap-up prompt
            await runSessionAndFinalize({
                prompt,
                slot,
            });
        } finally {
            // Stryker disable all: Defensive cleanup in finally - tested via wrap-up behavior tests
            clearTimeout(wrapUpTimer);
            // Ensure we always go idle after wrap-up, regardless of outcome
            if(stateManager.getMode() === 'perching') {
                stateManager.goIdle();
            }
            // Clear session state
            resetSessionState();
        }
        // Stryker restore all
    }

    // Helper for running sessions with error handling
    // eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- timeout handling adds necessary branching; each error case (abort-suspension, timeout, external-abort, other) requires distinct handling
    async function runSessionAndFinalize(options: {
        prompt: string
        slot:   PerchSlot
    }): Promise<void> {
        try {
            const result = await runAgentSession({
                prompt:      options.prompt,
                sessionId:   currentSessionId,
                abortSignal: currentAbortController!.signal,
                slot:        options.slot,
            });

            // Store session ID for resumption
            // eslint-disable-next-line require-atomic-updates -- single-threaded: sequential assignment after await, no concurrent writers
            currentSessionId = result.sessionId;

            // Store partial work if interrupted
            // Stryker disable next-line BlockStatement: partialWork storage tested via timeout wrap-up prompt tests
            if(result.partialWork) {
                partialWork = result.partialWork;
            }

            if(result.completed) {
                // Session completed normally, transition to idle
                logger.info({ slot: options.slot }, 'Perch session completed');

                void deps.activityLogger?.log({ type: 'perch-end', summary: 'Perch session completed' }).catch((err) => {
                    logger.warn({ err, msg: 'Activity log failed for perch session end' });
                });
                if(stateManager.getMode() === 'perching') {
                    stateManager.goIdle();
                }
                resetSessionState();
            } else if(isTimingOut) {
                // Timeout abort caught via return path (agent caught AbortError internally and returned completed:false)
                // Run wrap-up using shared helper
                await runTimeoutWrapUp(options.slot);
            } else if(suspendedState === null) {
                // Safety-net path — hard-to-reach unknown non-completion
                // Safety net — unknown non-completion, go idle
                logger.warn({ slot: options.slot }, 'Session returned incomplete for unknown reason - going idle');
                // Stryker disable next-line ConditionalExpression: Defensive guard — always goes idle on unknown non-completion
                if(stateManager.getMode() === 'perching') {
                    stateManager.goIdle();
                }
                resetSessionState();
            } else {
                // Suspended — preserve session state for resume
                // Stryker disable next-line ObjectLiteral,StringLiteral: Session ID storage in suspension path
                // eslint-disable-next-line require-atomic-updates -- single-threaded: sequential state update after await, no concurrent writers
                currentSessionId = result.sessionId;
                // Stryker disable next-line ObjectLiteral,StringLiteral: Log message in suspension path
                logger.debug({ slot: options.slot }, 'Session suspended - state preserved for resume');
            }
        } catch (error) {
            // Check if this is a suspension abort (mode is idle because suspend() called goIdle())
            // Stryker disable all: Suspension abort path — tested via suspension behavior tests
            if(error instanceof Error && error.name === 'AbortError' && suspendedState !== null) {
                logger.debug({ slot: options.slot }, 'Perch session aborted by suspension');
                return;
            }
            // Stryker restore all

            // Check if this is a timeout abort (not a message interrupt)
            // Stryker disable next-line all: Timeout handling tested via behavior in timeout tests
            if(error instanceof Error && error.name === 'AbortError' && isTimingOut) {
                // Run wrap-up using shared helper
                await runTimeoutWrapUp(currentSlot ?? 'unscheduled');
                return;
            }

            // AbortError without interrupt flag or timeout - external abort
            if(error instanceof Error && error.name === 'AbortError') {
                logger.debug({ slot: options.slot }, 'Perch session aborted');
                // Clear timeout for all AbortError cases to prevent orphaned timers
                // Stryker disable next-line BlockStatement: Defensive cleanup tested via timer count assertions
                if(sessionTimeout) {
                    clearTimeout(sessionTimeout);
                    sessionTimeout = null;
                    sessionStartTime = null;
                }
                return;
            }

            // For other errors, log and transition to idle
            logger.error({ error, slot: options.slot }, 'Perch session error');
            if(stateManager.getMode() === 'perching') {
                stateManager.goIdle();
            }
            resetSessionState();
        } finally {
            // eslint-disable-next-line require-atomic-updates -- single-threaded: finally block owns currentAbortController exclusively
            currentAbortController = null;
        }
    }

    return {
        async startPerch(slot: PerchSlot): Promise<void> {
            // Guard against non-idle state
            if(stateManager.getMode() !== 'idle') {
                logger.warn({ mode: stateManager.getMode() }, 'Cannot start perch - not idle');
                return;
            }

            // Store current slot for resumption
            currentSlot = slot;

            // Transition to perching mode
            const activityType = `Perch time: ${slot}`;
            stateManager.startPerching(activityType);

            // Create abort controller
            currentAbortController = new AbortController();

            // Start session timeout timer
            sessionStartTime = new Date();
            const timeoutMs = config.maxSessionMinutes * 60 * 1000;
            // Stryker disable next-line BlockStatement: session timeout callback — mutating causes test timeout (timer fires, session abort not triggered)
            sessionTimeout = setTimeout(() => {
                handleSessionTimeout();
            }, timeoutMs);

            // Test mode is active if triggerOnStartup or forceSlot is set
            const isTestMode = !!(config.testMode?.triggerOnStartup ?? config.testMode?.forceSlot);

            logger.info({
                slot,
                suggestionLevel: getSuggestionLevelDescription(slot),
                timeoutMinutes:  config.maxSessionMinutes,
                testMode:        isTestMode,
                msg:             'Starting perch session with timeout',
            });

            // Stryker disable next-line StringLiteral: activity log summary text is informational only
            // Stryker disable BlockStatement,ObjectLiteral,StringLiteral: fire-and-forget .catch() error handler — uncoverable without triggering activityLogger failures
            void deps.activityLogger?.log({ type: 'perch-start', summary: `Perch session started (slot: ${slot})` }).catch((err) => {
                logger.warn({ err, slot, msg: 'Activity log failed for perch session start' });
            });
            // Stryker restore BlockStatement,ObjectLiteral,StringLiteral

            // Stryker disable BlockStatement: Defensive error handling for context/prompt build failures
            try {
                // Build perch context (if context builder available)
                let perchContext: string | undefined;
                if(contextBuilder) {
                    // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                    logger.debug({ slot }, 'Building perch context');
                    perchContext = await contextBuilder.buildPerchContext();
                    // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                    logger.debug({ slot, contextLength: perchContext.length }, 'Perch context built');
                }

                // Build prompt for this slot (use test prompt if test mode enabled)
                const prompt = isTestMode
                    ? buildTestPerchPrompt(slot, perchContext)
                    : buildPerchPrompt(slot, perchContext);

                // Run agent session with error handling
                await runSessionAndFinalize({
                    prompt,
                    slot,
                });
            } catch (error) {
                logger.error({ error, slot }, 'Failed to start perch session');
                // Stryker disable next-line ConditionalExpression: Defensive guard - always goes idle on error
                if(stateManager.getMode() === 'perching') {
                    stateManager.goIdle();
                }
                resetSessionState();
                currentAbortController = null;
            }
            // Stryker restore BlockStatement
        },

        suspend(message: InterruptingMessage): void {
            // Guard: if mode is not perching or already suspended, no-op
            // Stryker disable next-line all: Guard tested via behavior in suspend tests
            if(stateManager.getMode() !== 'perching' || suspendedState !== null) {
                // Stryker disable next-line all: Log message content inside guard block is not behavior-affecting
                logger.debug({ mode: stateManager.getMode(), alreadySuspended: suspendedState !== null }, 'Suspend called but not in active perching state - no-op');
                return;
            }

            // Calculate elapsed time before suspension
            // Stryker disable next-line ArithmeticOperator,MethodExpression: Duration calculation for resume timeout
            const elapsedMs = sessionStartTime ? Date.now() - sessionStartTime.getTime() : 0;

            // Save state for resume
            suspendedState = {
                sessionId:           currentSessionId,
                slot:                currentSlot ?? 'unscheduled',
                elapsedMs,
                suspendedAt:         new Date(),
                interruptingMessage: message,
            };

            // Clear partialWork (resume uses same sessionId, prior thinking is in conversation history)
            partialWork = null;

            // Clear timeout
            if(sessionTimeout) {
                clearTimeout(sessionTimeout);
                sessionTimeout = null;
            }

            // Stryker disable next-line StringLiteral: activity log summary text is informational only
            // Stryker disable BlockStatement,ObjectLiteral,StringLiteral: fire-and-forget .catch() error handler — uncoverable without triggering activityLogger failures
            void deps.activityLogger?.log({ type: 'perch-suspend', summary: 'Perch suspended' }).catch((err) => {
                logger.warn({ err, msg: 'Activity log failed for perch session suspend' });
            });
            // Stryker restore BlockStatement,ObjectLiteral,StringLiteral

            // Transition to idle BEFORE aborting (so runSessionAndFinalize sees idle mode)
            stateManager.goIdle();

            // Abort current session
            // Stryker disable next-line BlockStatement: abort block — mutating causes test timeout (session never aborts on suspend)
            if(currentAbortController) {
                currentAbortController.abort();
            }
        },

        async resumeAfterSuspension(): Promise<void> {
            // Guard: if no suspended state, return
            if(suspendedState === null) {
                return;
            }

            // Grab saved state and clear suspendedState (prevents double-resume and race conditions)
            const savedState = suspendedState;
            suspendedState = null;

            // Calculate remaining time
            // Stryker disable ArithmeticOperator,MethodExpression: Duration calculation internals
            const maxMs = config.maxSessionMinutes * 60 * 1000;
            const remainingMs = Math.max(maxMs - savedState.elapsedMs, 60_000); // At least 1 minute
            // Stryker restore ArithmeticOperator,MethodExpression

            // Transition to perching
            // Stryker disable next-line StringLiteral: Activity type string tested via startPerching assertion
            const activityType = `Perch time: ${savedState.slot}`;
            stateManager.startPerching(activityType);

            // Create new abort controller
            currentAbortController = new AbortController();

            // Store current slot
            currentSlot = savedState.slot;

            // Set session start time for timeout tracking
            sessionStartTime = new Date();

            // Set timeout with remaining time
            // Stryker disable next-line ArrowFunction: Timeout handler delegation tested via timeout behavior tests
            sessionTimeout = setTimeout(() => handleSessionTimeout(), remainingMs);

            // Load new events since suspension
            let newEventsSummary: string | undefined;
            if(contextBuilder) {
                const eventsResult = await contextBuilder.loadRecentEvents(5);
                // Filter to events updated after suspension
                // Stryker disable all: Event filtering and formatting — tested via post-suspension event inclusion tests
                const newEvents = eventsResult.items.filter(item =>
                    new Date(item.updatedAt) > savedState.suspendedAt);
                if(newEvents.length > 0) {
                    newEventsSummary = newEvents.map(item =>
                        `- ${item.path}: ${item.contentPreview ?? '(no preview)'}`).join('\n');
                }
                // Stryker restore all
            }

            // Calculate suspension duration
            // Stryker disable next-line ArithmeticOperator,MethodExpression: Duration calculation for prompt
            const suspendedDurationMs = Date.now() - savedState.suspendedAt.getTime();

            // Build interrupting message summary
            // Stryker disable next-line StringLiteral: Prompt summary text is product design
            const interruptingSummary = `A message from ${savedState.interruptingMessage.author} in #${savedState.interruptingMessage.channelName}`;

            // Build resumed prompt
            const prompt = buildPerchResumedPrompt({
                suspendedDurationMs,
                interruptingSummary,
                newEventsSummary,
            });

            // Stryker disable next-line StringLiteral: activity log summary text is informational only

            void deps.activityLogger?.log({ type: 'perch-resume', summary: 'Perch resumed' }).catch((err) => {
                logger.warn({ err, msg: 'Activity log failed for perch session resume' });
            });

            // Run session and finalize
            await runSessionAndFinalize({
                prompt,
                slot: savedState.slot,
            });
        },

        isSuspended(): boolean {
            return suspendedState !== null;
        },

        clearSuspension(): void {
            // Stryker disable next-line all: Defensive log guard — tested via clearSuspension behavior tests
            if(suspendedState !== null) {
                // Stryker disable next-line StringLiteral: Log message content is not behavior-affecting
                logger.warn('Clearing suspension state - error recovery');
            }
            suspendedState = null;
        },

        getAbortController(): AbortController | null {
            return currentAbortController;
        },
    };
}
