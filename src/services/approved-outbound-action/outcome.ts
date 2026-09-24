import { truncate } from 'lodash-es';
import type { ApprovedOutboundAction, ApprovedOutboundActionType } from './types';
import { InvariantViolationError } from '@/errors';

/** How the approval card shows an outcome: sent (green), failed but retrying (amber), failed for good (red). */
export type ApprovedActionOutcomeTone = 'sent' | 'retrying' | 'failed';

/** What to tell the admin (on the approval card) and Izzy (as a notification) about one outcome. */
export interface ApprovedActionOutcomeReport {
    /** Notification source, the same one the platform's approval notices already use. */
    source: 'email-approval' | 'bsky-approval'
    /** Notification dedupe key: the row id, state and `updatedAt` revision, so each attempt is reported once. */
    key:    string
    /** Whether the notification opens a turn for Izzy. */
    wake:   boolean
    /** Notification text for Izzy. */
    text:   string
    card: {
        tone:    ApprovedActionOutcomeTone
        title:   string
        /** The error, for a failure. */
        detail?: string
    }
}

const MAX_ERROR_LENGTH   = 500;
const MAX_SNIPPET_LENGTH = 100;

interface TypeCopy {
    source:          ApprovedActionOutcomeReport['source']
    /** Generic subject, e.g. `Outbound email`. */
    subject:         string
    /** Verb for the failure text, e.g. `send` in "failed to send". */
    verb:            string
    /** Past tense for the success text, e.g. `sent` in "was sent". */
    past:            string
    /** Service name in "when … reconnects". */
    service:         string
    sentTitle:       string
    failTitlePrefix: string
    /** Only email approvals wake Izzy on success, matching the pre-existing per-platform budget. */
    wakeOnSuccess:   boolean
}

const COPY: Record<ApprovedOutboundActionType, TypeCopy> = {
    email_send: {
        source:          'email-approval',
        subject:         'Outbound email',
        verb:            'send',
        past:            'sent',
        service:         'email',
        sentTitle:       'Sent ✓',
        failTitlePrefix: 'Send failed',
        wakeOnSuccess:   true,
    },
    bsky_reply: {
        source:          'bsky-approval',
        subject:         'Bluesky reply',
        verb:            'post',
        past:            'posted',
        service:         'Bluesky',
        sentTitle:       'Posted ✓',
        failTitlePrefix: 'Post failed',
        wakeOnSuccess:   false,
    },
    bsky_dm: {
        source:          'bsky-approval',
        subject:         'Bluesky DM',
        verb:            'send',
        past:            'sent',
        service:         'Bluesky',
        sentTitle:       'DM sent ✓',
        failTitlePrefix: 'DM failed',
        wakeOnSuccess:   false,
    },
};

/** `Outbound email (uid 42)` or `Bluesky DM "first 100 chars"`, or the bare subject when the params lack them. */
function label(action: ApprovedOutboundAction, copy: TypeCopy): string {
    if(action.type === 'email_send') {
        const { uid } = action.params;
        return typeof uid === 'number' ? `${copy.subject} (uid ${uid})` : copy.subject;
    }
    const { text } = action.params;
    return typeof text === 'string' ? `${copy.subject} "${truncate(text, { length: MAX_SNIPPET_LENGTH })}"` : copy.subject;
}

/**
 * Describe the outcome of an executed or failed approved action, for the approval card and for
 * Izzy. A failure with no `failureKind` (written before #40) is never retried, so it reads as
 * permanent. Throws for an `approved` or `sending` row, which has no outcome yet.
 */
export function describeApprovedActionOutcome(action: ApprovedOutboundAction): ApprovedActionOutcomeReport {
    if(action.state === 'approved' || action.state === 'sending') {
        throw new InvariantViolationError('describeApprovedActionOutcome', 'an action that is approved or still sending has no outcome yet');
    }
    const copy = COPY[action.type];
    const subject = label(action, copy);
    const key = `${action.id}:${action.state}:${action.updatedAt}`;

    if(action.state === 'executed') {
        return {
            source: copy.source,
            key,
            wake:   copy.wakeOnSuccess,
            text:   `${subject} was ${copy.past}.`,
            card:   { tone: 'sent', title: copy.sentTitle },
        };
    }

    const error = truncate(action.lastError ?? 'unknown error', { length: MAX_ERROR_LENGTH });
    if(action.failureKind === 'transient') {
        return {
            source: copy.source,
            key,
            wake:   true,
            text:   `${subject} failed to ${copy.verb}: ${error}. It will be retried automatically when ${copy.service} reconnects.`,
            card:   { tone: 'retrying', title: `${copy.failTitlePrefix} — will retry when ${copy.service} reconnects`, detail: error },
        };
    }
    return {
        source: copy.source,
        key,
        wake:   true,
        text:   `${subject} failed to ${copy.verb} and will not be retried: ${error}`,
        card:   { tone: 'failed', title: `${copy.failTitlePrefix} — will not be retried`, detail: error },
    };
}
