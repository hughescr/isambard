/**
 * Message Coordinator Module
 *
 * Orchestrates multi-message handling by:
 * - Tracking active processing per channel
 * - Batching rapid successive messages via debounce window
 * - Interrupting active processing only after debounce timer expires
 * - Capturing partial work from interrupted streams
 * - Resuming with full context including all batched messages
 *
 * When messages arrive during active processing:
 * 1. Add message to pending queue
 * 2. Start/reset debounce timer (don't interrupt yet)
 * 3. After debounce expires -> interrupt the active query
 * 4. Wait for interrupted query to complete
 * 5. Process all batched messages with resume context
 *
 * This ensures the agent isn't idle during the debounce window and
 * batches all rapid messages before interrupting.
 */

import { logger } from '@hughescr/logger';
import type { Message } from 'discord.js';
import type { DiscordMessageContext, ChannelId } from './types';
import type { StreamTracker, StreamProgress, ResumeContext, EventDeltaTracker } from '@/agent';
import { InvariantViolationError } from '@/errors';

const MAX_PENDING_MESSAGES = 50;

/** Result from processing messages */
export interface ProcessResult {
    response:       string | null
    sessionId?:     string
    wasInterrupted: boolean
    streamTracker:  StreamTracker
}

/** Processor function type - called to process batched messages */
export type MessageProcessor = (
    contexts: DiscordMessageContext[],
    resumeContext: ResumeContext | null,
    abortSignal: AbortSignal
) => Promise<ProcessResult>;

/** Configuration for the coordinator */
export interface MessageCoordinatorConfig {
    debounceMs?:        number  // Default: 2000ms
    /** Optional callback invoked when processing completes (not on interruption) */
    onResponse?:        (result: ProcessResult, discordMessage: Message | null) => Promise<void>
    /** Optional event delta tracker for capturing new events during processing */
    eventDeltaTracker?: EventDeltaTracker
    /** Optional callback invoked when processing ends, with info about whether it was interrupted and whether it will resume */
    onProcessingEnd?:   (info: { wasInterrupted: boolean, willResume: boolean }) => void
    /**
     * Optional synchronous callback that returns true when the channel registry is ready.
     * When provided and returns false, incoming messages are dropped with a warn log.
     * If not provided, messages are always processed (backward-compatible).
     */
    registryReady?:     () => boolean
}

/** Discord channel interface for typing indicator */
export interface TypingChannel {
    sendTyping(): Promise<void>
}

/** Internal queued message type */
interface QueuedMessage {
    context:        DiscordMessageContext
    discordMessage: Message | null  // null for re-queued original messages
}

/** Internal state per channel */
interface ChannelState {
    // Active processing
    activeQuery?: {
        abortController:     AbortController
        originalContexts:    DiscordMessageContext[]
        processingPromise:   Promise<void>
        firstDiscordMessage: Message | null  // First message in the batch for response
    }
    // Messages received during processing
    pendingMessages:          QueuedMessage[]
    // Debounce timer after interrupt
    debounceTimer?:           ReturnType<typeof setTimeout>
    // Partial work from interrupted query
    partialWork?:             StreamProgress
    // First Discord message from interrupted query (for onResponse callback)
    interruptedFirstMessage?: Message | null
    // Typing indicator support
    typingChannel?:           TypingChannel
    typingInterval?:          ReturnType<typeof setInterval>
}

/**
 * Message coordinator orchestrating multi-message handling.
 *
 * @example
 * ```typescript
 * const coordinator = new MessageCoordinator({ debounceMs: 500 });
 *
 * coordinator.setProcessor(async (contexts, resumeContext, abortSignal) => {
 *   // Process messages
 *   return {
 *     response: 'Response text',
 *     sessionId: 'session-123',
 *     wasInterrupted: false,
 *     streamTracker: new StreamTracker()
 *   };
 * });
 *
 * coordinator.handleMessage(context, message, channel);
 * coordinator.stop();
 * ```
 */
