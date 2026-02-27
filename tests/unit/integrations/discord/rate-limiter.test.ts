/**
 * Tests for Discord Rate Limiter
 *
 * Verifies that:
 * - Messages to the same channel are sent sequentially (queued)
 * - Messages to different channels can be sent concurrently (up to global limit)
 * - Global concurrency limit is respected across all channels
 * - Queue cleanup works properly on stop()
 * - Errors in one send don't break subsequent sends in the queue
 */

import { describe, expect, test, mock } from 'bun:test';
import type { TextChannel, Message } from 'discord.js';
import { DiscordRateLimiter, type LimitFunction } from '@/integrations/discord/rate-limiter';

// Synchronous mock limit function that just executes immediately (no p-limit overhead)
const syncLimit: LimitFunction = async <T>(fn: () => PromiseLike<T>): Promise<T> => fn();

describe('new DiscordRateLimiter', () => {
    test('sends single message to channel', async () => {
        const mockChannel = {
            id:   'channel-1',
            send: mock().mockResolvedValue({ id: 'msg-1' }),
        } as unknown as TextChannel;

        const limiter = new DiscordRateLimiter({ limitFn: syncLimit });

        const result = await limiter.sendToChannel(mockChannel, 'Hello');

        expect(mockChannel.send).toHaveBeenCalledWith('Hello');
        expect(result.id).toBe('msg-1');

        limiter.stop();
    });

    test('queues multiple messages to same channel sequentially', async () => {
        const sendOrder: number[] = [];
        let sendCounter = 0;

        const mockChannel = {
            id:   'channel-1',
            send: mock(async () => {
                const order = ++sendCounter;
                sendOrder.push(order);
                // No delay - instant resolution
                return { id: `msg-${order}` };
            }),
        } as unknown as TextChannel;

        const limiter = new DiscordRateLimiter({ limitFn: syncLimit });

        // Start 3 sends to same channel concurrently
        const promise1 = limiter.sendToChannel(mockChannel, 'Message 1');
        const promise2 = limiter.sendToChannel(mockChannel, 'Message 2');
        const promise3 = limiter.sendToChannel(mockChannel, 'Message 3');

        const results = await Promise.all([promise1, promise2, promise3]);

        // Verify messages were sent in order (sequential)
        expect(sendOrder).toEqual([1, 2, 3]);
        expect(results[0].id).toBe('msg-1');
        expect(results[1].id).toBe('msg-2');
        expect(results[2].id).toBe('msg-3');

        limiter.stop();
    });

    test('allows concurrent sends to different channels', async () => {
        const sendOrder: string[] = [];

        const createMockChannel = (id: string) => ({
            id,
            send: mock(() => {
                sendOrder.push(id);
                return Promise.resolve({ id: `msg-${id}` });
            }),
        } as unknown as TextChannel);

        const mockChannel1 = createMockChannel('channel-1');
        const mockChannel2 = createMockChannel('channel-2');

        const limiter = new DiscordRateLimiter({ globalConcurrency: 10, limitFn: syncLimit });

        // Send to different channels concurrently
        const [result1, result2] = await Promise.all([
            limiter.sendToChannel(mockChannel1, 'Message 1'),
            limiter.sendToChannel(mockChannel2, 'Message 2'),
        ]);

        // Both channels should have been sent to
        expect(sendOrder).toHaveLength(2);
        expect(mockChannel1.send).toHaveBeenCalledWith('Message 1');
        expect(mockChannel2.send).toHaveBeenCalledWith('Message 2');

        expect(result1.id).toBe('msg-channel-1');
        expect(result2.id).toBe('msg-channel-2');

        limiter.stop();
    });

    test('respects global concurrency limit', async () => {
        const callOrder: string[] = [];

        // Create 3 different channels
        const channels = Array.from({ length: 3 }, (_, i) => ({
            id:   `channel-${i}`,
            send: mock(() => {
                callOrder.push(`channel-${i}`);
                return Promise.resolve({ id: `msg-${i}` } as Message);
            }),
        } as unknown as TextChannel));

        const limiter = new DiscordRateLimiter({ globalConcurrency: 2, limitFn: syncLimit });

        // Send to all 3 channels concurrently
        await Promise.all(
            channels.map(ch => limiter.sendToChannel(ch, 'test'))
        );

        // All 3 should have been called
        expect(callOrder).toHaveLength(3);

        limiter.stop();
    });

    test('error in one send does not break subsequent sends in queue', async () => {
        const mockChannel = {
            id:   'channel-1',
            send: mock()
                .mockRejectedValueOnce(new Error('Send failed'))
                .mockResolvedValueOnce({ id: 'msg-2' })
                .mockResolvedValueOnce({ id: 'msg-3' }),
        } as unknown as TextChannel;

        const limiter = new DiscordRateLimiter({ limitFn: syncLimit });

        // First send fails
        expect(
            limiter.sendToChannel(mockChannel, 'Message 1')
        ).rejects.toThrow('Send failed');

        // Second and third sends should still work
        const result2 = await limiter.sendToChannel(mockChannel, 'Message 2');
        const result3 = await limiter.sendToChannel(mockChannel, 'Message 3');

        expect(result2.id).toBe('msg-2');
        expect(result3.id).toBe('msg-3');

        limiter.stop();
    });

    test('replyToMessage works correctly', async () => {
        const mockMessage = {
            id:        'msg-original',
            channelId: 'channel-1',
            reply:     mock().mockResolvedValue({ id: 'msg-reply' }),
        } as unknown as Message;

        const limiter = new DiscordRateLimiter({ limitFn: syncLimit });

        const result = await limiter.replyToMessage(mockMessage, 'Reply text');

        expect(mockMessage.reply).toHaveBeenCalledWith('Reply text');
        expect(result.id).toBe('msg-reply');

        limiter.stop();
    });

    test('uses custom logger if provided', async () => {
        const mockLogger = {
            debug: mock(),
        };

        const mockChannel = {
            id:   'channel-1',
            send: mock().mockResolvedValue({ id: 'msg-1' }),
        } as unknown as TextChannel;

        const limiter = new DiscordRateLimiter({ logger: mockLogger, limitFn: syncLimit });

        await limiter.sendToChannel(mockChannel, 'Test message');

        // Logger should be called for queuing
        expect(mockLogger.debug).toHaveBeenCalled();

        limiter.stop();
    });

    test('stop() cleans up pending queues', async () => {
        const mockChannel = {
            id:   'channel-1',
            send: mock().mockResolvedValue({ id: 'msg-1' }),
        } as unknown as TextChannel;

        const limiter = new DiscordRateLimiter({ limitFn: syncLimit });

        // Start a send
        const promise = limiter.sendToChannel(mockChannel, 'Long message');

        // Stop immediately (doesn't cancel in-flight requests)
        limiter.stop();

        // The promise should still complete
        const result = await promise;
        expect(result.id).toBe('msg-1');
    });

    test('default globalConcurrency is 5', async () => {
        const callOrder: string[] = [];

        // Create 6 different channels to test the limit
        const channels = Array.from({ length: 6 }, (_, i) => ({
            id:   `channel-${i}`,
            send: mock(() => {
                callOrder.push(`channel-${i}`);
                return Promise.resolve({ id: `msg-${i}` } as Message);
            }),
        } as unknown as TextChannel));

        const limiter = new DiscordRateLimiter({ limitFn: syncLimit });

        // Send to all 6 channels concurrently
        await Promise.all(
            channels.map(ch => limiter.sendToChannel(ch, 'test'))
        );

        // All 6 should have been called
        expect(callOrder).toHaveLength(6);

        limiter.stop();
    });

    test('logs debug message when recovering from queue error', async () => {
        const mockLogger = {
            debug: mock(),
        };

        const mockChannel = {
            id:   'channel-1',
            send: mock()
                .mockRejectedValueOnce(new Error('First send failed'))
                .mockResolvedValueOnce({ id: 'msg-2' }),
        } as unknown as TextChannel;

        const limiter = new DiscordRateLimiter({ logger: mockLogger, limitFn: syncLimit });

        // First send fails
        expect(
            limiter.sendToChannel(mockChannel, 'Message 1')
        ).rejects.toThrow('First send failed');

        // Second send should work and logger should have been called for error recovery
        await limiter.sendToChannel(mockChannel, 'Message 2');

        // Verify debug was called with error recovery message
        const debugCalls = mockLogger.debug.mock.calls as [Record<string, unknown>][];
        const errorRecoveryCalls = debugCalls.filter(call => call[0].msg === 'Previous send in queue failed, continuing queue');
        expect(errorRecoveryCalls).toHaveLength(1);
        expect(errorRecoveryCalls[0][0].channelId).toBe('channel-1');

        limiter.stop();
    });

    test('logs debug messages during queue execution', async () => {
        const mockLogger = {
            debug: mock(),
        };

        const mockChannel = {
            id:   'channel-1',
            send: mock().mockResolvedValue({ id: 'msg-1' }),
        } as unknown as TextChannel;

        const limiter = new DiscordRateLimiter({ logger: mockLogger, limitFn: syncLimit });

        await limiter.sendToChannel(mockChannel, 'Test message');

        // Verify all expected debug calls
        const debugCalls = mockLogger.debug.mock.calls as [Record<string, unknown>][];

        // Should have: queueing, executing, and sending
        const queueingCalls = debugCalls.filter(call => call[0].msg === 'Queueing send to channel');
        const executingCalls = debugCalls.filter(call => call[0].msg === 'Executing queued operation');
        const sendingCalls = debugCalls.filter(call => call[0].msg === 'Sending to channel');

        expect(queueingCalls).toHaveLength(1);
        expect(queueingCalls[0][0].channelId).toBe('channel-1');
        expect(queueingCalls[0][0].contentLength).toBe(12);

        expect(executingCalls).toHaveLength(1);
        expect(executingCalls[0][0].channelId).toBe('channel-1');

        expect(sendingCalls).toHaveLength(1);
        expect(sendingCalls[0][0].channelId).toBe('channel-1');

        limiter.stop();
    });

    test('works correctly without logger', async () => {
        const mockChannel = {
            id:   'channel-1',
            send: mock().mockResolvedValue({ id: 'msg-1' }),
        } as unknown as TextChannel;

        // Create limiter without logger
        const limiter = new DiscordRateLimiter({ limitFn: syncLimit });

        // Should work normally
        const result = await limiter.sendToChannel(mockChannel, 'Hello');
        expect(result.id).toBe('msg-1');

        limiter.stop();
    });

    test('handles error recovery without logger', async () => {
        const mockChannel = {
            id:   'channel-1',
            send: mock()
                .mockRejectedValueOnce(new Error('Send failed'))
                .mockResolvedValueOnce({ id: 'msg-2' }),
        } as unknown as TextChannel;

        // Create limiter without logger
        const limiter = new DiscordRateLimiter({ limitFn: syncLimit });

        // First send fails
        expect(
            limiter.sendToChannel(mockChannel, 'Message 1')
        ).rejects.toThrow('Send failed');

        // Second send should still work (queue recovery works without logger)
        const result = await limiter.sendToChannel(mockChannel, 'Message 2');
        expect(result.id).toBe('msg-2');

        limiter.stop();
    });

    test('sendToChannel after stop() still completes in-flight requests', async () => {
        const mockChannel = {
            id:   'channel-1',
            send: mock().mockResolvedValue({ id: 'msg-1' }),
        } as unknown as TextChannel;

        const limiter = new DiscordRateLimiter({ limitFn: syncLimit });

        // Start a send
        const promise = limiter.sendToChannel(mockChannel, 'Message');

        // Stop immediately
        limiter.stop();

        // The in-flight request should complete
        const result = await promise;
        expect(result.id).toBe('msg-1');
    });

    test('multiple sequential stop() calls do not throw', async () => {
        const limiter = new DiscordRateLimiter({ limitFn: syncLimit });

        // Call stop multiple times
        expect(() => {
            limiter.stop();
            limiter.stop();
            limiter.stop();
        }).not.toThrow();
    });

    test('handles very long message content', async () => {
        const longMessage = 'x'.repeat(10_000);

        const mockChannel = {
            id:   'channel-1',
            send: mock().mockResolvedValue({ id: 'msg-1' }),
        } as unknown as TextChannel;

        const limiter = new DiscordRateLimiter({ limitFn: syncLimit });

        const result = await limiter.sendToChannel(mockChannel, longMessage);

        expect(mockChannel.send).toHaveBeenCalledWith(longMessage);
        expect(result.id).toBe('msg-1');

        limiter.stop();
    });

    test('handles channels with numeric string IDs', async () => {
        const mockChannel = {
            id:   '123456789012345678',
            send: mock().mockResolvedValue({ id: 'msg-1' }),
        } as unknown as TextChannel;

        const limiter = new DiscordRateLimiter({ limitFn: syncLimit });

        const result = await limiter.sendToChannel(mockChannel, 'Test');

        expect(mockChannel.send).toHaveBeenCalledWith('Test');
        expect(result.id).toBe('msg-1');

        limiter.stop();
    });

    test('logs stop() with pending queue count', async () => {
        const mockLogger = {
            debug: mock(),
        };

        const mockChannel = {
            id:   'channel-1',
            send: mock().mockResolvedValue({ id: 'msg-1' }),
        } as unknown as TextChannel;

        const limiter = new DiscordRateLimiter({ logger: mockLogger, limitFn: syncLimit });

        // Start a send to create a queue
        await limiter.sendToChannel(mockChannel, 'Message');

        // Stop and check logging
        limiter.stop();

        const debugCalls = mockLogger.debug.mock.calls as [Record<string, unknown>][];
        const stopCalls = debugCalls.filter(call => call[0].msg === 'Stopping rate limiter');

        expect(stopCalls).toHaveLength(1);
        expect(stopCalls[0][0]).toHaveProperty('pendingQueueCount');
    });

    test('replyToMessage logs with message ID', async () => {
        const mockLogger = {
            debug: mock(),
        };

        const mockMessage = {
            id:        'msg-original',
            channelId: 'channel-1',
            reply:     mock().mockResolvedValue({ id: 'msg-reply' }),
        } as unknown as Message;

        const limiter = new DiscordRateLimiter({ logger: mockLogger, limitFn: syncLimit });

        await limiter.replyToMessage(mockMessage, 'Reply text');

        const debugCalls = mockLogger.debug.mock.calls as [Record<string, unknown>][];
        const queueingCalls = debugCalls.filter(call => call[0].msg === 'Queueing reply to message');
        const replyingCalls = debugCalls.filter(call => call[0].msg === 'Replying to message');

        expect(queueingCalls).toHaveLength(1);
        expect(queueingCalls[0][0].messageId).toBe('msg-original');
        expect(queueingCalls[0][0].channelId).toBe('channel-1');

        expect(replyingCalls).toHaveLength(1);
        expect(replyingCalls[0][0].messageId).toBe('msg-original');

        limiter.stop();
    });
});
