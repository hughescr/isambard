import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mockClient } from 'aws-sdk-client-mock';
import {
    DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    DeleteCommand,
    QueryCommand
} from '@aws-sdk/lib-dynamodb';
import { MessageCacheBackend } from '@/storage/message-cache/backend';
import { ValidationError } from '@/storage/errors';
import type { MessageId, CachedSegmentItem, CachedMessage } from '@/storage/message-cache/types';
import type { ChannelId } from '@/integrations/discord/types';

describe('MessageCacheBackend', () => {
    const ddbMock = mockClient(DynamoDBDocumentClient);
    let backend: MessageCacheBackend;

    const channelId = '123456789012345678' as ChannelId;
    const startSnowflake = '100' as MessageId;
    const endSnowflake = '200' as MessageId;

    const validMessages: CachedMessage[] = [
        {
            id:        '150' as MessageId,
            content:   'Test message',
            authorId:  '111222333444555666',
            timestamp: '2024-01-15T10:30:00.000Z',
        },
    ];

    beforeEach(() => {
        ddbMock.reset();
        backend = new MessageCacheBackend(
            ddbMock as unknown as DynamoDBDocumentClient,
            'TestTable'
        );
    });

    afterEach(() => {
        ddbMock.reset();
    });

    describe('storeSegment', () => {
        it('should store a new segment', async () => {
            ddbMock.on(PutCommand).resolves({});

            const segment = await backend.storeSegment({
                channelId,
                startSnowflake,
                endSnowflake,
                messages: validMessages,
            });

            expect(segment.channelId).toBe(channelId);
            expect(segment.startSnowflake).toBe(startSnowflake);
            expect(segment.endSnowflake).toBe(endSnowflake);
            expect(segment.messages).toHaveLength(1);
        });

        it('should set fetchedAt timestamp', async () => {
            ddbMock.on(PutCommand).resolves({});

            const before = new Date().toISOString();
            const segment = await backend.storeSegment({
                channelId,
                startSnowflake,
                endSnowflake,
                messages: validMessages,
            });
            const after = new Date().toISOString();

            expect(segment.fetchedAt >= before).toBe(true);
            expect(segment.fetchedAt <= after).toBe(true);
        });

        it('should store empty messages array', async () => {
            ddbMock.on(PutCommand).resolves({});

            const segment = await backend.storeSegment({
                channelId,
                startSnowflake,
                endSnowflake,
                messages: [],
            });

            expect(segment.messages).toHaveLength(0);
        });

        it('should call putItem with correct DynamoDB keys', async () => {
            ddbMock.on(PutCommand).resolves({});

            await backend.storeSegment({
                channelId,
                startSnowflake,
                endSnowflake,
                messages: validMessages,
            });

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(1);
            const item = calls[0].args[0].input.Item as CachedSegmentItem;
            expect(item.PK).toBe('CHANNEL#123456789012345678');
            expect(item.SK).toBe('SEGMENT#100#200');
        });

        it('should throw ValidationError for empty channelId', async () => {
            expect(
                backend.storeSegment({
                    channelId: '' as ChannelId,
                    startSnowflake,
                    endSnowflake,
                    messages:  validMessages,
                })
            ).rejects.toThrow(ValidationError);
        });

        it('should throw ValidationError for empty startSnowflake', async () => {
            expect(
                backend.storeSegment({
                    channelId,
                    startSnowflake: '' as MessageId,
                    endSnowflake,
                    messages:       validMessages,
                })
            ).rejects.toThrow(ValidationError);
        });

        it('should throw ValidationError for invalid message in array', async () => {
            expect(
                backend.storeSegment({
                    channelId,
                    startSnowflake,
                    endSnowflake,
                    messages: [{ id: '' as MessageId, content: 'x', authorId: '', timestamp: 'invalid' }],
                })
            ).rejects.toThrow(ValidationError);
        });
    });

    describe('getSegment', () => {
        it('should return segment when found', async () => {
            const mockItem: CachedSegmentItem = {
                PK:        'CHANNEL#123456789012345678',
                SK:        'SEGMENT#100#200',
                channelId,
                startSnowflake,
                endSnowflake,
                messages:  validMessages,
                fetchedAt: '2024-01-15T10:30:00.000Z',
            };

            ddbMock.on(GetCommand).resolves({ Item: mockItem });

            const segment = await backend.getSegment(channelId, startSnowflake, endSnowflake);

            expect(segment).not.toBeUndefined();
            expect(segment?.channelId).toBe(channelId);
            expect(segment?.startSnowflake).toBe(startSnowflake);
            expect(segment?.endSnowflake).toBe(endSnowflake);
        });

        it('should call getItem with correct DynamoDB keys', async () => {
            const mockItem: CachedSegmentItem = {
                PK:        'CHANNEL#123456789012345678',
                SK:        'SEGMENT#100#200',
                channelId,
                startSnowflake,
                endSnowflake,
                messages:  validMessages,
                fetchedAt: '2024-01-15T10:30:00.000Z',
            };

            ddbMock.on(GetCommand).resolves({ Item: mockItem });

            await backend.getSegment(channelId, startSnowflake, endSnowflake);

            const calls = ddbMock.commandCalls(GetCommand);
            expect(calls).toHaveLength(1);
            const input = calls[0].args[0].input;
            expect(input.Key).toEqual({
                PK: 'CHANNEL#123456789012345678',
                SK: 'SEGMENT#100#200',
            });
        });

        it('should return undefined when not found', async () => {
            ddbMock.on(GetCommand).resolves({});

            const segment = await backend.getSegment(channelId, startSnowflake, endSnowflake);

            expect(segment).toBeUndefined();
        });

        it('should strip DynamoDB keys from response', async () => {
            const mockItem: CachedSegmentItem = {
                PK:        'CHANNEL#123456789012345678',
                SK:        'SEGMENT#100#200',
                channelId,
                startSnowflake,
                endSnowflake,
                messages:  validMessages,
                fetchedAt: '2024-01-15T10:30:00.000Z',
            };

            ddbMock.on(GetCommand).resolves({ Item: mockItem });

            const segment = await backend.getSegment(channelId, startSnowflake, endSnowflake);

            expect(segment).not.toHaveProperty('PK');
            expect(segment).not.toHaveProperty('SK');
        });
    });

    describe('listSegments', () => {
        it('should return all segments for a channel', async () => {
            const mockItems: CachedSegmentItem[] = [
                {
                    PK:             'CHANNEL#123456789012345678',
                    SK:             'SEGMENT#100#150',
                    channelId,
                    startSnowflake: '100' as MessageId,
                    endSnowflake:   '150' as MessageId,
                    messages:       [],
                    fetchedAt:      '2024-01-15T10:30:00.000Z',
                },
                {
                    PK:             'CHANNEL#123456789012345678',
                    SK:             'SEGMENT#200#300',
                    channelId,
                    startSnowflake: '200' as MessageId,
                    endSnowflake:   '300' as MessageId,
                    messages:       [],
                    fetchedAt:      '2024-01-15T10:35:00.000Z',
                },
            ];

            ddbMock.on(QueryCommand).resolves({ Items: mockItems });

            const segments = await backend.listSegments(channelId);

            expect(segments).toHaveLength(2);
            expect(segments[0].startSnowflake).toBe('100' as MessageId);
            expect(segments[1].startSnowflake).toBe('200' as MessageId);
        });

        it('should return empty array when no segments exist', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const segments = await backend.listSegments(channelId);

            expect(segments).toHaveLength(0);
        });

        it('should query with correct PK', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.listSegments(channelId);

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            const input = calls[0].args[0].input;
            expect(input.KeyConditionExpression).toBe('PK = :pk');
            expect(input.ExpressionAttributeValues).toEqual({ ':pk': 'CHANNEL#123456789012345678' });
        });
    });

    describe('deleteSegment', () => {
        it('should delete a segment', async () => {
            ddbMock.on(DeleteCommand).resolves({});

            await backend.deleteSegment(channelId, startSnowflake, endSnowflake);

            const calls = ddbMock.commandCalls(DeleteCommand);
            expect(calls).toHaveLength(1);
            const key = calls[0].args[0].input.Key;
            expect(key).toEqual({
                PK: 'CHANNEL#123456789012345678',
                SK: 'SEGMENT#100#200',
            });
        });
    });

    describe('deleteAllSegments', () => {
        it('should delete all segments for a channel', async () => {
            const mockItems: CachedSegmentItem[] = [
                {
                    PK:             'CHANNEL#123456789012345678',
                    SK:             'SEGMENT#100#150',
                    channelId,
                    startSnowflake: '100' as MessageId,
                    endSnowflake:   '150' as MessageId,
                    messages:       [],
                    fetchedAt:      '2024-01-15T10:30:00.000Z',
                },
                {
                    PK:             'CHANNEL#123456789012345678',
                    SK:             'SEGMENT#200#300',
                    channelId,
                    startSnowflake: '200' as MessageId,
                    endSnowflake:   '300' as MessageId,
                    messages:       [],
                    fetchedAt:      '2024-01-15T10:35:00.000Z',
                },
            ];

            ddbMock.on(QueryCommand).resolves({ Items: mockItems });
            ddbMock.on(DeleteCommand).resolves({});

            const count = await backend.deleteAllSegments(channelId);

            expect(count).toBe(2);
            const deleteCalls = ddbMock.commandCalls(DeleteCommand);
            expect(deleteCalls).toHaveLength(2);
        });

        it('should call DeleteCommand with correct TableName and Key for each segment', async () => {
            const mockItems: CachedSegmentItem[] = [
                {
                    PK:             'CHANNEL#123456789012345678',
                    SK:             'SEGMENT#100#150',
                    channelId,
                    startSnowflake: '100' as MessageId,
                    endSnowflake:   '150' as MessageId,
                    messages:       [],
                    fetchedAt:      '2024-01-15T10:30:00.000Z',
                },
                {
                    PK:             'CHANNEL#123456789012345678',
                    SK:             'SEGMENT#200#300',
                    channelId,
                    startSnowflake: '200' as MessageId,
                    endSnowflake:   '300' as MessageId,
                    messages:       [],
                    fetchedAt:      '2024-01-15T10:35:00.000Z',
                },
            ];

            ddbMock.on(QueryCommand).resolves({ Items: mockItems });
            ddbMock.on(DeleteCommand).resolves({});

            await backend.deleteAllSegments(channelId);

            const deleteCalls = ddbMock.commandCalls(DeleteCommand);
            expect(deleteCalls).toHaveLength(2);

            // Verify first delete call
            expect(deleteCalls[0].args[0].input.TableName).toBe('TestTable');
            expect(deleteCalls[0].args[0].input.Key).toEqual({
                PK: 'CHANNEL#123456789012345678',
                SK: 'SEGMENT#100#150',
            });

            // Verify second delete call
            expect(deleteCalls[1].args[0].input.TableName).toBe('TestTable');
            expect(deleteCalls[1].args[0].input.Key).toEqual({
                PK: 'CHANNEL#123456789012345678',
                SK: 'SEGMENT#200#300',
            });
        });

        it('should return 0 when no segments exist', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const count = await backend.deleteAllSegments(channelId);

            expect(count).toBe(0);
        });
    });
});