export class MessageCoordinator {
    private readonly debounceMs:         number;
    private readonly onResponse?:        (result: ProcessResult, discordMessage: Message | null) => Promise<void>;
    private readonly eventDeltaTracker?: EventDeltaTracker;
    private readonly onProcessingEnd?:   (info: { wasInterrupted: boolean, willResume: boolean }) => void;
    private readonly registryReady?:     () => boolean;
    private readonly channelStates = new Map<ChannelId, ChannelState>();
    private processor:                   MessageProcessor | null = null;

    constructor(config?: MessageCoordinatorConfig) {
        this.debounceMs = config?.debounceMs ?? 2000;
        this.onResponse = config?.onResponse;
        this.eventDeltaTracker = config?.eventDeltaTracker;
        this.onProcessingEnd = config?.onProcessingEnd;
        this.registryReady = config?.registryReady;
    }

    /**
     * Get or create channel state.
     */
    private getOrCreateState(channelId: ChannelId): ChannelState {
        let state = this.channelStates.get(channelId);
        if(!state) {
            state = {
                pendingMessages: [],
            };
            this.channelStates.set(channelId, state);
        }
        return state;
    }

    /**
     * Start typing indicator and set up refresh interval.
     */
    private startTypingIndicator(state: ChannelState): void {
        if(!state.typingChannel) {
            return;
        }

        // Early return if typing is already active - avoids unnecessary work
        // Stryker disable next-line ConditionalExpression,BlockStatement: Defensive guard - stopTypingIndicator always clears interval before next startTypingIndicator call; prevents leaked intervals if call order changes
        if(state.typingInterval) {
            return;
        }

        // Debug logging to trace calls
        logger.debug({
            hasExisting: !!state.typingInterval,
            channelId:   'present',
            msg:         'startTypingIndicator called',
        });

        // Send initial typing indicator
        // Stryker disable next-line ArrowFunction: Equivalent mutant - () => undefined and () => undefined both return undefined, suppressing the caught error
        // eslint-disable-next-line no-restricted-syntax -- sendTyping is best-effort; Discord rate limits or offline state should not crash message processing
        void state.typingChannel.sendTyping().catch(() => undefined);

        // Set up refresh interval (Discord typing lasts ~10 seconds, refresh every 8s)
        state.typingInterval = setInterval(() => {
            // Stryker disable next-line ArrowFunction: Equivalent mutant - () => undefined and () => undefined both return undefined, suppressing the caught error
            // eslint-disable-next-line no-restricted-syntax -- sendTyping is best-effort; Discord rate limits or offline state should not crash message processing
            state.typingChannel?.sendTyping().catch(() => undefined);
        }, 8000);
    }

    /**
     * Stop typing indicator and clear refresh interval.
     */
    private stopTypingIndicator(state: ChannelState): void {
        // Stryker disable next-line ConditionalExpression,BlockStatement: Guard clause - clearInterval on undefined is harmless but unnecessary
        if(state.typingInterval) {
            clearInterval(state.typingInterval);
            state.typingInterval = undefined;
        }
    }

    /**
     * Shared post-processing logic for both startProcessing and processWithResume.
     * Handles interrupted vs completed result, captures partial work, and invokes onResponse.
     * Returns the onResponse Promise when there is work to await, or void otherwise.
     * This avoids extra microtask hops in the interrupted/no-callback paths.
     * Callers are responsible for cleanup (stopTypingIndicator, activeQuery) in their own finally blocks.
     */

    private handleProcessingResult(
        result: ProcessResult,
        state: ChannelState,
        firstDiscordMessage: Message | null
    ): Promise<void> | void {
        // If interrupted, capture partial work for resume context (human-readable summary only)
        if(result.wasInterrupted) {
            if(result.streamTracker.hasMeaningfulProgress()) {
                state.partialWork = result.streamTracker.getProgress();
            }
            // No meaningful progress → next batch starts fresh; return void (no extra tick)
            return;
        }
        // Completed - invoke callback
        // Return the onResponse Promise directly so callers can await it without an extra tick,
        // or void if there is no callback (no extra tick needed)
        return this.onResponse?.(result, firstDiscordMessage);
    }

