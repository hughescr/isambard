import { createHash } from 'node:crypto';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '@hughescr/logger';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { buildAdminRejectedSubsection } from './context-builder';
import { AMEND_DEADLINE_MS, createDraftAmender } from './email-amend';
import { buildAttachments, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, saveEmailAttachments, saveFullEmailBody, type AttachmentProblem, type ContainedFileReader, type LocalAttachmentSource } from './email-attachments';
import { failureDetail, recordEmailToolFailure, withEmailToolErrorHandling, type EmailToolErrorCode } from './email-tool-errors';
import { amendError, counted, displayName } from './email-tool-text';
import { mcpTextResult, withHealthGuard, withWriteHealthGuard } from './mcp-helpers';
import { EmailFolder, READABLE_EMAIL_FOLDERS } from '@/config';
// eslint-disable-next-line @hughescr/module-boundaries/dependencies -- The MCP server is the email integration's public agent-facing boundary.
import { checkEmailSendDelivery, composeEmailBody, draftLockKey, draftsMailboxMessageRefSchema, emailSenderProfileSchema, formatAddressForDisplay, formatAttachmentSize, formatMailboxMessageRef, hasDecisionMarker, htmlMarker, mailboxMessageRefSchema, newPreviewToken, readDraftApprovalMeta, searchDraftsByReviewState, type ComposedEmailBody, type DraftApprovalMeta, type EmailBodyFormat, type WildDuckAttachment, type DraftLocks, type EmailSenderProfile, type MailboxMessageRef, type MarkdownBodyProblem, type SearchEmailAddress, type WildDuckClient, type WildDuckMessage, type WildDuckSearchParams, type WildDuckSearchRow, type WildDuckUploadPayload } from '@/integrations/email';
import type { DeliveryCheck, ServiceHealthRegistry, ReconnectionLoop, TokenBucketRateLimiter } from '@/services';
import type { PersonAllowlist } from '@/storage';
import { createDeadline, openContainedForRead } from '@/utils';
/** Mailboxes accessible directly by the agent without admin review. */
const ACCESSIBLE_MAILBOXES: ReadonlySet<EmailFolder> = new Set([EmailFolder.CleanInbox, EmailFolder.Archive]);

/**
 * The mailboxes Izzy can read (getEmailContent, searchEmail, getEmailThread), in the order a search
 * of all of them goes through them.
 */
const SEARCH_SCOPE = READABLE_EMAIL_FOLDERS;

/** Mailboxes readable by getEmailContent (also includes Drafts and Sent Mail). */
const READABLE_MAILBOXES: ReadonlySet<EmailFolder> = new Set(SEARCH_SCOPE);

/** The most results one searchEmail page shows. */
const SEARCH_PAGE_SIZE = 20;

/** The filters of a searchEmail call, which its `next` values are tied to. */
interface SearchFilters {
    correspondent?: string
    content?:       string
    before?:        string
    since?:         string
    mailbox?:       EmailFolder
}

/** Where a searchEmail page starts: a mailbox, by its index in the search's scope, and WildDuck's cursor in it (none at its start). */
interface SearchPosition {
    mailbox: number
    cursor?: string
}

/**
 * A `next` value: the search's fingerprint, the mailbox index and, within that mailbox, WildDuck's
 * cursor (base64url, as WildDuck validates it).
 */
const SEARCH_NEXT_PATTERN = /^([0-9a-f]+)\.(\d)(?:\.([\w-]+))?$/u;

const SEARCH_NEXT_REFUSAL = 'searchEmail: this next value does not belong to this search. Repeat the search that gave it with exactly the same filters, or search again without next.';

