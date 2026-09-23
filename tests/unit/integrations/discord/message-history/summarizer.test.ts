/**
 * Batch summarizer contracts: prompt, metadata, ordering, and concurrency.
 * The default concurrency test uses single-message batches to exercise the
 * same limiter as larger batches without calling the removed per-message API.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mockGenerateText, originalGenerateText } from '../../../../setup';
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

function waitForMicrotaskCondition(predicate: () => boolean, description: string, remainingTurns = 20): Promise<void> {
    if(predicate()) {
        return Promise.resolve();
    }
    if(remainingTurns === 0) {
        return Promise.reject(new Error(`Timed out waiting for ${description}`));
    }
    return Promise.resolve().then(() => waitForMicrotaskCondition(predicate, description, remainingTurns - 1));
}

describe('createMessageSummarizer', () => {
    beforeEach(() => {
        mockGenerateText.mockReset();
        mockGenerateText.mockResolvedValue('This is a test summary.');
    });

    afterEach(() => {
        mockGenerateText.mockReset();
        mockGenerateText.mockImplementation(originalGenerateText);
    });

    describe('batch concurrency default', () => {
        test('should default to maxConcurrent of 10 for message batches', async () => {
            // Create 15 single-message batches to test default concurrency
            const messages = Array.from({ length: 15 }, (_, i) =>
                createMockSearchResult({ id: `10000000000000000${i}` }));

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

            const resultPromise = summarizer.summarizeMessageBatch(messages, 1);

            await waitForMicrotaskCondition(() => deferreds.length === 10, 'all default p-limit slots to start');

            expect(maxConcurrent).toBe(10);

            for(let resolved = 0; resolved < messages.length; resolved++) {
                const resolver = deferreds.shift();
                expect(resolver).toBeDefined();
                resolver!('Summary');
                if(resolved < messages.length - 1) {
                    // eslint-disable-next-line no-await-in-loop -- preserve resolver order while yielding until a pending deferred is available
                    await waitForMicrotaskCondition(() => deferreds.length > 0, 'p-limit to schedule the next default worker');
                }
            }

            const result = await resultPromise;
            expect(result).toHaveLength(messages.length);
            expect(maxConcurrent).toBeLessThanOrEqual(10);
        });
    });

    describe('summarizeMessageBatch', () => {
        test('sends author and content under batch instructions', async () => {
            const summarizer = createMessageSummarizer({});
            await summarizer.summarizeMessageBatch([createMockSearchResult({ authorUsername: 'alice', content: 'Ship on Friday' })]);
            const prompt = mockGenerateText.mock.calls[0]?.[0];
            expect(prompt).toContain('Summarize these Discord messages');
            expect(prompt).toContain('[alice] Ship on Friday');
            expect(prompt).not.toContain('{messages}');
        });

        test('should return empty array for empty input', async () => {
            const summarizer = createMessageSummarizer({});

            const result = await summarizer.summarizeMessageBatch([]);

            expect(result).toEqual([]);
            expect(mockGenerateText).not.toHaveBeenCalled();
        });

        test('returns empty batches before constructing an invalid zero-concurrency limiter', async () => {
            const summarizer = createMessageSummarizer({ maxConcurrent: 0 });

            await expect(summarizer.summarizeMessageBatch([])).resolves.toEqual([]);
            expect(mockGenerateText).not.toHaveBeenCalled();
        });

        test('should batch messages into groups and return batch summaries', async () => {
            const messages = Array.from({ length: 25 }, (_, i) =>
                createMockSearchResult({
                    id:             `10000000000000000${i}`,
                    content:        `Message ${i}`,
                    authorUsername: i % 2 === 0 ? 'alice' : 'bob',
                    timestamp:      `2025-01-15T${String(10 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`,
                }));

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

        test('substitutes the message block exactly once when a body contains the placeholder', async () => {
            const summarizer = createMessageSummarizer({});

            await summarizer.summarizeMessageBatch([
                createMockSearchResult({ authorUsername: 'alice', content: 'Use {messages} as the key' }),
            ]);

            const prompt = mockGenerateText.mock.calls[0]?.[0];
            expect(prompt).toContain('[alice] Use {messages} as the key');
            // A second `.replace('{messages}', ...)` pass re-substitutes the placeholder inside the
            // message body, rendering the author a second time.
            expect(prompt.match(/\[alice\]/g)).toHaveLength(1);
        });

        test('deduplicates authors in first-appearance order, not batch timestamp order', async () => {
            const messages = [
                createMockSearchResult({ id: '100000000000000011', authorUsername: 'alice', timestamp: '2025-01-15T10:05:00.000Z' }),
                createMockSearchResult({ id: '100000000000000012', authorUsername: 'bob', timestamp: '2025-01-15T10:00:00.000Z' }),
                createMockSearchResult({ id: '100000000000000013', authorUsername: 'alice', timestamp: '2025-01-15T10:10:00.000Z' }),
            ];

            const summarizer = createMessageSummarizer({});

            const result = await summarizer.summarizeMessageBatch(messages, 10);

            expect(result).toHaveLength(1);
            expect(result[0].authors).toEqual(['alice', 'bob']);
            expect(result[0].startTimestamp).toBe('2025-01-15T10:00:00.000Z');
            expect(result[0].endTimestamp).toBe('2025-01-15T10:10:00.000Z');
        });

        test('should use default batch size of 10', async () => {
            const messages = Array.from({ length: 25 }, (_, i) =>
                createMockSearchResult({
                    id:      `10000000000000000${i}`,
                    content: `Message ${i}`,
                }));

            mockGenerateText.mockResolvedValue('Summary');

            const summarizer = createMessageSummarizer({});

            const result = await summarizer.summarizeMessageBatch(messages);

            // 25 / 10 = 3 batches of sizes [10, 10, 5]; asserting the exact
            // per-batch sizes (not just the batch count) pins the default to
            // 10 rather than any other value that also yields 3 batches.
            expect(result).toHaveLength(3);
            expect(mockGenerateText).toHaveBeenCalledTimes(3);
            expect(result.map(batch => batch.messageCount)).toEqual([10, 10, 5]);
        });

        test('should propagate errors from generateText', async () => {
            const messages = [createMockSearchResult()];

            mockGenerateText.mockRejectedValue(new Error('API error'));

            const summarizer = createMessageSummarizer({});

            await expect(summarizer.summarizeMessageBatch(messages)).rejects.toThrow('API error');
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

        test('should slice messages into correct batches with proper boundaries', async () => {
            // Use batchSize=3 and 7 messages to create 3 batches: [0,1,2], [3,4,5], [6]
            // This verifies i * batchSize and (i + 1) * batchSize arithmetic
            const messages = Array.from({ length: 7 }, (_, i) =>
                createMockSearchResult({
                    id:             `10000000000000000${i}`,
                    content:        `Message content ${i}`,
                    authorUsername: `user${i}`,
                    timestamp:      `2025-01-15T${String(10 + i).padStart(2, '0')}:00:00.000Z`,
                }));

            const summarizer = createMessageSummarizer({});
            await summarizer.summarizeMessageBatch(messages, 3);

            // 7 / 3 = ceil(2.33) = 3 batches, so generateText called 3 times
            expect(mockGenerateText).toHaveBeenCalledTimes(3);

            // Batch 0: messages[0..2], Batch 1: messages[3..5], Batch 2: messages[6]
            // Verify each batch prompt contains exactly the right messages
            const call0 = mockGenerateText.mock.calls[0]?.[0];
            const call1 = mockGenerateText.mock.calls[1]?.[0];
            const call2 = mockGenerateText.mock.calls[2]?.[0];

            // First batch: messages 0, 1, 2 (indices 0 * 3 to 1 * 3)
            expect(call0).toContain('Message content 0');
            expect(call0).toContain('Message content 1');
            expect(call0).toContain('Message content 2');
            expect(call0).not.toContain('Message content 3');

            // Second batch: messages 3, 4, 5 (indices 1 * 3 to 2 * 3)
            expect(call1).toContain('Message content 3');
            expect(call1).toContain('Message content 4');
            expect(call1).toContain('Message content 5');
            expect(call1).not.toContain('Message content 0');
            expect(call1).not.toContain('Message content 6');

            // Third batch: message 6 only (indices 2 * 3 to 3 * 3, but only 7 total)
            expect(call2).toContain('Message content 6');
            expect(call2).not.toContain('Message content 5');
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
            const messages = Array.from({ length: 30 }, (_, i) =>
                createMockSearchResult({
                    id:      `10000000000000000${i}`,
                    content: `Message ${i}`,
                }));

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

            await waitForMicrotaskCondition(() => deferreds.length === 2, 'all batch p-limit slots to start');

            expect(maxConcurrent).toBe(2);

            for(let resolved = 0; resolved < 3; resolved++) {
                const resolver = deferreds.shift();
                expect(resolver).toBeDefined();
                resolver!('Summary');
                if(resolved < 2) {
                    // eslint-disable-next-line no-await-in-loop -- preserve resolver order while yielding until a pending deferred is available
                    await waitForMicrotaskCondition(() => deferreds.length > 0, 'p-limit to schedule the next batch');
                }
            }

            const result = await resultPromise;
            expect(result).toHaveLength(3);
            expect(maxConcurrent).toBeLessThanOrEqual(2);
        });
    });
});
