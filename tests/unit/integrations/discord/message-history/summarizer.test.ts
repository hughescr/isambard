import { describe, it, expect, mock, beforeEach } from 'bun:test';
import _ from 'lodash';
import { createMessageSummarizer } from '@/integrations/discord/message-history/summarizer';
import type { DiscordSearchResult } from '@/integrations/discord/message-history/types';
import { createChannelId, createGuildId } from '@/integrations/discord/types';

// Mock the generateText module
const mockGenerateText = mock<(prompt: string) => Promise<string>>(_.constant(Promise.resolve('This is a test summary.')));
await mock.module('@/agent/text-generator', () => ({
    generateText: mockGenerateText,
}));

/**
 * Creates a mock Discord search result for testing.
 */
function createMockSearchResult(overrides: Partial<{
    id:                string
    channelId:         string
    guildId:           string | null
    authorId:          string
    authorUsername:    string
    authorDisplayName: string
    content:           string
    timestamp:         string
}> = {}): DiscordSearchResult {
    return {
        id:        overrides.id ?? '100000000000000000',
        channelId: createChannelId(overrides.channelId ?? '123456789012345678'),
        guildId:   overrides.guildId === null ? null : createGuildId(overrides.guildId ?? '987654321098765432'),
        author:    {
            id:          overrides.authorId ?? '111111111111111111',
            username:    overrides.authorUsername ?? 'testuser',
            displayName: overrides.authorDisplayName ?? 'Test User',
        },
        content:     overrides.content ?? 'Test message content',
        timestamp:   overrides.timestamp ?? '2025-01-15T12:00:00.000Z',
        attachments: [],
        embeds:      [],
        reactions:   [],
    };
}

