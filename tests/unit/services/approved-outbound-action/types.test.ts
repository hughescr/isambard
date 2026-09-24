import { describe, expect, test } from 'bun:test';
import { type ApprovedOutboundActionState, type ApprovedOutboundActionWriter } from '@/services';
import { approvedOutboundActionSchema, type ApprovedOutboundAction } from '@/services/approved-outbound-action/types';

const ROW: ApprovedOutboundAction = {
    id:        '550e8400-e29b-41d4-a716-446655440000',
    state:     'approved',
    type:      'email_send',
    params:    { uid: 7 },
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
};

describe('ApprovedOutboundActionWriter', () => {
    test('accepts records whose state is approved and rejects retired review states at compile time', () => {
        const state: ApprovedOutboundActionState = 'approved';
        const action: Parameters<ApprovedOutboundActionWriter['create']>[0] = {
            id:        '550e8400-e29b-41d4-a716-446655440000',
            state,
            type:      'email_send',
            params:    {},
            createdAt: '2026-09-23T00:00:00.000Z',
            updatedAt: '2026-09-23T00:00:00.000Z',
        };
        // @ts-expect-error -- the writer must reject misspelled states.
        const misspelled: Parameters<ApprovedOutboundActionWriter['create']>[0] = { ...action, state: 'aproved' };
        // @ts-expect-error -- pending_approval is no longer part of the lifecycle (#40).
        const pending: Parameters<ApprovedOutboundActionWriter['create']>[0] = { ...action, state: 'pending_approval' };
        // @ts-expect-error -- rejected is no longer part of the lifecycle (#40).
        const rejected: Parameters<ApprovedOutboundActionWriter['create']>[0] = { ...action, state: 'rejected' };

        expect(action.state).toBe('approved');
        expect([misspelled, pending, rejected]).toHaveLength(3);
    });
});

describe('approvedOutboundActionSchema', () => {
    test('accepts each of the three lifecycle states', () => {
        for(const state of ['approved', 'executed', 'failed'] as const) {
            expect(approvedOutboundActionSchema.parse({ ...ROW, state }).state).toBe(state);
        }
    });

    test('rejects the retired pending_approval state', () => {
        expect(approvedOutboundActionSchema.safeParse({ ...ROW, state: 'pending_approval' }).success).toBe(false);
    });

    test('rejects the retired rejected state', () => {
        expect(approvedOutboundActionSchema.safeParse({ ...ROW, state: 'rejected' }).success).toBe(false);
    });

    test('accepts each of the three action types', () => {
        for(const type of ['bsky_reply', 'bsky_dm', 'email_send'] as const) {
            expect(approvedOutboundActionSchema.parse({ ...ROW, type }).type).toBe(type);
        }
    });

    test('rejects the retired email_reply type', () => {
        expect(approvedOutboundActionSchema.safeParse({ ...ROW, type: 'email_reply' }).success).toBe(false);
    });

    test('accepts a failed row with each failureKind', () => {
        for(const failureKind of ['transient', 'permanent'] as const) {
            expect(approvedOutboundActionSchema.parse({ ...ROW, state: 'failed', lastError: 'boom', failureKind }).failureKind).toBe(failureKind);
        }
    });

    test('accepts a failed row without a failureKind (written before #40)', () => {
        const parsed = approvedOutboundActionSchema.parse({ ...ROW, state: 'failed', lastError: 'boom' });
        expect(parsed).toEqual({ ...ROW, state: 'failed', lastError: 'boom' });
    });

    test('rejects an unknown failureKind', () => {
        expect(approvedOutboundActionSchema.safeParse({ ...ROW, state: 'failed', failureKind: 'maybe' }).success).toBe(false);
    });

    test('strips the four retired review-only fields when parsing', () => {
        const parsed = approvedOutboundActionSchema.parse({
            ...ROW,
            approvalChannelId: 'ch-1',
            approvalMessageId: 'msg-1',
            adminUserId:       'admin-1',
            rejectionReason:   'nope',
        });
        expect(parsed).toEqual(ROW);
    });
});
