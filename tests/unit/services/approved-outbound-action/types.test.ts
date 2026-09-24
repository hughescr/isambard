import { describe, expect, test } from 'bun:test';
import { type ApprovedOutboundActionState, type ApprovedOutboundActionWriter } from '@/services';
import { approvalCardRefSchema, approvedOutboundActionSchema, type ApprovedOutboundAction } from '@/services/approved-outbound-action/types';

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
