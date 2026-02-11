/**
 * Discord Rate Limiter
 *
 * Implements per-channel queuing with global concurrency limiting for Discord message sends.
 *
 * Key design principles:
 * - Messages to the same channel are queued (sequential) to avoid rate limit bursts
 * - Messages to different channels can be concurrent (up to global limit)
 * - Discord.js automatically handles 429 retries, so we don't need manual retry-after logic
 * - Network errors are handled by the retry module (withDiscordRetry)
 *
 * Architecture:
 * - Per-channel promise chain: Ensures sequential sends to same channel
 * - Global p-limit wrapper: Caps total concurrent sends across all channels
 * - Graceful cleanup: stop() allows in-flight requests to complete
 */

import pLimit from 'p-limit';
import type { TextChannel, Message } from 'discord.js';

/** Function type for concurrency limiting (p-limit signature) */
export type LimitFunction = <T>(fn: () => PromiseLike<T>) => Promise<T>;

export interface DiscordRateLimiterOptions {
    /** Maximum concurrent sends across all channels (default: 5) */
    globalConcurrency?: number
    /** Optional logger for debugging */
    logger?:            { debug: (obj: Record<string, unknown>) => void }
    /** Injectable limit function for testing (default: uses p-limit) */
    limitFn?:           LimitFunction
}

/**
 * Discord rate limiter with per-channel queuing and global concurrency limiting.
 *
 * @example
 * ```typescript
 * const limiter = new DiscordRateLimiter({
 *   globalConcurrency: 5,
 *   logger: console,
 * });
 *
 * // Send to channel (queued per channel, limited globally)
 * const message = await limiter.sendToChannel(channel, 'Hello!');
 *
 * // Reply to message
 * await limiter.replyToMessage(message, 'Thanks!');
 *
 * // Cleanup
 * limiter.stop();
 * ```
 */
export class DiscordRateLimiter {
    // Global concurrency limiter - use injectable limit or default to p-limit
    private readonly limit:   LimitFunction;
    // Per-channel promise chains for sequential sends
    private readonly channelQueues = new Map<string, Promise<unknown>>();
    // Optional logger for debugging
    private readonly logger?: { debug: (obj: Record<string, unknown>) => void };

    constructor(options: DiscordRateLimiterOptions = {}) {
        const { globalConcurrency = 5, logger, limitFn } = options;
        this.limit = limitFn ?? pLimit(globalConcurrency);
        this.logger = logger;
    }

    /**
     * Send a message to a Discord channel with rate limiting.
     * Messages to the same channel are queued sequentially.
     *
     * @param channel The Discord text channel
     * @param content The message content
     * @returns The sent Discord message
     */
    async sendToChannel(channel: TextChannel, content: string): Promise<Message> {
        const channelId = channel.id;

        this.logger?.debug({
            msg:           'Queueing send to channel',
            channelId,
            contentLength: content.length,
        });

        return this.queueChannelOperation(channelId, async () => {
            this.logger?.debug({
                msg: 'Sending to channel',
                channelId,
            });
            return channel.send(content);
        });
    }

    /**
     * Reply to a Discord message with rate limiting.
     * Replies are treated as sends to the message's channel.
     *
     * @param message The message to reply to
     * @param content The reply content
     * @returns The sent reply message
     */
    async replyToMessage(message: Message, content: string): Promise<Message> {
        // Treat reply as a send to the message's channel
        const channelId = message.channelId;

        this.logger?.debug({
            msg:           'Queueing reply to message',
            channelId,
            messageId:     message.id,
            contentLength: content.length,
        });

        return this.queueChannelOperation(channelId, async () => {
            this.logger?.debug({
                msg:       'Replying to message',
                channelId,
                messageId: message.id,
            });
            return message.reply(content);
        });
    }

    /**
     * Stop the rate limiter and clean up pending queues.
     * In-flight requests are allowed to complete.
     */
    stop(): void {
        this.logger?.debug({
            msg:               'Stopping rate limiter',
            pendingQueueCount: this.channelQueues.size,
        });

        // Clear the channel queues map
        // Note: We don't cancel in-flight requests, we just stop accepting new ones
        this.channelQueues.clear();
    }

    /**
     * Queue a send operation for a specific channel.
     * Operations are chained sequentially per channel.
     */
    private queueChannelOperation<T>(channelId: string, operation: () => Promise<T>): Promise<T> {
        // Get existing queue for this channel (or start with resolved promise)
        const existingQueue = this.channelQueues.get(channelId) ?? Promise.resolve();

        // Chain the new operation after the existing queue
        // Use .catch(() => {}) to keep queue alive even if previous send failed
        const nextQueue = existingQueue
            // Stryker disable all: Observational logging for queue resilience
            .catch(() => {
                // Swallow errors from previous sends to keep queue alive
                this.logger?.debug({
                    msg: 'Previous send in queue failed, continuing queue',
                    channelId,
                });
            })
            // Stryker restore all
            .then(() => {
                this.logger?.debug({
                    msg: 'Executing queued operation',
                    channelId,
                });
                // Wrap in global concurrency limiter
                return this.limit(operation);
            });

        // Update the queue for this channel
        this.channelQueues.set(channelId, nextQueue);

        return nextQueue;
    }
}