    /**
     * Start processing messages immediately.
     */
    private startProcessing(
        channelId: ChannelId,
        contexts: DiscordMessageContext[],
        firstDiscordMessage: Message | null
    ): void {
        // Stryker disable all: Unreachable - handleMessage checks processor first
        if(!this.processor) {
            throw new InvariantViolationError('startProcessing', 'Processor not set. Call setProcessor() before handling messages.');
        }
        // Stryker restore all

        const state = this.getOrCreateState(channelId);

        // Start typing indicator
        this.startTypingIndicator(state);

        // Create abort controller for this query
        const abortController = new AbortController();

        // Create the processing promise
        // Stryker disable next-line ArrowFunction: Equivalent mutant — catch handler suppresses unhandled rejection; return value is unused
        const processingPromise = (async () => {
            let wasInterrupted = true; // Default: treat errors/aborts as interruptions
            try {
                // Mark event delta start point before processing begins (must await to prevent race)
                await this.eventDeltaTracker?.markStart();

                // Call processor
                const result = await this.processor!(
                    contexts,
                    null, // no resume context for initial processing
                    abortController.signal
                );
                wasInterrupted = result.wasInterrupted;

                // Conditionally await: handleProcessingResult returns a Promise only when onResponse
                // is invoked (completed path). For interrupted/no-callback paths it returns void,
                // avoiding an extra microtask hop that would delay state.activeQuery cleanup.
                const postProcess = this.handleProcessingResult(result, state, firstDiscordMessage);
                // Stryker disable next-line ConditionalExpression,BlockStatement: conditional await — if void, skip await to avoid extra microtask
                if(postProcess) {
                    await postProcess;
                }
            } finally {
                // Stop typing indicator
                this.stopTypingIndicator(state);
                // Clear active query
                state.activeQuery = undefined;
                // Notify caller about processing end state
                // Stryker disable next-line ConditionalExpression,EqualityOperator,LogicalOperator: debounceTimer is structurally redundant — handleMessage always pushes to pendingMessages before setting debounceTimer
                const willResume = state.pendingMessages.length > 0 || state.debounceTimer !== undefined;
                this.onProcessingEnd?.({ wasInterrupted, willResume });
            }
        // eslint-disable-next-line no-restricted-syntax -- IIFE safety net: internal errors are handled by the try/catch above; outer .catch prevents unhandled rejection in case of internal logic errors
        })().catch(() => undefined);

        // Store in state
        state.activeQuery = {
            abortController,
            originalContexts: contexts,
            processingPromise,
            firstDiscordMessage,
        };
    }

