import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { mockClient } from 'aws-sdk-client-mock';
import {
    DynamoDBDocumentClient,
    PutCommand,
    GetCommand,
    QueryCommand,
    UpdateCommand,
    DeleteCommand,
    ScanCommand
} from '@aws-sdk/lib-dynamodb';
import { ChannelRegistryBackend } from '@/integrations/discord/channel-registry/backend';
import { ItemNotFoundError, ValidationError } from '@/storage/errors';
import { createChannelId, createGuildId } from '@/integrations/discord/types';
import type { ChannelMetadata } from '@/integrations/discord/channel-registry/types';
import * as dynamoRetry from '@/storage/dynamo-retry';

describe('ChannelRegistryBackend', () => {
    const ddbMock = mockClient(DynamoDBDocumentClient);
    let backend: ChannelRegistryBackend;
    let withDynamoTimeoutSpy: ReturnType<typeof mock>;

    const tableName = 'test-table';
    const channelId = createChannelId('123456');
    const guildId = createGuildId('789012');
    const channelName = 'general';

    const createMetadata = (overrides?: Partial<ChannelMetadata>): ChannelMetadata => ({
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
            const metadata = createMetadata();

            ddbMock.on(PutCommand).resolves({});

            await backend.upsertChannel(metadata);

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(1);
            const call = calls[0];
            expect(call.args[0].input.TableName).toBe(tableName);
            expect(call.args[0].input.Item).toMatchObject({
                channelId,
                guildId,
                channelName,
                isMuted: false,
                PK:      `CHANNEL#${channelId}`,
                SK:      'METADATA',
                GSI1PK:  `GUILD#${guildId}`,
                GSI1SK:  `CHANNEL#${channelName}`,
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
            const metadata = createMetadata({ isWellKnown: 'general' });

            ddbMock.on(PutCommand).resolves({});

            await backend.upsertChannel(metadata);

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(1);
            const call = calls[0];
            expect(call.args[0].input.Item).toMatchObject({
                channelId,
                guildId,
                channelName,
                isWellKnown: 'general',
                PK:          `CHANNEL#${channelId}`,
                SK:          'METADATA',
                GSI1PK:      `GUILD#${guildId}`,
                GSI1SK:      `CHANNEL#${channelName}`,
                GSI2PK:      'WELLKNOWN#general',
                GSI2SK:      'CHANNEL',
            });
        });

        test('should update an existing channel', async () => {
            const metadata = createMetadata({ isMuted: true });

            ddbMock.on(PutCommand).resolves({});

            await backend.upsertChannel(metadata);

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(1);
            const call = calls[0];
            expect(call.args[0].input.Item?.isMuted).toBe(true);
        });

        test('should throw ValidationError for invalid metadata', async () => {
            const invalidMetadata = {
                channelId:    '', // Invalid - empty string
                guildId,
                channelName,
                isMuted:      false,
                discoveredAt: '2025-01-01T00:00:00.000Z',
                lastSeenAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:    '2025-01-01T00:00:00.000Z',
            };

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects requires await even though expect is not thenable
            await expect(backend.upsertChannel(invalidMetadata as ChannelMetadata)).rejects.toThrow(ValidationError);
            expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
        });
    });

    describe('getChannel', () => {
        test('should return channel metadata when found', async () => {
            const metadata = createMetadata();
            ddbMock.on(GetCommand).resolves({
                Item: {
                    ...metadata,
                    PK:     `CHANNEL#${channelId}`,
                    SK:     'METADATA',
                    GSI1PK: `GUILD#${guildId}`,
                    GSI1SK: `CHANNEL#${channelName}`,
                },
            });

            const result = await backend.getChannel(channelId);

            expect(result).toEqual(metadata);
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
            const metadata = createMetadata();
            ddbMock.on(GetCommand).resolves({
                Item: {
                    ...metadata,
                    PK:     `CHANNEL#${channelId}`,
                    SK:     'METADATA',
                    GSI1PK: `GUILD#${guildId}`,
                    GSI1SK: `CHANNEL#${channelName}`,
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
            const channel1 = createMetadata({ channelId: createChannelId('111'), channelName: 'general' });
            const channel2 = createMetadata({ channelId: createChannelId('222'), channelName: 'dev-chat' });

            ddbMock.on(QueryCommand).resolves({
                Items: [
                    { ...channel1, PK: `CHANNEL#${channel1.channelId}`, SK: 'METADATA', GSI1PK: `GUILD#${guildId}`, GSI1SK: `CHANNEL#${channel1.channelName}` },
                    { ...channel2, PK: `CHANNEL#${channel2.channelId}`, SK: 'METADATA', GSI1PK: `GUILD#${guildId}`, GSI1SK: `CHANNEL#${channel2.channelName}` },
                ],
            });

            const result = await backend.getChannelsByGuild(guildId);

            expect(result).toHaveLength(2);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- expect.arrayContaining requires any[] type
            expect(result).toEqual(expect.arrayContaining([
                expect.objectContaining({ channelName: 'general' }),
                expect.objectContaining({ channelName: 'dev-chat' }),
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

    describe('getChannelByName', () => {
        test('should query specific guild when guildId provided', async () => {
            const metadata = createMetadata();
            ddbMock.on(QueryCommand).resolves({
                Items: [
                    { ...metadata, PK: `CHANNEL#${channelId}`, SK: 'METADATA', GSI1PK: `GUILD#${guildId}`, GSI1SK: `CHANNEL#${channelName}` },
                ],
            });

            const result = await backend.getChannelByName(channelName, guildId);

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual(metadata);

            const calls = ddbMock.commandCalls(QueryCommand);
            const call = calls[0];
            expect(call.args[0].input.IndexName).toBe('GSI1');
            expect(call.args[0].input.KeyConditionExpression).toBe('GSI1PK = :guildPk AND GSI1SK = :channelSk');
            expect(call.args[0].input.ExpressionAttributeValues).toEqual({
                ':guildPk':   `GUILD#${guildId}`,
                ':channelSk': `CHANNEL#${channelName}`,
            });

            // Verify operation name passed to withDynamoTimeout
            expect(withDynamoTimeoutSpy).toHaveBeenCalledWith(
                expect.any(Function),
                expect.objectContaining({ operation: 'ChannelRegistry.getChannelByName' })
            );
        });

        test('should scan all guilds when guildId not provided', async () => {
            const metadata1 = createMetadata({ guildId: createGuildId('111') });
            const metadata2 = createMetadata({ guildId: createGuildId('222') });

            ddbMock.on(ScanCommand).resolves({
                Items: [
                    { ...metadata1, PK: `CHANNEL#${channelId}`, SK: 'METADATA' },
                    { ...metadata2, PK: `CHANNEL#${channelId}`, SK: 'METADATA' },
                ],
            });

            const result = await backend.getChannelByName(channelName);

            expect(result).toHaveLength(2);

            const calls = ddbMock.commandCalls(ScanCommand);
            const call = calls[0];
            expect(call.args[0].input.FilterExpression).toBe('channelName = :channelName');
            expect(call.args[0].input.ExpressionAttributeValues).toEqual({
                ':channelName': channelName,
            });

            // Verify operation name passed to withDynamoTimeout
            expect(withDynamoTimeoutSpy).toHaveBeenCalledWith(
                expect.any(Function),
                expect.objectContaining({ operation: 'ChannelRegistry.getChannelByName.scan' })
            );
        });

        test('should return empty array when no matches found', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await backend.getChannelByName(channelName, guildId);

            expect(result).toEqual([]);
        });
    });

    describe('getWellKnownChannel', () => {
        test('should return well-known channel when found', async () => {
            const metadata = createMetadata({ isWellKnown: 'general' });
            ddbMock.on(QueryCommand).resolves({
                Items: [
                    {
                        ...metadata,
                        PK:     `CHANNEL#${channelId}`,
                        SK:     'METADATA',
                        GSI2PK: 'WELLKNOWN#general',
                        GSI2SK: 'CHANNEL',
                    },
                ],
            });

            const result = await backend.getWellKnownChannel('general');

            expect(result).toEqual(metadata);

            const calls = ddbMock.commandCalls(QueryCommand);
            const call = calls[0];
            expect(call.args[0].input.IndexName).toBe('GSI2');
            expect(call.args[0].input.KeyConditionExpression).toBe('GSI2PK = :wellKnownPk AND GSI2SK = :channelSk');
            expect(call.args[0].input.ExpressionAttributeValues).toEqual({
                ':wellKnownPk': 'WELLKNOWN#general',
                ':channelSk':   'CHANNEL',
            });
            expect(call.args[0].input.Limit).toBe(1);

            // Verify operation name passed to withDynamoTimeout
            expect(withDynamoTimeoutSpy).toHaveBeenCalledWith(
                expect.any(Function),
                expect.objectContaining({ operation: 'ChannelRegistry.getWellKnownChannel' })
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

    describe('getAllChannels', () => {
        test('should return all channels using scan', async () => {
            const channel1 = createMetadata({ channelId: createChannelId('111') });
            const channel2 = createMetadata({ channelId: createChannelId('222') });

            ddbMock.on(ScanCommand).resolves({
                Items: [
                    { ...channel1, PK: `CHANNEL#${channel1.channelId}`, SK: 'METADATA' },
                    { ...channel2, PK: `CHANNEL#${channel2.channelId}`, SK: 'METADATA' },
                ],
            });

            const result = await backend.getAllChannels();

            expect(result).toHaveLength(2);

            const calls = ddbMock.commandCalls(ScanCommand);
            const call = calls[0];
            expect(call.args[0].input.FilterExpression).toBe('SK = :metadataSk');
            expect(call.args[0].input.ExpressionAttributeValues).toEqual({
                ':metadataSk': 'METADATA',
            });

            // Verify operation name passed to withDynamoTimeout
            expect(withDynamoTimeoutSpy).toHaveBeenCalledWith(
                expect.any(Function),
                expect.objectContaining({ operation: 'ChannelRegistry.getAllChannels' })
            );
        });

        test('should return empty array when no channels exist', async () => {
            ddbMock.on(ScanCommand).resolves({ Items: [] });

            const result = await backend.getAllChannels();

            expect(result).toEqual([]);
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

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects requires await even though expect is not thenable
            await expect(backend.muteChannel(channelId)).rejects.toThrow(ItemNotFoundError);
        });

        test('should propagate other errors', async () => {
            const otherError = new Error('Network error');
            ddbMock.on(UpdateCommand).rejects(otherError);

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects requires await even though expect is not thenable
            await expect(backend.muteChannel(channelId)).rejects.toThrow('Network error');
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

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects requires await even though expect is not thenable
            await expect(backend.unmuteChannel(channelId)).rejects.toThrow(ItemNotFoundError);
        });

        test('should propagate other errors', async () => {
            const otherError = new Error('Network error');
            ddbMock.on(UpdateCommand).rejects(otherError);

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects requires await even though expect is not thenable
            await expect(backend.unmuteChannel(channelId)).rejects.toThrow('Network error');
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

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects requires await even though expect is not thenable
            await expect(backend.markAsWellKnown(channelId, 'general')).rejects.toThrow(ItemNotFoundError);
        });

        test('should propagate other errors', async () => {
            const otherError = new Error('Network error');
            ddbMock.on(UpdateCommand).rejects(otherError);

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects requires await even though expect is not thenable
            await expect(backend.markAsWellKnown(channelId, 'general')).rejects.toThrow('Network error');
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

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().resolves requires await even though expect is not thenable
            await expect(backend.deleteChannel(channelId)).resolves.toBeUndefined();
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
