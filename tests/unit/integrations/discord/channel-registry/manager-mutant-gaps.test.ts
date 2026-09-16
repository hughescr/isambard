import { describe, test, expect, beforeEach, mock } from 'bun:test';
import type { Channel, Client } from 'discord.js';
import type { ChannelRegistryBackend } from '@/integrations/discord/channel-registry/backend';
import { ChannelRegistryManager } from '@/integrations/discord/channel-registry/manager';
import type { ChannelMetadata, ChannelStorageRecord } from '@/integrations/discord/channel-registry/types';
import { createChannelId, createGuildId } from '@/integrations/discord/types';

function deferred<T>() {
    let finish!: (value: T) => void;
    const promise = new Promise<T>((resolve) => {
        finish = resolve;
    });
    return { promise, resolve: finish };
}

describe('ChannelRegistryManager mutation contracts', () => {
    const homeGuildId = createGuildId('home');
    const channelId = createChannelId('channel');
    let backend: ChannelRegistryBackend;
    let client: Client;
    let manager: ChannelRegistryManager;

    const record = (overrides: Partial<ChannelStorageRecord> = {}): ChannelStorageRecord => ({
        channelId,
        guildId:   homeGuildId,
        isMuted:   false,
        createdAt: '2024-01-02T03:04:05.000Z',
        updatedAt: '2025-02-03T04:05:06.000Z',
        ...overrides,
    });
    const metadata = (overrides: Partial<ChannelMetadata> = {}): ChannelMetadata => ({
        channelId,
        guildId:      homeGuildId,
        channelName:  'general',
        isMuted:      false,
        discoveredAt: '2024-01-02T03:04:05.000Z',
        lastSeenAt:   '2025-01-01T00:00:00.000Z',
        updatedAt:    '2025-02-03T04:05:06.000Z',
        ...overrides,
    });

    beforeEach(() => {
        backend = {
            getAllChannels:      mock(() => Promise.resolve([])),
            getChannel:          mock(() => Promise.resolve(null)),
            upsertChannel:       mock(() => Promise.resolve()),
            deleteChannel:       mock(() => Promise.resolve()),
            getChannelsByGuild:  mock(() => Promise.resolve([])),
            getWellKnownChannel: mock(() => Promise.resolve(null)),
            muteChannel:         mock(() => Promise.resolve()),
            unmuteChannel:       mock(() => Promise.resolve()),
            markAsWellKnown:     mock(() => Promise.resolve()),
            unmarkAsWellKnown:   mock(() => Promise.resolve()),
        } as unknown as ChannelRegistryBackend;
        client = {
            channels: {
                cache: new Map(),
                fetch: mock(() => Promise.resolve({ id: channelId, name: 'general' } as unknown as Channel)),
            },
        } as unknown as Client;
        manager = new ChannelRegistryManager({ backend, homeGuildId, client });
    });

    test('restart callbacks retain their registration order', async () => {
        const calls: string[] = [];
        manager.onReady(() => {
            calls.push('first');
        });
        manager.onReady(() => {
            calls.push('second');
        });
        manager.stop();

        await manager.warmCache();
        await Bun.sleep(0);

        expect(calls).toEqual(['first', 'second']);
    });

    test('offReady removes only the selected middle callback', async () => {
        const calls: string[] = [];
        const first = () => {
            calls.push('first');
        };
        const removed = () => {
            calls.push('removed');
        };
        const third = () => {
            calls.push('third');
        };
        manager.onReady(first);
        manager.onReady(removed);
        manager.onReady(third);
        manager.offReady(removed);
        manager.stop();

        await manager.warmCache();
        await Bun.sleep(0);

        expect(calls).toEqual(['first', 'third']);
    });

    test.each([
        ['upsert', (gate: ReturnType<typeof deferred<void>>) => {
            backend.upsertChannel = mock(() => gate.promise);
            return manager.upsertChannel(metadata());
        }],
        ['delete', (gate: ReturnType<typeof deferred<void>>) => {
            backend.deleteChannel = mock(() => gate.promise);
            return manager.deleteChannel(channelId);
        }],
        ['mark well known', (gate: ReturnType<typeof deferred<void>>) => {
            backend.markAsWellKnown = mock(() => gate.promise);
            return manager.markAsWellKnown(channelId, 'general');
        }],
    ])('%s resolves only after its backend write', async (_name, start) => {
        const gate = deferred<void>();
        let completed = false;
        const operation = start(gate).then(() => {
            completed = true;
            return undefined;
        });
        await Bun.sleep(0);
        try {
            expect(completed).toBe(false);
        } finally {
            gate.resolve();
            await operation;
        }
    });

    test.each([
        ['', '@Unknown'],
        ['prefix DM - alice', '@prefix DM - alice'],
        ['DMalice', '@DMalice'],
        ['DM - alice', '@alice'],
        ['DMbob', '@DMbob'],
        ['prefix @alice', '@prefix @alice'],
    ])('normalizes a DM name %p as %p', async (name, expected) => {
        backend.getChannel = mock(() => Promise.resolve(record({ guildId: createGuildId('DM') })));
        client.channels.fetch = mock(() => Promise.resolve({ id: channelId, name } as unknown as Channel));

        const result = await manager.getChannel(channelId);

        expect(result?.channelName).toBe(expected);
    });

    test('hydrates provenance timestamps from creation time and the fetch window', async () => {
        backend.getChannel = mock(() => Promise.resolve(record()));
        const before = new Date().toISOString();

        const result = await manager.getChannel(channelId);
        const after = new Date().toISOString();

        expect(result?.discoveredAt).toBe('2024-01-02T03:04:05.000Z');
        const lastSeenAt = result?.lastSeenAt;
        if(lastSeenAt === undefined) {
            throw new Error('Hydrated channel did not have lastSeenAt');
        }
        expect(lastSeenAt >= before).toBe(true);
        expect(lastSeenAt <= after).toBe(true);
        expect(lastSeenAt).not.toBe('2025-02-03T04:05:06.000Z');
    });

    test('getChannel does not complete before an uncached Discord fetch', async () => {
        const fetchGate = deferred<Channel | null>();
        backend.getChannel = mock(() => Promise.resolve(record()));
        client.channels.fetch = mock(() => fetchGate.promise);
        let completed = false;
        const operation = manager.getChannel(channelId).then((result) => {
            completed = true;
            return result;
        });
        await Bun.sleep(0);
        try {
            expect(completed).toBe(false);
        } finally {
            fetchGate.resolve({ id: channelId, name: 'general' } as unknown as Channel);
            await operation;
        }
    });
});
