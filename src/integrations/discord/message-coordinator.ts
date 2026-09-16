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
import type { StreamTracker, StreamProgress, ResumeContext } from '@/agent';
import { InvariantViolationError } from '@/errors';

const MAX_PENDING_MESSAGES = 50;

/** Result from processing messages */
export interface ProcessResult {
    response:       string | null
    sessionId?:     string
    wasInterrupted: boolean
    streamTracker:  StreamTracker
    /**
     * The submitted envelope's own id (see `setup/conductor-processor.ts`), passed through to
     * `onResponse` verbatim so the caller can deliver idempotently keyed on the actual submitted
     * envelope rather than on some other id (e.g. a triggering Discord message id, which does not
     * identify a merged multi-message batch).
     */
    envelopeId?:    string
}

/** Processor function type - called to process batched messages */
export type MessageProcessor = (
    contexts: DiscordMessageContext[],
    resumeContext: ResumeContext | null,
    abortSignal: AbortSignal
) => Promise<ProcessResult>;

/** Configuration for the coordinator */
export interface MessageCoordinatorConfig {
    debounceMs?:      number  // Default: 2000ms
    /**
     * Optional callback invoked when processing completes (not on interruption). `batch` is the
     * non-null Discord `Message` of every context in the completed batch (originals + resumed),
     * in arrival order — a re-queued original message's `Message` reference is null (only its
     * context survives interruption) and is therefore excluded.
     */
    onResponse?:      (result: ProcessResult, discordMessage: Message | null, batch: Message[]) => Promise<void>
    /** Optional callback invoked when processing ends; an async callback is observed but does not delay the next run. */
    onProcessingEnd?: (info: { wasInterrupted: boolean, willResume: boolean }) => void | Promise<void>
    /**
     * Optional synchronous callback that returns true when the channel registry is ready.
     * When provided and returns false, incoming messages are dropped with a warn log.
     * If not provided, messages are always processed (backward-compatible).
     */
    registryReady?:   () => boolean
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
        resumeScheduled:     boolean
        resultCompleted:     boolean
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
    private readonly debounceMs:       number;
    private readonly onResponse?:      (result: ProcessResult, discordMessage: Message | null, batch: Message[]) => Promise<void>;
    private readonly onProcessingEnd?: (info: { wasInterrupted: boolean, willResume: boolean }) => void | Promise<void>;
    private readonly registryReady?:   () => boolean;
    private readonly channelStates = new Map<ChannelId, ChannelState>();
    private processor:                 MessageProcessor | null = null;

    constructor(config?: MessageCoordinatorConfig) {
        this.debounceMs = config?.debounceMs ?? 2000;
        this.onResponse = config?.onResponse;
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
        // Stryker disable next-line llm: `!x || x === null` is logically equivalent to `!x` for every value of x (x === null already implies !x).
        if(!state.typingChannel) {
            return;
        }

        // Early return if typing is already active - avoids unnecessary work
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
        void state.typingChannel.sendTyping().catch((err: unknown) => {
            logger.warn({ err, msg: 'MessageCoordinator: initial typing indicator failed' });
        });

        // Set up refresh interval (Discord typing lasts ~10 seconds, refresh every 8s)
        state.typingInterval = setInterval(() => {
            void state.typingChannel?.sendTyping().catch((err: unknown) => {
                logger.warn({ err, msg: 'MessageCoordinator: typing indicator refresh failed' });
            });
        }, 8000);
    }

    /**
     * Stop typing indicator and clear refresh interval.
     */
    private stopTypingIndicator(state: ChannelState): void {
        if(state.typingInterval) {
            clearInterval(state.typingInterval);
            state.typingInterval = undefined;
        }
    }

