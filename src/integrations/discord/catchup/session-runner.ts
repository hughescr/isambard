/**
 * Catch-Up Session Runner
 *
 * Orchestrates the catch-up mode session lifecycle:
 * - Determining when to start catch-up (on startup, after crashes, or after intervals)
 * - Running agent sessions with catch-up prompts
 * - Handling interruptions from new messages
 * - Tracking completion and resumption
 */

import { logger } from '@hughescr/logger';
// eslint-disable-next-line lodash/import-scope -- Allow full lodash import for chaining only
import _ from 'lodash';
import flatMap from 'lodash/flatMap';
import isError from 'lodash/isError';
import map from 'lodash/map';
import { DateTime } from 'luxon';
import type { InboxManager } from '../inbox';
import type { BotStateManager, CatchingUpModeContext, InterruptingMessageDetails } from '../state';
import type { ChannelId } from '../types';
import { buildCatchUpPrompt, buildCatchUpResumedPrompt } from './prompts';
import { formatTimeSince } from '@/utils';

/**
 * Hot reload signal stored in memory - indicates catch-up completed.
 */
export interface CatchUpCompletionSignal {
    /** ISO 8601 timestamp when catch-up completed */
    completedAt:       string
    /** Number of channels processed */
    channelsProcessed: number
    /** Number of messages processed */
    messagesProcessed: number
}

/**
 * Re-export InterruptingMessageDetails for API compatibility
 */
export type InterruptingMessage = InterruptingMessageDetails;

/**
 * In-progress signal stored in memory - indicates catch-up was interrupted by crash/hot reload.
 */
export interface CatchUpInProgressSignal {
    /** ISO 8601 timestamp when catch-up started */
    startedAt: string
}

/**
 * Rich context for status generation during catch-up.
 */
export interface StatusContext {
    /** Channel names being processed */
    channelNames: string[]
    /** Top message authors (up to 3) */
    topAuthors:   string[]
    /** Total unread message count */
    totalUnread:  number
}

/**
 * Options for running an agent session.
 */
export interface RunAgentSessionOptions {
    /** Catch-up prompt to use */
    prompt:         string
    /** Session ID to resume (optional) */
    sessionId?:     string
    /** Abort signal for cancellation */
    abortSignal:    AbortSignal
    /** Rich context for status generation during catch-up */
    statusContext?: StatusContext
}

/**
 * Result from running an agent session.
 */
export interface AgentSessionResult {
    /** Whether the session completed (vs interrupted) */
    completed:  boolean
    /** Session ID for resuming */
    sessionId?: string
}

/**
 * Dependencies for the session runner.
 */
export interface CatchUpSessionRunnerDeps {
    /** State manager for catch-up mode */
    stateManager:           BotStateManager
    /** Inbox manager for tracking unread messages */
    inboxManager:           InboxManager
    /** Function to store completion signal in memory */
    storeCompletionSignal:  (signal: CatchUpCompletionSignal) => Promise<void>
    /** Function to load completion signal from memory */
    loadCompletionSignal:   () => Promise<CatchUpCompletionSignal | null>
    /** Function to store in-progress signal in memory */
    storeInProgressSignal:  (signal: CatchUpInProgressSignal) => Promise<void>
    /** Function to load in-progress signal from memory */
    loadInProgressSignal:   () => Promise<CatchUpInProgressSignal | null>
    /** Function to delete in-progress signal from memory */
    deleteInProgressSignal: () => Promise<void>
    /** Function to run a catch-up agent session */
    runAgentSession:        (options: RunAgentSessionOptions) => Promise<AgentSessionResult>
    /** Optional callback invoked when catch-up completes */
    onCatchUpComplete?:     () => void
    /** Optional function to resolve channel ID to channel name */
    resolveChannelName?:    (channelId: ChannelId) => string | undefined
}

/**
 * Interface for managing catch-up sessions.
 */
