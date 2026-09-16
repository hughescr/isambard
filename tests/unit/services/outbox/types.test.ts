import { describe, expect, test } from 'bun:test';
import { outboxItemSchema } from '@/services/outbox/types';

const validItem = {
    id:          'aaaaaaaa-1111-4222-8333-444444444444',
    createdAt:   '2026-03-30T12:00:00.000Z',
    type:        'agent_response',
    service:     'discord',
    destination: 'channel-123',
    payload:     { text: 'Hello world' },
    priority:    'medium',
    dedupeKey:   'dedup-abc',
    progress:    {},
};

describe('outboxItemSchema', () => {
    test('accepts epoch zero and rejects negative epochs', () => {
        expect(outboxItemSchema.safeParse({ ...validItem, epoch: 0 }).success).toBe(true);
        expect(outboxItemSchema.safeParse({ ...validItem, epoch: -1 }).success).toBe(false);
    });
});
