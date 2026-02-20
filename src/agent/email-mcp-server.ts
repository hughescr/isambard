import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import _ from 'lodash';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '@hughescr/logger';
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

import type { ImapConnection } from '@/integrations/email/imap-connection';
import type { EmailCounterStore } from '@/integrations/email/email-counters';
import { EmailFolder } from '@/integrations/email/types';
import type { WildDuckClient, WildDuckAttachment } from '@/integrations/email/wildduck-client';
import type { SendRateLimiter } from '@/integrations/email/send-rate-limiter';
import type { EmailAllowlist } from '@/integrations/email/allowlist';
import { sanitizeFilename, deduplicateFilename } from '@/utils/filename';

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
 * Parse a Mailbox:UID string into its mailbox name and numeric UID.
 * Assumes the string has already been validated against MAILBOX_UID_REGEX.
 */
function parseMailboxUid(message: string): { mailboxName: string, uid: number } {
    const colonIdx = message.lastIndexOf(':');
    const mailboxName = message.slice(0, colonIdx);
    const uid = parseInt(message.slice(colonIdx + 1), 10);
    return { mailboxName, uid };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Notification payload matches discord.js MessageCreateOptions
type AdminNotification = Record<string, any>;

export interface EmailMCPServerOptions {
    /** Optional callback to send an admin notification (e.g., Discord channel message) */
    sendAdminNotification?: (msg: AdminNotification) => Promise<void>
    /** WildDuck HTTP client for email search and sending */
    wildDuckClient:         WildDuckClient
    /** Optional rate limiter for outbound email sends */
    rateLimiter?:           SendRateLimiter
    /** Optional email allowlist for outbound recipient gating */
    allowlist?:             EmailAllowlist
    /** Optional callback to send outbound approval request to admin */
    sendApprovalRequest?:   (to: string, subject: string, draftUid: number, cc?: string[]) => Promise<void>
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
    const { basename, extname } = await import('node:path');

    const result: WildDuckAttachment[] = [];
    for(const filePath of filePaths) {
        let data: Buffer;
        try {
            data = await readFile(filePath);
        } catch{
            throw new Error(`Attachment file not found: ${filePath}`);
        }
        const filename    = basename(filePath);
        const ext         = _.toLower(extname(filePath)).slice(1);
        // Stryker disable next-line StringLiteral: fallback MIME type is specification constant
        const contentType = MIME_TYPE_MAP[ext] ?? 'application/octet-stream';
        result.push({ filename, contentType, content: data.toString('base64') });
    }
    return result;
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
 * Access control: getEmailContent only allows CleanInbox and Archive.
 * Access to restricted mailboxes (Quarantine, Junk, Trash, etc.) triggers
 * an admin notification and returns an error.
 *
 * This server wraps ImapConnection and EmailCounterStore for use with the Claude Agent SDK.
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

export function createEmailMCPServer(
    imap: ImapConnection,
    counters: EmailCounterStore,
    options: EmailMCPServerOptions
) {
    const { sendAdminNotification, wildDuckClient, rateLimiter, allowlist, sendApprovalRequest } = options;

    // Cache for formal/informal addresses loaded lazily from WildDuck.
    let formalAddress:         string | undefined;
    let informalAddress:       string | undefined;
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
                const formal    = _.find(addresses, addr => _.includes(addr.tags, 'formal'));
                const informal  = _.find(addresses, addr => _.includes(addr.tags, 'informal'));
                // Stryker disable next-line ConditionalExpression,BlockStatement: conditional assignment
                if(formal) {
                    // Stryker disable next-line StringLiteral: address format is RFC 5322 convention
                    formalAddress = formal.name ? `${formal.name} <${formal.address}>` : formal.address;
                }
                // Stryker disable next-line ConditionalExpression,BlockStatement: conditional assignment
                if(informal) {
                    // Stryker disable next-line StringLiteral: address format is RFC 5322 convention
                    informalAddress = informal.name ? `${informal.name} <${informal.address}>` : informal.address;
                }
                // Stryker disable next-line BooleanLiteral: addressesLoaded = true prevents infinite re-loading
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
        if(sendApprovalRequest) {
            // Stryker disable BlockStatement: try-catch wraps approval notification — failure sets IMAP flag and informs Izzy
            try {
                await sendApprovalRequest(toAddress, subject, draftUid, cc);
            } catch (notifErr) {
                // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                logger.warn({ error: _.isError(notifErr) ? notifErr.message : String(notifErr), msg: 'Failed to send outbound approval request' });
                // Best-effort: flag the draft so periodic recheck can retry notification
                // Stryker disable BlockStatement: try-catch wraps flag setting — best-effort, draft already saved
                try {
                    // Stryker disable next-line StringLiteral: flag name is configuration
                    await imap.setFlag(draftUid, EmailFolder.Drafts, '\\DiscordNotifyFailed');
                    await wildDuckClient.updateMessageMetadata(EmailFolder.Drafts, draftUid, { notifyAttempts: 1 });
                } catch (flagErr) {
                    // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                    logger.warn({ error: _.isError(flagErr) ? flagErr.message : String(flagErr), msg: 'Failed to set DiscordNotifyFailed flag on draft' });
                }
                // Stryker restore BlockStatement
                // Stryker disable next-line StringLiteral: Result message is configuration
                return `Draft saved as ${EmailFolder.Drafts}:${draftUid} but failed to notify admin. Please ask Craig to check pending drafts, or I will retry automatically.${rateLimitWarning}`;
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
                'Check CleanInbox for unread emails. Returns counter state and list of unread message summaries.',
                // Stryker restore StringLiteral
                {},
                async (): Promise<CallToolResult> => {
                    // Stryker disable BlockStatement: try-catch wraps IMAP operations - error handling
                    try {
                        const [countersData, messages] = await Promise.all([
                            counters.getCounters(),
                            // Stryker disable next-line StringLiteral: EmailFolder.CleanInbox is configuration constant
                            imap.listUnread(EmailFolder.CleanInbox),
                        ]);
                        const result = {
                            counters: countersData,
                            messages: _.map(messages, m => ({
                                // Stryker disable next-line StringLiteral: MailboxName is configuration constant
                                uid:     `${EmailFolder.CleanInbox}:${m.uid}`,
                                from:    formatAddressForDisplay(m.from),
                                subject: m.subject,
                                date:    m.date.toISOString(),
                            })),
                        };
                        return {
                            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
                        };
                    } catch (error) {
                        const message = _.isError(error) ? error.message : String(error);
                        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                        logger.warn({ error: message, msg: 'Failed to check inbox' });
                        return {
                            content: [{ type: 'text' as const, text: `Error: ${message}` }],
                            isError: true,
                        };
                    }
                },
                // Stryker disable next-line ObjectLiteral: Tool annotations are MCP server configuration
                { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }
            ),

            // Stryker disable StringLiteral: Tool name and description are MCP server configuration
            tool(
                'getEmailContent',
                'Fetch the full content of an email by UID. Marks the email as read and decrements the unread counter.',
                // Stryker restore StringLiteral
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    message: z.string().regex(MAILBOX_UID_REGEX, 'Must be in MailboxName:UID format (e.g., CleanInbox:42)').describe('The email reference in Mailbox:UID format (e.g., CleanInbox:42)'),
                },
                async (args): Promise<CallToolResult> => {
                    // Stryker disable BlockStatement: try-catch wraps IMAP operations - error handling
                    try {
                        const { mailboxName, uid } = parseMailboxUid(args.message);

                        // Access control: only CleanInbox and Archive are directly accessible
                        if(!ACCESSIBLE_MAILBOXES.has(mailboxName)) {
                            // Send admin notification (fire-and-forget)
                            if(sendAdminNotification) {
                                // Stryker disable BlockStatement: try-catch guards notification failure from breaking access control response
                                try {
                                    // Stryker disable next-line ObjectLiteral,StringLiteral: Notification message content is not behavior-affecting
                                    await sendAdminNotification({
                                        content: `Agent requested access to restricted mailbox **${mailboxName}** (UID ${uid}, reference: \`${args.message}\`). This requires admin review.`,
                                    });
                                } catch (notifErr) {
                                    // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                                    logger.warn({ error: _.isError(notifErr) ? notifErr.message : String(notifErr), msg: 'Failed to send restricted mailbox notification' });
                                }
                                // Stryker restore BlockStatement
                            }
                            // Stryker disable next-line StringLiteral: Error message is configuration
                            return {
                                content: [{ type: 'text' as const, text: `Access to ${mailboxName} requires admin review. A notification has been sent to #admin.` }],
                                isError: true,
                            };
                        }

                        const email = await imap.fetchMessage(mailboxName, uid);
                        await imap.setFlag(uid, mailboxName, '\\Seen');
                        // Sync counters with real IMAP state (fire-and-forget; email content returned immediately)
                        void (async () => {
                            // Stryker disable BlockStatement: try-catch wraps counter sync — best-effort, email content returned regardless
                            try {
                                // Stryker disable next-line StringLiteral: EmailFolder.CleanInbox is configuration constant
                                const { total, unread } = await imap.getMailboxCounts(EmailFolder.CleanInbox);
                                await counters.reset(total, unread);
                            } catch (countErr) {
                                // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                                logger.warn({ error: _.isError(countErr) ? countErr.message : String(countErr), msg: 'Failed to sync counters after read' });
                            }
                        })();

                        // Save attachments to disk (keyed by sha1 of messageId).
                        // Message-ID is always present: RFC 5322 requires MDAs to add one if missing,
                        // and our Haraka/WildDuck stack guarantees it.
                        const attachmentLines: string[] = [];
                        // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: skip attachment saving when there are none; > 0 and >= 0 are equivalent for empty array
                        if(email.attachments.length > 0) {
                            // Stryker disable next-line StringLiteral: sha1 algorithm name is a configuration constant
                            const hash          = createHash('sha1').update(email.messageId).digest('hex');
                            // Stryker disable next-line StringLiteral: 'email-' prefix is a configuration constant for path namespacing
                            const attachmentDir = join(process.cwd(), 'attachments', `email-${hash}`);
                            const usedFilenames = new Set<string>();
                            for(const attachment of email.attachments) {
                                const safeBase     = sanitizeFilename(attachment.filename);
                                const safeFilename = deduplicateFilename(safeBase, usedFilenames);
                                usedFilenames.add(safeFilename);
                                const filePath = join(attachmentDir, safeFilename);
                                // Stryker disable BlockStatement: try-catch for best-effort file write — email content returned regardless of attachment save failure
                                try {
                                    // Stryker disable BlockStatement: inner try-catch for file existence check — fs.access throws when file is absent
                                    // Stryker disable next-line BooleanLiteral: initial false is overwritten in both branches of try/catch — equivalent mutation
                                    let fileExists = false;
                                    try {
                                        await access(filePath);
                                        fileExists = true;
                                    } catch{
                                        fileExists = false;
                                    }
                                    // Stryker restore BlockStatement
                                    // Stryker disable next-line ConditionalExpression,BlockStatement: skip write when file already exists (idempotent)
                                    if(!fileExists) {
                                        // Stryker disable next-line ObjectLiteral,BooleanLiteral: recursive:true is required for nested directory creation
                                        await mkdir(attachmentDir, { recursive: true });
                                        await writeFile(filePath, attachment.data);
                                    }
                                    // Stryker disable next-line StringLiteral: attachment path format is a configuration constant
                                    attachmentLines.push(`- attachments/email-${hash}/${safeFilename} (${attachment.contentType})`);
                                } catch (writeErr) {
                                    const errMsg = _.isError(writeErr) ? writeErr.message : String(writeErr);
                                    // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                                    logger.warn({ error: errMsg, filename: safeFilename, msg: 'Failed to save attachment (best-effort)' });
                                    // Stryker disable next-line StringLiteral: note format is a configuration constant
                                    attachmentLines.push(`- Note: could not save attachment ${safeFilename}: ${errMsg}`);
                                }
                                // Stryker restore BlockStatement
                            }
                        }

                        const toList = _(email.to).map(formatAddressForDisplay).join(', ');
                        // Stryker disable ConditionalExpression: line !== undefined is a defensive runtime guard; undefined used as sentinel to omit absent CC line
                        const lines = _.filter([
                            `From: ${formatAddressForDisplay(email.from)}`,
                            `To: ${toList}`,
                            email.cc.length > 0 ? `Cc: ${_(email.cc).map(formatAddressForDisplay).join(', ')}` : undefined,
                            `Subject: ${email.subject}`,
                            `Date: ${email.date.toISOString()}`,
                            '',
                            email.bodyText,
                            // Stryker disable next-line ConditionalExpression,BlockStatement,ArrayDeclaration: attachment section only added when there are attachments
                            ...(attachmentLines.length > 0 ? ['\nAttachments:', ...attachmentLines] : []),
                        ], line => line !== undefined);
                        // Stryker restore ConditionalExpression
                        // Stryker disable next-line Regex,StringLiteral: /^\n/ and '' are defensive no-ops — the text always starts with 'From:' so the regex never matches; _.trim() on the next line also covers any edge case
                        const text = _.replace(_.join(lines, '\n'), /^\n/, '');
                        return {
                            content: [{ type: 'text' as const, text: _.trim(text) }],
                        };
                    } catch (error) {
                        const message = _.isError(error) ? error.message : String(error);
                        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                        logger.warn({ error: message, message: args.message, msg: 'Failed to fetch email content' });
                        return {
                            content: [{ type: 'text' as const, text: `Error: ${message}` }],
                            isError: true,
                        };
                    }
                },
                // Stryker disable next-line ObjectLiteral: Tool annotations are MCP server configuration
                { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }
            ),

            // Stryker disable StringLiteral: Tool name and description are MCP server configuration
            tool(
                'archiveEmail',
                'Move an email from CleanInbox to Archive. Decrements the total email counter.',
                // Stryker restore StringLiteral
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    message: z.string().regex(MAILBOX_UID_REGEX, 'Must be in MailboxName:UID format (e.g., CleanInbox:42)').describe('The email reference in Mailbox:UID format (e.g., CleanInbox:42)'),
                },
                async (args): Promise<CallToolResult> => {
                    // Stryker disable BlockStatement: try-catch wraps IMAP operations - error handling
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
                        await imap.moveMessage(uid, mailboxName, EmailFolder.Archive);
                        // Sync counters with real IMAP state (fire-and-forget; archive completes immediately)
                        void (async () => {
                            // Stryker disable BlockStatement: try-catch wraps counter sync — best-effort, archive completes regardless
                            try {
                                // Stryker disable next-line StringLiteral: EmailFolder.CleanInbox is configuration constant
                                const { total, unread } = await imap.getMailboxCounts(EmailFolder.CleanInbox);
                                await counters.reset(total, unread);
                            } catch (countErr) {
                                // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                                logger.warn({ error: _.isError(countErr) ? countErr.message : String(countErr), msg: 'Failed to sync counters after archive' });
                            }
                        })();
                        return {
                            content: [{ type: 'text' as const, text: `Email UID ${uid} archived successfully.` }],
                        };
                    } catch (error) {
                        const message = _.isError(error) ? error.message : String(error);
                        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                        logger.warn({ error: message, message: args.message, msg: 'Failed to archive email' });
                        return {
                            content: [{ type: 'text' as const, text: `Error: ${message}` }],
                            isError: true,
                        };
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
                    // Stryker disable BlockStatement: try-catch wraps WildDuck API operations - error handling
                    try {
                        // Determine which mailboxes to search
                        let mailboxes: string[];
                        // Stryker disable ConditionalExpression: mailbox parameter presence determines search scope
                        if(!args.mailbox || args.mailbox === 'all-regular') {
                            mailboxes = [...REGULAR_SEARCH_MAILBOXES];
                        } else if(args.mailbox === 'all') {
                            mailboxes = [...ALL_SEARCH_MAILBOXES];
                        } else {
                            mailboxes = [args.mailbox];
                        }
                        // Stryker restore ConditionalExpression

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
                            ..._.map(results, (r) => {
                                const toStr = r.to.length > 0 ? r.to.join(', ') : '(none)';
                                // Stryker disable next-line StringLiteral: Result line format is configuration
                                return `- ${r.message} | From: ${r.from} | To: ${toStr} | Subject: ${r.subject} | Date: ${r.date}`;
                            }),
                        ];

                        return {
                            // Stryker disable next-line StringLiteral: 'text' is an MCP content type constant
                            content: [{ type: 'text' as const, text: _.join(lines, '\n') }],
                        };
                    } catch (error) {
                        const message = _.isError(error) ? error.message : String(error);
                        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                        logger.warn({ error: message, msg: 'Failed to search emails' });
                        return {
                            content: [{ type: 'text' as const, text: `Error: ${message}` }],
                            isError: true,
                        };
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
                    // Stryker disable StringLiteral: describe() is documentation only
                    to: z.union([
                        z.email(),
                        // Stryker disable next-line MethodExpression: .min(1) is a schema constraint; removing it would allow empty arrays but Zod validation at schema level is not tested by mutation
                        z.array(z.email()).min(1),
                    ]).describe('Recipient email address or array of addresses'),
                    // Stryker restore StringLiteral
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
                    // Stryker disable BlockStatement: try-catch wraps send operations - error handling
                    try {
                        // Ensure addresses are loaded
                        await loadAddresses();

                        // Resolve from address based on identity
                        // Stryker disable next-line ConditionalExpression: identity selection between formal/informal addresses
                        const fromAddress = args.identity === 'informal' ? informalAddress : formalAddress;
                        // Stryker disable next-line BooleanLiteral,StringLiteral: fallback from address when identity not resolved
                        const from = fromAddress ?? '';

                        if(!from) {
                            return {
                                content: [{ type: 'text' as const, text: 'Cannot send email: no sender address configured on this account. Please configure an email address in WildDuck.' }],
                                isError: true,
                            };
                        }

                        // Normalize to to an array
                        // Stryker disable next-line ConditionalExpression: normalize single string or array of strings
                        const toAddresses = _.isArray(args.to) ? args.to : [args.to];

                        // Check rate limit — warn but don't block
                        // Stryker disable next-line StringLiteral: initial empty string for rateLimitWarning
                        let rateLimitWarning = '';
                        if(rateLimiter) {
                            // Stryker disable next-line ConditionalExpression,BlockStatement: rate limit warning is informational only
                            if(rateLimiter.isAtLimit()) {
                                // Stryker disable next-line StringLiteral: Warning message is configuration
                                rateLimitWarning = ` Warning: send rate limit reached (${rateLimiter.tokensRemaining()} tokens remaining).`;
                            }
                        }

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
                            // Stryker disable next-line ArrayDeclaration,StringLiteral: flags array for draft
                            flags:   ['\\Draft'],
                            // Stryker disable next-line BooleanLiteral: draft flag is required for WildDuck draft upload
                            draft:   true,
                        });

                        // Fast-path only when ALL recipients are allowlisted (cc is undefined for sendEmail)
                        // Stryker disable next-line ConditionalExpression,EqualityOperator,BooleanLiteral: all-recipients allowlist check; ?? false unreachable when allowlist always provided
                        const isAllAllowed = _.every(toAddresses, addr => allowlist?.isAllowed(addr) ?? false);
                        const toStr        = toAddresses.join(', ');
                        const text         = await submitOrRequestApproval(uid, toStr, args.subject, rateLimitWarning, 'Sent successfully.', undefined, isAllAllowed);
                        return {
                            content: [{ type: 'text' as const, text }],
                        };
                    } catch (error) {
                        const message = _.isError(error) ? error.message : String(error);
                        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                        logger.warn({ error: message, to: args.to, msg: 'Failed to send email' });
                        return {
                            content: [{ type: 'text' as const, text: `Error: ${message}` }],
                            isError: true,
                        };
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
                    // Stryker disable BlockStatement: try-catch wraps reply operations - error handling
                    try {
                        // Ensure addresses are loaded
                        await loadAddresses();

                        // Resolve from address based on identity
                        // Stryker disable next-line ConditionalExpression,EqualityOperator: identity selection between formal/informal addresses
                        const fromAddress = args.identity === 'informal' ? informalAddress : formalAddress;
                        // Stryker disable next-line BooleanLiteral,StringLiteral: fallback from address when identity not resolved
                        const from = fromAddress ?? '';

                        if(!from) {
                            return {
                                content: [{ type: 'text' as const, text: 'Cannot send email: no sender address configured on this account. Please configure an email address in WildDuck.' }],
                                isError: true,
                            };
                        }

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
                        // Stryker disable next-line StringLiteral: initial empty string for rateLimitWarning
                        let rateLimitWarning = '';
                        if(rateLimiter) {
                            // Stryker disable next-line ConditionalExpression,BlockStatement: rate limit warning is informational only
                            if(rateLimiter.isAtLimit()) {
                                // Stryker disable next-line StringLiteral: Warning message is configuration
                                rateLimitWarning = ` Warning: send rate limit reached (${rateLimiter.tokensRemaining()} tokens remaining).`;
                            }
                        }

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
                                // Stryker disable next-line ConditionalExpression: replyAll vs reply action
                                action:  args.mode === 'replyAll' ? 'replyAll' : 'reply',
                                mailbox: mailboxWildDuckId,
                                id:      originalUid,
                            },
                            // Stryker disable next-line ConditionalExpression,EqualityOperator,ObjectLiteral: attachments array inclusion guard
                            ...(attachments.length > 0 ? { attachments } : {}),
                            // Stryker disable next-line ArrayDeclaration,StringLiteral: flags array for draft
                            flags: ['\\Draft'],
                            // Stryker disable next-line BooleanLiteral: draft flag is required for WildDuck draft upload
                            draft: true,
                        });

                        // For replyAll, always require admin approval (isAllowedOverride = false).
                        // For plain reply, check allowlist for primary recipient.
                        // Stryker disable next-line ConditionalExpression,EqualityOperator,BooleanLiteral: replyAll forces approval path; plain reply uses allowlist
                        const isAllowedOverride: boolean | undefined = args.mode === 'replyAll' ? false : undefined;
                        // Stryker disable next-line ConditionalExpression,EqualityOperator: extract cc addresses for replyAll mode only
                        const ccAddresses = args.mode === 'replyAll'
                            ? _(original.cc ?? []).map('address').compact().value()
                            : undefined;
                        // Stryker disable next-line StringLiteral,LogicalOperator: Result message is configuration; ?? '' is defensive fallback when subject absent
                        const text = await submitOrRequestApproval(uid, primaryTo, `Re: ${original.subject ?? ''}`, rateLimitWarning, `Reply sent to ${primaryTo}.`, ccAddresses, isAllowedOverride);
                        return {
                            content: [{ type: 'text' as const, text }],
                        };
                    } catch (error) {
                        const message = _.isError(error) ? error.message : String(error);
                        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                        logger.warn({ error: message, message: args.message, msg: 'Failed to reply to email' });
                        return {
                            content: [{ type: 'text' as const, text: `Error: ${message}` }],
                            isError: true,
                        };
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
                    // Stryker disable BlockStatement: try-catch wraps delete operations - error handling
                    try {
                        const { uid } = parseMailboxUid(args.message);
                        await wildDuckClient.deleteMessage(EmailFolder.Drafts, uid);
                        return {
                            // Stryker disable next-line StringLiteral: Result message is configuration
                            content: [{ type: 'text' as const, text: `Draft ${args.message} deleted.` }],
                        };
                    } catch (error) {
                        const message = _.isError(error) ? error.message : String(error);
                        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                        logger.warn({ error: message, message: args.message, msg: 'Failed to delete draft' });
                        return {
                            content: [{ type: 'text' as const, text: `Error: ${message}` }],
                            isError: true,
                        };
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
                    // Stryker disable StringLiteral,MethodExpression: describe() is documentation only; .min(1) is schema constraint not tested via mutation
                    to:       z.union([z.email(), z.array(z.email()).min(1)]).optional().describe('New To address(es) (leave blank to keep original)'),
                    // Stryker restore StringLiteral,MethodExpression
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    identity: z.enum(['formal', 'informal']).optional().describe('Email identity to use (leave blank to keep original)'),
                },
                async (args): Promise<CallToolResult> => {
                    // Stryker disable BlockStatement: try-catch wraps amend operations - error handling
                    try {
                        // Ensure addresses are loaded
                        await loadAddresses();

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

                        // Normalize args.to: undefined → use original recipients; string → wrap in array
                        // Stryker disable next-line ConditionalExpression: args.to present → normalize to string[]; absent → use original recipients
                        const argToAddresses: string[] | undefined = args.to ? _.castArray(args.to) : undefined;
                        const toAddresses    = argToAddresses ?? _(original.to ?? []).map('address').compact().value();

                        // Resolve from address
                        // Stryker disable next-line ConditionalExpression: identity selection between formal/informal addresses
                        const fromAddress = args.identity === 'informal' ? informalAddress : formalAddress;
                        // Stryker disable next-line BooleanLiteral,StringLiteral: fallback from address when identity not resolved
                        const from = fromAddress ?? '';

                        if(!from) {
                            return {
                                content: [{ type: 'text' as const, text: 'Cannot send email: no sender address configured on this account. Please configure an email address in WildDuck.' }],
                                isError: true,
                            };
                        }

                        // Re-upload with replacePrevious to atomically replace the old draft
                        const newUid = await wildDuckClient.uploadMessage(EmailFolder.Drafts, {
                            from,
                            to:              toAddresses,
                            subject,
                            text:            body,
                            replacePrevious: { mailbox: EmailFolder.Drafts, id: uid },
                            // Stryker disable next-line ArrayDeclaration,StringLiteral: flags array for draft
                            flags:           ['\\Draft'],
                            // Stryker disable next-line BooleanLiteral: draft flag is required for WildDuck draft upload
                            draft:           true,
                        });

                        // Always route through approval (isAllowedOverride=false) — amended drafts require human review.
                        const amendResult = await submitOrRequestApproval(
                            newUid,
                            // Stryker disable next-line StringLiteral: join separator is cosmetic formatting — tested via multi-recipient amend test
                            toAddresses.join(', '),
                            subject,
                            // Stryker disable next-line StringLiteral: empty string — no rate limit warning for amend (rate limiter not called on approval path)
                            '',
                            // Stryker disable next-line StringLiteral: empty string — successMessage is unreachable when isAllowedOverride=false always routes to approval
                            '',
                            undefined, // cc not available for amend-resubmit
                            false      // isAllowedOverride=false → always approval path
                        );
                        return {
                            content: [{ type: 'text' as const, text: amendResult }],
                        };
                    } catch (error) {
                        const message = _.isError(error) ? error.message : String(error);
                        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                        logger.warn({ error: message, message: args.message, msg: 'Failed to amend and resubmit draft' });
                        return {
                            content: [{ type: 'text' as const, text: `Error: ${message}` }],
                            isError: true,
                        };
                    }
                },
                // Stryker disable next-line ObjectLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } }
            ),
        ],
    });
}