export interface CatchUpSessionRunner {
    /**
     * Check if catch-up should be started on startup.
     * Returns true if:
     * - There are unread messages in the inbox (already loaded by bot.ts)
     * - AND (inProgress marker exists OR lastCompleted was > 10 seconds ago OR never completed)
     */
    shouldStartCatchUp(): Promise<boolean>

    /**
     * Start a catch-up session.
     * Sets state to 'catching_up', stores inProgress marker,
     * and runs the agent until completion or suspension.
     */
    startCatchUp(): Promise<void>

    /**
     * Suspend the current catch-up session due to a new message.
     * Transitions to idle mode and stores suspension state for later resume.
     */
    suspend(message: InterruptingMessage): void

    /**
     * Resume catch-up after handling a suspension.
     * Called after the suspending message has been responded to.
     */
    resumeAfterSuspension(): Promise<void>

    /**
     * Check if a catch-up session is currently suspended.
     */
    isSuspended(): boolean

    /**
     * Clear suspension state (for error recovery).
     */
    clearSuspension(): void

    /**
     * Complete the catch-up session.
     * Marks all remaining messages as read, stores completion signal,
     * deletes inProgress marker, and transitions to idle.
     */
    completeCatchUp(channelsProcessed: number, messagesProcessed: number): Promise<void>

    /**
     * Get the current abort controller (for external interruption).
     */
    getAbortController(): AbortController | null
}

/**
 * Creates a catch-up session runner.
 *
 * The runner orchestrates the entire catch-up flow including:
 * - Checking hot reload signals to skip/resume catch-up
 * - Running catch-up sessions with the agent
 * - Handling interruptions from new messages
 * - Storing completion timestamps
 *
 * @param deps - Dependencies for the session runner
 * @returns CatchUpSessionRunner instance
 *
 * @example
 * ```typescript
 * const runner = createCatchUpSessionRunner({
 *     stateManager,
 *     inboxManager,
 *     storeCompletionSignal: async (signal) => { ... },
 *     loadCompletionSignal: async () => { ... },
 *     storeInProgressSignal: async (signal) => { ... },
 *     loadInProgressSignal: async () => { ... },
 *     deleteInProgressSignal: async () => { ... },
 *     runAgentSession: async (options) => { ... },
 * });
 *
 * // Check if catch-up should start
 * if (await runner.shouldStartCatchUp()) {
 *     await runner.startCatchUp();
 * }
 *
 * // Suspend to handle new message
 * runner.suspend(message);
 *
 * // Resume after handling the message
 * await runner.resumeAfterSuspension();
 * ```
 */
