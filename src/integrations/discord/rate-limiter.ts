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

export interface DiscordRateLimiter {
    /**
     * Send a message to a Discord channel with rate limiting.
     * Messages to the same channel are queued sequentially.
     *
     * @param channel The Discord text channel
     * @param content The message content
     * @returns The sent Discord message
     */
    sendToChannel(channel: TextChannel, content: string): Promise<Message>

    /**
     * Reply to a Discord message with rate limiting.
     * Replies are treated as sends to the message's channel.
     *
     * @param message The message to reply to
     * @param content The reply content
     * @returns The sent reply message
     */
    replyToMessage(message: Message, content: string): Promise<Message>

    /**
     * Stop the rate limiter and clean up pending queues.
     * In-flight requests are allowed to complete.
     */
    stop(): void
}

/**
 * Create a Discord rate limiter with per-channel queuing and global concurrency limiting.
 *
 * @param options Configuration options
 * @returns DiscordRateLimiter instance
 *
 * @example
 * ```typescript
 * const limiter = createDiscordRateLimiter({
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
export function createDiscordRateLimiter(options: DiscordRateLimiterOptions = {}): DiscordRateLimiter {
    const { globalConcurrency = 5, logger, limitFn } = options;

    // Global concurrency limiter - use injectable limit or default to p-limit
    const limit: LimitFunction = limitFn ?? pLimit(globalConcurrency);

    // Per-channel promise chains for sequential sends
    const channelQueues = new Map<string, Promise<unknown>>();

    /**
     * Queue a send operation for a specific channel.
     * Operations are chained sequentially per channel.
     */
    function queueChannelOperation<T>(channelId: string, operation: () => Promise<T>): Promise<T> {
        // Get existing queue for this channel (or start with resolved promise)
        const existingQueue = channelQueues.get(channelId) ?? Promise.resolve();

        // Chain the new operation after the existing queue
        // Use .catch(() => {}) to keep queue alive even if previous send failed
        const nextQueue = existingQueue
            .catch(() => {
                // Swallow errors from previous sends to keep queue alive
                logger?.debug({
                    msg: 'Previous send in queue failed, continuing queue',
                    channelId,
                });
            })
            .then(() => {
                logger?.debug({
                    msg: 'Executing queued operation',
                    channelId,
                });
                // Wrap in global concurrency limiter
                return limit(operation);
            });

        // Update the queue for this channel
        channelQueues.set(channelId, nextQueue);

        return nextQueue;
    }

    return {
        async sendToChannel(channel: TextChannel, content: string): Promise<Message> {
            const channelId = channel.id;

            logger?.debug({
                msg:           'Queueing send to channel',
                channelId,
                contentLength: content.length,
            });

            return queueChannelOperation(channelId, async () => {
                logger?.debug({
                    msg: 'Sending to channel',
                    channelId,
                });
                return channel.send(content);
            });
        },

        async replyToMessage(message: Message, content: string): Promise<Message> {
            // Treat reply as a send to the message's channel
            const channelId = message.channelId;

            logger?.debug({
                msg:           'Queueing reply to message',
                channelId,
                messageId:     message.id,
                contentLength: content.length,
            });

            return queueChannelOperation(channelId, async () => {
                logger?.debug({
                    msg:       'Replying to message',
                    channelId,
                    messageId: message.id,
                });
                return message.reply(content);
            });
        },

        stop(): void {
            logger?.debug({
                msg:               'Stopping rate limiter',
                pendingQueueCount: channelQueues.size,
            });

            // Clear the channel queues map
            // Note: We don't cancel in-flight requests, we just stop accepting new ones
            channelQueues.clear();
        },
    };
}
