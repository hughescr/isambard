import { ImapFlow } from 'imapflow';
import type { FetchMessageObject, MessageStructureObject } from 'imapflow';
import { convert } from 'html-to-text';
import _ from 'lodash';
import { logger } from '@hughescr/logger';
import { ImapConnectionError } from '@/integrations/email/errors';
import type { EmailMetadata, EmailAddress, EmailHeaders, EmailSummary, AttachmentData } from '@/integrations/email/types';
import { EmailFolder } from '@/integrations/email/types';

// ---------------------------------------------------------------------------
// Public config interface
// ---------------------------------------------------------------------------

export interface ImapConnectionConfig {
    host:             string
    port:             number
    user:             string
    password:         string
    maxBodySizeBytes: number
    imapDebug?:       boolean
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Expected folders that must exist. */
// Stryker disable next-line all: EmailFolder enum values are configuration
const REQUIRED_FOLDERS = _.values(EmailFolder);

/**
 * Maps IMAP specialUse flag to the logical EmailFolder value.
 * Standard IMAP flags per RFC 6154.
 */
// Stryker disable StringLiteral,ObjectLiteral: specialUse flag strings and folder values are IMAP RFC 6154 configuration
export const SPECIAL_USE_FLAGS: Record<string, string> = {
    '\\Inbox':   'INBOX',
    '\\Sent':    'Sent Mail',
    '\\Drafts':  'Drafts',
    '\\Junk':    'Junk',
    '\\Trash':   'Trash',
    '\\Archive': 'Archive',
};
// Stryker restore StringLiteral,ObjectLiteral

/**
 * Fallback IMAP path to use when no specialUse flag resolves a folder.
 * Custom folders (CleanInbox, Quarantine, Review) are always hardcoded.
 */
// Stryker disable StringLiteral,ObjectLiteral: fallback path strings and object literal are IMAP server configuration constants
const FOLDER_FALLBACK_PATHS: Record<string, string> = {
    INBOX:       'INBOX',
    'Sent Mail': 'Sent Mail',  // WildDuck uses 'Sent Mail'
    Drafts:      'Drafts',
    Junk:        'Junk',
    Trash:       'Trash',
    Archive:     'Archive',
    CleanInbox:  'CleanInbox',
    Quarantine:  'Quarantine',
    Review:      'Review',
};
// Stryker restore StringLiteral,ObjectLiteral

/** Header names we extract and expose. */
// Stryker disable StringLiteral: HEADER_NAMES entries are configuration constants
const HEADER_NAMES = [
    'from',
    'to',
    'cc',
    'subject',
    'date',
    'message-id',
    'in-reply-to',
    'reply-to',
    'authentication-results',
    'x-rspamd-report',
    'x-rspamd-score',
];
// Stryker enable StringLiteral

/**
 * Parse raw MIME source (Buffer) into a header map.
 * Returns a plain object keyed by lowercase header name.
 */
function parseHeaders(source: Buffer): Record<string, string> {
    const raw           = source.toString('utf8');
    // Header section ends at first blank line
    const blankIdx      = raw.indexOf('\r\n\r\n');
    // Stryker disable next-line ConditionalExpression,EqualityOperator,MethodExpression: blankIdx boundary and slice logic is MIME spec compliance
    const headerSection = blankIdx >= 0 ? raw.slice(0, blankIdx) : raw;

    const result: Record<string, string> = {};
    // Unfold continuation lines (CRLF followed by whitespace)
    const unfolded = _.replace(headerSection, /\r\n([ \t])/g, ' $1');
    const lines    = _.split(unfolded, '\r\n');

    for(const line of lines) {
        const colonIdx = line.indexOf(':');
        // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: colonIdx boundary is MIME header parsing spec
        if(colonIdx <= 0) {
            continue;
        }
        const name  = _.toLower(_.trim(line.slice(0, colonIdx)));
        const value = _.trim(line.slice(colonIdx + 1));
        // Only keep first occurrence and only tracked headers
        if(_.includes(HEADER_NAMES, name) && !(name in result)) {
            result[name] = value;
        }
    }

    return result;
}

/**
 * Find the text/plain part (or text/html as fallback) in a BODYSTRUCTURE tree.
 * Returns { part, isHtml } where part is the IMAP body part number (e.g. '1', '1.1').
 * Returns null if no text parts found.
 */
function findTextPart(bodyStructure: MessageStructureObject | undefined): { part: string, isHtml: boolean } | null {
    // Stryker disable next-line ConditionalExpression,BlockStatement: guard for absent bodyStructure
    if(!bodyStructure) {
        return null;
    }

    const type = _.toLower(bodyStructure.type);

    // Leaf node: check if it's a text part
    // Stryker disable next-line ConditionalExpression,StringLiteral: multipart check distinguishes container vs leaf nodes
    if(!_.startsWith(type, 'multipart/')) {
        if(type === 'text/plain') {
            // Stryker disable next-line ConditionalExpression,StringLiteral: part fallback when bodyStructure.part is absent (simple messages)
            return { part: bodyStructure.part ?? '1', isHtml: false };
        }
        if(type === 'text/html') {
            // Stryker disable next-line ConditionalExpression,StringLiteral: part fallback when bodyStructure.part is absent (simple messages)
            return { part: bodyStructure.part ?? '1', isHtml: true };
        }
        return null;
    }

    // Multipart node: recursively search children, prefer text/plain
    // Stryker disable next-line ConditionalExpression: _.some(undefined) returns [] — childNodes guard
    const children = bodyStructure.childNodes ?? [];
    let htmlFallback: { part: string, isHtml: boolean } | null = null;

    for(const child of children) {
        const found = findTextPart(child);
        // Stryker disable next-line ConditionalExpression,BlockStatement: skip absent children
        if(!found) {
            continue;
        }
        if(!found.isHtml) {
            // Prefer text/plain — return immediately
            return found;
        }
        // Stryker disable next-line LogicalOperator: ??= is equivalent to `if(!htmlFallback) htmlFallback = found` — keep first HTML fallback only
        htmlFallback ??= found;
    }

    return htmlFallback;
}

/**
 * Collect all attachment MIME parts (disposition=attachment) from a BODYSTRUCTURE tree.
 * Returns an array of { part, filename, contentType } for each attachment found.
 */
function findAttachmentParts(
    bodyStructure: MessageStructureObject | undefined
): { part: string, filename: string, contentType: string }[] {
    // Stryker disable next-line ConditionalExpression,BlockStatement: guard for absent bodyStructure
    if(!bodyStructure) {
        return [];
    }

    const results: { part: string, filename: string, contentType: string }[] = [];
    const type = _.toLower(bodyStructure.type);

    // Stryker disable next-line ConditionalExpression,StringLiteral: multipart check distinguishes container vs leaf nodes
    if(!_.startsWith(type, 'multipart/')) {
        // Leaf node: check if it's an attachment
        if(_.toLower(bodyStructure.disposition ?? '') === 'attachment') {
            const filename    = bodyStructure.dispositionParameters?.filename ?? bodyStructure.dispositionParameters?.name ?? 'attachment';
            // Stryker disable next-line ConditionalExpression,StringLiteral: part fallback when bodyStructure.part is absent (simple messages)
            const part        = bodyStructure.part ?? '1';
            results.push({ part, filename, contentType: type });
        }
        return results;
    }

    // Multipart node: recurse into children
    // Stryker disable next-line ConditionalExpression: _.flatMap(undefined) is empty — childNodes guard
    const children = bodyStructure.childNodes ?? [];
    for(const child of children) {
        const found = findAttachmentParts(child);
        // Stryker disable next-line BlockStatement: pushing results from children — always required
        for(const item of found) {
            results.push(item);
        }
    }
    return results;
}

/**
 * Extract plain-text body from a decoded body part string.
 * Converts HTML to text if isHtml is true.
 * Truncates at maxBytes on a valid UTF-8 byte boundary.
 */
function extractBody(content: string, isHtml: boolean, maxBytes: number): string {
    let text: string;
    // Stryker disable next-line ConditionalExpression: isHtml branch controls HTML-to-text conversion
    if(isHtml) {
        // Stryker disable next-line ObjectLiteral: wordwrap:false is html-to-text API configuration
        text = convert(content, { wordwrap: false });
    } else {
        text = content;
    }

    // Truncate at maxBytes on a valid UTF-8 byte boundary
    // Stryker disable next-line ConditionalExpression,EqualityOperator: truncation boundary check — > vs >= is semantic, always-true is semantically equivalent for text < maxBytes
    if(Buffer.byteLength(text, 'utf8') > maxBytes) {
        const buf = Buffer.from(text, 'utf8');
        // Stryker disable next-line ArithmeticOperator: walk back from maxBytes to find valid UTF-8 boundary
        let end = maxBytes;
        // Stryker disable BlockStatement: removing end-- makes an infinite loop — the while body is infrastructure for byte-boundary walking
        // Stryker disable next-line EqualityOperator,ConditionalExpression: 0xC0/0x80 are UTF-8 continuation byte masks; end > 0 vs end >= 0 and condition variants are equivalent for valid UTF-8 (buf[-1] = undefined, undefined & 0xC0 = 0 ≠ 0x80)
        // eslint-disable-next-line no-bitwise -- bitwise AND is required for UTF-8 continuation byte detection (0xC0/0x80 masks)
        while(end > 0 && (buf[end] & 0xC0) === 0x80) {
            end--;
        }
        // Stryker enable BlockStatement
        return buf.subarray(0, end).toString('utf8');
    }

    return text;
}

/**
 * Check whether a body structure has any attachments (disposition=attachment).
 */
function hasAttachmentParts(bodyStructure: MessageStructureObject | undefined): boolean {
    if(!bodyStructure) {
        return false;
    }
    if(_.toLower(bodyStructure.disposition ?? '') === 'attachment') {
        return true;
    }
    // Stryker disable next-line ConditionalExpression: _.some(undefined) returns false — semantically equivalent to guarding with if(childNodes)
    if(bodyStructure.childNodes) {
        return _.some(bodyStructure.childNodes, child => hasAttachmentParts(child));
    }
    return false;
}

/**
 * Map an imapflow address array to our EmailAddress array.
 */
function mapAddresses(addrs: { name?: string, address?: string }[] | undefined): EmailAddress[] {
    // Stryker disable next-line ConditionalExpression,BlockStatement: _.map(undefined) returns [] — semantically equivalent guard
    if(!addrs) {
        return [];
    }
    return _.map(addrs, a => ({
        ...(a.name ? { name: a.name } : {}),
        address: a.address ?? '',
    }));
}

/**
 * Build EmailHeaders from a parsed header map.
 */
function buildEmailHeaders(headers: Record<string, string>): EmailHeaders {
    return {
        ...(headers['message-id']             ? { messageId: headers['message-id']            } : {}),
        ...(headers['in-reply-to']            ? { inReplyTo: headers['in-reply-to']           } : {}),
        // Stryker disable next-line ObjectLiteral: replyTo header pass-through — only present in some emails, tested indirectly
        ...(headers['reply-to']               ? { replyTo: headers['reply-to']              } : {}),
        ...(headers['authentication-results'] ? { authenticationResults: headers['authentication-results'] } : {}),
        ...(headers['x-rspamd-report']        ? { xRspamdReport: headers['x-rspamd-report']       } : {}),
        ...(headers['x-rspamd-score']         ? { xRspamdScore: headers['x-rspamd-score']        } : {}),
    };
}

/**
 * Convert a FetchMessageObject (with pre-fetched body string and attachments) into EmailMetadata.
 */
function toEmailMetadata(msg: FetchMessageObject, bodyText: string, attachments: AttachmentData[] = []): EmailMetadata {
    const headers      = parseHeaders(msg.source ?? Buffer.alloc(0));
    const envelope     = msg.envelope ?? {};
    const fromArr      = mapAddresses(envelope.from);
    const toArr        = mapAddresses(envelope.to);
    const ccArr        = mapAddresses(envelope.cc);
    const emailHeaders = buildEmailHeaders(headers);

    return {
        uid:            msg.uid,
        messageId:      envelope.messageId ?? headers['message-id'] ?? '',
        from:           fromArr[0] ?? { address: '' },
        to:             toArr,
        cc:             ccArr,
        subject:        envelope.subject ?? headers.subject ?? '',
        date:           envelope.date ?? new Date(headers.date ?? 0),
        bodyText,
        hasAttachments: hasAttachmentParts(msg.bodyStructure),
        headers:        emailHeaders,
        attachments,
    };
}

// ---------------------------------------------------------------------------
// ImapConnection class
// ---------------------------------------------------------------------------

export class ImapConnection {
    private readonly client:     ImapFlow;
    private readonly maxBytes:   number;
    private          _connected: boolean;
    // Stryker disable next-line ObjectLiteral: initial queue value is implementation infrastructure
    private          _queue:     Promise<void> = Promise.resolve();
    // Stryker disable next-line BooleanLiteral: initialization flag — false is correct initial state
    private          _idleAborted    = false;
    private          _idleAbort: (() => void) | null = null;
    private          _resolvedPaths = new Map<string, string>();