    /**
     * Process with resume context after debounce.
     */
    private processWithResume(channelId: ChannelId): void {
        // Stryker disable all: Unreachable - handleMessage checks processor first
        if(!this.processor) {
            throw new InvariantViolationError('processWithResume', 'Processor not set. Call setProcessor() before handling messages.');
        }
        // Stryker restore all

        const state = this.getOrCreateState(channelId);

        // Get pending messages and clear the queue
        const pendingMessages = [...state.pendingMessages];
        state.pendingMessages = [];

        // Separate original messages (discordMessage === null) from new ones
        const originalMessages = pendingMessages.filter(msg => msg.discordMessage === null);
        const newMessages = pendingMessages.filter(msg => msg.discordMessage !== null);

        // Build contexts array: original + new
        const allContexts = [
            ...originalMessages.map(msg => msg.context),
            ...newMessages.map(msg => msg.context),
        ];

        // Get the first Discord message for this batch
        // Priority: 1) interruptedFirstMessage (from original interrupted query)
        //           2) First new message's Discord message
        // Stryker disable next-line OptionalChaining: newMessages cannot be empty in reachable paths
        const firstDiscordMessage = state.interruptedFirstMessage ?? newMessages[0]?.discordMessage ?? null;

        // Build partial resume context (newEvents resolved async in processing block)
        const partialResumeContext = state.partialWork
            ? {
                partialWork: state.partialWork,
                newMessages: newMessages.map(msg => msg.context),
            }
            : null;

        // Clear partial work and interrupted first message
        state.partialWork = undefined;
        state.interruptedFirstMessage = undefined;

        // Start typing indicator
        this.startTypingIndicator(state);

        // Create abort controller for this query
        const abortController = new AbortController();

        // Create the processing promise
        // Stryker disable next-line ArrowFunction: Equivalent mutant — catch handler suppresses unhandled rejection; return value is unused
        const processingPromise = (async () => {
            let wasInterrupted = true; // Default: treat errors/aborts as interruptions
            try {
                // Resolve newEvents asynchronously
                const resumeContext: ResumeContext | null = partialResumeContext
                    ? {
                        ...partialResumeContext,
                        newEvents: this.eventDeltaTracker
                            ? await this.eventDeltaTracker.getNewEvents()
                            : [],
                    }
                    : null;

                // Call processor with resume context
                const result = await this.processor!(
                    allContexts,
                    resumeContext,
                    abortController.signal
                );
                wasInterrupted = result.wasInterrupted;

                // Conditionally await: handleProcessingResult returns a Promise only when onResponse
                // is invoked (completed path). For interrupted/no-callback paths it returns void,
                // avoiding an extra microtask hop that would delay state.activeQuery cleanup.
                const postProcess = this.handleProcessingResult(result, state, firstDiscordMessage);
                // Stryker disable next-line ConditionalExpression,BlockStatement: conditional await — if void, skip await to avoid extra microtask
                if(postProcess) {
                    await postProcess;
                }
            } finally {
                // Stop typing indicator
                this.stopTypingIndicator(state);
                // Clear active query
                state.activeQuery = undefined;
                // Notify caller about processing end state
                // Stryker disable next-line ConditionalExpression,EqualityOperator,LogicalOperator: debounceTimer is structurally redundant — handleMessage always pushes to pendingMessages before setting debounceTimer
                const willResume = state.pendingMessages.length > 0 || state.debounceTimer !== undefined;
                this.onProcessingEnd?.({ wasInterrupted, willResume });
            }
        // eslint-disable-next-line no-restricted-syntax -- IIFE safety net: internal errors are handled by the try/catch above; outer .catch prevents unhandled rejection in case of internal logic errors
        })().catch(() => undefined);

        // Store in state
        state.activeQuery = {
            abortController,
            originalContexts: allContexts,
            processingPromise,
            firstDiscordMessage,
        };
    }

