/**
 * Notices telling Izzy that the outbox discarded one of her queued Discord messages undelivered
 * (#141). A reply dropped because its target was deleted is told by the replay itself
 * (`describeDroppedReply`); this module covers the discards the drainer decides.
 */
import type { NotifyFn, NotifyParams } from '@/agent';
import { boundNoticeText, messageChunksFor } from '@/integrations/discord/outbox-replay';
import type { DrainerDiscardReason, OutboxDiscardReporter, OutboxItem } from '@/services';

const DISCARD_REASON_TEXT: Record<DrainerDiscardReason, string> = {
    permanent_error:    'it ran out of delivery attempts',
    classified_abandon: 'Discord rejected it with an error judged permanent',
    stale_epoch:        'it was queued under a Discord connection that no longer applies',
};

/**
 * The notification Izzy receives when the drainer discards a queued message. An item whose last
 * outcome is `unknown` may already have been posted, so the notice says so rather than claiming
 * it was not delivered. After a partial delivery only the parts not yet posted are quoted. A
 * message sent during a notification turn (its reply or a tool send) is reported without waking
 * Izzy, so this notice can never open a turn whose own message is discarded and reported in turn.
 */
export function describeDiscardedMessage(item: OutboxItem, reason: DrainerDiscardReason): NotifyParams {
    const lastError = item.progress.lastError === undefined ? '' : ` (last error: ${item.progress.lastError})`;
    const cause = `${DISCARD_REASON_TEXT[reason]}${lastError}`;
    const posted = item.progress.deliveredParts ?? 0;
    let partial = '';
    let remainder = item.payload.text ?? '';
    if(posted > 0) {
        const chunks = messageChunksFor(item);
        partial = ` The first ${posted} of ${chunks.length} parts were already posted; only the rest is shown.`;
        remainder = chunks.slice(posted).join('\n\n');
    }
    const quoted = boundNoticeText(remainder);
    const text = item.progress.outcome === 'unknown'
        ? `A queued Discord message to channel ${item.destination} was dropped, but it may already have been posted: Discord never confirmed its delivery, and ${cause}. Check the channel before sending it again.${partial} Unconfirmed text:\n\n${quoted}`
        : `A queued Discord message to channel ${item.destination} was dropped and NOT delivered: ${cause}.${partial} Undelivered text:\n\n${quoted}`;
    return { source: 'discord-outbox', key: item.id, wake: item.origin !== 'notification', text };
}

/**
 * The drainer's discard reporter: tells Izzy about a discarded `agent_response` (her own words)
 * and returns whether she could be told. Other outbox types are discarded without a notice.
 */
export function createOutboxDiscardReporter(notify: NotifyFn): OutboxDiscardReporter {
    return (item, reason) => item.type !== 'agent_response' || notify(describeDiscardedMessage(item, reason));
}