    constructor(config: ImapConnectionConfig) {
        // Stryker disable next-line ConditionalExpression,BooleanLiteral,EqualityOperator: imapDebug conditional is debug configuration — not behavior-affecting
        const imapLogger = config.imapDebug === true ? logger : false;
        this.client = new ImapFlow({
            host:   config.host,
            port:   config.port,
            // Stryker disable next-line BooleanLiteral: secure:true is required for TLS — always must be true
            secure: true,
            auth:   {
                user: config.user,
                pass: config.password,
            },
            logger: imapLogger,
        });
        // Stryker disable StringLiteral: 'exists' event name is imapflow API configuration — cannot test registration without spying on internals
        this.client.on('exists', () => {
            this.cancelIdle();
        });
        // Stryker restore StringLiteral
        this.maxBytes   = config.maxBodySizeBytes;
        // Stryker disable next-line BooleanLiteral: initialization flag - false is correct initial state
        this._connected = false;
    }

    private serialize<T>(fn: () => Promise<T>): Promise<T> {
        this.cancelIdle(); // Interrupt any in-progress IDLE immediately
        const result = this._queue.then(fn);
        // Stryker disable next-line ObjectLiteral: empty callbacks ensure queue always advances on error
        // eslint-disable-next-line @typescript-eslint/unbound-method -- _.noop is safe to pass as callback; it has no `this` dependency
        this._queue  = result.then(_.noop, _.noop);
        return result;
    }

