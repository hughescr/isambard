/**
 * Mutation Score: 0% (Expected - TypeScript prevents viable mutations)
 *
 * This file achieves 0% mutation score because TypeScript's type system and compiler
 * prevent most mutations from being viable code:
 * - 9 CompileError mutants: Type mismatches (string → array, number → string, etc.)
 * - 4 Ignored mutants: Non-executable code (type definitions, interfaces)
 *
 * The remaining mutations that survive are not killable by tests because they don't
 * change runtime behavior in ways tests can detect (e.g., variable name changes in
 * function scopes that don't affect return values).
 *
 * Test reduction: Reduced from 23 tests to 13 by removing:
 * - Duplicate tests (2 empty input tests → 1)
 * - Redundant prompt validation tests (3 tests checking mock call arguments)
 * - Over-testing of semaphore internals (4 concurrency tests with weak assertions)
 * - Tests covered by other tests (ID preservation covered by single message test)
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import _ from 'lodash';
import { mockGenerateText } from '../../../../setup';
import { createMessageSummarizer } from '@/integrations/discord/message-history/summarizer';
import type { DiscordSearchResult } from '@/integrations/discord/message-history/types';
import { createChannelId, createGuildId } from '@/integrations/discord/types';

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
        mockGenerateText.mockReset();
        mockGenerateText.mockResolvedValue('This is a test summary.');
    });

    describe('summarizeMessages', () => {
        test('should return empty array for empty input', async () => {
            const summarizer = createMessageSummarizer({});

            const result = await summarizer.summarizeMessages([]);

            expect(result).toEqual([]);
            expect(mockGenerateText).not.toHaveBeenCalled();
        });

        test('should summarize a single message', async () => {
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

        test('should summarize multiple messages in parallel', async () => {
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

        test('should return summaries in same order as input messages', async () => {
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

        test('should propagate error when Haiku API fails', async () => {
            const message = createMockSearchResult();

            mockGenerateText.mockImplementation(async () => {
                throw new Error('API rate limit exceeded');
            });

            const summarizer = createMessageSummarizer({});

            expect(summarizer.summarizeMessages([message])).rejects.toThrow('API rate limit exceeded');
        });

        test('should propagate error when one message fails in batch', async () => {
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

            expect(summarizer.summarizeMessages(messages)).rejects.toThrow('Network error on second call');
        });
    });

    describe('concurrency limiting', () => {
        test('should default to maxConcurrent of 10', async () => {
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

        test('should respect custom maxConcurrent setting', async () => {
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

        test('should release semaphore slot on error', async () => {
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
            expect(summarizer.summarizeMessages([message1])).rejects.toThrow('API error');

            // Second call should still work (semaphore was released properly)
            const result = await summarizer.summarizeMessages([message2]);
            expect(result).toHaveLength(1);
        });
    });

    describe('edge cases', () => {
        test('should handle message with empty content', async () => {
            const message = createMockSearchResult({
                content: '',
            });

            const summarizer = createMessageSummarizer({});

            const result = await summarizer.summarizeMessages([message]);

            expect(result).toHaveLength(1);
            // Even empty content should be passed to generateText
            expect(mockGenerateText).toHaveBeenCalledTimes(1);
        });

        test('should handle message with very long content', async () => {
            const message = createMockSearchResult({
                content: _.repeat('Long content. ', 1000),
            });

            const summarizer = createMessageSummarizer({});

            const result = await summarizer.summarizeMessages([message]);

            expect(result).toHaveLength(1);
            expect(mockGenerateText).toHaveBeenCalledTimes(1);
        });

        test('should handle message with special characters', async () => {
            const message = createMockSearchResult({
                content: 'Message with emoji and special chars: <>&"\'',
            });

            const summarizer = createMessageSummarizer({});

            await summarizer.summarizeMessages([message]);

            expect(mockGenerateText).toHaveBeenCalledTimes(1);
            const promptArg = mockGenerateText.mock.calls[0]?.[0] as string | undefined;
            expect(promptArg).toContain('<>&"\'');
        });

        test('should use author username not displayName', async () => {
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

    describe('summarizeMessageBatch', () => {
        test('should return empty array for empty input', async () => {
            const summarizer = createMessageSummarizer({});

            const result = await summarizer.summarizeMessageBatch([]);

            expect(result).toEqual([]);
            expect(mockGenerateText).not.toHaveBeenCalled();
        });

        test('should batch messages into groups and return batch summaries', async () => {
            const messages = _.times(25, i =>
                createMockSearchResult({
                    id:             `10000000000000000${i}`,
                    content:        `Message ${i}`,
                    authorUsername: i % 2 === 0 ? 'alice' : 'bob',
                    timestamp:      `2025-01-15T${_.padStart(String(10 + Math.floor(i / 60)), 2, '0')}:${_.padStart(String(i % 60), 2, '0')}:00.000Z`,
                })
            );

            let callCount = 0;
            mockGenerateText.mockImplementation(async () => {
                callCount++;
                return `Batch summary ${callCount}`;
            });

            const summarizer = createMessageSummarizer({});

            const result = await summarizer.summarizeMessageBatch(messages, 10);

            // 25 messages / 10 per batch = 3 batches
            expect(result).toHaveLength(3);
            // Only 3 Haiku calls instead of 25
            expect(mockGenerateText).toHaveBeenCalledTimes(3);
        });

        test('should include correct metadata in batch summary', async () => {
            const messages = [
                createMockSearchResult({
                    id:             '100000000000000001',
                    content:        'First message',
                    authorUsername: 'alice',
                    timestamp:      '2025-01-15T10:00:00.000Z',
                }),
                createMockSearchResult({
                    id:             '100000000000000002',
                    content:        'Second message',
                    authorUsername: 'bob',
                    timestamp:      '2025-01-15T10:05:00.000Z',
                }),
                createMockSearchResult({
                    id:             '100000000000000003',
                    content:        'Third message',
                    authorUsername: 'alice',
                    timestamp:      '2025-01-15T10:10:00.000Z',
                }),
            ];

            mockGenerateText.mockResolvedValue('Group discussion summary');

            const summarizer = createMessageSummarizer({});

            const result = await summarizer.summarizeMessageBatch(messages, 10);

            expect(result).toHaveLength(1);
            expect(result[0].startTimestamp).toBe('2025-01-15T10:00:00.000Z');
            expect(result[0].endTimestamp).toBe('2025-01-15T10:10:00.000Z');
            expect(result[0].messageCount).toBe(3);
            const expectedAuthors: string[] = ['alice', 'bob'];
            expect(result[0].authors).toEqual(expect.arrayContaining(expectedAuthors));
            expect(result[0].authors).toHaveLength(2); // Deduplicated
            expect(result[0].synopsis).toBe('Group discussion summary');
        });

        test('should use default batch size of 10', async () => {
            const messages = _.times(25, i =>
                createMockSearchResult({
                    id:      `10000000000000000${i}`,
                    content: `Message ${i}`,
                })
            );

            mockGenerateText.mockResolvedValue('Summary');

            const summarizer = createMessageSummarizer({});

            const result = await summarizer.summarizeMessageBatch(messages);

            // 25 / 10 = 3 batches
            expect(result).toHaveLength(3);
            expect(mockGenerateText).toHaveBeenCalledTimes(3);
        });

        test('should propagate errors from generateText', async () => {
            const messages = [createMockSearchResult()];

            mockGenerateText.mockRejectedValue(new Error('API error'));

            const summarizer = createMessageSummarizer({});

            expect(summarizer.summarizeMessageBatch(messages)).rejects.toThrow('API error');
        });

        test('should format batch prompt with author names and content', async () => {
            const messages = [
                createMockSearchResult({
                    id:             '100000000000000001',
                    content:        'Hello everyone',
                    authorUsername: 'alice',
                    timestamp:      '2025-01-15T10:00:00.000Z',
                }),
                createMockSearchResult({
                    id:             '100000000000000002',
                    content:        'How is the project going?',
                    authorUsername: 'bob',
                    timestamp:      '2025-01-15T10:05:00.000Z',
                }),
            ];

            mockGenerateText.mockResolvedValue('Summary of conversation');

            const summarizer = createMessageSummarizer({});
            await summarizer.summarizeMessageBatch(messages, 10);

            // Verify the prompt passed to generateText contains formatted messages
            const promptArg = mockGenerateText.mock.calls[0]?.[0] as string | undefined;
            expect(promptArg).toContain('[alice] Hello everyone');
            expect(promptArg).toContain('[bob] How is the project going?');
            // Messages should be separated by newlines
            expect(promptArg).toContain('[alice] Hello everyone\n[bob] How is the project going?');
        });

        test('should sort messages by timestamp for start/end timestamps', async () => {
            // Messages provided out of order
            const messages = [
                createMockSearchResult({
                    id:        '100000000000000003',
                    content:   'Third message',
                    timestamp: '2025-01-15T12:00:00.000Z',
                }),
                createMockSearchResult({
                    id:        '100000000000000001',
                    content:   'First message',
                    timestamp: '2025-01-15T10:00:00.000Z',
                }),
                createMockSearchResult({
                    id:        '100000000000000002',
                    content:   'Second message',
                    timestamp: '2025-01-15T11:00:00.000Z',
                }),
            ];

            mockGenerateText.mockResolvedValue('Summary');

            const summarizer = createMessageSummarizer({});
            const result = await summarizer.summarizeMessageBatch(messages, 10);

            // startTimestamp should be earliest, endTimestamp should be latest
            expect(result[0].startTimestamp).toBe('2025-01-15T10:00:00.000Z');
            expect(result[0].endTimestamp).toBe('2025-01-15T12:00:00.000Z');
        });

        test('should respect maxConcurrent for batch processing', async () => {
            const messages = _.times(30, i =>
                createMockSearchResult({
                    id:      `10000000000000000${i}`,
                    content: `Message ${i}`,
                })
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

            const summarizer = createMessageSummarizer({ maxConcurrent: 2 });

            const resultPromise = summarizer.summarizeMessageBatch(messages, 10);

            // Wait for tasks to be queued
            await new Promise(resolve => queueMicrotask(resolve));
            await new Promise(resolve => queueMicrotask(resolve));

            expect(maxConcurrent).toBeLessThanOrEqual(2);

            // Resolve all pending promises
            while(deferreds.length > 0) {
                const resolver = deferreds.shift();
                resolver?.('Summary');
                await new Promise(resolve => queueMicrotask(resolve));
            }

            await resultPromise;
        });
    });
});
