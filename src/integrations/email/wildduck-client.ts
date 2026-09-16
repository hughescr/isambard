import { logger } from '@hughescr/logger';
import { convert } from 'html-to-text';
import { WildDuckError, WildDuckAuthError } from '@/errors';
import { type EmailMetadata, type EmailAddress, type EmailHeaders, type VerificationResults, EmailFolder  } from '@/integrations/email/types';

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
// Stryker restore StringLiteral,ObjectLiteral

const REQUEST_TIMEOUT_MS = 30_000;

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
    from:    string
    to:      string[]
    subject: string
    date:    string
}

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

interface WildDuckUploadPayload {
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

interface WildDuckMessage {
    id:        number
    subject?:  string
    from?:     { address: string, name?: string }
    to?:       { address: string, name?: string }[]
    cc?:       { address: string, name?: string }[]
    /** Pre-parsed Reply-To address from WildDuck API */
    replyTo?:  { address: string, name?: string }
    text?:     string
    html?:     string
    metaData?: Record<string, unknown>
    flags?:    string[]
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
    success:         boolean
    message:         { id: number, mailbox: string, size: number }
    previousDeleted: boolean
}

interface SearchResultEntry {
    id:      number | string
    mailbox: string
    from:    { name?: string, address?: string }
    to:      { name?: string, address?: string }[]
    subject: string
    date:    string
}

interface SearchResponse {
    success: boolean
    results: SearchResultEntry[]
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
    html?:                string
    headers?:             Record<string, string>
    attachments?:         { id: string, filename: string, contentType: string, sizeKb: number }[]
    verificationResults?: VerificationResults & {
        tls?:  unknown
        arc?:  boolean
        bimi?: boolean
    }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Extract and optionally convert body text, truncating at UTF-8 boundary.
 */
function extractBody(content: string, isHtml: boolean, maxBytes: number): string {
    const text = isHtml ? convert(content, { wordwrap: false }) : content;
    const buf = Buffer.from(text, 'utf8');
    let end   = Math.min(maxBytes, buf.length);
    while((buf[end]! & 0xC0) === 0x80) {
        end--;
    }
    // A Buffer created from UTF-8 text cannot start with a continuation byte; an
    // out-of-range read bitwise-coerces to zero, so this also stops at byte zero.
    return buf.subarray(0, end).toString('utf8');
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
                while(nextIndex < missingFolders.length && !state.stopped) {
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
        // Stryker restore BlockStatement
        this.token = null;
    }

    /**
     * Search emails using WildDuck API.
     */
    async search(params: WildDuckSearchParams): Promise<WildDuckSearchResult[]> {
        return this.withAuthRetry(() => this.doSearch(params));
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
        const uids = results.map((result) => {
            const colonIdx = result.message.lastIndexOf(':');
            return colonIdx === -1 ? 0 : Number.parseInt(result.message.slice(colonIdx + 1), 10);
        });
        return uids.filter(uid => uid > 0);
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
        return this.withAuthRetry(() => this.doUploadMessage(mailboxPath, payload));
    }

    /**
     * Submit a stored draft message for delivery.
     */
    async submitMessage(mailboxPath: string, uid: number): Promise<void> {
        await this.withAuthRetry(() => this.doSubmitMessage(mailboxPath, uid));
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
     * Delete a message by UID.
     */
    async deleteMessage(mailboxPath: string, uid: number): Promise<void> {
        await this.withAuthRetry(() => this.doDeleteMessage(mailboxPath, uid));
    }

    /**
     * Move a message from one mailbox to another.
     */
    async moveMessage(sourceMailbox: string, uid: number, destMailbox: string): Promise<void> {
        await this.withAuthRetry(() => this.doMoveMessage(sourceMailbox, uid, destMailbox));
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
     * Returns null if the message is not found (404).
     */
    async getFullMessage(mailboxPath: string, uid: number): Promise<WildDuckEmailMetadata | null> {
        return this.withAuthRetry(() => this.doGetFullMessage(mailboxPath, uid));
    }

    /**
     * Download attachment data as a Buffer.
     */
    async getAttachment(mailboxPath: string, messageUid: number, attachmentId: string): Promise<Buffer> {
        return this.withAuthRetry(() => this.doGetAttachment(mailboxPath, messageUid, attachmentId));
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
     * Returns null if the message is not found (404).
     */
    async getMessage(mailboxPath: string, uid: number): Promise<WildDuckMessage | null> {
        return this.withAuthRetry(() => this.doGetMessage(mailboxPath, uid));
    }

    // ---------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------

    private async withAuthRetry<T>(fn: () => Promise<T>): Promise<T> {
        const tokenAtAttempt = this.token;
        try {
            return await fn();
        } catch (err) {
            if(err instanceof WildDuckAuthError) {
                // Another request may have refreshed the token before this 401 arrived.
                if(this.token === tokenAtAttempt) {
                    await this.authenticate();
                }
                return fn();
            }
            throw err;
        }
    }
    // Stryker restore BlockStatement

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
            throw new WildDuckAuthError('Authentication failed: no token returned');
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

        for(const mailbox of response.results) {
            this.mailboxMap.set(mailbox.id, mailbox.path);
            this.reverseMailboxMap.set(mailbox.path, mailbox.id);
            // Also map the logical folder name (e.g. 'Sent Mail') via specialUse flag
            // so that resolveMailboxId() works regardless of server-specific path names
            // (e.g. '[Gmail]/Sent Mail' vs 'Sent Mail')
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
        // Stryker restore ObjectLiteral,StringLiteral
    }

    private async doSearch(params: WildDuckSearchParams): Promise<WildDuckSearchResult[]> {
        const searchParams = new URLSearchParams();

        // Add query criteria
        const query = params.query ?? {};
        if(query.correspondent) {
            searchParams.set('q', query.correspondent);
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

        // Map mailbox name to WildDuck ID
        if(params.mailbox) {
            const mailboxId = this.reverseMailboxMap.get(params.mailbox);
            if(mailboxId) {
                searchParams.set('mailbox', mailboxId);
            } else {
                logger.warn({ folderName: params.mailbox, msg: 'WildDuck search: unknown mailbox name skipped' });
            }
        }
        if(params.searchable) {
            searchParams.set('searchable', 'true');
        }

        const url = `/users/me/search?${searchParams.toString()}`;
        const response = await this.makeRequest<SearchResponse>(url, { method: 'GET' });

        return response.results.map(result => this.mapSearchResult(result));
    }

    private mapSearchResult(result: SearchResultEntry): WildDuckSearchResult {
        const folderName = this.mailboxMap.get(result.mailbox) ?? result.mailbox;
        const message    = `${folderName}:${String(result.id)}`;

        const from = result.from.name
            ? `${result.from.name} <${result.from.address ?? ''}>`
            : (result.from.address ?? '');

        const to = result.to.map(addr => (
            addr.name ? `${addr.name} <${addr.address ?? ''}>` : (addr.address ?? '')
        ));
        // Stryker restore StringLiteral

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
            throw new WildDuckError(`WildDuck: unknown mailbox path: ${mailboxPath}`);
        }
        return mailboxId;
    }

    private async doUploadMessage(mailboxPath: string, payload: WildDuckUploadPayload): Promise<number> {
        const mailboxId      = this.resolveMailboxId(mailboxPath);
        const resolvedPayload = payload.replacePrevious
            ? { ...payload, replacePrevious: { mailbox: this.resolveMailboxId(payload.replacePrevious.mailbox), id: payload.replacePrevious.id } }
            : payload;
        const response = await this.makeRequest<UploadMessageResponse>(
            `/users/me/mailboxes/${mailboxId}/messages`,
            {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(resolvedPayload),
            }
        );
        return response.message.id;
    }

    private async doSubmitMessage(mailboxPath: string, uid: number): Promise<void> {
        const mailboxId = this.resolveMailboxId(mailboxPath);
        await this.makeRequest<unknown>(
            `/users/me/mailboxes/${mailboxId}/messages/${uid}/submit`,
            { method: 'POST' }
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

    private async doDeleteMessage(mailboxPath: string, uid: number): Promise<void> {
        const mailboxId = this.resolveMailboxId(mailboxPath);
        await this.makeRequest<unknown>(
            `/users/me/mailboxes/${mailboxId}/messages/${uid}`,
            { method: 'DELETE' }
        );
    }

    private async doGetMessage(mailboxPath: string, uid: number): Promise<WildDuckMessage | null> {
        const mailboxId = this.resolveMailboxId(mailboxPath);
        return this.makeRequestNullable<WildDuckMessage>(
            `/users/me/mailboxes/${mailboxId}/messages/${uid}`,
            { method: 'GET' }
        );
    }

    private async doMoveMessage(sourceMailbox: string, uid: number, destMailbox: string): Promise<void> {
        const sourceId = this.resolveMailboxId(sourceMailbox);
        const destId   = this.resolveMailboxId(destMailbox);
        await this.makeRequest<unknown>(
            `/users/me/mailboxes/${sourceId}/messages/${uid}`,
            {
                method:  'PUT',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ moveTo: destId }),
            }
        );
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

    private async doGetFullMessage(mailboxPath: string, uid: number): Promise<WildDuckEmailMetadata | null> {
        const mailboxId = this.resolveMailboxId(mailboxPath);
        const response  = await this.makeRequestNullable<FullMessageResponse>(
            `/users/me/mailboxes/${mailboxId}/messages/${uid}`,
            { method: 'GET' }
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
    // Stryker restore StringLiteral

    private extractBodyText(response: FullMessageResponse): string {
        const maxBodySizeBytes = this.options.maxBodySizeBytes ?? 50_000;
        if(response.text) {
            return extractBody(response.text, false, maxBodySizeBytes);
        }
        if(response.html) {
            return extractBody(response.html, true, maxBodySizeBytes);
        }
        return '';
    }

    private mapFullMessage(response: FullMessageResponse): WildDuckEmailMetadata {
        const bodyText = this.extractBodyText(response);

        // Map addresses
        const from = response.from ? mapAddress(response.from) : { address: '' };
        const to   = (response.to ?? []).map(addr => mapAddress(addr));
        const cc   = (response.cc ?? []).map(addr => mapAddress(addr));

        // Map headers
        const headers = this.mapHeaders(response.headers ?? {}, response.replyTo);

        // Map attachment metadata for lazy fetching (data not fetched here)
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
            date:           new Date(response.date),
            bodyText,
            hasAttachments: (response.attachments?.length ?? 0) > 0,
            headers,
            verificationResults,
            attachments:    [],
            attachmentMeta,
        };
    }

    private async doGetAttachment(mailboxPath: string, messageUid: number, attachmentId: string): Promise<Buffer> {
        const mailboxId = this.resolveMailboxId(mailboxPath);
        return this.makeRequestBuffer(
            `/users/me/mailboxes/${mailboxId}/messages/${messageUid}/attachments/${attachmentId}`,
            { method: 'GET' }
        );
    }

    private async makeRequestBuffer(path: string, options: RequestInit): Promise<Buffer> {
        // Stryker disable next-line ObjectLiteral: the only private caller passes GET without headers; the access token is inserted below after this copy
        // Stryker disable next-line SpreadOperandDrop: the only private caller passes headerless GET, so spreading undefined adds no properties.
        const headers: Record<string, string> = {
            ...options.headers as Record<string, string>,
        };

        if(this.token) {
            headers['X-Access-Token'] = this.token;
        }

        const response = await fetch(`${this.options.url}${path}`, {
            ...options,
            headers,
        });

        if(response.status === 401) {
            throw new WildDuckAuthError('WildDuck authentication failed (401)');
        }

        if(!response.ok) {
            const body = await response.text();
            const bodySuffix = body ? `: ${body}` : '';
            throw new WildDuckError(`WildDuck API error: ${response.status} ${response.statusText}${bodySuffix}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    }

    private async makeRequestNullable<T>(path: string, options: RequestInit): Promise<T | null> {
        // Stryker disable ObjectLiteral: both private callers pass GET without headers; the access token is inserted below after this copy
        // Stryker disable next-line SpreadOperandDrop: both private callers pass headerless GET, so spreading undefined adds no properties.
        const headers: Record<string, string> = {
            ...options.headers as Record<string, string>,
        };
        // Stryker restore ObjectLiteral

        if(this.token) {
            headers['X-Access-Token'] = this.token;
        }

        const response = await fetch(`${this.options.url}${path}`, {
            ...options,
            headers,
        });

        if(response.status === 404) {
            return null;
        }

        if(response.status === 401) {
            throw new WildDuckAuthError('WildDuck authentication failed (401)');
        }

        if(!response.ok) {
            const body = await response.text();
            const bodySuffix = body ? `: ${body}` : '';
            throw new WildDuckError(`WildDuck API error: ${response.status} ${response.statusText}${bodySuffix}`);
        }

        return response.json() as Promise<T>;
    }

    private async makeRequest<T>(path: string, options: RequestInit, skipAuth = false): Promise<T> {
        const headers: Record<string, string> = {
            ...options.headers as Record<string, string>,
        };

        if(!skipAuth && this.token) {
            headers['X-Access-Token'] = this.token;
        }

        const response = await fetch(`${this.options.url}${path}`, {
            ...options,
            headers,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if(response.status === 401) {
            throw new WildDuckAuthError('WildDuck authentication failed (401)');
        }

        if(!response.ok) {
            const body = await response.text();
            const bodySuffix = body ? `: ${body}` : '';
            throw new WildDuckError(`WildDuck API error: ${response.status} ${response.statusText}${bodySuffix}`);
        }

        return response.json() as Promise<T>;
    }
}