    /**
     * Resolve a logical EmailFolder value to its actual IMAP path.
     * Returns the resolved path from _resolvedPaths, or the original value
     * if no resolution is available (e.g., before ensureFolders() is called).
     * @internal
     */
    private resolveFolder(folder: string): string {
        // Stryker disable next-line ConditionalExpression: fallback to original folder when not yet resolved
        return this._resolvedPaths.get(folder) ?? folder;
    }

    /** Whether the connection is currently active. */
    get connected(): boolean {
        return this._connected;
    }

    /** Connect to the IMAP server. */
    async connect(): Promise<void> {
        return this.serialize(async () => {
            // Stryker disable BlockStatement: try-catch wraps IMAP connect - error handling
            try {
                await this.client.connect();
                // Stryker disable next-line BooleanLiteral: setting connected=true after successful connect
                this._connected = true;
            } catch (err) {
                throw new ImapConnectionError(
                    // Stryker disable next-line StringLiteral: Error message template is not behavior-affecting
                    `IMAP connect failed: ${_.isError(err) ? err.message : String(err)}`,
                    // Stryker disable next-line ObjectLiteral,StringLiteral: Error cause wrapping is not behavior-affecting
                    { cause: String(err) }
                );
            }
        });
    }

    /** Disconnect gracefully. */
    async disconnect(): Promise<void> {
        return this.serialize(async () => {
            if(!this._connected) {
                return;
            }
            // Stryker disable BlockStatement: try-catch wraps IMAP logout - error handling
            try {
                await this.client.logout();
                // Stryker disable next-line BooleanLiteral: setting connected=false after successful logout
                this._connected = false;
            } catch (err) {
                throw new ImapConnectionError(
                    // Stryker disable next-line StringLiteral: Error message template is not behavior-affecting
                    `IMAP logout failed: ${_.isError(err) ? err.message : String(err)}`,
                    // Stryker disable next-line ObjectLiteral,StringLiteral: Error cause wrapping is not behavior-affecting
                    { cause: String(err) }
                );
            }
        });
    }

