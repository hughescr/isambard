import { describe, test, expect } from 'bun:test';
import { createFakeOperationalStateStore, type FakeOperationalStateStore } from '../../../../helpers/fake-operational-state-store';
import { BskyCheckpointManager } from '@/integrations/bsky/checkpoint/checkpoint-manager';
import {
    MAX_PROCESSED_URIS,
    bskyDmCheckpointSchema,
    bskyFeedCheckpointSchema,
    bskyNotificationCheckpointSchema,
    type BskyFeedCheckpoint,
    type BskyNotificationCheckpoint,
    type BskyDmCheckpoint
} from '@/integrations/bsky/checkpoint/types';
import type { BskyFeedItem, BskyNotification, BskyConversation } from '@/integrations/bsky/types';
import type { OperationalStateKey } from '@/storage/operational-state';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = '2026-03-07T12:00:00.000Z';

const FEED_KEY: OperationalStateKey = { owner: 'bsky', name: 'feeds/following/checkpoint' };
const NOTIF_KEY: OperationalStateKey = { owner: 'bsky', name: 'notifications/checkpoint' };
const DM_KEY: OperationalStateKey = { owner: 'bsky', name: 'dm/checkpoint' };

/**
 * A fresh fake store and manager per test: the suite runs concurrently, so nothing mutable is
 * shared between tests.
 */
function setup(): { store: FakeOperationalStateStore, manager: BskyCheckpointManager } {
    const store = createFakeOperationalStateStore();
    return { store, manager: new BskyCheckpointManager({ store }) };
}