/** Sixteen hex digits of a hash of the search's filters, so a `next` used with other filters is caught. */
function searchFingerprint(filters: SearchFilters): string {
    const key = JSON.stringify([filters.correspondent, filters.content, filters.before, filters.since, filters.mailbox]);
    return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** The `next` value for a search page starting at `position`. */
function encodeSearchNext(fingerprint: string, position: SearchPosition): string {
    return position.cursor === undefined ? `${fingerprint}.${position.mailbox}` : `${fingerprint}.${position.mailbox}.${position.cursor}`;
}

/** Where a `next` value starts its page, or undefined when it is malformed, from a search with other filters, or past the end of the scope. */
function decodeSearchNext(next: string, fingerprint: string, scopeLength: number): SearchPosition | undefined {
    const match = SEARCH_NEXT_PATTERN.exec(next);
    if(match?.[1] !== fingerprint) {
        return undefined;
    }
    const mailbox = Number(match[2]);
    return mailbox < scopeLength ? { mailbox, cursor: match[3] } : undefined;
}

/** The most messages of a thread getEmailThread looks at, oldest first. */
const THREAD_MAX_MESSAGES = 50;

/** A thread row's intro as a short snippet: whitespace collapsed to single spaces, then made safe and cut as a filename is ({@link displayName}). */
function snippet(intro: string): string {
    return displayName(intro.replaceAll(/\s+/gu, ' ').trim());
}

/** A search row's recipients for tool text, or `(none)`. */
function recipientList(to: SearchEmailAddress[]): string {
    return to.length > 0 ? to.map(address => formatAddressForDisplay(address)).join(', ') : '(none)';
}

/**
 * Description for a `senderProfile` that the handler defaults to `'formal'` when omitted.
 * The default lives in the handler, not in a zod `.default()`: the Agent SDK validates tool
 * arguments with its own bundled zod, which rejects an omitted `.default()` field as
 * "expected nonoptional" even though the advertised JSON schema marks it optional.
 */
const SENDER_PROFILE_DEFAULT_FORMAL_DESCRIPTION = 'Sender profile for the From address: formal or informal (default: formal)';

function isEmailFolder(folder: string): folder is EmailFolder {
    return Object.values(EmailFolder).includes(folder as EmailFolder);
}

function hasAccessibleMailbox(folder: string): boolean {
    return isEmailFolder(folder) && ACCESSIBLE_MAILBOXES.has(folder);
}

function hasReadableMailbox(folder: string): boolean {
    return isEmailFolder(folder) && READABLE_MAILBOXES.has(folder);
}

/** The most time `deleteDraft`'s read and delete under the draft's key may take together. */
const DELETE_DRAFT_DEADLINE_MS = 45_000;

/** How long a direct send waits to read its draft's Message-ID and Date before submitting it. */
const SEND_FINGERPRINT_DEADLINE_MS = 10_000;

/** How long a direct send whose submit failed looks for what happened to it. */
const SEND_OUTCOME_CHECK_DEADLINE_MS = 20_000;

/**
 * The failures that prove WildDuck refused a submit before handing anything over for delivery: a
 * 4xx answer (other than a 404 or 408), a refused login, or a request refused before it was sent.
 * Any other failure may leave a submit still running in WildDuck.
 */
const DEFINITIVE_SUBMIT_REFUSALS: ReadonlySet<EmailToolErrorCode> = new Set<EmailToolErrorCode>(['refused', 'auth', 'invalid_request']);

export type RestrictedMailboxNotification = MailboxMessageRef;

/**
 * How a draft was shown to the admin: a new card (`posted`, or `queued` in the outbox while
 * Discord is offline), the amended draft's existing card edited in place (`updated`), the draft
 * not found (`missing`), or no card at all (`failed`).
 */
export type ApprovalCardPresentation = 'posted' | 'updated' | 'queued' | 'missing' | 'failed';

/** The admin approval cards the email tools drive (#158); implemented by the Discord presenter. */
export interface EmailApprovalCardPort {
    /** Show draft `uid` to the admin; `previousUid` is the draft it replaces (amend only). */
    present(uid: number, previousUid?: number): Promise<ApprovalCardPresentation>
    /** Mark a just-deleted draft's card deleted (read before the delete); never throws. */
    markDeleted(draft: WildDuckMessage, uid: number): Promise<void>
    /**
     * Mark `oldUid` replaced by `newUid` when an amend could not delete it; false when that failed
     * too. Called holding `email-draft:<oldUid>`, so it must not take that key (the gate is not re-entrant).
     */
    markSuperseded(oldUid: number, newUid: number): Promise<boolean>
}

interface EmailMCPServerOptions {
    /** Optional callback to send an admin notification (e.g., Discord channel message) */
    sendAdminNotification?: (params: RestrictedMailboxNotification) => Promise<void>
    /** WildDuck HTTP client for email search and sending */
    wildDuckClient:         WildDuckClient
    /** Optional rate limiter for outbound email sends */
    rateLimiter?:           TokenBucketRateLimiter
    /** Optional email allowlist for outbound recipient gating */
    allowlist?:             PersonAllowlist
    /** Optional admin approval cards for non-allowlisted outbound email (the Discord presenter) */
    approvalCards?:         EmailApprovalCardPort
    /** Marks an amended draft's old UID superseded when no approval cards are configured; called holding `email-draft:<oldUid>` (EmailOutboundApprovals.markSupersededLocked) */
    markSuperseded?:        (oldUid: number, newUid: number) => Promise<boolean>
    /** The process-wide approval card gate; deleteDraft and amendAndResubmitDraft hold `email-draft:<uid>` on it so they cannot race an admin decision */
    draftLocks?:            DraftLocks
    /** Optional service health registry for fast-fail guards */
    healthRegistry?:        ServiceHealthRegistry
    /** Optional reconnection loop to trigger on health check failure */
    reconnectionLoop?:      ReconnectionLoop
    /** The only directory attachment files are read from: Izzy's working directory (default: `process.cwd()` when the server is created) */
    attachmentRoot?:        string
    /** Reads one attachment file under the root, following no symlink (default: `openContainedForRead`); a test seam */
    readAttachmentFile?:    ContainedFileReader
}

/** Which local files the email tools attach: what `sendEmail`, `replyToEmail` and an amend's `addAttachments` say of their paths. */
const ATTACHMENT_PATH_RULES = 'paths relative to your working directory, or absolute paths inside it. Only a regular file inside it can be attached: a path that leaves it or passes through a symbolic link, a hidden file or one in a hidden folder (any name starting with "."), and a file name with a control character, "=?", a backslash, or leading or trailing whitespace are refused.';

/** The `attachments` parameter of `sendEmail` and `replyToEmail`. */
const ATTACHMENTS_DESCRIPTION = `Files to attach: ${ATTACHMENT_PATH_RULES} At most ${MAX_ATTACHMENTS} files, ${formatAttachmentSize(MAX_ATTACHMENT_BYTES)} in all; a file that is refused means nothing is saved or sent.`;

/** What `amendAndResubmitDraft` says of the reply threading it keeps. */
const AMEND_THREADING_DESCRIPTION = 'An amended reply stays in its conversation: it is threaded from the message it replies to while that is still in the inbox or archive and the subject is not empty, and otherwise from the original draft\'s own In-Reply-To and References headers; the result says whether that was confirmed.';

/** The tool text for local attachments or a markdown body refused before anything was uploaded. */
function uploadRefusal(problem: AttachmentProblem | MarkdownBodyProblem): CallToolResult {
    return { content: [{ type: 'text' as const, text: `Nothing was saved or sent: ${problem.problem}.` }], isError: true };
}

/** What every body-taking tool says of markdown. */
const MARKDOWN_BODY_DESCRIPTION = 'Use markdown when formatting helps the reader: lists, links, emphasis, headings, quotes, code or tables. The email then has a plain-text version and an HTML version, both rendered from your markdown. The plain-text version shows each link as its text and then its whole destination in brackets ("the docs [https://example.com/docs]"), or just once when the text is exactly the destination, or is the address of a mailto: to that address. Raw HTML in the markdown is shown literally, never interpreted, and images are never embedded (each becomes a link to its URL). A link is clickable only when its destination is at most 2048 characters and is either an absolute http:// or https:// URL with a host and no user name or password, or mailto: and one plain address (no ?subject= or other query, one recipient); any other link is shown as its text and destination, not clickable. The admin sees the plain-text version on the approval card and both versions in the preview. Limits: 64 KB of markdown, 90 KB of rendered text, 500 KB of rendered HTML; lists and quotes cannot nest deeply.';

/** The `bodyFormat` parameter of `sendEmail`, `replyToEmail` and `amendAndResubmitDraft`. */
const bodyFormatSchema = z.enum(['text', 'markdown']).optional();

/** The `bodyFormat` description: plain text by default, or markdown. */
const BODY_FORMAT_DESCRIPTION = `How body is written: "text" (the default) sends it exactly as written, as plain text only; "markdown" renders it. ${MARKDOWN_BODY_DESCRIPTION}`;

/** The upload's body fields: the text, and the HTML only when the body has one (a plain-text body uploads exactly its text). */
function bodyFields(body: ComposedEmailBody): Pick<WildDuckUploadPayload, 'text' | 'html'> {
    return body.html === undefined ? { text: body.text } : { text: body.text, html: body.html };
}

/**
 * Creates an MCP server for email operations.
 *
 * Provides tools for:
 * - Checking the CleanInbox for unread messages
 * - Fetching full email content by Mailbox:UID reference and marking as read
 * - Searching the readable mailboxes a page at a time, and listing a message's thread
 * - Archiving emails by moving them from their current mailbox to Archive
 *
 * Access control: getEmailContent and getEmailThread read CleanInbox, Archive, Drafts and Sent
 * Mail, and searchEmail searches only those. Access to restricted mailboxes (Quarantine, Junk,
 * Trash, etc.) triggers an admin notification and returns an error.
 *
 * This server wraps WildDuckClient for use with the Claude Agent SDK.
 */
/**
 * Normalizes a to-address argument (string, object, array, or undefined) to an array or undefined.
 */

function normalizeToAddresses<T>(to: T | T[] | undefined): T[] | undefined {
    // Stryker disable next-line llm: both callers pass a Zod .optional() value, which is never null, so strict and loose nullish checks agree.
    if(to === undefined) {
        return undefined;
    }
    if(Array.isArray(to)) {
        return to;
    }
    return [to];
}

const emailAddressSchema = z.union([
    z.email(),
    z.object({
        name:          z.string(),
        email_address: z.email(),
    }),
]);

/** Tool-argument addresses (plain or `{name, email_address}`) as WildDuck upload addresses; undefined stays undefined. */
function uploadAddresses(addresses: z.infer<typeof emailAddressSchema>[] | undefined): { name?: string, address: string }[] | undefined {
    return addresses?.map(addr => (typeof addr === 'string' ? { address: addr } : { name: addr.name, address: addr.email_address }));
}

export function createEmailMCPServer(options: EmailMCPServerOptions) {
    const { sendAdminNotification, wildDuckClient, rateLimiter, allowlist, approvalCards } = options;
    const attachmentSource: LocalAttachmentSource = { root: options.attachmentRoot ?? process.cwd(), read: options.readAttachmentFile ?? openContainedForRead };

    // Cache for formal/informal addresses loaded lazily from WildDuck.
    let formalAddress:         { name?: string, address: string } | undefined;
    let informalAddress:       { name?: string, address: string } | undefined;
    let addressesLoaded        = false;
    let addressLoadingPromise:  Promise<void> | null = null;

    /**
     * Load formal/informal addresses from WildDuck (lazy, cached).
     * Called before first send; subsequent calls reuse cached values.
     */
    async function loadAddresses(): Promise<void> {
        if(addressesLoaded) {
            return;
        }
        addressLoadingPromise ??= (async () => {
            try {
                const addresses = await wildDuckClient.getUserAddresses();
                const formal    = addresses.find(addr => new Set<string>(addr.tags).has('formal'));
                const informal  = addresses.find(addr => new Set<string>(addr.tags).has('informal'));
                if(formal) {
                    formalAddress = { address: formal.address, ...(formal.name ? { name: formal.name } : {}) };
                }
                if(informal) {
                    informalAddress = { address: informal.address, ...(informal.name ? { name: informal.name } : {}) };
                }
                addressesLoaded = true;
            } catch (err) {
                logger.warn({ err, msg: 'Failed to load WildDuck user addresses' });
                // Do NOT set addressesLoaded = true here — allow retry on next call
            } finally {
                addressLoadingPromise = null;
            }
        })();
        await addressLoadingPromise;
    }

    /**
     * Load addresses and resolve the from address for the given sender profile.
     * Returns `{ ok: true, from }` on success, or `{ ok: false, error }` if no address is configured.
     */
    async function resolveFromAddress(senderProfile: EmailSenderProfile): Promise<{ ok: true, from: { address: string, name?: string } } | { ok: false, error: CallToolResult }> {
        await loadAddresses();
        // Stryker disable next-line llm: senderProfile is the exhaustive formal/informal union, so the inverted ternary selects the same address.
        const from = senderProfile === 'informal' ? informalAddress : formalAddress;
        if(!from) {
            return {
                ok:    false,
                error: {
                    content: [{ type: 'text' as const, text: 'Cannot send email: no sender address configured on this account. Please configure an email address in WildDuck.' }],
                    isError: true,
                },
            };
        }
        return { ok: true, from };
    }

    /**
     * Build a rate limit warning string when the limiter is at its limit.
     * Returns an empty string when not at limit or when no limiter is configured.
     */
    function buildRateLimitWarning(): string {
        if(!rateLimiter?.isAtLimit()) {
            return '';
        }
        return ` Warning: send rate limit reached (${rateLimiter.tokensRemaining()} tokens remaining).`;
    }

    /**
     * The draft's Message-ID and Date as WildDuck stores them, read (under
     * {@link SEND_FINGERPRINT_DEADLINE_MS}) before it is submitted so a failed submit's outcome can
     * be checked. Empty when the read fails (logged by status or error name) or finds nothing.
     */
    async function sendFingerprint(uid: number): Promise<{ messageId?: string, draftDate?: string }> {
        const deadline = createDeadline(SEND_FINGERPRINT_DEADLINE_MS);
        try {
            const draft = await wildDuckClient.getMessage(EmailFolder.Drafts, uid, deadline.signal);
            return { messageId: draft?.messageId, draftDate: draft?.date ?? undefined };
        } catch (err) {
            logger.warn({ uid, ...failureDetail(err), msg: 'Could not read the draft before sending it; a failed send will be reported as unknown' });
            return {};
        } finally {
            deadline.clear();
        }
    }

    /**
     * What happened to a direct send whose submit failed, from the same check an approved send's
     * uncertain outcome gets ({@link checkEmailSendDelivery}), under
     * {@link SEND_OUTCOME_CHECK_DEADLINE_MS}: `delivered` (its Message-ID is in Sent Mail),
     * `not-delivered` (the same draft is untouched in Drafts) or `undetermined` (that cannot be
     * told); undefined when the check fails (logged by status or error name).
     */
    async function failedSendOutcome(uid: number, fingerprint: { messageId?: string, draftDate?: string }): Promise<DeliveryCheck['verdict'] | undefined> {
        const deadline = createDeadline(SEND_OUTCOME_CHECK_DEADLINE_MS);
        try {
            const now = new Date();
            const check = await checkEmailSendDelivery(wildDuckClient, { params: { uid, ...fingerprint }, since: now, until: now, signal: deadline.signal });
            return check.verdict;
        } catch (err) {
            logger.warn({ uid, ...failureDetail(err), msg: 'Could not check whether a failed send went out' });
        } finally {
            deadline.clear();
        }
        return undefined;
    }

    /**
     * Submits an allowed draft at once, never retrying the submit. A failed submit is logged
     * ({@link recordEmailToolFailure}) and its outcome checked: a message found in Sent Mail was
     * sent; a definitive refusal ({@link DEFINITIVE_SUBMIT_REFUSALS}) of a draft still untouched in
     * Drafts was not sent and is not charged; anything else is unknown, and is charged, so Izzy is
     * told not to send it again. `notes` (the rate limit warning) ends every result text.
     */
    async function submitDirect(toolName: string, draftUid: number, notes: string, successMessage: string): Promise<CallToolResult> {
        const fingerprint = await sendFingerprint(draftUid);
        try {
            await wildDuckClient.submitMessage(EmailFolder.Drafts, draftUid);
        } catch (err) {
            const failure = recordEmailToolFailure(toolName, err);
            const outcome = await failedSendOutcome(draftUid, fingerprint);
            const draftRef = `${EmailFolder.Drafts}:${draftUid}`;
            if(outcome === 'delivered') {
                rateLimiter?.increment();
                return mcpTextResult(`${successMessage} The mail server reported an error, but the message was found in Sent Mail.${notes}`);
            }
            if(outcome === 'not-delivered' && DEFINITIVE_SUBMIT_REFUSALS.has(failure.code)) {
                return { content: [{ type: 'text' as const, text: `Not sent: the mail server refused to send this message (${failure.code}), and it is still an unsent draft, ${draftRef}. To try again, delete it with deleteDraft, then send or reply again; if it is refused again, tell the admin. Reference: ${failure.reference}.${notes}` }], isError: true };
            }
            rateLimiter?.increment();
            return { content: [{ type: 'text' as const, text: `Outcome unknown: the mail server did not confirm sending this message (${failure.code}), so it may or may not have gone out (draft ${draftRef}). Do not send this again; check Sent Mail later. Reference: ${failure.reference}.${notes}` }], isError: true };
        }
        rateLimiter?.increment();
        return mcpTextResult(`${successMessage}${notes}`);
    }

    /**
     * Submit the draft at once when every recipient is allowed (the caller decides: all To
     * addresses allowlisted for a send, the replied-to address for a plain reply, never for a
     * reply-all), else show it to the admin for approval ({@link requestApproval}).
     */
    async function submitOrRequestApproval(toolName: string, draftUid: number, isAllowed: boolean, notes: string, successMessage: string): Promise<CallToolResult> {
        return isAllowed ? submitDirect(toolName, draftUid, notes, successMessage) : requestApproval(draftUid, notes);
    }

    /**
     * Show the draft to the admin for approval. An amend passes the draft it replaced and the new
     * edit count, so the admin's existing card can be edited in place. `notes` (a rate limit
     * warning, or an amend's carry notes and warnings) ends every result text.
     */
    async function requestApproval(draftUid: number, notes: string, previous?: { uid: number, edits: number }): Promise<CallToolResult> {
        // Not on allowlist (or replyAll, or an amend) — request admin approval. The card is posted
        // through the Discord outbox when Discord is offline, so a failure here is exceptional.
        let presentation: ApprovalCardPresentation = 'posted';
        if(approvalCards) {
            try {
                presentation = await approvalCards.present(draftUid, previous?.uid);
            } catch (error) {
                logger.warn({ error: error instanceof Error ? error.message : String(error), msg: 'Failed to send outbound approval request' });
                presentation = 'failed';
            }
        }

        const draftRef = `${EmailFolder.Drafts}:${draftUid}`;
        switch(presentation) {
            case 'updated': {
                return mcpTextResult(`Draft saved as ${draftRef}; the admin's approval card was updated in place (edit ${previous?.edits}).${notes}`);
            }
            case 'missing': {
                return { content: [{ type: 'text' as const, text: `Draft ${draftRef} not found after upload.${notes}` }], isError: true };
            }
            case 'failed': {
                return mcpTextResult(`Draft saved as ${draftRef} but failed to notify admin. Please check pending drafts manually.${notes}`);
            }
            case 'posted':
            case 'queued': {
                return mcpTextResult(`Message saved to Drafts, pending admin approval (draft UID: ${draftUid}).${notes}`);
            }
        }
    }

    /**
     * What `sendEmail` and `replyToEmail` upload besides their headers, worked out before anything
     * is uploaded: the body as composed (a markdown body rendered), then the attached files read
     * from the working directory only; or the refusal of either, with nothing saved or sent.
     */
    async function prepareUpload(bodySource: string, format: EmailBodyFormat | undefined, paths: string[]): Promise<{ body: ComposedEmailBody, attachments: WildDuckAttachment[] } | CallToolResult> {
        const body = composeEmailBody(bodySource, format);
        if('problem' in body) {
            return uploadRefusal(body);
        }
        const local = await buildAttachments(attachmentSource, paths);
        return 'problem' in local ? uploadRefusal(local) : { body, attachments: local.attachments };
    }

    /** Whether a reply goes out without approval: never for replyAll (its Cc included), else when the replied-to address is allowlisted. */
    function isReplyAllowed(mode: 'reply' | 'replyAll', primaryTo: string): boolean {
        return mode !== 'replyAll' && (allowlist?.isAllowed('email', primaryTo) ?? false);
    }

    /**
     * Run `fn` holding draft `uid`'s key when a gate is configured (released on every path), else
     * directly, with one signal that aborts `budgetMs` after the key is taken, for every WildDuck
     * call `fn` makes under it. The budget stands down when `fn` settles.
     */
    async function withDraftLock<T>(uid: number, budgetMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
        const release = await options.draftLocks?.acquire(draftLockKey(uid));
        const budget = createDeadline(budgetMs);
        try {
            return await fn(budget.signal);
        } finally {
            budget.clear();
            release?.();
        }
    }

    /**
     * The refusal of a message in a mailbox Izzy cannot read, after notifying the admin (a failed
     * notification is only logged).
     */
    async function restrictedMailboxRefusal(message: MailboxMessageRef): Promise<CallToolResult> {
        if(sendAdminNotification) {
            try {
                await sendAdminNotification(message);
            } catch (error) {
                logger.warn({ error: error instanceof Error ? error.message : String(error), msg: 'Failed to send restricted mailbox notification' });
            }
        }
        return {
            content: [{ type: 'text' as const, text: `Access to ${message.folder} requires admin review. A notification has been sent to #admin.` }],
            isError: true,
        };
    }

    /**
     * One searchEmail page: from `start`, each mailbox of `scope` in turn is asked for the rows the
     * page still lacks, until the page is full or the scope runs out. A mailbox with more (WildDuck
     * gave a cursor) ends the page there, so each mailbox is asked at most once. Returns the rows,
     * each with the mailbox it was searched in, and where the next page starts when there may be
     * one.
     */
    async function searchReadablePage(query: WildDuckSearchParams['query'], scope: readonly EmailFolder[], start: SearchPosition): Promise<{ rows: { folder: EmailFolder, row: WildDuckSearchRow }[], next?: SearchPosition }> {
        const rows: { folder: EmailFolder, row: WildDuckSearchRow }[] = [];
        let position = start;
        while(position.mailbox < scope.length && rows.length < SEARCH_PAGE_SIZE) {
            const folder = scope[position.mailbox]!;
            // eslint-disable-next-line no-await-in-loop -- each mailbox is asked only for the rows the ones before it left
            const page = await wildDuckClient.searchPage({ query, mailbox: folder, limit: SEARCH_PAGE_SIZE - rows.length, next: position.cursor });
            rows.push(...page.results.map(row => ({ folder, row })));
            if(page.nextCursor !== undefined) {
                return { rows, next: { mailbox: position.mailbox, cursor: page.nextCursor } };
            }
            position = { mailbox: position.mailbox + 1 };
        }
        return position.mailbox < scope.length ? { rows, next: position } : { rows };
    }

    const amender = createDraftAmender({
        wildDuckClient,
        replyMailboxes: ACCESSIBLE_MAILBOXES,
        markSuperseded: (oldUid, newUid) => (approvalCards ? approvalCards.markSuperseded(oldUid, newUid) : options.markSuperseded?.(oldUid, newUid)),
        attachmentSource,
    });

    return createSdkMcpServer({
        name:    'email',
        version: '1.0.0',
        tools:   [
            tool(
                'checkInbox',
                'Check CleanInbox for emails. Returns counter state and message summaries. By default only unread; set showSeen to include read messages.',
                { showSeen: z.boolean().optional().describe('When true, include read messages alongside unread. Defaults to false (unread only).') },
                withHealthGuard(options.healthRegistry, 'email', options.reconnectionLoop,
                    withEmailToolErrorHandling('checkInbox', async ({ showSeen }): Promise<CallToolResult> => {
                        const [countsData, messages] = await Promise.all([
                            wildDuckClient.getMailboxCounts(EmailFolder.CleanInbox),
                            wildDuckClient.listMessages(EmailFolder.CleanInbox, { unseen: !showSeen }),
                        ]);
                        const result = {
                            counters: { total: countsData.total, unread: countsData.unseen },
                            messages: messages.map(m => ({
                                uid:         `${EmailFolder.CleanInbox}:${m.id}`,
                                from:        formatAddressForDisplay(m.from),
                                subject:     m.subject,
                                date:        m.date,
                                intro:       m.intro,
                                attachments: m.attachments,
                            })),
                        };
                        return {
                            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
                        };
                    })),
                { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }
            ),

            tool(
                'getEmailContent',
                'Fetch the full content of an email by its Mailbox:UID reference and mark it as read. An HTML email\'s body is its HTML converted to text, each link shown as "label [url]"; a body over the size limit is cut, its last line then says how much of it is shown, and the full text is saved to a file whose path and size in bytes follow the body.',
                {
                    message: mailboxMessageRefSchema.describe('The email reference in Mailbox:UID format (e.g., CleanInbox:42)'),
                },

                withHealthGuard(options.healthRegistry, 'email', options.reconnectionLoop,
                    withEmailToolErrorHandling('getEmailContent',

                        async (args): Promise<CallToolResult> => {
                            const { folder, uid } = args.message;

                            // Access control: CleanInbox, Archive, Drafts, and Sent Mail are directly readable
                            if(!hasReadableMailbox(folder)) {
                                return restrictedMailboxRefusal(args.message);
                            }

                            const email = await wildDuckClient.getFullMessage(folder, uid);
                            if(!email) {
                                return {
                                    content: [{ type: 'text' as const, text: `Email ${formatMailboxMessageRef(args.message)} not found.` }],
                                    isError: true,
                                };
                            }
                            await wildDuckClient.updateMessageFlags(folder, uid, { addFlags: [String.raw`\Seen`] });

                            // Lazy-fetch and save attachments using WildDuck's mailbox and UID identity.
                            // Stryker disable next-line llm: getFullMessage normalizes attachmentMeta to an array, which is always truthy.
                            const attachmentLines = await saveEmailAttachments(wildDuckClient, folder, uid, email.attachmentMeta);
                            // A body that was cut has its whole text saved beside the attachments, for Izzy to read the rest.
                            const fullBodyLine = email.fullBodyText === undefined ? undefined : await saveFullEmailBody(folder, uid, email.fullBodyText);

                            const toList = email.to.map(addr => formatAddressForDisplay(addr)).join(', ');
                            const lines = ([
                                `From: ${formatAddressForDisplay(email.from)}`,
                                `To: ${toList}`,
                                email.cc.length > 0 ? `Cc: ${email.cc.map(addr => formatAddressForDisplay(addr)).join(', ')}` : undefined,
                                `Subject: ${email.subject}`,
                                `Date: ${email.date.toISOString()}`,
                                '',
                                email.bodyText,
                                fullBodyLine,
                                ...(attachmentLines.length > 0 ? ['\nAttachments:', ...attachmentLines] : []),
                            ]).filter(line => line !== undefined);
                            const text = lines.join('\n');
                            return mcpTextResult(text.trim());
                        })),
                { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }
            ),

            tool(
                'getEmailThread',
                `List the messages in an email's conversation, oldest first: each one's Mailbox:UID reference, From, To, Date, Subject and a short snippet; read one in full with getEmailContent. Lists only messages in CleanInbox, Archive, Drafts and Sent Mail (saying how many others were left out), at most ${THREAD_MAX_MESSAGES}, and marks nothing as read.`,
                {
                    message: mailboxMessageRefSchema.describe('The email reference in Mailbox:UID format (e.g., CleanInbox:42)'),
                },
                withHealthGuard(options.healthRegistry, 'email', options.reconnectionLoop,
                    withEmailToolErrorHandling('getEmailThread', async (args): Promise<CallToolResult> => {
                        const { folder, uid } = args.message;
                        if(!hasReadableMailbox(folder)) {
                            return restrictedMailboxRefusal(args.message);
                        }
                        const ref = formatMailboxMessageRef(args.message);
                        const message = await wildDuckClient.getMessage(folder, uid);
                        if(!message) {
                            return { content: [{ type: 'text' as const, text: `Email ${ref} not found.` }], isError: true };
                        }
                        if(typeof message.thread !== 'string') {
                            return { content: [{ type: 'text' as const, text: `Email ${ref} has no thread information; read it with getEmailContent.` }], isError: true };
                        }
                        const page = await wildDuckClient.searchPage({ thread: message.thread, order: 'asc', limit: THREAD_MAX_MESSAGES });
                        // A thread spans mailboxes: only rows in a mailbox Izzy can read are shown, named as getEmailContent takes them.
                        const readable = new Map(SEARCH_SCOPE.map(readableFolder => [wildDuckClient.getMailboxId(readableFolder), readableFolder]));
                        const shown = page.results.flatMap((row) => {
                            const rowFolder = readable.get(row.mailboxId);
                            return rowFolder === undefined ? [] : [{ folder: rowFolder, row }];
                        });
                        const leftOut = page.results.length - shown.length;
                        const lines = [
                            `Thread of ${ref}, oldest first (${counted(shown.length, 'message', 'messages')}):`,
                            ...shown.map(({ folder: rowFolder, row }) => `- ${formatMailboxMessageRef({ folder: rowFolder, uid: row.uid })} | From: ${formatAddressForDisplay(row.from)} | To: ${recipientList(row.to)} | Date: ${row.date} | Subject: ${row.subject} | Snippet: ${snippet(row.intro)}`),
                            ...(leftOut === 0 ? [] : [leftOut === 1 ? '1 message in a mailbox you cannot read was left out.' : `${leftOut} messages in mailboxes you cannot read were left out.`]),
                            ...(page.nextCursor === undefined ? [] : [`This thread has more than ${THREAD_MAX_MESSAGES} messages; only its oldest ${THREAD_MAX_MESSAGES} were looked at.`]),
                        ];
                        return mcpTextResult(lines.join('\n'));
                    })),
                { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }
            ),

            tool(
                'archiveEmail',
                'Move an email from CleanInbox to Archive.',
                {
                    message: mailboxMessageRefSchema.describe('The email reference in Mailbox:UID format (e.g., CleanInbox:42)'),
                },
                withHealthGuard(options.healthRegistry, 'email', options.reconnectionLoop,
                    withEmailToolErrorHandling('archiveEmail', async (args): Promise<CallToolResult> => {
                        const { folder, uid } = args.message;

                        // Access control: only CleanInbox and Archive are directly accessible
                        if(!hasAccessibleMailbox(folder)) {
                            return {
                                content: [{ type: 'text' as const, text: `Access denied: cannot archive messages in ${folder}. Restricted mailboxes require admin review.` }],
                                isError: true,
                            };
                        }

                        // WildDuck assigns a new UID in Archive — report that one, not the caller's
                        // source uid, so a later Archive:<uid> lookup targets the right message.
                        const archivedUid = await wildDuckClient.moveMessage(folder, uid, EmailFolder.Archive);
                        return mcpTextResult(`Email UID ${archivedUid} archived successfully.`);
                    })),
                { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }
            ),

            tool(
                'searchEmail',
                `Search the emails you can read (CleanInbox, Archive, Drafts and Sent Mail, mailbox by mailbox), at most ${SEARCH_PAGE_SIZE} a page: each result's Mailbox:UID reference, From, To, Subject and Date. When there may be more, the result ends with a next value for the following page.`,
                {
                    correspondent: z.string().optional().describe('Match this text in the From, To or Cc header'),
                    content:       z.string().optional().describe('Search Subject and body text'),
                    before:        z.string().optional().describe('ISO date - return emails before this date'),
                    since:         z.string().optional().describe('ISO date - return emails since this date'),
                    mailbox:       z.enum(SEARCH_SCOPE).optional().describe(`Search only this mailbox. Omit to search every mailbox you can read: ${SEARCH_SCOPE.join(', ')}, in that order.`),
                    next:          z.string().optional().describe('The next value from the end of an earlier searchEmail result, for the page after it. Give exactly the same filters as that search; a next from a different search is refused.'),
                },
                withHealthGuard(options.healthRegistry, 'email', options.reconnectionLoop,
                    withEmailToolErrorHandling('searchEmail', async (args): Promise<CallToolResult> => {
                        const scope = args.mailbox === undefined ? SEARCH_SCOPE : [args.mailbox];
                        const fingerprint = searchFingerprint(args);
                        const start = args.next === undefined ? { mailbox: 0 } : decodeSearchNext(args.next, fingerprint, scope.length);
                        if(start === undefined) {
                            return { content: [{ type: 'text' as const, text: SEARCH_NEXT_REFUSAL }], isError: true };
                        }
                        const page = await searchReadablePage({
                            correspondent: args.correspondent,
                            content:       args.content,
                            before:        args.before,
                            since:         args.since,
                        }, scope, start);
                        const lines = [
                            page.rows.length === 0 ? 'No emails found matching your search criteria.' : `Found ${counted(page.rows.length, 'email', 'emails')}:`,
                            ...page.rows.map(({ folder, row }) => `- ${formatMailboxMessageRef({ folder, uid: row.uid })} | From: ${formatAddressForDisplay(row.from)} | To: ${recipientList(row.to)} | Subject: ${row.subject} | Date: ${row.date}`),
                            page.next === undefined ? 'No more results.' : `More results: call searchEmail again with the same filters and next: ${encodeSearchNext(fingerprint, page.next)}`,
                        ];
                        return mcpTextResult(lines.join('\n'));
                    })),
                { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }
            ),

            tool(
                'sendEmail',
                'Send an outbound email. If all recipients are on the allowlist, sends immediately. Otherwise, saves to Drafts and requests admin approval via Discord.',
                {
                    to: z.union([emailAddressSchema, z.array(emailAddressSchema).min(1)])
                        .describe('Recipient email: plain address string or {name, email_address} object, or array of either'),
                    subject:       z.string().describe('Email subject'),
                    body:          z.string().describe('Email body: plain text, or markdown with bodyFormat "markdown"'),
                    bodyFormat:    bodyFormatSchema.describe(BODY_FORMAT_DESCRIPTION),
                    senderProfile: emailSenderProfileSchema.optional().describe(SENDER_PROFILE_DEFAULT_FORMAL_DESCRIPTION),
                    attachments:   z.array(z.string()).optional().describe(ATTACHMENTS_DESCRIPTION),
                },
                withWriteHealthGuard(options.healthRegistry, 'email', 'discord', options.reconnectionLoop,
                    withEmailToolErrorHandling('sendEmail', async (args): Promise<CallToolResult> => {
                        // Resolve from address based on sender profile (loads addresses lazily)
                        const fromResult = await resolveFromAddress(args.senderProfile ?? 'formal');
                        if(!fromResult.ok) {
                            return fromResult.error;
                        }
                        const from = fromResult.from;

                        // Normalize to to an array of address objects
                        const toArr = Array.isArray(args.to) ? args.to : [args.to];
                        const toAddresses = toArr.map((addr): { name?: string, address: string } => {
                            if(typeof addr === 'string') {
                                return { address: addr };
                            }
                            return { name: addr.name, address: addr.email_address };
                        });

                        // Check rate limit — warn but don't block
                        const rateLimitWarning = buildRateLimitWarning();

                        // Stryker disable next-line llm: the schema yields string[] or undefined; arrays are truthy, so ?? and || agree.
                        const prepared = await prepareUpload(args.body, args.bodyFormat, args.attachments ?? []);
                        if('content' in prepared) {
                            return prepared;
                        }
                        const { body, attachments } = prepared;

                        // Upload to Drafts, recording the digest of any HTML part with the new UID.
                        const uid = await wildDuckClient.uploadMessage(EmailFolder.Drafts, {
                            from,
                            to:       toAddresses,
                            subject:  args.subject,
                            ...bodyFields(body),
                            ...(attachments.length > 0 ? { attachments } : {}),
                            draft:    true,
                            metaData: { previewToken: newPreviewToken(), ...htmlMarker(body.html) },
                        });

                        // Fast-path only when ALL recipients are allowlisted (cc is undefined for sendEmail)
                        const isAllAllowed = toAddresses.every(addr => allowlist?.isAllowed('email', addr.address) ?? false);
                        return submitOrRequestApproval('sendEmail', uid, isAllAllowed, rateLimitWarning, 'Sent successfully.');
                    })),
                { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } }
            ),

            tool(
                'replyToEmail',
                'Reply to an existing email. If recipient is on the allowlist, sends immediately. Otherwise, saves to Drafts for admin approval.',
                {
                    message:       mailboxMessageRefSchema.describe('The email reference in Mailbox:UID format to reply to'),
                    body:          z.string().describe('Reply body: plain text, or markdown with bodyFormat "markdown"'),
                    bodyFormat:    bodyFormatSchema.describe(BODY_FORMAT_DESCRIPTION),
                    mode:          z.enum(['reply', 'replyAll']).describe('Reply mode: reply to sender only, or reply-all'),
                    senderProfile: emailSenderProfileSchema.optional().describe(SENDER_PROFILE_DEFAULT_FORMAL_DESCRIPTION),
                    attachments:   z.array(z.string()).optional().describe(ATTACHMENTS_DESCRIPTION),
                },

                withWriteHealthGuard(options.healthRegistry, 'email', 'discord', options.reconnectionLoop,
                    withEmailToolErrorHandling('replyToEmail',
                        async (args): Promise<CallToolResult> => {
                        // Resolve from address based on sender profile (loads addresses lazily)
                            const fromResult = await resolveFromAddress(args.senderProfile ?? 'formal');
                            if(!fromResult.ok) {
                                return fromResult.error;
                            }
                            const from = fromResult.from;

                            const { folder, uid: originalUid } = args.message;

                            // Access control: only CleanInbox and Archive are directly accessible
                            if(!hasAccessibleMailbox(folder)) {
                                return {
                                    content: [{ type: 'text' as const, text: `Access denied: cannot reply to messages in ${folder}. Restricted mailboxes require admin review.` }],
                                    isError: true,
                                };
                            }

                            // Fetch original message from WildDuck to get pre-parsed sender address fields
                            const original = await wildDuckClient.getMessage(folder, originalUid);
                            if(!original) {
                                return {
                                    content: [{ type: 'text' as const, text: `Cannot reply: message '${formatMailboxMessageRef(args.message)}' not found.` }],
                                    isError: true,
                                };
                            }

                            // Determine recipient address for allowlist check using WildDuck pre-parsed fields.
                            // Prefer replyTo address; fall back to from address.
                            const primaryTo = original.replyTo?.address ?? original.from?.address ?? '';

                            // Check rate limit — warn but don't block
                            const rateLimitWarning = buildRateLimitWarning();

                            // Resolve WildDuck mailbox ID for the reference object
                            const mailboxWildDuckId = wildDuckClient.getMailboxId(folder);
                            if(!mailboxWildDuckId) {
                                return {
                                    content: [{ type: 'text' as const, text: `Cannot reply: mailbox '${folder}' not found in WildDuck. Reconnect or try again.` }],
                                    isError: true,
                                };
                            }

                            const prepared = await prepareUpload(args.body, args.bodyFormat, args.attachments ?? []);
                            if('content' in prepared) {
                                return prepared;
                            }
                            const { body, attachments } = prepared;

                            // Upload to Drafts with WildDuck reference for threading, recording the
                            // digest of any HTML part with the new UID.
                            // WildDuck derives all recipients (To, Cc) from the reference object automatically.
                            const uid = await wildDuckClient.uploadMessage(EmailFolder.Drafts, {
                                from,
                                subject:   `Re: ${original.subject ?? ''}`,
                                ...bodyFields(body),
                                reference: {
                                    action:  args.mode === 'replyAll' ? 'replyAll' : 'reply',
                                    mailbox: mailboxWildDuckId,
                                    id:      originalUid,
                                },
                                ...(attachments.length > 0 ? { attachments } : {}),
                                draft:    true,
                                metaData: { previewToken: newPreviewToken(), ...htmlMarker(body.html) },
                            });

                            return submitOrRequestApproval('replyToEmail', uid, isReplyAllowed(args.mode, primaryTo), rateLimitWarning, `Reply sent to ${primaryTo}.`);
                        })),
                { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } }
            ),

            tool(
                'deleteDraft',
                'Delete a draft email. Only drafts in the Drafts folder can be deleted this way.',
                {
                    message: draftsMailboxMessageRefSchema.describe('The draft to delete, in Drafts:UID format'),
                },
                withHealthGuard(options.healthRegistry, 'email', options.reconnectionLoop,
                    withEmailToolErrorHandling('deleteDraft', async (args): Promise<CallToolResult> => {
                        const { uid } = args.message;
                        const draftRef = formatMailboxMessageRef(args.message);
                        // Read, check and delete holding the draft's key, so an approval recorded
                        // meanwhile is seen and its draft kept; the card is marked from this read
                        // after the key is released (lock order is card key, then draft key). Both
                        // WildDuck calls share one DELETE_DRAFT_DEADLINE_MS budget.
                        const deletion = await withDraftLock(uid, DELETE_DRAFT_DEADLINE_MS, async (signal): Promise<{ draft: WildDuckMessage, meta: DraftApprovalMeta } | CallToolResult> => {
                            const draft = await wildDuckClient.getMessage(EmailFolder.Drafts, uid, signal);
                            if(!draft) {
                                return { content: [{ type: 'text' as const, text: `Draft ${draftRef} not found.` }], isError: true };
                            }
                            const meta = readDraftApprovalMeta(draft.metaData);
                            if(meta.approval !== undefined) {
                                return { content: [{ type: 'text' as const, text: `Draft ${draftRef} has an admin approval recorded; it can't be deleted.` }], isError: true };
                            }
                            await wildDuckClient.deleteMessage(EmailFolder.Drafts, uid, signal);
                            return { draft, meta };
                        });
                        if('content' in deletion) {
                            return deletion;
                        }
                        const { draft, meta } = deletion;
                        await approvalCards?.markDeleted(draft, uid);
                        const cardNote = approvalCards && meta.card && !hasDecisionMarker(meta) ? ' The admin\'s approval card was marked deleted.' : '';
                        return mcpTextResult(`Draft ${draftRef} deleted.${cardNote}`);
                    })),
                { annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } }
            ),

            tool(
                'amendAndResubmitDraft',
                `Amend a pending or rejected draft and resubmit it for admin approval. Reads the existing draft, applies your changes, and re-uploads it as a new draft UID, replacing the old one. The new version keeps the draft's Cc addresses and attachments unless you override them (cc, removeAttachments), and adds the files you name in addAttachments; kept and added together it carries at most ${MAX_ATTACHMENTS} attachments, ${formatAttachmentSize(MAX_ATTACHMENT_BYTES)} in all. The result says how many Cc addresses and attachments the stored new version has, and warns if they differ from what was intended or could not be confirmed. Omitting body keeps the draft's text and its HTML version; a new markdown body replaces both, and a new plain-text body removes the HTML version; the result says which, and warns if the stored HTML version is not what was uploaded. ${AMEND_THREADING_DESCRIPTION} A pending draft's approval card is updated in place; a rejected draft gets a new card. A draft the admin has approved cannot be amended.`,
                {
                    message:           draftsMailboxMessageRefSchema.describe('The pending or rejected draft to amend, in Drafts:UID format'),
                    subject:           z.string().optional().describe('New subject line (omit to keep the original)'),
                    body:              z.string().optional().describe('New body: plain text, or markdown with bodyFormat "markdown". Omit to keep the original body, its HTML version included.'),
                    bodyFormat:        bodyFormatSchema.describe(`How the new body is written; give it only with body. ${BODY_FORMAT_DESCRIPTION} A new plain-text body removes the draft's HTML version.`),
                    to:                z.union([emailAddressSchema, z.array(emailAddressSchema).min(1)]).optional().describe('New To address(es) (omit to keep the original)'),
                    cc:                z.union([emailAddressSchema, z.array(emailAddressSchema)]).optional().describe('New Cc address(es), replacing the draft\'s Cc: plain address string or {name, email_address} object, or array of either. Omit to keep the draft\'s Cc; pass an empty array to remove every Cc address.'),
                    removeAttachments: z.union([z.literal('all'), z.array(z.string())]).optional().describe('Attachments to drop from the draft: "all", or an array of filenames (each drops every attachment with exactly that name). Omit to keep every attachment. A filename the draft does not have refuses the amend and changes nothing.'),
                    addAttachments:    z.array(z.string()).optional().describe(`Files to attach to the new version, read as sendEmail reads its attachments: ${ATTACHMENT_PATH_RULES} An added file whose name is the same as a kept attachment's or another added file's refuses the amend and changes nothing.`),
                    senderProfile:     emailSenderProfileSchema.optional().describe('Sender profile for the From address: formal or informal'),
                },
                withWriteHealthGuard(options.healthRegistry, 'email', 'discord', options.reconnectionLoop,
                    withEmailToolErrorHandling('amendAndResubmitDraft', async (args): Promise<CallToolResult> => {
                        // Resolve from address based on sender profile (loads addresses lazily)
                        const fromResult = await resolveFromAddress(args.senderProfile ?? 'formal');
                        if(!fromResult.ok) {
                            return fromResult.error;
                        }
                        const from = fromResult.from;

                        // Drafts-only schema has already decoded the message UID.
                        const { uid } = args.message;
                        const draftRef = formatMailboxMessageRef(args.message);

                        // Compose the new body before anything is read: a bodyFormat without a body,
                        // or a markdown body the renderer refuses, changes nothing.
                        if(args.body === undefined && args.bodyFormat !== undefined) {
                            return amendError(`Could not amend draft ${draftRef}: bodyFormat was given without body; give the new body with it, or leave both out to keep the draft's body. Nothing was changed.`);
                        }
                        const body = args.body === undefined ? undefined : composeEmailBody(args.body, args.bodyFormat);
                        if(body !== undefined && 'problem' in body) {
                            return amendError(`Could not amend draft ${draftRef}: ${body.problem}. Nothing was changed.`);
                        }

                        // Normalize args.to and args.cc: undefined → keep the draft's addresses; structured/plain string → array
                        const to = uploadAddresses(normalizeToAddresses(args.to));
                        const cc = uploadAddresses(normalizeToAddresses(args.cc));

                        // Read, refuse, fetch the kept attachments, read the added files, work out the
                        // reply threading, upload, remove the old UID and read the new one back holding
                        // the draft's key, so an approval recorded meanwhile is
                        // seen (and the draft kept) and none can land on the old UID before it is gone or
                        // superseded (#161), all within one AMEND_DEADLINE_MS budget. The card is
                        // presented after the key is released (lock order is card key, then draft key).
                        const amended = await withDraftLock(uid, AMEND_DEADLINE_MS, async signal => amender.replaceAmendedDraft(uid, draftRef, {
                            from, subject: args.subject, body, to, cc, removeAttachments: args.removeAttachments, addAttachments: args.addAttachments,
                        }, signal));
                        if('content' in amended) {
                            return amended;
                        }

                        // Always route through approval — amended drafts require human review.
                        return requestApproval(amended.newUid, amended.notes, { uid, edits: amended.edits });
                    })),
                { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } }
            ),

            tool(
                'getRejectedDrafts',
                'List drafts rejected by admin review.',
                {},
                withHealthGuard(options.healthRegistry, 'email', options.reconnectionLoop,
                    withEmailToolErrorHandling('getRejectedDrafts', async (): Promise<CallToolResult> => {
                        const rejectedUids = await searchDraftsByReviewState(wildDuckClient, 'rejected_by_admin');
                        const adminRejectedSection = await buildAdminRejectedSubsection(rejectedUids, wildDuckClient);

                        return mcpTextResult(adminRejectedSection ?? 'No drafts rejected by admin review.');
                    })),
                { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }
            ),
        ],
    });
}
