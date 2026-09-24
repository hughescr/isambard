import { describe, test, expect, beforeEach, afterEach, jest } from 'bun:test';
import { createFakeOperationalStateStore, type FakeOperationalStateStore } from '../../../../helpers/fake-operational-state-store';
import { mockLogger } from '../../../../setup';
import { InvariantViolationError } from '@/errors';
import { CheckpointManager } from '@/integrations/discord/inbox/checkpoint-manager';
import { discordChannelCheckpointSchema, type DiscordChannelCheckpoint } from '@/integrations/discord/inbox/types';
import { createChannelId, createGuildId } from '@/integrations/discord/types';
import type { OperationalStateKey, OperationalStateStore } from '@/storage/operational-state';

describe('CheckpointManager', () => {
    let store: FakeOperationalStateStore;
    let manager: CheckpointManager;

    const channelId = createChannelId('123456789');
    const guildId = createGuildId('987654321');
    const now = '2025-01-24T10:00:00.000Z';
    const key: OperationalStateKey = { owner: 'discord', name: 'channels/123456789/checkpoint' };

    function checkpoint(overrides: Partial<DiscordChannelCheckpoint> = {}): DiscordChannelCheckpoint {
        return { service: 'discord', channelId, guildId, lastSeenAt: now, updatedAt: now, ...overrides };
    }

    beforeEach(() => {
        store = createFakeOperationalStateStore();
        manager = new CheckpointManager({ store });
        mockLogger.warn.mockClear();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    describe('load', () => {
        test('returns the stored checkpoint read from the channel key with the checkpoint schema, without warning', async () => {
            const saved = checkpoint({ lastSeenMessageId: '111222333' });
            store.seed(key, saved);

            await expect(manager.load(channelId)).resolves.toEqual(saved);
            expect(store.read).toHaveBeenCalledTimes(1);
            expect(store.read).toHaveBeenCalledWith(key, discordChannelCheckpointSchema);
            expect(mockLogger.warn).not.toHaveBeenCalled();
        });

        test('returns undefined without warning when no checkpoint exists', async () => {
            await expect(manager.load(channelId)).resolves.toBeUndefined();
            expect(mockLogger.warn).not.toHaveBeenCalled();
        });

        test('returns undefined and warns with the JSON message and error when the row is not JSON', async () => {
            store.seedRaw(key, 'invalid json');

            await expect(manager.load(channelId)).resolves.toBeUndefined();
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledWith({
                channelId,
                err: expect.any(SyntaxError),
                msg: 'Checkpoint data is corrupt: failed to parse JSON',
            });
        });

        test('returns undefined and warns with the schema message and error when the row fails validation', async () => {
            store.seed(key, { service: 'discord', channelId, guildId, lastSeenAt: 12_345, updatedAt: now });

            await expect(manager.load(channelId)).resolves.toBeUndefined();
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledWith({
                channelId,
                err: expect.objectContaining({ issues: expect.any(Array) }),
                msg: 'Checkpoint data is corrupt: schema validation failed',
            });
        });

        test('returns a checkpoint without the optional lastSeenMessageId unchanged', async () => {
            store.seed(key, checkpoint());
            const result = await manager.load(channelId);
            expect(result).toEqual(checkpoint());
            expect(result?.lastSeenMessageId).toBeUndefined();
        });
    });

    describe('save', () => {
        test('puts the checkpoint under its channel key exactly once without reading first', async () => {
            const saved = checkpoint({ lastSeenMessageId: '111222333' });

            await manager.save(saved);

            expect(store.put).toHaveBeenCalledTimes(1);
            expect(store.put).toHaveBeenCalledWith(key, saved);
            expect(store.read).not.toHaveBeenCalled();
        });

        test('overwrites an existing checkpoint with one put', async () => {
            store.seed(key, checkpoint());
            const next = checkpoint({ lastSeenAt: '2025-01-24T11:00:00.000Z' });

            await manager.save(next);

            expect(store.put).toHaveBeenCalledTimes(1);
            expect(store.stored(key)).toEqual(next);
        });
    });

    describe('initializeIfMissing', () => {
        test('puts a fresh checkpoint stamped with the current time when none exists', async () => {
            jest.useFakeTimers();
            jest.setSystemTime(new Date(now));

            const result = await manager.initializeIfMissing(channelId, guildId);

            expect(result).toEqual(checkpoint());
            expect(store.put).toHaveBeenCalledTimes(1);
            expect(store.put).toHaveBeenCalledWith(key, checkpoint());
        });

        test('returns an existing checkpoint without putting', async () => {
            const existing = checkpoint({ lastSeenMessageId: '111222333' });
            store.seed(key, existing);

            await expect(manager.initializeIfMissing(channelId, guildId)).resolves.toEqual(existing);
            expect(store.put).not.toHaveBeenCalled();
        });

        test('initializes a checkpoint with DM as guildId', async () => {
            const result = await manager.initializeIfMissing(channelId, 'DM');
            expect(result.guildId).toBe('DM');
            expect(store.put).toHaveBeenCalledTimes(1);
        });
    });

    describe('updateLastSeen', () => {
        test('puts a checkpoint with every field when none exists', async () => {
            jest.useFakeTimers();
            jest.setSystemTime(new Date('2025-01-24T12:00:00.000Z'));

            const result = await manager.updateLastSeen(channelId, guildId, now, '111222333');

            const expected: DiscordChannelCheckpoint = {
                service: 'discord', channelId, guildId, lastSeenAt: now, lastSeenMessageId: '111222333', updatedAt: '2025-01-24T12:00:00.000Z', handled: undefined,
            };
            expect(result).toEqual(expected);
            expect(store.put).toHaveBeenCalledTimes(1);
            expect(store.put).toHaveBeenCalledWith(key, expected);
        });

        test('puts a checkpoint without the optional messageId', async () => {
            const result = await manager.updateLastSeen(channelId, guildId, now);
            expect(result.lastSeenMessageId).toBeUndefined();
            expect(store.put).toHaveBeenCalledTimes(1);
        });

        test('handles the DM guild ID', async () => {
            const result = await manager.updateLastSeen(channelId, 'DM', now, '111222333');
            expect(result.guildId).toBe('DM');
        });

        test('preserves the handled watermark of the existing checkpoint', async () => {
            const handled = { messageId: '111222333', at: now };
            store.seed(key, checkpoint({ handled }));

            const result = await manager.updateLastSeen(channelId, guildId, '2025-01-24T11:00:00.000Z', '999888777');

            expect(result.handled).toEqual(handled);
            expect(result.lastSeenAt).toBe('2025-01-24T11:00:00.000Z');
            expect(result.lastSeenMessageId).toBe('999888777');
            expect(store.stored(key)).toEqual(result);
        });

        test('drops the handled watermark and warns when the existing checkpoint is corrupt', async () => {
            store.seedRaw(key, '{corrupt');

            const result = await manager.updateLastSeen(channelId, guildId, now, '111222333');

            expect(result.handled).toBeUndefined();
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(store.put).toHaveBeenCalledTimes(1);
        });
    });

    describe('updateHandled', () => {
        test('sets the handled watermark preserving lastSeen fields and guildId, and puts the result', async () => {
            jest.useFakeTimers();
            jest.setSystemTime(new Date('2025-01-24T12:00:00.000Z'));
            const existing = checkpoint({ lastSeenMessageId: '555666777' });
            store.seed(key, existing);

            const result = await manager.updateHandled(channelId, '555666777', '2025-01-24T10:01:00.000Z');

            expect(result).toEqual({ ...existing, handled: { messageId: '555666777', at: '2025-01-24T10:01:00.000Z' }, updatedAt: '2025-01-24T12:00:00.000Z' });
            expect(store.put).toHaveBeenCalledTimes(1);
            expect(store.put).toHaveBeenCalledWith(key, result);
        });

        test('advances an existing handled watermark when the new snowflake is greater', async () => {
            store.seed(key, checkpoint({ handled: { messageId: '111111111', at: '2025-01-24T09:00:00.000Z' } }));

            const result = await manager.updateHandled(channelId, '222222222', '2025-01-24T10:05:00.000Z');

            expect(result.handled).toEqual({ messageId: '222222222', at: '2025-01-24T10:05:00.000Z' });
            expect(store.put).toHaveBeenCalledTimes(1);
        });

        test('does not put when the existing watermark is numerically greater (snowflake compare)', async () => {
            const existing = checkpoint({ handled: { messageId: '999999999999999999', at: now } });
            store.seed(key, existing);

            // Older messageId (numerically smaller, even though shorter string) must not regress the watermark
            const result = await manager.updateHandled(channelId, '111111111', '2025-01-24T10:02:00.000Z');

            expect(result).toEqual(existing);
            expect(store.put).not.toHaveBeenCalled();
        });

        test('does not put when the existing watermark messageId exactly equals the new one', async () => {
            const existing = checkpoint({ handled: { messageId: '555666777', at: '2025-01-24T09:00:00.000Z' } });
            store.seed(key, existing);

            // A retry of the same batch must not overwrite the watermark's `at` either (>= must include equal).
            const result = await manager.updateHandled(channelId, '555666777', '2025-01-24T10:05:00.000Z');

            expect(result.handled).toEqual(existing.handled);
            expect(store.put).not.toHaveBeenCalled();
        });

        test('throws the no-checkpoint InvariantViolationError when no checkpoint exists', async () => {
            const attempt = manager.updateHandled(channelId, '111222333', now);
            await expect(attempt).rejects.toBeInstanceOf(InvariantViolationError);
            await expect(attempt).rejects.toThrow(
                'Invariant violated in updateHandled: no checkpoint exists for channel 123456789; receipt must initialise it first'
            );
            expect(store.put).not.toHaveBeenCalled();
        });

        test('throws the corrupt InvariantViolationError when the existing checkpoint is not JSON', async () => {
            store.seedRaw(key, 'not json');
            const attempt = manager.updateHandled(channelId, '111222333', now);
            await expect(attempt).rejects.toBeInstanceOf(InvariantViolationError);
            await expect(attempt).rejects.toThrow('Invariant violated in updateHandled: checkpoint for channel 123456789 is corrupt');
            expect(store.put).not.toHaveBeenCalled();
        });

        test('throws the corrupt InvariantViolationError when the existing checkpoint fails schema validation', async () => {
            store.seed(key, { service: 'discord' });
            await expect(manager.updateHandled(channelId, '111222333', now)).rejects.toThrow(
                'Invariant violated in updateHandled: checkpoint for channel 123456789 is corrupt'
            );
        });

        test('does not lose either field when updateLastSeen and updateHandled interleave for the same channel', async () => {
            store.seed(key, checkpoint());

            // The FIRST read is gated behind a controllable promise so both operations'
            // read-modify-write cycles are attempted concurrently; the per-channel promise chain
            // must serialise them instead of interleaving.
            let releaseFirstRead: (() => void) | undefined;
            const firstReadGate = new Promise<void>((resolve) => {
                releaseFirstRead = resolve;
            });
            let readCount = 0;
            const gated: OperationalStateStore = {
                ...store,
                read: async (k, schema) => {
                    readCount++;
                    if(readCount === 1) {
                        await firstReadGate;
                    }
                    return store.read(k, schema);
                },
            };
            const gatedManager = new CheckpointManager({ store: gated });

            const lastSeenPromise = gatedManager.updateLastSeen(channelId, guildId, '2025-01-24T11:00:00.000Z', '222222222');
            const handledPromise = gatedManager.updateHandled(channelId, '111222333', '2025-01-24T10:05:00.000Z');
            releaseFirstRead!();

            const [lastSeenResult, handledResult] = await Promise.all([lastSeenPromise, handledPromise]);

            expect(lastSeenResult.lastSeenAt).toBe('2025-01-24T11:00:00.000Z');
            expect(handledResult.handled).toEqual({ messageId: '111222333', at: '2025-01-24T10:05:00.000Z' });
            // The final write carries both the updated lastSeen and the handled watermark.
            expect(handledResult.lastSeenAt).toBe('2025-01-24T11:00:00.000Z');
            expect(store.stored(key)).toEqual(handledResult);
            expect(readCount).toBe(2);
        });
    });

    describe('listAll', () => {
        test('lists the discord channels/ prefix with the checkpoint schema', async () => {
            await expect(manager.listAll()).resolves.toEqual([]);
            expect(store.listByPrefix).toHaveBeenCalledTimes(1);
            expect(store.listByPrefix).toHaveBeenCalledWith({ owner: 'discord', name: 'channels/' }, discordChannelCheckpointSchema);
        });

        test('returns every checkpoint the store lists', async () => {
            const first = checkpoint({ channelId: createChannelId('111') });
            const second = checkpoint({ channelId: createChannelId('222'), lastSeenMessageId: '999' });
            store.seed({ owner: 'discord', name: 'channels/111/checkpoint' }, first);
            store.seed({ owner: 'discord', name: 'channels/222/checkpoint' }, second);

            await expect(manager.listAll()).resolves.toEqual([first, second]);
        });
    });
});