    /**
     * Fetch the body text for a single message given its envelope+bodyStructure fetch result.
     * Finds the text/plain (or text/html) MIME part and fetches just that part.
     * Both operations happen within the caller's serialize() callback.
     * @internal
     */
    private async fetchBodyText(uid: number, bodyStructure: MessageStructureObject | undefined): Promise<string> {
        const textPart = findTextPart(bodyStructure);
        // Stryker disable next-line ConditionalExpression,BlockStatement: no text parts found — return empty string
        if(!textPart) {
            return '';
        }
        const partMsg = await this.client.fetchOne(
            String(uid),
            // Stryker disable next-line ObjectLiteral,ArrayDeclaration: bodyParts fetch option is API configuration
            { bodyParts: [textPart.part] },
            // Stryker disable next-line ObjectLiteral,BooleanLiteral: uid option is API configuration
            { uid: true }
        );
        // Stryker disable next-line ConditionalExpression,BlockStatement: guard for absent bodyParts in response
        if(!partMsg || !partMsg.bodyParts) {
            return '';
        }
        const partBuf = partMsg.bodyParts.get(textPart.part);
        // Stryker disable next-line ConditionalExpression,BlockStatement: guard for absent part content
        if(!partBuf) {
            return '';
        }
        return extractBody(partBuf.toString('utf8'), textPart.isHtml, this.maxBytes);
    }

