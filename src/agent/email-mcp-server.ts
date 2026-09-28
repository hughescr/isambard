import { createHash } from 'node:crypto';
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '@hughescr/logger';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import pLimit from 'p-limit';
import { z } from 'zod';
import { buildAdminRejectedSubsection } from './context-builder';
import { mcpTextResult, withHealthGuard, withToolErrorHandling, withWriteHealthGuard } from './mcp-helpers';
import { EmailFolder } from '@/config';
import { EmailProcessingError, WildDuckError } from '@/errors';
// eslint-disable-next-line boundaries/dependencies -- The MCP server is the email integration's public agent-facing boundary.
import { amendedDraftMeta, draftsMailboxMessageRefSchema, emailSenderProfileSchema, formatAddressForDisplay, formatMailboxMessageRef, hasDecisionMarker, mailboxMessageRefSchema, newPreviewToken, readDraftApprovalMeta, searchDraftsByReviewState, type DraftApprovalMeta, type EmailSenderProfile, type MailboxMessageRef, type WildDuckClient, type WildDuckAttachment, type WildDuckAttachmentMeta, type WildDuckMessage } from '@/integrations/email';
import type { ServiceHealthRegistry, ReconnectionLoop, TokenBucketRateLimiter } from '@/services';
import type { PersonAllowlist } from '@/storage';
import { sanitizeFilename, deduplicateFilename, processLocalVideo, createSpawnRunner, createBinarySpawnRunner } from '@/utils';
/** Mailboxes accessible directly by the agent without admin review. */
const ACCESSIBLE_MAILBOXES: ReadonlySet<EmailFolder> = new Set([EmailFolder.CleanInbox, EmailFolder.Archive]);

/** Mailboxes readable by getEmailContent (also includes Drafts and Sent Mail). */
const READABLE_MAILBOXES: ReadonlySet<EmailFolder> = new Set([EmailFolder.CleanInbox, EmailFolder.Archive, EmailFolder.Drafts, EmailFolder.Sent]);

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

/** Why a draft cannot be amended: the admin approved it, or an earlier amend already replaced it. */
function amendRefusal(draftRef: string, meta: DraftApprovalMeta): string | undefined {
    if(meta.approval !== undefined) {
        return `Draft ${draftRef} has an admin approval recorded; it can't be amended.`;
    }
    if(meta.supersededBy !== undefined) {
        return `Draft ${draftRef} was already replaced by ${EmailFolder.Drafts}:${meta.supersededBy}.`;
    }
    return undefined;
}

/**
 * What an amended draft's upload carries — the card link with one more edit (when it has one) and
 * a fresh preview token, never anything else of the old metaData — and the edit number its card
 * will show.
 */
function amendCarry(metaData: unknown, meta: DraftApprovalMeta): { metaData: Record<string, unknown>, edits: number } {
    return {
        metaData: { ...amendedDraftMeta(metaData), previewToken: newPreviewToken() },
        edits:    (meta.card?.edits ?? 0) + 1,
    };
}

/** Whether a WildDuck call failed because the message does not exist. */
function isNotFound(err: unknown): boolean {
    return err instanceof WildDuckError && err.context?.status === 404;
}

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
    /** Mark `oldUid` replaced by `newUid` when an amend could not delete it; false when that failed too. */
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
    /** Marks an amended draft's old UID superseded when no approval cards are configured (EmailOutboundApprovals.markSuperseded) */
    markSuperseded?:        (oldUid: number, newUid: number) => Promise<boolean>
    /** Optional service health registry for fast-fail guards */
    healthRegistry?:        ServiceHealthRegistry
    /** Optional reconnection loop to trigger on health check failure */
    reconnectionLoop?:      ReconnectionLoop
}

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

/**
 * Build WildDuck attachments from file paths.
 */
export async function buildAttachments(filePaths: string[]): Promise<WildDuckAttachment[]> {
    const { readFile } = await import('node:fs/promises');
    const limit = pLimit(2);
    const reads = await Promise.allSettled(filePaths.map(filePath => limit(async (): Promise<WildDuckAttachment> => {
        const bytes       = await readFile(filePath);
        const filename    = path.basename(filePath);
        // Stryker disable next-line llm: extname examines only the final path segment, so using filename produces the same extension.
        const ext         = path.extname(filePath).toLowerCase().slice(1);
        const contentType = MIME_TYPE_MAP[ext] ?? 'application/octet-stream';
        return { filename, contentType, content: bytes.toString('base64') };
    })));
    return reads.map((read, index) => {
        // Stryker disable next-line llm: reads and filePaths share length by construction, so index is in bounds and `?? ''` is unreachable.
        const filePath = filePaths[index]!;
        // Stryker disable next-line llm: read.status and 'rejected' are string primitives of the same type, so == and === agree.
        if(read.status === 'rejected') {
            throw new EmailProcessingError(`Attachment file not found: ${filePath}`, { filePath });
        }
        return read.value;
    });
}

