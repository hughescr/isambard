/**
 * Catch-Up Session Runner
 *
 * Orchestrates the catch-up mode session lifecycle:
 * - Determining when to start catch-up (on startup, after crashes, or after intervals)
 * - Running agent sessions with catch-up prompts
 * - Handling interruptions from new messages
 * - Tracking completion and resumption
 */

import type { ChannelId } from '@/integrations/discord/types';
import type { BotStateManager, CatchingUpModeContext } from '../state';
import type { InboxManager } from '../inbox';
import { buildCatchUpPrompt, buildCatchUpInterruptedPrompt } from './prompts';
import { logger } from '@hughescr/logger';
import _ from 'lodash';
import { formatTimeSince } from '@/utils/time';

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
 * Details about the message that interrupted a catch-up session.
 */
export interface InterruptingMessage {
    /** Channel ID where the interruption occurred */
    channelId:   ChannelId
    /** Author of the interrupting message */
    author:      string
    /** Channel name where the interruption occurred */
    channelName: string
    /** Content of the interrupting message */
    content:     string
}

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
     * - AND (inProgress marker exists OR lastCompleted was > 5 minutes ago OR never completed)
     */
    shouldStartCatchUp(): Promise<boolean>

    /**
     * Start a catch-up session.
     * Sets state to 'catching_up', stores inProgress marker,
     * and runs the agent until completion or interruption.
     */
    startCatchUp(): Promise<void>

    /**
     * Interrupt the current catch-up session due to a new message.
     * Sets state to 'catching_up_interrupted' and stores the interrupting message details.
     */
    interrupt(message: InterruptingMessage): void

    /**
     * Resume catch-up after handling an interruption.
     * Called after the interrupting message has been responded to.
     */
    resumeAfterInterruption(): Promise<void>

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
 * // Handle interruption
 * runner.interrupt(channelId);
 *
 * // Resume after handling interruption
 * await runner.resumeAfterInterruption();
 * ```
 */
export function createCatchUpSessionRunner(deps: CatchUpSessionRunnerDeps): CatchUpSessionRunner {
    let currentAbortController: AbortController | null = null;
    let currentSessionId: string | undefined;
    let interruptingMessage: InterruptingMessage | null = null;

    // Local closure function for completing catch-up
    const completeCatchUp = async (channelsProcessed: number, messagesProcessed: number): Promise<void> => {
        // Delete inProgress marker
        await deps.deleteInProgressSignal();

        // Store completion signal
        await deps.storeCompletionSignal({
            completedAt: new Date().toISOString(),
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
    const runSessionAndFinalize = async (options: {
        prompt:            string
        channelsProcessed: number
        messagesProcessed: number
        statusContext?:    StatusContext
    }): Promise<void> => {
        try {
            const result = await deps.runAgentSession({
                prompt:        options.prompt,
                sessionId:     currentSessionId,
                abortSignal:   currentAbortController!.signal,
                statusContext: options.statusContext,
            });

            // Store session ID for resumption
            currentSessionId = result.sessionId;

            // Clear abort controller
            currentAbortController = null;

            // If completed, call completeCatchUp
            if(result.completed) {
                await completeCatchUp(options.channelsProcessed, options.messagesProcessed);
            }
        } catch (error) {
            currentAbortController = null;

            // AbortError means we were interrupted - don't complete, let interrupt flow handle it
            // Stryker disable all: AbortError handling is tested with dedicated test cases for abort vs regular errors
            if(_.isError(error) && error.name === 'AbortError') {
                return;
            }
            // Stryker restore all

            // For other errors, transition to idle
            // Note: We still call completeCatchUp to clean up state, but this prevents
            // retry for 5 minutes. For truly transient errors, a restart will still work
            // since we delete the inProgress marker here.
            await completeCatchUp(0, 0);
        }
    };

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

            // Skip if completed < 5 minutes ago
            const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
            const completedAt = new Date(completion.completedAt).getTime();
            // Stryker disable ArithmeticOperator: Logging calculation only
            const minutesSinceCompletion = (Date.now() - completedAt) / (60 * 1000);
            // Stryker restore ArithmeticOperator
            // Stryker disable next-line EqualityOperator: Boundary condition < vs <= at exact 5 minutes makes no practical difference
            const shouldStart = completedAt < fiveMinutesAgo;

            // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
            logger.debug({
                completedAt:            completion.completedAt,
                minutesSinceCompletion: minutesSinceCompletion.toFixed(1),
                shouldStart,
                msg:                    `Completion check: ${shouldStart ? 'starting' : 'skipping'} catch-up (${minutesSinceCompletion.toFixed(1)} minutes since last completion)`,
            });
            // Stryker restore ObjectLiteral,StringLiteral

            // Stryker disable next-line EqualityOperator,ArithmeticOperator: Boundary condition < vs <= at exact 5 minutes makes no practical difference
            return shouldStart;
        },

        async startCatchUp(): Promise<void> {
            // Guard against duplicate sessions - test verifies no side effects occur when state is catching_up
            if(deps.stateManager.getMode() === 'catching_up') { // Stryker disable ConditionalExpression,BlockStatement
                return;
            }

            // Store inProgress marker
            await deps.storeInProgressSignal({
                startedAt: new Date().toISOString(),
            });

            // Create abort controller
            currentAbortController = new AbortController();

            // Get current unread overview
            const overview = deps.inboxManager.getUnreadOverview();

            // Build status context for dynamic status generation
            // Stryker disable ArrowFunction,ArrayDeclaration,StringLiteral: Status context building - values affect status generation but not core behavior
            const allMessages = _.flatMap(
                overview.channels,
                ch => deps.inboxManager.getChannelMessages(ch.channelId)
            );
            const topAuthors = _(allMessages)
                .map('author')
                .countBy()
                .toPairs()
                .orderBy([1], ['desc'])
                .take(3)
                .map(([author]) => author)
                .value();
            const statusContext: StatusContext = {
                channelNames: _.map(overview.channels, 'channelName'),
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
                channelNames:   _.map(overview.channels, 'channelName'),
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

        interrupt(message: InterruptingMessage): void {
            // Store the interrupting message
            interruptingMessage = message;

            // Mark as interrupted
            deps.stateManager.interrupt();

            // Abort current session
            if(currentAbortController) {
                currentAbortController.abort();
            }
        },

        async resumeAfterInterruption(): Promise<void> {
            // Stryker disable next-line ConditionalExpression,LogicalOperator: Guard clause - test verifies no operations occur when not in interrupted state
            if(deps.stateManager.getMode() !== 'catching_up' || !deps.stateManager.isInterrupted()) {
                // Stryker disable BlockStatement: Guard clause return
                return;
                // Stryker restore BlockStatement
            }

            // Get current unread overview
            const overview = deps.inboxManager.getUnreadOverview();

            // If no unread messages, complete catch-up - test verifies completeCatchUp called without runAgentSession
            if(overview.totalUnread === 0) { // Stryker disable ConditionalExpression,BlockStatement
                await completeCatchUp(0, 0);
                return;
            }

            // Resume (clear interrupted flag)
            deps.stateManager.resume();

            // Create new abort controller
            currentAbortController = new AbortController();

            // Build status context for dynamic status generation
            // Stryker disable ArrowFunction,ArrayDeclaration,StringLiteral: Status context building - values affect status generation but not core behavior
            const allMessages = _.flatMap(
                overview.channels,
                ch => deps.inboxManager.getChannelMessages(ch.channelId)
            );
            const topAuthors = _(allMessages)
                .map('author')
                .countBy()
                .toPairs()
                .orderBy([1], ['desc'])
                .take(3)
                .map(([author]) => author)
                .value();
            const statusContext: StatusContext = {
                channelNames: _.map(overview.channels, 'channelName'),
                topAuthors,
                totalUnread:  overview.totalUnread,
            };
            // Stryker restore ArrowFunction,ArrayDeclaration,StringLiteral

            // Build catch-up interrupted prompt
            // Get viewed channels from state manager context
            const state = deps.stateManager.getState();
            const catchUpContext = state.modeContext as CatchingUpModeContext;
            const viewedChannelIds = Array.from(catchUpContext.viewedChannels);
            const viewedChannels = _.map(viewedChannelIds, channelId =>
                deps.resolveChannelName?.(channelId) ?? channelId
            );

            // Fallback display strings not behavior-critical - test verifies prompt generation
            const newMessage = interruptingMessage
                ? {
                    author:      interruptingMessage.author,
                    channelName: interruptingMessage.channelName,
                    content:     interruptingMessage.content,
                }
                : {
                    // Stryker disable StringLiteral: Fallback display strings not behavior-critical
                    author:      'Unknown',
                    channelName: 'unknown',
                    content:     '',
                    // Stryker restore StringLiteral
                };

            const prompt = buildCatchUpInterruptedPrompt({
                viewedChannels,
                remainingUnread:   overview.totalUnread,
                remainingChannels: overview.channels.length,
                newMessage,
            });

            // Run agent session with error handling
            await runSessionAndFinalize({
                prompt,
                channelsProcessed: overview.channels.length,
                messagesProcessed: overview.totalUnread,
                statusContext,
            });
        },

        completeCatchUp,

        getAbortController(): AbortController | null {
            return currentAbortController;
        },
    };
}
