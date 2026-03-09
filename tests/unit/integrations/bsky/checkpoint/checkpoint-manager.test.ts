import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { BskyCheckpointManager } from '@/integrations/bsky/checkpoint/checkpoint-manager';
import { MAX_PROCESSED_URIS, type BskyFeedCheckpoint, type BskyNotificationCheckpoint } from '@/integrations/bsky/checkpoint/types';
import type { BskyFeedItem, BskyNotification } from '@/integrations/bsky/types';
import type { MemoryToolBackend } from '@/storage/memory-tool/backend';
import type { MemoryToolItemData, MemoryPath, ContentType } from '@/storage/memory-tool/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = '2026-03-07T12:00:00.000Z';

function makeItem(content: string): MemoryToolItemData {
    return {
        path:        '/state/services/bsky/feeds/following/checkpoint' as MemoryPath,
        content,
        contentType: 'application/json' as ContentType,
        metadata:    {},
        createdAt:   NOW,
        updatedAt:   NOW,
    };
}

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

const FEED_CHECKPOINT: BskyFeedCheckpoint = {
    service:       'bsky',
    type:          'feed',
    feedName:      'following',
    lastIndexedAt: '2026-03-07T12:00:00.000Z',
    processedUris: ['at://did:plc:abc/app.bsky.feed.post/123'],
    updatedAt:     '2026-03-07T12:00:01.000Z',
};

const NOTIF_CHECKPOINT: BskyNotificationCheckpoint = {
    service:       'bsky',
    type:          'notification',
    lastSeenAt:    '2026-03-07T12:00:00.000Z',
    processedUris: ['at://did:plc:abc/app.bsky.feed.like/456'],
    updatedAt:     '2026-03-07T12:00:01.000Z',
};