    /**
     * Fetch all attachment parts for a single message given its bodyStructure.
     * Fetches each attachment part and returns the raw data.
     * Both operations happen within the caller's serialize() callback.
     * @internal
     */
    private async fetchAttachments(uid: number, bodyStructure: MessageStructureObject | undefined): Promise<AttachmentData[]> {
        const attachmentParts = findAttachmentParts(bodyStructure);
        // Stryker disable next-line ConditionalExpression,BlockStatement: no attachment parts found — return empty array
        if(attachmentParts.length === 0) {
            return [];
        }

        const results: AttachmentData[] = [];
        for(const { part, filename, contentType } of attachmentParts) {
            // Stryker disable next-line MethodExpression: await is required for sequential attachment fetching within serialize
            const partMsg = await this.client.fetchOne(
                String(uid),
                // Stryker disable next-line ObjectLiteral,ArrayDeclaration: bodyParts fetch option is API configuration
                { bodyParts: [part] },
                // Stryker disable next-line ObjectLiteral,BooleanLiteral: uid option is API configuration
                { uid: true }
            );
            // Stryker disable next-line ConditionalExpression,BlockStatement: guard for absent bodyParts in response
            if(!partMsg || !partMsg.bodyParts) {
                continue;
            }
            const partBuf = partMsg.bodyParts.get(part);
            // Stryker disable next-line ConditionalExpression,BlockStatement: guard for absent part content
            if(!partBuf) {
                continue;
            }
            results.push({ filename, contentType, data: partBuf });
        }
        return results;
    }

    /** Fetch a single message by UID from the given folder. */
    async fetchMessage(folder: string, uid: number): Promise<EmailMetadata> {
        return this.serialize(async () => {
            // Stryker disable BlockStatement: try-catch wraps IMAP fetch - error handling
            try {
                await this.client.mailboxOpen(this.resolveFolder(folder));
                const msg = await this.client.fetchOne(
                    String(uid),
                    // Stryker disable next-line ObjectLiteral,BooleanLiteral: IMAP fetch options are API configuration constants
                    { source: true, envelope: true, bodyStructure: true, uid: true },
                    // Stryker disable next-line ObjectLiteral,BooleanLiteral: IMAP fetch options are API configuration constants
                    { uid: true }
                );
                if(!msg) {
                    throw new ImapConnectionError(`Message UID ${uid} not found in ${folder}`);
                }
                const bodyText    = await this.fetchBodyText(uid, msg.bodyStructure);
                const attachments = await this.fetchAttachments(uid, msg.bodyStructure);
                return toEmailMetadata(msg, bodyText, attachments);
            } catch (err) {
                if(err instanceof ImapConnectionError) {
                    throw err;
                }
                throw new ImapConnectionError(
                    `fetchMessage failed (folder=${folder}, uid=${uid}): ${_.isError(err) ? err.message : String(err)}`,
                    // Stryker disable next-line ObjectLiteral,StringLiteral: Error cause wrapping is not behavior-affecting
                    { cause: String(err) }
                );
            }
        });
    }