    /** The end callback is advisory; observe failures without delaying queued work. */
    private notifyProcessingEnd(channelId: ChannelId, info: { wasInterrupted: boolean, willResume: boolean }): void {
        try {
            const notified = this.onProcessingEnd?.(info);
            if(notified) {
                void notified.catch((err: unknown) => {
                    logger.error({ err, channelId, msg: 'MessageCoordinator: processing-end callback failed' });
                });
            }
        } catch (err) {
            logger.error({ err, channelId, msg: 'MessageCoordinator: processing-end callback failed' });
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
        firstDiscordMessage: Message | null,
        batch: Message[]
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
        return this.onResponse?.(result, firstDiscordMessage, batch);
    }

    /**
     * Start processing messages immediately.
     */
    private startProcessing(
        channelId: ChannelId,
        contexts: DiscordMessageContext[],
        firstDiscordMessage: Message | null
    ): void {
        if(!this.processor) {
            throw new InvariantViolationError('startProcessing', 'Processor not set. Call setProcessor() before handling messages.');
        }

        const state = this.getOrCreateState(channelId);

        // Fresh (non-resumed) path: contexts is always the single triggering message, so the
        // batch is just that message's Message object (never null — the only call site passes
        // the real discord.js Message that triggered this processing run).
        const batch: Message[] = firstDiscordMessage ? [firstDiscordMessage] : [];

        // Start typing indicator
        this.startTypingIndicator(state);

        // Create abort controller for this query
        const abortController = new AbortController();

        // Install ownership before invoking user code. A synchronous processor throw can run
        // catch/finally before the IIFE returns; its finally must clear this same active run.
        const activeQuery: NonNullable<ChannelState['activeQuery']> = {
            abortController,
            originalContexts:  contexts,
            processingPromise: Promise.resolve(),
            firstDiscordMessage,
            resumeScheduled:   false,
            resultCompleted:   false,
        };
        state.activeQuery = activeQuery;

        // The coordinator does not retry a failed processor or delivery callback: the inbox
        // checkpoint and conductor/outbox own replay, and a blind callback retry can send twice.
        const processingPromise = (async () => {
            let wasInterrupted = true; // Default: treat errors/aborts as interruptions
            let phase: 'processor' | 'onResponse' = 'processor';
            try {
                // Call processor
                const result = await this.processor!(
                    contexts,
                    null, // no resume context for initial processing
                    abortController.signal
                );
                wasInterrupted = result.wasInterrupted;
                if(!result.wasInterrupted && state.activeQuery?.abortController === abortController) {
                    state.activeQuery.resultCompleted = true;
                }
                phase = 'onResponse';

                // Conditionally await: handleProcessingResult returns a Promise only when onResponse
                // is invoked (completed path). For interrupted/no-callback paths it returns void,
                // avoiding an extra microtask hop that would delay state.activeQuery cleanup.
                const postProcess = this.handleProcessingResult(result, state, firstDiscordMessage, batch);
                if(postProcess) {
                    await postProcess;
                }
            } catch (err) {
                logger.error({ err, channelId, messageIds: contexts.map(context => context.messageId), phase, msg: 'MessageCoordinator: processing failed' });
            } finally {
                // Stop typing indicator
                this.stopTypingIndicator(state);
                // Clear active query
                state.activeQuery = undefined;
                // Notify caller about processing end state
                const willResume = state.pendingMessages.length > 0;
                this.notifyProcessingEnd(channelId, { wasInterrupted, willResume });
            }
        })();
        activeQuery.processingPromise = processingPromise;
    }

    /**
     * Process with resume context after debounce.
     */
    private processWithResume(channelId: ChannelId): void {
        if(!this.processor) {
            throw new InvariantViolationError('processWithResume', 'Processor not set. Call setProcessor() before handling messages.');
        }

        const state = this.getOrCreateState(channelId);

        if(state.pendingMessages.length === 0) {
            return;
        }

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
        const firstDiscordMessage = state.interruptedFirstMessage ?? newMessages[0]?.discordMessage ?? null;

        // The non-null Discord Message of every context in the batch (originals + resumed), in
        // arrival order. Re-queued original messages carry discordMessage: null (only their
        // context survives interruption — see the debounce-timer handler in handleMessage), so
        // they're excluded here; only messages we still hold a real Message object for appear.
        // Stryker disable next-line llm: originalMessages (discordMessage === null) are all removed by the following .filter, so the spread order of the two non-overlapping groups cannot affect batch
        const batch: Message[] = [...originalMessages, ...newMessages]
            .map(msg => msg.discordMessage)
            .filter((message): message is Message => message !== null);

        // Build the resume context up front — nothing below needs to resolve anything async.
        const resumeContext: ResumeContext | null = state.partialWork
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

        const activeQuery: NonNullable<ChannelState['activeQuery']> = {
            abortController,
            originalContexts:  allContexts,
            processingPromise: Promise.resolve(),
            firstDiscordMessage,
            resumeScheduled:   false,
            resultCompleted:   false,
        };
        state.activeQuery = activeQuery;

        // Delivery retries belong to the conductor/outbox, not this coordinator.
        const processingPromise = (async () => {
            let wasInterrupted = true; // Default: treat errors/aborts as interruptions
            let phase: 'processor' | 'onResponse' = 'processor';
            try {
                // Call processor with resume context
                const result = await this.processor!(
                    allContexts,
                    resumeContext,
                    abortController.signal
                );
                wasInterrupted = result.wasInterrupted;
                if(!result.wasInterrupted && state.activeQuery?.abortController === abortController) {
                    state.activeQuery.resultCompleted = true;
                }
                phase = 'onResponse';

                // Conditionally await: handleProcessingResult returns a Promise only when onResponse
                // is invoked (completed path). For interrupted/no-callback paths it returns void,
                // avoiding an extra microtask hop that would delay state.activeQuery cleanup.
                const postProcess = this.handleProcessingResult(result, state, firstDiscordMessage, batch);
                if(postProcess) {
                    await postProcess;
                }
            } catch (err) {
                logger.error({ err, channelId, messageIds: allContexts.map(context => context.messageId), phase, msg: 'MessageCoordinator: processing failed' });
            } finally {
                // Stop typing indicator
                this.stopTypingIndicator(state);
                // Clear active query
                state.activeQuery = undefined;
                // Notify caller about processing end state
                const willResume = state.pendingMessages.length > 0;
                this.notifyProcessingEnd(channelId, { wasInterrupted, willResume });
            }
        })();
        activeQuery.processingPromise = processingPromise;
    }

    /** Start one resumed run after both the active run and the latest debounce have ended. */
    private resumePending(channelId: ChannelId, state: ChannelState): void {
        if(this.channelStates.get(channelId) !== state || state.activeQuery || state.debounceTimer) {
            return;
        }
        this.processWithResume(channelId);
    }

    /**
     * Handle an incoming message.
     */
    handleMessage(context: DiscordMessageContext, discordMessage: Message, channel?: TypingChannel): void {
        if(!this.processor) {
            throw new InvariantViolationError('handleMessage', 'Processor not set. Call setProcessor() before handling messages.');
        }

        // Registry-ready gate: drop messages while the channel registry is hydrating.
        // Inbox checkpoint covers messages missed during this window.
        if(this.registryReady !== undefined && !this.registryReady()) {
            logger.warn({
                channelId: context.channelId,
                messageId: context.messageId,
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
            if(state.pendingMessages.length > MAX_PENDING_MESSAGES) {
                const evictCount = state.pendingMessages.length - MAX_PENDING_MESSAGES;
                state.pendingMessages.splice(0, evictCount);
                logger.debug({ evicted: evictCount, max: MAX_PENDING_MESSAGES, msg: 'MessageCoordinator: queue cap eviction (Case 1 push)' });
            }

            // Start or reset debounce timer
            clearTimeout(state.debounceTimer);

            // Set debounce timer - when it expires, THEN interrupt
            state.debounceTimer = setTimeout(() => {
                state.debounceTimer = undefined;

                const activeQuery = state.activeQuery;
                if(activeQuery) {
                    // Several debounce windows may expire while one aborted processor cleans up.
                    // Only the first expiry owns its requeue and completion continuation.
                    if(activeQuery.resumeScheduled) {
                        return;
                    }
                    activeQuery.resumeScheduled = true;
                    if(!activeQuery.resultCompleted) {
                        activeQuery.abortController.abort();

                        // Store the first message from interrupted query if we don't have one yet
                        // Stryker disable next-line llm: the field is cleared before every activeQuery install and resumeScheduled makes this line reachable at most once per query, so it is always undefined here and `??=` equals `=`
                        state.interruptedFirstMessage ??= activeQuery.firstDiscordMessage;

                        // Re-queue original messages (with null discordMessage)
                        const reQueuedOriginals = activeQuery.originalContexts.map(ctx => ({
                            context:        ctx,
                            discordMessage: null,
                        }));
                        state.pendingMessages.unshift(...reQueuedOriginals);
                        state.pendingMessages.splice(MAX_PENDING_MESSAGES); // Keep re-queued originals at the front
                    }

                    // A newer debounce may still be running when cleanup finishes; the continuation
                    // and timer both use resumePending, which starts at most one nonempty batch.
                    void activeQuery.processingPromise.then(() => this.resumePending(context.channelId, state)).catch((err: unknown) => {
                        logger.error({ err, channelId: context.channelId, msg: 'MessageCoordinator: failed to resume after interruption' });
                    });
                } else {
                    // Active query finished before debounce expired, just process pending normally
                    this.resumePending(context.channelId, state);
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
            if(state.pendingMessages.length > MAX_PENDING_MESSAGES) {
                state.pendingMessages.splice(0, state.pendingMessages.length - MAX_PENDING_MESSAGES);
                logger.debug({ max: MAX_PENDING_MESSAGES, msg: 'MessageCoordinator: queue cap eviction (Case 2)' });
            }

            // Reset debounce timer
            clearTimeout(state.debounceTimer);
            state.debounceTimer = setTimeout(() => {
                state.debounceTimer = undefined;
                this.resumePending(context.channelId, state);
            }, this.debounceMs);

            return;
        }

        // An end callback may synchronously submit a new message after activeQuery is cleared
        // but before its pending-batch continuation runs. Keep the queued batch first.
        if(state.pendingMessages.length > 0) {
            state.pendingMessages.push({ context, discordMessage });
            if(state.pendingMessages.length > MAX_PENDING_MESSAGES) {
                // Re-queued originals have no response yet. Evict the oldest newer message,
                // matching ordinary push eviction while retaining the interrupted original.
                const oldestNewIndex = state.pendingMessages.findIndex(message => message.discordMessage !== null);
                state.pendingMessages.splice(oldestNewIndex, 1);
                logger.debug({ evicted: 1, max: MAX_PENDING_MESSAGES, msg: 'MessageCoordinator: queue cap eviction (reentrant push)' });
            }
            this.resumePending(context.channelId, state);
            return;
        }

        // Case 3: No active processing, no debounce or pending batch
        state.partialWork = undefined;
        state.interruptedFirstMessage = undefined;
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
        clearTimeout(state.debounceTimer);
        state.debounceTimer = undefined;

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
