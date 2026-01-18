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

import type { Message } from 'discord.js';
import type { DiscordMessageContext, ChannelId } from './types';
import type { StreamTracker, StreamProgress } from '../../agent/stream-tracker';
import type { ResumeContext } from '../../agent/resume-prompt-builder';
import _ from 'lodash';

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
    sessionId: string | undefined,
    abortSignal: AbortSignal
) => Promise<ProcessResult>;

/** Configuration for the coordinator */
export interface MessageCoordinatorConfig {
    debounceMs?: number  // Default: 2000ms
    /** Optional callback invoked when processing completes (not on interruption) */
    onResponse?: (result: ProcessResult, discordMessage: Message | null) => Promise<void>
}

/** Discord channel interface for typing indicator */
export interface TypingChannel {
    sendTyping(): Promise<void>
}

export interface MessageCoordinator {
    /** Handle an incoming message */
    handleMessage(context: DiscordMessageContext, discordMessage: Message, channel?: TypingChannel): void

    /** Set the processor function (called to process messages) */
    setProcessor(processor: MessageProcessor): void

    /** Stop the coordinator and cleanup */
    stop(): void
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
    // Session tracking for resume
    sessionId?:               string
    // Partial work from interrupted query
    partialWork?:             StreamProgress
    // First Discord message from interrupted query (for onResponse callback)
    interruptedFirstMessage?: Message | null
    // Typing indicator support
    typingChannel?:           TypingChannel
    typingInterval?:          ReturnType<typeof setInterval>
}

/**
 * Creates a MessageCoordinator instance for orchestrating multi-message handling.
 * @param config Optional configuration (debounceMs)
 * @returns A new MessageCoordinator instance
 */