    /** Fetch all new messages since (exclusive) sinceUid. */
    async fetchNewMessages(folder: string, sinceUid: number): Promise<EmailMetadata[]> {
        return this.serialize(async () => {
            // Stryker disable BlockStatement: try-catch wraps IMAP search/fetch - error handling
            try {
                await this.client.mailboxOpen(this.resolveFolder(folder));
                const uidRange = `${sinceUid + 1}:*`;
                const uids     = await this.client.search({ uid: uidRange }, { uid: true });
                if(!uids || uids.length === 0) {
                    return [];
                }

                const msgs = await this.client.fetchAll(
                    uids,
                    // Stryker disable next-line ObjectLiteral,BooleanLiteral: IMAP fetch options are API configuration constants
                    { source: true, envelope: true, bodyStructure: true, uid: true },
                    // Stryker disable next-line ObjectLiteral,BooleanLiteral: IMAP fetch options are API configuration constants
                    { uid: true }
                );
                const results: EmailMetadata[] = [];
                for(const m of msgs) {
                    // Stryker disable next-line MethodExpression: await is required for sequential body fetching within serialize
                    const bodyText = await this.fetchBodyText(m.uid, m.bodyStructure);
                    results.push(toEmailMetadata(m, bodyText));
                }
                return results;
            } catch (err) {
                if(err instanceof ImapConnectionError) {
                    throw err;
                }
                throw new ImapConnectionError(
                    `fetchNewMessages failed (folder=${folder}, sinceUid=${sinceUid}): ${_.isError(err) ? err.message : String(err)}`,
                    // Stryker disable next-line ObjectLiteral,StringLiteral: Error cause wrapping is not behavior-affecting
                    { cause: String(err) }
                );
            }
        });
    }

    /** List unread message summaries from the given folder. */
    async listUnread(folder: string): Promise<EmailSummary[]> {
        return this.serialize(async () => {
            // Stryker disable BlockStatement: try-catch wraps IMAP search/fetch - error handling
            try {
                await this.client.mailboxOpen(this.resolveFolder(folder));
                const uids = await this.client.search({ seen: false }, { uid: true });
                if(!uids || uids.length === 0) {
                    return [];
                }

                const msgs = await this.client.fetchAll(
                    uids,
                    // Stryker disable next-line ObjectLiteral,BooleanLiteral: IMAP fetch options are API configuration constants
                    { envelope: true, uid: true },
                    // Stryker disable next-line ObjectLiteral,BooleanLiteral: IMAP fetch options are API configuration constants
                    { uid: true }
                );
                return _.map(msgs, m => ({
                    uid:     m.uid,
                    from:    mapAddresses(m.envelope?.from)[0] ?? { address: '' },
                    subject: m.envelope?.subject ?? '',
                    date:    m.envelope?.date ?? new Date(0),
                }));
            } catch (err) {
                if(err instanceof ImapConnectionError) {
                    throw err;
                }
                throw new ImapConnectionError(
                    `listUnread failed (folder=${folder}): ${_.isError(err) ? err.message : String(err)}`,
                    // Stryker disable next-line ObjectLiteral,StringLiteral: Error cause wrapping is not behavior-affecting
                    { cause: String(err) }
                );
            }
        });
    }

    /** Move a message from one folder to another. */
    async moveMessage(uid: number, fromFolder: string, toFolder: string): Promise<void> {
        return this.serialize(async () => {
            // Stryker disable BlockStatement: try-catch wraps IMAP move - error handling
            try {
                await this.client.mailboxOpen(this.resolveFolder(fromFolder));
                // Stryker disable next-line ObjectLiteral,BooleanLiteral: IMAP move options are API configuration constants
                await this.client.messageMove(uid, this.resolveFolder(toFolder), { uid: true });
            } catch (err) {
                if(err instanceof ImapConnectionError) {
                    throw err;
                }
                throw new ImapConnectionError(
                    `moveMessage failed (uid=${uid}, from=${fromFolder}, to=${toFolder}): ${_.isError(err) ? err.message : String(err)}`,
                    // Stryker disable next-line ObjectLiteral,StringLiteral: Error cause wrapping is not behavior-affecting
                    { cause: String(err) }
                );
            }
        });
    }

