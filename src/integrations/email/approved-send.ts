import { logger } from '@hughescr/logger';
import { truncate } from 'lodash-es';
import { readDraftSendMeta } from './draft-approval-meta';
import { emailSendParamsSchema, FINGERPRINT_READ_TIMEOUT_MS } from './outbound-approvals';
import type { WildDuckClient, WildDuckMessage } from './wildduck-client';
import { EmailFolder } from '@/config';
import { ApprovedDraftChangedError, EmailProcessingError, WildDuckAuthError, WildDuckError, type WildDuckErrorContext, type WildDuckErrorKind } from '@/errors';
import type { SendAttempt } from '@/services';
import { createDeadline } from '@/utils';

/** How long an approved send waits to read its draft before submitting it (10 seconds). */
export const APPROVED_SEND_CHECK_TIMEOUT_MS = FINGERPRINT_READ_TIMEOUT_MS;

/** The most of a failed pre-send read's own message that is logged (500 characters). */
export const READ_FAILURE_LOG_MAX_LENGTH = 500;

/** What a status-less WildDuck read failure is called in the action row, by its kind. */
const WILDDUCK_FAILURE_DETAIL: Record<WildDuckErrorKind, string> = {
    http:            'HTTP error',
    auth:            'authentication failed',
    invalid_request: 'request refused before it was sent',
    bad_response:    'unusable response',
    timeout:         'timed out',
};

function readFailedMessage(detail: string): string {
    return `could not read the draft before sending (${detail})`;
}

/** A WildDuck read failure's detail: its HTTP status, else its kind. */
function wildDuckFailureDetail({ status, kind }: WildDuckErrorContext): string {
    if(status !== undefined) {
        return `HTTP ${status}`;
    }
    return kind === undefined ? 'WildDuck error' : WILDDUCK_FAILURE_DETAIL[kind];
}

/**
 * A failed pre-send read, re-raised with a short message of Isambard's own: the original can
 * carry WildDuck's whole response body, which would otherwise land in the action row. It keeps
 * what the executor's `classifyFailure` reads — a WildDuckError's class, code, status and kind,
 * a DOMException's name — so the send is classified as before; anything else (a network
 * failure) becomes an EmailProcessingError, which is classified as ambiguous just as it was.
 */
function readFailure(err: unknown): Error {
    if(err instanceof WildDuckError) {
        const context: WildDuckErrorContext = { status: err.context?.status, kind: err.context?.kind };
        const message = readFailedMessage(wildDuckFailureDetail(context));
        return err instanceof WildDuckAuthError ? new WildDuckAuthError(message, context) : new WildDuckError(message, err.code, context);
    }
    if(err instanceof DOMException) {
        return new DOMException(readFailedMessage(err.name === 'TimeoutError' ? 'timed out' : 'cancelled'), err.name);
    }
    return new EmailProcessingError(readFailedMessage('network error'));
}

/** The binding an approval recorded: the `email_send` row's id and the draft's Message-ID and Date then. */
interface ApprovalBinding {
    actionId:  string
    messageId: string
    draftDate: string
}

/**
 * Why the draft read now is not the message at the uid that was approved, or undefined: gone,
 * no longer a draft, or another Message-ID. A partial submit can cause any of these (WildDuck
 * moves a submitted draft to Sent Mail), so on a resend they are not proof of a change.
 */
function messageMismatch(draft: WildDuckMessage | null, binding: ApprovalBinding): string | undefined {
    if(draft === null) {
        return 'it is no longer in Drafts';
    }
    if(draft.draft !== true) {
        return 'it is no longer a draft';
    }
    return draft.messageId === binding.messageId ? undefined : 'its Message-ID differs';
}

/**
 * Why the approval no longer stands on a draft that is still the approved message, or undefined:
 * its Date differs (checked on a first send only — WildDuck rewrites a draft's Date when a submit
 * reaches it, so a resend after a refused submit sees a new Date), its approval marker is missing,
 * malformed or names another approval, it carries a `rejectedAt` key, or it carries a
 * `supersededBy` key (an amend replaced it). The last two count whatever their value, so a
 * malformed one still blocks. No submit changes metaData.
 */
function approvalMismatch(draft: WildDuckMessage, binding: ApprovalBinding, firstSend: boolean): string | undefined {
    if(firstSend && draft.date !== binding.draftDate) {
        return 'its Date differs';
    }
    const meta = readDraftSendMeta(draft.metaData);
    if(meta.approval?.actionId !== binding.actionId) {
        return 'its approval marker is missing or names another approval';
    }
    if(meta.rejected) {
        return 'it was rejected';
    }
    return meta.superseded ? 'an amend replaced it' : undefined;
}

function changed(detail: string): ApprovedDraftChangedError {
    return new ApprovedDraftChangedError(`the draft no longer matches what was approved (${detail}), so it was not sent`);
}

/**
 * Sends an approved `email_send` action: reads its draft (under
 * {@link APPROVED_SEND_CHECK_TIMEOUT_MS} and the executor's `signal`) and submits it only when it
 * is still what the admin approved, so this check can only ever stop a send. It requires the
 * fingerprint recorded at approval, and a draft that is still a draft at the uid, with the
 * approved Message-ID and — on a first send — the approved Date, whose approval marker names this
 * action and which carries no rejection and no amend's `supersededBy`. A mismatch throws {@link ApprovedDraftChangedError}, which
 * settles the action as a permanent failure saying why, except on a resend (`attempt.firstSend`
 * false: the row was claimed before) of a draft that is gone, no longer a draft or another
 * message: an earlier partial submit may have sent it, so that throws an EmailProcessingError,
 * which the executor treats as an unknown outcome and checks Sent Mail for before any resend. A
 * read that fails or times out is logged at warn (its message cut to
 * {@link READ_FAILURE_LOG_MAX_LENGTH} characters) and re-thrown with a short message that keeps
 * its classification (the executor's ambiguous or retry handling); unparseable params throw a
 * ZodError before any read.
 */
export async function submitApprovedDraft(client: Pick<WildDuckClient, 'getMessage' | 'submitMessage'>, params: Record<string, unknown>, attempt: SendAttempt, signal: AbortSignal): Promise<void> {
    const { uid, messageId, draftDate } = emailSendParamsSchema.parse(params);
    if(messageId === undefined || draftDate === undefined) {
        throw changed('no Message-ID and Date were recorded when it was approved');
    }
    const binding: ApprovalBinding = { actionId: attempt.actionId, messageId, draftDate };
    const deadline = createDeadline(APPROVED_SEND_CHECK_TIMEOUT_MS);
    let draft: WildDuckMessage | null;
    try {
        draft = await client.getMessage(EmailFolder.Drafts, uid, AbortSignal.any([signal, deadline.signal]));
    } catch (err: unknown) {
        const error = truncate(err instanceof Error ? err.message : String(err), { length: READ_FAILURE_LOG_MAX_LENGTH, omission: '…' });
        logger.warn({ uid, actionId: attempt.actionId, error, msg: 'Could not read the approved draft before sending it' });
        throw readFailure(err);
    } finally {
        deadline.clear();
    }
    const gone = messageMismatch(draft, binding);
    if(gone !== undefined) {
        throw attempt.firstSend ? changed(gone) : new EmailProcessingError(`the approved draft is no longer in Drafts as approved (${gone}), so an earlier send may have gone out`);
    }
    // messageMismatch found the draft, so it is not null here.
    const mismatch = approvalMismatch(draft!, binding, attempt.firstSend);
    if(mismatch !== undefined) {
        throw changed(mismatch);
    }
    await client.submitMessage(EmailFolder.Drafts, uid, signal);
}
