/* eslint-disable @typescript-eslint/no-explicit-any -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Test mocks */
/* eslint-disable @typescript-eslint/unbound-method -- Mock methods */
/* eslint-disable @typescript-eslint/await-thenable -- expect().rejects returns a promise */

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import _ from 'lodash';
import {
    createMessageSearchService,
    type MessageSearchService
} from '@/integrations/discord/message-history/search';
import type { DiscordSearchResult } from '@/integrations/discord/message-history/types';
import { createChannelId } from '@/integrations/discord/types';
import { timestampToSnowflake, snowflakeToTimestamp } from '@/integrations/discord/message-history/snowflake';
import type { MessageFetcher } from '@/integrations/discord/message-history/fetcher';
import type { MessageCache } from '@/storage/message-cache/cache';
import type { MessageSummarizer } from '@/integrations/discord/message-history/summarizer';
import type { CachedMessage, CacheGap, MessageId } from '@/storage/message-cache/types';
import { createMessageId } from '@/storage/message-cache/types';

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

/**
 * Creates a mock cached message for testing.
 */
function createMockCachedMessage(overrides: Partial<{
    id:        string
    content:   string
    authorId:  string
    timestamp: string
}> = {}): CachedMessage {
    return {
        id:        createMessageId(overrides.id ?? '100000000000000000'),
        content:   overrides.content ?? 'Cached message content',
        authorId:  overrides.authorId ?? '111111111111111111',
        timestamp: overrides.timestamp ?? '2025-01-15T12:00:00.000Z',
    };
}

