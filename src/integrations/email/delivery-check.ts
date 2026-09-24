import { emailSendParamsSchema } from './outbound-approvals';
import type { WildDuckClient } from './wildduck-client';
import { EmailFolder } from '@/config';
import type { DeliveryCheck, DeliveryCheckInput } from '@/services';

function undetermined(reason: string): DeliveryCheck {
    return { verdict: 'undetermined', reason };
}

/**
 * Check an approved `email_send` action's destination, from the fingerprint recorded at
 * approval: the draft's Message-ID and its Date header then.
 *
 * WildDuck's submit rewrites the draft's Date to the send time before it queues anything, then
 * moves the draft into Sent Mail with its Message-ID unchanged. So, in order:
 * - no fingerprint recorded (an older row, or the approval-time read failed): undetermined;
 * - the Message-ID is in Sent Mail: delivered;
 * - the draft is gone from Drafts with no Sent copy found: undetermined — never absent, since a
 *   resend of a vanished draft could only fail the same way;
 * - the draft is no longer the same message, or no longer a draft: undetermined;
 * - the draft's Date has changed since approval: undetermined (a submit reached WildDuck);
 * - otherwise — the same, untouched draft is still waiting in Drafts: not delivered.
 *
 * A Message-ID identifies one email: two actions sharing one are approvals of the same draft, so
 * whichever found it is right, and a Sent copy of that draft found at any time, inside the
 * delivery window or after it, means it went out and must not be sent again. So the window is
 * not used. Unparseable params throw.
 */
export async function checkEmailSendDelivery(
    client: Pick<WildDuckClient, 'getMessage' | 'findMessageByMessageId'>,
    input: DeliveryCheckInput
): Promise<DeliveryCheck> {
    const { uid, messageId, draftDate } = emailSendParamsSchema.parse(input.params);
    if(messageId === undefined || draftDate === undefined) {
        return undetermined('no Message-ID and Date were recorded at approval to look for');
    }
    if(await client.findMessageByMessageId(EmailFolder.Sent, messageId, input.signal)) {
        return { verdict: 'delivered' };
    }
    const draft = await client.getMessage(EmailFolder.Drafts, uid, input.signal);
    if(draft === null) {
        return undetermined('the draft is gone from Drafts and no copy was found in Sent Mail');
    }
    if(draft.messageId !== messageId || draft.draft !== true) {
        return undetermined('the message at the draft’s uid is no longer the approved draft');
    }
    if(draft.date !== draftDate) {
        return undetermined('the draft’s Date has changed since approval, so a submit reached WildDuck');
    }
    return { verdict: 'not-delivered' };
}
