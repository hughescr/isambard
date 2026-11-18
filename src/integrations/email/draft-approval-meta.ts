import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * The approval state a draft carries in its WildDuck `metaData` (#158). metaData lives only in
 * WildDuck's database, never in the RFC822 source a submit sends, so none of this can reach a
 * recipient. WildDuck replaces metaData wholesale on update, so every write to an existing draft
 * must read, merge and write under that draft's lock ({@link draftLockKey}); see
 * `EmailOutboundApprovals`.
 */

/** Where the draft's #admin approval card lives, and how many times it has been edited in place. */
export interface DraftApprovalCardLink {
    channelId: string
    messageId: string
    edits:     number
}

/** The admin's approval, written BEFORE the `email_send` row whose id is `actionId`. */
export interface DraftApprovalMarker {
    actionId: string
    at:       string
}

/** The draft's approval metaData, read leniently: a malformed key is simply absent. */
export interface DraftApprovalMeta {
    card?:         DraftApprovalCardLink
    approval?:     DraftApprovalMarker
    rejectedAt?:   string
    reason?:       string
    /** Set on an old UID only when an amend could not delete it; the UID of its replacement. */
    supersededBy?: number
    previewToken?: string
    /** Hex SHA-256 of the exact HTML part Isambard uploaded with this draft; see {@link readDraftHtmlPart}. */
    htmlSha256?:   string
}

/** The minimal lock the email module needs; the process-wide approval card gate satisfies it. */
export interface DraftLocks {
    acquire(key: string): Promise<() => void>
}

const cardSchema = z.object({
    channelId: z.string().min(1),
    messageId: z.string().min(1),
    edits:     z.number().int().nonnegative(),
});

const htmlSha256Schema = z.string().regex(/^[\da-f]{64}$/u);

const approvalSchema = z.object({
    actionId: z.string().min(1),
    at:       z.string(),
});

/** Keep only the keys whose parse succeeded. */
function parsed<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
    const result = schema.safeParse(value);
    return result.success ? result.data : undefined;
}

function asRecord(metaData: unknown): Record<string, unknown> {
    return typeof metaData === 'object' && metaData !== null && !Array.isArray(metaData) ? metaData as Record<string, unknown> : {};
}

/** Read the draft's approval state from its metaData; never throws. */
export function readDraftApprovalMeta(metaData: unknown): DraftApprovalMeta {
    const raw = asRecord(metaData);
    const meta: DraftApprovalMeta = {
        card:         parsed(cardSchema, raw.approvalCard),
        approval:     parsed(approvalSchema, raw.approval),
        rejectedAt:   parsed(z.string(), raw.rejectedAt),
        reason:       parsed(z.string(), raw.reason),
        supersededBy: parsed(z.number().int(), raw.supersededBy),
        previewToken: parsed(z.string(), raw.previewToken),
        htmlSha256:   parsed(htmlSha256Schema, raw.htmlSha256),
    };
    return Object.fromEntries(Object.entries(meta).filter(([, value]) => value !== undefined));
}

/** Whether a stored draft has an HTML part Isambard uploaded: none, one that verifies (with that HTML), or a marker that does not verify. */
export type DraftHtmlPart = { state: 'none' } | { state: 'verified', html: string } | { state: 'unverified' };

export type DraftHtmlState = DraftHtmlPart['state'];

/** The hex SHA-256 of an HTML part, as the `htmlSha256` marker records it. */
export function htmlDigest(html: string): string {
    return createHash('sha256').update(html, 'utf8').digest('hex');
}

/** The upload-time metaData marker for an HTML part: `{ htmlSha256 }`, or nothing for a body without HTML. */
export function htmlMarker(html: string | undefined): { htmlSha256?: string } {
    return html === undefined ? {} : { htmlSha256: htmlDigest(html) };
}

const htmlPartsSchema = z.array(z.string());

