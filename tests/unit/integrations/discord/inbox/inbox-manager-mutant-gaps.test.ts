import { describe, expect, mock, test } from 'bun:test';
import type { ChannelRegistryManager } from '@/integrations/discord/channel-registry/manager';
import type { CheckpointManager } from '@/integrations/discord/inbox/checkpoint-manager';
import { InboxManager } from '@/integrations/discord/inbox/inbox-manager';
import type { MessageSearchService } from '@/integrations/discord/message-history/search';
import { createChannelId, createGuildId, createUserId } from '@/integrations/discord/types';

const guildId = createGuildId('900');
const lastSeenAt = '2025-01-01T00:00:00.000Z';

function deferred<T>() {
    let fulfill!: (value: T) => void;
    const promise = new Promise<T>((resolve) => {
        fulfill = resolve;
    });
    return { promise, resolve: fulfill };
}

function dependencies(channelNames: string[]) {
    const channels = channelNames.map((channelName, index) => ({
        channelId: createChannelId(String(index + 1)),
        channelName,
        guildId,
        isMuted:   false,
    }));
    const checkpointManager = {
        initializeIfMissing: mock(async () => undefined),
        load:                mock(async (channelId: ReturnType<typeof createChannelId>) => ({
            service: 'discord' as const, channelId, guildId, lastSeenAt, updatedAt: lastSeenAt,
        })),
        updateLastSeen: mock(async () => undefined),
        updateHandled:  mock(async () => undefined),
    } as unknown as CheckpointManager;
    const messageSearchService = {
        searchMessages: mock(async ({ channelId }: { channelId: ReturnType<typeof createChannelId> }) => ({
            messages: [{
                id:          `message-${channelId}`,
                channelId,
                guildId,
                author:      { id: createUserId(`user-${channelId}`), username: 'user', displayName: 'User' },
                content:     `content-${channelId}`,
                timestamp:   '2025-01-02T00:00:00.000Z',
                attachments: [], embeds:      [], reactions:   [],
            }],
            metadata: { totalFound: 1, timeRange: { start: lastSeenAt, end: '2025-01-02T00:00:00.000Z' } },
        })),
    } as unknown as MessageSearchService;
    const channelRegistry = { getUnmutedChannels: mock(async () => channels) } as unknown as ChannelRegistryManager;
    return { channels, checkpointManager, messageSearchService, channelRegistry };
}

function makeManager(channelNames: string[], config?: ConstructorParameters<typeof InboxManager>[0]['config']) {
    const deps = dependencies(channelNames);
    const manager = new InboxManager({ ...deps, config });
    return { ...deps, manager };
}

describe('InboxManager mutation gap contracts', () => {
    test('applies caller catch-up configuration', async () => {
        const { manager, messageSearchService } = makeManager(['one'], { minGapDurationMs: 0, maxCatchUpMessages: 7 });

        await manager.loadUnread();

        expect(messageSearchService.searchMessages).toHaveBeenCalledWith(expect.objectContaining({ limit: 7 }));
    });

    test('initializes every requested channel before completing', async () => {
        const { manager, checkpointManager } = makeManager(['1', '2', '3', '4', '5', '6'], { minGapDurationMs: 0 });

        await manager.loadUnread();

        expect(checkpointManager.initializeIfMissing).toHaveBeenCalledTimes(6);
    });

    test('waits for checkpoint initialization before loading it', async () => {
        const { manager, checkpointManager } = makeManager(['one'], { minGapDurationMs: 0 });
        const gate = deferred<void>();
        checkpointManager.initializeIfMissing = mock(async () => gate.promise) as unknown as CheckpointManager['initializeIfMissing'];

        const loading = manager.loadUnread();
        try {
            await Promise.resolve();
            expect(checkpointManager.load).not.toHaveBeenCalled();
        } finally {
            gate.resolve();
            await loading;
        }
        expect(checkpointManager.load).toHaveBeenCalledTimes(1);
    });

    test('reports names and aggregates every unread channel', async () => {
        const { manager, channels } = makeManager(['first', 'second'], { minGapDurationMs: 0 });
        manager.updateChannelMetadata(channels[0].channelId, 'renamed-first', guildId);
        await manager.loadUnread();

        const overview = manager.getUnreadOverview();
        expect(overview.totalUnread).toBe(2);
        expect(overview.channels).toHaveLength(2);
        expect(overview.channels.find(channel => channel.channelId === channels[0].channelId)).toEqual({
            channelId: channels[0].channelId, channelName: 'renamed-first', messageCount: 1,
        });
        expect(overview.channels.find(channel => channel.channelId === channels[1].channelId)).toEqual({
            channelId: channels[1].channelId, channelName: channels[1].channelId, messageCount: 1,
        });
    });

    test('markAsRead resolves only after its checkpoint is stored', async () => {
        const { manager, checkpointManager, channels } = makeManager(['one'], { minGapDurationMs: 0 });
        await manager.loadUnread();
        const gate = deferred<void>();
        checkpointManager.updateLastSeen = mock(async () => gate.promise) as unknown as CheckpointManager['updateLastSeen'];
        let resolved = false;

        const marking = manager.markAsRead(channels[0].channelId, [`message-${channels[0].channelId}`]).then(() => {
            resolved = true;
            return resolved;
        });
        try {
            await Promise.resolve();
            expect(resolved).toBe(false);
        } finally {
            gate.resolve();
            await marking;
        }
        expect(resolved).toBe(true);
    });

    test('markChannelRead resolves only after its checkpoint is stored', async () => {
        const { manager, checkpointManager, channels } = makeManager(['one'], { minGapDurationMs: 0 });
        await manager.loadUnread();
        const gate = deferred<void>();
        checkpointManager.updateLastSeen = mock(async () => gate.promise) as unknown as CheckpointManager['updateLastSeen'];
        let resolved = false;

        const marking = manager.markChannelRead(channels[0].channelId).then(() => {
            resolved = true;
            return resolved;
        });
        try {
            await Promise.resolve();
            expect(resolved).toBe(false);
        } finally {
            gate.resolve();
            await marking;
        }
        expect(resolved).toBe(true);
    });

    test('recordActivity resolves only after persistence', async () => {
        const { manager, checkpointManager, channels } = makeManager(['one']);
        const gate = deferred<void>();
        checkpointManager.updateLastSeen = mock(async () => gate.promise) as unknown as CheckpointManager['updateLastSeen'];
        let resolved = false;
        const activity = manager.recordActivity(channels[0].channelId, guildId, 'message', lastSeenAt).then(() => {
            resolved = true;
            return resolved;
        });
        try {
            await Promise.resolve();
            expect(resolved).toBe(false);
        } finally {
            gate.resolve();
            await activity;
        }
        expect(resolved).toBe(true);
    });

    test('recordHandled resolves only after persistence', async () => {
        const { manager, checkpointManager, channels } = makeManager(['one']);
        const gate = deferred<void>();
        checkpointManager.updateHandled = mock(async () => gate.promise) as unknown as CheckpointManager['updateHandled'];
        let resolved = false;
        const handled = manager.recordHandled(channels[0].channelId, 'message', lastSeenAt).then(() => {
            resolved = true;
            return resolved;
        });
        try {
            await Promise.resolve();
            expect(resolved).toBe(false);
        } finally {
            gate.resolve();
            await handled;
        }
        expect(resolved).toBe(true);
    });
});
