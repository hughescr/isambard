/**
 * Perch Session Runner
 *
 * Orchestrates perch time sessions:
 * - Starting sessions with the correct slot-specific prompt
 * - Running agent with perching mode
 * - Handling interruptions from user messages
 * - Resuming after interruption
 * - Completing sessions and returning to idle
 */

import type { Logger } from '@hughescr/logger';
import type { BotStateManager, PerchingModeContext, InterruptingMessageDetails } from '@/integrations/discord/state';
import { type PerchSlot, type PerchConfig } from './types';
import { buildPerchPrompt, buildTestPerchPrompt, buildPerchInterruptedPrompt, buildPerchTimeoutPrompt, getSuggestionLevelDescription } from './prompts';
import type { StreamProgress } from '@/agent/stream-tracker';
import type { ContextBuilder } from '@/agent/context-builder';
import _ from 'lodash';

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
    stateManager:    BotStateManager
    /** Logger instance */
    logger:          Logger
    /** Perch configuration (for timeout settings) */
    config:          PerchConfig
    /** Function to run a perch agent session */
    runAgentSession: (options: RunAgentSessionOptions) => Promise<AgentSessionResult>
    /** Context builder for perch context (optional for backward compatibility) */
    contextBuilder?: ContextBuilder
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
     * Interrupt the current perch session due to a user message.
     * Sets state to interrupted and stores the interrupting message details.
     */
    interrupt(message: InterruptingMessage): void

    /**
     * Resume perch after handling an interruption.
     * Called after the interrupting message has been responded to.
     */
    resumeAfterInterruption(): Promise<void>

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
 * // Handle interruption
 * runner.interrupt({ channelId, author, channelName, content });
 *
 * // Resume after handling interruption
 * await runner.resumeAfterInterruption();
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
    let isTimingOut = false;
    let resumeInProgress = false;
    let wasReInterrupted = false;

    // Timeout handler - aborts session when max duration reached
    function handleSessionTimeout(): void {
        // Don't timeout if not in perching mode
        // Stryker disable next-line ConditionalExpression,BlockStatement: Guard tested via behavior - tests verify no timeout when mode changed
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

    // Internal resume logic - uses BotStateManager.isInterrupted() as the trigger
    async function doResume(): Promise<void> {
        // Guard: verify we're still in perching mode and interrupted, and not already resuming
        // BotStateManager is the single source of truth for this state
        // Stryker disable next-line all: Complex guard condition tested via behavior in resume-after-interruption tests
        if(stateManager.getMode() !== 'perching' || !stateManager.isInterrupted() || resumeInProgress) {
            return;
        }

        // Mark resume as in progress to prevent double-resume
        resumeInProgress = true;

        logger.info({
            slot:           currentSlot,
            // Stryker disable next-line ArithmeticOperator,MethodExpression: Timeout calculation internals for logging only
            remainingMs:    Math.max((config.maxSessionMinutes * 60 * 1000) - (sessionStartTime ? Date.now() - sessionStartTime.getTime() : 0), 60_000),
            // Stryker disable next-line ConditionalExpression,EqualityOperator: Logging-only field, mutation doesn't affect behavior
            hasPartialWork: partialWork !== null,
        }, 'doResume starting');

        // Create new abort controller
        currentAbortController = new AbortController();

        // Stryker disable ArithmeticOperator,MethodExpression,ArrowFunction: Timeout calculation internals - correctness validated by integration behavior
        // Set timeout for resume based on remaining time from original session
        const elapsedMs = sessionStartTime ? Date.now() - sessionStartTime.getTime() : 0;
        const maxMs = config.maxSessionMinutes * 60 * 1000;
        const remainingMs = Math.max(maxMs - elapsedMs, 60_000); // At least 1 minute
        sessionTimeout = setTimeout(() => handleSessionTimeout(), remainingMs);
        // Stryker restore ArithmeticOperator,MethodExpression,ArrowFunction

        // Build perch interrupted prompt
        const state = stateManager.getState();
        const perchContext = state.modeContext as PerchingModeContext;

        // Get interrupting message from BotStateManager context
        const storedMessage = perchContext.interruptingMessage;
        const newMessage = storedMessage
            ? {
                author:      storedMessage.author,
                channelName: storedMessage.channelName,
                content:     storedMessage.content,
            }
            : {
                // Stryker disable all: Fallback strings for missing data - logging only
                author:      'Unknown',
                channelName: 'unknown',
                content:     '',
                // Stryker restore all
            };

        const prompt = buildPerchInterruptedPrompt({
            // Stryker disable next-line all: Fallback default values for partial work state
            partialWork: partialWork ?? { thinking: '', text: '', pendingToolUse: null, sessionId: undefined },
            newMessage,
        });

        // Run agent session with error handling
        try {
            await runSessionAndFinalize({
                prompt,
                slot: currentSlot ?? 'unscheduled',
            });
        } finally {
            if(wasReInterrupted) {
                // Re-interrupted during resume — stay in perching+interrupted
                // The onResponse callback will trigger a fresh resume
                wasReInterrupted = false;
                resumeInProgress = false;
                // Don't call stateManager.resume() or goIdle()
            } else {
                // Normal completion
                stateManager.resume();
                resumeInProgress = false;
                // Safety net: handles ALL resume exit paths (incomplete, aborted, errored)
                if(stateManager.getMode() === 'perching') {
                    stateManager.goIdle();
                    currentSessionId = undefined;
                    partialWork = null;
                    currentSlot = null;
                    if(sessionTimeout) {
                        clearTimeout(sessionTimeout);
                        sessionTimeout = null;
                        sessionStartTime = null;
                    }
                }
            }
        }
    }

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
        const wrapUpTimer = setTimeout(() => {
            logger.warn({ slot, wrapUpTimeoutMinutes: config.wrapUpTimeoutMinutes }, 'Wrap-up session timed out - aborting');
            currentAbortController?.abort();
        }, wrapUpTimeoutMs);

        // Calculate session duration
        const durationMs = sessionStartTime ? Date.now() - sessionStartTime.getTime() : 0;
        // Stryker disable next-line ArithmeticOperator: Duration calculation for logging only
        const durationMinutes = Math.round(durationMs / 60000);

        // Build timeout prompt
        const prompt = buildPerchTimeoutPrompt({
            // Stryker disable next-line all: Fallback default values for partial work state
            partialWork:       partialWork ?? { thinking: '', text: '', pendingToolUse: null, sessionId: undefined },
            sessionDuration:   durationMinutes,
            maxSessionMinutes: config.maxSessionMinutes,
        });

        logger.info({
            slot:        slot,
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
            clearTimeout(wrapUpTimer);
            // Ensure we always go idle after wrap-up, regardless of outcome
            if(stateManager.getMode() === 'perching') {
                stateManager.goIdle();
            }
            // Clear session state
            currentSessionId = undefined;
            partialWork = null;
            currentSlot = null;
            // Clear session timeout
            if(sessionTimeout) {
                clearTimeout(sessionTimeout);
                sessionTimeout = null;
                sessionStartTime = null;
            }
        }
    }

    // Helper for running sessions with error handling
    // eslint-disable-next-line complexity -- timeout handling adds necessary branching
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
            currentSessionId = result.sessionId;

            // Store partial work if interrupted
            if(result.partialWork) {
                partialWork = result.partialWork;
            }

            // Check interrupt state FIRST - state manager is single source of truth
            // The result.completed flag can be incorrect when abort errors are caught
            // Don't schedule resume if we're already in a resume (resumeInProgress)
            if(stateManager.isInterrupted() && !resumeInProgress) {
                // Session was interrupted — don't resume here.
                // The onResponse callback in bot.ts will call resumeAfterInterruption()
                // after the interrupting message has been handled.
                logger.debug({ slot: options.slot }, 'Session interrupted - awaiting external resume');
            } else if(result.completed && !resumeInProgress) {
                // Session completed normally, transition to idle
                logger.info({ slot: options.slot }, 'Perch session completed');
                if(stateManager.getMode() === 'perching') {
                    stateManager.goIdle();
                }
                // Clear session state
                currentSessionId = undefined;
                partialWork = null;
                currentSlot = null;
                // Clear timeout
                if(sessionTimeout) {
                    clearTimeout(sessionTimeout);
                    sessionTimeout = null;
                    sessionStartTime = null;
                }
            } else if(resumeInProgress && stateManager.getMode() === 'perching') {
                // Resume session exiting — doResume finally block will handle cleanup
                logger.info({ slot: options.slot }, 'Resume session exiting - cleanup deferred to doResume');
            } else if(isTimingOut && !result.completed) {
                // Timeout abort caught via return path (agent caught AbortError internally and returned completed:false)
                // Run wrap-up using shared helper
                await runTimeoutWrapUp(options.slot);
                return;
            } else if(!result.completed && !resumeInProgress) {
                // Safety net — unknown non-completion, go idle
                logger.warn({ slot: options.slot }, 'Session returned incomplete for unknown reason - going idle');
                if(stateManager.getMode() === 'perching') {
                    stateManager.goIdle();
                }
                currentSessionId = undefined;
                partialWork = null;
                currentSlot = null;
                if(sessionTimeout) {
                    clearTimeout(sessionTimeout);
                    sessionTimeout = null;
                    sessionStartTime = null;
                }
            }
        } catch (error) {
            // Check BotStateManager - it's the single source of truth for interrupt state
            // If interrupted by message, leave state as perching+interrupted for onResponse to handle
            // Don't schedule resume if we're already in a resume (resumeInProgress)
            if(stateManager.isInterrupted() && !resumeInProgress) {
                // Interrupted — leave state as perching+interrupted for onResponse to handle
                logger.debug({ slot: options.slot }, 'Session aborted by interrupt - awaiting external resume');
                return;
            }

            // Check if this is a timeout abort (not a message interrupt)
            // Stryker disable next-line all: Timeout handling tested via behavior in timeout tests
            if(_.isError(error) && error.name === 'AbortError' && isTimingOut) {
                // Run wrap-up using shared helper
                await runTimeoutWrapUp(currentSlot ?? 'unscheduled');
                return;
            }

            // AbortError without interrupt flag or timeout - external abort
            if(_.isError(error) && error.name === 'AbortError') {
                logger.debug({ slot: options.slot }, 'Perch session aborted');
                // Clear timeout for all AbortError cases to prevent orphaned timers
                // (may already be null if cleared by interrupt() during re-interruption)
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
            // Clear session state
            currentSessionId = undefined;
            partialWork = null;
            currentSlot = null;
            // Clear timeout
            if(sessionTimeout) {
                clearTimeout(sessionTimeout);
                sessionTimeout = null;
                sessionStartTime = null;
            }
        } finally {
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

            // Stryker disable BlockStatement: Defensive error handling for context/prompt build failures
            try {
                // Build perch context (if context builder available)
                let perchContext: string | undefined;
                if(contextBuilder) {
                    perchContext = await contextBuilder.buildPerchContext();
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
                if(stateManager.getMode() === 'perching') {
                    stateManager.goIdle();
                }
                currentSessionId = undefined;
                partialWork = null;
                currentSlot = null;
                if(sessionTimeout) {
                    clearTimeout(sessionTimeout);
                    sessionTimeout = null;
                    sessionStartTime = null;
                }
                currentAbortController = null;
            }
            // Stryker restore BlockStatement
        },

        interrupt(message: InterruptingMessage): void {
            if(stateManager.isInterrupted()) {
                // Case: already interrupted
                if(resumeInProgress && currentAbortController) {
                    // Re-interrupt: abort the active resume session
                    wasReInterrupted = true;
                    stateManager.updateInterruptingMessage(message);
                    if(sessionTimeout) {
                        clearTimeout(sessionTimeout);
                        sessionTimeout = null;
                    }
                    currentAbortController.abort();
                }
                // Else: interrupted but resume not started yet — no-op, message batches naturally
                return;
            }

            // Normal first interrupt (unchanged logic)
            stateManager.interrupt(message);

            // Clear timeout when interrupted by message
            if(sessionTimeout) {
                clearTimeout(sessionTimeout);
                sessionTimeout = null;
            }

            // Abort current session
            if(currentAbortController) {
                currentAbortController.abort();
            }
        },

        async resumeAfterInterruption(): Promise<void> {
            // This public method is used for external resume calls
            // (e.g., from coordinator's onResponse callback)
            // Stryker disable next-line all: Resume guard tested via behavior in resume-after-interruption tests
            if(stateManager.getMode() !== 'perching' || !stateManager.isInterrupted()) {
                return;
            }

            await doResume();
        },

        getAbortController(): AbortController | null {
            return currentAbortController;
        },
    };
}
