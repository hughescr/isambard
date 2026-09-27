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
    };
    return Object.fromEntries(Object.entries(meta).filter(([, value]) => value !== undefined));
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
