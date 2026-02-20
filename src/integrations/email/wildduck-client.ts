/* eslint-disable n/no-unsupported-features/node-builtins -- Bun runtime supports fetch natively */
import _ from 'lodash';
import { logger } from '@hughescr/logger';
import { WildDuckError, WildDuckAuthError } from '@/integrations/email/errors';
export { WildDuckError, WildDuckAuthError } from '@/integrations/email/errors';
import { SPECIAL_USE_FLAGS } from '@/integrations/email/imap-connection';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchCriteria {
    correspondent?: string
    content?:       string
    before?:        string
    since?:         string
    header?:        { name: string, value: string }
    keyword?:       string
}

export interface WildDuckSearchParams {
    query?:     SearchCriteria
    mailboxes?: string[]
}

export interface WildDuckSearchResult {
    /** 'FolderName:uid' format e.g. 'CleanInbox:42' */
    message: string
    from:    string
    to:      string[]
    subject: string
    date:    string
}

export interface WildDuckClientOptions {
    /** Base URL e.g. 'https://wildduck-api.example.com' */
    url:          string
    /** IMAP username for authentication */
    imapUser:     string
    /** IMAP password for authentication */
    imapPassword: string
}

export interface WildDuckAddress {
    id:      string
    address: string
    name:    string
    main:    boolean
    tags:    string[]
}

export interface WildDuckMessageReference {
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

export interface WildDuckMessage {
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
    private mailboxMap:        Map<string, string>   = new Map<string, string>(); // WildDuck mailbox ID → folder name
    private reverseMailboxMap: Map<string, string>   = new Map<string, string>(); // folder name → WildDuck mailbox ID

    constructor(private readonly options: WildDuckClientOptions) {}

    /**
     * Authenticate with WildDuck and build the mailbox map.
     * Must be called before any search() calls.
     */
    async init(): Promise<void> {
        await this.authenticate();
        await this.loadMailboxes();
    }

