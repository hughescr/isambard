import { describe, expect, test } from 'bun:test';
import { decodeStoredMemoryToolItem, storedTtl as brandedStoredTtl } from '@/storage/memory-tool/decode-stored-item';

/** The brand is irrelevant to these assertions; compare plain numbers. */
const storedTtl = (item: object): number | undefined => brandedStoredTtl(item);

describe('storedTtl', () => {
    test('returns a valid epoch-seconds TTL, zero included', () => {
        expect(storedTtl({ TTL: 1_800_000_000 })).toBe(1_800_000_000);
        expect(storedTtl({ TTL: 0 })).toBe(0);
    });

    test.each([
        ['absent', {}],
        ['a string', { TTL: '1800000000' }],
        ['negative', { TTL: -1 }],
        ['fractional', { TTL: 1.5 }],
        ['null', { TTL: null }],
    ])('returns undefined for a TTL that is %s', (_label, item) => {
        expect(storedTtl(item)).toBeUndefined();
    });

    test('reads the TTL a decoded item carries at runtime', () => {
        const decoded = decodeStoredMemoryToolItem({
            PK:             'DIR#/events/activity/chat',
            SK:             'FILE#2026-09-24',
            GSI1PK:         'LAYER#events',
            GSI1SK:         'UPDATED#2026-09-24T00:00:00.000Z',
            path:           '/events/activity/chat/2026-09-24',
            content:        'x',
            contentType:    'text/plain',
            contentPreview: 'x',
            createdAt:      '2026-09-24T00:00:00.000Z',
            updatedAt:      '2026-09-24T00:00:00.000Z',
            TTL:            1_800_000_000,
        });
        expect(decoded).toBeDefined();
        expect(storedTtl(decoded!)).toBe(1_800_000_000);
    });
});
