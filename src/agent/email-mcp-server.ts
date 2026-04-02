import { createHash } from 'node:crypto';
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '@hughescr/logger';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { chain } from 'lodash-es';
import { z } from 'zod';
import { mcpErrorResult, mcpTextResult, checkServiceHealth, checkWriteServiceHealth } from './mcp-helpers';
import { EmailFolder, type WildDuckClient, type WildDuckAttachment, type WildDuckAttachmentMeta, type SendRateLimiter, type EmailAllowlist  } from '@/integrations/email';
import type { ServiceHealthRegistry, ReconnectionLoop } from '@/services';
import { sanitizeFilename, deduplicateFilename, processLocalVideo, createSpawnRunner, createBinarySpawnRunner } from '@/utils';
/**
 * Format an email address for display to Claude in MCP tool responses.
 * WARNING: NOT RFC 2822 compliant — does NOT quote or escape special characters in names.
 * MUST NOT be used to construct addresses for To:, Cc:, or any outgoing email field.
 * For AI-readable display only.
 */
// Stryker disable next-line ConditionalExpression,StringLiteral: all branches tested via getEmailContent/replyToEmail/checkInbox tests
function formatAddressForDisplay(addr: { name?: string, address: string }): string {
    return addr.name ? `${addr.name} <${addr.address}>` : addr.address;
}

// Regex for Mailbox:UID format — e.g., "CleanInbox:42", "Sent Mail:7", "INBOX.Sub:15"
// Allows any non-empty mailbox name (including spaces, dots, slashes) followed by colon and digits.
// Stryker disable next-line Regex,StringLiteral: Regex pattern is a configuration constant for parsing
const MAILBOX_UID_REGEX = /^.+:\d+$/;

// Regex for Drafts:UID format — used for draft management tools
// Stryker disable next-line Regex,StringLiteral: Regex pattern is a configuration constant for parsing
const DRAFTS_UID_REGEX = /^Drafts:\d+$/;

/**
 * Mailboxes accessible directly by the agent without admin review.
 */
// Stryker disable next-line ArrayDeclaration: Allowlist is configuration
const ACCESSIBLE_MAILBOXES: ReadonlySet<string> = new Set([EmailFolder.CleanInbox, EmailFolder.Archive]);

/**
 * Mailboxes readable by getEmailContent (superset of ACCESSIBLE_MAILBOXES: also includes Drafts and Sent Mail).
 */
// Stryker disable next-line ArrayDeclaration: Readable mailboxes are configuration
const READABLE_MAILBOXES: ReadonlySet<string> = new Set([EmailFolder.CleanInbox, EmailFolder.Archive, EmailFolder.Drafts, EmailFolder.Sent]);

/**
 * Parse a Mailbox:UID string into its mailbox name and numeric UID.
 * Assumes the string has already been validated against MAILBOX_UID_REGEX.
 */
function parseMailboxUid(message: string): { mailboxName: string, uid: number } {
    const colonIdx = message.lastIndexOf(':');
    const mailboxName = message.slice(0, colonIdx);
    const uid = Number.parseInt(message.slice(colonIdx + 1), 10);
    return { mailboxName, uid };
}

export interface RestrictedMailboxNotification {
    mailboxName: string
    uid:         number
    reference:   string
}

export interface EmailMCPServerOptions {
    /** Optional callback to send an admin notification (e.g., Discord channel message) */
    sendAdminNotification?: (params: RestrictedMailboxNotification) => Promise<void>
    /** WildDuck HTTP client for email search and sending */
    wildDuckClient:         WildDuckClient
    /** Optional rate limiter for outbound email sends */
    rateLimiter?:           SendRateLimiter
    /** Optional email allowlist for outbound recipient gating */
    allowlist?:             EmailAllowlist
    /** Optional callback to send outbound approval request to admin */
    sendApprovalRequest?:   (to: string, subject: string, draftUid: number, cc?: string[]) => Promise<void>
    /** Optional service health registry for fast-fail guards */
    healthRegistry?:        ServiceHealthRegistry
    /** Optional reconnection loop to trigger on health check failure */
    reconnectionLoop?:      ReconnectionLoop
}

// Stryker disable ObjectLiteral,StringLiteral: MIME type map is a configuration constant
const MIME_TYPE_MAP: Readonly<Record<string, string>> = {
    pdf:  'application/pdf',
    doc:  'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls:  'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt:  'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt:  'text/plain',
    csv:  'text/csv',
    html: 'text/html',
    htm:  'text/html',
    xml:  'application/xml',
    json: 'application/json',
    zip:  'application/zip',
    tar:  'application/x-tar',
    gz:   'application/gzip',
    png:  'image/png',
    jpg:  'image/jpeg',
    jpeg: 'image/jpeg',
    gif:  'image/gif',
    webp: 'image/webp',
    svg:  'image/svg+xml',
    mp4:  'video/mp4',
    mp3:  'audio/mpeg',
    wav:  'audio/wav',
};
// Stryker restore ObjectLiteral,StringLiteral

/**
 * Build WildDuck attachments from file paths (disk I/O — untestable, Stryker disabled).
 */