export function createCatchUpSessionRunner(deps: CatchUpSessionRunnerDeps): CatchUpSessionRunner {
    // Only operational handles - NO state flags. BotStateManager is the single source of truth.
    let currentAbortController: AbortController | null = null;
    let currentSessionId: string | undefined;
    let suspendedState: {
        sessionId:           string | undefined
        interruptingMessage: InterruptingMessage
        viewedChannels:      Set<ChannelId>
    } | null = null;

    // Local closure function for completing catch-up
    const completeCatchUp = async (channelsProcessed: number, messagesProcessed: number): Promise<void> => {
        // Delete inProgress marker
        await deps.deleteInProgressSignal();

        // Store completion signal
        await deps.storeCompletionSignal({
            completedAt: DateTime.now().toISO(),
            channelsProcessed,
            messagesProcessed,
        });

        // Clear session state to prevent memory leak
        currentSessionId = undefined;
        currentAbortController = null;

        // Transition to idle (this also clears viewed channels in the context)
        deps.stateManager.goIdle();

        // Invoke callback if provided
        deps.onCatchUpComplete?.();
    };

    // Helper for running sessions with error handling
    async function runSessionAndFinalize(options: {
        prompt:            string
        channelsProcessed: number
        messagesProcessed: number
        statusContext?:    StatusContext
    }): Promise<void> {
        try {
            const result = await deps.runAgentSession({
                prompt:        options.prompt,
                sessionId:     currentSessionId,
                abortSignal:   currentAbortController!.signal,
                statusContext: options.statusContext,
            });

            // Store session ID for resumption
            // eslint-disable-next-line require-atomic-updates -- single-threaded: sequential assignment after await, no concurrent writers
            currentSessionId = result.sessionId;

            // Clear abort controller
            // eslint-disable-next-line require-atomic-updates -- single-threaded: sequential state cleanup after await, no concurrent writers
            currentAbortController = null;

            if(result.completed) {
                await completeCatchUp(options.channelsProcessed, options.messagesProcessed);
                return;
            }

            // Check for suspension — sessionId already saved at line 247, this is defensive logging
            // Stryker disable all: Suspension detection guard — sessionId preserved above, only adds logging
            if(suspendedState !== null) {
                logger.debug({ msg: 'Catch-up session suspended - state preserved for resume' });
            }
            // Stryker restore all
        } catch (error) {
            // eslint-disable-next-line require-atomic-updates -- single-threaded: catch block cleanup, no concurrent writers
            currentAbortController = null;

            // Check if this is a suspension abort (mode is idle because suspend() called goIdle())
            if(isError(error) && error.name === 'AbortError' && suspendedState !== null) {
                logger.debug({ msg: 'Catch-up session aborted by suspension' });
                return;
            }

            // AbortError without suspend flag - external abort, just return
            if(isError(error) && error.name === 'AbortError') {
                return;
            }

            // For other errors, transition to idle
            // Note: We still call completeCatchUp to clean up state, but this prevents
            // retry for 10 seconds. For truly transient errors, a restart will still work
            // since we delete the inProgress marker here.
            await completeCatchUp(0, 0);
        }
    }

    return {
        async shouldStartCatchUp(): Promise<boolean> {
            // 1. Check if there are unread messages (inbox is already loaded by bot.ts)
            const unreadCount = deps.inboxManager.totalUnread;
            // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
            logger.debug({
                unreadCount,
                msg: 'Checking if catch-up should start - unread count',
            });
            // Stryker restore ObjectLiteral,StringLiteral

            if(unreadCount === 0) {
                // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
                logger.debug({ msg: 'No unread messages - skipping catch-up' });
                // Stryker restore ObjectLiteral,StringLiteral
                return false;
            }

            // 2. Check inProgress marker (crash/hot reload during catch-up)
            const inProgress = await deps.loadInProgressSignal();
            // Stryker disable ObjectLiteral,StringLiteral,BooleanLiteral: Logging for observability
            logger.debug({
                inProgress: !!inProgress,
                startedAt:  inProgress?.startedAt,
                msg:        'Checking inProgress signal',
            });
            // Stryker restore ObjectLiteral,StringLiteral,BooleanLiteral

            if(inProgress) {
                // Delete the old marker - we'll create a new one when starting
                await deps.deleteInProgressSignal();
                // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
                logger.info({ msg: 'Resuming interrupted catch-up session' });
                // Stryker restore ObjectLiteral,StringLiteral
                return true;
            }

            // 3. Check lastCompleted timestamp
            const completion = await deps.loadCompletionSignal();
            // Stryker disable ObjectLiteral,StringLiteral,BooleanLiteral: Logging for observability
            logger.debug({
                hasCompletion:     !!completion,
                completedAt:       completion?.completedAt,
                channelsProcessed: completion?.channelsProcessed,
                messagesProcessed: completion?.messagesProcessed,
                msg:               'Checking completion signal',
            });
            // Stryker restore ObjectLiteral,StringLiteral,BooleanLiteral

            if(!completion) {
                // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
                logger.info({ msg: 'No previous completion - starting catch-up' });
                // Stryker restore ObjectLiteral,StringLiteral
                return true;  // Never completed before
            }

            // Skip if completed < 10 seconds ago
            const tenSecondsAgo = Date.now() - (10 * 1000);
            const completedAt = new Date(completion.completedAt).getTime();
            // Stryker disable ArithmeticOperator: Logging calculation only
            const secondsSinceCompletion = (Date.now() - completedAt) / 1000;
            // Stryker restore ArithmeticOperator
            // Stryker disable next-line EqualityOperator: Boundary condition < vs <= at exact 10 seconds makes no practical difference
            const shouldStart = completedAt < tenSecondsAgo;

            // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
            logger.debug({
                completedAt:            completion.completedAt,
                secondsSinceCompletion: secondsSinceCompletion.toFixed(1),
                shouldStart,
                msg:                    `Completion check: ${shouldStart ? 'starting' : 'skipping'} catch-up (${secondsSinceCompletion.toFixed(1)} seconds since last completion)`,
            });
            // Stryker restore ObjectLiteral,StringLiteral

            // Stryker disable next-line EqualityOperator,ArithmeticOperator: Boundary condition < vs <= at exact 10 seconds makes no practical difference
            return shouldStart;
        },

        async startCatchUp(): Promise<void> {
            // Guard against duplicate sessions - test verifies no side effects occur when state is catching_up
            if(deps.stateManager.getMode() === 'catching_up') {
                return;
            }

            // Store inProgress marker
            await deps.storeInProgressSignal({
                startedAt: DateTime.now().toISO(),
            });

            // Create abort controller
            currentAbortController = new AbortController();

            // Get current unread overview
            const overview = deps.inboxManager.getUnreadOverview();

            // Build status context for dynamic status generation
            // Stryker disable ArrowFunction,ArrayDeclaration,StringLiteral: Status context building - values affect status generation but not core behavior
            const allMessages = flatMap(
                overview.channels,
                ch => deps.inboxManager.getChannelMessages(ch.channelId)
            );
            const topAuthors = _(allMessages).map('author').countBy().toPairs().orderBy([1], ['desc']).take(3).map(([author]) => author).value();
            const statusContext: StatusContext = {
                channelNames: map(overview.channels, 'channelName'),
                topAuthors,
                totalUnread:  overview.totalUnread,
            };

            // Load completion signal to calculate time since last active
            const completionSignal = await deps.loadCompletionSignal();
            const timeSinceLastActive = completionSignal
                ? formatTimeSince(new Date(completionSignal.completedAt))
                : null;

            // Create catch-up context
            const catchUpContext: CatchingUpModeContext = {
                viewedChannels: new Set(),
                sessionId:      null,
                startedAt:      new Date(),
                unreadCount:    overview.totalUnread,
                channelNames:   map(overview.channels, 'channelName'),
                topAuthors,
                timeSinceLastActive,
            };
            // Stryker restore ArrowFunction,ArrayDeclaration,StringLiteral

            // Transition to catching_up mode
            deps.stateManager.startCatchUp(catchUpContext);

            // Build catch-up prompt
            const prompt = buildCatchUpPrompt(overview.totalUnread, overview.channels.length);

            // Run agent session with error handling
            await runSessionAndFinalize({
                prompt,
                channelsProcessed: overview.channels.length,
                messagesProcessed: overview.totalUnread,
                statusContext,
            });
        },

        suspend(message: InterruptingMessage): void {
            // Guard: if not catching_up or already suspended, handle appropriately
            const currentMode = deps.stateManager.getMode();
            if(currentMode !== 'catching_up' || suspendedState !== null) {
                // If resume is in progress (suspendedState is being consumed), update message and abort
                if(suspendedState !== null && currentAbortController) {
                    suspendedState = {
                        ...suspendedState,
                        interruptingMessage: message,
                    };
                    currentAbortController.abort();
                }
                // Else: not in catching_up mode or already suspended — no-op
                return;
            }

            // Read viewedChannels from BotStateManager context BEFORE goIdle
            const state = deps.stateManager.getState();
            const catchUpContext = state.modeContext as CatchingUpModeContext;
            const viewedChannels = new Set(catchUpContext.viewedChannels);

            // Save state to suspendedState
            suspendedState = {
                sessionId:           currentSessionId,
                interruptingMessage: message,
                viewedChannels,
            };

            // Transition to idle
            deps.stateManager.goIdle();

            // Abort current session
            if(currentAbortController) {
                currentAbortController.abort();
            }
        },

        async resumeAfterSuspension(): Promise<void> {
            // Guard: if no suspended state, return
            if(suspendedState === null) {
                return;
            }

            // Grab saved state and clear suspendedState
            const savedState = suspendedState;
            suspendedState = null;

            // Check inbox: if totalUnread === 0, complete catch-up and return
            const overview = deps.inboxManager.getUnreadOverview();
            if(overview.totalUnread === 0) {
                await completeCatchUp(0, 0);
                return;
            }

            // Build new CatchingUpModeContext with restored viewedChannels and fresh inbox data
            // Stryker disable ArrowFunction,StringLiteral,ArrayDeclaration: Status context values affect status generation but not core behavior
            const allMessages = flatMap(
                overview.channels,
                ch => deps.inboxManager.getChannelMessages(ch.channelId)
            );
            const topAuthors = _(allMessages).map('author').countBy().toPairs().orderBy([1], ['desc']).take(3).map(([author]) => author).value();

            // Load completion signal to calculate time since last active
            const completionSignal = await deps.loadCompletionSignal();
            const timeSinceLastActive = completionSignal
                ? formatTimeSince(new Date(completionSignal.completedAt))
                : null;

            const catchUpContext: CatchingUpModeContext = {
                viewedChannels: savedState.viewedChannels,
                sessionId:      savedState.sessionId ?? null,
                startedAt:      new Date(),
                unreadCount:    overview.totalUnread,
                channelNames:   map(overview.channels, 'channelName'),
                topAuthors,
                timeSinceLastActive,
            };
            // Stryker restore ArrowFunction,StringLiteral,ArrayDeclaration

            // Start catch-up mode with restored context
            deps.stateManager.startCatchUp(catchUpContext);

            // Create new abort controller
            currentAbortController = new AbortController();

            // Restore session ID
            currentSessionId = savedState.sessionId;

            // Build status context for dynamic status generation
            // Stryker disable StringLiteral: Property accessor string for lodash map — cosmetic status context
            const statusContext: StatusContext = {
                channelNames: map(overview.channels, 'channelName'),
                topAuthors,
                totalUnread:  overview.totalUnread,
            };
            // Stryker restore StringLiteral

            // Build resumed prompt
            const viewedChannelIds = [...savedState.viewedChannels];
            const viewedChannels = map(viewedChannelIds, channelId =>
                deps.resolveChannelName?.(channelId) ?? channelId
            );

            // Stryker disable StringLiteral: Fallback display strings not behavior-critical
            const newMessage = {
                author:      savedState.interruptingMessage.author,
                channelName: savedState.interruptingMessage.channelName,
                content:     savedState.interruptingMessage.content,
            };
            // Stryker restore StringLiteral

            const prompt = buildCatchUpResumedPrompt({
                viewedChannels,
                remainingUnread:   overview.totalUnread,
                remainingChannels: overview.channels.length,
                newMessage,
            });

            // Run session
            await runSessionAndFinalize({
                prompt,
                channelsProcessed: overview.channels.length,
                messagesProcessed: overview.totalUnread,
                statusContext,
            });
        },

        isSuspended(): boolean {
            return suspendedState !== null;
        },

        clearSuspension(): void {
            suspendedState = null;
        },

        completeCatchUp,

        getAbortController(): AbortController | null {
            return currentAbortController;
        },
    };
}