/** The value of the only put the store received. */
function onlyPut<T>(store: FakeOperationalStateStore): T {
    expect(store.put).toHaveBeenCalledTimes(1);
    return store.put.mock.calls[0]?.[1] as T;
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

const DM_CHECKPOINT: BskyDmCheckpoint = {
    service:             'bsky',
    type:                'dm',
    lastSeenSentAt:      '2026-03-07T12:00:00.000Z',
    processedMessageIds: ['msg-existing'],
    updatedAt:           '2026-03-07T12:00:01.000Z',
};

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe.concurrent('BskyCheckpointManager', () => {
    // -----------------------------------------------------------------------
    // loadFeedCheckpoint
    // -----------------------------------------------------------------------

    describe('loadFeedCheckpoint()', () => {
        test('returns undefined when no checkpoint exists', async () => {
            const { manager } = setup();
            await expect(manager.loadFeedCheckpoint('following')).resolves.toBeUndefined();
        });

        test('loads and parses a valid feed checkpoint from the feed key with the feed schema', async () => {
            const { store, manager } = setup();
            store.seed(FEED_KEY, FEED_CHECKPOINT);
            await expect(manager.loadFeedCheckpoint('following')).resolves.toEqual(FEED_CHECKPOINT);
            expect(store.read).toHaveBeenCalledWith(FEED_KEY, bskyFeedCheckpointSchema);
        });

        test('returns undefined on invalid JSON', async () => {
            const { store, manager } = setup();
            store.seedRaw(FEED_KEY, 'not json');
            await expect(manager.loadFeedCheckpoint('following')).resolves.toBeUndefined();
        });

        test('returns undefined on schema validation failure', async () => {
            const { store, manager } = setup();
            store.seed(FEED_KEY, { service: 'wrong' });
            await expect(manager.loadFeedCheckpoint('following')).resolves.toBeUndefined();
        });

        test('uses the sanitized feed name in the key', async () => {
            const { store, manager } = setup();
            await manager.loadFeedCheckpoint('at://did:plc:abc/app.bsky.feed.generator/my-feed');
            expect(store.read).toHaveBeenCalledWith(
                { owner: 'bsky', name: 'feeds/at-did:plc:abc-app.bsky.feed.generator-my-feed/checkpoint' },
                bskyFeedCheckpointSchema
            );
        });
    });

    // -----------------------------------------------------------------------
    // saveFeedCheckpoint
    // -----------------------------------------------------------------------

    describe('saveFeedCheckpoint()', () => {
        test('puts the checkpoint under the feed key without reading first', async () => {
            const { store, manager } = setup();
            await manager.saveFeedCheckpoint(FEED_CHECKPOINT);

            expect(store.put).toHaveBeenCalledTimes(1);
            expect(store.put).toHaveBeenCalledWith(FEED_KEY, FEED_CHECKPOINT);
            expect(store.read).not.toHaveBeenCalled();
        });

        test('applies FIFO eviction when processedUris exceeds MAX_PROCESSED_URIS', async () => {
            const { store, manager } = setup();
            const uris = Array.from({ length: MAX_PROCESSED_URIS + 50 }, (_, i) => `at://uri/${i}`);
            await manager.saveFeedCheckpoint({ ...FEED_CHECKPOINT, processedUris: uris });

            const saved = onlyPut<BskyFeedCheckpoint>(store);
            expect(saved.processedUris).toHaveLength(MAX_PROCESSED_URIS);
            // Keeps the newest (last) entries
            expect(saved.processedUris[0]).toBe('at://uri/50');
            expect(saved.processedUris[MAX_PROCESSED_URIS - 1]).toBe(`at://uri/${MAX_PROCESSED_URIS + 49}`);
        });

        test('does not evict when processedUris is exactly at MAX_PROCESSED_URIS', async () => {
            const { store, manager } = setup();
            const uris = Array.from({ length: MAX_PROCESSED_URIS }, (_, i) => `at://uri/${i}`);
            await manager.saveFeedCheckpoint({ ...FEED_CHECKPOINT, processedUris: uris });

            const saved = onlyPut<BskyFeedCheckpoint>(store);
            expect(saved.processedUris).toHaveLength(MAX_PROCESSED_URIS);
            expect(saved.processedUris[0]).toBe('at://uri/0');
        });
    });

    // -----------------------------------------------------------------------
    // loadNotificationCheckpoint
    // -----------------------------------------------------------------------

    describe('loadNotificationCheckpoint()', () => {
        test('returns undefined when no checkpoint exists', async () => {
            const { manager } = setup();
            await expect(manager.loadNotificationCheckpoint()).resolves.toBeUndefined();
        });

        test('loads and parses a valid notification checkpoint from the notification key with its schema', async () => {
            const { store, manager } = setup();
            store.seed(NOTIF_KEY, NOTIF_CHECKPOINT);
            await expect(manager.loadNotificationCheckpoint()).resolves.toEqual(NOTIF_CHECKPOINT);
            expect(store.read).toHaveBeenCalledWith(NOTIF_KEY, bskyNotificationCheckpointSchema);
        });

        test('returns undefined on invalid JSON', async () => {
            const { store, manager } = setup();
            store.seedRaw(NOTIF_KEY, '{invalid');
            await expect(manager.loadNotificationCheckpoint()).resolves.toBeUndefined();
        });

        test('returns undefined on schema validation failure', async () => {
            const { store, manager } = setup();
            store.seed(NOTIF_KEY, { service: 'bsky', type: 'wrong' });
            await expect(manager.loadNotificationCheckpoint()).resolves.toBeUndefined();
        });
    });

    // -----------------------------------------------------------------------
    // saveNotificationCheckpoint
    // -----------------------------------------------------------------------

    describe('saveNotificationCheckpoint()', () => {
        test('puts the checkpoint under the notification key without reading first', async () => {
            const { store, manager } = setup();
            await manager.saveNotificationCheckpoint(NOTIF_CHECKPOINT);

            expect(store.put).toHaveBeenCalledTimes(1);
            expect(store.put).toHaveBeenCalledWith(NOTIF_KEY, NOTIF_CHECKPOINT);
            expect(store.read).not.toHaveBeenCalled();
        });

        test('applies FIFO eviction when processedUris exceeds MAX_PROCESSED_URIS', async () => {
            const { store, manager } = setup();
            const uris = Array.from({ length: MAX_PROCESSED_URIS + 100 }, (_, i) => `at://uri/${i}`);
            await manager.saveNotificationCheckpoint({ ...NOTIF_CHECKPOINT, processedUris: uris });

            const saved = onlyPut<BskyNotificationCheckpoint>(store);
            expect(saved.processedUris).toHaveLength(MAX_PROCESSED_URIS);
            expect(saved.processedUris[0]).toBe('at://uri/100');
        });

        test('does not evict when processedUris is exactly at MAX_PROCESSED_URIS', async () => {
            const { store, manager } = setup();
            const uris = Array.from({ length: MAX_PROCESSED_URIS }, (_, i) => `at://uri/${i}`);
            await manager.saveNotificationCheckpoint({ ...NOTIF_CHECKPOINT, processedUris: uris });

            const saved = onlyPut<BskyNotificationCheckpoint>(store);
            expect(saved.processedUris).toHaveLength(MAX_PROCESSED_URIS);
            expect(saved.processedUris[0]).toBe('at://uri/0');
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

        test('returns all items and puts their uris when no checkpoint exists', async () => {
            const { store, manager } = setup();
            const result = await manager.processFeedItems('following', [makeFeedItem('at://uri/1'), makeFeedItem('at://uri/2')]);
            expect(result.newItems).toHaveLength(2);
            expect(result.totalFetched).toBe(2);
            expect(onlyPut<BskyFeedCheckpoint>(store).processedUris).toEqual(['at://uri/1', 'at://uri/2']);
            expect(store.put.mock.calls[0]?.[0]).toEqual(FEED_KEY);
        });

        test('filters already-processed items when a checkpoint exists', async () => {
            const { store, manager } = setup();
            store.seed(FEED_KEY, FEED_CHECKPOINT);
            const result = await manager.processFeedItems('following', [
                makeFeedItem('at://did:plc:abc/app.bsky.feed.post/123'), // already in FEED_CHECKPOINT
                makeFeedItem('at://uri/new'),
            ]);
            expect(result.newItems).toHaveLength(1);
            expect(result.newItems[0].post.uri).toBe('at://uri/new');
            expect(result.totalFetched).toBe(2);
        });

        test('saves the checkpoint with the max indexedAt as lastIndexedAt', async () => {
            const { store, manager } = setup();
            await manager.processFeedItems('following', [
                makeFeedItem('at://uri/1', '2026-01-01T00:00:01.000Z'),
                makeFeedItem('at://uri/2', '2026-01-01T00:00:03.000Z'),
                makeFeedItem('at://uri/3', '2026-01-01T00:00:02.000Z'),
            ]);
            expect(onlyPut<BskyFeedCheckpoint>(store).lastIndexedAt).toBe('2026-01-01T00:00:03.000Z');
        });

        test('a single item advances lastIndexedAt past the stored high-water mark', async () => {
            const { store, manager } = setup();
            store.seed(FEED_KEY, { ...FEED_CHECKPOINT, lastIndexedAt: '2020-01-01T00:00:00.000Z' });
            await manager.processFeedItems('following', [makeFeedItem('at://uri/only', '2026-01-01T00:00:03.000Z')]);
            expect(onlyPut<BskyFeedCheckpoint>(store).lastIndexedAt).toBe('2026-01-01T00:00:03.000Z');
        });

        test('preserves the existing lastIndexedAt when there are no items', async () => {
            const { store, manager } = setup();
            store.seed(FEED_KEY, FEED_CHECKPOINT);
            const result = await manager.processFeedItems('following', []);
            expect(result.newItems).toHaveLength(0);
            expect(onlyPut<BskyFeedCheckpoint>(store).lastIndexedAt).toBe(FEED_CHECKPOINT.lastIndexedAt);
        });

        test('accumulates processedUris from the existing checkpoint', async () => {
            const { store, manager } = setup();
            store.seed(FEED_KEY, FEED_CHECKPOINT);
            await manager.processFeedItems('following', [makeFeedItem('at://uri/new')]);
            expect(onlyPut<BskyFeedCheckpoint>(store).processedUris).toEqual(['at://did:plc:abc/app.bsky.feed.post/123', 'at://uri/new']);
        });

        test('reads once and puts once whether or not a checkpoint already existed', async () => {
            const fresh = setup();
            await fresh.manager.processFeedItems('following', [makeFeedItem('at://uri/1')]);
            expect(fresh.store.read).toHaveBeenCalledTimes(1);
            expect(fresh.store.put).toHaveBeenCalledTimes(1);

            const existing = setup();
            existing.store.seed(FEED_KEY, FEED_CHECKPOINT);
            await existing.manager.processFeedItems('following', [makeFeedItem('at://uri/1')]);
            expect(existing.store.read).toHaveBeenCalledTimes(1);
            expect(existing.store.put).toHaveBeenCalledTimes(1);
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

        test('returns all notifications and puts their uris when no checkpoint exists', async () => {
            const { store, manager } = setup();
            const result = await manager.processNotifications([makeNotification('at://notif/1'), makeNotification('at://notif/2')]);
            expect(result.newNotifications).toHaveLength(2);
            expect(result.totalFetched).toBe(2);
            expect(onlyPut<BskyNotificationCheckpoint>(store).processedUris).toEqual(['at://notif/1', 'at://notif/2']);
            expect(store.put.mock.calls[0]?.[0]).toEqual(NOTIF_KEY);
        });

        test('filters already-processed notifications when a checkpoint exists', async () => {
            const { store, manager } = setup();
            store.seed(NOTIF_KEY, NOTIF_CHECKPOINT);
            const result = await manager.processNotifications([
                makeNotification('at://did:plc:abc/app.bsky.feed.like/456'), // already in NOTIF_CHECKPOINT
                makeNotification('at://notif/new'),
            ]);
            expect(result.newNotifications).toHaveLength(1);
            expect(result.newNotifications[0].uri).toBe('at://notif/new');
            expect(result.totalFetched).toBe(2);
        });

        test('returns max indexedAt as lastSeenAt', async () => {
            const { manager } = setup();
            const result = await manager.processNotifications([
                makeNotification('at://n/1', '2026-01-01T00:00:01.000Z'),
                makeNotification('at://n/2', '2026-01-01T00:00:03.000Z'),
                makeNotification('at://n/3', '2026-01-01T00:00:02.000Z'),
            ]);
            expect(result.lastSeenAt).toBe('2026-01-01T00:00:03.000Z');
        });

        test('preserves the existing lastSeenAt when there are no notifications', async () => {
            const { store, manager } = setup();
            store.seed(NOTIF_KEY, NOTIF_CHECKPOINT);
            const result = await manager.processNotifications([]);
            expect(result.lastSeenAt).toBe(NOTIF_CHECKPOINT.lastSeenAt);
        });

        test('returns undefined lastSeenAt when no notifications and no checkpoint', async () => {
            const { manager } = setup();
            const result = await manager.processNotifications([]);
            expect(result.lastSeenAt).toBeUndefined();
        });

        test('saves processedUris accumulated from the existing checkpoint', async () => {
            const { store, manager } = setup();
            store.seed(NOTIF_KEY, NOTIF_CHECKPOINT);
            await manager.processNotifications([makeNotification('at://notif/new')]);
            expect(onlyPut<BskyNotificationCheckpoint>(store).processedUris).toEqual(['at://did:plc:abc/app.bsky.feed.like/456', 'at://notif/new']);
        });

        test('saves the checkpoint with the notification lastSeenAt', async () => {
            const { store, manager } = setup();
            await manager.processNotifications([makeNotification('at://n/1', '2026-01-01T00:00:05.000Z')]);
            expect(onlyPut<BskyNotificationCheckpoint>(store).lastSeenAt).toBe('2026-01-01T00:00:05.000Z');
        });

        test('stamps a fresh updatedAt over the stored notification checkpoint updatedAt', async () => {
            const { store, manager } = setup();
            store.seed(NOTIF_KEY, NOTIF_CHECKPOINT);
            await manager.processNotifications([makeNotification('at://n/new', '2026-01-01T00:00:09.000Z')]);
            const saved = onlyPut<BskyNotificationCheckpoint>(store);
            expect(saved.updatedAt).not.toBe(NOTIF_CHECKPOINT.updatedAt);
            expect(saved.updatedAt).toMatch(ISO_TIMESTAMP);
        });

        test('returns hadExistingCheckpoint=false and still puts once when no checkpoint exists', async () => {
            const { store, manager } = setup();
            const result = await manager.processNotifications([makeNotification('at://n/1')]);
            expect(result.hadExistingCheckpoint).toBe(false);
            expect(store.put).toHaveBeenCalledTimes(1);
        });

        test('returns hadExistingCheckpoint=true and puts once when a checkpoint already exists', async () => {
            const { store, manager } = setup();
            store.seed(NOTIF_KEY, NOTIF_CHECKPOINT);
            const result = await manager.processNotifications([makeNotification('at://n/new')]);
            expect(result.hadExistingCheckpoint).toBe(true);
            expect(store.put).toHaveBeenCalledTimes(1);
            expect(store.read).toHaveBeenCalledTimes(1);
        });
    });

    // -----------------------------------------------------------------------
    // loadDmCheckpoint
    // -----------------------------------------------------------------------

    describe('loadDmCheckpoint()', () => {
        test('returns undefined when no checkpoint exists', async () => {
            const { manager } = setup();
            await expect(manager.loadDmCheckpoint()).resolves.toBeUndefined();
        });

        test('loads and parses a valid dm checkpoint from the dm key with its schema', async () => {
            const { store, manager } = setup();
            store.seed(DM_KEY, DM_CHECKPOINT);
            await expect(manager.loadDmCheckpoint()).resolves.toEqual(DM_CHECKPOINT);
            expect(store.read).toHaveBeenCalledWith(DM_KEY, bskyDmCheckpointSchema);
        });

        test('returns undefined on invalid JSON', async () => {
            const { store, manager } = setup();
            store.seedRaw(DM_KEY, '{invalid');
            await expect(manager.loadDmCheckpoint()).resolves.toBeUndefined();
        });

        test('returns undefined on schema validation failure', async () => {
            const { store, manager } = setup();
            store.seed(DM_KEY, { service: 'bsky', type: 'wrong' });
            await expect(manager.loadDmCheckpoint()).resolves.toBeUndefined();
        });
    });

    // -----------------------------------------------------------------------
    // saveDmCheckpoint
    // -----------------------------------------------------------------------

    describe('saveDmCheckpoint()', () => {
        test('puts the checkpoint under the dm key without reading first', async () => {
            const { store, manager } = setup();
            await manager.saveDmCheckpoint(DM_CHECKPOINT);

            expect(store.put).toHaveBeenCalledTimes(1);
            expect(store.put).toHaveBeenCalledWith(DM_KEY, DM_CHECKPOINT);
            expect(store.read).not.toHaveBeenCalled();
        });

        test('applies FIFO eviction when processedMessageIds exceeds MAX_PROCESSED_URIS', async () => {
            const { store, manager } = setup();
            const ids = Array.from({ length: MAX_PROCESSED_URIS + 100 }, (_, i) => `msg-${i}`);
            await manager.saveDmCheckpoint({ ...DM_CHECKPOINT, processedMessageIds: ids });

            const saved = onlyPut<BskyDmCheckpoint>(store);
            expect(saved.processedMessageIds).toHaveLength(MAX_PROCESSED_URIS);
            expect(saved.processedMessageIds[0]).toBe('msg-100');
            expect(saved).not.toHaveProperty('processedUris');
        });

        test('does not evict when processedMessageIds is exactly at MAX_PROCESSED_URIS', async () => {
            const { store, manager } = setup();
            const ids = Array.from({ length: MAX_PROCESSED_URIS }, (_, i) => `msg-${i}`);
            await manager.saveDmCheckpoint({ ...DM_CHECKPOINT, processedMessageIds: ids });

            const saved = onlyPut<BskyDmCheckpoint>(store);
            expect(saved.processedMessageIds).toHaveLength(MAX_PROCESSED_URIS);
            expect(saved.processedMessageIds[0]).toBe('msg-0');
        });
    });

    // -----------------------------------------------------------------------
    // processDirectMessages
    // -----------------------------------------------------------------------

    describe('processDirectMessages()', () => {
        function makeConvo(id: string, opts: { lastMessageId?: string, sentAt?: string, unreadCount?: number } = {}): BskyConversation {
            const { lastMessageId, sentAt = NOW, unreadCount = 1 } = opts;
            return {
                id,
                rev:     'rev-1',
                members: [],
                muted:   false,
                unreadCount,
                ...(lastMessageId === undefined
                    ? {}
                    : {
                        lastMessage: {
                            id:        lastMessageId,
                            rev:       'msg-rev-1',
                            text:      'hi',
                            senderDid: 'did:plc:sender',
                            sentAt,
                        },
                    }),
            };
        }

        test('returns no new convos and hadExistingCheckpoint=false when no checkpoint and empty list', async () => {
            const { manager } = setup();
            const result = await manager.processDirectMessages([]);
            expect(result.newConvos).toHaveLength(0);
            expect(result.hadExistingCheckpoint).toBe(false);
            expect(result.totalFetched).toBe(0);
        });

        test('returns a convo with unreadCount>0 and a lastMessage as new and puts its id', async () => {
            const { store, manager } = setup();
            const result = await manager.processDirectMessages([makeConvo('convo-1', { lastMessageId: 'msg-1' })]);
            expect(result.newConvos).toHaveLength(1);
            expect(result.newConvos[0].id).toBe('convo-1');
            expect(result.totalFetched).toBe(1);
            const saved = onlyPut<BskyDmCheckpoint>(store);
            expect(saved.processedMessageIds).toEqual(['msg-1']);
            expect(saved).not.toHaveProperty('processedUris');
            expect(store.put.mock.calls[0]?.[0]).toEqual(DM_KEY);
        });

        test('a second poll with no activity returns nothing', async () => {
            const { store, manager } = setup();
            store.seed(DM_KEY, { ...DM_CHECKPOINT, processedMessageIds: ['msg-1'] });
            const result = await manager.processDirectMessages([makeConvo('convo-1', { lastMessageId: 'msg-1' })]);
            expect(result.newConvos).toHaveLength(0);
        });

        test('a NEW message in an already-processed conversation raises a new row (keyed on message id, not convo id)', async () => {
            const { store, manager } = setup();
            store.seed(DM_KEY, { ...DM_CHECKPOINT, processedUris: ['msg-old'] });
            const result = await manager.processDirectMessages([makeConvo('convo-1', { lastMessageId: 'msg-new' })]);
            expect(result.newConvos).toHaveLength(1);
            expect(result.newConvos[0].lastMessage.id).toBe('msg-new');
        });

        test('a convo with unreadCount>0 but no lastMessage is never treated as a new event', async () => {
            const { manager } = setup();
            const result = await manager.processDirectMessages([makeConvo('convo-1', { unreadCount: 1 })]);
            expect(result.newConvos).toHaveLength(0);
            expect(result.totalFetched).toBe(1);
        });

        test('a convo with no lastMessage never touches the checkpoint at all (nothing changed)', async () => {
            const { store, manager } = setup();
            await manager.processDirectMessages([makeConvo('convo-1', { unreadCount: 1 })]);
            expect(store.put).not.toHaveBeenCalled();
        });

        test('a convo with unreadCount=0 and a lastMessage is not treated as a new event', async () => {
            const { manager } = setup();
            const result = await manager.processDirectMessages([makeConvo('convo-1', { lastMessageId: 'msg-1', unreadCount: 0 })]);
            expect(result.newConvos).toHaveLength(0);
        });

        test('a convo with a negative unreadCount is not treated as a new event', async () => {
            const { store, manager } = setup();
            const result = await manager.processDirectMessages([makeConvo('convo-1', { lastMessageId: 'msg-1', unreadCount: -1 })]);
            expect(result.newConvos).toHaveLength(0);
            expect(store.put).not.toHaveBeenCalled();
        });

        test('returns max lastMessage.sentAt as lastSeenSentAt', async () => {
            const { manager } = setup();
            const result = await manager.processDirectMessages([
                makeConvo('convo-1', { lastMessageId: 'msg-1', sentAt: '2026-01-01T00:00:01.000Z' }),
                makeConvo('convo-2', { lastMessageId: 'msg-2', sentAt: '2026-01-01T00:00:03.000Z' }),
                makeConvo('convo-3', { lastMessageId: 'msg-3', sentAt: '2026-01-01T00:00:02.000Z' }),
            ]);
            expect(result.lastSeenSentAt).toBe('2026-01-01T00:00:03.000Z');
        });

        test('preserves the existing lastSeenSentAt when there are no candidates', async () => {
            const { store, manager } = setup();
            store.seed(DM_KEY, DM_CHECKPOINT);
            const result = await manager.processDirectMessages([]);
            expect(result.lastSeenSentAt).toBe(DM_CHECKPOINT.lastSeenSentAt);
        });

        test('returns undefined lastSeenSentAt when no candidates and no checkpoint', async () => {
            const { manager } = setup();
            const result = await manager.processDirectMessages([]);
            expect(result.lastSeenSentAt).toBeUndefined();
        });

        test('saves processedMessageIds accumulated from the existing checkpoint', async () => {
            const { store, manager } = setup();
            store.seed(DM_KEY, DM_CHECKPOINT);
            await manager.processDirectMessages([makeConvo('convo-1', { lastMessageId: 'msg-new' })]);
            const saved = onlyPut<BskyDmCheckpoint>(store);
            expect(saved.processedMessageIds).toEqual(['msg-existing', 'msg-new']);
            expect(saved).not.toHaveProperty('processedUris');
        });

        test('stamps a fresh updatedAt over the stored dm checkpoint updatedAt', async () => {
            const { store, manager } = setup();
            store.seed(DM_KEY, DM_CHECKPOINT);
            await manager.processDirectMessages([makeConvo('convo-1', { lastMessageId: 'msg-new', sentAt: '2026-01-01T00:00:09.000Z' })]);
            const saved = onlyPut<BskyDmCheckpoint>(store);
            expect(saved.updatedAt).not.toBe(DM_CHECKPOINT.updatedAt);
            expect(saved.updatedAt).toMatch(ISO_TIMESTAMP);
        });

        test('processed message ids FIFO-evict at MAX_PROCESSED_URIS', async () => {
            const { store, manager } = setup();
            const ids = Array.from({ length: MAX_PROCESSED_URIS }, (_, i) => `msg-${i}`);
            store.seed(DM_KEY, { ...DM_CHECKPOINT, processedMessageIds: ids });
            await manager.processDirectMessages([makeConvo('convo-new', { lastMessageId: 'msg-brand-new' })]);

            const saved = onlyPut<BskyDmCheckpoint>(store);
            expect(saved.processedMessageIds).toHaveLength(MAX_PROCESSED_URIS);
            expect(saved.processedMessageIds).not.toContain('msg-0');
            expect(saved.processedMessageIds).toContain('msg-brand-new');
        });

        test('returns hadExistingCheckpoint=false and puts once when no dm checkpoint exists', async () => {
            const { store, manager } = setup();
            const result = await manager.processDirectMessages([makeConvo('convo-1', { lastMessageId: 'msg-1' })]);
            expect(result.hadExistingCheckpoint).toBe(false);
            expect(store.read).toHaveBeenCalledTimes(1);
            expect(store.put).toHaveBeenCalledTimes(1);
        });

        test('returns hadExistingCheckpoint=true and puts once when a dm checkpoint already exists', async () => {
            const { store, manager } = setup();
            store.seed(DM_KEY, DM_CHECKPOINT);
            const result = await manager.processDirectMessages([makeConvo('convo-1', { lastMessageId: 'msg-new' })]);
            expect(result.hadExistingCheckpoint).toBe(true);
            expect(store.put).toHaveBeenCalledTimes(1);
        });

        test('skips the save entirely when there is no checkpoint and nothing to record', async () => {
            const { store, manager } = setup();
            const result = await manager.processDirectMessages([]);
            expect(result.newConvos).toHaveLength(0);
            expect(store.put).not.toHaveBeenCalled();
        });

        test('skips the save when a candidate is already processed and lastSeenSentAt is unchanged', async () => {
            const { store, manager } = setup();
            store.seed(DM_KEY, { ...DM_CHECKPOINT, processedMessageIds: ['msg-1'], lastSeenSentAt: NOW });
            const result = await manager.processDirectMessages([makeConvo('convo-1', { lastMessageId: 'msg-1', sentAt: NOW })]);

            expect(result.newConvos).toHaveLength(0);
            expect(store.put).not.toHaveBeenCalled();
        });

        test('still saves when lastSeenSentAt advances even with zero new convos', async () => {
            const { store, manager } = setup();
            store.seed(DM_KEY, { ...DM_CHECKPOINT, processedMessageIds: ['msg-1'], lastSeenSentAt: '2020-01-01T00:00:00.000Z' });
            await manager.processDirectMessages([makeConvo('convo-1', { lastMessageId: 'msg-1', sentAt: NOW })]);

            expect(store.put).toHaveBeenCalledTimes(1);
        });
    });

    // -----------------------------------------------------------------------
    // unprocessDirectMessages
    // -----------------------------------------------------------------------

    describe('unprocessDirectMessages()', () => {
        test('removes the given ids from processedMessageIds and puts under the dm key', async () => {
            const { store, manager } = setup();
            store.seed(DM_KEY, { ...DM_CHECKPOINT, processedMessageIds: ['a', 'b', 'c'] });

            await manager.unprocessDirectMessages(['b']);

            expect(onlyPut<BskyDmCheckpoint>(store).processedMessageIds).toEqual(['a', 'c']);
            expect(store.put.mock.calls[0]?.[0]).toEqual(DM_KEY);
        });

        test('stamps a fresh updatedAt when unprocessing over the stored checkpoint updatedAt', async () => {
            const { store, manager } = setup();
            store.seed(DM_KEY, { ...DM_CHECKPOINT, processedMessageIds: ['a', 'b', 'c'] });

            await manager.unprocessDirectMessages(['b']);

            const saved = onlyPut<BskyDmCheckpoint>(store);
            expect(saved.updatedAt).not.toBe(DM_CHECKPOINT.updatedAt);
            expect(saved.updatedAt).toMatch(ISO_TIMESTAMP);
        });

        test('is a no-op when no checkpoint exists', async () => {
            const { store, manager } = setup();
            await manager.unprocessDirectMessages(['a']);
            expect(store.put).not.toHaveBeenCalled();
        });

        test('is a no-op when none of the ids are present in processedMessageIds', async () => {
            const { store, manager } = setup();
            store.seed(DM_KEY, { ...DM_CHECKPOINT, processedMessageIds: ['a', 'b'] });

            await manager.unprocessDirectMessages(['z']);

            expect(store.put).not.toHaveBeenCalled();
        });
    });

    describe('public persistence completion boundaries', () => {
        async function isPendingUntilWrite(
            store: FakeOperationalStateStore,
            start: () => Promise<unknown>
        ): Promise<boolean> {
            const writeStarted = Promise.withResolvers<void>();
            const writeGate    = Promise.withResolvers<void>();
            store.put.mockImplementation(() => {
                writeStarted.resolve();
                return writeGate.promise;
            });
            let completed = false;
            const operation = start().then((): void => {
                completed = true;
                return undefined;
            });

            try {
                await writeStarted.promise;
                await Bun.sleep(0);
                return !completed;
            } finally {
                writeGate.resolve();
                await operation;
            }
        }

        test('saveFeedCheckpoint waits for the store write', async () => {
            const { store, manager } = setup();
            expect(await isPendingUntilWrite(store, () => manager.saveFeedCheckpoint(FEED_CHECKPOINT))).toBeTrue();
        });

        test('saveNotificationCheckpoint waits for the store write', async () => {
            const { store, manager } = setup();
            expect(await isPendingUntilWrite(store, () => manager.saveNotificationCheckpoint(NOTIF_CHECKPOINT))).toBeTrue();
        });

        test('saveDmCheckpoint waits for the store write', async () => {
            const { store, manager } = setup();
            expect(await isPendingUntilWrite(store, () => manager.saveDmCheckpoint(DM_CHECKPOINT))).toBeTrue();
        });

        test('processFeedItems waits for checkpoint persistence before returning items', async () => {
            const { store, manager } = setup();
            const item: BskyFeedItem = {
                post: {
                    uri:         'at://uri/new',
                    cid:         'bafycid',
                    author:      { did: 'did:plc:author', handle: 'author.bsky.social' },
                    text:        'Hello',
                    createdAt:   NOW,
                    replyCount:  0,
                    likeCount:   0,
                    repostCount: 0,
                    indexedAt:   NOW,
                },
            };
            expect(await isPendingUntilWrite(store, () => manager.processFeedItems('following', [item]))).toBeTrue();
        });

        test('processNotifications waits for checkpoint persistence before returning notifications', async () => {
            const { store, manager } = setup();
            const notification: BskyNotification = {
                reason: 'like', uri: 'at://notif/new', author: { did: 'did:plc:author', handle: 'author.bsky.social' }, indexedAt: NOW,
            };
            expect(await isPendingUntilWrite(store, () => manager.processNotifications([notification]))).toBeTrue();
        });

        test('processDirectMessages waits for checkpoint persistence before returning conversations', async () => {
            const { store, manager } = setup();
            const conversation: BskyConversation = {
                id:          'convo-new',
                rev:         'rev-1',
                members:     [],
                muted:       false,
                unreadCount: 1,
                lastMessage: { id: 'msg-new', rev: 'msg-rev-1', text: 'hi', senderDid: 'did:plc:sender', sentAt: NOW },
            };
            expect(await isPendingUntilWrite(store, () => manager.processDirectMessages([conversation]))).toBeTrue();
        });

        test('unprocessDirectMessages waits for the updated checkpoint to persist', async () => {
            const { store, manager } = setup();
            store.seed(DM_KEY, { ...DM_CHECKPOINT, processedMessageIds: ['keep', 'remove'] });
            expect(await isPendingUntilWrite(store, () => manager.unprocessDirectMessages(['remove']))).toBeTrue();
        });
    });
});