    /**
     * Invalidate authentication token.
     */
    async shutdown(): Promise<void> {
        // Stryker disable BlockStatement: try-catch guards token cleanup - non-fatal if server unreachable
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
     * Retries once on 401 by re-authenticating.
     */
    async search(params: WildDuckSearchParams): Promise<WildDuckSearchResult[]> {
        // Stryker disable BlockStatement: try-catch with re-auth retry - inner structure is essential
        try {
            return await this.doSearch(params);
        } catch (err) {
            if(err instanceof WildDuckAuthError) {
                // Re-authenticate once and retry
                await this.authenticate();
                return this.doSearch(params);
            }
            throw err;
        }
        // Stryker restore BlockStatement
    }

    /**
     * Retrieve all email addresses for the current user.
     * Retries once on 401 by re-authenticating.
     */
    async getUserAddresses(): Promise<WildDuckAddress[]> {
        // Stryker disable BlockStatement: try-catch with re-auth retry - inner structure is essential
        try {
            return await this.doGetUserAddresses();
        } catch (err) {
            if(err instanceof WildDuckAuthError) {
                await this.authenticate();
                return this.doGetUserAddresses();
            }
            throw err;
        }
        // Stryker restore BlockStatement
    }

    /**
     * Upload a message to a mailbox.
     * Retries once on 401 by re-authenticating.
     */
    async uploadMessage(mailboxPath: string, payload: WildDuckUploadPayload): Promise<number> {
        // Stryker disable BlockStatement: try-catch with re-auth retry - inner structure is essential
        try {
            return await this.doUploadMessage(mailboxPath, payload);
        } catch (err) {
            if(err instanceof WildDuckAuthError) {
                await this.authenticate();
                return this.doUploadMessage(mailboxPath, payload);
            }
            throw err;
        }
        // Stryker restore BlockStatement
    }

    /**
     * Submit a stored draft message for delivery.
     * Retries once on 401 by re-authenticating.
     */
    async submitMessage(mailboxPath: string, uid: number): Promise<void> {
        // Stryker disable BlockStatement: try-catch with re-auth retry - inner structure is essential
        try {
            await this.doSubmitMessage(mailboxPath, uid);
        } catch (err) {
            if(err instanceof WildDuckAuthError) {
                await this.authenticate();
                await this.doSubmitMessage(mailboxPath, uid);
                return;
            }
            throw err;
        }
        // Stryker restore BlockStatement
    }

    /**
     * Update metadata on an existing message.
     * Retries once on 401 by re-authenticating.
     */
    async updateMessageMetadata(mailboxPath: string, uid: number, metadata: Record<string, unknown>): Promise<void> {
        // Stryker disable BlockStatement: try-catch with re-auth retry - inner structure is essential
        try {
            await this.doUpdateMessageMetadata(mailboxPath, uid, metadata);
        } catch (err) {
            if(err instanceof WildDuckAuthError) {
                await this.authenticate();
                await this.doUpdateMessageMetadata(mailboxPath, uid, metadata);
                return;
            }
            throw err;
        }
        // Stryker restore BlockStatement
    }

    /**
     * Update flags on an existing message (add and/or remove).
     * Retries once on 401 by re-authenticating.
     */
    async updateMessageFlags(mailboxPath: string, uid: number, options: { addFlags?: string[], removeFlags?: string[] }): Promise<void> {
        // Stryker disable next-line ConditionalExpression,LogicalOperator: early return when no flags to update — no-op is correct
        if(!options.addFlags?.length && !options.removeFlags?.length) {
            return;
        }
        // Stryker disable BlockStatement: try-catch with re-auth retry - inner structure is essential
        try {
            await this.doUpdateMessageFlags(mailboxPath, uid, options);
        } catch (err) {
            if(err instanceof WildDuckAuthError) {
                await this.authenticate();
                await this.doUpdateMessageFlags(mailboxPath, uid, options);
                return;
            }
            throw err;
        }
        // Stryker restore BlockStatement
    }

    /**
     * Delete a message by IMAP UID.
     * Retries once on 401 by re-authenticating.
     */
    async deleteMessage(mailboxPath: string, uid: number): Promise<void> {
        // Stryker disable BlockStatement: try-catch with re-auth retry - inner structure is essential
        try {
            await this.doDeleteMessage(mailboxPath, uid);
        } catch (err) {
            if(err instanceof WildDuckAuthError) {
                await this.authenticate();
                await this.doDeleteMessage(mailboxPath, uid);
                return;
            }
            throw err;
        }
        // Stryker restore BlockStatement
    }

    /**
     * Look up the WildDuck internal mailbox ID for a given mailbox path.
     * Returns undefined if the mailbox path is not found in the current map.
     */
    getMailboxId(mailboxPath: string): string | undefined {
        return this.reverseMailboxMap.get(mailboxPath);
    }

    /**
     * Retrieve a message by IMAP UID.
     * Returns null if the message is not found (404).
     * Retries once on 401 by re-authenticating.
     */
    async getMessage(mailboxPath: string, uid: number): Promise<WildDuckMessage | null> {
        // Stryker disable BlockStatement: try-catch with re-auth retry - inner structure is essential
        try {
            return await this.doGetMessage(mailboxPath, uid);
        } catch (err) {
            if(err instanceof WildDuckAuthError) {
                await this.authenticate();
                return this.doGetMessage(mailboxPath, uid);
            }
            throw err;
        }
        // Stryker restore BlockStatement
    }

    // ---------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------

    private async authenticate(): Promise<void> {
        const response = await this.makeRequest<AuthResponse>('/authenticate', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                username: this.options.imapUser,
                password: this.options.imapPassword,
                token:    true,
            }),
        }, /* skipAuth */ true);

