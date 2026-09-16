import { afterEach, describe, expect, jest, mock, test } from 'bun:test';
import { CheckpointManager } from '@/integrations/discord/inbox/checkpoint-manager';
import type { DiscordChannelCheckpoint } from '@/integrations/discord/inbox/types';
import { createChannelId, createGuildId } from '@/integrations/discord/types';
import type { MemoryToolBackend } from '@/storage/memory-tool/backend';
import type { MemoryPath, MemoryToolItemData } from '@/storage/memory-tool/types';

const channelId = createChannelId('123456789');
const guildId = createGuildId('987654321');
const persistedAt = '2025-01-24T10:00:00.000Z';
const updatedAt = '2030-01-24T10:00:00.000Z';

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

function item(content: string, path = '/state/services/discord/channels/123456789/checkpoint'): MemoryToolItemData {
    return {
        path:        path as MemoryPath,
        content,
        contentType: 'application/json',
        metadata:    {},
        createdAt:   persistedAt,
        updatedAt:   persistedAt,
    };
}

function backend(): MemoryToolBackend {
    return {
        get:          mock(async () => undefined),
        create:       mock(async () => item('{}')),
        update:       mock(async () => item('{}')),
        list:         mock(async () => ({ items: [], nextCursor: undefined })),
        listByLayer:  mock(async () => ({ items: [], nextCursor: undefined })),
        searchByTags: mock(async () => ({ items: [], nextCursor: undefined })),
    } as unknown as MemoryToolBackend;
}

afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
});

describe('CheckpointManager mutation gap contracts', () => {
    test('save rejects when updating an existing checkpoint fails', async () => {
        const store = backend();
        const saved = checkpoint();
        store.get = mock(async () => item(JSON.stringify(saved)));
        store.update = mock(async () => {
            throw new Error('storage unavailable');
        });

        await expect(new CheckpointManager({ backend: store }).save(saved)).rejects.toThrow('storage unavailable');
    });

    test('initialization rejects when checkpoint creation fails', async () => {
        const store = backend();
        store.create = mock(async () => {
            throw new Error('storage unavailable');
        });

        await expect(new CheckpointManager({ backend: store }).initializeIfMissing(channelId, guildId)).rejects.toThrow('storage unavailable');
    });

    test('updating last seen rejects when checkpoint creation fails', async () => {
        const store = backend();
        store.create = mock(async () => {
            throw new Error('storage unavailable');
        });

        await expect(new CheckpointManager({ backend: store }).updateLastSeen(channelId, guildId, persistedAt)).rejects.toThrow('storage unavailable');
    });

    test('advancing a handled watermark rejects when persistence fails', async () => {
        const store = backend();
        store.get = mock(async () => item(JSON.stringify(checkpoint())));
        store.update = mock(async () => {
            throw new Error('storage unavailable');
        });

        await expect(new CheckpointManager({ backend: store }).updateHandled(channelId, '101', updatedAt)).rejects.toThrow('storage unavailable');
    });

    test('advances the handled watermark by one snowflake', async () => {
        const store = backend();
        store.get = mock(async () => item(JSON.stringify(checkpoint({
            handled: { messageId: '100', at: persistedAt },
        }))));

        const result = await new CheckpointManager({ backend: store }).updateHandled(channelId, '101', updatedAt);

        expect(result.handled).toEqual({ messageId: '101', at: updatedAt });
        expect(store.update).toHaveBeenCalledTimes(1);
    });

    test('timestamps handled watermark advancement at the write time', async () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date(updatedAt));
        const store = backend();
        store.get = mock(async () => item(JSON.stringify(checkpoint())));

        const result = await new CheckpointManager({ backend: store }).updateHandled(channelId, '101', persistedAt);

        expect(result.updatedAt).toBe(updatedAt);
    });

    test('lists only terminal, absolute checkpoint paths', async () => {
        const store = backend();
        const saved = checkpoint();
        store.list = mock(async () => ({
            items: [
                item(JSON.stringify(saved), '/state/services/discord/channels/123456789/checkpoint/metadata'),
                item(JSON.stringify(saved), 'checkpoint'),
            ],
            nextCursor: undefined,
        }));

        await expect(new CheckpointManager({ backend: store }).listAll()).resolves.toEqual([]);
    });

    test('lists every valid checkpoint returned by storage', async () => {
        const store = backend();
        const items = Array.from({ length: 101 }, (_, index) => {
            const channel = createChannelId(String(index + 1));
            return item(JSON.stringify(checkpoint({ channelId: channel })), `/state/services/discord/channels/${channel}/checkpoint`);
        });
        store.list = mock(async () => ({ items, nextCursor: undefined }));

        await expect(new CheckpointManager({ backend: store }).listAll()).resolves.toHaveLength(101);
    });
});