/**
 * Whether a stored draft has a real HTML part. A non-empty `html` proves nothing: WildDuck's
 * indexer synthesises `<p>…</p>` HTML for every plain-text message. So a draft has an HTML part
 * only when its metaData carries a well-formed `htmlSha256` (written with the upload of a new UID
 * whose HTML Isambard rendered) and its stored HTML hashes to it. The stored HTML is WildDuck's
 * parts joined with a newline (as the draft summary and the preview join them) with CRLF read as
 * LF: the only change WildDuck makes to an HTML part Isambard uploads (trimmed, CR-free) is the
 * CRLF line breaks its MIME encoding gives quoted-printable and 7bit parts. No marker is `none`;
 * a marker that is malformed, or that a missing, empty or different HTML does not match, is
 * `unverified`. Never throws.
 */
export function readDraftHtmlPart(metaData: unknown, html: unknown): DraftHtmlPart {
    if(!Object.hasOwn(asRecord(metaData), 'htmlSha256')) {
        return { state: 'none' };
    }
    const parts = htmlPartsSchema.safeParse(html);
    if(!parts.success) {
        return { state: 'unverified' };
    }
    const stored = parts.data.join('\n').replaceAll('\r\n', '\n');
    return stored !== '' && htmlDigest(stored) === readDraftApprovalMeta(metaData).htmlSha256 ? { state: 'verified', html: stored } : { state: 'unverified' };
}

/**
 * What an approved send needs from a draft's metaData, read strictly: the approval marker
 * (parsed as {@link readDraftApprovalMeta} parses it), and whether a `rejectedAt` or a
 * `supersededBy` key is present at all, whatever its value.
 */
export interface DraftSendMeta {
    approval:   DraftApprovalMarker | undefined
    rejected:   boolean
    superseded: boolean
}

/**
 * Read the draft's metaData for an approved send; never throws. Unlike
 * {@link readDraftApprovalMeta}, a malformed `rejectedAt` or `supersededBy` still counts, so a
 * contradicted or garbled draft blocks the send instead of passing as approved.
 */
export function readDraftSendMeta(metaData: unknown): DraftSendMeta {
    const raw = asRecord(metaData);
    return {
        approval:   parsed(approvalSchema, raw.approval),
        rejected:   Object.hasOwn(raw, 'rejectedAt'),
        superseded: Object.hasOwn(raw, 'supersededBy'),
    };
}

/**
 * The draft's metaData with `patch` applied: a shallow spread in which the patch wins, and a
 * key whose patch value is `undefined` is deleted. A missing or non-object metaData counts as empty.
 */
export function mergeDraftMeta(existing: unknown, patch: Record<string, unknown>): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...asRecord(existing), ...patch };
    for(const [key, value] of Object.entries(patch)) {
        if(value === undefined) {
            delete merged[key];
        }
    }
    return merged;
}

/** Whether the admin has decided the draft: an approval marker or a rejection. */
export function hasDecisionMarker(meta: DraftApprovalMeta): boolean {
    return meta.approval !== undefined || meta.rejectedAt !== undefined;
}

/**
 * The metaData an amended draft's new UID is uploaded with: the card link with one more edit,
 * and nothing else — never a decision, a reason, `supersededBy` or the old preview token.
 */
export function amendedDraftMeta(metaData: unknown): Record<string, unknown> {
    const card = readDraftApprovalMeta(metaData).card;
    return card === undefined ? {} : { approvalCard: { ...card, edits: card.edits + 1 } };
}

/** The gate key that serialises every metaData write and decision for one draft. */
export function draftLockKey(uid: number): string {
    return `email-draft:${uid}`;
}

/**
 * A fresh draft preview token (#158): 32 random bytes as 43 base64url characters. Every Drafts
 * upload stores a new one in its metaData, so an amended draft never inherits the old link.
 */
export function newPreviewToken(): string {
    return randomBytes(32).toString('base64url');
}

/** Whether `candidate` is the draft's preview token, compared in constant time; never matches a draft without one. */
export function previewTokenMatches(stored: string | undefined, candidate: string): boolean {
    if(stored === undefined) {
        return false;
    }
    const expected = Buffer.from(stored);
    const actual = Buffer.from(candidate);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
}