describe.concurrent('BskyCheckpointManager', () => {
    let mockBackend: MemoryToolBackend;
    let manager: BskyCheckpointManager;

    beforeEach(() => {
        mockBackend = {
            get:          mock(async () => undefined),
            create:       mock(async () => undefined),
            update:       mock(async () => undefined),
            list:         mock(async () => ({ items: [], nextCursor: undefined })),
            listByLayer:  mock(async () => ({ items: [], nextCursor: undefined })),
            searchByTags: mock(async () => ({ items: [], nextCursor: undefined })),
        } as unknown as MemoryToolBackend;

        manager = new BskyCheckpointManager({ backend: mockBackend });
    });

    // -----------------------------------------------------------------------
    // loadFeedCheckpoint
    // -----------------------------------------------------------------------

    describe('loadFeedCheckpoint()', () => {
        test('returns undefined when no checkpoint exists', async () => {
            const result = await manager.loadFeedCheckpoint('following');
            expect(result).toBeUndefined();
        });

        test('loads and parses valid feed checkpoint', async () => {
            mockBackend.get = mock(async () => makeItem(JSON.stringify(FEED_CHECKPOINT)));
            const result = await manager.loadFeedCheckpoint('following');
            expect(result).toEqual(FEED_CHECKPOINT);
        });

        test('returns undefined on invalid JSON', async () => {
            mockBackend.get = mock(async () => makeItem('not json'));
            const result = await manager.loadFeedCheckpoint('following');
            expect(result).toBeUndefined();
        });

        test('returns undefined on schema validation failure', async () => {
            mockBackend.get = mock(async () => makeItem(JSON.stringify({ service: 'wrong' })));
            const result = await manager.loadFeedCheckpoint('following');
            expect(result).toBeUndefined();
        });

        test('uses sanitized feed name in path', async () => {
            await manager.loadFeedCheckpoint('at://did:plc:abc/app.bsky.feed.generator/my-feed');
            expect(mockBackend.get).toHaveBeenCalledWith(
                expect.stringContaining('at-did:plc:abc-app.bsky.feed.generator-my-feed')
            );
        });
    });

    // -----------------------------------------------------------------------
    // saveFeedCheckpoint
    // -----------------------------------------------------------------------

    describe('saveFeedCheckpoint()', () => {
        test('creates new checkpoint when exists is false', async () => {
            await manager.saveFeedCheckpoint(FEED_CHECKPOINT, false);

            const createCall = (mockBackend.create as ReturnType<typeof mock>).mock.calls[0][0] as { path: string, content: string, contentType: string };
            expect(createCall.content).toBe(JSON.stringify(FEED_CHECKPOINT));
            expect(createCall.contentType).toBe('application/json');
            expect(mockBackend.update).not.toHaveBeenCalled();
        });

        test('updates existing checkpoint when exists is true', async () => {
            await manager.saveFeedCheckpoint(FEED_CHECKPOINT, true);

            const updateCall = (mockBackend.update as ReturnType<typeof mock>).mock.calls[0] as [string, { content: string }];
            expect(updateCall[1].content).toBe(JSON.stringify(FEED_CHECKPOINT));
            expect(mockBackend.create).not.toHaveBeenCalled();
        });

        test('applies FIFO eviction when processedUris exceeds MAX_PROCESSED_URIS', async () => {
            const uris = Array.from({ length: MAX_PROCESSED_URIS + 50 }, (_, i) => `at://uri/${i}`);
            const checkpoint: BskyFeedCheckpoint = { ...FEED_CHECKPOINT, processedUris: uris };
            await manager.saveFeedCheckpoint(checkpoint, false);

            const createCall = (mockBackend.create as ReturnType<typeof mock>).mock.calls[0][0] as { content: string };
            const savedContent = JSON.parse(createCall.content) as { processedUris: string[] };
            expect(savedContent.processedUris).toHaveLength(MAX_PROCESSED_URIS);
            // Should keep the newest (last) entries
            expect(savedContent.processedUris[0]).toBe('at://uri/50');
            expect(savedContent.processedUris[MAX_PROCESSED_URIS - 1]).toBe(`at://uri/${MAX_PROCESSED_URIS + 49}`);
        });

        test('does not evict when processedUris is within limit', async () => {
            await manager.saveFeedCheckpoint(FEED_CHECKPOINT, false);

            const createCall = (mockBackend.create as ReturnType<typeof mock>).mock.calls[0][0] as { content: string };
            const savedContent = JSON.parse(createCall.content) as { processedUris: string[] };
            expect(savedContent.processedUris).toEqual(FEED_CHECKPOINT.processedUris);
        });

        test('does not evict when processedUris is exactly at MAX_PROCESSED_URIS', async () => {
            const uris        = Array.from({ length: MAX_PROCESSED_URIS }, (_, i) => `at://uri/${i}`);
            const checkpoint  = { ...FEED_CHECKPOINT, processedUris: uris };
            await manager.saveFeedCheckpoint(checkpoint, false);

            const createCall   = (mockBackend.create as ReturnType<typeof mock>).mock.calls[0][0] as { content: string };
            const savedContent = JSON.parse(createCall.content) as { processedUris: string[] };
            expect(savedContent.processedUris).toHaveLength(MAX_PROCESSED_URIS);
            expect(savedContent.processedUris[0]).toBe('at://uri/0');
        });

        test('updates existing checkpoint with correct content', async () => {
            await manager.saveFeedCheckpoint(FEED_CHECKPOINT, true);

            const updateCall = (mockBackend.update as ReturnType<typeof mock>).mock.calls[0] as [string, { content: string }];
            expect(updateCall[1]).toEqual({ content: JSON.stringify(FEED_CHECKPOINT) });
        });

        test('uses correct memory path format', async () => {
            await manager.saveFeedCheckpoint(FEED_CHECKPOINT, false);

            const createCall = (mockBackend.create as ReturnType<typeof mock>).mock.calls[0][0] as { path: string };
            expect(createCall.path).toBe('/state/services/bsky/feeds/following/checkpoint');
        });

        test('does not call backend.get (uses provided exists flag)', async () => {
            await manager.saveFeedCheckpoint(FEED_CHECKPOINT, false);
            expect(mockBackend.get).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // loadNotificationCheckpoint
    // -----------------------------------------------------------------------

    describe('loadNotificationCheckpoint()', () => {
        test('returns undefined when no checkpoint exists', async () => {
            const result = await manager.loadNotificationCheckpoint();
            expect(result).toBeUndefined();
        });

        test('loads and parses valid notification checkpoint', async () => {
            mockBackend.get = mock(async () => makeItem(JSON.stringify(NOTIF_CHECKPOINT)));
            const result = await manager.loadNotificationCheckpoint();
            expect(result).toEqual(NOTIF_CHECKPOINT);
        });

        test('returns undefined on invalid JSON', async () => {
            mockBackend.get = mock(async () => makeItem('{invalid'));
            const result = await manager.loadNotificationCheckpoint();
            expect(result).toBeUndefined();
        });

        test('returns undefined on schema validation failure', async () => {
            mockBackend.get = mock(async () => makeItem(JSON.stringify({ service: 'bsky', type: 'wrong' })));
            const result = await manager.loadNotificationCheckpoint();
            expect(result).toBeUndefined();
        });

        test('uses correct memory path', async () => {
            await manager.loadNotificationCheckpoint();
            expect(mockBackend.get).toHaveBeenCalledWith('/state/services/bsky/notifications/checkpoint');
        });
    });

    // -----------------------------------------------------------------------
    // saveNotificationCheckpoint
    // -----------------------------------------------------------------------

    describe('saveNotificationCheckpoint()', () => {
        test('creates new checkpoint when exists is false', async () => {
            await manager.saveNotificationCheckpoint(NOTIF_CHECKPOINT, false);

            const createCall = (mockBackend.create as ReturnType<typeof mock>).mock.calls[0][0] as { content: string, contentType: string };
            expect(createCall.content).toBe(JSON.stringify(NOTIF_CHECKPOINT));
            expect(createCall.contentType).toBe('application/json');
        });

        test('updates existing checkpoint when exists is true', async () => {
            await manager.saveNotificationCheckpoint(NOTIF_CHECKPOINT, true);
            expect(mockBackend.update).toHaveBeenCalled();
            expect(mockBackend.create).not.toHaveBeenCalled();
        });

        test('updates existing checkpoint with correct content', async () => {
            await manager.saveNotificationCheckpoint(NOTIF_CHECKPOINT, true);

            const updateCall = (mockBackend.update as ReturnType<typeof mock>).mock.calls[0] as [string, { content: string }];
            expect(updateCall[1]).toEqual({ content: JSON.stringify(NOTIF_CHECKPOINT) });
        });

        test('applies FIFO eviction when processedUris exceeds MAX_PROCESSED_URIS', async () => {
            const uris = Array.from({ length: MAX_PROCESSED_URIS + 100 }, (_, i) => `at://uri/${i}`);
            const checkpoint: BskyNotificationCheckpoint = { ...NOTIF_CHECKPOINT, processedUris: uris };
            await manager.saveNotificationCheckpoint(checkpoint, false);

            const createCall = (mockBackend.create as ReturnType<typeof mock>).mock.calls[0][0] as { content: string };
            const savedContent = JSON.parse(createCall.content) as { processedUris: string[] };
            expect(savedContent.processedUris).toHaveLength(MAX_PROCESSED_URIS);
            expect(savedContent.processedUris[0]).toBe('at://uri/100');
        });

        test('does not evict when processedUris is exactly at MAX_PROCESSED_URIS', async () => {
            const uris        = Array.from({ length: MAX_PROCESSED_URIS }, (_, i) => `at://uri/${i}`);
            const checkpoint  = { ...NOTIF_CHECKPOINT, processedUris: uris };
            await manager.saveNotificationCheckpoint(checkpoint, false);

            const createCall   = (mockBackend.create as ReturnType<typeof mock>).mock.calls[0][0] as { content: string };
            const savedContent = JSON.parse(createCall.content) as { processedUris: string[] };
            expect(savedContent.processedUris).toHaveLength(MAX_PROCESSED_URIS);
            expect(savedContent.processedUris[0]).toBe('at://uri/0');
        });

        test('uses correct memory path', async () => {
            await manager.saveNotificationCheckpoint(NOTIF_CHECKPOINT, false);

            const createCall = (mockBackend.create as ReturnType<typeof mock>).mock.calls[0][0] as { path: string };
            expect(createCall.path).toBe('/state/services/bsky/notifications/checkpoint');
        });

        test('does not call backend.get (uses provided exists flag)', async () => {
            await manager.saveNotificationCheckpoint(NOTIF_CHECKPOINT, false);
            expect(mockBackend.get).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // processFeedItems
    // -----------------------------------------------------------------------

    describe('processFeedItems()', () => {
        function makeFeedItem(uri: string, indexedAt = NOW): BskyFeedItem {
            return {
                post: {
                    uri,
                    cid:         'bafycid',
                    author:      { did: 'did:plc:author', handle: 'author.bsky.social' },
                    text:        'Hello',
                    createdAt:   NOW,
                    replyCount:  0,
                    likeCount:   0,
                    repostCount: 0,
                    indexedAt,
                },
            };
        }

        test('returns all items when no checkpoint exists', async () => {
            const items  = [makeFeedItem('at://uri/1'), makeFeedItem('at://uri/2')];
            const result = await manager.processFeedItems('following', items);
            expect(result.newItems).toHaveLength(2);
            expect(result.totalFetched).toBe(2);
        });

        test('filters already-processed items when checkpoint exists', async () => {
            mockBackend.get = mock(async () => makeItem(JSON.stringify(FEED_CHECKPOINT)));
            const items  = [
                makeFeedItem('at://did:plc:abc/app.bsky.feed.post/123'), // already in FEED_CHECKPOINT
                makeFeedItem('at://uri/new'),
            ];
            const result = await manager.processFeedItems('following', items);
            expect(result.newItems).toHaveLength(1);
            expect(result.newItems[0].post.uri).toBe('at://uri/new');
            expect(result.totalFetched).toBe(2);
        });

        test('saves checkpoint with correct lastIndexedAt', async () => {
            const items = [
                makeFeedItem('at://uri/1', '2026-01-01T00:00:01.000Z'),
                makeFeedItem('at://uri/2', '2026-01-01T00:00:03.000Z'),
                makeFeedItem('at://uri/3', '2026-01-01T00:00:02.000Z'),
            ];
            await manager.processFeedItems('following', items);

            const createCall = (mockBackend.create as ReturnType<typeof mock>).mock.calls[0][0] as { content: string };
            const saved = JSON.parse(createCall.content) as { lastIndexedAt: string };
            expect(saved.lastIndexedAt).toBe('2026-01-01T00:00:03.000Z');
        });

        test('preserves existing lastIndexedAt when no items', async () => {
            mockBackend.get = mock(async () => makeItem(JSON.stringify(FEED_CHECKPOINT)));
            const result = await manager.processFeedItems('following', []);

            expect(result.newItems).toHaveLength(0);
            const updateCall = (mockBackend.update as ReturnType<typeof mock>).mock.calls[0] as [string, { content: string }];
            const saved = JSON.parse(updateCall[1].content) as { lastIndexedAt: string };
            expect(saved.lastIndexedAt).toBe(FEED_CHECKPOINT.lastIndexedAt!);
        });

        test('accumulates processedUris from existing checkpoint', async () => {
            mockBackend.get = mock(async () => makeItem(JSON.stringify(FEED_CHECKPOINT)));
            const items = [makeFeedItem('at://uri/new')];
            await manager.processFeedItems('following', items);

            const updateCall = (mockBackend.update as ReturnType<typeof mock>).mock.calls[0] as [string, { content: string }];
            const saved = JSON.parse(updateCall[1].content) as { processedUris: string[] };
            expect(saved.processedUris).toContain('at://did:plc:abc/app.bsky.feed.post/123');
            expect(saved.processedUris).toContain('at://uri/new');
        });

        test('uses load + save in a single round-trip (no double load)', async () => {
            const items = [makeFeedItem('at://uri/1')];
            await manager.processFeedItems('following', items);
            // Only one backend.get call (loadFeedCheckpoint) — saveFeedCheckpoint uses the exists flag, not a redundant get
            expect(mockBackend.get).toHaveBeenCalledTimes(1);
        });
    });

    // -----------------------------------------------------------------------
    // processNotifications
    // -----------------------------------------------------------------------

    describe('processNotifications()', () => {
        function makeNotification(uri: string, indexedAt = NOW): BskyNotification {
            return {
                reason: 'like' as const,
                uri,
                author: { did: 'did:plc:author', handle: 'author.bsky.social' },
                indexedAt,
            };
        }

        test('returns all notifications when no checkpoint exists', async () => {
            const notifications = [makeNotification('at://notif/1'), makeNotification('at://notif/2')];
            const result        = await manager.processNotifications(notifications);
            expect(result.newNotifications).toHaveLength(2);
            expect(result.totalFetched).toBe(2);
        });

        test('filters already-processed notifications when checkpoint exists', async () => {
            mockBackend.get = mock(async () => makeItem(JSON.stringify(NOTIF_CHECKPOINT)));
            const notifications = [
                makeNotification('at://did:plc:abc/app.bsky.feed.like/456'), // already in NOTIF_CHECKPOINT
                makeNotification('at://notif/new'),
            ];
            const result = await manager.processNotifications(notifications);
            expect(result.newNotifications).toHaveLength(1);
            expect(result.newNotifications[0].uri).toBe('at://notif/new');
            expect(result.totalFetched).toBe(2);
        });

        test('returns max indexedAt as lastSeenAt', async () => {
            const notifications = [
                makeNotification('at://n/1', '2026-01-01T00:00:01.000Z'),
                makeNotification('at://n/2', '2026-01-01T00:00:03.000Z'),
                makeNotification('at://n/3', '2026-01-01T00:00:02.000Z'),
            ];
            const result = await manager.processNotifications(notifications);
            expect(result.lastSeenAt).toBe('2026-01-01T00:00:03.000Z');
        });

        test('preserves existing lastSeenAt when no notifications', async () => {
            mockBackend.get = mock(async () => makeItem(JSON.stringify(NOTIF_CHECKPOINT)));
            const result = await manager.processNotifications([]);
            expect(result.lastSeenAt).toBe(NOTIF_CHECKPOINT.lastSeenAt);
        });

        test('returns undefined lastSeenAt when no notifications and no checkpoint', async () => {
            const result = await manager.processNotifications([]);
            expect(result.lastSeenAt).toBeUndefined();
        });

        test('saves checkpoint with correct processedUris accumulated from existing', async () => {
            mockBackend.get = mock(async () => makeItem(JSON.stringify(NOTIF_CHECKPOINT)));
            const notifications = [makeNotification('at://notif/new')];
            await manager.processNotifications(notifications);

            const updateCall = (mockBackend.update as ReturnType<typeof mock>).mock.calls[0] as [string, { content: string }];
            const saved = JSON.parse(updateCall[1].content) as { processedUris: string[] };
            expect(saved.processedUris).toContain('at://did:plc:abc/app.bsky.feed.like/456');
            expect(saved.processedUris).toContain('at://notif/new');
        });

        test('saves checkpoint with correct lastSeenAt', async () => {
            const notifications = [makeNotification('at://n/1', '2026-01-01T00:00:05.000Z')];
            await manager.processNotifications(notifications);

            const createCall = (mockBackend.create as ReturnType<typeof mock>).mock.calls[0][0] as { content: string };
            const saved = JSON.parse(createCall.content) as { lastSeenAt: string };
            expect(saved.lastSeenAt).toBe('2026-01-01T00:00:05.000Z');
        });

        test('returns hadExistingCheckpoint=false when no checkpoint exists', async () => {
            const notifications = [makeNotification('at://n/1')];
            const result = await manager.processNotifications(notifications);
            expect(result.hadExistingCheckpoint).toBe(false);
        });

        test('returns hadExistingCheckpoint=true when checkpoint already exists', async () => {
            mockBackend.get = mock(async () => makeItem(JSON.stringify(NOTIF_CHECKPOINT)));
            const notifications = [makeNotification('at://n/new')];
            const result = await manager.processNotifications(notifications);
            expect(result.hadExistingCheckpoint).toBe(true);
        });

        test('uses load + save in a single round-trip (no double load)', async () => {
            const notifications = [makeNotification('at://n/1')];
            await manager.processNotifications(notifications);
            // Only one backend.get call (loadNotificationCheckpoint) — saveNotificationCheckpoint uses the exists flag
            expect(mockBackend.get).toHaveBeenCalledTimes(1);
        });
    });
});