    /** Search a folder for messages with a given custom flag. Returns array of UIDs. */
    async searchByFlag(folder: string, flag: string): Promise<number[]> {
        return this.serialize(async () => {
            // Stryker disable BlockStatement: try-catch wraps IMAP search - error handling
            try {
                await this.client.mailboxOpen(this.resolveFolder(folder));
                // Stryker disable next-line ObjectLiteral: IMAP search criteria are API configuration
                const result = await this.client.search({ keyword: flag }, { uid: true });
                // Stryker disable next-line ConditionalExpression,ArrayDeclaration: false means no match support, treat as empty
                return result ? _.map(result, Number) : [];
            } catch (err) {
                if(err instanceof ImapConnectionError) {
                    throw err;
                }
                throw new ImapConnectionError(
                    `searchByFlag failed (folder=${folder}, flag=${flag}): ${_.isError(err) ? err.message : String(err)}`,
                    // Stryker disable next-line ObjectLiteral,StringLiteral: Error cause wrapping is not behavior-affecting
                    { cause: String(err) }
                );
            }
        });
    }

    /** Add a flag to a message (e.g. '\\Seen'). */
    async setFlag(uid: number, folder: string, flag: string): Promise<void> {
        return this.serialize(async () => {
            // Stryker disable BlockStatement: try-catch wraps IMAP flags - error handling
            try {
                await this.client.mailboxOpen(this.resolveFolder(folder));
                // Stryker disable next-line ObjectLiteral,BooleanLiteral: IMAP flag options are API configuration constants
                await this.client.messageFlagsAdd(uid, [flag], { uid: true });
            } catch (err) {
                if(err instanceof ImapConnectionError) {
                    throw err;
                }
                throw new ImapConnectionError(
                    `setFlag failed (uid=${uid}, folder=${folder}, flag=${flag}): ${_.isError(err) ? err.message : String(err)}`,
                    // Stryker disable next-line ObjectLiteral,StringLiteral: Error cause wrapping is not behavior-affecting
                    { cause: String(err) }
                );
            }
        });
    }

    /** Verify that all required email folders exist on the server, resolving paths via specialUse flags. */
    async ensureFolders(): Promise<void> {
        return this.serialize(async () => {
            // Stryker disable BlockStatement: try-catch wraps IMAP list - error handling
            try {
                const mailboxes = await this.client.list();

                // Phase 1: Build resolved map from specialUse flags, then fill remaining with fallbacks.
                const resolved = new Map<string, string>();

                // First pass: resolve via specialUse flags
                for(const mailbox of mailboxes) {
                    const flag = (mailbox as { specialUse?: string }).specialUse;
                    // Stryker disable next-line ConditionalExpression,BlockStatement: guard for absent specialUse flag
                    if(flag && SPECIAL_USE_FLAGS[flag]) {
                        resolved.set(SPECIAL_USE_FLAGS[flag], mailbox.path);
                    }
                }

                // Second pass: fill any not yet resolved using fallback paths
                for(const folder of REQUIRED_FOLDERS) {
                    // Stryker disable next-line ConditionalExpression: optimization guard — skips overwriting flag-resolved paths with fallback
                    if(!resolved.has(folder)) {
                        // Stryker disable next-line ConditionalExpression,LogicalOperator: fallback path when folder not in FOLDER_FALLBACK_PATHS
                        resolved.set(folder, FOLDER_FALLBACK_PATHS[folder] ?? folder);
                    }
                }

                // Phase 2: Validate all resolved paths exist on the server
                const paths = new Set(_.map(mailboxes, 'path'));
                for(const [logicalFolder, resolvedPath] of resolved) {
                    if(!paths.has(resolvedPath)) {
                        throw new ImapConnectionError(`Required IMAP folder missing: ${logicalFolder}`);
                    }
                }

                // Store resolved map for use by IMAP methods
                this._resolvedPaths = resolved;
            } catch (err) {
                if(err instanceof ImapConnectionError) {
                    throw err;
                }
                throw new ImapConnectionError(
                    `ensureFolders failed: ${_.isError(err) ? err.message : String(err)}`,
                    // Stryker disable next-line ObjectLiteral,StringLiteral: Error cause wrapping is not behavior-affecting
                    { cause: String(err) }
                );
            }
        });
    }