        if(!response.token) {
            // Stryker disable next-line StringLiteral: Error message is configuration
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
            if(mailbox.specialUse) {
                const logicalName = SPECIAL_USE_FLAGS[mailbox.specialUse];
                // Stryker disable next-line ConditionalExpression: guard against undefined logicalName — Map.set(undefined, id) stores under undefined key (not string 'undefined'), untestable via getMailboxId() which requires a string argument
                if(logicalName) {
                    this.reverseMailboxMap.set(logicalName, mailbox.id);
                }
            }
        }
    }

    private async doSearch(params: WildDuckSearchParams): Promise<WildDuckSearchResult[]> {
        const searchParams = new URLSearchParams();

        // Add query criteria
        const query = params.query ?? {};
        if(query.correspondent) {
            searchParams.set('q', query.correspondent);
        }
        if(query.content) {
            // Stryker disable next-line StringLiteral: query param name is API contract
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
            // Stryker disable next-line StringLiteral: query param name is API contract
            searchParams.set('keyword', query.keyword);
        }

        // Map mailbox names to WildDuck IDs
        // Stryker disable next-line EqualityOperator,ConditionalExpression: length > 0 and length >= 0 are equivalent since the loop body runs 0 times for empty arrays; ConditionalExpression → true would still run 0 times when array is empty
        if(params.mailboxes && params.mailboxes.length > 0) {
            for(const folderName of params.mailboxes) {
                const mailboxId = this.reverseMailboxMap.get(folderName);
                if(mailboxId) {
                    searchParams.append('mailbox', mailboxId);
                } else {
                    // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                    logger.warn({ folderName, msg: 'WildDuck search: unknown mailbox name skipped' });
                }
            }
        }

        const url = `/users/me/search?${searchParams.toString()}`;
        const response = await this.makeRequest<SearchResponse>(url, { method: 'GET' });

        return _.map(response.results, result => this.mapSearchResult(result));
    }

    private mapSearchResult(result: SearchResultEntry): WildDuckSearchResult {
        const folderName = this.mailboxMap.get(result.mailbox) ?? result.mailbox;
        const message    = `${folderName}:${String(result.id)}`;

        // Stryker disable StringLiteral: ?? '' fallbacks for absent address are defensive — in practice WildDuck always provides address
        const from = result.from.name
            ? `${result.from.name} <${result.from.address ?? ''}>`
            : (result.from.address ?? '');

        const to = _.map(result.to, addr => (
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

    private resolveMailboxId(mailboxPath: string): string {
        const mailboxId = this.reverseMailboxMap.get(mailboxPath);
        if(!mailboxId) {
            // Stryker disable next-line StringLiteral: Error message is configuration
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

    private async makeRequestNullable<T>(path: string, options: RequestInit): Promise<T | null> {
        // Stryker disable ObjectLiteral,LogicalOperator: spread of options.headers is defensive — options always has no headers in practice
        const headers: Record<string, string> = {
            ...(options.headers as Record<string, string> ?? {}),
        };
        // Stryker restore ObjectLiteral,LogicalOperator

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
            // Stryker disable next-line StringLiteral: Error message is configuration
            throw new WildDuckAuthError('WildDuck authentication failed (401)');
        }

        if(!response.ok) {
            const body = await response.text();
            // Stryker disable next-line StringLiteral: Error message is configuration
            throw new WildDuckError(`WildDuck API error: ${response.status} ${response.statusText}${body ? `: ${body}` : ''}`);
        }

        return response.json() as Promise<T>;
    }

    private async makeRequest<T>(path: string, options: RequestInit, skipAuth = false): Promise<T> {
        const headers: Record<string, string> = {
            ...(options.headers as Record<string, string> ?? {}),
        };

        if(!skipAuth && this.token) {
            headers['X-Access-Token'] = this.token;
        }

        const response = await fetch(`${this.options.url}${path}`, {
            ...options,
            headers,
        });

        if(response.status === 401) {
            // Stryker disable next-line StringLiteral: Error message is configuration
            throw new WildDuckAuthError('WildDuck authentication failed (401)');
        }

        if(!response.ok) {
            const body = await response.text();
            // Stryker disable next-line StringLiteral: Error message is configuration
            throw new WildDuckError(`WildDuck API error: ${response.status} ${response.statusText}${body ? `: ${body}` : ''}`);
        }

        return response.json() as Promise<T>;
    }
}
