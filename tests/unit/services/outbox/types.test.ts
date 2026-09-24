import { describe, expect, test } from 'bun:test';
import { channelIdSchema } from '@/config';
import { serializedDiscordPayloadSchema } from '@/services/outbox/discord-payload';
import { outboxItemSchema, type OutboxItem } from '@/services/outbox/types';

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
    test('accepts a nonempty branded destination and rejects an empty destination', () => {
        const valid = outboxItemSchema.parse({ ...validItem, epoch: 0 });
        expect(valid.destination).toBe(channelIdSchema.parse('channel-123'));
        expect(outboxItemSchema.safeParse({ ...validItem, epoch: 0, destination: '' }).success).toBe(false);
    });

    test('accepts epoch zero and rejects negative epochs', () => {
        expect(outboxItemSchema.safeParse({ ...validItem, epoch: 0 }).success).toBe(true);
        expect(outboxItemSchema.safeParse({ ...validItem, epoch: -1 }).success).toBe(false);
    });

    test('legacy progress defaults attemptCount to zero and rejects invalid counts and services', () => {
        expect(outboxItemSchema.parse({ ...validItem, epoch: 0 }).progress.attemptCount).toBe(0);
        expect(outboxItemSchema.parse({ ...validItem, epoch: 0, progress: { attemptCount: 9 } }).progress.attemptCount).toBe(9);
        expect(outboxItemSchema.safeParse({ ...validItem, epoch: 0, progress: { attemptCount: -1 } }).success).toBe(false);
        expect(outboxItemSchema.safeParse({ ...validItem, epoch: 0, progress: { attemptCount: 1.5 } }).success).toBe(false);
        expect(outboxItemSchema.safeParse({ ...validItem, epoch: 0, service: 'email' }).success).toBe(false);
    });

    test('ttl accepts a valid epoch-seconds integer and rejects a negative one', () => {
        expect(outboxItemSchema.safeParse({ ...validItem, epoch: 0, ttl: 1_700_000_000 }).success).toBe(true);
        expect(outboxItemSchema.safeParse({ ...validItem, epoch: 0, ttl: -1 }).success).toBe(false);
    });

    test('ttl must be branded EpochSeconds, not a bare number', () => {
        // @ts-expect-error - ttl must be EpochSeconds, not a bare number
        const invalid: OutboxItem = { ...(validItem as unknown as OutboxItem), ttl: 1_700_000_000 };
        expect(invalid.ttl as unknown as number).toBe(1_700_000_000);
    });

    test('progress.deliveryToken accepts the 16-character producer value and the 17-character base budget, but rejects 18 characters', () => {
        expect(outboxItemSchema.safeParse({ ...validItem, epoch: 0, progress: { deliveryToken: '0123456789abcdef' } }).success).toBe(true);
        expect(outboxItemSchema.safeParse({ ...validItem, epoch: 0, progress: { deliveryToken: '0'.repeat(17) } }).success).toBe(true);
        expect(outboxItemSchema.safeParse({ ...validItem, epoch: 0, progress: { deliveryToken: '0'.repeat(18) } }).success).toBe(false);
    });
});

describe('serializedDiscordPayloadSchema', () => {
    for(const [description, embed] of [['null', null], ['array', []], ['string', 'x']] as const) {
        test(`rejects malformed ${description} embed element without throwing`, () => {
            expect(serializedDiscordPayloadSchema.safeParse({ embeds: [embed] }).success).toBe(false);
        });
    }

    for(const [description, component] of [
        ['non-action-row type', { type: 2, components: [] }],
        ['action row without components', { type: 1 }],
        ['action row with a null component', { type: 1, components: [null] }],
        ['action row with a valid then a null component', { type: 1, components: [{ type: 2, custom_id: 'approve', label: 'Approve', style: 3 }, null] }],
    ] as const) {
        test(`rejects malformed component row (${description}) without throwing`, () => {
            expect(serializedDiscordPayloadSchema.safeParse({ components: [component] }).success).toBe(false);
        });
    }

    test.each([undefined, null, 'x'])('rejects non-object payload %p without throwing', (payload) => {
        expect(serializedDiscordPayloadSchema.safeParse(payload).success).toBe(false);
    });

    test('preserves extra API payload fields', () => {
        const payload = {
            embeds:     [{ title: 'Approval needed', future_embed_field: 'kept' }],
            components: [{
                type:             1,
                components:       [{ type: 2, custom_id: 'approve', label: 'Approve', style: 3, future_component_field: 'kept' }],
                future_row_field: 'kept',
            }],
        };

        expect(serializedDiscordPayloadSchema.parse(payload)).toEqual(payload);
    });
});
