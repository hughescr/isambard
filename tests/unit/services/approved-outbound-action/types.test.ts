import { describe, expect, test } from 'bun:test';
import { type ApprovedOutboundActionState, type ApprovedOutboundActionWriter } from '@/services';
import {
    adminPingSchema,
    approvalCardRefSchema,
    approvedOutboundActionSchema,
    deliveryWindowStart,
    isClaimed,
    isUnverified,
    type ApprovedOutboundAction
} from '@/services/approved-outbound-action/types';

const CARD_CHANNEL_ID = '1283746501928374650';
const CARD_MESSAGE_ID = '1419283746501928374';

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
    test('accepts each of the five lifecycle states', () => {
        for(const state of ['approved', 'sending', 'executed', 'failed', 'unverified'] as const) {
            expect(approvedOutboundActionSchema.parse({ ...ROW, state }).state).toBe(state);
        }
    });

    test('accepts and keeps firstClaimedAt and ambiguousSends', () => {
        const row = { ...ROW, state: 'unverified' as const, firstClaimedAt: '2026-09-23T00:01:00.000Z', ambiguousSends: 0 };
        expect(approvedOutboundActionSchema.parse(row)).toEqual(row);
    });

    test('rejects a firstClaimedAt that is not an ISO datetime', () => {
        expect(approvedOutboundActionSchema.safeParse({ ...ROW, firstClaimedAt: 'yesterday' }).success).toBe(false);
    });

    test('rejects a negative ambiguousSends', () => {
        expect(approvedOutboundActionSchema.safeParse({ ...ROW, ambiguousSends: -1 }).success).toBe(false);
    });

    test('rejects a fractional ambiguousSends', () => {
        expect(approvedOutboundActionSchema.safeParse({ ...ROW, ambiguousSends: 1.5 }).success).toBe(false);
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

    test('accepts a row without an approvalCard (written before the card ref existed)', () => {
        expect(approvedOutboundActionSchema.parse(ROW)).toEqual(ROW);
    });

    test('accepts and keeps an approvalCard reference of two Discord snowflakes', () => {
        const row = { ...ROW, approvalCard: { channelId: CARD_CHANNEL_ID, messageId: CARD_MESSAGE_ID } };
        expect(approvedOutboundActionSchema.parse(row)).toEqual(row);
    });

    test('accepts an approvalCard whose ids are single-digit snowflakes', () => {
        const card = { channelId: '7', messageId: '8' };
        expect(approvalCardRefSchema.parse(card)).toEqual(card);
    });

    test('rejects an approvalCard with an empty channelId', () => {
        expect(approvedOutboundActionSchema.safeParse({ ...ROW, approvalCard: { channelId: '', messageId: CARD_MESSAGE_ID } }).success).toBe(false);
    });

    test('rejects an approvalCard with an empty messageId', () => {
        expect(approvedOutboundActionSchema.safeParse({ ...ROW, approvalCard: { channelId: CARD_CHANNEL_ID, messageId: '' } }).success).toBe(false);
    });

    test('rejects an approvalCard whose channelId is not a decimal snowflake', () => {
        const result = approvalCardRefSchema.safeParse({ channelId: 'ch-1', messageId: CARD_MESSAGE_ID });
        expect(result.error?.issues.map(issue => [issue.path, issue.message])).toEqual([[['channelId'], 'Discord ID must be a decimal snowflake']]);
    });

    test('rejects an approvalCard whose messageId is not a decimal snowflake', () => {
        const result = approvalCardRefSchema.safeParse({ channelId: CARD_CHANNEL_ID, messageId: 'msg-1' });
        expect(result.error?.issues.map(issue => [issue.path, issue.message])).toEqual([[['messageId'], 'Discord ID must be a decimal snowflake']]);
    });

    test('accepts and keeps an outcomeReportPending marker', () => {
        const row = { ...ROW, state: 'executed' as const, outcomeReportPending: true };
        expect(approvedOutboundActionSchema.parse(row)).toEqual(row);
    });

    test('rejects a non-boolean outcomeReportPending marker', () => {
        expect(approvedOutboundActionSchema.safeParse({ ...ROW, outcomeReportPending: 'yes' }).success).toBe(false);
    });

    test('accepts a durable notified marker and preserves legacy rows without it', () => {
        expect(approvedOutboundActionSchema.parse({ ...ROW, outcomeNotified: true })).toEqual({ ...ROW, outcomeNotified: true });
        expect(approvedOutboundActionSchema.parse(ROW)).toEqual(ROW);
    });

    test('rejects a non-boolean notified marker', () => {
        expect(approvedOutboundActionSchema.safeParse({ ...ROW, outcomeNotified: 'yes' }).success).toBe(false);
    });

    test('accepts and keeps the escalation markers and an admin resolution (#125)', () => {
        const row = { ...ROW, state: 'executed' as const, escalated: true, resolvedBy: 'admin' as const };
        expect(approvedOutboundActionSchema.parse(row)).toEqual(row);
    });

    test('rejects a non-boolean escalated marker', () => {
        expect(approvedOutboundActionSchema.safeParse({ ...ROW, escalated: 'yes' }).success).toBe(false);
    });

    test('keeps the admin ping record off the row: a stray adminNotified is stripped on read', () => {
        expect(approvedOutboundActionSchema.parse({ ...ROW, adminNotified: true })).toEqual(ROW);
    });

    test('an admin ping record keeps the message carrying the controls and strips its storage keys', () => {
        const message = { channelId: CARD_CHANNEL_ID, messageId: CARD_MESSAGE_ID };
        expect(adminPingSchema.parse({ PK: 'APPROVAL#ADMIN_PING', SK: 'SAGA#x', TTL: 1, message })).toStrictEqual({ message });
        expect(adminPingSchema.parse({ PK: 'APPROVAL#ADMIN_PING' })).toStrictEqual({});
    });

    test('an admin ping record rejects a message that is not a Discord message reference', () => {
        expect(adminPingSchema.safeParse({ message: { channelId: 'admin-review', messageId: CARD_MESSAGE_ID } }).success).toBe(false);
    });

    test('rejects a resolvedBy other than admin', () => {
        expect(approvedOutboundActionSchema.safeParse({ ...ROW, resolvedBy: 'check' }).success).toBe(false);
    });

    test('accepts and keeps a claimId uuid on a sending row', () => {
        const row = { ...ROW, state: 'sending' as const, claimId: '11111111-2222-4333-8444-555555555555' };
        expect(approvedOutboundActionSchema.parse(row)).toEqual(row);
    });

    test('rejects a claimId that is not a uuid', () => {
        expect(approvedOutboundActionSchema.safeParse({ ...ROW, state: 'sending', claimId: 'claim-1' }).success).toBe(false);
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

describe('isClaimed', () => {
    const CLAIM_ID = '11111111-2222-4333-8444-555555555555';

    test('is true for a sending row that carries a claimId', () => {
        expect(isClaimed({ ...ROW, state: 'sending', claimId: CLAIM_ID })).toBe(true);
    });

    test('is false for a sending row with no claimId', () => {
        expect(isClaimed({ ...ROW, state: 'sending' })).toBe(false);
    });

    test('is false for an approved row even if it carries a claimId', () => {
        expect(isClaimed({ ...ROW, state: 'approved', claimId: CLAIM_ID })).toBe(false);
    });
});

describe('isUnverified', () => {
    test('is true only for an unverified row', () => {
        expect(isUnverified({ ...ROW, state: 'unverified' })).toBe(true);
        expect(isUnverified({ ...ROW, state: 'sending' })).toBe(false);
        expect(isUnverified(ROW)).toBe(false);
    });
});

describe('deliveryWindowStart', () => {
    test('is the first claim when one was recorded', () => {
        expect(deliveryWindowStart({ ...ROW, firstClaimedAt: '2026-09-23T00:05:00.000Z' })).toEqual(new Date('2026-09-23T00:05:00.000Z'));
    });

    test('is the approval when no first claim was recorded', () => {
        expect(deliveryWindowStart({ ...ROW, createdAt: '2026-09-22T23:00:00.000Z' })).toEqual(new Date('2026-09-22T23:00:00.000Z'));
    });
});
