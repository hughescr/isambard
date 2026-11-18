import { logger } from '@hughescr/logger';
import { messageBodyText } from './body-text';
import { EmailFolder } from '@/config';
import { WildDuckError, WildDuckAuthError } from '@/errors';
import { formatMailboxMessageRef, parseMailboxMessageRef, type EmailMetadata, type EmailAddress, type EmailHeaders, type SearchEmailAddress, type VerificationResults } from '@/integrations/email/types';
import { createDeadline, discardBody } from '@/utils';

export { WildDuckError, WildDuckAuthError } from '@/errors';

/**
 * Maps IMAP/WildDuck specialUse flag to the logical EmailFolder value.
 * Standard IMAP flags per RFC 6154.
 */
const SPECIAL_USE_FLAGS: Record<string, string> = {
    '\\Inbox':   'INBOX',
    '\\Sent':    'Sent Mail',
    '\\Drafts':  'Drafts',
    '\\Junk':    'Junk',
    '\\Trash':   'Trash',
    '\\Archive': 'Archive',
};

const REQUEST_TIMEOUT_MS = 30_000;

/** WildDuck's own attachment id format, as its attachment route validates it (`^ATT\d+$`). */
const ATTACHMENT_ID_PATTERN = /^ATT\d+$/u;

/**
 * Whether `id` is an attachment id WildDuck could have issued: `ATT` and one or more digits. An
 * attachment id from a message GET is untrusted and goes into a URL path, so it is checked first.
 */
export function isWildDuckAttachmentId(id: unknown): id is string {
    return typeof id === 'string' && ATTACHMENT_ID_PATTERN.test(id);
}

/** Refuses an attachment id WildDuck could not have issued, before any request is made. */
function assertAttachmentId(id: string): void {
    if(!isWildDuckAttachmentId(id)) {
        throw new WildDuckError('WildDuck: not a valid attachment id', undefined, { kind: 'invalid_request' });
    }
}

/** Messages per page when looking a message up by Message-ID. */
const FIND_BY_MESSAGE_ID_PAGE_SIZE = 250;

/** How many pages, newest first, a Message-ID lookup reads before giving up. */
export const FIND_BY_MESSAGE_ID_MAX_PAGES = 4;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Maps a WildDuck address object to the EmailAddress type.
 */
function mapAddress(addr: { address: string, name?: string }): EmailAddress {
    return {
        address: addr.address,
        ...(addr.name ? { name: addr.name } : {}),
    };
}

/** A search row's UID: its id as a number, or NaN when WildDuck's id is not one. */
function searchResultUid(result: { id: number | string }): number {
    return typeof result.id === 'number' || /^\d+$/.test(result.id) ? Number(result.id) : Number.NaN;
}

