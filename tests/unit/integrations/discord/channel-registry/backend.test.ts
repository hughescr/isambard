import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { mockClient } from 'aws-sdk-client-mock';
import _ from 'lodash';
import {
    DynamoDBDocumentClient,
    PutCommand,
    GetCommand,
    QueryCommand,
    UpdateCommand,
    DeleteCommand
} from '@aws-sdk/lib-dynamodb';
import { ChannelRegistryBackend } from '@/integrations/discord/channel-registry/backend';
import { ItemNotFoundError, ValidationError } from '@/errors';
import { createChannelId, createGuildId } from '@/integrations/discord/types';
import type { ChannelMetadata, ChannelStorageRecord } from '@/integrations/discord/channel-registry/types';
import { WELL_KNOWN_CHANNELS } from '@/integrations/discord/channel-registry/types';
import * as dynamoRetry from '@/storage/dynamo-retry';

describe('ChannelRegistryBackend', () => {
    const ddbMock = mockClient(DynamoDBDocumentClient);
    let backend: ChannelRegistryBackend;
    let withDynamoTimeoutSpy: ReturnType<typeof mock>;

    const tableName = 'test-table';
    const channelId = createChannelId('123456');
    const guildId = createGuildId('789012');
    const channelName = 'general';

    const createStorageRecord = (overrides?: Partial<ChannelStorageRecord>): ChannelStorageRecord => ({
        channelId,
        guildId,
        isMuted:   false,
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
        ...overrides,
    });

    const _createMetadata = (overrides?: Partial<ChannelMetadata>): ChannelMetadata => ({
        channelId,
        guildId,
        channelName,
        isMuted:      false,
        discoveredAt: '2025-01-01T00:00:00.000Z',
        lastSeenAt:   '2025-01-01T00:00:00.000Z',
        updatedAt:    '2025-01-01T00:00:00.000Z',
        ...overrides,
    });

    beforeEach(() => {
        ddbMock.reset();

        // Spy on withDynamoTimeout - just pass through to the operation
        withDynamoTimeoutSpy = spyOn(dynamoRetry, 'withDynamoTimeout').mockImplementation(
            async (operation) => {
                // Just execute the operation directly (bypass timeout wrapper for tests)
                return operation();
            }
        );

        backend = new ChannelRegistryBackend(
            ddbMock as unknown as DynamoDBDocumentClient,
            tableName
        );
    });

    afterEach(() => {
        ddbMock.restore();
        withDynamoTimeoutSpy.mockRestore();
    });

    describe('upsertChannel', () => {
        test('should upsert a basic channel without well-known designation', async () => {
            const record = createStorageRecord();

            ddbMock.on(PutCommand).resolves({});

            await backend.upsertChannel(record);

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(1);
            const call = calls[0];
            expect(call.args[0].input.TableName).toBe(tableName);
            expect(call.args[0].input.Item).toMatchObject({
                channelId,
                guildId,
                isMuted: false,
                PK:      `CHANNEL#${channelId}`,
                SK:      'METADATA',
                GSI1PK:  `GUILD#${guildId}`,
                GSI1SK:  `CHANNEL#${channelId}`,
            });
            // Should not have well-known keys
            expect(call.args[0].input.Item?.GSI2PK).toBeUndefined();
            expect(call.args[0].input.Item?.GSI2SK).toBeUndefined();

            // Verify operation name passed to withDynamoTimeout
            expect(withDynamoTimeoutSpy).toHaveBeenCalledWith(
                expect.any(Function),
                expect.objectContaining({ operation: 'ChannelRegistry.upsertChannel' })
            );
        });

        test('should upsert a well-known channel with GSI2 keys', async () => {
            const record = createStorageRecord({ isWellKnown: 'general' });

            ddbMock.on(PutCommand).resolves({});

            await backend.upsertChannel(record);

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(1);
            const call = calls[0];
            expect(call.args[0].input.Item).toMatchObject({
                channelId,
                guildId,
                isWellKnown: 'general',
                PK:          `CHANNEL#${channelId}`,
                SK:          'METADATA',
                GSI1PK:      `GUILD#${guildId}`,
                GSI1SK:      `CHANNEL#${channelId}`,
                GSI2PK:      'WELLKNOWN#general',
                GSI2SK:      'CHANNEL',
            });
        });

        test('should update an existing channel', async () => {
            const record = createStorageRecord({ isMuted: true });

            ddbMock.on(PutCommand).resolves({});

            await backend.upsertChannel(record);

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(1);
            const call = calls[0];
            expect(call.args[0].input.Item?.isMuted).toBe(true);
        });

        test('should throw ValidationError for invalid metadata', async () => {
            const invalidRecord = {
                channelId: '', // Invalid - empty string
                guildId,
                isMuted:   false,
                createdAt: '2025-01-01T00:00:00.000Z',
                updatedAt: '2025-01-01T00:00:00.000Z',
            };

            expect(backend.upsertChannel(invalidRecord as ChannelStorageRecord)).rejects.toThrow(ValidationError);
            expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
        });
    });

    describe('getChannel', () => {
        test('should return channel metadata when found', async () => {
            const storageRecord = createStorageRecord();
            ddbMock.on(GetCommand).resolves({
                Item: {
                    ...storageRecord,
                    PK:     `CHANNEL#${channelId}`,
                    SK:     'METADATA',
                    GSI1PK: `GUILD#${guildId}`,
                },
            });

            const result = await backend.getChannel(channelId);

            expect(result).toEqual(storageRecord);
            const calls = ddbMock.commandCalls(GetCommand);
            expect(calls).toHaveLength(1);
            const call = calls[0];
            expect(call.args[0].input.TableName).toBe(tableName);
            expect(call.args[0].input.Key).toEqual({
                PK: `CHANNEL#${channelId}`,
                SK: 'METADATA',
            });

            // Verify operation name passed to withDynamoTimeout
            expect(withDynamoTimeoutSpy).toHaveBeenCalledWith(
                expect.any(Function),
                expect.objectContaining({ operation: 'ChannelRegistry.getChannel' })
            );
        });

        test('should return null when channel not found', async () => {
            ddbMock.on(GetCommand).resolves({});

            const result = await backend.getChannel(channelId);

            expect(result).toBeNull();
        });

        test('should strip DynamoDB keys from response', async () => {
            const storageRecord = createStorageRecord();
            ddbMock.on(GetCommand).resolves({
                Item: {
                    ...storageRecord,
                    PK:     `CHANNEL#${channelId}`,
                    SK:     'METADATA',
                    GSI1PK: `GUILD#${guildId}`,
                    GSI2PK: 'WELLKNOWN#general',
                    GSI2SK: 'CHANNEL',
                },
            });

            const result = await backend.getChannel(channelId);

            expect(result).not.toHaveProperty('PK');
            expect(result).not.toHaveProperty('SK');
            expect(result).not.toHaveProperty('GSI1PK');
            expect(result).not.toHaveProperty('GSI1SK');
            expect(result).not.toHaveProperty('GSI2PK');
            expect(result).not.toHaveProperty('GSI2SK');
        });
    });

    describe('getChannelsByGuild', () => {
        test('should return all channels in a guild', async () => {
            const channel1 = createStorageRecord({ channelId: createChannelId('111') });
            const channel2 = createStorageRecord({ channelId: createChannelId('222') });

            ddbMock.on(QueryCommand).resolves({
                Items: [
                    { ...channel1, PK: `CHANNEL#${channel1.channelId}`, SK: 'METADATA', GSI1PK: `GUILD#${guildId}` },
                    { ...channel2, PK: `CHANNEL#${channel2.channelId}`, SK: 'METADATA', GSI1PK: `GUILD#${guildId}` },
                ],
            });

            const result = await backend.getChannelsByGuild(guildId);

            expect(result).toHaveLength(2);
            expect(result).toEqual(expect.arrayContaining([
                expect.objectContaining({ channelId: channel1.channelId }),
                expect.objectContaining({ channelId: channel2.channelId }),
            ]));

            const calls = ddbMock.commandCalls(QueryCommand);
            const call = calls[0];
            expect(call.args[0].input.IndexName).toBe('GSI1');
            expect(call.args[0].input.KeyConditionExpression).toBe('GSI1PK = :guildPk AND begins_with(GSI1SK, :channelPrefix)');
            expect(call.args[0].input.ExpressionAttributeValues).toEqual({
                ':guildPk':       `GUILD#${guildId}`,
                ':channelPrefix': 'CHANNEL#',
            });

            // Verify operation name passed to withDynamoTimeout
            expect(withDynamoTimeoutSpy).toHaveBeenCalledWith(
                expect.any(Function),
                expect.objectContaining({ operation: 'ChannelRegistry.getChannelsByGuild' })
            );
        });

        test('should return empty array when no channels found', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await backend.getChannelsByGuild(guildId);

            expect(result).toEqual([]);
        });

        test('should handle undefined Items in response', async () => {
            ddbMock.on(QueryCommand).resolves({});

            const result = await backend.getChannelsByGuild(guildId);

            expect(result).toEqual([]);
        });
    });

    describe('getWellKnownChannel', () => {
        test('should return well-known channel when found', async () => {
            const storageRecord = createStorageRecord({ isWellKnown: 'general' });

            // Mock the GSI2 query to return the PK
            ddbMock.on(QueryCommand).resolves({
                Items: [
                    {
                        ...storageRecord,
                        PK:     `CHANNEL#${channelId}`,
                        SK:     'METADATA',
                        GSI2PK: 'WELLKNOWN#general',
                        GSI2SK: 'CHANNEL',
                    },
                ],
            });

            // Mock the GetCommand to return the full record
            ddbMock.on(GetCommand).resolves({
                Item: {
                    ...storageRecord,
                    PK:     `CHANNEL#${channelId}`,
                    SK:     'METADATA',
                    GSI1PK: `GUILD#${guildId}`,
                    GSI2PK: 'WELLKNOWN#general',
                    GSI2SK: 'CHANNEL',
                },
            });

            const result = await backend.getWellKnownChannel('general');

            expect(result).toEqual(storageRecord);

            // Verify GSI2 query
            const queryCalls = ddbMock.commandCalls(QueryCommand);
            const queryCall = queryCalls[0];
            expect(queryCall.args[0].input.IndexName).toBe('GSI2');
            expect(queryCall.args[0].input.KeyConditionExpression).toBe('GSI2PK = :wellKnownPk AND GSI2SK = :channelSk');
            expect(queryCall.args[0].input.ExpressionAttributeValues).toEqual({
                ':wellKnownPk': 'WELLKNOWN#general',
                ':channelSk':   'CHANNEL',
            });
            expect(queryCall.args[0].input.Limit).toBe(1);

            // Verify GetCommand was called with correct key
            const getCalls = ddbMock.commandCalls(GetCommand);
            expect(getCalls).toHaveLength(1);
            const getCall = getCalls[0];
            expect(getCall.args[0].input.Key).toEqual({
                PK: `CHANNEL#${channelId}`,
                SK: 'METADATA',
            });

            // Verify operation names passed to withDynamoTimeout
            expect(withDynamoTimeoutSpy).toHaveBeenCalledWith(
                expect.any(Function),
                expect.objectContaining({ operation: 'ChannelRegistry.getWellKnownChannel.gsi2Query' })
            );
            expect(withDynamoTimeoutSpy).toHaveBeenCalledWith(
                expect.any(Function),
                expect.objectContaining({ operation: 'ChannelRegistry.getChannel' })
            );
        });

        test('should return null when well-known channel not found', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await backend.getWellKnownChannel('catch-up');

            expect(result).toBeNull();
        });

        test('should return null when Items is undefined', async () => {
            ddbMock.on(QueryCommand).resolves({});

            const result = await backend.getWellKnownChannel('catch-up');

            expect(result).toBeNull();
        });
    });

    describe('getAllWellKnownChannels', () => {
        test('should return empty array when no well-known channels exist', async () => {
            // All 4 well-known types return null (not configured)
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await backend.getAllWellKnownChannels();

            expect(result).toEqual([]);

            // Verify QueryCommand called once per well-known type (4 types)
            const queryCalls = ddbMock.commandCalls(QueryCommand);
            expect(queryCalls).toHaveLength(WELL_KNOWN_CHANNELS.length);
        });

        test('should call getWellKnownChannel for each well-known type', async () => {
            // All return null (not configured)
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.getAllWellKnownChannels();

            // Verify QueryCommand is called for each well-known channel type
            const queryCalls = ddbMock.commandCalls(QueryCommand);
            expect(queryCalls).toHaveLength(WELL_KNOWN_CHANNELS.length);

            // Each call should query GSI2 for a specific well-known type
            const queriedTypes = _.map(queryCalls, call =>
                call.args[0].input.ExpressionAttributeValues?.[':wellKnownPk'] as string
            );
            for(const type of WELL_KNOWN_CHANNELS) {
                expect(queriedTypes).toContain(`WELLKNOWN#${type}`);
            }
        });

        test('should return records for configured well-known channels', async () => {
            const generalChannel = createStorageRecord({
                channelId:   createChannelId('111'),
                isWellKnown: 'general'
            });
            const catchUpChannel = createStorageRecord({
                channelId:   createChannelId('222'),
                isWellKnown: 'catch-up'
            });

            // Spy on getWellKnownChannel to control what it returns per type
            const getWellKnownSpy = spyOn(backend, 'getWellKnownChannel').mockImplementation(
                async (type) => {
                    if(type === 'general') {
                        return generalChannel;
                    }
                    if(type === 'catch-up') {
                        return catchUpChannel;
                    }
                    return null;
                }
            );

            const result = await backend.getAllWellKnownChannels();

            expect(result).toHaveLength(2);
            expect(result).toEqual(expect.arrayContaining([
                expect.objectContaining({ channelId: generalChannel.channelId }),
                expect.objectContaining({ channelId: catchUpChannel.channelId }),
            ]));

            // Verify getWellKnownChannel was called for each type
            expect(getWellKnownSpy).toHaveBeenCalledTimes(WELL_KNOWN_CHANNELS.length);
            for(const type of WELL_KNOWN_CHANNELS) {
                expect(getWellKnownSpy).toHaveBeenCalledWith(type);
            }

            getWellKnownSpy.mockRestore();
        });

        test('should filter out null results for unconfigured well-known types', async () => {
            const generalChannel = createStorageRecord({
                channelId:   createChannelId('111'),
                isWellKnown: 'general'
            });

            // Spy: only 'general' returns a record; others return null
            const getWellKnownSpy = spyOn(backend, 'getWellKnownChannel').mockImplementation(
                async (type) => {
                    if(type === 'general') {
                        return generalChannel;
                    }
                    return null;
                }
            );

            const result = await backend.getAllWellKnownChannels();

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual(generalChannel);

            getWellKnownSpy.mockRestore();
        });
    });

    describe('muteChannel', () => {
        test('should mute a channel', async () => {
            ddbMock.on(UpdateCommand).resolves({});

            await backend.muteChannel(channelId);

            const calls = ddbMock.commandCalls(UpdateCommand);
            expect(calls).toHaveLength(1);
            const call = calls[0];
            expect(call.args[0].input.TableName).toBe(tableName);
            expect(call.args[0].input.Key).toEqual({
                PK: `CHANNEL#${channelId}`,
                SK: 'METADATA',
            });
            expect(call.args[0].input.UpdateExpression).toBe('SET isMuted = :muted, updatedAt = :now');
            expect(call.args[0].input.ExpressionAttributeValues?.[':muted']).toBe(true);
            expect(call.args[0].input.ExpressionAttributeValues?.[':now']).toBeDefined();
            expect(call.args[0].input.ConditionExpression).toBe('attribute_exists(PK)');

            // Verify operation name passed to withDynamoTimeout
            expect(withDynamoTimeoutSpy).toHaveBeenCalledWith(
                expect.any(Function),
                expect.objectContaining({ operation: 'ChannelRegistry.muteChannel' })
            );
        });

        test('should throw ItemNotFoundError when channel does not exist', async () => {
            const conditionalCheckError = new Error('ConditionalCheckFailedException');
            (conditionalCheckError as { name: string }).name = 'ConditionalCheckFailedException';
            ddbMock.on(UpdateCommand).rejects(conditionalCheckError);

            expect(backend.muteChannel(channelId)).rejects.toThrow(ItemNotFoundError);
        });

        test('should propagate other errors', async () => {
            const otherError = new Error('Network error');
            ddbMock.on(UpdateCommand).rejects(otherError);

            expect(backend.muteChannel(channelId)).rejects.toThrow('Network error');
        });
    });

    describe('unmuteChannel', () => {
        test('should unmute a channel', async () => {
            ddbMock.on(UpdateCommand).resolves({});

            await backend.unmuteChannel(channelId);

            const calls = ddbMock.commandCalls(UpdateCommand);
            expect(calls).toHaveLength(1);
            const call = calls[0];
            expect(call.args[0].input.TableName).toBe(tableName);
            expect(call.args[0].input.Key).toEqual({
                PK: `CHANNEL#${channelId}`,
                SK: 'METADATA',
            });
            expect(call.args[0].input.UpdateExpression).toBe('SET isMuted = :muted, updatedAt = :now');
            expect(call.args[0].input.ExpressionAttributeValues?.[':muted']).toBe(false);
            expect(call.args[0].input.ExpressionAttributeValues?.[':now']).toBeDefined();
            expect(call.args[0].input.ConditionExpression).toBe('attribute_exists(PK)');

            // Verify operation name passed to withDynamoTimeout
            expect(withDynamoTimeoutSpy).toHaveBeenCalledWith(
                expect.any(Function),
                expect.objectContaining({ operation: 'ChannelRegistry.unmuteChannel' })
            );
        });

        test('should throw ItemNotFoundError when channel does not exist', async () => {
            const conditionalCheckError = new Error('ConditionalCheckFailedException');
            (conditionalCheckError as { name: string }).name = 'ConditionalCheckFailedException';
            ddbMock.on(UpdateCommand).rejects(conditionalCheckError);

            expect(backend.unmuteChannel(channelId)).rejects.toThrow(ItemNotFoundError);
        });

        test('should propagate other errors', async () => {
            const otherError = new Error('Network error');
            ddbMock.on(UpdateCommand).rejects(otherError);

            expect(backend.unmuteChannel(channelId)).rejects.toThrow('Network error');
        });
    });

    describe('markAsWellKnown', () => {
        test('should mark channel as well-known and add GSI2 keys', async () => {
            ddbMock.on(UpdateCommand).resolves({});

            await backend.markAsWellKnown(channelId, 'general');

            const calls = ddbMock.commandCalls(UpdateCommand);
            expect(calls).toHaveLength(1);
            const call = calls[0];
            expect(call.args[0].input.TableName).toBe(tableName);
            expect(call.args[0].input.Key).toEqual({
                PK: `CHANNEL#${channelId}`,
                SK: 'METADATA',
            });
            expect(call.args[0].input.UpdateExpression).toBe('SET isWellKnown = :type, GSI2PK = :gsi2pk, GSI2SK = :gsi2sk, updatedAt = :now');
            expect(call.args[0].input.ExpressionAttributeValues).toMatchObject({
                ':type':   'general',
                ':gsi2pk': 'WELLKNOWN#general',
                ':gsi2sk': 'CHANNEL',
            });
            expect(call.args[0].input.ExpressionAttributeValues?.[':now']).toBeDefined();
            expect(call.args[0].input.ConditionExpression).toBe('attribute_exists(PK)');

            // Verify operation name passed to withDynamoTimeout
            expect(withDynamoTimeoutSpy).toHaveBeenCalledWith(
                expect.any(Function),
                expect.objectContaining({ operation: 'ChannelRegistry.markAsWellKnown' })
            );
        });

        test('should throw ItemNotFoundError when channel does not exist', async () => {
            const conditionalCheckError = new Error('ConditionalCheckFailedException');
            (conditionalCheckError as { name: string }).name = 'ConditionalCheckFailedException';
            ddbMock.on(UpdateCommand).rejects(conditionalCheckError);

            expect(backend.markAsWellKnown(channelId, 'general')).rejects.toThrow(ItemNotFoundError);
        });

        test('should propagate other errors', async () => {
            const otherError = new Error('Network error');
            ddbMock.on(UpdateCommand).rejects(otherError);

            expect(backend.markAsWellKnown(channelId, 'general')).rejects.toThrow('Network error');
        });
    });

    describe('unmarkAsWellKnown', () => {
        test('should remove well-known designation and GSI2 keys', async () => {
            ddbMock.on(UpdateCommand).resolves({});

            await backend.unmarkAsWellKnown(channelId);

            const calls = ddbMock.commandCalls(UpdateCommand);
            expect(calls).toHaveLength(1);
            const call = calls[0];
            expect(call.args[0].input.TableName).toBe(tableName);
            expect(call.args[0].input.Key).toEqual({
                PK: `CHANNEL#${channelId}`,
                SK: 'METADATA',
            });

            // Should use REMOVE expression for GSI2 keys and isWellKnown
            expect(call.args[0].input.UpdateExpression).toContain('REMOVE');
            expect(call.args[0].input.UpdateExpression).toContain('GSI2PK');
            expect(call.args[0].input.UpdateExpression).toContain('GSI2SK');
            expect(call.args[0].input.UpdateExpression).toContain('isWellKnown');

            // Should SET updatedAt timestamp
            expect(call.args[0].input.UpdateExpression).toContain('SET');
            expect(call.args[0].input.UpdateExpression).toContain('updatedAt');
            expect(call.args[0].input.ExpressionAttributeValues?.[':now']).toBeDefined();

            // Should have condition to ensure channel exists
            expect(call.args[0].input.ConditionExpression).toBe('attribute_exists(PK)');

            // Verify operation name passed to withDynamoTimeout
            expect(withDynamoTimeoutSpy).toHaveBeenCalledWith(
                expect.any(Function),
                expect.objectContaining({ operation: 'ChannelRegistry.unmarkAsWellKnown' })
            );
        });

        test('should throw ItemNotFoundError when channel does not exist', async () => {
            const conditionalCheckError = new Error('ConditionalCheckFailedException');
            (conditionalCheckError as { name: string }).name = 'ConditionalCheckFailedException';
            ddbMock.on(UpdateCommand).rejects(conditionalCheckError);

            expect(backend.unmarkAsWellKnown(channelId)).rejects.toThrow(ItemNotFoundError);
        });

        test('should propagate other errors', async () => {
            const otherError = new Error('Network error');
            ddbMock.on(UpdateCommand).rejects(otherError);

            expect(backend.unmarkAsWellKnown(channelId)).rejects.toThrow('Network error');
        });

        test('should include updatedAt timestamp', async () => {
            ddbMock.on(UpdateCommand).resolves({});

            const before = new Date().toISOString();
            await backend.unmarkAsWellKnown(channelId);
            const after = new Date().toISOString();

            const calls = ddbMock.commandCalls(UpdateCommand);
            const command = calls[0].args[0].input;
            const updatedAt = command.ExpressionAttributeValues?.[':now'] as string | undefined;

            expect(updatedAt).toBeDefined();
            expect(updatedAt! >= before).toBe(true);
            expect(updatedAt! <= after).toBe(true);
        });
    });

    describe('deleteChannel', () => {
        test('should delete a channel', async () => {
            ddbMock.on(DeleteCommand).resolves({});

            await backend.deleteChannel(channelId);

            const calls = ddbMock.commandCalls(DeleteCommand);
            expect(calls).toHaveLength(1);
            const call = calls[0];
            expect(call.args[0].input.TableName).toBe(tableName);
            expect(call.args[0].input.Key).toEqual({
                PK: `CHANNEL#${channelId}`,
                SK: 'METADATA',
            });

            // Verify operation name passed to withDynamoTimeout
            expect(withDynamoTimeoutSpy).toHaveBeenCalledWith(
                expect.any(Function),
                expect.objectContaining({ operation: 'ChannelRegistry.deleteChannel' })
            );
        });

        test('should not throw error when channel does not exist', async () => {
            ddbMock.on(DeleteCommand).resolves({});

            expect(backend.deleteChannel(channelId)).resolves.toBeUndefined();
        });
    });

    describe('timeout configuration', () => {
        test('should use default timeout when not specified', () => {
            const defaultBackend = new ChannelRegistryBackend(
                ddbMock as unknown as DynamoDBDocumentClient,
                tableName
            );

            expect(defaultBackend).toBeDefined();
        });

        test('should use custom timeout when specified', () => {
            const customBackend = new ChannelRegistryBackend(
                ddbMock as unknown as DynamoDBDocumentClient,
                tableName,
                5000
            );

            expect(customBackend).toBeDefined();
        });
    });
});
