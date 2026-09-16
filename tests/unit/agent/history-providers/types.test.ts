import { describe, expect, test } from 'bun:test';
import { historyEntrySchema } from '@/agent/history-providers/types';

const baseEntry = {
    platform:  'discord',
    timestamp: '2026-09-12T12:00:00.000Z',
    summary:   'A reply arrived',
    direction: 'inbound',
};

describe('historyEntrySchema', () => {
    test.each(['inbound', 'outbound', 'mutual'])('accepts %s direction', (direction) => {
        expect(historyEntrySchema.safeParse({ ...baseEntry, direction }).success).toBe(true);
    });

    test.each(['discord', 'email', 'bsky'])('accepts %s platform', (platform) => {
        expect(historyEntrySchema.safeParse({ ...baseEntry, platform }).success).toBe(true);
    });

    test('requires a nonempty summary and recognized direction', () => {
        expect(historyEntrySchema.safeParse({ ...baseEntry, summary: '' }).success).toBe(false);
        expect(historyEntrySchema.safeParse({ ...baseEntry, direction: 'sideways' }).success).toBe(false);
    });

    test('accepts a one-character summary', () => {
        expect(historyEntrySchema.safeParse({ ...baseEntry, summary: 'x' }).success).toBe(true);
    });
});