describe('createMessageSearchService', () => {
    let mockFetcher: MessageFetcher;
    let mockCache: MessageCache;
    let mockSummarizer: MessageSummarizer;
    let service: MessageSearchService;

    const testChannelId = '123456789012345678';

    beforeEach(() => {
        mockFetcher = {
            fetchMessages: mock(() => Promise.resolve({ messages: [], hasMore: false })),
            fetchById:     mock(() => Promise.resolve(null)),
        };

        mockCache = {
            getMessagesInRange: mock(() => Promise.resolve({ messages: [], gaps: [], fullyResolved: true })),
            storeMessages:      mock(() => Promise.resolve({} as any)),
            findGaps:           mock(() => Promise.resolve([])),
            isRangeFullyCached: mock(() => Promise.resolve(true)),
            listSegments:       mock(() => Promise.resolve([])),
            deleteSegment:      mock(() => Promise.resolve()),
            clearChannel:       mock(() => Promise.resolve(0)),
        } as unknown as MessageCache;

        mockSummarizer = {
            summarizeMessages: mock(() => Promise.resolve([])),
        };

        service = createMessageSearchService({
            fetcher:    mockFetcher,
            cache:      mockCache,
            summarizer: mockSummarizer,
        });
    });

    describe('searchMessages', () => {
        describe('cache behavior', () => {
            it('should return cached messages when cache is fully resolved', async () => {
                const cachedMessage = createMockCachedMessage({
                    id:        '100000000000000001',
                    content:   'Cached content',
                    timestamp: '2025-01-15T12:00:00.000Z',
                });

                (mockCache.getMessagesInRange as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages:      [cachedMessage],
                        gaps:          [],
                        fullyResolved: true,
                    })
                );

                const result = await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                });

                expect(result.messages).toHaveLength(1);
                expect(result.messages[0].content).toBe('Cached content');
                expect(mockFetcher.fetchMessages).not.toHaveBeenCalled();
            });

            it('should fetch from Discord API when cache has gaps', async () => {
                const startTime = new Date('2025-01-10T00:00:00.000Z');
                const endTime = new Date('2025-01-15T00:00:00.000Z');
                const gapStart = timestampToSnowflake(startTime);
                const gapEnd = timestampToSnowflake(endTime);

                const gap: CacheGap = {
                    start: createMessageId(gapStart),
                    end:   createMessageId(gapEnd),
                };

                (mockCache.getMessagesInRange as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages:      [],
                        gaps:          [gap],
                        fullyResolved: false,
                    })
                );

                const fetchedMessage = createMockSearchResult({
                    id:        gapStart,
                    content:   'Fetched content',
                    timestamp: startTime.toISOString(),
                });

                (mockFetcher.fetchMessages as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages: [fetchedMessage],
                        hasMore:  false,
                    })
                );

                const result = await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                    startTime,
                    endTime,
                });

                expect(mockFetcher.fetchMessages).toHaveBeenCalled();
                expect(mockFetcher.fetchMessages).toHaveBeenCalledWith({
                    channelId: createChannelId(testChannelId),
                    startTime: expect.any(Date),
                    endTime:   expect.any(Date),
                });
                expect(result.messages).toHaveLength(1);
                expect(result.messages[0].content).toBe('Fetched content');
            });

            it('should merge cached and fetched messages for partial cache hits', async () => {
                const now = new Date('2025-01-20T00:00:00.000Z');
                const cachedTime = new Date('2025-01-15T00:00:00.000Z');
                const gapStartTime = new Date('2025-01-10T00:00:00.000Z');
                const gapEndTime = new Date('2025-01-14T00:00:00.000Z');

                const cachedSnowflake = timestampToSnowflake(cachedTime);
                const gapStart = timestampToSnowflake(gapStartTime);
                const gapEnd = timestampToSnowflake(gapEndTime);

                const cachedMessage = createMockCachedMessage({
                    id:        cachedSnowflake,
                    content:   'Cached message',
                    timestamp: cachedTime.toISOString(),
                });

                const gap: CacheGap = {
                    start: createMessageId(gapStart),
                    end:   createMessageId(gapEnd),
                };

                (mockCache.getMessagesInRange as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages:      [cachedMessage],
                        gaps:          [gap],
                        fullyResolved: false,
                    })
                );

                const fetchedMessage = createMockSearchResult({
                    id:        gapStart,
                    content:   'Fetched message',
                    timestamp: gapStartTime.toISOString(),
                });

                (mockFetcher.fetchMessages as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages: [fetchedMessage],
                        hasMore:  false,
                    })
                );

                const result = await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                    startTime: gapStartTime,
                    endTime:   now,
                });

                expect(result.messages).toHaveLength(2);
                // Messages should be sorted chronologically (oldest first)
                expect(result.messages[0].content).toBe('Fetched message');
                expect(result.messages[1].content).toBe('Cached message');
            });

            it('should cache fetched messages when gap end time is in the past', async () => {
                const now = new Date();
                const pastTime = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000); // 2 days ago
                const olderTime = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000); // 5 days ago

                const gapStart = timestampToSnowflake(olderTime);
                const gapEnd = timestampToSnowflake(pastTime);

                const gap: CacheGap = {
                    start: createMessageId(gapStart),
                    end:   createMessageId(gapEnd),
                };

                (mockCache.getMessagesInRange as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages:      [],
                        gaps:          [gap],
                        fullyResolved: false,
                    })
                );

                const fetchedMessage = createMockSearchResult({
                    id:        gapStart,
                    timestamp: olderTime.toISOString(),
                });

                (mockFetcher.fetchMessages as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages: [fetchedMessage],
                        hasMore:  false,
                    })
                );

                await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                    startTime: olderTime,
                    endTime:   pastTime,
                });

                expect(mockCache.storeMessages).toHaveBeenCalled();
            });

            it('should NOT cache fetched messages when gap end time is now or in the future', async () => {
                const now = new Date();
                const futureTime = new Date(now.getTime() + 1000); // 1 second in the future
                const pastTime = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 1 day ago

                const gapStart = timestampToSnowflake(pastTime);
                const gapEnd = timestampToSnowflake(futureTime);

                const gap: CacheGap = {
                    start: createMessageId(gapStart),
                    end:   createMessageId(gapEnd),
                };

                (mockCache.getMessagesInRange as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages:      [],
                        gaps:          [gap],
                        fullyResolved: false,
                    })
                );

                const fetchedMessage = createMockSearchResult({
                    id:        gapStart,
                    timestamp: pastTime.toISOString(),
                });

                (mockFetcher.fetchMessages as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages: [fetchedMessage],
                        hasMore:  false,
                    })
                );

                await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                    startTime: pastTime,
                    endTime:   futureTime,
                });

                expect(mockCache.storeMessages).not.toHaveBeenCalled();
            });

            it('should NOT cache fetched messages when gap end time equals now exactly (boundary test)', async () => {
                // Tests: gapEndTime < now
                // When gapEndTime === now, condition is false, so should NOT cache
                const now = new Date();
                const pastTime = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 1 day ago

                const gapStart = timestampToSnowflake(pastTime);
                const gapEnd = timestampToSnowflake(now); // exactly now

                const gap: CacheGap = {
                    start: createMessageId(gapStart),
                    end:   createMessageId(gapEnd),
                };

                (mockCache.getMessagesInRange as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages:      [],
                        gaps:          [gap],
                        fullyResolved: false,
                    })
                );

                const fetchedMessage = createMockSearchResult({
                    id:        gapStart,
                    timestamp: pastTime.toISOString(),
                });

                (mockFetcher.fetchMessages as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages: [fetchedMessage],
                        hasMore:  false,
                    })
                );

                await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                    startTime: pastTime,
                    endTime:   now, // exactly now
                });

                // Should NOT cache because gapEndTime is not strictly less than now
                expect(mockCache.storeMessages).not.toHaveBeenCalled();
            });
        });

        describe('time range handling', () => {
            it('should use default time range of 7 days when not specified', async () => {
                await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                });

                const cacheCall = (mockCache.getMessagesInRange as ReturnType<typeof mock>).mock.calls[0];
                const startSnowflake = cacheCall[1] as MessageId;
                const endSnowflake = cacheCall[2] as MessageId;

                const startTime = snowflakeToTimestamp(startSnowflake);
                const endTime = snowflakeToTimestamp(endSnowflake);

                const now = new Date();
                const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

                // Allow 1 second tolerance for test execution time
                expect(Math.abs(endTime.getTime() - now.getTime())).toBeLessThan(1000);
                expect(Math.abs(startTime.getTime() - sevenDaysAgo.getTime())).toBeLessThan(1000);
            });

            it('should use provided startTime and endTime', async () => {
                const startTime = new Date('2025-01-01T00:00:00.000Z');
                const endTime = new Date('2025-01-10T00:00:00.000Z');

                await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                    startTime,
                    endTime,
                });

                const cacheCall = (mockCache.getMessagesInRange as ReturnType<typeof mock>).mock.calls[0];
                const startSnowflake = cacheCall[1] as MessageId;
                const endSnowflake = cacheCall[2] as MessageId;

                const resultStart = snowflakeToTimestamp(startSnowflake);
                const resultEnd = snowflakeToTimestamp(endSnowflake);

                expect(resultStart.getTime()).toBe(startTime.getTime());
                expect(resultEnd.getTime()).toBe(endTime.getTime());
            });

            it('should include time range in response metadata', async () => {
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

            it('should allow custom default time range via options', async () => {
                const customService = createMessageSearchService({
                    fetcher:              mockFetcher,
                    cache:                mockCache,
                    summarizer:           mockSummarizer,
                    defaultTimeRangeDays: 3,
                });

                await customService.searchMessages({
                    channelId: createChannelId(testChannelId),
                });

                const cacheCall = (mockCache.getMessagesInRange as ReturnType<typeof mock>).mock.calls[0];
                const startSnowflake = cacheCall[1] as MessageId;
                const endSnowflake = cacheCall[2] as MessageId;

                const startTime = snowflakeToTimestamp(startSnowflake);
                const endTime = snowflakeToTimestamp(endSnowflake);

                const diffDays = (endTime.getTime() - startTime.getTime()) / (24 * 60 * 60 * 1000);
                expect(Math.abs(diffDays - 3)).toBeLessThan(0.01);
            });
        });

        describe('text query filtering', () => {
            it('should filter messages by text query (case-insensitive)', async () => {
                const messages = [
                    createMockCachedMessage({ id: '100000000000000001', content: 'Hello World' }),
                    createMockCachedMessage({ id: '100000000000000002', content: 'Goodbye World' }),
                    createMockCachedMessage({ id: '100000000000000003', content: 'HELLO again' }),
                ];

                (mockCache.getMessagesInRange as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages,
                        gaps:          [],
                        fullyResolved: true,
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

            it('should include query in response metadata', async () => {
                const result = await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                    query:     'test query',
                });

                expect(result.metadata.query).toBe('test query');
            });

            it('should return all messages when no query provided', async () => {
                const messages = [
                    createMockCachedMessage({ id: '100000000000000001', content: 'First' }),
                    createMockCachedMessage({ id: '100000000000000002', content: 'Second' }),
                ];

                (mockCache.getMessagesInRange as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages,
                        gaps:          [],
                        fullyResolved: true,
                    })
                );

                const result = await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                });

                expect(result.messages).toHaveLength(2);
                expect(result.metadata.query).toBeUndefined();
            });

            it('should NOT filter messages when query is undefined - all messages returned unfiltered', async () => {
                // This test explicitly verifies that without a query, NO filtering occurs
                // even when message content would NOT match any search term
                const messages = [
                    createMockCachedMessage({ id: '100000000000000001', content: 'apple' }),
                    createMockCachedMessage({ id: '100000000000000002', content: 'banana' }),
                    createMockCachedMessage({ id: '100000000000000003', content: 'cherry' }),
                    createMockCachedMessage({ id: '100000000000000004', content: 'date' }),
                ];

                (mockCache.getMessagesInRange as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages,
                        gaps:          [],
                        fullyResolved: true,
                    })
                );

                // Call without query parameter
                const result = await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                    limit:     100,  // High limit to get all messages
                });

                // ALL messages should be returned, not filtered
                expect(result.messages).toHaveLength(4);
                expect(result.messages[0].content).toBe('apple');
                expect(result.messages[1].content).toBe('banana');
                expect(result.messages[2].content).toBe('cherry');
                expect(result.messages[3].content).toBe('date');
            });
        });

        describe('limit and overflow handling', () => {
            it('should respect limit parameter', async () => {
                const messages = _.times(15, i =>
                    createMockCachedMessage({
                        id:      `10000000000000000${i}`,
                        content: `Message ${i}`,
                    })
                );

                (mockCache.getMessagesInRange as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages,
                        gaps:          [],
                        fullyResolved: true,
                    })
                );

                const result = await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                    limit:     5,
                });

                expect(result.messages).toHaveLength(5);
            });

            it('should use default limit of 10 when not specified', async () => {
                const messages = _.times(15, i =>
                    createMockCachedMessage({
                        id:      `10000000000000000${i}`,
                        content: `Message ${i}`,
                    })
                );

                (mockCache.getMessagesInRange as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages,
                        gaps:          [],
                        fullyResolved: true,
                    })
                );

                const result = await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                });

                expect(result.messages).toHaveLength(10);
            });

            it('should allow custom default limit via options', async () => {
                const customService = createMessageSearchService({
                    fetcher:      mockFetcher,
                    cache:        mockCache,
                    summarizer:   mockSummarizer,
                    defaultLimit: 5,
                });

                const messages = _.times(15, i =>
                    createMockCachedMessage({
                        id:      `10000000000000000${i}`,
                        content: `Message ${i}`,
                    })
                );

                (mockCache.getMessagesInRange as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages,
                        gaps:          [],
                        fullyResolved: true,
                    })
                );

                const result = await customService.searchMessages({
                    channelId: createChannelId(testChannelId),
                });

                expect(result.messages).toHaveLength(5);
            });

            it('should generate overflow summaries for messages beyond limit', async () => {
                const messages = _.times(15, i =>
                    createMockCachedMessage({
                        id:      `10000000000000000${i}`,
                        content: `Message ${i}`,
                    })
                );

                (mockCache.getMessagesInRange as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages,
                        gaps:          [],
                        fullyResolved: true,
                    })
                );

                (mockSummarizer.summarizeMessages as ReturnType<typeof mock>).mockImplementation((msgs: any[]) =>
                    Promise.resolve(
                        _.map(msgs, (m: any) => ({
                            id:        m.id,
                            timestamp: m.timestamp,
                            author:    m.author?.username ?? 'unknown',
                            synopsis:  `Summary of ${m.content}`,
                        }))
                    )
                );

                const result = await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                    limit:     10,
                });

                expect(result.overflow).toBeDefined();
                expect(result.overflow!.count).toBe(5);
                expect(result.overflow!.summaries).toHaveLength(5);
            });

            it('should include totalFound in metadata', async () => {
                const messages = _.times(15, i =>
                    createMockCachedMessage({
                        id:      `10000000000000000${i}`,
                        content: `Message ${i}`,
                    })
                );

                (mockCache.getMessagesInRange as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages,
                        gaps:          [],
                        fullyResolved: true,
                    })
                );

                const result = await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                    limit:     5,
                });

                expect(result.metadata.totalFound).toBe(15);
            });

            it('should not have overflow when messages are within limit', async () => {
                const messages = _.times(5, i =>
                    createMockCachedMessage({
                        id:      `10000000000000000${i}`,
                        content: `Message ${i}`,
                    })
                );

                (mockCache.getMessagesInRange as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages,
                        gaps:          [],
                        fullyResolved: true,
                    })
                );

                const result = await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                    limit:     10,
                });

                expect(result.overflow).toBeUndefined();
            });

            it('should NOT generate overflow when message count equals limit exactly (boundary test)', async () => {
                // Tests: allMessages.length > limit
                // When length === limit, condition is false, so NO overflow
                const messages = _.times(10, i =>
                    createMockCachedMessage({
                        id:      `10000000000000000${i}`,
                        content: `Message ${i}`,
                    })
                );

                (mockCache.getMessagesInRange as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages,
                        gaps:          [],
                        fullyResolved: true,
                    })
                );

                const result = await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                    limit:     10, // exactly 10 messages
                });

                expect(result.messages).toHaveLength(10);
                expect(result.overflow).toBeUndefined();
                expect(mockSummarizer.summarizeMessages).not.toHaveBeenCalled();
            });

            it('should generate overflow when message count is one more than limit (boundary test)', async () => {
                // Tests the boundary: length > limit
                // When length === limit + 1, condition is true, so overflow IS generated
                const messages = _.times(11, i =>
                    createMockCachedMessage({
                        id:      `10000000000000000${i}`,
                        content: `Message ${i}`,
                    })
                );

                (mockCache.getMessagesInRange as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages,
                        gaps:          [],
                        fullyResolved: true,
                    })
                );

                (mockSummarizer.summarizeMessages as ReturnType<typeof mock>).mockImplementation((msgs: DiscordSearchResult[]) =>
                    Promise.resolve(
                        _.map(msgs, (m: DiscordSearchResult) => ({
                            id:        m.id,
                            timestamp: m.timestamp,
                            author:    m.author?.username ?? 'unknown',
                            synopsis:  `Summary of ${m.content}`,
                        }))
                    )
                );

                const result = await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                    limit:     10, // 11 messages, limit 10 = 1 overflow
                });

                expect(result.messages).toHaveLength(10);
                expect(result.overflow).toBeDefined();
                expect(result.overflow!.count).toBe(1);
                expect(mockSummarizer.summarizeMessages).toHaveBeenCalled();
            });
        });

        describe('message ordering', () => {
            it('should return messages sorted chronologically (oldest first)', async () => {
                // Create messages in random order
                const messages = [
                    createMockCachedMessage({ id: '100000000000000003', content: 'Third' }),
                    createMockCachedMessage({ id: '100000000000000001', content: 'First' }),
                    createMockCachedMessage({ id: '100000000000000002', content: 'Second' }),
                ];

                (mockCache.getMessagesInRange as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages,
                        gaps:          [],
                        fullyResolved: true,
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
            it('should return empty array when no messages found', async () => {
                const result = await service.searchMessages({
                    channelId: createChannelId(testChannelId),
                });

                expect(result.messages).toHaveLength(0);
                expect(result.overflow).toBeUndefined();
                expect(result.metadata.totalFound).toBe(0);
            });

            it('should return empty array when query matches nothing', async () => {
                const messages = [
                    createMockCachedMessage({ id: '100000000000000001', content: 'Hello World' }),
                ];

                (mockCache.getMessagesInRange as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages,
                        gaps:          [],
                        fullyResolved: true,
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
            it('should propagate cache errors', async () => {
                (mockCache.getMessagesInRange as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.reject(new Error('Cache error'))
                );

                await expect(
                    service.searchMessages({ channelId: createChannelId(testChannelId) })
                ).rejects.toThrow('Cache error');
            });

            it('should propagate fetcher errors', async () => {
                const gap: CacheGap = {
                    start: createMessageId('100000000000000000'),
                    end:   createMessageId('100000000000000001'),
                };

                (mockCache.getMessagesInRange as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages:      [],
                        gaps:          [gap],
                        fullyResolved: false,
                    })
                );

                (mockFetcher.fetchMessages as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.reject(new Error('Fetcher error'))
                );

                await expect(
                    service.searchMessages({ channelId: createChannelId(testChannelId) })
                ).rejects.toThrow('Fetcher error');
            });

            it('should propagate summarizer errors', async () => {
                const messages = _.times(15, i =>
                    createMockCachedMessage({
                        id:      `10000000000000000${i}`,
                        content: `Message ${i}`,
                    })
                );

                (mockCache.getMessagesInRange as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.resolve({
                        messages,
                        gaps:          [],
                        fullyResolved: true,
                    })
                );

                (mockSummarizer.summarizeMessages as ReturnType<typeof mock>).mockImplementation(() =>
                    Promise.reject(new Error('Summarizer error'))
                );

                await expect(
                    service.searchMessages({
                        channelId: createChannelId(testChannelId),
                        limit:     5,
                    })
                ).rejects.toThrow('Summarizer error');
            });
        });
    });

    describe('getRecentMessages', () => {
        it('should call searchMessages with default parameters', async () => {
            const result = await service.getRecentMessages(testChannelId);

            expect(mockCache.getMessagesInRange).toHaveBeenCalled();
            expect(result.messages).toBeDefined();
            expect(result.metadata).toBeDefined();
        });

        it('should respect limit parameter', async () => {
            const messages = _.times(20, i =>
                createMockCachedMessage({
                    id:      `10000000000000000${i}`,
                    content: `Message ${i}`,
                })
            );

            (mockCache.getMessagesInRange as ReturnType<typeof mock>).mockImplementation(() =>
                Promise.resolve({
                    messages,
                    gaps:          [],
                    fullyResolved: true,
                })
            );

            const result = await service.getRecentMessages(testChannelId, 5);

            expect(result.messages).toHaveLength(5);
        });

        it('should use default limit when not specified', async () => {
            const messages = _.times(20, i =>
                createMockCachedMessage({
                    id:      `10000000000000000${i}`,
                    content: `Message ${i}`,
                })
            );

            (mockCache.getMessagesInRange as ReturnType<typeof mock>).mockImplementation(() =>
                Promise.resolve({
                    messages,
                    gaps:          [],
                    fullyResolved: true,
                })
            );

            const result = await service.getRecentMessages(testChannelId);

            expect(result.messages).toHaveLength(10);
        });

        it('should accept plain string channel ID', async () => {
            await service.getRecentMessages('999999999999999999');

            const cacheCall = (mockCache.getMessagesInRange as ReturnType<typeof mock>).mock.calls[0];
            expect(cacheCall[0]).toBe(createChannelId('999999999999999999'));
        });
    });

    describe('getMessageById', () => {
        it('should delegate to fetcher.fetchById', async () => {
            const mockMessage = createMockSearchResult({
                id:      '100000000000000000',
                content: 'Specific message',
            });

            (mockFetcher.fetchById as ReturnType<typeof mock>).mockImplementation(() =>
                Promise.resolve(mockMessage)
            );

            const result = await service.getMessageById(testChannelId, '100000000000000000');

            expect(mockFetcher.fetchById).toHaveBeenCalledWith(testChannelId, '100000000000000000');
            expect(result).toBe(mockMessage);
        });

        it('should return null when message not found', async () => {
            (mockFetcher.fetchById as ReturnType<typeof mock>).mockImplementation(() =>
                Promise.resolve(null)
            );

            const result = await service.getMessageById(testChannelId, 'nonexistent');

            expect(result).toBeNull();
        });

        it('should propagate fetcher errors', async () => {
            (mockFetcher.fetchById as ReturnType<typeof mock>).mockImplementation(() =>
                Promise.reject(new Error('Fetch error'))
            );

            await expect(
                service.getMessageById(testChannelId, '100000000000000000')
            ).rejects.toThrow('Fetch error');
        });
    });

    describe('cached message conversion', () => {
        it('should convert cached messages to DiscordSearchResult format', async () => {
            const cachedMessage = createMockCachedMessage({
                id:        '100000000000000001',
                content:   'Cached content',
                authorId:  '222222222222222222',
                timestamp: '2025-01-15T12:00:00.000Z',
            });

            (mockCache.getMessagesInRange as ReturnType<typeof mock>).mockImplementation(() =>
                Promise.resolve({
                    messages:      [cachedMessage],
                    gaps:          [],
                    fullyResolved: true,
                })
            );

            const result = await service.searchMessages({
                channelId: createChannelId(testChannelId),
            });

            const message = result.messages[0];
            expect(message.id).toBe('100000000000000001');
            expect(message.channelId).toBe(createChannelId(testChannelId));
            expect(message.content).toBe('Cached content');
            expect(message.author.id).toBe('222222222222222222');
            expect(message.timestamp).toBe('2025-01-15T12:00:00.000Z');
            // These should have default/empty values for cached messages
            expect(message.attachments).toEqual([]);
            expect(message.embeds).toEqual([]);
            expect(message.reactions).toEqual([]);
        });

        it('should convert DiscordSearchResult to CachedMessage when storing fetched messages', async () => {
            // This tests the convertSearchResultToCached function at line 122
            const now = new Date();
            const pastTime = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000); // 2 days ago
            const olderTime = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000); // 5 days ago

            const gapStart = timestampToSnowflake(olderTime);
            const gapEnd = timestampToSnowflake(pastTime);

            const gap: CacheGap = {
                start: createMessageId(gapStart),
                end:   createMessageId(gapEnd),
            };

            (mockCache.getMessagesInRange as ReturnType<typeof mock>).mockImplementation(() =>
                Promise.resolve({
                    messages:      [],
                    gaps:          [gap],
                    fullyResolved: false,
                })
            );

            const fetchedMessage = createMockSearchResult({
                id:                gapStart,
                content:           'Fetched message content',
                authorId:          '333333333333333333',
                authorUsername:    'testuser',
                authorDisplayName: 'Test User Display',
                timestamp:         olderTime.toISOString(),
            });

            (mockFetcher.fetchMessages as ReturnType<typeof mock>).mockImplementation(() =>
                Promise.resolve({
                    messages: [fetchedMessage],
                    hasMore:  false,
                })
            );

            await service.searchMessages({
                channelId: createChannelId(testChannelId),
                startTime: olderTime,
                endTime:   pastTime,
            });

            // Verify storeMessages was called with correctly converted CachedMessage
            expect(mockCache.storeMessages).toHaveBeenCalled();
            const storeCall = (mockCache.storeMessages as ReturnType<typeof mock>).mock.calls[0];
            const storedMessages = storeCall[3] as CachedMessage[];

            expect(storedMessages).toHaveLength(1);
            expect(storedMessages[0].id).toBe(createMessageId(gapStart));
            expect(storedMessages[0].content).toBe('Fetched message content');
            expect(storedMessages[0].authorId).toBe('333333333333333333');
            expect(storedMessages[0].timestamp).toBe(olderTime.toISOString());
        });

        it('should correctly map all fields when converting search result to cached', async () => {
            // Verify that convertSearchResultToCached correctly maps id, content, authorId, timestamp
            const now = new Date();
            const pastTime = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
            const olderTime = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);

            const gapStart = timestampToSnowflake(olderTime);
            const gapEnd = timestampToSnowflake(pastTime);

            const gap: CacheGap = {
                start: createMessageId(gapStart),
                end:   createMessageId(gapEnd),
            };

            (mockCache.getMessagesInRange as ReturnType<typeof mock>).mockImplementation(() =>
                Promise.resolve({
                    messages:      [],
                    gaps:          [gap],
                    fullyResolved: false,
                })
            );

            // Create a message with specific values to verify mapping
            const fetchedMessage = createMockSearchResult({
                id:        '123456789012345678',
                content:   'Specific content for testing',
                authorId:  '987654321098765432',
                timestamp: '2025-01-20T15:30:00.000Z',
            });

            (mockFetcher.fetchMessages as ReturnType<typeof mock>).mockImplementation(() =>
                Promise.resolve({
                    messages: [fetchedMessage],
                    hasMore:  false,
                })
            );

            await service.searchMessages({
                channelId: createChannelId(testChannelId),
                startTime: olderTime,
                endTime:   pastTime,
            });

            const storeCall = (mockCache.storeMessages as ReturnType<typeof mock>).mock.calls[0];
            const storedMessages = storeCall[3] as CachedMessage[];

            // Verify each field is correctly mapped
            const cached = storedMessages[0];
            expect(cached.id).toBe(createMessageId('123456789012345678'));
            expect(cached.content).toBe('Specific content for testing');
            expect(cached.authorId).toBe('987654321098765432');
            expect(cached.timestamp).toBe('2025-01-20T15:30:00.000Z');
        });
    });
});