/**
 * Save email attachments to disk (lazy-fetch from WildDuck, keyed by mailbox, UID, and attachment ID).
 * Returns lines suitable for appending to the email content display.
 */
async function saveEmailAttachments(
    wildDuckClient: WildDuckClient,
    mailboxName:    string,
    uid:            number,
    attachmentMeta: WildDuckAttachmentMeta[]
): Promise<string[]> {
    // eslint-disable-next-line sonarjs/hashing -- sha1 shortens a stable mailbox/UID cache key for a directory name; it does not protect security or integrity
    const hash          = createHash('sha1').update(JSON.stringify([mailboxName, uid])).digest('hex');
    const attachmentDir = path.join(process.cwd(), 'attachments', `email-${hash}`);
    const usedFilenames = new Set<string>();
    const namedAttachments = attachmentMeta.map((meta) => {
        const safeBase     = sanitizeFilename(meta.filename);
        const safeFilename = deduplicateFilename(safeBase, usedFilenames);
        usedFilenames.add(safeFilename);
        return { meta, safeFilename };
    });
    const limit = pLimit(2);
    const groups = await Promise.all(namedAttachments.map(({ meta, safeFilename }) => limit(() => saveOneEmailAttachment(
        wildDuckClient, mailboxName, uid, meta, safeFilename, attachmentDir, hash
    ))));
    return groups.flat();
}

async function saveOneEmailAttachment(
    wildDuckClient: WildDuckClient,
    mailboxName: string,
    uid: number,
    meta: WildDuckAttachmentMeta,
    safeFilename: string,
    attachmentDir: string,
    hash: string
): Promise<string[]> {
    try {
        // eslint-disable-next-line sonarjs/hashing -- sha1 shortens the attachment ID for a directory name; it does not protect security or integrity
        const attachmentHash = createHash('sha1').update(meta.id).digest('hex');
        const attachmentPath = path.join(attachmentDir, `attachment-${attachmentHash}`);
        const filePath = path.join(attachmentPath, safeFilename);
        let fileExists: boolean;
        try {
            await access(filePath);
            fileExists = true;
        } catch{
            fileExists = false;
        }
        if(!fileExists) {
            await mkdir(attachmentPath, { recursive: true });
            const data = await wildDuckClient.getAttachment(mailboxName, uid, meta.id);
            await writeFile(filePath, data);
        }
        if(meta.contentType.startsWith('video/')) {
            const videoLines = await renderVideoAttachment(filePath, attachmentPath, safeFilename);
            if(videoLines) {
                return videoLines;
            }
        }
        return [`- attachments/email-${hash}/attachment-${attachmentHash}/${safeFilename} (${meta.contentType})`];
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.warn({ error: errMsg, filename: safeFilename, msg: 'Failed to save attachment (best-effort)' });
        return [`- Note: could not save attachment ${safeFilename}: ${errMsg}`];
    }
}

async function renderVideoAttachment(filePath: string, attachmentPath: string, safeFilename: string): Promise<string[] | null> {
    try {
        const videoOutputDir = path.join(attachmentPath, `video-${safeFilename}`);
        const videoResult = await processLocalVideo(filePath, videoOutputDir, {
            run: createSpawnRunner(), binaryRun: createBinarySpawnRunner(),
        });
        return [
            `- Video: ${safeFilename} — ${videoResult.metadataMarkdown}`,
            ...videoResult.frames.map(frame => `  - Frame: ${videoOutputDir}/${frame.filename}`),
        ];
    } catch (videoError) {
        logger.warn({ error: videoError instanceof Error ? videoError.message : String(videoError), filename: safeFilename, msg: 'Video processing failed, using generic attachment reference' });
        return null;
    }
}

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
 * Normalizes a to-address argument (string, object, array, or undefined) to an array or undefined.
 */

