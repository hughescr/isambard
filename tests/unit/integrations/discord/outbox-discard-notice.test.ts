import { describe, test, expect, mock } from 'bun:test';
import type { NotifyParams } from '@/agent';
import { createChannelId } from '@/agent/types';
import { DISCORD_MAX_LENGTH } from '@/integrations/discord/messages';
import { createOutboxDiscardReporter, describeDiscardedMessage } from '@/integrations/discord/outbox-discard-notice';
import { DISCARD_NOTICE_TEXT_LIMIT, deliveryTokenFor, messageChunksFor } from '@/integrations/discord/outbox-replay';
import type { OutboxItem } from '@/services/outbox';
import { maxContentLengthForDeliveryCode } from '@/utils/delivery-code';

const ITEM_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const HEAD = 'A queued Discord message to channel ch-1 was dropped and NOT delivered: ';
const UNCONFIRMED_HEAD = 'A queued Discord message to channel ch-1 was dropped, but it may already have been posted: Discord never confirmed its delivery, and ';

function makeItem(overrides: Partial<OutboxItem> = {}): OutboxItem {
    return {
        id:          ITEM_ID,
        createdAt:   '2026-09-25T12:00:00.000Z',
        type:        'agent_response',
        service:     'discord',
        destination: createChannelId('ch-1'),
        payload:     { text: 'The undelivered words' },
        priority:    'high',
        dedupeKey:   'dedupe',
        progress:    { attemptCount: 10, deliveryToken: 'budgettoken' },
        epoch:       0,
        ...overrides,
    };
}

/** Text of `parts` chunks with no whitespace, so joining its chunks differs from the original. */
function textOfParts(parts: number): string {
    const budget = maxContentLengthForDeliveryCode(deliveryTokenFor(makeItem(), 0), DISCORD_MAX_LENGTH);
    return 'a'.repeat(budget * (parts - 1) + 1);
}

describe('describeDiscardedMessage', () => {
    test('tells Izzy an exhausted message was not delivered, where it was going, why, and what it said', () => {
        const item = makeItem({ progress: { attemptCount: 10, lastError: 'Missing Access' } });

        expect(describeDiscardedMessage(item, 'permanent_error')).toStrictEqual({
            source: 'discord-outbox',
            key:    ITEM_ID,
            wake:   true,
            text:   `${HEAD}it ran out of delivery attempts (last error: Missing Access). Undelivered text:\n\nThe undelivered words`,
        });
    });

    test('names a classified abandon as a permanent Discord rejection', () => {
        const item = makeItem({ progress: { attemptCount: 1, lastError: 'Missing Permissions', outcome: 'retryable' } });

        expect(describeDiscardedMessage(item, 'classified_abandon').text).toBe(`${HEAD}Discord rejected it with an error judged permanent (last error: Missing Permissions). Undelivered text:\n\nThe undelivered words`);
    });

    test('names a stale epoch and omits the error when there was none', () => {
        expect(describeDiscardedMessage(makeItem({ progress: { attemptCount: 0 } }), 'stale_epoch').text).toBe(`${HEAD}it was queued under a Discord connection that no longer applies. Undelivered text:\n\nThe undelivered words`);
    });

    test('says an unconfirmed message may already have been posted instead of claiming it was not delivered', () => {
        const item = makeItem({ progress: { attemptCount: 10, outcome: 'unknown', lastError: 'Discord delivery verification remains indeterminate' } });

        expect(describeDiscardedMessage(item, 'permanent_error').text).toBe(`${UNCONFIRMED_HEAD}it ran out of delivery attempts (last error: Discord delivery verification remains indeterminate). Check the channel before sending it again. Unconfirmed text:\n\nThe undelivered words`);
    });

    test('leaves the text empty for an item without text', () => {
        expect(describeDiscardedMessage(makeItem({ payload: {}, progress: { attemptCount: 0 } }), 'stale_epoch').text).toBe(`${HEAD}it was queued under a Discord connection that no longer applies. Undelivered text:\n\n`);
    });

    test('shows the original text, not rejoined parts, when no part was posted', () => {
        const text = textOfParts(2);
        const item = makeItem({ payload: { text }, progress: { attemptCount: 10, deliveryToken: 'budgettoken', deliveredParts: 0 } });

        expect(describeDiscardedMessage(item, 'permanent_error').text).toBe(`${HEAD}it ran out of delivery attempts. Undelivered text:\n\n${text}`);
    });

    test('shows only the parts not yet posted and says how many were', () => {
        const item = makeItem({ payload: { text: textOfParts(3) }, progress: { attemptCount: 10, deliveryToken: 'budgettoken', deliveredParts: 1 } });
        const rest = messageChunksFor(item).slice(1).join('\n\n');

        expect(describeDiscardedMessage(item, 'permanent_error').text).toBe(`${HEAD}it ran out of delivery attempts. The first 1 of 3 parts were already posted; only the rest is shown. Undelivered text:\n\n${rest}`);
        expect(rest).toBe(`${messageChunksFor(item)[1]}\n\na`);
    });

    test('bounds the undelivered text', () => {
        const text = 'b'.repeat(DISCARD_NOTICE_TEXT_LIMIT + 1);

        expect(describeDiscardedMessage(makeItem({ payload: { text }, progress: { attemptCount: 0 } }), 'stale_epoch').text).toBe(`${HEAD}it was queued under a Discord connection that no longer applies. Undelivered text:\n\n${'b'.repeat(DISCARD_NOTICE_TEXT_LIMIT)}… [1 more characters not shown]`);
    });

    test('does not wake Izzy for a reply to a notification turn', () => {
        expect(describeDiscardedMessage(makeItem({ origin: 'notification' }), 'classified_abandon').wake).toBe(false);
    });
});

describe('createOutboxDiscardReporter', () => {
    test('notifies Izzy of a discarded agent response and returns whether she could be told', () => {
        const notify = mock((_params: NotifyParams): boolean => false);
        const report = createOutboxDiscardReporter(notify);
        const item = makeItem();

        expect(report(item, 'permanent_error')).toBe(false);
        expect(notify).toHaveBeenCalledWith(describeDiscardedMessage(item, 'permanent_error'));
        notify.mockImplementation((): boolean => true);
        expect(report(item, 'stale_epoch')).toBe(true);
        expect(notify).toHaveBeenLastCalledWith(describeDiscardedMessage(item, 'stale_epoch'));
    });

    test('discards other outbox types without a notice', () => {
        const notify = mock((_params: NotifyParams): boolean => false);
        const report = createOutboxDiscardReporter(notify);

        for(const type of ['perch_output', 'catch_up_output', 'email_notification', 'email_approval', 'bsky_approval', 'contact_approval'] as const) {
            expect(report(makeItem({ type }), 'classified_abandon')).toBe(true);
        }
        expect(notify).not.toHaveBeenCalled();
    });
});
