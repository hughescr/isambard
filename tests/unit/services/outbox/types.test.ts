import { describe, expect, test } from 'bun:test';
import { serializedDiscordPayloadSchema } from '@/services/outbox/discord-payload';
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

    // Legacy pre-#49 outbox rows: can be safely deleted after 2026-09-25.
    test('rejects legacy action rows without a components array without throwing', () => {
        expect(serializedDiscordPayloadSchema.safeParse({ components: [{ data: { type: 1 } }] }).success).toBe(false);
    });

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