/** Maps a partial WildDuck search address while preserving whether an address exists. */
function mapSearchAddress(addr: { name?: string, address?: string }): SearchEmailAddress {
    if(addr.address) {
        return {
            address: addr.address,
            ...(addr.name ? { name: addr.name } : {}),
        };
    }
    if(addr.name) {
        return { name: addr.name, address: null };
    }
    return null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SearchCriteria {
    correspondent?: string
    content?:       string
    before?:        string
    since?:         string
    header?:        { name: string, value: string }
    keyword?:       string
}

export interface WildDuckSearchParams {
    query?:      SearchCriteria
    mailbox?:    string
    searchable?: boolean
}

export interface WildDuckSearchResult {
    /** 'FolderName:uid' format e.g. 'CleanInbox:42' */
    message: string
    from:    SearchEmailAddress
    to:      SearchEmailAddress[]
    subject: string
    date:    string
}

/** What {@link WildDuckClient.searchPage} asks for: the search's filters and which page of it. */
export interface WildDuckSearchPageRequest extends WildDuckSearchParams {
    /** Rows on the page (WildDuck takes 1 to 250). */
    limit:   number
    /** The previous page's `nextCursor`; omitted for the first page. */
    next?:   string
    /** Only the messages of this WildDuck thread id (24 hex digits), in every mailbox unless `mailbox` is given. */
    thread?: string
    /** `asc` lists the oldest received first; WildDuck's default is newest first. */
    order?:  'asc'
}

/** A search row with the parts {@link WildDuckSearchResult} folds into `message`, and WildDuck's intro. */
export interface WildDuckSearchRow extends WildDuckSearchResult {
    uid:       number
    /** WildDuck's id of the mailbox the message is in. */
    mailboxId: string
    /** The start of the message's text, as WildDuck excerpts it; empty when it has none. */
    intro:     string
}

/** One page of a search, and the cursor for the next page when there is one. */
export interface WildDuckSearchPage {
    results:     WildDuckSearchRow[]
    nextCursor?: string
}

/** A thread id as WildDuck issues it (a MongoDB ObjectId) and as its search validates it. */
const THREAD_ID_PATTERN = /^[0-9a-f]{24}$/iu;

interface WildDuckClientOptions {
    /** Base URL e.g. 'https://wildduck-api.example.com' */
    url:               string
    /** Username for authentication */
    user:              string
    /** Password for authentication */
    password:          string
    /** Maximum body size in bytes before truncation (default: 50_000) */
    maxBodySizeBytes?: number
}

/**
 * Attachment metadata with WildDuck remote ID for lazy data fetching.
 */
export interface WildDuckAttachmentMeta {
    /** WildDuck attachment ID (for fetching data via getAttachment) */
    id:          string
    /** Original filename */
    filename:    string
    /** MIME content type */
    contentType: string
    /** Size in kilobytes */
    sizeKb:      number
}

/**
 * EmailMetadata extended with WildDuck attachment metadata for lazy fetch.
 * Attachments array is empty (data not fetched); use attachmentMeta for IDs.
 */
interface WildDuckEmailMetadata extends EmailMetadata {
    /** WildDuck attachment metadata (IDs + names) for lazy fetching */
    attachmentMeta: WildDuckAttachmentMeta[]
}

interface WildDuckAddress {
    id:      string
    address: string
    name:    string
    main:    boolean
    tags:    string[]
}

interface WildDuckMessageReference {
    action:  'reply' | 'replyAll'
    mailbox: string
    id:      number
}

export interface WildDuckAttachment {
    filename:    string
    contentType: string
    content:     string
}

export interface WildDuckUploadPayload {
    from:             { name?: string, address: string }
    to?:              { name?: string, address: string }[]
    cc?:              { name?: string, address: string }[]
    subject:          string
    text:             string
    reference?:       WildDuckMessageReference
    attachments?:     WildDuckAttachment[]
    metaData?:        Record<string, unknown>
    flags?:           string[]
    draft?:           boolean
    replacePrevious?: { mailbox: string, id: number }
}

/** An attachment as WildDuck's message GET lists it. */
export interface WildDuckMessageAttachment {
    id:          string
    filename:    string
    contentType: string
    sizeKb:      number
    /** Decoded size in bytes, when WildDuck reports it. */
    size?:       number
    related?:    boolean
}

/** A message as WildDuck's `GET .../messages/:message` returns it (the fields this code reads). */
export interface WildDuckMessage {
    id:           number
    subject?:     string
    from?:        { address: string, name?: string }
    to?:          { address: string, name?: string }[]
    cc?:          { address: string, name?: string }[]
    /** Returned for drafts only. */
    bcc?:         { address: string, name?: string }[]
    /** Pre-parsed Reply-To address from WildDuck API */
    replyTo?:     { address: string, name?: string }
    text?:        string
    /** WildDuck returns the HTML body as an array of parts. */
    html?:        string[]
    attachments?: WildDuckMessageAttachment[]
    metaData?:    Record<string, unknown>
    flags?:       string[]
    /** The Message-ID header, angle brackets included. */
    messageId?:   string
    /** The Date header, as an ISO timestamp. WildDuck rewrites a draft's Date when it is submitted. */
    date?:        string | null
    /** Whether the message is still a draft. */
    draft?:       boolean
    /** The References header split into Message-IDs (WildDuck returns `[]` when there is none). */
    references?:  string[]
    /** WildDuck's id of the message's thread, which a thread search takes. */
    thread?:      string
    /**
     * The `reference` ({action, mailbox, id}) a draft was uploaded with, as WildDuck stored it;
     * absent otherwise. Untrusted shape: parse before use.
     */
    reference?:   unknown
}

/**
 * An attachment's bytes as WildDuck streams them, with the response's HTTP status (any 2xx: the
 * caller decides whether a partial or empty response will do) and their length when WildDuck gave
 * one.
 */
export interface AttachmentStream {
    status:         number
    body:           ReadableStream<Uint8Array> | null
    contentLength?: number
}

/**
 * Cancels a response body that will not be read and waits for it to be released. A cancel that
 * fails is only logged, so it cannot replace the result or error the caller goes on to report.
 */
async function releaseUnreadBody(response: Response): Promise<void> {
    try {
        await response.body?.cancel();
    } catch{
        logger.debug({ status: response.status, msg: 'WildDuck: could not cancel an unread attachment response body' });
    }
}

export interface WildDuckMessageSummary {
    id:          number
    from:        { address: string, name?: string }
    subject:     string
    date:        string
    intro:       string
    attachments: { filename: string, contentType: string, sizeKb: number }[]
}

// ---------------------------------------------------------------------------
// WildDuck API response shapes (internal)
// ---------------------------------------------------------------------------

interface AuthResponse {
    success: boolean
    id?:     string
    token?:  string
}

interface MailboxEntry {
    id:          string
    path:        string
    specialUse?: string
}

interface MailboxListResponse {
    success: boolean
    results: MailboxEntry[]
}

interface AddressListResponse {
    success: boolean
    results: WildDuckAddress[]
}

interface UploadMessageResponse {
    success:          boolean
    message:          { id: number, mailbox: string, size: number }
    /** Present only for a replacePrevious upload; WildDuck may omit it. */
    previousDeleted?: unknown
}

interface SearchResultEntry {
    id:      number | string
    mailbox: string
    from:    { name?: string, address?: string }
    to:      { name?: string, address?: string }[]
    subject: string
    date:    string
    intro?:  string
}

interface SearchResponse {
    success:     boolean
    results:     SearchResultEntry[]
    /** The next page's cursor, or false on the last page. */
    nextCursor?: string | false
}

/**
 * WildDuck's response to a `PUT .../messages/:message` move (`moveTo` in the body): `id` pairs
 * each moved message's `[sourceUid, destinationUid]`. A single-message move always yields exactly
 * one pair, but the source uid is matched explicitly rather than assumed to be `id[0]`.
 */
interface MoveMessageResponse {
    success: boolean
    mailbox: string
    id?:     [number, number][]
}

interface MailboxInfoResponse {
    success: boolean
    total:   number
    unseen:  number
}

interface MessageListResponse {
    success: boolean
    results: WildDuckMessageSummary[]
}

/** One page of a mailbox listing, read only for its Message-IDs and its next-page cursor. */
interface MessageIdPageResponse {
    results:     { messageId?: string }[]
    /** The next page's cursor, or false on the last page. */
    nextCursor?: string | false
}

interface FullMessageResponse {
    success:              boolean
    id:                   number
    messageId?:           string
    from?:                { address: string, name?: string }
    to?:                  { address: string, name?: string }[]
    cc?:                  { address: string, name?: string }[]
    replyTo?:             { address: string, name?: string }
    subject?:             string
    date:                 string
    text?:                string
    /** One string per HTML part. */
    html?:                string[]
    headers?:             Record<string, string>
    attachments?:         { id: string, filename: string, contentType: string, sizeKb: number }[]
    verificationResults?: VerificationResults & {
        tls?:  unknown
        arc?:  boolean
        bimi?: boolean
    }
}

// ---------------------------------------------------------------------------
// WildDuckClient
// ---------------------------------------------------------------------------

/**
 * HTTP client for the WildDuck email server REST API.
 *
 * Handles authentication token management, mailbox ID resolution,
 * and email search. Re-authenticates automatically on 401 responses.
 */
export class WildDuckClient {
    private token:             string | null         = null;
    private authInFlight:      Promise<void> | null  = null;
    private mailboxMap:        Map<string, string>   = new Map<string, string>(); // WildDuck mailbox ID → folder name
    private reverseMailboxMap: Map<string, string>   = new Map<string, string>(); // folder name → WildDuck mailbox ID

    constructor(private readonly options: WildDuckClientOptions) {}

    /**
     * Authenticate with WildDuck and build the mailbox map.
     * Must be called before any other API calls.
     * Creates any required EmailFolder mailboxes that are missing, then re-loads the mailbox map.
     */
    async init(): Promise<void> {
        await this.authenticate();
        await this.loadMailboxes();
        // Create any missing required folders

        const missingFolders = Object.values(EmailFolder).filter(folder => !this.reverseMailboxMap.has(folder));
        if(missingFolders.length > 0) {
            let nextIndex = 0;
            const state: { stopped: boolean, firstFailure: unknown } = { stopped: false, firstFailure: undefined };
            const stopAfterFirstFailure = (error: unknown): void => {
                if(state.stopped) {
                    return;
                }
                state.firstFailure = error;
                state.stopped = true;
            };
            const createWorker = async (): Promise<void> => {
                // Stryker disable next-line llm: nextIndex advances by one per admitted folder and cannot overshoot the array length.
                while(nextIndex < missingFolders.length && !state.stopped) {
                    // Stryker disable next-line llm: removing the non-null assertion is type-only and has no runtime effect.
                    const folder = missingFolders[nextIndex++]!;
                    try {
                        // eslint-disable-next-line no-await-in-loop -- each worker admits one folder at a time, with at most two in flight
                        await this.createMailbox(folder);
                    } catch (error) {
                        stopAfterFirstFailure(error);
                        throw error;
                    }
                }
            };
            // Wait for every admitted worker before reporting the first failure. This
            // prevents shutdown from racing a sibling mailbox creation.
            // Stryker disable next-line llm: createWorker ignores mapper arguments, and a surplus worker exits without side effects.
            await Promise.allSettled(Array.from({ length: Math.min(2, missingFolders.length) }, () => createWorker()));
            if(state.stopped) {
                throw state.firstFailure;
            }
            await this.loadMailboxes();
        }
    }

    /**
     * Invalidate authentication token.
     */
    async shutdown(): Promise<void> {
        try {
            if(this.token) {
                await this.makeRequest<unknown>('/authenticate', {
                    method:  'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                });
            }
        } catch{
            // Best-effort — ignore errors on shutdown
        }
        this.token = null;
    }

    /**
     * Search emails using WildDuck API.
     */
    async search(params: WildDuckSearchParams): Promise<WildDuckSearchResult[]> {
        return this.withAuthRetry(() => this.doSearch(params));
    }

    /**
     * One page of a search: at most `limit` rows after the `next` cursor, and WildDuck's cursor for
     * the page after it (absent on the last page). A cursor is only valid with the filters it came
     * from. An unknown mailbox, or a thread id WildDuck could not have issued, throws a
     * WildDuckError (`invalid_request`) before any request; a page with a row from another mailbox
     * than the one searched throws one (`bad_response`).
     */
    async searchPage(request: WildDuckSearchPageRequest): Promise<WildDuckSearchPage> {
        return this.withAuthRetry(() => this.doSearchPage(request));
    }

    /**
     * Search a mailbox for messages with a given keyword flag and return their UIDs.
     * Delegates to search() with keyword query restricted to the specified mailbox.
     */
    async searchByKeyword(mailboxPath: string, keyword: string): Promise<number[]> {
        const results = await this.search({
            query:   { keyword },
            mailbox: mailboxPath,
        });
        return results.flatMap((result) => {
            const reference = parseMailboxMessageRef(result.message);
            return reference ? [reference.uid] : [];
        });
    }

    /**
     * Retrieve all email addresses for the current user.
     */
    async getUserAddresses(): Promise<WildDuckAddress[]> {
        return this.withAuthRetry(() => this.doGetUserAddresses());
    }

    /**
     * Upload a message to a mailbox.
     */
    async uploadMessage(mailboxPath: string, payload: WildDuckUploadPayload): Promise<number> {
        const response = await this.withAuthRetry(() => this.doUploadMessage(mailboxPath, payload));
        return response.message.id;
    }

    /**
     * Upload a new version of a draft to Drafts, asking WildDuck to delete `previousUid` once the
     * new one is stored (`replacePrevious`). That delete is not atomic with the upload: WildDuck
     * stores the new message first, and a failed delete still reports success. So the result
     * carries `previousDeleted`, false unless WildDuck says the old UID is gone. `signal` cancels
     * the request (and the wait for a shared re-authentication); a cancelled upload may still have
     * been stored.
     */
    async uploadReplacingDraft(payload: Omit<WildDuckUploadPayload, 'replacePrevious'>, previousUid: number, signal?: AbortSignal): Promise<{ id: number, previousDeleted: boolean }> {
        const response = await this.withAuthRetry(() => this.doUploadMessage(EmailFolder.Drafts, {
            ...payload,
            replacePrevious: { mailbox: EmailFolder.Drafts, id: previousUid },
        }, signal), signal);
        return { id: response.message.id, previousDeleted: response.previousDeleted === true };
    }

    /**
     * Submit a stored draft message for delivery. `signal` cancels the request (and the wait for a
     * shared re-authentication).
     */
    async submitMessage(mailboxPath: string, uid: number, signal?: AbortSignal): Promise<void> {
        await this.withAuthRetry(() => this.doSubmitMessage(mailboxPath, uid, signal), signal);
    }

    /**
     * Update metadata on an existing message.
     */
    async updateMessageMetadata(mailboxPath: string, uid: number, metadata: Record<string, unknown>): Promise<void> {
        await this.withAuthRetry(() => this.doUpdateMessageMetadata(mailboxPath, uid, metadata));
    }

    /**
     * Update flags on an existing message (add and/or remove).
     */
    async updateMessageFlags(mailboxPath: string, uid: number, options: { addFlags?: string[], removeFlags?: string[] }): Promise<void> {
        if(!options.addFlags?.length && !options.removeFlags?.length) {
            return;
        }
        await this.withAuthRetry(() => this.doUpdateMessageFlags(mailboxPath, uid, options));
    }

    /**
     * Delete a message by UID. `signal` cancels the request (and the wait for a shared
     * re-authentication); a cancelled delete may still have happened.
     */
    async deleteMessage(mailboxPath: string, uid: number, signal?: AbortSignal): Promise<void> {
        await this.withAuthRetry(() => this.doDeleteMessage(mailboxPath, uid, signal), signal);
    }

    /**
     * Move a message from one mailbox to another. WildDuck (like IMAP) assigns the message a new
     * UID in the destination mailbox, so this returns that destination UID — any card, log entry,
     * or further lookup keyed on the message after the move must use it instead of the caller's
     * source `uid`.
     */
    async moveMessage(sourceMailbox: string, uid: number, destMailbox: string): Promise<number> {
        return this.withAuthRetry(() => this.doMoveMessage(sourceMailbox, uid, destMailbox));
    }

    /**
     * List messages in a mailbox with optional filtering.
     */
    async listMessages(mailbox: string, options?: { unseen?: boolean, limit?: number, order?: 'asc' | 'desc' }): Promise<WildDuckMessageSummary[]> {
        return this.withAuthRetry(() => this.doListMessages(mailbox, options));
    }

    /**
     * Retrieve a full message with body and headers, mapped to WildDuckEmailMetadata.
     * Attachments array is always empty — use attachmentMeta for lazy fetching.
     * Returns null if the message is not found (404). `signal` cancels the request (and the wait
     * for a shared re-authentication).
     */
    async getFullMessage(mailboxPath: string, uid: number, signal?: AbortSignal): Promise<WildDuckEmailMetadata | null> {
        return this.withAuthRetry(() => this.doGetFullMessage(mailboxPath, uid, signal), signal);
    }

    /**
     * Download attachment data as a Buffer. The request, body included, has the 30 s request
     * deadline; `signal` also aborts it (and the wait for a shared re-authentication). An id
     * WildDuck could not have issued throws a WildDuckError before any request.
     */
    async getAttachment(mailboxPath: string, messageUid: number, attachmentId: string, signal?: AbortSignal): Promise<Buffer> {
        assertAttachmentId(attachmentId);
        return this.withAuthRetry(() => this.doGetAttachment(mailboxPath, messageUid, attachmentId, signal), signal);
    }

    /**
     * Open an attachment's decoded bytes as a stream, unread and unbuffered, for the draft preview
     * (#158) and an amend's carried attachments, with the 2xx status WildDuck answered with. Null
     * when WildDuck has no such attachment (404); any other non-2xx throws a WildDuckError carrying
     * only the status, its body released unread. The 30 s request deadline covers only the wait for
     * the response headers; after that only `signal` aborts the body. An id WildDuck could not have
     * issued throws a WildDuckError before any request.
     */
    async openAttachmentStream(mailboxPath: string, uid: number, attachmentId: string, signal?: AbortSignal): Promise<AttachmentStream | null> {
        assertAttachmentId(attachmentId);
        return this.withAuthRetry(() => this.doOpenAttachmentStream(mailboxPath, uid, attachmentId, signal), signal);
    }

    /**
     * Get mailbox message counts (total and unseen).
     */
    async getMailboxCounts(mailboxPath: string): Promise<{ total: number, unseen: number }> {
        return this.withAuthRetry(() => this.doGetMailboxCounts(mailboxPath));
    }

    /**
     * Look up the WildDuck internal mailbox ID for a given mailbox path.
     * Returns undefined if the mailbox path is not found in the current map.
     */

    getMailboxId(mailboxPath: string): string | undefined {
        return this.reverseMailboxMap.get(mailboxPath);
    }

    /**
     * Get the current authentication token (for use in SSE or other HTTP connections).
     * Returns null if not yet authenticated or after shutdown.
     */

    getAuthToken(): string | null {
        return this.token;
    }

    /**
     * Get the base API URL for this client (for use in SSE or other HTTP connections).
     */
    getApiUrl(): string {
        return this.options.url;
    }

    /**
     * Retrieve a message by UID.
     * Returns null if the message is not found (404). `signal` cancels the request (and the wait
     * for a shared re-authentication).
     */
    async getMessage(mailboxPath: string, uid: number, signal?: AbortSignal): Promise<WildDuckMessage | null> {
        return this.withAuthRetry(() => this.doGetMessage(mailboxPath, uid, signal), signal);
    }

    /**
     * Whether a message whose Message-ID header is exactly `messageId` is among the newest
     * {@link FIND_BY_MESSAGE_ID_MAX_PAGES} pages of `mailboxPath` (read and unread alike).
     * False means not found there, not necessarily absent from an older page. `signal` cancels
     * the request in flight (and the wait for a shared re-authentication).
     */
    async findMessageByMessageId(mailboxPath: string, messageId: string, signal?: AbortSignal): Promise<boolean> {
        return this.withAuthRetry(() => this.doFindMessageByMessageId(mailboxPath, messageId, signal), signal);
    }

    // ---------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------

    /**
     * Runs `fn`, and once more after a re-authentication if it was refused with a 401. `signal`
     * (the caller's, when it has one) also ends the wait for that re-authentication, which is
     * shared with every other caller and keeps running for them.
     */
    private async withAuthRetry<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        const tokenAtAttempt = this.token;
        try {
            return await fn();
        } catch (err) {
            if(err instanceof WildDuckAuthError) {
                signal?.throwIfAborted();
                // Another request may have refreshed the token before this 401 arrived.
                // Stryker disable next-line llm: both token values are string or null, for which loose and strict equality agree.
                if(this.token === tokenAtAttempt) {
                    await this.waitFor(this.authenticate(), signal);
                }
                return fn();
            }
            throw err;
        }
    }

    /**
     * Waits for `pending` until it settles or `signal` aborts, whichever is first, without
     * cancelling `pending`. Promise.race subscribes to `pending`, so a rejection after the caller
     * stopped waiting is still handled.
     */
    private async waitFor(pending: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
        if(signal === undefined) {
            return pending;
        }
        const aborted = Promise.withResolvers<never>();
        const onAbort = (): void => {
            aborted.reject(signal.reason);
        };
        signal.addEventListener('abort', onAbort);
        try {
            await Promise.race([pending, aborted.promise]);
        } finally {
            signal.removeEventListener('abort', onAbort);
        }
    }

    private async authenticate(): Promise<void> {
        if(this.authInFlight) {
            return this.authInFlight;
        }
        const pending = this.performAuthentication();
        this.authInFlight = pending;
        try {
            await pending;
        } finally {
            // Both success and failure must release the slot so a later 401 can retry.
            this.authInFlight = null;
        }
    }

    private async performAuthentication(): Promise<void> {
        const response = await this.makeRequest<AuthResponse>('/authenticate', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                username: this.options.user,
                password: this.options.password,
                token:    true,
            }),
        }, /* skipAuth */ true);

        if(!response.token) {
            throw new WildDuckAuthError('Authentication failed: no token returned', { kind: 'auth' });
        }
        this.token = response.token;
    }

    private async loadMailboxes(): Promise<void> {
        const response = await this.makeRequest<MailboxListResponse>(
            '/users/me/mailboxes',
            { method: 'GET' }
        );

        this.mailboxMap.clear();
        this.reverseMailboxMap.clear();

        // Stryker disable next-line llm: results is required by the API contract; a fallback differs only for malformed responses.
        for(const mailbox of response.results) {
            this.mailboxMap.set(mailbox.id, mailbox.path);
            this.reverseMailboxMap.set(mailbox.path, mailbox.id);
            // Also map the logical folder name (e.g. 'Sent Mail') via specialUse flag
            // so that resolveMailboxId() works regardless of server-specific path names
            // (e.g. '[Gmail]/Sent Mail' vs 'Sent Mail')
            // Stryker disable next-line llm: unique non-empty keys make entry order irrelevant, and an absent flag cannot match.
            const mapping = Object.entries(SPECIAL_USE_FLAGS).find(([flag]) => flag === mailbox.specialUse);
            if(mapping) {
                this.reverseMailboxMap.set(mapping[1], mailbox.id);
            }
        }
    }

    private async createMailbox(path: string): Promise<void> {
        await this.withAuthRetry(() => this.doCreateMailbox(path));
    }

    private async doCreateMailbox(path: string): Promise<void> {
        await this.makeRequest<unknown>(
            '/users/me/mailboxes',
            {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ path }),
            }
        );
    }

    /**
     * A search's filters as WildDuck's query parameters. A correspondent is matched in From, or in
     * To or Cc (`or.from`, `or.to`), never as WildDuck's `q` query language, which would replace
     * every other filter (the mailbox included) and could name any mailbox itself. An unknown
     * mailbox throws ({@link resolveMailboxId}) rather than widening the search to every mailbox.
     */
    private searchQuery(params: WildDuckSearchParams): URLSearchParams {
        const searchParams = new URLSearchParams();

        // Add query criteria
        const query = params.query ?? {};
        if(query.correspondent) {
            searchParams.set('or.from', query.correspondent);
            searchParams.set('or.to', query.correspondent);
        }
        if(query.content) {
            searchParams.set('query', query.content);
        }
        if(query.before) {
            searchParams.set('dateend', query.before);
        }
        if(query.since) {
            searchParams.set('datestart', query.since);
        }
        if(query.header) {
            searchParams.set(`header.${query.header.name}`, query.header.value);
        }
        if(query.keyword) {
            searchParams.set('keyword', query.keyword);
        }

        if(params.mailbox) {
            searchParams.set('mailbox', this.resolveMailboxId(params.mailbox));
        }
        if(params.searchable) {
            searchParams.set('searchable', 'true');
        }
        return searchParams;
    }

    private async doSearch(params: WildDuckSearchParams): Promise<WildDuckSearchResult[]> {
        const response = await this.makeRequest<SearchResponse>(`/users/me/search?${this.searchQuery(params).toString()}`, { method: 'GET' });
        return response.results.map(result => this.mapSearchResult(result));
    }

    private async doSearchPage(request: WildDuckSearchPageRequest): Promise<WildDuckSearchPage> {
        if(request.thread !== undefined && !THREAD_ID_PATTERN.test(request.thread)) {
            throw new WildDuckError('WildDuck: not a valid thread id', undefined, { kind: 'invalid_request' });
        }
        const searchParams = this.searchQuery(request);
        searchParams.set('limit', String(request.limit));
        if(request.next !== undefined) {
            searchParams.set('next', request.next);
        }
        if(request.thread !== undefined) {
            searchParams.set('thread', request.thread);
        }
        if(request.order !== undefined) {
            searchParams.set('order', request.order);
        }
        const response = await this.makeRequest<SearchResponse>(`/users/me/search?${searchParams.toString()}`, { method: 'GET' });
        const mailboxId = searchParams.get('mailbox');
        if(mailboxId !== null && response.results.some(result => result.mailbox !== mailboxId)) {
            throw new WildDuckError('WildDuck search returned a message from outside the mailbox searched', undefined, { kind: 'bad_response' });
        }
        const results = response.results.map(result => ({ ...this.mapSearchResult(result), uid: searchResultUid(result), mailboxId: result.mailbox, intro: result.intro ?? '' }));
        return typeof response.nextCursor === 'string' && response.nextCursor !== '' ? { results, nextCursor: response.nextCursor } : { results };
    }

    private mapSearchResult(result: SearchResultEntry): WildDuckSearchResult {
        const folderName = this.mailboxMap.get(result.mailbox) ?? result.mailbox;
        const message    = formatMailboxMessageRef({ folder: folderName, uid: searchResultUid(result) });

        const from = mapSearchAddress(result.from);
        const to   = result.to.map(address => mapSearchAddress(address));

        return {
            message,
            from,
            to,
            subject: result.subject,
            date:    result.date,
        };
    }

    private async doGetUserAddresses(): Promise<WildDuckAddress[]> {
        const response = await this.makeRequest<AddressListResponse>('/users/me/addresses', { method: 'GET' });
        return response.results;
    }

    private async doGetMailboxCounts(mailboxPath: string): Promise<{ total: number, unseen: number }> {
        const mailboxId = this.resolveMailboxId(mailboxPath);
        const response = await this.makeRequest<MailboxInfoResponse>(
            `/users/me/mailboxes/${mailboxId}`,
            // Stryker disable next-line ObjectLiteral: omitting an explicit GET retains fetch's GET default
            { method: 'GET' }
        );
        return { total: response.total, unseen: response.unseen };
    }

    private resolveMailboxId(mailboxPath: string): string {
        const mailboxId = this.reverseMailboxMap.get(mailboxPath);
        if(!mailboxId) {
            throw new WildDuckError(`WildDuck: unknown mailbox path: ${mailboxPath}`, undefined, { kind: 'invalid_request' });
        }
        return mailboxId;
    }

    private async doUploadMessage(mailboxPath: string, payload: WildDuckUploadPayload, signal?: AbortSignal): Promise<UploadMessageResponse> {
        const mailboxId      = this.resolveMailboxId(mailboxPath);
        const resolvedPayload = payload.replacePrevious
            ? { ...payload, replacePrevious: { mailbox: this.resolveMailboxId(payload.replacePrevious.mailbox), id: payload.replacePrevious.id } }
            : payload;
        return this.makeRequest<UploadMessageResponse>(
            `/users/me/mailboxes/${mailboxId}/messages`,
            {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(resolvedPayload),
                signal,
            }
        );
    }

    private async doSubmitMessage(mailboxPath: string, uid: number, signal?: AbortSignal): Promise<void> {
        const mailboxId = this.resolveMailboxId(mailboxPath);
        await this.makeRequest<unknown>(
            `/users/me/mailboxes/${mailboxId}/messages/${uid}/submit`,
            { method: 'POST', signal }
        );
    }

    private async doUpdateMessageMetadata(mailboxPath: string, uid: number, metadata: Record<string, unknown>): Promise<void> {
        const mailboxId = this.resolveMailboxId(mailboxPath);
        await this.makeRequest<unknown>(
            `/users/me/mailboxes/${mailboxId}/messages/${uid}`,
            {
                method:  'PUT',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ metaData: metadata }),
            }
        );
    }

    private async doUpdateMessageFlags(mailboxPath: string, uid: number, options: { addFlags?: string[], removeFlags?: string[] }): Promise<void> {
        const mailboxId = this.resolveMailboxId(mailboxPath);
        const body: Record<string, string[]> = {};
        if(options.addFlags) {
            body.addFlags = options.addFlags;
        }
        if(options.removeFlags) {
            body.removeFlags = options.removeFlags;
        }
        await this.makeRequest<unknown>(
            `/users/me/mailboxes/${mailboxId}/messages/${uid}`,
            {
                method:  'PUT',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(body),
            }
        );
    }

    private async doDeleteMessage(mailboxPath: string, uid: number, signal?: AbortSignal): Promise<void> {
        const mailboxId = this.resolveMailboxId(mailboxPath);
        await this.makeRequest<unknown>(
            `/users/me/mailboxes/${mailboxId}/messages/${uid}`,
            { method: 'DELETE', signal }
        );
    }

    private async doGetMessage(mailboxPath: string, uid: number, signal?: AbortSignal): Promise<WildDuckMessage | null> {
        const mailboxId = this.resolveMailboxId(mailboxPath);
        return this.makeRequestNullable<WildDuckMessage>(
            `/users/me/mailboxes/${mailboxId}/messages/${uid}`,
            { method: 'GET', signal }
        );
    }

    private async doFindMessageByMessageId(mailboxPath: string, messageId: string, signal?: AbortSignal): Promise<boolean> {
        const mailboxId = this.resolveMailboxId(mailboxPath);
        let cursor: string | undefined;
        for(let page = 0; page < FIND_BY_MESSAGE_ID_MAX_PAGES; page++) {
            const searchParams = new URLSearchParams({ order: 'desc', limit: String(FIND_BY_MESSAGE_ID_PAGE_SIZE) });
            if(cursor !== undefined) {
                searchParams.set('next', cursor);
            }
            // eslint-disable-next-line no-await-in-loop -- each page's cursor comes from the one before.
            const response = await this.makeRequest<MessageIdPageResponse>(
                `/users/me/mailboxes/${mailboxId}/messages?${searchParams.toString()}`,
                { method: 'GET', signal }
            );
            if(response.results.some(result => result.messageId === messageId)) {
                return true;
            }
            if(typeof response.nextCursor !== 'string') {
                return false;
            }
            cursor = response.nextCursor;
        }
        return false;
    }

    private async doMoveMessage(sourceMailbox: string, uid: number, destMailbox: string): Promise<number> {
        const sourceId = this.resolveMailboxId(sourceMailbox);
        const destId   = this.resolveMailboxId(destMailbox);
        const response = await this.makeRequest<MoveMessageResponse>(
            `/users/me/mailboxes/${sourceId}/messages/${uid}`,
            {
                method:  'PUT',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ moveTo: destId }),
            }
        );
        const pair      = response.id?.find(([sourceUid]) => sourceUid === uid);
        const destUid   = pair?.[1];
        if(typeof destUid !== 'number') {
            throw new WildDuckError(
                `WildDuck move response missing destination uid for source uid ${uid}`,
                undefined,
                { kind: 'bad_response', sourceMailbox, uid, destMailbox }
            );
        }
        return destUid;
    }

    private async doListMessages(mailbox: string, options?: { unseen?: boolean, limit?: number, order?: 'asc' | 'desc' }): Promise<WildDuckMessageSummary[]> {
        const mailboxId    = this.resolveMailboxId(mailbox);
        const opts         = { unseen: true, limit: 20, order: 'asc' as const, ...options };
        const searchParams = new URLSearchParams({
            unseen: String(opts.unseen),
            limit:  String(opts.limit),
            order:  opts.order,
        });
        const response = await this.makeRequest<MessageListResponse>(
            `/users/me/mailboxes/${mailboxId}/messages?${searchParams.toString()}`,
            { method: 'GET' }
        );
        return response.results;
    }

    private async doGetFullMessage(mailboxPath: string, uid: number, signal?: AbortSignal): Promise<WildDuckEmailMetadata | null> {
        const mailboxId = this.resolveMailboxId(mailboxPath);
        const response  = await this.makeRequestNullable<FullMessageResponse>(
            `/users/me/mailboxes/${mailboxId}/messages/${uid}`,
            { method: 'GET', signal }
        );
        if(!response) {
            return null;
        }
        return this.mapFullMessage(response);
    }

    /**
     * Map raw header record and replyTo into a typed EmailHeaders object.
     */
    private mapHeaders(hdrs: Record<string, string>, replyTo: { address: string, name?: string } | undefined): EmailHeaders {
        return {
            ...(hdrs['message-id']             ? { messageId: hdrs['message-id'] }                         : {}),
            ...(hdrs['in-reply-to']            ? { inReplyTo: hdrs['in-reply-to'] }                        : {}),
            ...(replyTo?.address               ? { replyTo: replyTo.address }                               : {}),
            ...(hdrs['authentication-results'] ? { authenticationResults: hdrs['authentication-results'] } : {}),
            ...(hdrs['x-rspamd-report']        ? { xRspamdReport: hdrs['x-rspamd-report'] }                : {}),
            ...(hdrs['x-rspamd-score']         ? { xRspamdScore: hdrs['x-rspamd-score'] }                  : {}),
        };
    }

    private mapFullMessage(response: FullMessageResponse): WildDuckEmailMetadata {
        const bodyText = messageBodyText(response.text, response.html, this.options.maxBodySizeBytes ?? 50_000);

        // Map addresses
        const from = response.from ? mapAddress(response.from) : { address: '' };
        const to   = (response.to ?? []).map(addr => mapAddress(addr));
        // Stryker disable next-line llm: cc entries are contractually non-null; filtering changes only malformed responses.
        const cc   = (response.cc ?? []).map(addr => mapAddress(addr));

        // Map headers
        const headers = this.mapHeaders(response.headers ?? {}, response.replyTo);

        // Map attachment metadata for lazy fetching (data not fetched here)
        // Stryker disable next-line llm: attachment id, filename, and sizeKb are required; fallbacks differ only for malformed responses.
        const attachmentMeta: WildDuckAttachmentMeta[] = (response.attachments ?? []).map(att => ({
            id:          att.id,
            filename:    att.filename,
            contentType: att.contentType,
            sizeKb:      att.sizeKb,
        }));

        const verificationResults: VerificationResults | undefined = response.verificationResults
            ? { spf: response.verificationResults.spf, dkim: response.verificationResults.dkim }
            : undefined;

        return {
            uid:            response.id,
            messageId:      response.messageId ?? response.headers?.['message-id'] ?? '',
            from,
            to,
            cc,
            subject:        response.subject ?? '',
            // Stryker disable next-line llm: date is contractually non-null, and undefined and an empty string both produce Invalid Date.
            date:           new Date(response.date),
            bodyText,
            // Stryker disable next-line NumberLiteralValue: the fallback is compared only with > 0, so any non-positive value is equivalent.
            hasAttachments: (response.attachments?.length ?? 0) > 0,
            headers,
            verificationResults,
            attachments:    [],
            attachmentMeta,
        };
    }

    private async doGetAttachment(mailboxPath: string, messageUid: number, attachmentId: string, signal?: AbortSignal): Promise<Buffer> {
        const mailboxId = this.resolveMailboxId(mailboxPath);
        return this.makeRequestBuffer(
            `/users/me/mailboxes/${mailboxId}/messages/${messageUid}/attachments/${attachmentId}`,
            { method: 'GET', signal }
        );
    }

    private async doOpenAttachmentStream(mailboxPath: string, uid: number, attachmentId: string, signal?: AbortSignal): Promise<AttachmentStream | null> {
        const mailboxId = this.resolveMailboxId(mailboxPath);
        const headerDeadline = new AbortController();
        const timer = setTimeout(() => {
            headerDeadline.abort(new WildDuckError('WildDuck attachment request timed out before its headers arrived', undefined, { kind: 'timeout' }));
        }, REQUEST_TIMEOUT_MS);
        let response: Response;
        try {
            response = await fetch(`${this.options.url}/users/me/mailboxes/${mailboxId}/messages/${uid}/attachments/${attachmentId}`, {
                method:  'GET',
                headers: this.token === null ? {} : { 'X-Access-Token': this.token },
                signal:  signal ? AbortSignal.any([signal, headerDeadline.signal]) : headerDeadline.signal,
            });
        } finally {
            clearTimeout(timer);
        }

        if(response.status === 404) {
            await releaseUnreadBody(response);
            return null;
        }
        if(response.status === 401) {
            await releaseUnreadBody(response);
            throw new WildDuckAuthError('WildDuck authentication failed (401)', { kind: 'auth' });
        }
        if(!response.ok) {
            // The error body is never read: it is released unread, so it is neither buffered nor echoed
            await releaseUnreadBody(response);
            throw new WildDuckError(`WildDuck API error: ${response.status} ${response.statusText}`, undefined, { status: response.status, kind: 'http' });
        }

        // A decoded (content-encoded) body's length differs from the header's, so it is only passed through for an identity body.
        const length = response.headers.get('content-length');
        return length !== null && /^\d+$/u.test(length) && response.headers.get('content-encoding') === null
            ? { status: response.status, body: response.body, contentLength: Number(length) }
            : { status: response.status, body: response.body };
    }

    /** A request whose 2xx body is an attachment's bytes (see {@link send}). */
    private async makeRequestBuffer(path: string, options: RequestInit): Promise<Buffer> {
        return this.send(path, options, async response => Buffer.from(await response.arrayBuffer()));
    }

    /** A request whose 2xx body is JSON, or null when WildDuck answers 404 (see {@link send}). */
    private async makeRequestNullable<T>(path: string, options: RequestInit): Promise<T | null> {
        return this.send<T | null>(path, options, async response => response.json() as Promise<T>, { notFound: { value: null } });
    }

    /** A request whose 2xx body is JSON (see {@link send}). */
    private async makeRequest<T>(path: string, options: RequestInit, skipAuth = false): Promise<T> {
        return this.send(path, options, async response => response.json() as Promise<T>, { skipAuth });
    }

    /**
     * Sends one request under a {@link REQUEST_TIMEOUT_MS} deadline, composed with any
     * `options.signal`, and returns what `read` makes of a 2xx response (or `notFound.value` for a
     * 404, when given). A 401 throws a WildDuckAuthError; any other non-2xx a WildDuckError
     * carrying its status. The deadline covers reading the body too, so it stands down only once
     * the response is consumed, and an unread body is released while it still stands.
     */
    private async send<T>(path: string, options: RequestInit, read: (response: Response) => Promise<T>, { skipAuth = false, notFound }: { skipAuth?: boolean, notFound?: { value: T } } = {}): Promise<T> {
        const headers: Record<string, string> = {
            ...options.headers as Record<string, string>,
        };

        if(!skipAuth && this.token) {
            headers['X-Access-Token'] = this.token;
        }

        const deadline = createDeadline(REQUEST_TIMEOUT_MS);
        let response: Response | undefined;
        try {
            response = await fetch(`${this.options.url}${path}`, {
                ...options,
                headers,
                signal: options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal,
            });

            if(response.status === 404 && notFound !== undefined) {
                return notFound.value;
            }

            if(response.status === 401) {
                throw new WildDuckAuthError('WildDuck authentication failed (401)', { kind: 'auth' });
            }

            if(!response.ok) {
                const body = await response.text();
                // Stryker disable next-line llm: response.text returns a string whose only falsy value is the same empty string.
                const bodySuffix = body ? `: ${body}` : '';
                throw new WildDuckError(`WildDuck API error: ${response.status} ${response.statusText}${bodySuffix}`, undefined, { status: response.status, kind: 'http' });
            }

            return await read(response);
        } finally {
            // A 401 or 404 returns or throws without reading the body: release it while the deadline still stands, never after
            discardBody(response);
            deadline.clear();
        }
    }
}
