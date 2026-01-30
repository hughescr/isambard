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
import { buildPerchPrompt, buildPerchInterruptedPrompt, buildPerchTimeoutPrompt, getSuggestionLevelDescription } from './prompts';
import type { StreamProgress } from '@/agent/stream-tracker';
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
    const { stateManager, logger, config, runAgentSession } = deps;

    // Only operational handles - NO state flags. BotStateManager is the single source of truth.
    let currentAbortController: AbortController | null = null;
    let currentSessionId: string | undefined;
    let partialWork: StreamProgress | null = null;
    let currentSlot: PerchSlot | null = null;
    let sessionTimeout: ReturnType<typeof setTimeout> | null = null;
    let sessionStartTime: Date | null = null;
    let isTimingOut = false;

    // Timeout handler - aborts session when max duration reached
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

    // Internal resume logic - uses BotStateManager.isInterrupted() as the trigger
    async function doResume(): Promise<void> {
        // Guard: verify we're still in perching mode and interrupted
        // BotStateManager is the single source of truth for this state
        if(stateManager.getMode() !== 'perching' || !stateManager.isInterrupted()) {
            return;
        }

        // Resume (clear interrupted flag)
        stateManager.resume();

        // Create new abort controller
        currentAbortController = new AbortController();

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
                author:      'Unknown',
                channelName: 'unknown',
                content:     '',
            };

        const prompt = buildPerchInterruptedPrompt({
            partialWork: partialWork ?? { thinking: '', text: '', pendingToolUse: null, sessionId: undefined },
            newMessage,
        });

        // Run agent session with error handling
        await runSessionAndFinalize({
            prompt,
            slot: currentSlot ?? 'unscheduled',
        });
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

            // If completed, transition to idle
            if(result.completed && !stateManager.isInterrupted()) {
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
            }
        } catch (error) {
            // Check BotStateManager - it's the single source of truth for interrupt state
            // If interrupted by message, schedule resume on next tick to let current stack unwind
            if(stateManager.isInterrupted()) {
                setTimeout(() => void doResume(), 0);
                return;
            }

            // Check if this is a timeout abort (not a message interrupt)
            if(_.isError(error) && error.name === 'AbortError' && isTimingOut) {
                // Reset timeout flag
                isTimingOut = false;

                // Create new abort controller for wrap-up
                currentAbortController = new AbortController();

                // Calculate session duration
                const durationMs = sessionStartTime ? Date.now() - sessionStartTime.getTime() : 0;
                const durationMinutes = Math.round(durationMs / 60000);

                // Build timeout prompt
                const prompt = buildPerchTimeoutPrompt({
                    partialWork:       partialWork ?? { thinking: '', text: '', pendingToolUse: null, sessionId: undefined },
                    sessionDuration:   durationMinutes,
                    maxSessionMinutes: config.maxSessionMinutes,
                });

                logger.info({
                    slot:        currentSlot,
                    durationMin: durationMinutes,
                    maxDuration: config.maxSessionMinutes,
                    msg:         'Resuming with timeout wrap-up prompt',
                });

                // Resume session with wrap-up prompt
                await runSessionAndFinalize({
                    prompt,
                    slot: currentSlot ?? 'unscheduled',
                });

                return;
            }

            // AbortError without interrupt flag or timeout - external abort, just return
            if(_.isError(error) && error.name === 'AbortError') {
                logger.debug({ slot: options.slot }, 'Perch session aborted');
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
            // Guard against duplicate sessions
            if(stateManager.getMode() === 'perching') {
                logger.warn('Already in perching mode - ignoring startPerch');
                return;
            }

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

            logger.info({
                slot,
                suggestionLevel: getSuggestionLevelDescription(slot),
                timeoutMinutes:  config.maxSessionMinutes,
                msg:             'Starting perch session with timeout',
            });

            // Build prompt for this slot
            const prompt = buildPerchPrompt(slot);

            // Run agent session with error handling
            await runSessionAndFinalize({
                prompt,
                slot,
            });
        },

        interrupt(message: InterruptingMessage): void {
            // Store the interrupting message AND mark as interrupted in BotStateManager
            // BotStateManager is the SINGLE SOURCE OF TRUTH for all state
            // The error handler will check isInterrupted() and trigger resume
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
