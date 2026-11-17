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
// eslint-disable-next-line @hughescr/module-boundaries/dependencies -- The MCP server is the email integration's public agent-facing boundary.
import { amendedDraftMeta, draftLockKey, draftsMailboxMessageRefSchema, emailSenderProfileSchema, formatAddressForDisplay, formatAttachmentSize, formatMailboxMessageRef, hasDecisionMarker, isWildDuckAttachmentId, mailboxMessageRefSchema, newPreviewToken, readDraftApprovalMeta, searchDraftsByReviewState, type AttachmentStream, type DraftApprovalMeta, type DraftLocks, type EmailSenderProfile, type MailboxMessageRef, type WildDuckClient, type WildDuckAttachment, type WildDuckAttachmentMeta, type WildDuckMessage, type WildDuckMessageAttachment, type WildDuckUploadPayload } from '@/integrations/email';
import type { ServiceHealthRegistry, ReconnectionLoop, TokenBucketRateLimiter } from '@/services';
import type { PersonAllowlist } from '@/storage';
import { sanitizeFilename, deduplicateFilename, processLocalVideo, createSpawnRunner, createBinarySpawnRunner, createDeadline } from '@/utils';
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

/** What an amend changes; an absent field keeps the draft's own value. */
interface DraftAmendment {
    from:               WildDuckUploadPayload['from']
    subject?:           string
    body?:              string
    to?:                WildDuckUploadPayload['to']
    /** Replaces the draft's Cc; `[]` removes it. */
    cc?:                WildDuckUploadPayload['cc']
    /** Attachments to leave out of the new version: all of them, or every one with one of these filenames. */
    removeAttachments?: 'all' | string[]
}

/**
 * An amend's new UID, the notes for its tool text (what it carried, a threading note or warning,
 * and any warning about its old UID), and the edit number its card will show.
 */
interface AmendedDraft {
    newUid: number
    notes:  string
    edits:  number
}

/**
 * The most attachment bytes an amend carries into the new version, all kept attachments together:
 * WildDuck's own 25 MiB attachment ceiling (`MAX_ALLOWED_ATTACHMENT_SIZE`). The sizes WildDuck
 * reports are checked against it before any fetch, and the fetches then share it as a budget:
 * reading stops, and every fetch is aborted, as soon as the bytes read pass it.
 */
const AMEND_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * The most attachments an amend carries into the new version. It bounds the fetches an amend makes
 * while it holds the draft's key; WildDuck itself sets no count.
 */
const AMEND_MAX_ATTACHMENTS = 50;

/** How long an amend waits for all its kept attachments' bytes while it holds the draft's key. */
const AMEND_ATTACHMENT_DEADLINE_MS = 60_000;

/** How long an amend waits to read its new version back from WildDuck while it holds the draft's key. */
const AMEND_READ_BACK_DEADLINE_MS = 10_000;

/**
 * The reply reference WildDuck stored with a draft uploaded by `replyToEmail` (returned by its
 * message GET as `reference`). Re-passing it on upload makes WildDuck derive In-Reply-To and
 * References from the replied-to message again, as it did for the original draft. Unknown keys
 * are dropped: WildDuck's upload schema rejects them, and its `attachments` key would make
 * WildDuck copy the replied-to message's attachments into the draft.
 */
const replyReferenceSchema = z.object({
    action:  z.enum(['reply', 'replyAll']),
    mailbox: z.string(),
    id:      z.int().positive(),
});

/** A References list as WildDuck returns it (Message-IDs); anything else is unknown. */
const referencesSchema = z.array(z.string());

/** What an amend reads back from its stored new version; a missing Cc or attachment list counts as none. */
const storedDraftSchema = z.object({
    cc:          z.array(z.unknown()).optional(),
    attachments: z.array(z.unknown()).optional(),
    references:  z.unknown().optional(),
});

const THREAD_KEPT_NOTE = ' Its References header matches the original draft\'s, so it stays in the same conversation.';
const THREAD_LOST_WARNING = ' Warning: the amended draft is no longer threaded as a reply to the original conversation; the recipient will see it as a new message. To keep the thread, delete this draft and reply to the original message again with replyToEmail.';
const THREAD_UNVERIFIED_WARNING = ' Warning: could not confirm whether the amended draft is still threaded as a reply; check the draft before it is approved.';

