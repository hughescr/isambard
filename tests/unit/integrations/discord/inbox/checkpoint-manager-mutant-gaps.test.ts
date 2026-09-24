import { afterEach, describe, expect, jest, test } from 'bun:test';
import { createFakeOperationalStateStore, type FakeOperationalStateStore } from '../../../../helpers/fake-operational-state-store';
import { CheckpointManager } from '@/integrations/discord/inbox/checkpoint-manager';
import type { DiscordChannelCheckpoint } from '@/integrations/discord/inbox/types';
import { createChannelId, createGuildId } from '@/integrations/discord/types';
import type { OperationalStateKey } from '@/storage/operational-state';

const channelId = createChannelId('123456789');
const guildId = createGuildId('987654321');
const persistedAt = '2025-01-24T10:00:00.000Z';
const updatedAt = '2030-01-24T10:00:00.000Z';
const key: OperationalStateKey = { owner: 'discord', name: 'channels/123456789/checkpoint' };

function checkpoint(overrides: Partial<DiscordChannelCheckpoint> = {}): DiscordChannelCheckpoint {
    return {
        service:    'discord',
        channelId,
        guildId,
        lastSeenAt: persistedAt,
        updatedAt:  persistedAt,
        ...overrides,
    };
}

function failingPutStore(): FakeOperationalStateStore {
    const store = createFakeOperationalStateStore();
    store.put.mockImplementation(async () => {
        throw new Error('storage unavailable');
    });
    return store;
}

afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
});

describe('CheckpointManager mutation gap contracts', () => {
    test('save rejects when the put fails', async () => {
        await expect(new CheckpointManager({ store: failingPutStore() }).save(checkpoint())).rejects.toThrow('storage unavailable');
    });

    test('initialization rejects when the put fails', async () => {
        await expect(new CheckpointManager({ store: failingPutStore() }).initializeIfMissing(channelId, guildId)).rejects.toThrow('storage unavailable');
    });

    test('updating last seen rejects when the put fails', async () => {
        await expect(new CheckpointManager({ store: failingPutStore() }).updateLastSeen(channelId, guildId, persistedAt)).rejects.toThrow('storage unavailable');
    });

    test('advancing a handled watermark rejects when the put fails', async () => {
        const store = failingPutStore();
        store.seed(key, checkpoint());

        await expect(new CheckpointManager({ store }).updateHandled(channelId, '101', updatedAt)).rejects.toThrow('storage unavailable');
    });

    test('advances the handled watermark by one snowflake', async () => {
        const store = createFakeOperationalStateStore();
        store.seed(key, checkpoint({ handled: { messageId: '100', at: persistedAt } }));

        const result = await new CheckpointManager({ store }).updateHandled(channelId, '101', updatedAt);

        expect(result.handled).toEqual({ messageId: '101', at: updatedAt });
        expect(store.put).toHaveBeenCalledTimes(1);
    });

    test('timestamps handled watermark advancement at the write time', async () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date(updatedAt));
        const store = createFakeOperationalStateStore();
        store.seed(key, checkpoint());

        const result = await new CheckpointManager({ store }).updateHandled(channelId, '101', persistedAt);

        expect(result.updatedAt).toBe(updatedAt);
    });

    test('lists every valid checkpoint returned by storage', async () => {
        const store = createFakeOperationalStateStore();
        for(let index = 1; index <= 101; index++) {
            const channel = createChannelId(String(index));
            store.seed({ owner: 'discord', name: `channels/${channel}/checkpoint` }, checkpoint({ channelId: channel }));
        }

        await expect(new CheckpointManager({ store }).listAll()).resolves.toHaveLength(101);
    });
});
