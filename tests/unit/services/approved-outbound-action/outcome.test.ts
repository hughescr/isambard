import { describe, expect, test } from 'bun:test';
import { InvariantViolationError } from '@/errors';
import { describeApprovedActionOutcome } from '@/services/approved-outbound-action/outcome';
import type { ApprovedOutboundAction } from '@/services/approved-outbound-action/types';

const ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const REVISION = '2026-09-24T12:00:00.000Z';

function row(overrides: Partial<ApprovedOutboundAction>): ApprovedOutboundAction {
    return {
        id:        ID,
        state:     'executed',
        type:      'email_send',
        params:    { uid: 42 },
        createdAt: '2026-09-24T11:00:00.000Z',
        updatedAt: REVISION,
        ...overrides,
    };
}

const EMAIL = { type: 'email_send' as const, params: { uid: 42 } };
const REPLY = { type: 'bsky_reply' as const, params: { text: 'Thanks for the link!', parentUri: 'at://x', parentCid: 'cid' } };
const DM = { type: 'bsky_dm' as const, params: { text: 'See you Tuesday', convoId: 'convo-1' } };

describe('describeApprovedActionOutcome', () => {
    test('email_send executed', () => {
        expect(describeApprovedActionOutcome(row({ ...EMAIL, state: 'executed' }))).toEqual({
            source: 'email-approval',
            key:    `${ID}:executed:${REVISION}`,
            wake:   true,
            text:   'Outbound email (uid 42) was sent.',
            card:   { tone: 'sent', title: 'Sent ✓' },
        });
    });

    test('email_send failed transiently', () => {
        expect(describeApprovedActionOutcome(row({ ...EMAIL, state: 'failed', lastError: 'socket hang up', failureKind: 'transient' }))).toEqual({
            source: 'email-approval',
            key:    `${ID}:failed:${REVISION}`,
            wake:   true,
            text:   'Outbound email (uid 42) failed to send: socket hang up. It will be retried automatically when email reconnects.',
            card:   { tone: 'retrying', title: 'Send failed — will retry when email reconnects', detail: 'socket hang up' },
        });
    });

    test('email_send failed permanently', () => {
        expect(describeApprovedActionOutcome(row({ ...EMAIL, state: 'failed', lastError: 'uid not found', failureKind: 'permanent' }))).toEqual({
            source: 'email-approval',
            key:    `${ID}:failed:${REVISION}`,
            wake:   true,
            text:   'Outbound email (uid 42) failed to send and will not be retried: uid not found',
            card:   { tone: 'failed', title: 'Send failed — will not be retried', detail: 'uid not found' },
        });
    });

    test('bsky_reply executed', () => {
        expect(describeApprovedActionOutcome(row({ ...REPLY, state: 'executed' }))).toEqual({
            source: 'bsky-approval',
            key:    `${ID}:executed:${REVISION}`,
            wake:   false,
            text:   'Bluesky reply "Thanks for the link!" was posted.',
            card:   { tone: 'sent', title: 'Posted ✓' },
        });
    });

    test('bsky_reply failed transiently', () => {
        expect(describeApprovedActionOutcome(row({ ...REPLY, state: 'failed', lastError: 'HTTP 502', failureKind: 'transient' }))).toEqual({
            source: 'bsky-approval',
            key:    `${ID}:failed:${REVISION}`,
            wake:   true,
            text:   'Bluesky reply "Thanks for the link!" failed to post: HTTP 502. It will be retried automatically when Bluesky reconnects.',
            card:   { tone: 'retrying', title: 'Post failed — will retry when Bluesky reconnects', detail: 'HTTP 502' },
        });
    });

    test('bsky_reply failed permanently', () => {
        expect(describeApprovedActionOutcome(row({ ...REPLY, state: 'failed', lastError: 'Post exceeds 300 graphemes', failureKind: 'permanent' }))).toEqual({
            source: 'bsky-approval',
            key:    `${ID}:failed:${REVISION}`,
            wake:   true,
            text:   'Bluesky reply "Thanks for the link!" failed to post and will not be retried: Post exceeds 300 graphemes',
            card:   { tone: 'failed', title: 'Post failed — will not be retried', detail: 'Post exceeds 300 graphemes' },
        });
    });

    test('bsky_dm executed', () => {
        expect(describeApprovedActionOutcome(row({ ...DM, state: 'executed' }))).toEqual({
            source: 'bsky-approval',
            key:    `${ID}:executed:${REVISION}`,
            wake:   false,
            text:   'Bluesky DM "See you Tuesday" was sent.',
            card:   { tone: 'sent', title: 'DM sent ✓' },
        });
    });

    test('bsky_dm failed transiently', () => {
        expect(describeApprovedActionOutcome(row({ ...DM, state: 'failed', lastError: 'rate limited', failureKind: 'transient' }))).toEqual({
            source: 'bsky-approval',
            key:    `${ID}:failed:${REVISION}`,
            wake:   true,
            text:   'Bluesky DM "See you Tuesday" failed to send: rate limited. It will be retried automatically when Bluesky reconnects.',
            card:   { tone: 'retrying', title: 'DM failed — will retry when Bluesky reconnects', detail: 'rate limited' },
        });
    });

    test('bsky_dm failed permanently', () => {
        expect(describeApprovedActionOutcome(row({ ...DM, state: 'failed', lastError: 'convo gone', failureKind: 'permanent' }))).toEqual({
            source: 'bsky-approval',
            key:    `${ID}:failed:${REVISION}`,
            wake:   true,
            text:   'Bluesky DM "See you Tuesday" failed to send and will not be retried: convo gone',
            card:   { tone: 'failed', title: 'DM failed — will not be retried', detail: 'convo gone' },
        });
    });

    test('a failure with no failureKind is described as never retried', () => {
        const report = describeApprovedActionOutcome(row({ ...EMAIL, state: 'failed', lastError: 'old' }));

        expect(report.card).toEqual({ tone: 'failed', title: 'Send failed — will not be retried', detail: 'old' });
        expect(report.text).toBe('Outbound email (uid 42) failed to send and will not be retried: old');
    });

    test('a failure with no lastError reports an unknown error', () => {
        const report = describeApprovedActionOutcome(row({ ...EMAIL, state: 'failed', failureKind: 'permanent' }));

        expect(report.card.detail).toBe('unknown error');
        expect(report.text).toBe('Outbound email (uid 42) failed to send and will not be retried: unknown error');
    });

    test('the failure key carries the revision so each attempt is reported separately', () => {
        const first = describeApprovedActionOutcome(row({ ...EMAIL, state: 'failed', failureKind: 'transient', updatedAt: '2026-09-24T12:00:00.000Z' }));
        const second = describeApprovedActionOutcome(row({ ...EMAIL, state: 'failed', failureKind: 'transient', updatedAt: '2026-09-24T13:00:00.000Z' }));

        expect(first.key).toBe(`${ID}:failed:2026-09-24T12:00:00.000Z`);
        expect(second.key).toBe(`${ID}:failed:2026-09-24T13:00:00.000Z`);
    });

    test('error text is truncated at 500 characters', () => {
        const report = describeApprovedActionOutcome(row({ ...EMAIL, state: 'failed', failureKind: 'permanent', lastError: 'e'.repeat(600) }));

        expect(report.card.detail).toBe(`${'e'.repeat(497)}...`);
    });

    test('a Bluesky text snippet is truncated at 100 characters', () => {
        const report = describeApprovedActionOutcome(row({ ...DM, params: { text: 'x'.repeat(150), convoId: 'c' } }));

        expect(report.text).toBe(`Bluesky DM "${'x'.repeat(97)}..." was sent.`);
    });

    test('an email row without a numeric uid falls back to the generic label', () => {
        expect(describeApprovedActionOutcome(row({ type: 'email_send', params: { uid: '42' } })).text).toBe('Outbound email was sent.');
    });

    test('a Bluesky row without string text falls back to the generic label', () => {
        expect(describeApprovedActionOutcome(row({ type: 'bsky_reply', params: { text: 7 } })).text).toBe('Bluesky reply was posted.');
    });

    for(const state of ['approved', 'sending'] as const) {
        test(`a ${state} row has no outcome to describe`, () => {
            let thrown: unknown;
            try {
                describeApprovedActionOutcome(row({ state }));
            } catch (err) {
                thrown = err;
            }

            expect(thrown).toBeInstanceOf(InvariantViolationError);
            expect((thrown as InvariantViolationError).context).toEqual({
                location:  'describeApprovedActionOutcome',
                invariant: 'an action that is approved or still sending has no outcome yet',
            });
        });
    }
});
