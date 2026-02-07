/* eslint-disable @typescript-eslint/no-explicit-any -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Test mocks */
/* eslint-disable @typescript-eslint/unbound-method -- Mock methods */

import { describe, test, expect, mock, beforeEach, afterEach, jest } from 'bun:test';
import _ from 'lodash';
import {
    createMessageSearchService,
    type MessageSearchService
} from '@/integrations/discord/message-history/search';
import type { DiscordSearchResult } from '@/integrations/discord/message-history/types';
import { createChannelId } from '@/integrations/discord/types';
import type { MessageFetcher } from '@/integrations/discord/message-history/fetcher';
import type { MessageSummarizer } from '@/integrations/discord/message-history/summarizer';

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
    // Handle guildId: null if explicitly set, otherwise null
    let guildId = null;
    if(overrides.guildId !== null && overrides.guildId !== undefined) {
        guildId = createChannelId(overrides.guildId) as any;
    }

    return {
        id:        overrides.id ?? '100000000000000000',
        channelId: createChannelId(overrides.channelId ?? '123456789012345678'),
        guildId,
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

describe('createMessageSearchService', () => {
    let mockFetcher: MessageFetcher;
    let mockSummarizer: MessageSummarizer;
    let service: MessageSearchService;

    const testChannelId = '123456789012345678';

    beforeEach(() => {
        // Use fake timers to prevent timing-related race conditions
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2025-01-20T12:00:00.000Z'));

        mockFetcher = {
            fetchMessages: mock(() => Promise.resolve({ messages: [], hasMore: false })),
            fetchById:     mock(() => Promise.resolve(null)),
            fetchByIds:    mock(() => Promise.resolve([])),
        };

        mockSummarizer = {
            summarizeMessages:     mock(() => Promise.resolve([])),
            summarizeMessageBatch: mock(() => Promise.resolve([])),
        };

        service = createMessageSearchService({
            fetcher:    mockFetcher,
            summarizer: mockSummarizer,
        });
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('searchMessages', () => {
        describe('fetcher integration', () => {
            test('should fetch messages from Discord API', async () => {
                const fetchedMessage = createMockSearchResult({
                    id:        '100000000000000001',
                    content:   'Fetched content',
                    timestamp: '2025-01-15T12:00:00.000Z',
                });

                (mockFetcher.fetchMessages as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages: [fetchedMessage],
                        hasMore:  false,
                    })
                );

                const result = await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                });

                expect(mockFetcher.fetchMessages).toHaveBeenCalled();
                expect(result.messages).toHaveLength(1);
                expect(result.messages[0].content).toBe('Fetched content');
            });

            test('should pass correct time range parameters to fetcher', async () => {
                const startTime = new Date('2025-01-10T00:00:00.000Z');
                const endTime = new Date('2025-01-15T00:00:00.000Z');

                const fetchedMessage = createMockSearchResult({
                    id:        '100000000000000001',
                    content:   'Fetched content',
                    timestamp: startTime.toISOString(),
                });

                (mockFetcher.fetchMessages as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages: [fetchedMessage],
                        hasMore:  false,
                    })
                );

                await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                    startTime,
                    endTime,
                });

                expect(mockFetcher.fetchMessages).toHaveBeenCalled();
                expect(mockFetcher.fetchMessages).toHaveBeenCalledWith({
                    channelId: createChannelId(testChannelId),
                    startTime,
                    endTime,
                });
            });

            test('should handle multiple fetched messages', async () => {
                const now = new Date('2025-01-20T12:00:00.000Z');
                const olderTime = new Date('2025-01-15T00:00:00.000Z');
                const oldestTime = new Date('2025-01-10T00:00:00.000Z');

                const messages = [
                    createMockSearchResult({
                        id:        '100000000000000001',
                        content:   'Oldest message',
                        timestamp: oldestTime.toISOString(),
                    }),
                    createMockSearchResult({
                        id:        '100000000000000002',
                        content:   'Older message',
                        timestamp: olderTime.toISOString(),
                    }),
                ];

                (mockFetcher.fetchMessages as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages,
                        hasMore: false,
                    })
                );

                const result = await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                    startTime: oldestTime,
                    endTime:   now,
                });

                expect(result.messages).toHaveLength(2);
                expect(result.messages[0].content).toBe('Oldest message');
                expect(result.messages[1].content).toBe('Older message');
            });
        });

        describe('time range handling', () => {
            test('should use default time range of 7 days when not specified', async () => {
                await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                });

                const fetcherCall = (mockFetcher.fetchMessages as ReturnType<typeof mock>).mock.calls[0][0];
                const startTime = fetcherCall.startTime as Date;
                const endTime = fetcherCall.endTime as Date;

                const now = new Date('2025-01-20T12:00:00.000Z');
                const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

                // Allow 1 second tolerance for test execution time
                expect(Math.abs(endTime.getTime() - now.getTime())).toBeLessThan(1000);
                expect(Math.abs(startTime.getTime() - sevenDaysAgo.getTime())).toBeLessThan(1000);
            });

            test('should use provided startTime and endTime', async () => {
                const startTime = new Date('2025-01-01T00:00:00.000Z');
                const endTime = new Date('2025-01-10T00:00:00.000Z');

                await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                    startTime,
                    endTime,
                });

                const fetcherCall = (mockFetcher.fetchMessages as ReturnType<typeof mock>).mock.calls[0][0];

                expect(fetcherCall.startTime).toBe(startTime);
                expect(fetcherCall.endTime).toBe(endTime);
            });

            test('should include time range in response metadata', async () => {
                const startTime = new Date('2025-01-01T00:00:00.000Z');
                const endTime = new Date('2025-01-10T00:00:00.000Z');

                const result = await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                    startTime,
                    endTime,
                });

                expect(result.metadata.timeRange.start).toBe(startTime.toISOString());
                expect(result.metadata.timeRange.end).toBe(endTime.toISOString());
            });

            test('should allow custom default time range via options', async () => {
                const customService = createMessageSearchService({
                    fetcher:              mockFetcher,
                    summarizer:           mockSummarizer,
                    defaultTimeRangeDays: 3,
                });

                await customService.searchMessages({
                    channelId: createChannelId(testChannelId),
                });

                const fetcherCall = (mockFetcher.fetchMessages as ReturnType<typeof mock>).mock.calls[0][0];
                const startTime = fetcherCall.startTime as Date;
                const endTime = fetcherCall.endTime as Date;

                const diffDays = (endTime.getTime() - startTime.getTime()) / (24 * 60 * 60 * 1000);
                expect(Math.abs(diffDays - 3)).toBeLessThan(0.01);
            });
        });

        describe('text query filtering', () => {
            test('should filter messages by text query (case-insensitive)', async () => {
                const messages = [
                    createMockSearchResult({ id: '100000000000000001', content: 'Hello World' }),
                    createMockSearchResult({ id: '100000000000000002', content: 'Goodbye World' }),
                    createMockSearchResult({ id: '100000000000000003', content: 'HELLO again' }),
                ];

                (mockFetcher.fetchMessages as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages,
                        hasMore: false,
                    })
                );

                const result = await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                    query:     'hello',
                });

                expect(result.messages).toHaveLength(2);
                expect(_.some(result.messages, ['content', 'Hello World'])).toBe(true);
                expect(_.some(result.messages, ['content', 'HELLO again'])).toBe(true);
            });

            test('should include query in response metadata', async () => {
                const result = await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                    query:     'test query',
                });

                expect(result.metadata.query).toBe('test query');
            });

            test('should return all messages when no query provided', async () => {
                const messages = [
                    createMockSearchResult({ id: '100000000000000001', content: 'First' }),
                    createMockSearchResult({ id: '100000000000000002', content: 'Second' }),
                ];

                (mockFetcher.fetchMessages as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages,
                        hasMore: false,
                    })
                );

                const result = await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                });

                expect(result.messages).toHaveLength(2);
                expect(result.metadata.query).toBeUndefined();
            });

            test.each([
                {
                    description: 'when query is undefined',
                    query:       undefined,
                    messages:    [
                        { id: '100000000000000001', content: 'apple' },
                        { id: '100000000000000002', content: 'banana' },
                        { id: '100000000000000003', content: 'cherry' },
                        { id: '100000000000000004', content: 'date' },
                    ],
                },
                {
                    description: 'when query is empty string',
                    query:       '',
                    messages:    [
                        { id: '100000000000000001', content: 'alpha' },
                        { id: '100000000000000002', content: 'beta' },
                        { id: '100000000000000003', content: 'gamma' },
                    ],
                },
            ])('should NOT filter messages $description - all messages returned unfiltered', async ({ query, messages }) => {
                const fetchedMessages = _.map(messages, m => createMockSearchResult(m));

                (mockFetcher.fetchMessages as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages: fetchedMessages,
                        hasMore:  false,
                    })
                );

                const result = await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                    query,
                    limit:     100,
                });

                expect(result.messages).toHaveLength(messages.length);
                // eslint-disable-next-line lodash/prefer-lodash-method -- _.forEach breaks TypeScript inference with test.each union types
                messages.forEach((msg, idx) => {
                    expect(result.messages[idx].content).toBe(msg.content);
                });
                if(query === '') {
                    expect(result.metadata.query).toBe('');
                }
            });
        });

        describe('limit and overflow handling', () => {
            test('should respect limit parameter', async () => {
                const messages = _.times(15, i =>
                    createMockSearchResult({
                        id:      `10000000000000000${i}`,
                        content: `Message ${i}`,
                    })
                );

                (mockFetcher.fetchMessages as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages,
                        hasMore: false,
                    })
                );

                const result = await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                    limit:     5,
                });

                expect(result.messages).toHaveLength(5);
            });

            test('should use default limit of 10 when not specified', async () => {
                const messages = _.times(15, i =>
                    createMockSearchResult({
                        id:      `10000000000000000${i}`,
                        content: `Message ${i}`,
                    })
                );

                (mockFetcher.fetchMessages as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages,
                        hasMore: false,
                    })
                );

                const result = await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                });

                expect(result.messages).toHaveLength(10);
            });

            test('should allow custom default limit via options', async () => {
                const customService = createMessageSearchService({
                    fetcher:      mockFetcher,
                    summarizer:   mockSummarizer,
                    defaultLimit: 5,
                });

                const messages = _.times(15, i =>
                    createMockSearchResult({
                        id:      `10000000000000000${i}`,
                        content: `Message ${i}`,
                    })
                );

                (mockFetcher.fetchMessages as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages,
                        hasMore: false,
                    })
                );

                const result = await customService.searchMessages({
                    channelId: createChannelId(testChannelId),
                });

                expect(result.messages).toHaveLength(5);
            });

            test('should generate overflow batch summaries for messages beyond limit', async () => {
                const messages = _.times(15, i =>
                    createMockSearchResult({
                        id:      `10000000000000000${i}`,
                        content: `Message ${i}`,
                    })
                );

                (mockFetcher.fetchMessages as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages,
                        hasMore: false,
                    })
                );

                (mockSummarizer.summarizeMessageBatch as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve([{
                        startTimestamp: '2025-01-15T12:00:00.000Z',
                        endTimestamp:   '2025-01-15T12:05:00.000Z',
                        messageCount:   5,
                        authors:        ['testuser'],
                        synopsis:       'Batch summary',
                    }])
                );

                const result = await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                    limit:     10,
                });

                expect(result.overflow).toBeDefined();
                expect(result.overflow!.count).toBe(5);
                expect(result.overflow!.batchSummaries).toBeDefined();
                expect(mockSummarizer.summarizeMessageBatch).toHaveBeenCalled();
            });

            test('should include totalFound in metadata', async () => {
                const messages = _.times(15, i =>
                    createMockSearchResult({
                        id:      `10000000000000000${i}`,
                        content: `Message ${i}`,
                    })
                );

                (mockFetcher.fetchMessages as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages,
                        hasMore: false,
                    })
                );

                const result = await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                    limit:     5,
                });

                expect(result.metadata.totalFound).toBe(15);
            });

            test('should not have overflow when messages are within limit', async () => {
                const messages = _.times(5, i =>
                    createMockSearchResult({
                        id:      `10000000000000000${i}`,
                        content: `Message ${i}`,
                    })
                );

                (mockFetcher.fetchMessages as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages,
                        hasMore: false,
                    })
                );

                const result = await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                    limit:     10,
                });

                expect(result.overflow).toBeUndefined();
            });

            test.each([
                {
                    description:    'when message count equals limit exactly',
                    messageCount:   10,
                    limit:          10,
                    expectOverflow: false,
                },
                {
                    description:           'when message count is one more than limit',
                    messageCount:          11,
                    limit:                 10,
                    expectOverflow:        true,
                    expectedOverflowCount: 1,
                },
            ])('should handle overflow boundary $description', async ({ messageCount, limit, expectOverflow, expectedOverflowCount }) => {
                const messages = _.times(messageCount, i =>
                    createMockSearchResult({
                        id:      `10000000000000000${i}`,
                        content: `Message ${i}`,
                    })
                );

                (mockFetcher.fetchMessages as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages,
                        hasMore: false,
                    })
                );

                if(expectOverflow) {
                    (mockSummarizer.summarizeMessageBatch as ReturnType<typeof mock>).mockImplementation(() =>
                        Promise.resolve([{
                            startTimestamp: '2025-01-15T12:00:00.000Z',
                            endTimestamp:   '2025-01-15T12:05:00.000Z',
                            messageCount:   1,
                            authors:        ['testuser'],
                            synopsis:       'Batch summary',
                        }])
                    );
                }

                const result = await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                    limit,
                });

                expect(result.messages).toHaveLength(limit);
                if(expectOverflow) {
                    expect(result.overflow).toBeDefined();
                    expect(result.overflow!.count).toBe(expectedOverflowCount);
                    expect(mockSummarizer.summarizeMessageBatch).toHaveBeenCalled();
                } else {
                    expect(result.overflow).toBeUndefined();
                    expect(mockSummarizer.summarizeMessageBatch).not.toHaveBeenCalled();
                }
            });
        });

        describe('batch overflow summarization', () => {
            test('should call summarizeMessageBatch instead of summarizeMessages for overflow', async () => {
                const messages = _.times(15, i =>
                    createMockSearchResult({
                        id:      `10000000000000000${i}`,
                        content: `Message ${i}`,
                    })
                );

                (mockFetcher.fetchMessages as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages,
                        hasMore: false,
                    })
                );

                (mockSummarizer.summarizeMessageBatch as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve([{
                        startTimestamp: '2025-01-15T12:00:00.000Z',
                        endTimestamp:   '2025-01-15T12:05:00.000Z',
                        messageCount:   5,
                        authors:        ['testuser'],
                        synopsis:       'Batch summary',
                    }])
                );

                const result = await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                    limit:     10,
                });

                expect(result.overflow).toBeDefined();
                expect(result.overflow!.batchSummaries).toBeDefined();
                expect(mockSummarizer.summarizeMessageBatch).toHaveBeenCalled();
                expect(mockSummarizer.summarizeMessages).not.toHaveBeenCalled();
            });

            test('should cap overflow at 100 messages for batch summarization', async () => {
                const messages = _.times(150, i =>
                    createMockSearchResult({
                        id:      `10000000000000000${i}`,
                        content: `Message ${i}`,
                    })
                );

                (mockFetcher.fetchMessages as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages,
                        hasMore: false,
                    })
                );

                (mockSummarizer.summarizeMessageBatch as ReturnType<typeof mock>).mockImplementation((msgs: any[]) =>
                    Promise.resolve([{
                        startTimestamp: '2025-01-15T12:00:00.000Z',
                        endTimestamp:   '2025-01-15T12:05:00.000Z',
                        messageCount:   msgs.length,
                        authors:        ['testuser'],
                        synopsis:       'Batch summary',
                    }])
                );

                const result = await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                    limit:     10,
                });

                expect(result.overflow).toBeDefined();
                expect(result.overflow!.count).toBe(140); // 150 - 10
                expect(result.overflow!.hasMore).toBe(true);
                expect(result.overflow!.hint).toBeDefined();

                // Summarizer should receive at most 100 messages
                const batchCall = (mockSummarizer.summarizeMessageBatch as ReturnType<typeof mock>).mock.calls[0];
                expect(batchCall[0]).toHaveLength(100);
            });

            test('should not set hasMore when overflow is within cap', async () => {
                const messages = _.times(50, i =>
                    createMockSearchResult({
                        id:      `10000000000000000${i}`,
                        content: `Message ${i}`,
                    })
                );

                (mockFetcher.fetchMessages as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages,
                        hasMore: false,
                    })
                );

                (mockSummarizer.summarizeMessageBatch as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve([{
                        startTimestamp: '2025-01-15T12:00:00.000Z',
                        endTimestamp:   '2025-01-15T12:05:00.000Z',
                        messageCount:   40,
                        authors:        ['testuser'],
                        synopsis:       'Batch summary',
                    }])
                );

                const result = await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                    limit:     10,
                });

                expect(result.overflow).toBeDefined();
                expect(result.overflow!.hasMore).toBeUndefined();
                expect(result.overflow!.hint).toBeUndefined();
            });

            test('should not set hasMore when overflow is exactly MAX_OVERFLOW_FOR_SUMMARY (100)', async () => {
                // 110 messages with limit 10 = exactly 100 overflow
                const messages = _.times(110, i =>
                    createMockSearchResult({
                        id:      `10000000000000000${i}`,
                        content: `Message ${i}`,
                    })
                );

                (mockFetcher.fetchMessages as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages,
                        hasMore: false,
                    })
                );

                (mockSummarizer.summarizeMessageBatch as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve([{
                        startTimestamp: '2025-01-15T12:00:00.000Z',
                        endTimestamp:   '2025-01-15T12:05:00.000Z',
                        messageCount:   100,
                        authors:        ['testuser'],
                        synopsis:       'Batch summary',
                    }])
                );

                const result = await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                    limit:     10,
                });

                expect(result.overflow).toBeDefined();
                expect(result.overflow!.count).toBe(100);
                expect(result.overflow!.hasMore).toBeUndefined();
                expect(result.overflow!.hint).toBeUndefined();
                expect(result.overflow!.batchSummaries).toBeDefined();
            });

            test('should set hasMore when overflow is exactly one more than cap (101)', async () => {
                // 111 messages with limit 10 = 101 overflow (just over cap)
                const messages = _.times(111, i =>
                    createMockSearchResult({
                        id:      `10000000000000000${i}`,
                        content: `Message ${i}`,
                    })
                );

                (mockFetcher.fetchMessages as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages,
                        hasMore: false,
                    })
                );

                (mockSummarizer.summarizeMessageBatch as ReturnType<typeof mock>).mockImplementation((msgs: any[]) =>
                    Promise.resolve([{
                        startTimestamp: '2025-01-15T12:00:00.000Z',
                        endTimestamp:   '2025-01-15T12:05:00.000Z',
                        messageCount:   msgs.length,
                        authors:        ['testuser'],
                        synopsis:       'Batch summary',
                    }])
                );

                const result = await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                    limit:     10,
                });

                expect(result.overflow).toBeDefined();
                expect(result.overflow!.count).toBe(101);
                expect(result.overflow!.hasMore).toBe(true);
                expect(result.overflow!.hint).toBeDefined();

                // Should cap at 100 messages sent to summarizer
                const batchCall = (mockSummarizer.summarizeMessageBatch as ReturnType<typeof mock>).mock.calls[0];
                expect(batchCall[0]).toHaveLength(100);
            });
        });

        describe('message ordering', () => {
            test('should return messages sorted chronologically (oldest first)', async () => {
                // Create messages in random order
                const messages = [
                    createMockSearchResult({ id: '100000000000000003', content: 'Third' }),
                    createMockSearchResult({ id: '100000000000000001', content: 'First' }),
                    createMockSearchResult({ id: '100000000000000002', content: 'Second' }),
                ];

                (mockFetcher.fetchMessages as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages,
                        hasMore: false,
                    })
                );

                const result = await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                });

                expect(result.messages[0].content).toBe('First');
                expect(result.messages[1].content).toBe('Second');
                expect(result.messages[2].content).toBe('Third');
            });
        });

        describe('empty results', () => {
            test('should return empty array when no messages found', async () => {
                const result = await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                });

                expect(result.messages).toHaveLength(0);
                expect(result.overflow).toBeUndefined();
                expect(result.metadata.totalFound).toBe(0);
            });

            test('should return empty array when query matches nothing', async () => {
                const messages = [
                    createMockSearchResult({ id: '100000000000000001', content: 'Hello World' }),
                ];

                (mockFetcher.fetchMessages as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages,
                        hasMore: false,
                    })
                );

                const result = await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                    query:     'nonexistent',
                });

                expect(result.messages).toHaveLength(0);
                expect(result.metadata.totalFound).toBe(0);
            });
        });

        describe('error propagation', () => {
            test('should propagate fetcher errors', async () => {
                (mockFetcher.fetchMessages as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.reject(new Error('Fetcher error'))
                );

                expect(
                    service.searchMessages({ channelId: createChannelId(testChannelId) })
                ).rejects.toThrow('Fetcher error');
            });

            test('should propagate summarizer errors', async () => {
                const messages = _.times(15, i =>
                    createMockSearchResult({
                        id:      `10000000000000000${i}`,
                        content: `Message ${i}`,
                    })
                );

                (mockFetcher.fetchMessages as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages,
                        hasMore: false,
                    })
                );

                (mockSummarizer.summarizeMessageBatch as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.reject(new Error('Summarizer error'))
                );

                expect(
                    service.searchMessages({
                        channelId: createChannelId(testChannelId),
                        limit:     5,
                    })
                ).rejects.toThrow('Summarizer error');
            });
        });
    });

    describe('getRecentMessages', () => {
        test.each([
            { description: 'with limit parameter', limit: 5, expectedLength: 5 },
            { description: 'with default limit', limit: undefined, expectedLength: 10 },
        ])('should respect limit $description', async ({ limit, expectedLength }) => {
            const messages = _.times(20, i =>
                createMockSearchResult({
                    id:      `10000000000000000${i}`,
                    content: `Message ${i}`,
                })
            );

            (mockFetcher.fetchMessages as ReturnType<typeof mock>).mockImplementation(() =>
                Promise.resolve({
                    messages,
                    hasMore: false,
                })
            );

            const result = limit !== undefined
                ? await service.getRecentMessages(testChannelId, limit)
                : await service.getRecentMessages(testChannelId);

            expect(result.messages).toHaveLength(expectedLength);
        });

        test('should not call summarizer for overflow (count-only)', async () => {
            const messages = _.times(20, i =>
                createMockSearchResult({
                    id:      `10000000000000000${i}`,
                    content: `Message ${i}`,
                })
            );

            (mockFetcher.fetchMessages as ReturnType<typeof mock>).mockImplementation(() =>
                Promise.resolve({
                    messages,
                    hasMore: false,
                })
            );

            const result = await service.getRecentMessages(testChannelId, 5);

            expect(result.messages).toHaveLength(5);
            expect(result.overflow).toBeDefined();
            expect(result.overflow!.count).toBe(15);
            expect(result.overflow!.summaries).toBeUndefined();
            expect(result.overflow!.batchSummaries).toBeUndefined();
            expect(result.overflow!.hint).toBeDefined();
            expect(mockSummarizer.summarizeMessages).not.toHaveBeenCalled();
            expect(mockSummarizer.summarizeMessageBatch).not.toHaveBeenCalled();
        });

        test('should pass fetchLimit to fetcher', async () => {
            await service.getRecentMessages(testChannelId, 5);

            const fetcherCall = (mockFetcher.fetchMessages as ReturnType<typeof mock>).mock.calls[0][0];
            expect(fetcherCall.limit).toBe(55); // 5 + 50
        });

        test('should use default limit for fetchLimit calculation', async () => {
            await service.getRecentMessages(testChannelId);

            const fetcherCall = (mockFetcher.fetchMessages as ReturnType<typeof mock>).mock.calls[0][0];
            expect(fetcherCall.limit).toBe(60); // 10 (default) + 50
        });
    });

    describe('getMessageById', () => {
        test('should propagate fetcher errors', async () => {
            (mockFetcher.fetchById as ReturnType<typeof mock>).mockImplementation(() =>
                Promise.reject(new Error('Fetch error'))
            );

            expect(
                service.getMessageById(testChannelId, '100000000000000000')
            ).rejects.toThrow('Fetch error');
        });
    });

    describe('getMessagesById', () => {
        test('should propagate fetcher errors', async () => {
            (mockFetcher.fetchByIds as ReturnType<typeof mock>).mockImplementation(() =>
                Promise.reject(new Error('Batch fetch error'))
            );

            expect(
                service.getMessagesById(testChannelId, ['100000000000000001'])
            ).rejects.toThrow('Batch fetch error');
        });
    });
});