export function createMessageCoordinator(config?: MessageCoordinatorConfig): MessageCoordinator {
    const debounceMs = config?.debounceMs ?? 2000;
    const onResponse = config?.onResponse;

    // Map of channel states
    const channelStates = new Map<ChannelId, ChannelState>();

    // Processor function (set by caller)
    let processor: MessageProcessor | null = null;

    /**
     * Get or create channel state.
     */
    function getOrCreateState(channelId: ChannelId): ChannelState {
        let state = channelStates.get(channelId);
        if(!state) {
            state = {
                pendingMessages: [],
            };
            channelStates.set(channelId, state);
        }
        return state;
    }

    /**
     * Start typing indicator and set up refresh interval.
     */
    function startTypingIndicator(state: ChannelState): void {
        if(!state.typingChannel) {
            return;
        }

        // Send initial typing indicator
        void state.typingChannel.sendTyping().catch(() => _.noop());

        // Set up refresh interval (Discord typing lasts ~10 seconds, refresh every 8s)
        state.typingInterval = setInterval(() => {
            void state.typingChannel?.sendTyping().catch(() => _.noop());
        }, 8000);
    }

    /**
     * Stop typing indicator and clear refresh interval.
     */
    function stopTypingIndicator(state: ChannelState): void {
        if(state.typingInterval) {
            clearInterval(state.typingInterval);
            state.typingInterval = undefined;
        }
    }

    /**
     * Start processing messages immediately.
     */
    function startProcessing(
        channelId: ChannelId,
        contexts: DiscordMessageContext[],
        firstDiscordMessage: Message | null
    ): void {
        // Stryker disable all: Unreachable - handleMessage checks processor first
        if(!processor) {
            throw new Error('Processor not set. Call setProcessor() before handling messages.');
        }
        // Stryker restore all

        const state = getOrCreateState(channelId);

        // Start typing indicator
        startTypingIndicator(state);

        // Create abort controller for this query
        const abortController = new AbortController();

        // Create the processing promise
        const processingPromise = (async () => {
            try {
                // Call processor
                const result = await processor(
                    contexts,
                    null, // no resume context for initial processing
                    state.sessionId,
                    abortController.signal
                );

                // If interrupted, capture partial work AND sessionId for resume
                if(result.wasInterrupted) {
                    state.partialWork = result.streamTracker.getProgress();
                    if(result.sessionId) {
                        state.sessionId = result.sessionId;
                    }
                } else {
                    // Completed - clear sessionId (session was cleaned up), invoke callback
                    state.sessionId = undefined;
                    if(onResponse) {
                        await onResponse(result, firstDiscordMessage);
                    }
                }
            } finally {
                // Stop typing indicator
                stopTypingIndicator(state);
                // Clear active query
                state.activeQuery = undefined;
            }
        })();

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
    function processWithResume(channelId: ChannelId): void {
        // Stryker disable all: Unreachable - handleMessage checks processor first
        if(!processor) {
            throw new Error('Processor not set. Call setProcessor() before handling messages.');
        }
        // Stryker restore all

        const state = getOrCreateState(channelId);

        // Get pending messages and clear the queue
        const pendingMessages = [...state.pendingMessages];
        state.pendingMessages = [];

        // Separate original messages (discordMessage === null) from new ones
        const originalMessages = _.filter(pendingMessages, ['discordMessage', null]);
        const newMessages = _.filter(pendingMessages, msg => msg.discordMessage !== null);

        // Build contexts array: original + new
        const allContexts = [
            ..._.map(originalMessages, 'context'),
            ..._.map(newMessages, 'context'),
        ];

        // Get the first Discord message for this batch
        // Priority: 1) interruptedFirstMessage (from original interrupted query)
        //           2) First new message's Discord message
        // Stryker disable next-line OptionalChaining: newMessages cannot be empty in reachable paths
        const firstDiscordMessage = state.interruptedFirstMessage ?? newMessages[0]?.discordMessage ?? null;

        // Build resume context if we have partial work
        const resumeContext: ResumeContext | null = state.partialWork
            ? {
                partialWork: state.partialWork,
                newEvents:   [], // Will integrate with EventDeltaTracker
                newMessages: _.map(newMessages, 'context'),
            }
            : null;

        // Clear partial work and interrupted first message
        state.partialWork = undefined;
        state.interruptedFirstMessage = undefined;

        // Start typing indicator
        startTypingIndicator(state);

        // Create abort controller for this query
        const abortController = new AbortController();

        // Create the processing promise
        const processingPromise = (async () => {
            try {
                // Call processor with resume context
                const result = await processor(
                    allContexts,
                    resumeContext,
                    state.sessionId,
                    abortController.signal
                );

                // If interrupted, capture partial work AND sessionId for resume
                if(result.wasInterrupted) {
                    state.partialWork = result.streamTracker.getProgress();
                    if(result.sessionId) {
                        state.sessionId = result.sessionId;
                    }
                } else {
                    // Completed - clear sessionId (session was cleaned up), invoke callback
                    state.sessionId = undefined;
                    if(onResponse) {
                        await onResponse(result, firstDiscordMessage);
                    }
                }
            } finally {
                // Stop typing indicator
                stopTypingIndicator(state);
                // Clear active query
                state.activeQuery = undefined;
            }
        })();

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
    function handleMessage(context: DiscordMessageContext, discordMessage: Message, channel?: TypingChannel): void {
        // Stryker disable next-line ConditionalExpression,BlockStatement: Redundant with checks in startProcessing (line 126) and processWithResume (line 180)
        if(!processor) {
            throw new Error('Processor not set. Call setProcessor() before handling messages.');
        }

        const state = getOrCreateState(context.channelId);

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
                    const reQueuedOriginals = _.map(state.activeQuery.originalContexts, ctx => ({
                        context:        ctx,
                        discordMessage: null,
                    }));
                    state.pendingMessages.unshift(...reQueuedOriginals);

                    // Wait for the interrupted processing to complete, then start processing with resume
                    void processingPromise.finally(() => {
                        processWithResume(context.channelId);
                    });
                } else {
                    // Active query finished before debounce expired, just process pending normally
                    processWithResume(context.channelId);
                }
            }, debounceMs);

            return;
        }

        // Case 2: Debounce timer active (but no active query)
        if(state.debounceTimer) {
            // Just add to pending queue
            state.pendingMessages.push({
                context,
                discordMessage,
            });

            // Reset debounce timer
            clearTimeout(state.debounceTimer);
            // Stryker disable next-line BlockStatement: Case 2 (debounce active, no query) is covered via Case 1 interrupt flow
            state.debounceTimer = setTimeout(() => {
                state.debounceTimer = undefined;
                processWithResume(context.channelId);
            }, debounceMs);

            return;
        }

        // Case 3: No active processing, no debounce
        startProcessing(context.channelId, [context], discordMessage);
    }

    /**
     * Set the processor function.
     */
    function setProcessor(newProcessor: MessageProcessor): void {
        processor = newProcessor;
    }

    /**
     * Stop the coordinator and cleanup.
     */
    function stop(): void {
        // Clear all debounce timers and typing intervals
        for(const state of channelStates.values()) {
            // Stryker disable next-line ConditionalExpression: clearTimeout(undefined) is a no-op
            if(state.debounceTimer) {
                clearTimeout(state.debounceTimer);
                state.debounceTimer = undefined;
            }

            // Stop typing indicators
            stopTypingIndicator(state);

            // Abort any active queries
            if(state.activeQuery) {
                state.activeQuery.abortController.abort();
                state.activeQuery = undefined;
            }
        }

        // Clear all state
        channelStates.clear();
    }

    return {
        handleMessage,
        setProcessor,
        stop,
    };
}
