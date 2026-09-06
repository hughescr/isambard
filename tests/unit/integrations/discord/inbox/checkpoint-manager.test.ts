import { describe, test, expect, beforeEach, afterEach, jest, mock } from 'bun:test';
import { mockLogger } from '../../../../setup';
import { InvariantViolationError } from '@/errors';
import { CheckpointManager } from '@/integrations/discord/inbox/checkpoint-manager';
import type { DiscordChannelCheckpoint } from '@/integrations/discord/inbox/types';
import { createChannelId, createGuildId } from '@/integrations/discord/types';
import type { MemoryToolBackend } from '@/storage/memory-tool/backend';
import type { MemoryToolItemData, MemoryPath, ContentType } from '@/storage/memory-tool/types';

describe('CheckpointManager', () => {
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
                createdAt:   now,
                updatedAt:   now,
            })),
            update: mock(async () => ({
                path:        '/state/services/discord/channels/123456789/checkpoint' as MemoryPath,
                content:     '{}',
                contentType: 'application/json' as ContentType,
                metadata:    {},
                createdAt:   now,
                updatedAt:   now,
            })),
            list:         mock(async () => ({ items: [], nextCursor: undefined })),
            listByLayer:  mock(async () => ({ items: [], nextCursor: undefined })),
            searchByTags: mock(async () => ({ items: [], nextCursor: undefined })),
        } as unknown as MemoryToolBackend;

        manager = new CheckpointManager({ backend: mockBackend });
        mockLogger.warn.mockClear();
    });

    afterEach(() => {
        jest.restoreAllMocks();
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

        test('should return undefined when checkpoint does not exist (no warn logged)', async () => {
            mockBackend.get = mock(async () => undefined);

            const result = await manager.load(channelId);
            expect(result).toBeUndefined();
            // "missing" must NOT produce a warn — only "corrupt" does
            expect(mockLogger.warn).not.toHaveBeenCalled();
        });

        test('should return undefined and log warn when JSON parsing fails (corrupt)', async () => {
            mockBackend.get = mock(async () => ({
                path:        '/state/services/discord/channels/123456789/checkpoint' as MemoryPath,
                content:     'invalid json',
                contentType: 'application/json' as ContentType,
                metadata:    {},
                createdAt:   now,
                updatedAt:   now,
            }));

            const result = await manager.load(channelId);
            expect(result).toBeUndefined();
            // Corrupt data must produce a warn with the JSON-parse-specific message
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    msg: 'Checkpoint data is corrupt: failed to parse JSON',
                })
            );
        });

        test('should return undefined and log warn when schema validation fails (corrupt)', async () => {
            mockBackend.get = mock(async () => ({
                path:        '/state/services/discord/channels/123456789/checkpoint' as MemoryPath,
                // Valid JSON but fails schema: lastSeenAt must be ISO datetime string
                content:     JSON.stringify({ service: 'discord', channelId, guildId, lastSeenAt: 12_345, updatedAt: now }),
                contentType: 'application/json' as ContentType,
                metadata:    {},
                createdAt:   now,
                updatedAt:   now,
            }));

            const result = await manager.load(channelId);
            expect(result).toBeUndefined();
            // Corrupt data must produce a warn distinguishing it from missing
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    msg: expect.stringContaining('corrupt'),
                })
            );
        });

        test('should return undefined when JSON parsing fails', async () => {
            mockBackend.get = mock(async () => ({
                path:        '/state/services/discord/channels/123456789/checkpoint' as MemoryPath,
                content:     'invalid json',
                contentType: 'application/json' as ContentType,
                metadata:    {},
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
                createdAt:   now,
                updatedAt:   now,
            }));

            await manager.save(checkpoint);

            expect(mockBackend.get).toHaveBeenCalledTimes(1);
            expect(mockBackend.create).toHaveBeenCalledTimes(1);
            expect(mockBackend.update).not.toHaveBeenCalled();

            const createCall = (mockBackend.create as ReturnType<typeof mock>).mock.calls[0][0] as { path: string, content: string, contentType: string };
            expect(createCall.path).toBe('/state/services/discord/channels/123456789/checkpoint');
            expect(createCall.content).toBe(JSON.stringify(checkpoint));
            expect(createCall.contentType).toBe('application/json');
        });

        test('should update existing checkpoint', async () => {
            const existingCheckpoint: MemoryToolItemData = {
                path:        '/state/services/discord/channels/123456789/checkpoint' as MemoryPath,
                content:     '{}',
                contentType: 'application/json',
                metadata:    {},
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
                updatedAt: now,
            }));

            await manager.save(updatedCheckpoint);

            expect(mockBackend.get).toHaveBeenCalledTimes(1);
            expect(mockBackend.update).toHaveBeenCalledTimes(1);
            expect(mockBackend.create).not.toHaveBeenCalled();

            const updateCall = (mockBackend.update as ReturnType<typeof mock>).mock.calls[0] as [string, { content: string }];
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
            const createCall = (mockBackend.create as ReturnType<typeof mock>).mock.calls[0][0] as { content: string };
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
                contentType: 'application/json',
                metadata:    {},
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

        test('should preserve handled watermark set by a prior updateHandled', async () => {
            const existingWithHandled: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId,
                guildId,
                lastSeenAt: now,
                updatedAt:  now,
                handled:    { messageId: '111222333', at: now },
            };

            mockBackend.get = mock(async () => ({
                path:        '/state/services/discord/channels/123456789/checkpoint' as MemoryPath,
                content:     JSON.stringify(existingWithHandled),
                contentType: 'application/json' as ContentType,
                metadata:    {},
                createdAt:   now,
                updatedAt:   now,
            }));

            const result = await manager.updateLastSeen(channelId, guildId, '2025-01-24T11:00:00.000Z', '999888777');

            expect(result.handled).toEqual(existingWithHandled.handled);
            expect(result.lastSeenAt).toBe('2025-01-24T11:00:00.000Z');
            expect(result.lastSeenMessageId).toBe('999888777');
        });
    });

    describe('updateHandled', () => {
        test('should set handled watermark preserving lastSeen* and guildId', async () => {
            const existing: DiscordChannelCheckpoint = {
                service:           'discord',
                channelId,
                guildId,
                lastSeenAt:        now,
                lastSeenMessageId: '555666777',
                updatedAt:         now,
            };

            mockBackend.get = mock(async () => ({
                path:        '/state/services/discord/channels/123456789/checkpoint' as MemoryPath,
                content:     JSON.stringify(existing),
                contentType: 'application/json' as ContentType,
                metadata:    {},
                createdAt:   now,
                updatedAt:   now,
            }));

            const result = await manager.updateHandled(channelId, '555666777', '2025-01-24T10:01:00.000Z');

            expect(result.handled).toEqual({ messageId: '555666777', at: '2025-01-24T10:01:00.000Z' });
            expect(result.lastSeenAt).toBe(existing.lastSeenAt);
            expect(result.lastSeenMessageId).toBe(existing.lastSeenMessageId);
            expect(result.guildId).toBe(existing.guildId);
            expect(mockBackend.update).toHaveBeenCalledTimes(1);
        });

        test('should no-op when the existing watermark messageId is already >= the new one (snowflake compare)', async () => {
            const existing: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId,
                guildId,
                lastSeenAt: now,
                updatedAt:  now,
                handled:    { messageId: '999999999999999999', at: now },
            };

            mockBackend.get = mock(async () => ({
                path:        '/state/services/discord/channels/123456789/checkpoint' as MemoryPath,
                content:     JSON.stringify(existing),
                contentType: 'application/json' as ContentType,
                metadata:    {},
                createdAt:   now,
                updatedAt:   now,
            }));

            // Older messageId (numerically smaller, even though shorter string) must not regress the watermark
            const result = await manager.updateHandled(channelId, '111111111', '2025-01-24T10:02:00.000Z');

            expect(result.handled).toEqual(existing.handled);
            expect(mockBackend.update).not.toHaveBeenCalled();
        });

        test('should no-op (not write) when the existing watermark messageId exactly equals the new one', async () => {
            const existing: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId,
                guildId,
                lastSeenAt: now,
                updatedAt:  now,
                handled:    { messageId: '555666777', at: '2025-01-24T09:00:00.000Z' },
            };

            mockBackend.get = mock(async () => ({
                path:        '/state/services/discord/channels/123456789/checkpoint' as MemoryPath,
                content:     JSON.stringify(existing),
                contentType: 'application/json' as ContentType,
                metadata:    {},
                createdAt:   now,
                updatedAt:   now,
            }));

            // Same messageId as the existing watermark, but a different `at` — a retry of the
            // same batch must not overwrite the watermark's `at` either (>= must include equal).
            const result = await manager.updateHandled(channelId, '555666777', '2025-01-24T10:05:00.000Z');

            expect(result.handled).toEqual(existing.handled);
            expect(mockBackend.update).not.toHaveBeenCalled();
        });

        test('should throw InvariantViolationError when no checkpoint item exists', async () => {
            mockBackend.get = mock(async () => undefined);

            await expect(manager.updateHandled(channelId, '111222333', now)).rejects.toThrow(InvariantViolationError);
        });

        test('should throw InvariantViolationError when the existing checkpoint item is corrupt (invalid JSON)', async () => {
            mockBackend.get = mock(async () => ({
                path:        '/state/services/discord/channels/123456789/checkpoint' as MemoryPath,
                content:     'not json',
                contentType: 'application/json' as ContentType,
                metadata:    {},
                createdAt:   now,
                updatedAt:   now,
            }));

            await expect(manager.updateHandled(channelId, '111222333', now)).rejects.toThrow(InvariantViolationError);
        });

        test('should throw InvariantViolationError when the existing checkpoint item fails schema validation', async () => {
            mockBackend.get = mock(async () => ({
                path:        '/state/services/discord/channels/123456789/checkpoint' as MemoryPath,
                content:     JSON.stringify({ service: 'discord' }),
                contentType: 'application/json' as ContentType,
                metadata:    {},
                createdAt:   now,
                updatedAt:   now,
            }));

            await expect(manager.updateHandled(channelId, '111222333', now)).rejects.toThrow(InvariantViolationError);
        });

        test('should not lose either field when updateLastSeen and updateHandled interleave for the same channel', async () => {
            const path = '/state/services/discord/channels/123456789/checkpoint' as MemoryPath;
            const initial: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId,
                guildId,
                lastSeenAt: now,
                updatedAt:  now,
            };

            // Stateful fake backend: get() reflects the latest create()/update(), and the FIRST
            // get() call is gated behind a controllable promise so we can force the two
            // operations' read-modify-write cycles to be attempted concurrently and prove the
            // per-channel promise chain serialises them instead of interleaving.
            let stored: MemoryToolItemData = {
                path,
                content:     JSON.stringify(initial),
                contentType: 'application/json',
                metadata:    {},
                createdAt:   now,
                updatedAt:   now,
            };

            let releaseFirstGet: (() => void) | undefined;
            const firstGetGate = new Promise<void>((resolve) => {
                releaseFirstGet = resolve;
            });

            let getCallCount = 0;
            mockBackend.get = mock(async () => {
                getCallCount++;
                if(getCallCount === 1) {
                    await firstGetGate;
                }
                return stored;
            });
            mockBackend.update = mock(async (_path: MemoryPath, patch: { content: string }) => {
                stored = { ...stored, content: patch.content, updatedAt: new Date().toISOString() };
                return stored;
            });

            // Kick off updateLastSeen first (its get is gated/delayed)
            const lastSeenPromise = manager.updateLastSeen(channelId, guildId, '2025-01-24T11:00:00.000Z', '222222222');
            // Kick off updateHandled second — per-channel serialisation must make it wait for
            // updateLastSeen's write to finish before starting its own get/update cycle.
            const handledPromise = manager.updateHandled(channelId, '111222333', '2025-01-24T10:05:00.000Z');

            // Release the gated first get, allowing updateLastSeen to complete
            releaseFirstGet!();

            const [lastSeenResult, handledResult] = await Promise.all([lastSeenPromise, handledPromise]);

            expect(lastSeenResult.lastSeenAt).toBe('2025-01-24T11:00:00.000Z');
            expect(handledResult.handled).toEqual({ messageId: '111222333', at: '2025-01-24T10:05:00.000Z' });
            // The final write must carry both the updated lastSeen and the handled watermark —
            // neither operation's get/update cycle may have interleaved with the other's.
            expect(handledResult.lastSeenAt).toBe('2025-01-24T11:00:00.000Z');
            expect(getCallCount).toBe(2);
        });
    });

    describe('listAll', () => {
        test('should return empty array when no checkpoints exist', async () => {
            mockBackend.list = mock<MemoryToolBackend['list']>(async () => ({ items: [], nextCursor: undefined }));

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

            mockBackend.list = mock<MemoryToolBackend['list']>(async () => ({
                items: [
                    {
                        path:        '/state/services/discord/channels/111111111/checkpoint' as MemoryPath,
                        content:     JSON.stringify(checkpoint1),
                        contentType: 'application/json',
                        metadata:    {},
                        createdAt:   now,
                        updatedAt:   now,
                    },
                    {
                        path:        '/state/services/discord/channels/222222222/checkpoint' as MemoryPath,
                        content:     JSON.stringify(checkpoint2),
                        contentType: 'application/json',
                        metadata:    {},
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

            mockBackend.list = mock<MemoryToolBackend['list']>(async () => ({
                items: [
                    {
                        path:        '/state/services/discord/channels/111111111/checkpoint' as MemoryPath,
                        content:     JSON.stringify(checkpoint),
                        contentType: 'application/json',
                        metadata:    {},
                        createdAt:   now,
                        updatedAt:   now,
                    },
                    {
                        path:        '/state/services/discord/channels/111111111/metadata' as MemoryPath,
                        content:     '{}',
                        contentType: 'application/json',
                        metadata:    {},
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

            mockBackend.list = mock<MemoryToolBackend['list']>(async () => ({
                items: [
                    {
                        path:        '/state/services/discord/channels/111111111/checkpoint' as MemoryPath,
                        content:     JSON.stringify(validCheckpoint),
                        contentType: 'application/json',
                        metadata:    {},
                        createdAt:   now,
                        updatedAt:   now,
                    },
                    {
                        path:        '/state/services/discord/channels/222222222/checkpoint' as MemoryPath,
                        content:     'invalid json',
                        contentType: 'application/json',
                        metadata:    {},
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

            mockBackend.list = mock<MemoryToolBackend['list']>(async () => ({
                items: [
                    {
                        path:        '/state/services/discord/channels/111111111/checkpoint' as MemoryPath,
                        content:     JSON.stringify(validCheckpoint),
                        contentType: 'application/json',
                        metadata:    {},
                        createdAt:   now,
                        updatedAt:   now,
                    },
                    {
                        path:        '/state/services/discord/channels/333333333/checkpoint' as MemoryPath,
                        content:     JSON.stringify(invalidCheckpoint),
                        contentType: 'application/json',
                        metadata:    {},
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

            mockBackend.list = mock<MemoryToolBackend['list']>(async () => ({
                items: [
                    {
                        // This has valid checkpoint data but wrong path suffix
                        path:        '/state/services/discord/channels/111111111/data' as MemoryPath,
                        content:     JSON.stringify(validCheckpoint),
                        contentType: 'application/json',
                        metadata:    {},
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