describe('createMessageSummarizer', () => {
    beforeEach(() => {
        mockGenerateText.mockClear();
        mockGenerateText.mockImplementation(_.constant(Promise.resolve('This is a test summary.')));
    });

    describe('summarizeMessages', () => {
        it('should return empty array for empty input', async () => {
            const summarizer = createMessageSummarizer({});

            const result = await summarizer.summarizeMessages([]);

            expect(result).toEqual([]);
            expect(mockGenerateText).not.toHaveBeenCalled();
        });

        it('should return empty array immediately without calling Haiku when messages is empty', async () => {
            // Explicitly tests the _.isEmpty(messages) early return branch
            // This verifies no API calls are made for empty input
            let apiCallCount = 0;
            mockGenerateText.mockImplementation(async () => {
                apiCallCount++;
                return 'Should not be called';
            });

            const summarizer = createMessageSummarizer({});

            const result = await summarizer.summarizeMessages([]);

            // MUST return empty array
            expect(result).toEqual([]);
            expect(_.isArray(result)).toBe(true);
            expect(result.length).toBe(0);

            // MUST NOT call the API at all
            expect(apiCallCount).toBe(0);
            expect(mockGenerateText).not.toHaveBeenCalled();
        });

        it('should summarize a single message', async () => {
            const message = createMockSearchResult({
                id:             '100000000000000000',
                content:        'Hello world!',
                authorUsername: 'alice',
                timestamp:      '2025-01-15T12:00:00.000Z',
            });

            const summarizer = createMessageSummarizer({});

            const result = await summarizer.summarizeMessages([message]);

            expect(result).toHaveLength(1);
            expect(result[0].id).toBe('100000000000000000');
            expect(result[0].author).toBe('alice');
            expect(result[0].timestamp).toBe('2025-01-15T12:00:00.000Z');
            expect(result[0].synopsis).toBe('This is a test summary.');
        });

        it('should preserve message IDs from our code, not from Haiku', async () => {
            const message = createMockSearchResult({
                id:      '999888777666555444',
                content: 'Important message',
            });

            const summarizer = createMessageSummarizer({});

            const result = await summarizer.summarizeMessages([message]);

            // ID should come from our message, not from Haiku response
            expect(result[0].id).toBe('999888777666555444');

            // Verify the message content was passed to generateText (but not the ID)
            expect(mockGenerateText).toHaveBeenCalledTimes(1);
            const promptArg = mockGenerateText.mock.calls[0]?.[0] as string | undefined;
            expect(promptArg).toContain('Important message');
            expect(promptArg).not.toContain('999888777666555444');
        });

        it('should NOT pass message ID to Haiku prompt', async () => {
            const message = createMockSearchResult({
                id:      '123456789012345678',
                content: 'Some content here',
            });

            const summarizer = createMessageSummarizer({});

            await summarizer.summarizeMessages([message]);

            expect(mockGenerateText).toHaveBeenCalledTimes(1);
            const promptArg = mockGenerateText.mock.calls[0]?.[0] as string | undefined;

            // The ID should NOT appear in the prompt
            expect(promptArg).not.toContain('123456789012345678');
            // But the content should
            expect(promptArg).toContain('Some content here');
        });

        it('should summarize multiple messages in parallel', async () => {
            const messages = [
                createMockSearchResult({ id: '100000000000000001', content: 'First message', authorUsername: 'alice' }),
                createMockSearchResult({ id: '100000000000000002', content: 'Second message', authorUsername: 'bob' }),
                createMockSearchResult({ id: '100000000000000003', content: 'Third message', authorUsername: 'charlie' }),
            ];

            let callCount = 0;
            mockGenerateText.mockImplementation(async () => {
                callCount++;
                return `Summary ${callCount}`;
            });

            const summarizer = createMessageSummarizer({});

            const result = await summarizer.summarizeMessages(messages);

            expect(result).toHaveLength(3);
            expect(mockGenerateText).toHaveBeenCalledTimes(3);
        });

        it('should return summaries in same order as input messages', async () => {
            const messages = [
                createMockSearchResult({ id: '100000000000000001', authorUsername: 'alice', timestamp: '2025-01-15T10:00:00.000Z' }),
                createMockSearchResult({ id: '100000000000000002', authorUsername: 'bob', timestamp: '2025-01-15T11:00:00.000Z' }),
                createMockSearchResult({ id: '100000000000000003', authorUsername: 'charlie', timestamp: '2025-01-15T12:00:00.000Z' }),
            ];

            // Track call order to verify results are reordered correctly
            let callIndex = 0;
            mockGenerateText.mockImplementation(async () => {
                const idx = callIndex++;
                return `Summary for call ${idx}`;
            });

            const summarizer = createMessageSummarizer({});

            const result = await summarizer.summarizeMessages(messages);

            // Results should match input order (by ID/author), not call order
            expect(result[0].id).toBe('100000000000000001');
            expect(result[0].author).toBe('alice');
            expect(result[1].id).toBe('100000000000000002');
            expect(result[1].author).toBe('bob');
            expect(result[2].id).toBe('100000000000000003');
            expect(result[2].author).toBe('charlie');
        });

        it('should propagate error when Haiku API fails', async () => {
            const message = createMockSearchResult();

            mockGenerateText.mockImplementation(async () => {
                throw new Error('API rate limit exceeded');
            });

            const summarizer = createMessageSummarizer({});

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
            await expect(summarizer.summarizeMessages([message])).rejects.toThrow('API rate limit exceeded');
        });

        it('should propagate error when one message fails in batch', async () => {
            const messages = [
                createMockSearchResult({ id: '100000000000000001' }),
                createMockSearchResult({ id: '100000000000000002' }),
                createMockSearchResult({ id: '100000000000000003' }),
            ];

            let callCount = 0;
            mockGenerateText.mockImplementation(async () => {
                callCount++;
                if(callCount === 2) {
                    throw new Error('Network error on second call');
                }
                return 'Success';
            });

            const summarizer = createMessageSummarizer({});

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
            await expect(summarizer.summarizeMessages(messages)).rejects.toThrow('Network error on second call');
        });

        it('should include message content in prompt', async () => {
            const message = createMockSearchResult({
                content: 'This is the specific content to summarize',
            });

            const summarizer = createMessageSummarizer({});

            await summarizer.summarizeMessages([message]);

            expect(mockGenerateText).toHaveBeenCalledTimes(1);
            const promptArg = mockGenerateText.mock.calls[0]?.[0] as string | undefined;
            expect(promptArg).toContain('This is the specific content to summarize');
        });

        it('should include summarization instructions in prompt', async () => {
            const message = createMockSearchResult();

            const summarizer = createMessageSummarizer({});

            await summarizer.summarizeMessages([message]);

            expect(mockGenerateText).toHaveBeenCalledTimes(1);
            const promptArg = mockGenerateText.mock.calls[0]?.[0] as string | undefined;

            // Check for key parts of the prompt template
            expect(promptArg).toContain('Summarize');
            expect(promptArg).toContain('1-2 sentences');
        });
    });

    describe('concurrency limiting', () => {
        it('should default to maxConcurrent of 10', async () => {
            // Create 15 messages to test default concurrency
            const messages = _.times(15, i =>
                createMockSearchResult({ id: `10000000000000000${i}` })
            );

            // Use a deferred pattern to control when each task completes
            const deferreds: ((value: string) => void)[] = [];
            let maxConcurrent = 0;
            let currentConcurrent = 0;

            mockGenerateText.mockImplementation(() => {
                currentConcurrent++;
                maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
                return new Promise<string>((resolve) => {
                    deferreds.push((value: string) => {
                        currentConcurrent--;
                        resolve(value);
                    });
                });
            });

            const summarizer = createMessageSummarizer({});

            const resultPromise = summarizer.summarizeMessages(messages);

            // Wait for all tasks to be queued (give event loop time to start them)
            await new Promise(resolve => queueMicrotask(resolve));
            await new Promise(resolve => queueMicrotask(resolve));

            // Should not exceed default of 10 concurrent requests
            expect(maxConcurrent).toBeLessThanOrEqual(10);

            // Resolve all pending promises
            while(deferreds.length > 0) {
                const resolver = deferreds.shift();
                resolver?.('Summary');
                await new Promise(resolve => queueMicrotask(resolve));
            }

            await resultPromise;
        });

        it('should respect custom maxConcurrent setting', async () => {
            const messages = _.times(10, i =>
                createMockSearchResult({ id: `10000000000000000${i}` })
            );

            const deferreds: ((value: string) => void)[] = [];
            let maxConcurrent = 0;
            let currentConcurrent = 0;

            mockGenerateText.mockImplementation(() => {
                currentConcurrent++;
                maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
                return new Promise<string>((resolve) => {
                    deferreds.push((value: string) => {
                        currentConcurrent--;
                        resolve(value);
                    });
                });
            });

            const summarizer = createMessageSummarizer({
                maxConcurrent: 3,
            });

            const resultPromise = summarizer.summarizeMessages(messages);

            // Wait for tasks to be queued
            await new Promise(resolve => queueMicrotask(resolve));
            await new Promise(resolve => queueMicrotask(resolve));

            // Should not exceed 3 concurrent requests
            expect(maxConcurrent).toBeLessThanOrEqual(3);

            // Resolve all pending promises
            while(deferreds.length > 0) {
                const resolver = deferreds.shift();
                resolver?.('Summary');
                await new Promise(resolve => queueMicrotask(resolve));
            }

            await resultPromise;
        });

        it('should process all messages even with concurrency limit', async () => {
            const messages = _.times(25, i =>
                createMockSearchResult({ id: `10000000000000000${i}` })
            );

            const summarizer = createMessageSummarizer({
                maxConcurrent: 5,
            });

            const result = await summarizer.summarizeMessages(messages);

            expect(result).toHaveLength(25);
            expect(mockGenerateText).toHaveBeenCalledTimes(25);
        });

        it('should handle maxConcurrent of 1 (sequential processing)', async () => {
            const messages = _.times(3, i =>
                createMockSearchResult({ id: `10000000000000000${i}` })
            );

            let maxConcurrent = 0;
            let currentConcurrent = 0;

            // Use synchronous mock - tasks complete immediately
            mockGenerateText.mockImplementation(async () => {
                currentConcurrent++;
                maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
                currentConcurrent--;
                return 'Summary';
            });

            const summarizer = createMessageSummarizer({
                maxConcurrent: 1,
            });

            await summarizer.summarizeMessages(messages);

            // With maxConcurrent=1 and instant completion, each task runs alone
            expect(maxConcurrent).toBe(1);
            expect(mockGenerateText).toHaveBeenCalledTimes(3);
        });

        it('should decrement semaphore count after each task completes', async () => {
            // This test verifies that current-- works correctly in release()
            // If current-- were mutated to current++, concurrency would grow unbounded
            const messages = _.times(20, i =>
                createMockSearchResult({ id: `10000000000000000${i}` })
            );

            const deferreds: ((value: string) => void)[] = [];
            const concurrencySnapshots: number[] = [];
            let currentConcurrent = 0;

            mockGenerateText.mockImplementation(() => {
                currentConcurrent++;
                concurrencySnapshots.push(currentConcurrent);
                return new Promise<string>((resolve) => {
                    deferreds.push((value: string) => {
                        currentConcurrent--;
                        resolve(value);
                    });
                });
            });

            const summarizer = createMessageSummarizer({
                maxConcurrent: 3,
            });

            const resultPromise = summarizer.summarizeMessages(messages);

            // Wait for tasks to be queued
            await new Promise(resolve => queueMicrotask(resolve));
            await new Promise(resolve => queueMicrotask(resolve));

            // Resolve all pending promises
            while(deferreds.length > 0) {
                const resolver = deferreds.shift();
                resolver?.('Summary');
                await new Promise(resolve => queueMicrotask(resolve));
            }

            await resultPromise;

            // After all tasks complete, current should be back to 0
            expect(currentConcurrent).toBe(0);
            // All snapshots should be <= maxConcurrent (3)
            // If decrement was broken (current++), we'd see values exceeding 3
            expect(Math.max(...concurrencySnapshots)).toBeLessThanOrEqual(3);
        });

        it('should increment semaphore count when acquiring for queued task', async () => {
            // This test verifies that current++ in release() works correctly
            // when processing the next queued task
            const messages = _.times(6, i =>
                createMockSearchResult({ id: `10000000000000000${i}` })
            );

            const deferreds: ((value: string) => void)[] = [];
            let peakConcurrency = 0;
            let currentConcurrent = 0;
            let tasksStarted = 0;

            mockGenerateText.mockImplementation(() => {
                currentConcurrent++;
                tasksStarted++;
                peakConcurrency = Math.max(peakConcurrency, currentConcurrent);
                return new Promise<string>((resolve) => {
                    deferreds.push((value: string) => {
                        currentConcurrent--;
                        resolve(value);
                    });
                });
            });

            const summarizer = createMessageSummarizer({
                maxConcurrent: 2,
            });

            const resultPromise = summarizer.summarizeMessages(messages);

            // Wait for tasks to be queued
            await new Promise(resolve => queueMicrotask(resolve));
            await new Promise(resolve => queueMicrotask(resolve));

            // Resolve all pending promises
            while(deferreds.length > 0) {
                const resolver = deferreds.shift();
                resolver?.('Summary');
                await new Promise(resolve => queueMicrotask(resolve));
            }

            await resultPromise;

            // All 6 tasks should have started (meaning queued tasks were properly acquired)
            expect(tasksStarted).toBe(6);
            // Peak should be exactly 2 (the limit)
            expect(peakConcurrency).toBeLessThanOrEqual(2);
        });

        it('should release semaphore slot on error', async () => {
            // This test verifies the semaphore is released even when an error occurs
            const message1 = createMockSearchResult({ id: '100000000000000001' });
            const message2 = createMockSearchResult({ id: '100000000000000002' });

            let callCount = 0;
            mockGenerateText.mockImplementation(async () => {
                callCount++;
                if(callCount === 1) {
                    throw new Error('API error');
                }
                return 'Summary';
            });

            const summarizer = createMessageSummarizer({
                maxConcurrent: 1,
            });

            // First call should fail
            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
            await expect(summarizer.summarizeMessages([message1])).rejects.toThrow('API error');

            // Second call should still work (semaphore was released properly)
            const result = await summarizer.summarizeMessages([message2]);
            expect(result).toHaveLength(1);
        });
    });

    describe('edge cases', () => {
        it('should handle message with empty content', async () => {
            const message = createMockSearchResult({
                content: '',
            });

            const summarizer = createMessageSummarizer({});

            const result = await summarizer.summarizeMessages([message]);

            expect(result).toHaveLength(1);
            // Even empty content should be passed to generateText
            expect(mockGenerateText).toHaveBeenCalledTimes(1);
        });

        it('should handle message with very long content', async () => {
            const message = createMockSearchResult({
                content: _.repeat('Long content. ', 1000),
            });

            const summarizer = createMessageSummarizer({});

            const result = await summarizer.summarizeMessages([message]);

            expect(result).toHaveLength(1);
            expect(mockGenerateText).toHaveBeenCalledTimes(1);
        });

        it('should handle message with special characters', async () => {
            const message = createMockSearchResult({
                content: 'Message with emoji and special chars: <>&"\'',
            });

            const summarizer = createMessageSummarizer({});

            await summarizer.summarizeMessages([message]);

            expect(mockGenerateText).toHaveBeenCalledTimes(1);
            const promptArg = mockGenerateText.mock.calls[0]?.[0] as string | undefined;
            expect(promptArg).toContain('<>&"\'');
        });

        it('should use author username not displayName', async () => {
            const message = createMockSearchResult({
                authorUsername:    'actual_username',
                authorDisplayName: 'Display Name',
            });

            const summarizer = createMessageSummarizer({});

            const result = await summarizer.summarizeMessages([message]);

            expect(result[0].author).toBe('actual_username');
            expect(result[0].author).not.toBe('Display Name');
        });
    });
});
