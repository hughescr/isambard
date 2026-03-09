import { describe, test, expect } from 'bun:test';
import {
    bskyFeedCheckpointSchema,
    bskyNotificationCheckpointSchema,
    MAX_PROCESSED_URIS
} from '@/integrations/bsky/checkpoint/types';

describe('bskyFeedCheckpointSchema', () => {
    const VALID_FEED_CHECKPOINT = {
        service:       'bsky',
        type:          'feed',
        feedName:      'following',
        lastIndexedAt: '2026-03-07T12:00:00.000Z',
        processedUris: ['at://did:plc:abc/app.bsky.feed.post/123'],
        updatedAt:     '2026-03-07T12:00:01.000Z',
    };

    test('accepts valid feed checkpoint', () => {
        const result = bskyFeedCheckpointSchema.safeParse(VALID_FEED_CHECKPOINT);
        expect(result.success).toBe(true);
    });

    test('accepts feed checkpoint without lastIndexedAt', () => {
        const { lastIndexedAt: _, ...checkpoint } = VALID_FEED_CHECKPOINT;
        const result = bskyFeedCheckpointSchema.safeParse(checkpoint);
        expect(result.success).toBe(true);
    });

    test('accepts feed checkpoint with empty processedUris', () => {
        const result = bskyFeedCheckpointSchema.safeParse({
            ...VALID_FEED_CHECKPOINT,
            processedUris: [],
        });
        expect(result.success).toBe(true);
    });

    test('rejects wrong service literal', () => {
        const result = bskyFeedCheckpointSchema.safeParse({
            ...VALID_FEED_CHECKPOINT,
            service: 'discord',
        });
        expect(result.success).toBe(false);
    });

    test('rejects wrong type literal', () => {
        const result = bskyFeedCheckpointSchema.safeParse({
            ...VALID_FEED_CHECKPOINT,
            type: 'notification',
        });
        expect(result.success).toBe(false);
    });

    test('rejects empty feedName', () => {
        const result = bskyFeedCheckpointSchema.safeParse({
            ...VALID_FEED_CHECKPOINT,
            feedName: '',
        });
        expect(result.success).toBe(false);
    });

    test('rejects invalid datetime for updatedAt', () => {
        const result = bskyFeedCheckpointSchema.safeParse({
            ...VALID_FEED_CHECKPOINT,
            updatedAt: 'not-a-date',
        });
        expect(result.success).toBe(false);
    });

    test('rejects missing required fields', () => {
        const result = bskyFeedCheckpointSchema.safeParse({});
        expect(result.success).toBe(false);
    });
});

describe('bskyNotificationCheckpointSchema', () => {
    const VALID_NOTIF_CHECKPOINT = {
        service:       'bsky',
        type:          'notification',
        lastSeenAt:    '2026-03-07T12:00:00.000Z',
        processedUris: ['at://did:plc:abc/app.bsky.feed.like/456'],
        updatedAt:     '2026-03-07T12:00:01.000Z',
    };

    test('accepts valid notification checkpoint', () => {
        const result = bskyNotificationCheckpointSchema.safeParse(VALID_NOTIF_CHECKPOINT);
        expect(result.success).toBe(true);
    });

    test('accepts notification checkpoint without lastSeenAt', () => {
        const { lastSeenAt: _, ...checkpoint } = VALID_NOTIF_CHECKPOINT;
        const result = bskyNotificationCheckpointSchema.safeParse(checkpoint);
        expect(result.success).toBe(true);
    });

    test('rejects wrong service literal', () => {
        const result = bskyNotificationCheckpointSchema.safeParse({
            ...VALID_NOTIF_CHECKPOINT,
            service: 'discord',
        });
        expect(result.success).toBe(false);
    });

    test('rejects wrong type literal', () => {
        const result = bskyNotificationCheckpointSchema.safeParse({
            ...VALID_NOTIF_CHECKPOINT,
            type: 'feed',
        });
        expect(result.success).toBe(false);
    });

    test('rejects missing required fields', () => {
        const result = bskyNotificationCheckpointSchema.safeParse({});
        expect(result.success).toBe(false);
    });
});

describe('MAX_PROCESSED_URIS', () => {
    test('is 500', () => {
        expect(MAX_PROCESSED_URIS).toBe(500);
    });
});