function normalizeToAddresses<T>(to: T | T[] | undefined): T[] | undefined {
    // Stryker disable next-line llm: the sole caller passes a Zod .optional() value, which is never null, so strict and loose nullish checks agree.
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

export function createEmailMCPServer(options: EmailMCPServerOptions) {
    const { sendAdminNotification, wildDuckClient, rateLimiter, allowlist, approvalCards } = options;

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
     * Submit the draft immediately when every recipient is allowed (the caller decides: all To
     * addresses allowlisted for a send, the replied-to address for a plain reply, never for a
     * reply-all or an amend), or else show it to the admin for approval. An amend passes the
     * draft it replaced and the new edit count, so the admin's existing card can be edited in place.
     */
    async function submitOrRequestApproval(
        draftUid: number,
        isAllowed: boolean,
        rateLimitWarning: string,
        successMessage: string,
        previous?: { uid: number, edits: number }
    ): Promise<CallToolResult> {
        if(isAllowed) {
            await wildDuckClient.submitMessage(EmailFolder.Drafts, draftUid);
            rateLimiter?.increment();
            return mcpTextResult(`${successMessage}${rateLimitWarning}`);
        }

        // Not on allowlist (or replyAll) — request admin approval. The card is posted through the
        // Discord outbox when Discord is offline, so a failure here is exceptional.
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
                return mcpTextResult(`Draft saved as ${draftRef}; the admin's approval card was updated in place (edit ${previous?.edits}).${rateLimitWarning}`);
            }
            case 'missing': {
                return { content: [{ type: 'text' as const, text: `Draft ${draftRef} not found after upload.` }], isError: true };
            }
            case 'failed': {
                return mcpTextResult(`Draft saved as ${draftRef} but failed to notify admin. Please check pending drafts manually.${rateLimitWarning}`);
            }
            case 'posted':
            case 'queued': {
                return mcpTextResult(`Message saved to Drafts, pending admin approval (draft UID: ${draftUid}).${rateLimitWarning}`);
            }
        }
    }

    /** Whether a reply goes out without approval: never for replyAll (its Cc included), else when the replied-to address is allowlisted. */
    function isReplyAllowed(mode: 'reply' | 'replyAll', primaryTo: string): boolean {
        return mode !== 'replyAll' && (allowlist?.isAllowed('email', primaryTo) ?? false);
    }

    /**
     * Remove an amended draft's old UID that WildDuck's replace left behind: delete it (already
     * gone counts), or failing that mark it superseded. Returns a warning for the tool text when
     * both failed, else ''.
     */
    async function removeReplacedDraft(oldUid: number, newUid: number): Promise<string> {
        try {
            await wildDuckClient.deleteMessage(EmailFolder.Drafts, oldUid);
            return '';
        } catch (err) {
            if(isNotFound(err)) {
                return '';
            }
            logger.warn({ err, oldUid, newUid, msg: 'Could not delete the amended draft’s previous version — marking it superseded' });
        }
        const marked = await (approvalCards ? approvalCards.markSuperseded(oldUid, newUid) : options.markSuperseded?.(oldUid, newUid)) ?? false;
        return marked ? '' : ` Warning: the previous version ${EmailFolder.Drafts}:${oldUid} could not be removed; delete it with deleteDraft.`;
    }

    return createSdkMcpServer({
        name:    'email',
        version: '1.0.0',
        tools:   [
            tool(
                'checkInbox',
                'Check CleanInbox for emails. Returns counter state and message summaries. By default only unread; set showSeen to include read messages.',
                { showSeen: z.boolean().optional().describe('When true, include read messages alongside unread. Defaults to false (unread only).') },
                withHealthGuard(options.healthRegistry, 'email', options.reconnectionLoop,
                    withToolErrorHandling('checkInbox', async ({ showSeen }): Promise<CallToolResult> => {
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
                'Fetch the full content of an email by UID. Marks the email as read.',
                {
                    message: mailboxMessageRefSchema.describe('The email reference in Mailbox:UID format (e.g., CleanInbox:42)'),
                },

                withHealthGuard(options.healthRegistry, 'email', options.reconnectionLoop,
                    withToolErrorHandling('getEmailContent',

                        async (args): Promise<CallToolResult> => {
                            const { folder, uid } = args.message;

                            // Access control: CleanInbox, Archive, Drafts, and Sent Mail are directly readable
                            if(!hasReadableMailbox(folder)) {
                                // Send admin notification (fire-and-forget)
                                if(sendAdminNotification) {
                                    try {
                                        await sendAdminNotification(args.message);
                                    } catch (error) {
                                        logger.warn({ error: error instanceof Error ? error.message : String(error), msg: 'Failed to send restricted mailbox notification' });
                                    }
                                }
                                return {
                                    content: [{ type: 'text' as const, text: `Access to ${folder} requires admin review. A notification has been sent to #admin.` }],
                                    isError: true,
                                };
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

                            const toList = email.to.map(addr => formatAddressForDisplay(addr)).join(', ');
                            const lines = ([
                                `From: ${formatAddressForDisplay(email.from)}`,
                                `To: ${toList}`,
                                email.cc.length > 0 ? `Cc: ${email.cc.map(addr => formatAddressForDisplay(addr)).join(', ')}` : undefined,
                                `Subject: ${email.subject}`,
                                `Date: ${email.date.toISOString()}`,
                                '',
                                email.bodyText,
                                ...(attachmentLines.length > 0 ? ['\nAttachments:', ...attachmentLines] : []),
                            ]).filter(line => line !== undefined);
                            const text = lines.join('\n');
                            return mcpTextResult(text.trim());
                        })),
                { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }
            ),

            tool(
                'archiveEmail',
                'Move an email from CleanInbox to Archive.',
                {
                    message: mailboxMessageRefSchema.describe('The email reference in Mailbox:UID format (e.g., CleanInbox:42)'),
                },
                withHealthGuard(options.healthRegistry, 'email', options.reconnectionLoop,
                    withToolErrorHandling('archiveEmail', async (args): Promise<CallToolResult> => {
                        const { folder, uid } = args.message;

                        // Access control: only CleanInbox and Archive are directly accessible
                        if(!hasAccessibleMailbox(folder)) {
                            return {
                                content: [{ type: 'text' as const, text: `Access denied: cannot archive messages in ${folder}. Restricted mailboxes require admin review.` }],
                                isError: true,
                            };
                        }

                        await wildDuckClient.moveMessage(folder, uid, EmailFolder.Archive);
                        return mcpTextResult(`Email UID ${uid} archived successfully.`);
                    })),
                { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }
            ),

            tool(
                'searchEmail',
                'Search emails across mailboxes using WildDuck API',
                {
                    correspondent: z.string().optional().describe('Search From, To, Cc, Bcc fields'),
                    content:       z.string().optional().describe('Search Subject and body text'),
                    before:        z.string().optional().describe('ISO date - return emails before this date'),
                    since:         z.string().optional().describe('ISO date - return emails since this date'),
                    header:        z.object({
                        name:  z.string().describe('Header name'),
                        value: z.string().describe('Header value'),
                    }).optional().describe('Search by specific header value'),
                    mailbox: z.union([
                        z.literal('all-regular'),
                        z.literal('all'),
                        z.enum([
                            EmailFolder.CleanInbox, EmailFolder.Archive, EmailFolder.Review,
                            EmailFolder.Quarantine, EmailFolder.Junk, EmailFolder.Trash,
                            EmailFolder.Drafts, EmailFolder.Sent,
                        ]),
                    ]).optional().describe("Mailbox scope. 'all-regular' = all regular mailboxes excluding Junk and Trash (default). 'all' = every folder. Or a specific folder name."),
                },
                withHealthGuard(options.healthRegistry, 'email', options.reconnectionLoop,
                    withToolErrorHandling('searchEmail', async (args): Promise<CallToolResult> => {
                        // Build search params based on mailbox selection
                        const mailboxParam = (!args.mailbox || args.mailbox === 'all-regular' || args.mailbox === 'all')
                            ? undefined
                            : args.mailbox;
                        const searchableParam = (!args.mailbox || args.mailbox === 'all-regular')
                            ? true as const
                            : undefined;

                        const results = await wildDuckClient.search({
                            query: {
                                correspondent: args.correspondent,
                                content:       args.content,
                                before:        args.before,
                                since:         args.since,
                                header:        args.header,
                            },
                            mailbox:    mailboxParam,
                            searchable: searchableParam,
                        });

                        // Stryker disable next-line llm: search returns an array or rejects, so an added falsy-results guard is unreachable.
                        if(results.length === 0) {
                            return {
                                content: [{ type: 'text' as const, text: 'No emails found matching your search criteria.' }],
                            };
                        }

                        const lines = [
                            `Found ${results.length} email${results.length === 1 ? '' : 's'}:`,
                            ...results.map((r) => {
                                const toStr = r.to.length > 0 ? r.to.map(address => formatAddressForDisplay(address)).join(', ') : '(none)';
                                return `- ${r.message} | From: ${formatAddressForDisplay(r.from)} | To: ${toStr} | Subject: ${r.subject} | Date: ${r.date}`;
                            }),
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
                    body:          z.string().describe('Email body text'),
                    senderProfile: emailSenderProfileSchema.optional().describe(SENDER_PROFILE_DEFAULT_FORMAL_DESCRIPTION),
                    attachments:   z.array(z.string()).optional().describe('File paths to attach'),
                },
                withWriteHealthGuard(options.healthRegistry, 'email', 'discord', options.reconnectionLoop,
                    withToolErrorHandling('sendEmail', async (args): Promise<CallToolResult> => {
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

                        // Build attachments from file paths
                        // Stryker disable next-line llm: the schema yields string[] or undefined; arrays are truthy, so ?? and || agree.
                        const attachments = await buildAttachments(args.attachments ?? []);

                        // Upload to Drafts
                        const uid = await wildDuckClient.uploadMessage(EmailFolder.Drafts, {
                            from,
                            to:       toAddresses,
                            subject:  args.subject,
                            // Stryker disable next-line llm: sendEmail's schema requires body to be a string, so a nullish fallback is inert.
                            text:     args.body,
                            ...(attachments.length > 0 ? { attachments } : {}),
                            draft:    true,
                            metaData: { previewToken: newPreviewToken() },
                        });

                        // Fast-path only when ALL recipients are allowlisted (cc is undefined for sendEmail)
                        const isAllAllowed = toAddresses.every(addr => allowlist?.isAllowed('email', addr.address) ?? false);
                        return submitOrRequestApproval(uid, isAllAllowed, rateLimitWarning, 'Sent successfully.');
                    })),
                { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } }
            ),

            tool(
                'replyToEmail',
                'Reply to an existing email. If recipient is on the allowlist, sends immediately. Otherwise, saves to Drafts for admin approval.',
                {
                    message:       mailboxMessageRefSchema.describe('The email reference in Mailbox:UID format to reply to'),
                    body:          z.string().describe('Reply body text'),
                    mode:          z.enum(['reply', 'replyAll']).describe('Reply mode: reply to sender only, or reply-all'),
                    senderProfile: emailSenderProfileSchema.optional().describe(SENDER_PROFILE_DEFAULT_FORMAL_DESCRIPTION),
                    attachments:   z.array(z.string()).optional().describe('File paths to attach'),
                },

                withWriteHealthGuard(options.healthRegistry, 'email', 'discord', options.reconnectionLoop,
                    withToolErrorHandling('replyToEmail',
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

                            // Build attachments from file paths
                            const attachments = await buildAttachments(args.attachments ?? []);

                            // Upload to Drafts with WildDuck reference for threading.
                            // WildDuck derives all recipients (To, Cc) from the reference object automatically.
                            const uid = await wildDuckClient.uploadMessage(EmailFolder.Drafts, {
                                from,
                                subject:   `Re: ${original.subject ?? ''}`,
                                // Stryker disable next-line llm: the reply tool schema requires body to be a string, so a nullish empty-string fallback is inert.
                                text:      args.body,
                                reference: {
                                    action:  args.mode === 'replyAll' ? 'replyAll' : 'reply',
                                    mailbox: mailboxWildDuckId,
                                    id:      originalUid,
                                },
                                ...(attachments.length > 0 ? { attachments } : {}),
                                draft:    true,
                                metaData: { previewToken: newPreviewToken() },
                            });

                            return submitOrRequestApproval(uid, isReplyAllowed(args.mode, primaryTo), rateLimitWarning, `Reply sent to ${primaryTo}.`);
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
                    withToolErrorHandling('deleteDraft', async (args): Promise<CallToolResult> => {
                        const { uid } = args.message;
                        const draftRef = formatMailboxMessageRef(args.message);
                        // Read first: the card is marked from this read, and an approved draft is left alone.
                        const draft = await wildDuckClient.getMessage(EmailFolder.Drafts, uid);
                        if(!draft) {
                            return { content: [{ type: 'text' as const, text: `Draft ${draftRef} not found.` }], isError: true };
                        }
                        const meta = readDraftApprovalMeta(draft.metaData);
                        if(meta.approval !== undefined) {
                            return { content: [{ type: 'text' as const, text: `Draft ${draftRef} has an admin approval recorded; it can't be deleted.` }], isError: true };
                        }
                        await wildDuckClient.deleteMessage(EmailFolder.Drafts, uid);
                        await approvalCards?.markDeleted(draft, uid);
                        const cardNote = approvalCards && meta.card && !hasDecisionMarker(meta) ? ' The admin\'s approval card was marked deleted.' : '';
                        return mcpTextResult(`Draft ${draftRef} deleted.${cardNote}`);
                    })),
                { annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } }
            ),

            tool(
                'amendAndResubmitDraft',
                'Amend a pending or rejected draft and resubmit it for admin approval. Reads the existing draft, applies your changes, and re-uploads it as a new draft UID, replacing the old one. A pending draft\'s approval card is updated in place; a rejected draft gets a new card. A draft the admin has approved cannot be amended.',
                {
                    message:       draftsMailboxMessageRefSchema.describe('The pending or rejected draft to amend, in Drafts:UID format'),
                    subject:       z.string().optional().describe('New subject line (leave blank to keep original)'),
                    body:          z.string().optional().describe('New plain text body (leave blank to keep original)'),
                    to:            z.union([emailAddressSchema, z.array(emailAddressSchema).min(1)]).optional().describe('New To address(es) (leave blank to keep original)'),
                    senderProfile: emailSenderProfileSchema.optional().describe('Sender profile for the From address: formal or informal'),
                },
                withWriteHealthGuard(options.healthRegistry, 'email', 'discord', options.reconnectionLoop,
                    withToolErrorHandling('amendAndResubmitDraft', async (args): Promise<CallToolResult> => {
                        // Resolve from address based on sender profile (loads addresses lazily)
                        const fromResult = await resolveFromAddress(args.senderProfile ?? 'formal');
                        if(!fromResult.ok) {
                            return fromResult.error;
                        }
                        const from = fromResult.from;

                        // Drafts-only schema has already decoded the message UID.
                        const { uid } = args.message;

                        // Fetch original draft
                        const draftRef = formatMailboxMessageRef(args.message);
                        const original = await wildDuckClient.getMessage(EmailFolder.Drafts, uid);
                        if(!original) {
                            return {
                                content: [{ type: 'text' as const, text: `Draft ${draftRef} not found.` }],
                                isError: true,
                            };
                        }
                        const meta = readDraftApprovalMeta(original.metaData);
                        const refusal = amendRefusal(draftRef, meta);
                        if(refusal !== undefined) {
                            return { content: [{ type: 'text' as const, text: refusal }], isError: true };
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

                        // Re-upload as a new UID replacing the old one, carrying the card link (one more
                        // edit) and a fresh preview token, and nothing else of the old metaData — never a
                        // decision, a reason or the old token.
                        const carry = amendCarry(original.metaData, meta);
                        const { id: newUid, previousDeleted } = await wildDuckClient.uploadReplacingDraft({
                            from,
                            to:       toAddresses,
                            subject,
                            text:     body,
                            draft:    true,
                            metaData: carry.metaData,
                        }, uid);

                        // WildDuck's replace is not atomic: if it did not delete the old UID, delete it
                        // now, or failing that mark it superseded so no click, amend or preview uses it.
                        const warning = previousDeleted ? '' : await removeReplacedDraft(uid, newUid);

                        // Always route through approval — amended drafts require human review.
                        return submitOrRequestApproval(
                            newUid,
                            false,
                            warning,
                            // Stryker disable next-line StringLiteral: empty string — successMessage is unreachable when isAllowed=false always routes to approval
                            '',
                            { uid, edits: carry.edits }
                        );
                    })),
                { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } }
            ),

            tool(
                'getRejectedDrafts',
                'List drafts rejected by admin review.',
                {},
                withHealthGuard(options.healthRegistry, 'email', options.reconnectionLoop,
                    withToolErrorHandling('getRejectedDrafts', async (): Promise<CallToolResult> => {
                        const rejectedUids = await searchDraftsByReviewState(wildDuckClient, 'rejected_by_admin');
                        const adminRejectedSection = await buildAdminRejectedSubsection(rejectedUids, wildDuckClient);

                        return mcpTextResult(adminRejectedSection ?? 'No drafts rejected by admin review.');
                    })),
                { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }
            ),
        ],
    });
}