/** How many filenames one tool text lists before it only counts the rest. */
const LISTED_NAMES_MAX = 10;

/** The most characters (grapheme clusters) of one filename a tool text shows. */
const LISTED_NAME_MAX_CHARACTERS = 80;

/** Control characters, and the bidi marks, embeddings, overrides and isolates that can make a name read as another. */
const UNSAFE_NAME_CHARACTERS = /[\p{Cc}\u{61C}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu;

const graphemes = new Intl.Segmenter();

/** A filename from WildDuck or the tool arguments, made safe for tool text: unsafe characters stripped, then cut to {@link LISTED_NAME_MAX_CHARACTERS}. */
function displayName(name: string): string {
    const characters = Array.from(graphemes.segment(name.replaceAll(UNSAFE_NAME_CHARACTERS, '')), ({ segment }) => segment);
    return characters.length > LISTED_NAME_MAX_CHARACTERS
        ? `${characters.slice(0, LISTED_NAME_MAX_CHARACTERS).join('')}…`
        : characters.join('');
}

/** Filenames for tool text, each made safe and quoted, comma-separated: the first {@link LISTED_NAMES_MAX}, then how many more. */
function quotedNames(names: Iterable<string>): string {
    const quoted = Array.from(names, name => JSON.stringify(displayName(name)));
    const listed = quoted.slice(0, LISTED_NAMES_MAX).join(', ');
    return quoted.length > LISTED_NAMES_MAX ? `${listed} and ${quoted.length - LISTED_NAMES_MAX} more` : listed;
}

/** `count` and its noun, singular for one. */
function counted(count: number, singular: string, plural: string): string {
    return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * What to log about a failed WildDuck call: its HTTP status, else its error's name — never its
 * message, which can carry WildDuck's response body.
 */
function failureDetail(err: unknown): { status: number } | { error: string } {
    const status = err instanceof WildDuckError ? err.context?.status : undefined;
    if(typeof status === 'number') {
        return { status };
    }
    return { error: err instanceof Error ? err.name : typeof err };
}

/** The bytes an amend's attachment fetches may still read between them, and the abort that stops them all once those run out. */
interface AttachmentBudget {
    remaining:        number
    readonly overrun: AbortController
}

/**
 * Reads an attachment's bytes, counting each chunk against the amend's shared budget. Once the
 * budget is overrun it stops reading, cancels this body and aborts every other fetch, and returns
 * undefined.
 */
async function readWithinBudget(stream: AttachmentStream, budget: AttachmentBudget): Promise<Buffer | undefined> {
    const chunks: Uint8Array[] = [];
    let overrun = false;
    const reader = stream.body?.getReader();
    if(reader !== undefined) {
        // eslint-disable-next-line no-await-in-loop -- a body's chunks arrive one after another
        for(let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
            budget.remaining -= chunk.value.length;
            if(budget.remaining < 0) {
                overrun = true;
                break;
            }
            chunks.push(chunk.value);
        }
        if(overrun) {
            budget.overrun.abort();
            await reader.cancel();
            return undefined;
        }
    }
    return Buffer.concat(chunks);
}

const CARRY_FETCH_FAILED = 'Could not fetch an attachment to carry into the amended draft';

/**
 * What an amend tells the agent about the Cc and attachments it carried, from the new version as
 * WildDuck stored it: the counts it carried when the stored draft has them, a warning naming both
 * counts when it does not, and that the carry could not be confirmed when the draft could not be
 * read back.
 */
function carryNote(intended: { cc: number, ccGiven: boolean, kept: number, removed: number }, stored: StoredDraft | undefined): string {
    if(stored === undefined) {
        return ` Cc and attachments were sent to WildDuck (${intended.cc} Cc, ${counted(intended.kept, 'attachment', 'attachments')} kept, ${intended.removed} removed) but could not be confirmed on the stored draft.`;
    }
    if(stored.cc === intended.cc && stored.attachments === intended.kept) {
        return carriedNote(intended.cc, intended.ccGiven, intended.kept, intended.removed);
    }
    return ` Warning: the amended draft stores ${counted(stored.cc, 'Cc address', 'Cc addresses')} and ${counted(stored.attachments, 'attachment', 'attachments')}, but ${intended.cc} and ${intended.kept} were intended; check it before it is approved.`;
}

/** An amend's new version as WildDuck stored it: its Cc and attachment counts, and its References (undefined when unreadable). */
interface StoredDraft {
    cc:          number
    attachments: number
    references:  string[] | undefined
}

/** What an amend knows of the original draft's reply threading, worked out before the upload. */
interface ThreadingPlan {
    /** The reply reference to re-pass on upload, when one may be. */
    reference?: z.infer<typeof replyReferenceSchema>
    /** The original's References, or undefined when WildDuck returned something unreadable. */
    expected:   string[] | undefined
    /** Whether the original was a reply: it has a reply reference stored, or References. */
    wasReply:   boolean
}

/**
 * Whether the amended draft kept the original's reply threading: '' for a draft that was not a
 * reply; the threading-lost warning when no reference could be re-passed for a reply, or when the
 * stored new draft's References are empty or differ from the original's; a note when they match;
 * and otherwise — the new draft not read back, or either References unreadable — a warning that it
 * could not be confirmed.
 */
function threadingNote(plan: ThreadingPlan, stored: StoredDraft | undefined): string {
    if(plan.reference === undefined) {
        if(plan.wasReply) {
            return THREAD_LOST_WARNING;
        }
        return plan.expected === undefined ? THREAD_UNVERIFIED_WARNING : '';
    }
    if(plan.expected === undefined || stored?.references === undefined) {
        return THREAD_UNVERIFIED_WARNING;
    }
    const kept = plan.expected.length > 0 && JSON.stringify(stored.references) === JSON.stringify(plan.expected);
    return kept ? THREAD_KEPT_NOTE : THREAD_LOST_WARNING;
}

/** An amend's refusal or failure as an error tool result. */
function amendError(text: string): CallToolResult {
    return { content: [{ type: 'text' as const, text }], isError: true };
}

/** The refusal for kept attachments whose reported sizes total over {@link AMEND_MAX_ATTACHMENT_BYTES}. */
function attachmentsTooLarge(draftRef: string, bytes: number): CallToolResult {
    return amendError(`Could not amend draft ${draftRef}: the attachments it would keep total ${formatAttachmentSize(bytes)}, over the ${formatAttachmentSize(AMEND_MAX_ATTACHMENT_BYTES)} an amend can carry. Nothing was changed; leave some out with removeAttachments, or delete the draft and create a new one.`);
}

/**
 * Why an amend cannot carry the draft's attachments as WildDuck listed them, before any fetch: an
 * id WildDuck could not have issued or one listed twice (on any attachment, kept or not), more kept
 * attachments than {@link AMEND_MAX_ATTACHMENTS}, a kept one whose reported size is not a finite
 * non-negative number, or reported sizes totalling over {@link AMEND_MAX_ATTACHMENT_BYTES}.
 */
function attachmentListRefusal(draftRef: string, attachments: WildDuckMessageAttachment[], keeping: WildDuckMessageAttachment[]): CallToolResult | undefined {
    const ids = attachments.map(attachment => attachment.id);
    if(!ids.every(id => isWildDuckAttachmentId(id)) || new Set(ids).size !== ids.length) {
        return amendError(`Could not amend draft ${draftRef}: WildDuck listed its attachments with an id that is missing, malformed or repeated, so they can't be carried safely. Nothing was changed; delete the draft and create a new one instead.`);
    }
    if(keeping.length > AMEND_MAX_ATTACHMENTS) {
        return amendError(`Could not amend draft ${draftRef}: it would keep ${keeping.length} attachments, more than the ${AMEND_MAX_ATTACHMENTS} an amend can carry. Nothing was changed; leave some out with removeAttachments, or delete the draft and create a new one.`);
    }
    // The reported sizes are only a hint (the bytes read are counted again as they arrive), but one that is unusable refuses.
    const reported = keeping.map(attachment => ({ attachment, bytes: attachment.size ?? attachment.sizeKb * 1024 }));
    const unusable = reported.filter(({ bytes }) => !(Number.isFinite(bytes) && bytes >= 0));
    if(unusable.length > 0) {
        return amendError(`Could not amend draft ${draftRef}: WildDuck did not report a usable size for ${quotedNames(unusable.map(({ attachment }) => attachment.filename))}. Nothing was changed; leave them out with removeAttachments, or delete the draft and create a new one.`);
    }
    const reportedBytes = reported.reduce((total, { bytes }) => total + bytes, 0);
    return reportedBytes > AMEND_MAX_ATTACHMENT_BYTES ? attachmentsTooLarge(draftRef, reportedBytes) : undefined;
}

/** What an amend tells the agent it carried: the new version's Cc and where it came from, and the attachments kept and removed. */
function carriedNote(ccCount: number, ccGiven: boolean, kept: number, removed: number): string {
    const addresses = ccCount === 1 ? 'address' : 'addresses';
    const source = ccGiven ? 'as given in this amend' : 'kept from the original draft';
    return ` Cc: ${ccCount} ${addresses} (${source}). Attachments: ${kept} kept from the original draft, ${removed} removed.`;
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
    // ast-grep-ignore: security-no-weak-hash-literal -- sha1 shortens a stable mailbox/UID cache key for a directory name; it does not protect security or integrity
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
        // ast-grep-ignore: security-no-weak-hash-literal -- sha1 shortens the attachment ID for a directory name; it does not protect security or integrity
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
     * `notes` (a rate limit warning, or an amend's carry notes and warnings) ends every result text.
     */
    async function submitOrRequestApproval(
        draftUid: number,
        isAllowed: boolean,
        notes: string,
        successMessage: string,
        previous?: { uid: number, edits: number }
    ): Promise<CallToolResult> {
        if(isAllowed) {
            await wildDuckClient.submitMessage(EmailFolder.Drafts, draftUid);
            rateLimiter?.increment();
            return mcpTextResult(`${successMessage}${notes}`);
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

    /** Whether a reply goes out without approval: never for replyAll (its Cc included), else when the replied-to address is allowlisted. */
    function isReplyAllowed(mode: 'reply' | 'replyAll', primaryTo: string): boolean {
        return mode !== 'replyAll' && (allowlist?.isAllowed('email', primaryTo) ?? false);
    }

    /** Run `fn` holding draft `uid`'s key when a gate is configured (released on every path), else directly. */
    async function withDraftLock<T>(uid: number, fn: () => Promise<T>): Promise<T> {
        const release = await options.draftLocks?.acquire(draftLockKey(uid));
        try {
            return await fn();
        } finally {
            release?.();
        }
    }

    /**
     * Remove an amended draft's old UID that WildDuck's replace left behind: delete it (already
     * gone counts), or failing that mark it superseded. Returns a warning for the tool text when
     * both failed, else ''. Runs holding `email-draft:<oldUid>`, so the supersede write is the
     * held-lock one and never takes that key again.
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

    /**
     * Fetches one kept attachment's bytes through WildDuck's attachment stream, counted against
     * the amend's shared budget; undefined when it failed (logged by status or error name, never by
     * WildDuck's error text), when its body was not the length WildDuck declared, when the budget
     * ran out, or when another fetch had already aborted them all.
     */
    async function fetchCarried(uid: number, attachment: WildDuckMessageAttachment, budget: AttachmentBudget, signal: AbortSignal): Promise<Buffer | undefined> {
        if(signal.aborted) {
            return undefined;
        }
        try {
            const stream = await wildDuckClient.openAttachmentStream(EmailFolder.Drafts, uid, attachment.id, signal);
            if(stream === null) {
                logger.warn({ uid, attachmentId: attachment.id, status: 404, msg: CARRY_FETCH_FAILED });
                return undefined;
            }
            const bytes = await readWithinBudget(stream, budget);
            if(bytes !== undefined && stream.contentLength !== undefined && bytes.length !== stream.contentLength) {
                logger.warn({ uid, attachmentId: attachment.id, declared: stream.contentLength, read: bytes.length, msg: 'An attachment to carry into the amended draft was not the length WildDuck declared' });
                return undefined;
            }
            return bytes;
        } catch (err) {
            logger.warn({ uid, attachmentId: attachment.id, ...failureDetail(err), msg: CARRY_FETCH_FAILED });
            return undefined;
        }
    }

    /**
     * The original draft's attachments an amend keeps (all but `remove`), with their bytes fetched
     * from the draft in WildDuck — two at a time, under one {@link AMEND_ATTACHMENT_DEADLINE_MS}
     * deadline, sharing one {@link AMEND_MAX_ATTACHMENT_BYTES} budget — and how many were removed.
     * Fails closed: a filename the draft does not have, an attachment list it cannot carry
     * ({@link attachmentListRefusal}), bytes read past the budget (which aborts every fetch) or any
     * fetch that fails returns an error result, so nothing is uploaded and no partial set can be.
     * An inline (`related`) attachment is carried as an ordinary one: the new version is plain
     * text, so it has no HTML that could reference its cid. Runs holding `email-draft:<uid>`.
     */
    async function carriedAttachments(
        uid: number,
        draftRef: string,
        attachments: WildDuckMessageAttachment[],
        remove: 'all' | string[] | undefined
    ): Promise<{ kept: WildDuckAttachment[], removed: number } | CallToolResult> {
        const names = new Set(attachments.map(attachment => attachment.filename));
        const removing = new Set(remove === 'all' ? names : remove);
        const unknown = [...removing].filter(name => !names.has(name));
        if(unknown.length > 0) {
            return amendError(`Could not amend draft ${draftRef}: it has no attachment named ${quotedNames(unknown)} (its attachments: ${quotedNames(names) || 'none'}). Nothing was changed.`);
        }
        const keeping = attachments.filter(attachment => !removing.has(attachment.filename));
        const refusal = attachmentListRefusal(draftRef, attachments, keeping);
        if(refusal !== undefined) {
            return refusal;
        }

        const deadline = createDeadline(AMEND_ATTACHMENT_DEADLINE_MS);
        const budget: AttachmentBudget = { remaining: AMEND_MAX_ATTACHMENT_BYTES, overrun: new AbortController() };
        const signal = AbortSignal.any([deadline.signal, budget.overrun.signal]);
        const limit = pLimit(2);
        const fetched = await Promise.all(keeping.map(attachment => limit(async () => ({ attachment, bytes: await fetchCarried(uid, attachment, budget, signal) }))))
            .finally(() => {
                deadline.clear();
            });

        if(budget.overrun.signal.aborted) {
            return amendError(`Could not amend draft ${draftRef}: the attachments it would keep come to more than the ${formatAttachmentSize(AMEND_MAX_ATTACHMENT_BYTES)} an amend can carry. Nothing was changed; leave some out with removeAttachments, or delete the draft and create a new one.`);
        }
        const kept: WildDuckAttachment[] = [];
        const failed: string[] = [];
        for(const { attachment, bytes } of fetched) {
            if(bytes === undefined) {
                failed.push(attachment.filename);
            } else {
                kept.push({ filename: attachment.filename, contentType: attachment.contentType, content: bytes.toString('base64') });
            }
        }
        if(failed.length > 0) {
            return amendError(`Could not amend draft ${draftRef}: these attachments could not be fetched from WildDuck: ${quotedNames(failed)}. Nothing was changed and the draft is as it was; try again, or leave them out with removeAttachments.`);
        }
        return { kept, removed: attachments.length - keeping.length };
    }

    /** Whether `mailboxId` is WildDuck's id for a mailbox `replyToEmail` may reply from. */
    function isReplyMailbox(mailboxId: string): boolean {
        return Array.from(ACCESSIBLE_MAILBOXES, folder => wildDuckClient.getMailboxId(folder)).includes(mailboxId);
    }

    /**
     * What an amend knows of the original draft's reply threading before it uploads: its stored
     * reply reference, re-passed only when it points into a mailbox `replyToEmail` may reply from
     * and the new version's subject is not empty (WildDuck puts the replied-to message's subject on
     * a draft uploaded with an empty one), and its References, parsed leniently so nothing about
     * them can throw once the old UID is gone.
     */
    function planThreading(original: WildDuckMessage, subject: string): ThreadingPlan {
        const reference = replyReferenceSchema.safeParse(original.reference).data;
        const expected = referencesSchema.safeParse(original.references).data;
        const wasReply = reference !== undefined || (expected !== undefined && expected.length > 0);
        return reference !== undefined && subject !== '' && isReplyMailbox(reference.mailbox)
            ? { reference, expected, wasReply }
            : { expected, wasReply };
    }

    /**
     * Reads an amend's new version back from WildDuck under its own
     * {@link AMEND_READ_BACK_DEADLINE_MS} deadline: its Cc and attachment counts and its
     * References, or undefined when it is not found, unreadable, or the read fails or times out
     * (logged by status or error name, never by WildDuck's error text). Never throws, so the new
     * UID is always reported. Runs holding `email-draft:<oldUid>`.
     */
    async function readBackAmended(newUid: number): Promise<StoredDraft | undefined> {
        const deadline = createDeadline(AMEND_READ_BACK_DEADLINE_MS);
        try {
            const parsed = storedDraftSchema.safeParse(await wildDuckClient.getMessage(EmailFolder.Drafts, newUid, deadline.signal));
            if(!parsed.success) {
                logger.warn({ newUid, msg: 'The amended draft read back from WildDuck was missing or unreadable' });
                return undefined;
            }
            return {
                cc:          parsed.data.cc?.length ?? 0,
                attachments: parsed.data.attachments?.length ?? 0,
                references:  referencesSchema.safeParse(parsed.data.references).data,
            };
        } catch (err) {
            logger.warn({ newUid, ...failureDetail(err), msg: 'Could not read back the amended draft' });
            return undefined;
        } finally {
            deadline.clear();
        }
    }

    /**
     * The locked section of an amend; the caller holds `email-draft:<uid>` throughout. Reads the
     * draft fresh, refuses it when gone, not a draft, approved or already replaced, fetches the
     * attachments it keeps, uploads the new version built from THAT read (subject, body, To and Cc
     * fall back to it; its attachments and, where it may be, its reply reference are carried; the
     * card link and edit number come from it), removes the old UID — WildDuck's replace, else a
     * delete, else `supersededBy` — so no decision can land on the old UID between the read and its
     * removal, and reads the new version back once to check what it stores and its reply threading.
     * Returns the refusal as a tool result, or the new UID, the notes for the tool text and the
     * edit number the card will show.
     */
    async function replaceAmendedDraft(uid: number, draftRef: string, amendment: DraftAmendment): Promise<AmendedDraft | CallToolResult> {
        const original = await wildDuckClient.getMessage(EmailFolder.Drafts, uid);
        if(!original) {
            return amendError(`Draft ${draftRef} not found.`);
        }
        if(original.draft !== true) {
            return amendError(`${draftRef} is not a draft; it can't be amended.`);
        }
        const meta = readDraftApprovalMeta(original.metaData);
        const refusal = amendRefusal(draftRef, meta);
        if(refusal !== undefined) {
            return amendError(refusal);
        }
        const attachments = await carriedAttachments(uid, draftRef, original.attachments ?? [], amendment.removeAttachments);
        if('content' in attachments) {
            return attachments;
        }

        // Re-upload as a new UID replacing the old one, carrying the card link (one more edit) and
        // a fresh preview token, and nothing else of the old metaData — never a decision, a
        // reason or the old token. The explicit To and Cc (empty lists included) win over the
        // recipients WildDuck would derive from the reply reference; the subject wins only when it
        // is not empty, so a reference is passed only with a non-empty one.
        const cc = amendment.cc ?? original.cc ?? [];
        const subject = amendment.subject ?? original.subject ?? '';
        const threading = planThreading(original, subject);
        const carry = amendCarry(original.metaData, meta);
        const { id: newUid, previousDeleted } = await wildDuckClient.uploadReplacingDraft({
            from:        amendment.from,
            to:          amendment.to ?? original.to ?? [],
            cc,
            subject,
            text:        amendment.body ?? original.text ?? '',
            reference:   threading.reference,
            attachments: attachments.kept,
            draft:       true,
            metaData:    carry.metaData,
        }, uid);

        // WildDuck's replace is not atomic: if it did not delete the old UID, delete it now, or
        // failing that mark it superseded so no click, amend or preview uses it.
        const removal = previousDeleted ? '' : await removeReplacedDraft(uid, newUid);
        const stored = await readBackAmended(newUid);
        const carried = carryNote({ cc: cc.length, ccGiven: amendment.cc !== undefined, kept: attachments.kept.length, removed: attachments.removed }, stored);
        return { newUid, notes: `${carried}${threadingNote(threading, stored)}${removal}`, edits: carry.edits };
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

                        // WildDuck assigns a new UID in Archive — report that one, not the caller's
                        // source uid, so a later Archive:<uid> lookup targets the right message.
                        const archivedUid = await wildDuckClient.moveMessage(folder, uid, EmailFolder.Archive);
                        return mcpTextResult(`Email UID ${archivedUid} archived successfully.`);
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
                        // Read, check and delete holding the draft's key, so an approval recorded
                        // meanwhile is seen and its draft kept; the card is marked from this read
                        // after the key is released (lock order is card key, then draft key).
                        const deletion = await withDraftLock(uid, async (): Promise<{ draft: WildDuckMessage, meta: DraftApprovalMeta } | CallToolResult> => {
                            const draft = await wildDuckClient.getMessage(EmailFolder.Drafts, uid);
                            if(!draft) {
                                return { content: [{ type: 'text' as const, text: `Draft ${draftRef} not found.` }], isError: true };
                            }
                            const meta = readDraftApprovalMeta(draft.metaData);
                            if(meta.approval !== undefined) {
                                return { content: [{ type: 'text' as const, text: `Draft ${draftRef} has an admin approval recorded; it can't be deleted.` }], isError: true };
                            }
                            await wildDuckClient.deleteMessage(EmailFolder.Drafts, uid);
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
                'Amend a pending or rejected draft and resubmit it for admin approval. Reads the existing draft, applies your changes, and re-uploads it as a new draft UID, replacing the old one. The new version keeps the draft\'s Cc addresses and attachments (at most 50 attachments, 25 MB in all) unless you override them (cc, removeAttachments), and stays threaded as a reply when the draft was one and its subject is not empty; the result says how many Cc addresses and attachments the stored new version has, and warns if they differ from what was intended, if the reply threading was lost, or if either could not be confirmed. An amend cannot attach new files: delete the draft and create a new one instead. A pending draft\'s approval card is updated in place; a rejected draft gets a new card. A draft the admin has approved cannot be amended.',
                {
                    message:           draftsMailboxMessageRefSchema.describe('The pending or rejected draft to amend, in Drafts:UID format'),
                    subject:           z.string().optional().describe('New subject line (leave blank to keep original)'),
                    body:              z.string().optional().describe('New plain text body (leave blank to keep original)'),
                    to:                z.union([emailAddressSchema, z.array(emailAddressSchema).min(1)]).optional().describe('New To address(es) (leave blank to keep original)'),
                    cc:                z.union([emailAddressSchema, z.array(emailAddressSchema)]).optional().describe('New Cc address(es), replacing the draft\'s Cc: plain address string or {name, email_address} object, or array of either. Omit to keep the draft\'s Cc; pass an empty array to remove every Cc address.'),
                    removeAttachments: z.union([z.literal('all'), z.array(z.string())]).optional().describe('Attachments to drop from the draft: "all", or an array of filenames (each drops every attachment with exactly that name). Omit to keep every attachment. A filename the draft does not have refuses the amend and changes nothing.'),
                    senderProfile:     emailSenderProfileSchema.optional().describe('Sender profile for the From address: formal or informal'),
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
                        const draftRef = formatMailboxMessageRef(args.message);

                        // Normalize args.to and args.cc: undefined → keep the draft's addresses; structured/plain string → array
                        const to = uploadAddresses(normalizeToAddresses(args.to));
                        const cc = uploadAddresses(normalizeToAddresses(args.cc));

                        // Read, refuse, fetch the kept attachments, upload, remove the old UID and read
                        // the new one back holding the draft's key, so an approval recorded meanwhile is
                        // seen (and the draft kept) and none can land on the old UID before it is gone or
                        // superseded (#161). The card is presented after the key is released (lock order
                        // is card key, then draft key).
                        const amended = await withDraftLock(uid, async () => replaceAmendedDraft(uid, draftRef, {
                            from, subject: args.subject, body: args.body, to, cc, removeAttachments: args.removeAttachments,
                        }));
                        if('content' in amended) {
                            return amended;
                        }

                        // Always route through approval — amended drafts require human review.
                        return submitOrRequestApproval(
                            amended.newUid,
                            false,
                            amended.notes,
                            // Stryker disable next-line StringLiteral: empty string — successMessage is unreachable when isAllowed=false always routes to approval
                            '',
                            { uid, edits: amended.edits }
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