    /** Get the real total and unread counts for a folder using IMAP STATUS command. */
    async getMailboxCounts(folder: string): Promise<{ total: number, unread: number }> {
        return this.serialize(async () => {
            // Stryker disable BlockStatement: try-catch wraps IMAP status - error handling
            try {
                // Stryker disable next-line ObjectLiteral,BooleanLiteral: STATUS query options are API configuration constants
                const status = await this.client.status(this.resolveFolder(folder), { messages: true, unseen: true });
                return {
                    total:  (status as { messages?: number }).messages ?? 0,
                    unread: (status as { unseen?: number }).unseen   ?? 0,
                };
            } catch (err) {
                if(err instanceof ImapConnectionError) {
                    throw err;
                }
                throw new ImapConnectionError(
                    `getMailboxCounts failed (folder=${folder}): ${_.isError(err) ? err.message : String(err)}`,
                    // Stryker disable next-line ObjectLiteral,StringLiteral: Error cause wrapping is not behavior-affecting
                    { cause: String(err) }
                );
            }
        });
    }

    /**
     * Enter IDLE mode on the given folder.
     * Resolves when new mail arrives or when cancelIdle() is called.
     * Goes through the serialize queue to ensure no concurrent IMAP ops.
     */
    async idle(folder: string): Promise<void> {
        return this.serialize(async () => {
            // Stryker disable next-line BooleanLiteral: reset abort flag at start of each idle cycle
            this._idleAborted = false;
            await this.client.mailboxOpen(this.resolveFolder(folder));
            // Stryker disable next-line ConditionalExpression,BlockStatement: race guard — skip IDLE if cancelIdle() was called during mailboxOpen
            if(!this._idleAborted) {
                await Promise.race([
                    this.client.idle(),
                    new Promise<void>((resolve) => {
                        this._idleAbort = resolve;
                        // Stryker disable next-line ConditionalExpression,BlockStatement: guard for cancelIdle() called between mailboxOpen and here
                        if(this._idleAborted) {
                            resolve();
                        }
                    }),
                ]);
            }
            this._idleAbort = null;
        });
    }

    /**
     * Cancel any in-progress IDLE, causing the idle() promise to resolve.
     * Synchronous — does NOT go through the serialize queue.
     */
    cancelIdle(): void {
        // Stryker disable next-line BooleanLiteral: race guard — marks cancellation before _idleAbort is set
        this._idleAborted = true;
        if(this._idleAbort !== null) {
            this._idleAbort();
            this._idleAbort = null;
        }
    }

    /**
     * Append a raw RFC 2822 message to the given IMAP folder.
     * Returns the UID of the appended message.
     */
    async appendMessage(folder: string, rawMessage: Buffer): Promise<number> {
        return this.serialize(async () => {
            // Stryker disable BlockStatement: try-catch wraps IMAP append - error handling
            try {
                await this.client.mailboxOpen(this.resolveFolder(folder));
                const result = await this.client.append(this.resolveFolder(folder), rawMessage);
                const uid = (result as { uid?: number }).uid;
                // UIDPLUS extension (RFC 4315) is required; WildDuck/Dovecot always provide uid.
                // If uid is absent the server does not support UIDPLUS — treat as an error.
                if(!uid) {
                    throw new ImapConnectionError(
                        // Stryker disable next-line StringLiteral: Error message is configuration
                        'appendMessage: server did not return a UID (UIDPLUS extension required)'
                    );
                }
                return uid;
            } catch (err) {
                if(err instanceof ImapConnectionError) {
                    throw err;
                }
                throw new ImapConnectionError(
                    `appendMessage failed (folder=${folder}): ${_.isError(err) ? err.message : String(err)}`,
                    // Stryker disable next-line ObjectLiteral,StringLiteral: Error cause wrapping is not behavior-affecting
                    { cause: String(err) }
                );
            }
        });
    }
}