// Stryker disable all
async function buildAttachments(filePaths: string[]): Promise<WildDuckAttachment[]> {
    const { readFile } = await import('node:fs/promises');

    const result: WildDuckAttachment[] = [];
    for(const filePath of filePaths) {
        let data: Buffer;
        try {
            // eslint-disable-next-line no-await-in-loop -- sequential: filesystem I/O, stop on first error
            data = await readFile(filePath);
        } catch{
            throw new Error(`Attachment file not found: ${filePath}`);
        }
        const filename    = path.basename(filePath);
        const ext         = path.extname(filePath).toLowerCase().slice(1);
        // Stryker disable next-line StringLiteral: fallback MIME type is specification constant
        const contentType = MIME_TYPE_MAP[ext] ?? 'application/octet-stream';
        result.push({ filename, contentType, content: data.toString('base64') });
    }
    return result;
}
// Stryker restore all

/**
 * Save email attachments to disk (lazy-fetch from WildDuck, keyed by sha1 of messageId).
 * Returns lines suitable for appending to the email content display.
 */
// Stryker disable all
// eslint-disable-next-line sonarjs/cognitive-complexity -- video processing branch adds necessary branching; function handles distinct attachment type paths
async function saveEmailAttachments(
    wildDuckClient: WildDuckClient,
    mailboxName:    string,
    uid:            number,
    messageId:      string,
    attachmentMeta: WildDuckAttachmentMeta[]
): Promise<string[]> {
    if(attachmentMeta.length === 0) {
        return [];
    }
    // eslint-disable-next-line sonarjs/hashing -- sha1 used only to derive a unique directory name from message ID, not for security or integrity
    const hash          = createHash('sha1').update(messageId).digest('hex');
    const attachmentDir = path.join(process.cwd(), 'attachments', `email-${hash}`);
    const usedFilenames = new Set<string>();
    const attachmentLines: string[] = [];
    for(const meta of attachmentMeta) {
        const safeBase     = sanitizeFilename(meta.filename);
        const safeFilename = deduplicateFilename(safeBase, usedFilenames);
        usedFilenames.add(safeFilename);
        const filePath = path.join(attachmentDir, safeFilename);
        try {
            let fileExists = false;
            try {
                // eslint-disable-next-line no-await-in-loop -- sequential: filesystem check before conditional write
                await access(filePath);
                fileExists = true;
            } catch{
                fileExists = false;
            }
            if(!fileExists) {
                // eslint-disable-next-line no-await-in-loop -- sequential: mkdir then fetch then write in order
                await mkdir(attachmentDir, { recursive: true });
                // eslint-disable-next-line no-await-in-loop -- sequential: rate-limited WildDuck API
                const data = await wildDuckClient.getAttachment(mailboxName, uid, meta.id);
                // eslint-disable-next-line no-await-in-loop -- sequential: write depends on prior fetch result
                await writeFile(filePath, data);
            }
            if(meta.contentType.startsWith('video/')) {
                try {
                    const videoOutputDir = path.join(attachmentDir, `video-${safeFilename}`);
                    // eslint-disable-next-line no-await-in-loop -- sequential: video processing per attachment
                    const videoResult = await processLocalVideo(filePath, videoOutputDir, {
                        run:       createSpawnRunner(),
                        binaryRun: createBinarySpawnRunner(),
                    });
                    attachmentLines.push(`- Video: ${safeFilename} — ${videoResult.metadataMarkdown}`);
                    for(const frame of videoResult.frames) {
                        attachmentLines.push(`  - Frame: ${videoOutputDir}/${frame.filename}`);
                    }
                    continue; // Skip the generic attachment line
                } catch (videoError) {
                    logger.warn({ error: videoError instanceof Error ? videoError.message : String(videoError), filename: safeFilename, msg: 'Video processing failed, using generic attachment reference' });
                    // Fall through to generic attachment line on video processing failure
                }
            }
            attachmentLines.push(`- attachments/email-${hash}/${safeFilename} (${meta.contentType})`);
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            logger.warn({ error: errMsg, filename: safeFilename, msg: 'Failed to save attachment (best-effort)' });
            attachmentLines.push(`- Note: could not save attachment ${safeFilename}: ${errMsg}`);
        }
    }
    return attachmentLines;
}
// Stryker restore all

/**
 * Creates an MCP server for email operations.
 *
 * Provides tools for:
 * - Checking the CleanInbox for unread messages
 * - Fetching full email content by Mailbox:UID reference and marking as read
 * - Archiving emails by moving them from their current mailbox to Archive
 *
 * Access control: getEmailContent allows CleanInbox, Archive, and Drafts.
 * Access to restricted mailboxes (Quarantine, Junk, Trash, etc.) triggers
 * an admin notification and returns an error.
 *
 * This server wraps WildDuckClient for use with the Claude Agent SDK.
 */
/**
 * Mailboxes searched when mailbox='all-regular' (or omitted).
 */
// Stryker disable next-line ArrayDeclaration: Regular search mailboxes are configuration
const REGULAR_SEARCH_MAILBOXES: readonly string[] = [EmailFolder.CleanInbox, EmailFolder.Archive];

