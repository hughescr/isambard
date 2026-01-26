/* eslint-disable @typescript-eslint/unbound-method -- Test file uses mocks extensively */
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { CheckpointManager } from '@/integrations/discord/inbox/checkpoint-manager';
import type { MemoryToolBackend } from '@/storage/memory-tool/backend';
import type { MemoryToolItemData, MemoryPath, ContentType } from '@/storage/memory-tool/types';
import { createChannelId, createGuildId } from '@/integrations/discord/types';
import type { DiscordChannelCheckpoint } from '@/integrations/discord/inbox/types';

describe.concurrent('CheckpointManager', () => {
    let mockBackend: MemoryToolBackend;
    let manager: CheckpointManager;

    const channelId = createChannelId('123456789');
    const guildId = createGuildId('987654321');
    const now = '2025-01-24T10:00:00.000Z';

    beforeEach(() => {
        mockBackend = {
            get:    mock(async () => undefined),
            create: mock(async () => ({
                path:        '/state/services/discord/channels/123456789/checkpoint' as MemoryPath,
                content:     '{}',
                contentType: 'application/json' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   now,
                updatedAt:   now,
            })),
            update: mock(async () => ({
                path:        '/state/services/discord/channels/123456789/checkpoint' as MemoryPath,
                content:     '{}',
                contentType: 'application/json' as ContentType,
                metadata:    {},
                version:     2,
                createdAt:   now,
                updatedAt:   now,
            })),
            list:        mock(async () => ({ items: [], nextCursor: undefined })),
            listByLayer: mock(async () => ({ items: [], nextCursor: undefined })),
            searchByTag: mock(async () => ({ items: [], nextCursor: undefined })),
        } as unknown as MemoryToolBackend;

        manager = new CheckpointManager({ backend: mockBackend });
    });

    describe('load', () => {
        test('should return checkpoint when it exists', async () => {
            const checkpoint: DiscordChannelCheckpoint = {
                service:           'discord',
                channelId,
                guildId,
                lastSeenAt:        now,
                lastSeenMessageId: '111222333',
                updatedAt:         now,
            };

            mockBackend.get = mock(async () => ({
                path:        '/state/services/discord/channels/123456789/checkpoint' as MemoryPath,
                content:     JSON.stringify(checkpoint),
                contentType: 'application/json' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   now,
                updatedAt:   now,
            }));

            const result = await manager.load(channelId);
            expect(result).toEqual(checkpoint);
            expect(mockBackend.get).toHaveBeenCalledTimes(1);
        });

        test('should return undefined when checkpoint does not exist', async () => {
            mockBackend.get = mock(async () => undefined);

            const result = await manager.load(channelId);
            expect(result).toBeUndefined();
            expect(mockBackend.get).toHaveBeenCalledTimes(1);
        });

        test('should return undefined when JSON parsing fails', async () => {
            mockBackend.get = mock(async () => ({
                path:        '/state/services/discord/channels/123456789/checkpoint' as MemoryPath,
                content:     'invalid json',
                contentType: 'application/json' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   now,
                updatedAt:   now,
            }));

            const result = await manager.load(channelId);
            expect(result).toBeUndefined();
        });

        test('should handle checkpoint without optional lastSeenMessageId', async () => {
            const checkpoint: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId,
                guildId,
                lastSeenAt: now,
                updatedAt:  now,
            };

            mockBackend.get = mock(async () => ({
                path:        '/state/services/discord/channels/123456789/checkpoint' as MemoryPath,
                content:     JSON.stringify(checkpoint),
                contentType: 'application/json' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   now,
                updatedAt:   now,
            }));

            const result = await manager.load(channelId);
            expect(result).toEqual(checkpoint);
            expect(result?.lastSeenMessageId).toBeUndefined();
        });
    });

    describe('save', () => {
        test('should create new checkpoint when none exists', async () => {
            const checkpoint: DiscordChannelCheckpoint = {
                service:           'discord',
                channelId,
                guildId,
                lastSeenAt:        now,
                lastSeenMessageId: '111222333',
                updatedAt:         now,
            };

            mockBackend.get = mock(async () => undefined);
            mockBackend.create = mock(async () => ({
                path:        '/state/services/discord/channels/123456789/checkpoint' as MemoryPath,
                content:     JSON.stringify(checkpoint),
                contentType: 'application/json' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   now,
                updatedAt:   now,
            }));

            await manager.save(checkpoint);

            expect(mockBackend.get).toHaveBeenCalledTimes(1);
            expect(mockBackend.create).toHaveBeenCalledTimes(1);
            expect(mockBackend.update).not.toHaveBeenCalled();

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- Accessing mock internals
            const createCall = (mockBackend.create as any).mock.calls[0][0] as { path: string, content: string, contentType: string };
            expect(createCall.path).toBe('/state/services/discord/channels/123456789/checkpoint');
            expect(createCall.content).toBe(JSON.stringify(checkpoint));
            expect(createCall.contentType).toBe('application/json');
        });

        test('should update existing checkpoint', async () => {
            const existingCheckpoint: MemoryToolItemData = {
                path:        '/state/services/discord/channels/123456789/checkpoint' as MemoryPath,
                content:     '{}',
                contentType: 'application/json' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   now,
                updatedAt:   now,
            };

            const updatedCheckpoint: DiscordChannelCheckpoint = {
                service:           'discord',
                channelId,
                guildId,
                lastSeenAt:        now,
                lastSeenMessageId: '111222333',
                updatedAt:         now,
            };

            mockBackend.get = mock(async () => existingCheckpoint);
            mockBackend.update = mock(async () => ({
                ...existingCheckpoint,
                content:   JSON.stringify(updatedCheckpoint),
                version:   2,
                updatedAt: now,
            }));

            await manager.save(updatedCheckpoint);

            expect(mockBackend.get).toHaveBeenCalledTimes(1);
            expect(mockBackend.update).toHaveBeenCalledTimes(1);
            expect(mockBackend.create).not.toHaveBeenCalled();

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- Accessing mock internals
            const updateCall = (mockBackend.update as any).mock.calls[0] as [string, { content: string }];
            expect(updateCall[0]).toBe('/state/services/discord/channels/123456789/checkpoint');
            expect(updateCall[1].content).toBe(JSON.stringify(updatedCheckpoint));
        });

        test('should save checkpoint without optional lastSeenMessageId', async () => {
            const checkpoint: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId,
                guildId,
                lastSeenAt: now,
                updatedAt:  now,
            };

            mockBackend.get = mock(async () => undefined);

            await manager.save(checkpoint);

            expect(mockBackend.create).toHaveBeenCalledTimes(1);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- Accessing mock internals
            const createCall = (mockBackend.create as any).mock.calls[0][0] as { content: string };
            const savedContent = JSON.parse(createCall.content) as { lastSeenMessageId?: string };
            expect(savedContent.lastSeenMessageId).toBeUndefined();
        });
    });

    describe('initializeIfMissing', () => {
        test('should create new checkpoint when none exists', async () => {
            mockBackend.get = mock(async () => undefined);

            const result = await manager.initializeIfMissing(channelId, guildId);

            expect(result.service).toBe('discord');
            expect(result.channelId).toBe(channelId);
            expect(result.guildId).toBe(guildId);
            expect(result.lastSeenAt).toBeDefined();
            expect(result.updatedAt).toBeDefined();
            expect(result.lastSeenMessageId).toBeUndefined();
            expect(mockBackend.create).toHaveBeenCalledTimes(1);
        });

        test('should return existing checkpoint without creating new one', async () => {
            const existingCheckpoint: DiscordChannelCheckpoint = {
                service:           'discord',
                channelId,
                guildId,
                lastSeenAt:        now,
                lastSeenMessageId: '111222333',
                updatedAt:         now,
            };

            mockBackend.get = mock(async () => ({
                path:        '/state/services/discord/channels/123456789/checkpoint' as MemoryPath,
                content:     JSON.stringify(existingCheckpoint),
                contentType: 'application/json' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   now,
                updatedAt:   now,
            }));

            const result = await manager.initializeIfMissing(channelId, guildId);

            expect(result).toEqual(existingCheckpoint);
            expect(mockBackend.create).not.toHaveBeenCalled();
        });

        test('should initialize checkpoint with DM as guildId', async () => {
            mockBackend.get = mock(async () => undefined);

            const result = await manager.initializeIfMissing(channelId, 'DM');

            expect(result.guildId).toBe('DM');
            expect(mockBackend.create).toHaveBeenCalledTimes(1);
        });
    });

    describe('updateLastSeen', () => {
        test('should create checkpoint with all fields', async () => {
            const messageId = '111222333';
            mockBackend.get = mock(async () => undefined);

            const result = await manager.updateLastSeen(channelId, guildId, now, messageId);

            expect(result.service).toBe('discord');
            expect(result.channelId).toBe(channelId);
            expect(result.guildId).toBe(guildId);
            expect(result.lastSeenAt).toBe(now);
            expect(result.lastSeenMessageId).toBe(messageId);
            expect(result.updatedAt).toBeDefined();
            expect(mockBackend.create).toHaveBeenCalledTimes(1);
        });

        test('should create checkpoint without optional messageId', async () => {
            mockBackend.get = mock(async () => undefined);

            const result = await manager.updateLastSeen(channelId, guildId, now);

            expect(result.lastSeenMessageId).toBeUndefined();
            expect(mockBackend.create).toHaveBeenCalledTimes(1);
        });

        test('should update existing checkpoint', async () => {
            const messageId = '111222333';
            const existingCheckpoint: MemoryToolItemData = {
                path:        '/state/services/discord/channels/123456789/checkpoint' as MemoryPath,
                content:     '{}',
                contentType: 'application/json' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   now,
                updatedAt:   now,
            };

            mockBackend.get = mock(async () => existingCheckpoint);

            const result = await manager.updateLastSeen(channelId, guildId, now, messageId);

            expect(result.lastSeenMessageId).toBe(messageId);
            expect(mockBackend.update).toHaveBeenCalledTimes(1);
        });

        test('should handle DM guild ID', async () => {
            mockBackend.get = mock(async () => undefined);

            const result = await manager.updateLastSeen(channelId, 'DM', now, '111222333');

            expect(result.guildId).toBe('DM');
        });
    });

    describe('listAll', () => {
        test('should return empty array when no checkpoints exist', async () => {
            mockBackend.list = mock(async () => ({ items: [], nextCursor: undefined }));

            const result = await manager.listAll();

            expect(result).toEqual([]);
            expect(mockBackend.list).toHaveBeenCalledTimes(1);
            expect(mockBackend.list).toHaveBeenCalledWith('/state/services/discord/channels');
        });

        test('should return all checkpoint items', async () => {
            const checkpoint1: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId:  createChannelId('111111111'),
                guildId:    createGuildId('999999999'),
                lastSeenAt: now,
                updatedAt:  now,
            };

            const checkpoint2: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId:  createChannelId('222222222'),
                guildId:    'DM',
                lastSeenAt: now,
                updatedAt:  now,
            };

            mockBackend.list = mock(async () => ({
                items: [
                    {
                        path:        '/state/services/discord/channels/111111111/checkpoint' as MemoryPath,
                        content:     JSON.stringify(checkpoint1),
                        contentType: 'application/json' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   now,
                        updatedAt:   now,
                    },
                    {
                        path:        '/state/services/discord/channels/222222222/checkpoint' as MemoryPath,
                        content:     JSON.stringify(checkpoint2),
                        contentType: 'application/json' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   now,
                        updatedAt:   now,
                    },
                ],
                nextCursor: undefined,
            }));

            const result = await manager.listAll();

            expect(result).toHaveLength(2);
            expect(result[0]).toEqual(checkpoint1);
            expect(result[1]).toEqual(checkpoint2);
        });

        test('should skip non-checkpoint items', async () => {
            const checkpoint: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId:  createChannelId('111111111'),
                guildId:    createGuildId('999999999'),
                lastSeenAt: now,
                updatedAt:  now,
            };

            mockBackend.list = mock(async () => ({
                items: [
                    {
                        path:        '/state/services/discord/channels/111111111/checkpoint' as MemoryPath,
                        content:     JSON.stringify(checkpoint),
                        contentType: 'application/json' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   now,
                        updatedAt:   now,
                    },
                    {
                        path:        '/state/services/discord/channels/111111111/metadata' as MemoryPath,
                        content:     '{}',
                        contentType: 'application/json' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   now,
                        updatedAt:   now,
                    },
                ],
                nextCursor: undefined,
            }));

            const result = await manager.listAll();

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual(checkpoint);
        });

        test('should skip items that fail JSON parsing', async () => {
            const validCheckpoint: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId:  createChannelId('111111111'),
                guildId:    createGuildId('999999999'),
                lastSeenAt: now,
                updatedAt:  now,
            };

            mockBackend.list = mock(async () => ({
                items: [
                    {
                        path:        '/state/services/discord/channels/111111111/checkpoint' as MemoryPath,
                        content:     JSON.stringify(validCheckpoint),
                        contentType: 'application/json' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   now,
                        updatedAt:   now,
                    },
                    {
                        path:        '/state/services/discord/channels/222222222/checkpoint' as MemoryPath,
                        content:     'invalid json',
                        contentType: 'application/json' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   now,
                        updatedAt:   now,
                    },
                ],
                nextCursor: undefined,
            }));

            const result = await manager.listAll();

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual(validCheckpoint);
        });

        test('should skip items that fail schema validation', async () => {
            const validCheckpoint: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId:  createChannelId('111111111'),
                guildId:    createGuildId('999999999'),
                lastSeenAt: now,
                updatedAt:  now,
            };

            // Create an object that is valid JSON but fails schema validation
            const invalidCheckpoint = {
                service:    'discord',
                channelId:  createChannelId('333333333'),
                guildId:    createGuildId('888888888'),
                lastSeenAt: 'not-a-valid-iso-date', // Invalid: not an ISO 8601 datetime
                updatedAt:  now,
            };

            mockBackend.list = mock(async () => ({
                items: [
                    {
                        path:        '/state/services/discord/channels/111111111/checkpoint' as MemoryPath,
                        content:     JSON.stringify(validCheckpoint),
                        contentType: 'application/json' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   now,
                        updatedAt:   now,
                    },
                    {
                        path:        '/state/services/discord/channels/333333333/checkpoint' as MemoryPath,
                        content:     JSON.stringify(invalidCheckpoint),
                        contentType: 'application/json' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   now,
                        updatedAt:   now,
                    },
                ],
                nextCursor: undefined,
            }));

            const result = await manager.listAll();

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual(validCheckpoint);
        });

        test('should filter items based on path ending with /checkpoint', async () => {
            const validCheckpoint: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId:  createChannelId('999999999'),
                guildId:    createGuildId('888888888'),
                lastSeenAt: now,
                updatedAt:  now,
            };

            mockBackend.list = mock(async () => ({
                items: [
                    {
                        // This has valid checkpoint data but wrong path suffix
                        path:        '/state/services/discord/channels/111111111/data' as MemoryPath,
                        content:     JSON.stringify(validCheckpoint),
                        contentType: 'application/json' as ContentType,
                        metadata:    {},
                        version:     1,
                        createdAt:   now,
                        updatedAt:   now,
                    },
                ],
                nextCursor: undefined,
            }));

            const result = await manager.listAll();

            // Should be filtered out because path doesn't end with '/checkpoint'
            expect(result).toHaveLength(0);
        });
    });
});
