import _ from 'lodash';
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mockClient } from 'aws-sdk-client-mock';
import {
    DynamoDBDocumentClient,
    PutCommand,
    QueryCommand,
    DeleteCommand,
    BatchWriteCommand
} from '@aws-sdk/lib-dynamodb';
import { MessageCache } from '@/storage/message-cache/cache';
import type { MessageId, CachedSegmentItem, CachedMessage } from '@/storage/message-cache/types';
import type { ChannelId } from '@/integrations/discord/types';

describe('MessageCache', () => {
    let ddbMock: ReturnType<typeof mockClient>;
    let cache: MessageCache;

    const channelId = '123456789012345678' as ChannelId;

    beforeEach(() => {
        ddbMock = mockClient(DynamoDBDocumentClient);
        cache = new MessageCache(
            ddbMock as unknown as DynamoDBDocumentClient,
            'TestTable'
        );
    });

    afterEach(() => {
        ddbMock.restore();
    });

    describe('getMessagesInRange', () => {
        test('should return messages from cache when fully covered', async () => {
            const mockMessages: CachedMessage[] = [
                { id: '120' as MessageId, content: 'First', authorId: 'a', timestamp: '2024-01-15T10:00:00.000Z' },
                { id: '150' as MessageId, content: 'Second', authorId: 'a', timestamp: '2024-01-15T10:10:00.000Z' },
                { id: '180' as MessageId, content: 'Third', authorId: 'a', timestamp: '2024-01-15T10:20:00.000Z' },
            ];

            const mockItem: CachedSegmentItem = {
                PK:             'CHANNEL#123456789012345678',
                SK:             'SEGMENT#100#200',
                channelId,
                startSnowflake: '100' as MessageId,
                endSnowflake:   '200' as MessageId,
                messages:       mockMessages,
                fetchedAt:      '2024-01-15T10:30:00.000Z',
            };

            ddbMock.on(QueryCommand).resolves({ Items: [mockItem] });

            const result = await cache.getMessagesInRange(
                channelId,
                '100' as MessageId,
                '200' as MessageId
            );

            expect(result.messages).toHaveLength(3);
            expect(result.gaps).toHaveLength(0);
            expect(result.fullyResolved).toBe(true);
        });

        test('should identify gaps when cache is incomplete', async () => {
            const mockItem: CachedSegmentItem = {
                PK:             'CHANNEL#123456789012345678',
                SK:             'SEGMENT#130#170',
                channelId,
                startSnowflake: '130' as MessageId,
                endSnowflake:   '170' as MessageId,
                messages:       [
                    { id: '150' as MessageId, content: 'Middle', authorId: 'a', timestamp: '2024-01-15T10:10:00.000Z' },
                ],
                fetchedAt: '2024-01-15T10:30:00.000Z',
            };

            ddbMock.on(QueryCommand).resolves({ Items: [mockItem] });

            const result = await cache.getMessagesInRange(
                channelId,
                '100' as MessageId,
                '200' as MessageId
            );

            expect(result.messages).toHaveLength(1);
            expect(result.gaps).toHaveLength(2);
            expect(result.gaps[0].start).toBe('100' as MessageId);
            expect(result.gaps[0].end).toBe('129' as MessageId);
            expect(result.gaps[1].start).toBe('171' as MessageId);
            expect(result.gaps[1].end).toBe('200' as MessageId);
            expect(result.fullyResolved).toBe(false);
        });

        test('should return full range as gap when no cache exists', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await cache.getMessagesInRange(
                channelId,
                '100' as MessageId,
                '200' as MessageId
            );

            expect(result.messages).toHaveLength(0);
            expect(result.gaps).toHaveLength(1);
            expect(result.gaps[0].start).toBe('100' as MessageId);
            expect(result.gaps[0].end).toBe('200' as MessageId);
            expect(result.fullyResolved).toBe(false);
        });

        test('should merge messages from multiple overlapping segments', async () => {
            const mockItems: CachedSegmentItem[] = [
                {
                    PK:             'CHANNEL#123456789012345678',
                    SK:             'SEGMENT#100#150',
                    channelId,
                    startSnowflake: '100' as MessageId,
                    endSnowflake:   '150' as MessageId,
                    messages:       [
                        { id: '120' as MessageId, content: 'First', authorId: 'a', timestamp: '2024-01-15T10:00:00.000Z' },
                    ],
                    fetchedAt: '2024-01-15T10:30:00.000Z',
                },
                {
                    PK:             'CHANNEL#123456789012345678',
                    SK:             'SEGMENT#140#200',
                    channelId,
                    startSnowflake: '140' as MessageId,
                    endSnowflake:   '200' as MessageId,
                    messages:       [
                        { id: '180' as MessageId, content: 'Second', authorId: 'a', timestamp: '2024-01-15T10:20:00.000Z' },
                    ],
                    fetchedAt: '2024-01-15T10:35:00.000Z',
                },
            ];

            ddbMock.on(QueryCommand).resolves({ Items: mockItems });

            const result = await cache.getMessagesInRange(
                channelId,
                '100' as MessageId,
                '200' as MessageId
            );

            expect(result.messages).toHaveLength(2);
            expect(result.messages[0].id).toBe('120' as MessageId);
            expect(result.messages[1].id).toBe('180' as MessageId);
            expect(result.fullyResolved).toBe(true);
        });

        test('should deduplicate messages from overlapping segments', async () => {
            const mockItems: CachedSegmentItem[] = [
                {
                    PK:             'CHANNEL#123456789012345678',
                    SK:             'SEGMENT#100#160',
                    channelId,
                    startSnowflake: '100' as MessageId,
                    endSnowflake:   '160' as MessageId,
                    messages:       [
                        { id: '150' as MessageId, content: 'Duplicate', authorId: 'a', timestamp: '2024-01-15T10:10:00.000Z' },
                    ],
                    fetchedAt: '2024-01-15T10:30:00.000Z',
                },
                {
                    PK:             'CHANNEL#123456789012345678',
                    SK:             'SEGMENT#140#200',
                    channelId,
                    startSnowflake: '140' as MessageId,
                    endSnowflake:   '200' as MessageId,
                    messages:       [
                        { id: '150' as MessageId, content: 'Duplicate again', authorId: 'a', timestamp: '2024-01-15T10:10:00.000Z' },
                    ],
                    fetchedAt: '2024-01-15T10:35:00.000Z',
                },
            ];

            ddbMock.on(QueryCommand).resolves({ Items: mockItems });

            const result = await cache.getMessagesInRange(
                channelId,
                '100' as MessageId,
                '200' as MessageId
            );

            expect(result.messages).toHaveLength(1);
            expect(result.messages[0].id).toBe('150' as MessageId);
        });
    });

    describe('storeMessages', () => {
        test('should store messages as a segment', async () => {
            ddbMock.on(PutCommand).resolves({});

            const messages: CachedMessage[] = [
                { id: '120' as MessageId, content: 'First', authorId: 'a', timestamp: '2024-01-15T10:00:00.000Z' },
                { id: '180' as MessageId, content: 'Second', authorId: 'a', timestamp: '2024-01-15T10:20:00.000Z' },
            ];

            await cache.storeMessages(
                channelId,
                '100' as MessageId,
                '200' as MessageId,
                messages
            );

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(1);
            const item = calls[0].args[0].input.Item as CachedSegmentItem;
            expect(item.channelId).toBe(channelId);
            expect(item.startSnowflake).toBe('100' as MessageId);
            expect(item.endSnowflake).toBe('200' as MessageId);
            expect(item.messages).toHaveLength(2);
        });

        test('should store empty messages array', async () => {
            ddbMock.on(PutCommand).resolves({});

            await cache.storeMessages(
                channelId,
                '100' as MessageId,
                '200' as MessageId,
                []
            );

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(1);
            const item = calls[0].args[0].input.Item as CachedSegmentItem;
            expect(item.messages).toHaveLength(0);
        });
    });

    describe('findGaps', () => {
        test('should return gaps for uncached range', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const gaps = await cache.findGaps(
                channelId,
                '100' as MessageId,
                '200' as MessageId
            );

            expect(gaps).toHaveLength(1);
            expect(gaps[0].start).toBe('100' as MessageId);
            expect(gaps[0].end).toBe('200' as MessageId);
        });

        test('should return empty array when fully covered', async () => {
            const mockItem: CachedSegmentItem = {
                PK:             'CHANNEL#123456789012345678',
                SK:             'SEGMENT#50#250',
                channelId,
                startSnowflake: '50' as MessageId,
                endSnowflake:   '250' as MessageId,
                messages:       [],
                fetchedAt:      '2024-01-15T10:30:00.000Z',
            };

            ddbMock.on(QueryCommand).resolves({ Items: [mockItem] });

            const gaps = await cache.findGaps(
                channelId,
                '100' as MessageId,
                '200' as MessageId
            );

            expect(gaps).toHaveLength(0);
        });
    });

    describe('isRangeFullyCached', () => {
        test('should return true when range is fully covered', async () => {
            const mockItem: CachedSegmentItem = {
                PK:             'CHANNEL#123456789012345678',
                SK:             'SEGMENT#50#250',
                channelId,
                startSnowflake: '50' as MessageId,
                endSnowflake:   '250' as MessageId,
                messages:       [],
                fetchedAt:      '2024-01-15T10:30:00.000Z',
            };

            ddbMock.on(QueryCommand).resolves({ Items: [mockItem] });

            const isCached = await cache.isRangeFullyCached(
                channelId,
                '100' as MessageId,
                '200' as MessageId
            );

            expect(isCached).toBe(true);
        });

        test('should return false when range has gaps', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const isCached = await cache.isRangeFullyCached(
                channelId,
                '100' as MessageId,
                '200' as MessageId
            );

            expect(isCached).toBe(false);
        });
    });

    describe('listSegments', () => {
        test('should return segments from backend', async () => {
            // This tests the block at line 160-162
            const mockItems: CachedSegmentItem[] = [
                {
                    PK:             'CHANNEL#123456789012345678',
                    SK:             'SEGMENT#100#200',
                    channelId,
                    startSnowflake: '100' as MessageId,
                    endSnowflake:   '200' as MessageId,
                    messages:       [],
                    fetchedAt:      '2024-01-15T10:30:00.000Z',
                },
                {
                    PK:             'CHANNEL#123456789012345678',
                    SK:             'SEGMENT#300#400',
                    channelId,
                    startSnowflake: '300' as MessageId,
                    endSnowflake:   '400' as MessageId,
                    messages:       [],
                    fetchedAt:      '2024-01-15T10:35:00.000Z',
                },
            ];

            ddbMock.on(QueryCommand).resolves({ Items: mockItems });

            const result = await cache.listSegments(channelId);

            expect(result).toHaveLength(2);
            expect(result[0].startSnowflake).toBe('100' as MessageId);
            expect(result[1].startSnowflake).toBe('300' as MessageId);
        });

        test('should return empty array when no segments exist', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await cache.listSegments(channelId);

            expect(result).toHaveLength(0);
            expect(result).toEqual([]);
        });
    });

    describe('deleteSegment', () => {
        test('should call backend to delete segment', async () => {
            // This tests the block at line 175-177
            ddbMock.on(DeleteCommand).resolves({});

            await cache.deleteSegment(
                channelId,
                '100' as MessageId,
                '200' as MessageId
            );

            const calls = ddbMock.commandCalls(DeleteCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input.Key).toEqual({
                PK: 'CHANNEL#123456789012345678',
                SK: 'SEGMENT#100#200',
            });
        });
    });

    describe('clearChannel', () => {
        test('should delete all segments and return count', async () => {
            // This tests the block at line 185-187
            const mockItems: CachedSegmentItem[] = [
                {
                    PK:             'CHANNEL#123456789012345678',
                    SK:             'SEGMENT#100#200',
                    channelId,
                    startSnowflake: '100' as MessageId,
                    endSnowflake:   '200' as MessageId,
                    messages:       [],
                    fetchedAt:      '2024-01-15T10:30:00.000Z',
                },
                {
                    PK:             'CHANNEL#123456789012345678',
                    SK:             'SEGMENT#300#400',
                    channelId,
                    startSnowflake: '300' as MessageId,
                    endSnowflake:   '400' as MessageId,
                    messages:       [],
                    fetchedAt:      '2024-01-15T10:35:00.000Z',
                },
            ];

            ddbMock.on(QueryCommand).resolves({ Items: mockItems });
            ddbMock.on(BatchWriteCommand).resolves({});

            const count = await cache.clearChannel(channelId);

            expect(count).toBe(2);
        });

        test('should return 0 when no segments exist', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const count = await cache.clearChannel(channelId);

            expect(count).toBe(0);
        });
    });

    describe('concurrent operations', () => {
        test('should handle concurrent getMessagesInRange calls safely', async () => {
            // Setup cache with some data
            const mockMessages: CachedMessage[] = [
                { id: '120' as MessageId, content: 'First', authorId: 'a', timestamp: '2024-01-15T10:00:00.000Z' },
                { id: '150' as MessageId, content: 'Second', authorId: 'a', timestamp: '2024-01-15T10:10:00.000Z' },
                { id: '180' as MessageId, content: 'Third', authorId: 'a', timestamp: '2024-01-15T10:20:00.000Z' },
                { id: '210' as MessageId, content: 'Fourth', authorId: 'a', timestamp: '2024-01-15T10:30:00.000Z' },
            ];

            const mockItem: CachedSegmentItem = {
                PK:             'CHANNEL#123456789012345678',
                SK:             'SEGMENT#100#250',
                channelId,
                startSnowflake: '100' as MessageId,
                endSnowflake:   '250' as MessageId,
                messages:       mockMessages,
                fetchedAt:      '2024-01-15T10:40:00.000Z',
            };

            ddbMock.on(QueryCommand).resolves({ Items: [mockItem] });

            const promises = [
                cache.getMessagesInRange(channelId, '100' as MessageId, '200' as MessageId),
                cache.getMessagesInRange(channelId, '150' as MessageId, '250' as MessageId),
                cache.getMessagesInRange(channelId, '100' as MessageId, '250' as MessageId),
            ];

            const results = await Promise.all(promises);

            // All should complete without error
            expect(results).toHaveLength(3);
            // Results should be consistent
            _.forEach(results, (result) => {
                expect(result.messages).toBeDefined();
                expect(_.isArray(result.messages)).toBe(true);
            });
        });

        test('should handle concurrent storeMessages calls safely', async () => {
            ddbMock.on(PutCommand).resolves({});

            const messages1: CachedMessage[] = [
                { id: '120' as MessageId, content: 'Batch 1 First', authorId: 'a', timestamp: '2024-01-15T10:00:00.000Z' },
                { id: '150' as MessageId, content: 'Batch 1 Second', authorId: 'a', timestamp: '2024-01-15T10:10:00.000Z' },
            ];

            const messages2: CachedMessage[] = [
                { id: '250' as MessageId, content: 'Batch 2 First', authorId: 'b', timestamp: '2024-01-15T10:20:00.000Z' },
                { id: '280' as MessageId, content: 'Batch 2 Second', authorId: 'b', timestamp: '2024-01-15T10:30:00.000Z' },
            ];

            await Promise.all([
                cache.storeMessages(channelId, '100' as MessageId, '200' as MessageId, messages1),
                cache.storeMessages(channelId, '200' as MessageId, '300' as MessageId, messages2),
            ]);

            // Verify both batches were stored
            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls.length).toBeGreaterThanOrEqual(2);
        });

        test('should handle concurrent mixed operations safely', async () => {
            const mockItem: CachedSegmentItem = {
                PK:             'CHANNEL#123456789012345678',
                SK:             'SEGMENT#100#200',
                channelId,
                startSnowflake: '100' as MessageId,
                endSnowflake:   '200' as MessageId,
                messages:       [
                    { id: '150' as MessageId, content: 'Message', authorId: 'a', timestamp: '2024-01-15T10:10:00.000Z' },
                ],
                fetchedAt: '2024-01-15T10:30:00.000Z',
            };

            ddbMock.on(QueryCommand).resolves({ Items: [mockItem] });
            ddbMock.on(PutCommand).resolves({});

            const newMessages: CachedMessage[] = [
                { id: '250' as MessageId, content: 'New', authorId: 'b', timestamp: '2024-01-15T10:40:00.000Z' },
            ];

            // Mix of reads and writes
            const promises = [
                cache.getMessagesInRange(channelId, '100' as MessageId, '200' as MessageId),
                cache.storeMessages(channelId, '200' as MessageId, '300' as MessageId, newMessages),
                cache.findGaps(channelId, '100' as MessageId, '300' as MessageId),
                cache.isRangeFullyCached(channelId, '100' as MessageId, '200' as MessageId),
            ];

            const results = await Promise.all(promises);

            // All operations should complete without error
            expect(results).toHaveLength(4);
        });
    });
});