/**
 * All mailboxes searched when mailbox='all'.
 */
// Stryker disable next-line ArrayDeclaration: All-mailboxes list is configuration
const ALL_SEARCH_MAILBOXES: readonly string[] = [
    EmailFolder.CleanInbox,
    EmailFolder.Archive,
    EmailFolder.Sent,
    EmailFolder.Drafts,
    EmailFolder.Junk,
    EmailFolder.Trash,
    EmailFolder.Quarantine,
    EmailFolder.Review,
];

/**
 * Normalizes a to-address argument (string, object, array, or undefined) to an array or undefined.
 */
// eslint-disable-next-line sonarjs/function-return-type -- legitimately returns T[] | undefined
function normalizeToAddresses<T>(to: T | T[] | undefined): T[] | undefined {
    if(to === undefined) {
        return undefined;
    }
    if(Array.isArray(to)) {
        return to;
    }
    return [to];
}

// Stryker disable ObjectLiteral,StringLiteral: emailAddressSchema is a configuration constant for address parsing
const emailAddressSchema = z.union([
    z.email(),
    z.object({
        name:          z.string(),
        email_address: z.email(),
    }),
]);
// Stryker restore ObjectLiteral,StringLiteral

export function createEmailMCPServer(options: EmailMCPServerOptions) {
    const { sendAdminNotification, wildDuckClient, rateLimiter, allowlist, sendApprovalRequest } = options;

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
        // Stryker disable next-line ConditionalExpression,BlockStatement: early return when already loaded
        if(addressesLoaded) {
            return;
        }
        // Stryker disable next-line LogicalOperator: deduplicate concurrent load calls
        // Stryker disable BlockStatement: async address loading - error handling
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
                // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                logger.warn({ err, msg: 'Failed to load WildDuck user addresses' });
                // Do NOT set addressesLoaded = true here — allow retry on next call
            } finally {
                addressLoadingPromise = null;
            }
        })();
        // Stryker restore BlockStatement
        await addressLoadingPromise;
    }

    /**
     * Load addresses and resolve the from address for the given identity.
     * Returns `{ ok: true, from }` on success, or `{ ok: false, error }` if no address is configured.
     */
    async function resolveFromAddress(identity: 'formal' | 'informal'): Promise<{ ok: true, from: { address: string, name?: string } } | { ok: false, error: CallToolResult }> {
        await loadAddresses();
        const from = identity === 'informal' ? informalAddress : formalAddress;
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
            // Stryker disable next-line StringLiteral: initial empty string for rateLimitWarning
            return '';
        }
        // Stryker disable next-line StringLiteral: Warning message is configuration
        return ` Warning: send rate limit reached (${rateLimiter.tokensRemaining()} tokens remaining).`;
    }

    /**
     * Check allowlist, submit draft immediately if allowed, or request admin approval.
     * When cc is provided (replyAll mode), always routes to approval regardless of allowlist.
     * The optional isAllowedOverride parameter allows callers to pre-compute allowlist status
     * (e.g., for multi-to sends where all recipients must be checked).
     * Returns the text content string for the tool result.
     */
    async function submitOrRequestApproval(
        draftUid: number,
        toAddress: string,
        subject: string,
        rateLimitWarning: string,
        successMessage: string,
        cc?: string[],
        isAllowedOverride?: boolean
    ): Promise<string> {
        // Stryker disable next-line ConditionalExpression,EqualityOperator,BooleanLiteral: isAllowedOverride false forces approval path; ?? false default unreachable when allowlist always provided
        const isAllowed = isAllowedOverride ?? (allowlist?.isAllowed(toAddress) ?? false);

        if(isAllowed) {
            await wildDuckClient.submitMessage(EmailFolder.Drafts, draftUid);
            rateLimiter?.increment();
            // Stryker disable next-line StringLiteral: Result message is configuration
            return `${successMessage}${rateLimitWarning}`;
        }

        // Not on allowlist (or replyAll) — request admin approval
        // sendApprovalRequest uses the Discord outbox for fallback when Discord is offline,
        // so failures here are exceptional (e.g. outbox backend unavailable).
        if(sendApprovalRequest) {
            // Stryker disable BlockStatement: try-catch wraps approval request — error handling for exceptional outbox failures
            try {
                await sendApprovalRequest(toAddress, subject, draftUid, cc);
            } catch (error) {
                // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                logger.warn({ error: error instanceof Error ? error.message : String(error), msg: 'Failed to send outbound approval request' });
                // Stryker disable next-line StringLiteral: Result message is configuration
                return `Draft saved as ${EmailFolder.Drafts}:${draftUid} but failed to notify admin. Please check pending drafts manually.${rateLimitWarning}`;
            }
            // Stryker restore BlockStatement
        }

        // Stryker disable next-line StringLiteral: Result message is configuration
        return `Message saved to Drafts, pending admin approval (draft UID: ${draftUid}).${rateLimitWarning}`;
    }

    return createSdkMcpServer({
        name:    'email',
        version: '1.0.0',
        tools:   [
            // Stryker disable StringLiteral: Tool name and description are MCP server configuration
            tool(
                'checkInbox',
                'Check CleanInbox for emails. Returns counter state and message summaries. By default only unread; set showSeen to include read messages.',
                // Stryker restore StringLiteral
                // Stryker disable next-line StringLiteral: Zod schema description is MCP parameter documentation
                { showSeen: z.boolean().describe('When true, include read messages alongside unread. Defaults to false (unread only).').optional() },
                async ({ showSeen }): Promise<CallToolResult> => {
                    // Stryker disable BlockStatement: health guard delegates to tested checkServiceHealth
                    if(options.healthRegistry) {
                        const healthCheck = checkServiceHealth(options.healthRegistry, 'email', options.reconnectionLoop);
                        if(healthCheck) {
                            return healthCheck;
                        }
                    }
                    // Stryker restore BlockStatement
                    // Stryker disable BlockStatement: try-catch wraps WildDuck operations - error handling
                    try {
                        const [countsData, messages] = await Promise.all([
                            wildDuckClient.getMailboxCounts(EmailFolder.CleanInbox),
                            // Stryker disable next-line StringLiteral,ObjectLiteral: EmailFolder.CleanInbox is configuration constant; unseen filter is configuration
                            wildDuckClient.listMessages(EmailFolder.CleanInbox, { unseen: !showSeen }),
                        ]);
                        const result = {
                            counters: { total: countsData.total, unread: countsData.unseen },
                            messages: messages.map(m => ({
                                // Stryker disable next-line StringLiteral: MailboxName is configuration constant
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
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                        logger.warn({ error: message, msg: 'Failed to check inbox' });
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral: Tool annotations are MCP server configuration
                { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }
            ),

            // Stryker disable StringLiteral: Tool name and description are MCP server configuration
            tool(
                'getEmailContent',
                'Fetch the full content of an email by UID. Marks the email as read.',
                // Stryker restore StringLiteral
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    message: z.string().regex(MAILBOX_UID_REGEX, 'Must be in MailboxName:UID format (e.g., CleanInbox:42)').describe('The email reference in Mailbox:UID format (e.g., CleanInbox:42)'),
                },
                // eslint-disable-next-line sonarjs/cognitive-complexity -- MCP tool handler validates access, fetches email, saves attachments, and formats output; branching is inherent to the multi-step protocol
                async (args): Promise<CallToolResult> => {
                    // Stryker disable BlockStatement: health guard delegates to tested checkServiceHealth
                    if(options.healthRegistry) {
                        const healthCheck = checkServiceHealth(options.healthRegistry, 'email', options.reconnectionLoop);
                        if(healthCheck) {
                            return healthCheck;
                        }
                    }
                    // Stryker restore BlockStatement
                    // Stryker disable BlockStatement: try-catch wraps WildDuck operations - error handling
                    try {
                        const { mailboxName, uid } = parseMailboxUid(args.message);

                        // Access control: CleanInbox, Archive, Drafts, and Sent Mail are directly readable
                        if(!READABLE_MAILBOXES.has(mailboxName)) {
                            // Send admin notification (fire-and-forget)
                            if(sendAdminNotification) {
                                // Stryker disable BlockStatement: try-catch guards notification failure from breaking access control response
                                try {
                                    // Stryker disable next-line ObjectLiteral: Notification params are configuration
                                    await sendAdminNotification({ mailboxName, uid, reference: args.message });
                                } catch (error) {
                                    // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                                    logger.warn({ error: error instanceof Error ? error.message : String(error), msg: 'Failed to send restricted mailbox notification' });
                                }
                                // Stryker restore BlockStatement
                            }
                            // Stryker disable next-line StringLiteral: Error message is configuration
                            return {
                                content: [{ type: 'text' as const, text: `Access to ${mailboxName} requires admin review. A notification has been sent to #admin.` }],
                                isError: true,
                            };
                        }

                        const email = await wildDuckClient.getFullMessage(mailboxName, uid);
                        if(!email) {
                            return {
                                // Stryker disable next-line StringLiteral: Error message is configuration
                                content: [{ type: 'text' as const, text: `Email ${args.message} not found.` }],
                                isError: true,
                            };
                        }
                        // Stryker disable next-line StringLiteral,ObjectLiteral: flag name and options are configuration constants
                        await wildDuckClient.updateMessageFlags(mailboxName, uid, { addFlags: [String.raw`\Seen`] });

                        // Lazy-fetch and save attachments to disk (keyed by sha1 of messageId).
                        // Message-ID is always present: RFC 5322 requires MDAs to add one if missing,
                        // and our Haraka/WildDuck stack guarantees it.
                        const attachmentLines = await saveEmailAttachments(wildDuckClient, mailboxName, uid, email.messageId, email.attachmentMeta);

                        const toList = email.to.map(addr => formatAddressForDisplay(addr)).join(', ');
                        const lines = ([
                            `From: ${formatAddressForDisplay(email.from)}`,
                            `To: ${toList}`,
                            email.cc.length > 0 ? `Cc: ${email.cc.map(addr => formatAddressForDisplay(addr)).join(', ')}` : undefined,
                            `Subject: ${email.subject}`,
                            `Date: ${email.date.toISOString()}`,
                            '',
                            email.bodyText,
                            // Stryker disable next-line ConditionalExpression,BlockStatement,ArrayDeclaration: attachment section only added when there are attachments
                            ...(attachmentLines.length > 0 ? ['\nAttachments:', ...attachmentLines] : []),
                        ]).filter(line => line !== undefined);
                        // Stryker disable next-line Regex,StringLiteral: /^\n/ and '' are defensive no-ops — the text always starts with 'From:' so the regex never matches; .trim() on the next line also covers any edge case
                        const text = lines.join('\n').replace(/^\n/, '');
                        // Stryker disable MethodExpression: trim() is defensive — lines.join() produces clean text starting with 'From:' header
                        return mcpTextResult(text.trim());
                        // Stryker restore MethodExpression
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                        logger.warn({ error: message, message: args.message, msg: 'Failed to fetch email content' });
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral: Tool annotations are MCP server configuration
                { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }
            ),

            // Stryker disable StringLiteral: Tool name and description are MCP server configuration
            tool(
                'archiveEmail',
                'Move an email from CleanInbox to Archive.',
                // Stryker restore StringLiteral
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    message: z.string().regex(MAILBOX_UID_REGEX, 'Must be in MailboxName:UID format (e.g., CleanInbox:42)').describe('The email reference in Mailbox:UID format (e.g., CleanInbox:42)'),
                },
                async (args): Promise<CallToolResult> => {
                    // Stryker disable BlockStatement: health guard delegates to tested checkServiceHealth
                    if(options.healthRegistry) {
                        const healthCheck = checkServiceHealth(options.healthRegistry, 'email', options.reconnectionLoop);
                        if(healthCheck) {
                            return healthCheck;
                        }
                    }
                    // Stryker restore BlockStatement
                    // Stryker disable BlockStatement: try-catch wraps WildDuck operations - error handling
                    try {
                        const { mailboxName, uid } = parseMailboxUid(args.message);

                        // Access control: only CleanInbox and Archive are directly accessible
                        if(!ACCESSIBLE_MAILBOXES.has(mailboxName)) {
                            return {
                                // Stryker disable next-line StringLiteral: Error message is configuration
                                content: [{ type: 'text' as const, text: `Access denied: cannot archive messages in ${mailboxName}. Restricted mailboxes require admin review.` }],
                                isError: true,
                            };
                        }

                        // Stryker disable next-line StringLiteral: EmailFolder values are configuration constants
                        await wildDuckClient.moveMessage(mailboxName, uid, EmailFolder.Archive);
                        return mcpTextResult(`Email UID ${uid} archived successfully.`);
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                        logger.warn({ error: message, message: args.message, msg: 'Failed to archive email' });
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral: Tool annotations are MCP server configuration
                { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }
            ),

            // Stryker disable StringLiteral: Tool name and description are MCP server configuration
            tool(
                'searchEmail',
                'Search emails across mailboxes using WildDuck API',
                // Stryker restore StringLiteral
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    correspondent: z.string().describe('Search From, To, Cc, Bcc fields').optional(),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    content:       z.string().describe('Search Subject and body text').optional(),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    before:        z.string().describe('ISO date - return emails before this date').optional(),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    since:         z.string().describe('ISO date - return emails since this date').optional(),
                    // Stryker disable StringLiteral: describe() calls are documentation only
                    header:        z.object({
                        name:  z.string().describe('Header name'),
                        value: z.string().describe('Header value'),
                    }).describe('Search by specific header value').optional(),
                    // Stryker restore StringLiteral
                    // Stryker disable StringLiteral,ArrayDeclaration: mailbox schema — literals/describe are configuration
                    mailbox: z.union([
                        z.literal('all-regular'),
                        z.literal('all'),
                        z.enum([
                            EmailFolder.CleanInbox, EmailFolder.Archive, EmailFolder.Review,
                            EmailFolder.Quarantine, EmailFolder.Junk, EmailFolder.Trash,
                            EmailFolder.Drafts, EmailFolder.Sent,
                        ]),
                    ]).optional().describe("Mailbox scope. 'all-regular' = CleanInbox+Archive (default). 'all' = every folder. Or a specific folder name."),
                    // Stryker restore StringLiteral,ArrayDeclaration
                },
                async (args): Promise<CallToolResult> => {
                    // Stryker disable BlockStatement: health guard delegates to tested checkServiceHealth
                    if(options.healthRegistry) {
                        const healthCheck = checkServiceHealth(options.healthRegistry, 'email', options.reconnectionLoop);
                        if(healthCheck) {
                            return healthCheck;
                        }
                    }
                    // Stryker restore BlockStatement
                    // Stryker disable BlockStatement: try-catch wraps WildDuck API operations - error handling
                    try {
                        // Determine which mailboxes to search
                        let mailboxes: string[];
                        if(!args.mailbox || args.mailbox === 'all-regular') {
                            mailboxes = [...REGULAR_SEARCH_MAILBOXES];
                        } else if(args.mailbox === 'all') {
                            mailboxes = [...ALL_SEARCH_MAILBOXES];
                        } else {
                            mailboxes = [args.mailbox];
                        }

                        const results = await wildDuckClient.search({
                            query: {
                                correspondent: args.correspondent,
                                content:       args.content,
                                before:        args.before,
                                since:         args.since,
                                header:        args.header,
                            },
                            mailboxes,
                        });

                        // Stryker disable next-line ConditionalExpression,StringLiteral: empty results vs found results
                        if(results.length === 0) {
                            return {
                                // Stryker disable next-line StringLiteral: Result message is configuration
                                content: [{ type: 'text' as const, text: 'No emails found matching your search criteria.' }],
                            };
                        }

                        const lines = [
                            // Stryker disable next-line StringLiteral: Result format is configuration
                            `Found ${results.length} email${results.length === 1 ? '' : 's'}:`,
                            ...results.map((r) => {
                                const toStr = r.to.length > 0 ? r.to.join(', ') : '(none)';
                                // Stryker disable next-line StringLiteral: Result line format is configuration
                                return `- ${r.message} | From: ${r.from} | To: ${toStr} | Subject: ${r.subject} | Date: ${r.date}`;
                            }),
                        ];

                        return mcpTextResult(lines.join('\n'));
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                        logger.warn({ error: message, msg: 'Failed to search emails' });
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral: Tool annotations are MCP server configuration
                { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }
            ),

            // Stryker disable StringLiteral: Tool name and description are MCP server configuration
            tool(
                'sendEmail',
                'Send an outbound email. If all recipients are on the allowlist, sends immediately. Otherwise, saves to Drafts and requests admin approval via Discord.',
                // Stryker restore StringLiteral
                {
                    // Stryker disable StringLiteral,ObjectLiteral: emailAddressSchema is a configuration constant for address parsing
                    to: z.union([emailAddressSchema, z.array(emailAddressSchema).min(1)])
                        // Stryker disable next-line StringLiteral: describe() is documentation only
                        .describe('Recipient email: plain address string or {name, email_address} object, or array of either'),
                    // Stryker restore StringLiteral,ObjectLiteral
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    subject:     z.string().describe('Email subject'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    body:        z.string().describe('Email body text'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    identity:    z.enum(['formal', 'informal']).default('formal').describe('From identity: formal or informal'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    attachments: z.array(z.string()).optional().describe('File paths to attach'),
                },
                async (args): Promise<CallToolResult> => {
                    // Stryker disable BlockStatement: health guard delegates to tested checkWriteServiceHealth
                    if(options.healthRegistry) {
                        const healthCheck = checkWriteServiceHealth(options.healthRegistry, 'email', 'discord', options.reconnectionLoop);
                        if(healthCheck) {
                            return healthCheck;
                        }
                    }
                    // Stryker restore BlockStatement
                    // Stryker disable BlockStatement: try-catch wraps send operations - error handling
                    try {
                        // Resolve from address based on identity (loads addresses lazily)
                        const fromResult = await resolveFromAddress(args.identity);
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

                        // Build attachments from file paths (Stryker disabled — disk I/O)
                        const attachments = await buildAttachments(args.attachments ?? []);

                        // Upload to Drafts
                        const uid = await wildDuckClient.uploadMessage(EmailFolder.Drafts, {
                            from,
                            to:      toAddresses,
                            subject: args.subject,
                            text:    args.body,
                            // Stryker disable next-line ConditionalExpression,EqualityOperator,ObjectLiteral: attachments array inclusion guard
                            ...(attachments.length > 0 ? { attachments } : {}),
                            draft:   true,
                        });

                        // Fast-path only when ALL recipients are allowlisted (cc is undefined for sendEmail)
                        // Stryker disable next-line BooleanLiteral: ?? false unreachable when allowlist always provided
                        const isAllAllowed = toAddresses.every(addr => allowlist?.isAllowed(addr.address) ?? false);
                        const toStr        = toAddresses.map(addr => addr.address).join(', ');
                        const text         = await submitOrRequestApproval(uid, toStr, args.subject, rateLimitWarning, 'Sent successfully.', undefined, isAllAllowed);
                        return mcpTextResult(text);
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                        logger.warn({ error: message, to: args.to, msg: 'Failed to send email' });
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } }
            ),

            // Stryker disable StringLiteral: Tool name and description are MCP server configuration
            tool(
                'replyToEmail',
                'Reply to an existing email. If recipient is on the allowlist, sends immediately. Otherwise, saves to Drafts for admin approval.',
                // Stryker restore StringLiteral
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    message:     z.string().regex(MAILBOX_UID_REGEX, 'Must be in MailboxName:UID format (e.g., CleanInbox:42)').describe('The email reference in Mailbox:UID format to reply to'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    body:        z.string().describe('Reply body text'),
                    // Stryker disable next-line StringLiteral,ArrayDeclaration: describe() is documentation only
                    mode:        z.enum(['reply', 'replyAll']).describe('Reply mode: reply to sender only, or reply-all'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    identity:    z.enum(['formal', 'informal']).default('formal').describe('From identity: formal or informal'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    attachments: z.array(z.string()).optional().describe('File paths to attach'),
                },
                // eslint-disable-next-line complexity -- replyToEmail handler has inherent branching for access control, rate limiting, and replyAll logic
                async (args): Promise<CallToolResult> => {
                    // Stryker disable BlockStatement: health guard delegates to tested checkWriteServiceHealth
                    if(options.healthRegistry) {
                        const healthCheck = checkWriteServiceHealth(options.healthRegistry, 'email', 'discord', options.reconnectionLoop);
                        if(healthCheck) {
                            return healthCheck;
                        }
                    }
                    // Stryker restore BlockStatement
                    // Stryker disable BlockStatement: try-catch wraps reply operations - error handling
                    try {
                        // Resolve from address based on identity (loads addresses lazily)
                        const fromResult = await resolveFromAddress(args.identity);
                        if(!fromResult.ok) {
                            return fromResult.error;
                        }
                        const from = fromResult.from;

                        const { mailboxName, uid: originalUid } = parseMailboxUid(args.message);

                        // Access control: only CleanInbox and Archive are directly accessible
                        if(!ACCESSIBLE_MAILBOXES.has(mailboxName)) {
                            return {
                                // Stryker disable next-line StringLiteral: Error message is configuration
                                content: [{ type: 'text' as const, text: `Access denied: cannot reply to messages in ${mailboxName}. Restricted mailboxes require admin review.` }],
                                isError: true,
                            };
                        }

                        // Fetch original message from WildDuck to get pre-parsed sender address fields
                        const original = await wildDuckClient.getMessage(mailboxName, originalUid);
                        if(!original) {
                            return {
                                // Stryker disable next-line StringLiteral: Error message is configuration
                                content: [{ type: 'text' as const, text: `Cannot reply: message '${args.message}' not found.` }],
                                isError: true,
                            };
                        }

                        // Determine recipient address for allowlist check using WildDuck pre-parsed fields.
                        // Prefer replyTo address; fall back to from address.
                        // Stryker disable next-line ConditionalExpression,StringLiteral: replyTo presence determines address source; ?? '' is defensive fallback when from absent (impossible in practice)
                        const primaryTo = original.replyTo?.address ?? original.from?.address ?? '';

                        // Check rate limit — warn but don't block
                        const rateLimitWarning = buildRateLimitWarning();

                        // Resolve WildDuck mailbox ID for the reference object
                        const mailboxWildDuckId = wildDuckClient.getMailboxId(mailboxName);
                        if(!mailboxWildDuckId) {
                            return {
                                // Stryker disable next-line StringLiteral: error message is UI configuration
                                content: [{ type: 'text' as const, text: `Cannot reply: mailbox '${mailboxName}' not found in WildDuck. Reconnect or try again.` }],
                                isError: true,
                            };
                        }

                        // Build attachments from file paths (Stryker disabled — disk I/O)
                        const attachments = await buildAttachments(args.attachments ?? []);

                        // Upload to Drafts with WildDuck reference for threading.
                        // WildDuck derives all recipients (To, Cc) from the reference object automatically.
                        const uid = await wildDuckClient.uploadMessage(EmailFolder.Drafts, {
                            from,
                            // Stryker disable next-line StringLiteral,LogicalOperator: Re: prefix is RFC 5322 reply subject convention; ?? '' is defensive fallback when subject absent
                            subject:   `Re: ${original.subject ?? ''}`,
                            text:      args.body,
                            reference: {
                                action:  args.mode === 'replyAll' ? 'replyAll' : 'reply',
                                mailbox: mailboxWildDuckId,
                                id:      originalUid,
                            },
                            // Stryker disable next-line ConditionalExpression,EqualityOperator,ObjectLiteral: attachments array inclusion guard
                            ...(attachments.length > 0 ? { attachments } : {}),
                            draft: true,
                        });

                        // For replyAll, always require admin approval (isAllowedOverride = false).
                        // For plain reply, check allowlist for primary recipient.
                        const isAllowedOverride: boolean | undefined = args.mode === 'replyAll' ? false : undefined;
                        const ccAddresses = args.mode === 'replyAll'
                            ? chain(original.cc ?? []).map('address').compact().value()
                            : undefined;
                        // Stryker disable next-line StringLiteral,LogicalOperator: Result message is configuration; ?? '' is defensive fallback when subject absent
                        const text = await submitOrRequestApproval(uid, primaryTo, `Re: ${original.subject ?? ''}`, rateLimitWarning, `Reply sent to ${primaryTo}.`, ccAddresses, isAllowedOverride);
                        return mcpTextResult(text);
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                        logger.warn({ error: message, message: args.message, msg: 'Failed to reply to email' });
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } }
            ),

            // Stryker disable StringLiteral: Tool name and description are MCP server configuration
            tool(
                'deleteDraft',
                'Delete a draft email. Only drafts in the Drafts folder can be deleted this way.',
                // Stryker restore StringLiteral
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    message: z.string().regex(DRAFTS_UID_REGEX, 'Must be in Drafts:UID format (e.g., Drafts:42)').describe('The draft to delete, in Drafts:UID format'),
                },
                async (args): Promise<CallToolResult> => {
                    // Stryker disable BlockStatement: health guard delegates to tested checkServiceHealth
                    if(options.healthRegistry) {
                        const healthCheck = checkServiceHealth(options.healthRegistry, 'email', options.reconnectionLoop);
                        if(healthCheck) {
                            return healthCheck;
                        }
                    }
                    // Stryker restore BlockStatement
                    // Stryker disable BlockStatement: try-catch wraps delete operations - error handling
                    try {
                        const { uid } = parseMailboxUid(args.message);
                        await wildDuckClient.deleteMessage(EmailFolder.Drafts, uid);
                        // Stryker disable next-line StringLiteral: Result message is configuration
                        return mcpTextResult(`Draft ${args.message} deleted.`);
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                        logger.warn({ error: message, message: args.message, msg: 'Failed to delete draft' });
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } }
            ),

            // Stryker disable StringLiteral: Tool name and description are MCP server configuration
            tool(
                'amendAndResubmitDraft',
                'Amend a rejected draft email and resubmit it for admin approval. Reads the existing draft, applies your changes, and re-uploads it (replacing the old draft atomically). A new approval request will be posted to the admin channel.',
                // Stryker restore StringLiteral
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    message:  z.string().regex(DRAFTS_UID_REGEX, 'Must be in Drafts:UID format (e.g., Drafts:42)').describe('The rejected draft to amend, in Drafts:UID format'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    subject:  z.string().optional().describe('New subject line (leave blank to keep original)'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    body:     z.string().optional().describe('New plain text body (leave blank to keep original)'),
                    // Stryker disable StringLiteral,MethodExpression,ObjectLiteral: describe() is documentation only; .min(1) is schema constraint not tested via mutation
                    to:       z.union([emailAddressSchema, z.array(emailAddressSchema).min(1)]).optional().describe('New To address(es) (leave blank to keep original)'),
                    // Stryker restore StringLiteral,MethodExpression,ObjectLiteral
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    identity: z.enum(['formal', 'informal']).optional().describe('Email identity to use (leave blank to keep original)'),
                },
                async (args): Promise<CallToolResult> => {
                    // Stryker disable BlockStatement: health guard delegates to tested checkWriteServiceHealth
                    if(options.healthRegistry) {
                        const healthCheck = checkWriteServiceHealth(options.healthRegistry, 'email', 'discord', options.reconnectionLoop);
                        if(healthCheck) {
                            return healthCheck;
                        }
                    }
                    // Stryker restore BlockStatement
                    // Stryker disable BlockStatement: try-catch wraps amend operations - error handling
                    try {
                        // Resolve from address based on identity (loads addresses lazily)
                        const fromResult = await resolveFromAddress(args.identity ?? 'formal');
                        if(!fromResult.ok) {
                            return fromResult.error;
                        }
                        const from = fromResult.from;

                        // Parse UID from 'Drafts:42'
                        const { uid } = parseMailboxUid(args.message);

                        // Fetch original draft
                        const original = await wildDuckClient.getMessage(EmailFolder.Drafts, uid);
                        if(!original) {
                            return {
                                // Stryker disable next-line StringLiteral: Error message is configuration
                                content: [{ type: 'text' as const, text: `Draft ${args.message} not found.` }],
                                isError: true,
                            };
                        }

                        // Apply amendments
                        const subject = args.subject ?? original.subject ?? '';
                        const body    = args.body ?? original.text ?? '';

                        // Normalize args.to: undefined → use original recipients; structured/plain string → array
                        const argToArr = normalizeToAddresses(args.to);
                        const argToAddresses = argToArr
                            ? argToArr.map((addr): { name?: string, address: string } => {
                                if(typeof addr === 'string') {
                                    return { address: addr };
                                }
                                return { name: addr.name, address: addr.email_address };
                            })
                            : undefined;
                        const toAddresses    = argToAddresses ?? (original.to ?? []);

                        // Re-upload with replacePrevious to atomically replace the old draft
                        const newUid = await wildDuckClient.uploadMessage(EmailFolder.Drafts, {
                            from,
                            to:              toAddresses,
                            subject,
                            text:            body,
                            replacePrevious: { mailbox: EmailFolder.Drafts, id: uid },
                            // Stryker disable next-line BooleanLiteral: draft flag is required for WildDuck draft upload
                            draft:           true,
                        });

                        // Always route through approval (isAllowedOverride=false) — amended drafts require human review.
                        const amendResult = await submitOrRequestApproval(
                            newUid,
                            // Stryker disable next-line StringLiteral: join separator is cosmetic formatting — tested via multi-recipient amend test
                            toAddresses.map(addr => addr.address).join(', '),
                            subject,
                            // Stryker disable next-line StringLiteral: empty string — no rate limit warning for amend (rate limiter not called on approval path)
                            '',
                            // Stryker disable next-line StringLiteral: empty string — successMessage is unreachable when isAllowedOverride=false always routes to approval
                            '',
                            undefined, // cc not available for amend-resubmit
                            false      // isAllowedOverride=false → always approval path
                        );
                        return mcpTextResult(amendResult);
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                        logger.warn({ error: message, message: args.message, msg: 'Failed to amend and resubmit draft' });
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } }
            ),
        ],
    });
}