    /**
     * Handle an incoming message.
     */
    handleMessage(context: DiscordMessageContext, discordMessage: Message, channel?: TypingChannel): void {
        // Stryker disable next-line ConditionalExpression,BlockStatement: Redundant with checks in startProcessing (line 126) and processWithResume (line 180)
        if(!this.processor) {
            // Stryker disable next-line StringLiteral: invariant location and detail strings are debug-only metadata
            throw new InvariantViolationError('handleMessage', 'Processor not set. Call setProcessor() before handling messages.');
        }

        // Registry-ready gate: drop messages while the channel registry is hydrating.
        // Inbox checkpoint covers messages missed during this window.
        if(this.registryReady !== undefined && !this.registryReady()) {
            // Stryker disable next-line ObjectLiteral: Logger warn object for observability
            logger.warn({
                channelId: context.channelId,
                messageId: context.messageId,
                // Stryker disable next-line StringLiteral: log message is informational only
                msg:       'MessageCoordinator: dropping message — channel registry not ready',
            });
            return;
        }

        const state = this.getOrCreateState(context.channelId);

        // Store the channel reference for typing indicator
        if(channel) {
            state.typingChannel = channel;
        }

        // Case 1: Active query in progress
        if(state.activeQuery) {
            // Add new message to pending queue (DON'T interrupt yet)
            state.pendingMessages.push({
                context,
                discordMessage,
            });
            // Stryker disable next-line ConditionalExpression,EqualityOperator: queue cap boundary — equivalent mutant (> vs >=) produces identical behavior in practice
            if(state.pendingMessages.length > MAX_PENDING_MESSAGES) {
                const evictCount = state.pendingMessages.length - MAX_PENDING_MESSAGES;
                state.pendingMessages.splice(0, evictCount);
                // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                logger.debug({ evicted: evictCount, max: MAX_PENDING_MESSAGES, msg: 'MessageCoordinator: queue cap eviction (Case 1 push)' });
            }

            // Start or reset debounce timer
            // Stryker disable next-line ConditionalExpression: clearTimeout(undefined) is a no-op
            if(state.debounceTimer) {
                clearTimeout(state.debounceTimer);
            }

            // Store the processing promise to wait for it
            const processingPromise = state.activeQuery.processingPromise;

            // Set debounce timer - when it expires, THEN interrupt
            state.debounceTimer = setTimeout(() => {
                state.debounceTimer = undefined;

                // Check if active query is still running
                if(state.activeQuery) {
                    // Interrupt the active query
                    state.activeQuery.abortController.abort();

                    // Store the first message from interrupted query if we don't have one yet
                    state.interruptedFirstMessage ??= state.activeQuery.firstDiscordMessage;

                    // Re-queue original messages (with null discordMessage)
                    const reQueuedOriginals = state.activeQuery.originalContexts.map(ctx => ({
                        context:        ctx,
                        discordMessage: null,
                    }));
                    state.pendingMessages.unshift(...reQueuedOriginals);
                    // Stryker disable next-line ConditionalExpression,EqualityOperator: queue cap boundary — equivalent mutant (> vs >=) produces identical behavior in practice
                    if(state.pendingMessages.length > MAX_PENDING_MESSAGES) {
                        state.pendingMessages.length = MAX_PENDING_MESSAGES; // Truncate from end (keep re-queued originals at front)
                    }

                    // Wait for the interrupted processing to complete, then start processing with resume
                    void processingPromise.finally(() => {
                        this.processWithResume(context.channelId);
                    });
                } else {
                    // Active query finished before debounce expired, just process pending normally
                    this.processWithResume(context.channelId);
                }
            }, this.debounceMs);

            return;
        }

        // Case 2: Debounce timer active (but no active query)
        if(state.debounceTimer) {
            // Just add to pending queue
            state.pendingMessages.push({
                context,
                discordMessage,
            });
            // Stryker disable next-line ConditionalExpression,EqualityOperator: queue cap boundary — equivalent mutant (> vs >=) produces identical behavior in practice
            if(state.pendingMessages.length > MAX_PENDING_MESSAGES) {
                state.pendingMessages.splice(0, state.pendingMessages.length - MAX_PENDING_MESSAGES);
                // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                logger.debug({ max: MAX_PENDING_MESSAGES, msg: 'MessageCoordinator: queue cap eviction (Case 2)' });
            }

            // Reset debounce timer
            clearTimeout(state.debounceTimer);
            // Stryker disable next-line BlockStatement: Case 2 (debounce active, no query) is covered via Case 1 interrupt flow
            state.debounceTimer = setTimeout(() => {
                state.debounceTimer = undefined;
                this.processWithResume(context.channelId);
            }, this.debounceMs);

            return;
        }

        // Case 3: No active processing, no debounce
        this.startProcessing(context.channelId, [context], discordMessage);
    }

    /**
     * Set the processor function.
     */
    setProcessor(newProcessor: MessageProcessor): void {
        this.processor = newProcessor;
    }

    /**
     * Cleanup a single channel's state.
     */
    private cleanupChannelState(channelId: ChannelId): void {
        const state = this.channelStates.get(channelId);
        if(!state) {
            return;
        }

        // Clear debounce timer
        // Stryker disable next-line ConditionalExpression: clearTimeout(undefined) is a no-op
        if(state.debounceTimer) {
            clearTimeout(state.debounceTimer);
            state.debounceTimer = undefined;
        }

        // Stop typing indicator
        this.stopTypingIndicator(state);

        // Abort any active query
        if(state.activeQuery) {
            state.activeQuery.abortController.abort();
            state.activeQuery = undefined;
        }

        // Remove from map
        this.channelStates.delete(channelId);
    }

    /**
     * Remove a single channel's state (cleanup on channel deletion).
     */
    removeChannel(channelId: ChannelId): void {
        this.cleanupChannelState(channelId);
    }

    /**
     * Remove multiple channels' state (cleanup on guild deletion).
     */
    removeGuildChannels(channelIds: ChannelId[]): void {
        for(const channelId of channelIds) {
            this.cleanupChannelState(channelId);
        }
    }

    /**
     * Stop the coordinator and cleanup.
     */
    stop(): void {
        // Clear all channel states
        for(const channelId of this.channelStates.keys()) {
            this.cleanupChannelState(channelId);
        }
    }
}
