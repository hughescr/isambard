/**
 * The locked section of `amendAndResubmitDraft`: the fresh read of the draft, its refusals, the
 * carried and removed attachments, the replacing upload with its reply threading, the old UID's
 * removal and the read-back that checks what WildDuck stored. The MCP server holds the draft's
 * key around {@link DraftAmender.replaceAmendedDraft} and presents the card afterwards.
 */

import { logger } from '@hughescr/logger';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { carriedAttachments, planLocalAttachments, readLocalAttachments, type LocalAttachmentSource } from './email-attachments';
import { failureDetail, isNotFound } from './email-tool-errors';
import { amendError, counted } from './email-tool-text';
import { EmailFolder } from '@/config';
// eslint-disable-next-line @hughescr/module-boundaries/dependencies -- The MCP server is the email integration's public agent-facing boundary.
import { amendedDraftMeta, newPreviewToken, readDraftApprovalMeta, type DraftApprovalMeta, type WildDuckAttachment, type WildDuckClient, type WildDuckMessage, type WildDuckThreadingHeader, type WildDuckUploadPayload } from '@/integrations/email';
import { createDeadline } from '@/utils';

/** How long an amend waits to read its new version back from WildDuck while it holds the draft's key. */
const AMEND_READ_BACK_DEADLINE_MS = 10_000;

/**
 * The most time all of an amend's WildDuck calls under the draft's key may take together: the
 * read, the attachment fetches (inside their own deadline), the upload, the old UID's delete and
 * the read-back (inside its own {@link AMEND_READ_BACK_DEADLINE_MS}).
 */
export const AMEND_DEADLINE_MS = 120_000;

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
export interface DraftAmendment {
    from:               WildDuckUploadPayload['from']
    subject?:           string
    body?:              string
    to?:                WildDuckUploadPayload['to']
    /** Replaces the draft's Cc; `[]` removes it. */
    cc?:                WildDuckUploadPayload['cc']
    /** Attachments to leave out of the new version: all of them, or every one with one of these filenames. */
    removeAttachments?: 'all' | string[]
    /** Local files to attach to the new version, read from the working directory as `sendEmail` reads its attachments. */
    addAttachments?:    string[]
}

/**
 * An amend's new UID, the notes for its tool text (what it carried, a threading note or warning,
 * and any warning about its old UID), and the edit number its card will show.
 */
export interface AmendedDraft {
    newUid: number
    notes:  string
    edits:  number
}

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
const THREAD_KEPT_VIA_HEADERS_NOTE = `${THREAD_KEPT_NOTE} It was threaded from the original draft's own reply headers, so sending it will not mark the message it replies to as answered.`;
const THREAD_LOST_WARNING = ' Warning: the amended draft is no longer threaded as a reply to the original conversation; the recipient will see it as a new message. To keep the thread, delete this draft and reply to the original message again with replyToEmail.';
const THREAD_UNVERIFIED_WARNING = ' Warning: could not confirm whether the amended draft is still threaded as a reply; check the draft before it is approved.';

/**
 * What an amend tells the agent about the Cc and attachments it carried, from the new version as
 * WildDuck stored it: the counts it carried when the stored draft has them, a warning naming both
 * counts when it does not, and that the carry could not be confirmed when the draft could not be
 * read back.
 */
function carryNote(intended: CarriedCounts, stored: StoredDraft | undefined): string {
    if(stored === undefined) {
        return ` Cc and attachments were sent to WildDuck (${intended.cc} Cc, ${counted(intended.kept, 'attachment', 'attachments')} kept, ${intended.removed} removed, ${intended.added} added) but could not be confirmed on the stored draft.`;
    }
    const attachments = intended.kept + intended.added;
    if(stored.cc === intended.cc && stored.attachments === attachments) {
        return carriedNote(intended);
    }
    return ` Warning: the amended draft stores ${counted(stored.cc, 'Cc address', 'Cc addresses')} and ${counted(stored.attachments, 'attachment', 'attachments')}, but ${intended.cc} and ${attachments} were intended; check it before it is approved.`;
}

/** What an amend sent: its Cc count and whether the amend gave the Cc, and how many attachments it kept, removed and added. */
interface CarriedCounts {
    cc:      number
    ccGiven: boolean
    kept:    number
    removed: number
    added:   number
}

/** An amend's new version as WildDuck stored it: its Cc and attachment counts, and its References (undefined when unreadable). */
interface StoredDraft {
    cc:          number
    attachments: number
    references:  string[] | undefined
}

/**
 * What an amend knows of the original draft's reply threading, worked out before the upload, and
 * how the upload threads the new version: by re-passing the reply reference, or by the original
 * draft's own In-Reply-To and References headers — never both, since WildDuck appends `headers`
 * after the ones it derives from a reference, which would repeat them.
 */
type ThreadingPlan = {
    /** The original's References, or undefined when WildDuck returned something unreadable. */
    expected: string[] | undefined
    /** Whether the original was a reply: it has a reply reference stored, or References. */
    wasReply: boolean
} & ({ reference: z.infer<typeof replyReferenceSchema>, headers?: never } | { headers: WildDuckThreadingHeader[], reference?: never } | { reference?: never, headers?: never });

/**
 * A Message-ID as a reply header may carry it: wildduck-mcp's deliberately bounded dot-atom
 * subset of RFC 5322, angle brackets included, with no comments, folding or whitespace (so no CR
 * or LF either).
 */
const MESSAGE_ID = /^<[\w!#$%&'*+/=?^`{|}~-]+(?:\.[\w!#$%&'*+/=?^`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?>$/u;

/** The longest Message-ID a threading header carries. */
const MESSAGE_ID_MAX_LENGTH = 320;

/** The most References a threading header carries (WildDuck itself derives at most 50). */
const REFERENCES_MAX = 50;

function isMessageId(value: unknown): value is string {
    return typeof value === 'string' && value.length <= MESSAGE_ID_MAX_LENGTH && MESSAGE_ID.test(value) && !value.includes('..');
}

/**
 * The upload's threading headers from an old draft's own In-Reply-To and References, ported from
 * wildduck-mcp's `validateThreading`: one well-formed Message-ID for In-Reply-To, and 1 to
 * {@link REFERENCES_MAX} distinct well-formed ones for References; anything else is no headers at
 * all. The two keys are fixed here and the values are only validated Message-IDs, so nothing
 * from WildDuck can name another header or break a line.
 */
function threadingHeaders(inReplyTo: unknown, references: unknown): WildDuckThreadingHeader[] | undefined {
    if(!isMessageId(inReplyTo) || !Array.isArray(references) || references.length === 0 || references.length > REFERENCES_MAX) {
        return undefined;
    }
    if(!references.every(id => isMessageId(id)) || new Set(references).size !== references.length) {
        return undefined;
    }
    return [{ key: 'In-Reply-To', value: inReplyTo }, { key: 'References', value: references.join(' ') }];
}

/** The upload fields that thread the new version as `plan` says: its reference, or its headers, or neither — never both. */
function threadingFields(plan: ThreadingPlan): Pick<WildDuckUploadPayload, 'reference' | 'headers'> {
    if(plan.reference !== undefined) {
        return { reference: plan.reference };
    }
    return plan.headers === undefined ? {} : { headers: plan.headers };
}

/**
 * Whether the amended draft kept the original's reply threading: '' for a draft that was not a
 * reply; the threading-lost warning when neither the reference nor the original's own headers
 * could thread a reply, when the stored new draft's References are empty, or when both
 * References lists are non-empty and differ; a note when they match (saying, for one threaded by
 * its headers, that sending it will not mark the replied-to message answered); and otherwise —
 * the new draft not read back, either References unreadable, or an original with empty
 * References (nothing to compare the stored ones with) — a warning that it could not be confirmed.
 */
function threadingNote(plan: ThreadingPlan, stored: StoredDraft | undefined): string {
    if(plan.reference === undefined && plan.headers === undefined) {
        if(plan.wasReply) {
            return THREAD_LOST_WARNING;
        }
        return plan.expected === undefined ? THREAD_UNVERIFIED_WARNING : '';
    }
    if(plan.expected === undefined || stored?.references === undefined) {
        return THREAD_UNVERIFIED_WARNING;
    }
    if(stored.references.length === 0) {
        return THREAD_LOST_WARNING;
    }
    if(plan.expected.length === 0) {
        return THREAD_UNVERIFIED_WARNING;
    }
    if(JSON.stringify(stored.references) !== JSON.stringify(plan.expected)) {
        return THREAD_LOST_WARNING;
    }
    return plan.headers === undefined ? THREAD_KEPT_NOTE : THREAD_KEPT_VIA_HEADERS_NOTE;
}

/** What an amend tells the agent it carried: the new version's Cc and where it came from, and the attachments kept, removed and added. */
function carriedNote({ cc, ccGiven, kept, removed, added }: CarriedCounts): string {
    const addresses = cc === 1 ? 'address' : 'addresses';
    const source = ccGiven ? 'as given in this amend' : 'kept from the original draft';
    return ` Cc: ${cc} ${addresses} (${source}). Attachments: ${kept} kept from the original draft, ${removed} removed, ${added} added.`;
}

export interface DraftAmenderDeps {
    wildDuckClient:   WildDuckClient
    /** The mailboxes `replyToEmail` may reply from: only a reference into one of them is re-passed. */
    replyMailboxes:   ReadonlySet<EmailFolder>
    /**
     * Marks `oldUid` replaced by `newUid` when the amend could not delete it; true when marked, and
     * false or undefined when it was not. Called holding `email-draft:<oldUid>`, so it must not take
     * that key (the gate is not re-entrant).
     */
    markSuperseded:   (oldUid: number, newUid: number) => Promise<boolean> | undefined
    /** Where `addAttachments` files are read from: the working directory, through the contained reader. */
    attachmentSource: LocalAttachmentSource
}

/** The amend's locked section, built once per MCP server. */
export interface DraftAmender {
    replaceAmendedDraft(uid: number, draftRef: string, amendment: DraftAmendment, signal: AbortSignal): Promise<AmendedDraft | CallToolResult>
}

export function createDraftAmender(deps: DraftAmenderDeps): DraftAmender {
    const { wildDuckClient } = deps;

    /**
     * Remove an amended draft's old UID that WildDuck's replace left behind: delete it (already
     * gone counts), or failing that mark it superseded. Returns a warning for the tool text when
     * both failed, else ''. Runs holding `email-draft:<oldUid>`, so the supersede write is the
     * held-lock one and never takes that key again. `signal` (the amend's budget) bounds the
     * delete; once it has run out the delete fails at once and the old UID is marked instead, under
     * the supersede write's own deadlines.
     */
    async function removeReplacedDraft(oldUid: number, newUid: number, signal: AbortSignal): Promise<string> {
        try {
            await wildDuckClient.deleteMessage(EmailFolder.Drafts, oldUid, signal);
            return '';
        } catch (err) {
            if(isNotFound(err)) {
                return '';
            }
            logger.warn({ err, oldUid, newUid, msg: 'Could not delete the amended draft’s previous version — marking it superseded' });
        }
        const marked = await deps.markSuperseded(oldUid, newUid) ?? false;
        return marked ? '' : ` Warning: the previous version ${EmailFolder.Drafts}:${oldUid} could not be removed; delete it with deleteDraft.`;
    }

    /** The mailbox `replyToEmail` may reply from whose WildDuck id is `mailboxId`, if any. */
    function replyFolder(mailboxId: string): EmailFolder | undefined {
        return [...deps.replyMailboxes].find(folder => wildDuckClient.getMailboxId(folder) === mailboxId);
    }

    /**
     * How an amend threads the new version of a reply, worked out before it uploads (#200). Its
     * stored reply reference is re-passed only when it points into a mailbox `replyToEmail` may
     * reply from, the new version's subject is not empty (WildDuck puts the replied-to message's
     * subject on a draft uploaded with an empty one), and the message it points at is still there
     * (one bounded read of it by mailbox and UID; once moved, WildDuck would upload the draft
     * unthreaded). Otherwise a reply is threaded from the original draft's own In-Reply-To and
     * References (WildDuck's message GET has no In-Reply-To, so one bounded search reads both),
     * when they are well-formed ({@link threadingHeaders}). Its References are parsed leniently so
     * nothing about them can throw once the old UID is gone. Both reads run under the amend's
     * budget (`signal`) and holding the draft's key; a read that fails throws, before anything is
     * uploaded.
     */
    async function resolveThreading(uid: number, original: WildDuckMessage, subject: string, signal: AbortSignal): Promise<ThreadingPlan> {
        const reference = replyReferenceSchema.safeParse(original.reference).data;
        const expected = referencesSchema.safeParse(original.references).data;
        const wasReply = reference !== undefined || (expected !== undefined && expected.length > 0);
        if(!wasReply) {
            return { expected, wasReply };
        }
        if(reference !== undefined && subject !== '') {
            const folder = replyFolder(reference.mailbox);
            if(folder !== undefined && await wildDuckClient.getMessage(folder, reference.id, signal) !== null) {
                return { reference, expected, wasReply };
            }
        }
        const own = await wildDuckClient.getThreadingHeaders(EmailFolder.Drafts, uid, signal);
        const headers = own === null ? undefined : threadingHeaders(own.inReplyTo, own.references);
        return headers === undefined ? { expected, wasReply } : { headers, expected, wasReply };
    }

    /**
     * The attachments the new version carries — the draft's kept ones, then the files the amend
     * adds — and their counts, or the refusal: the added paths are checked before anything is
     * fetched or read, the kept attachments are fetched from WildDuck, and the added files are read
     * from the working directory within what the kept ones left of the one byte budget.
     */
    async function gatherAttachments(uid: number, draftRef: string, original: WildDuckMessage, amendment: DraftAmendment, signal: AbortSignal): Promise<{ attachments: WildDuckAttachment[], kept: number, removed: number, added: number } | CallToolResult> {
        const plans = planLocalAttachments(deps.attachmentSource.root, amendment.addAttachments ?? []);
        if('problem' in plans) {
            return amendError(`Could not amend draft ${draftRef}: ${plans.problem}. Nothing was changed.`);
        }
        const carried = await carriedAttachments(wildDuckClient, uid, draftRef, original.attachments ?? [], { remove: amendment.removeAttachments, adding: plans.map(plan => plan.filename) }, signal);
        if('content' in carried) {
            return carried;
        }
        const added = await readLocalAttachments(deps.attachmentSource, plans, { remaining: carried.remaining });
        if('problem' in added) {
            return amendError(`Could not amend draft ${draftRef}: ${added.problem}. Nothing was changed.`);
        }
        return { attachments: [...carried.kept, ...added.attachments], kept: carried.kept.length, removed: carried.removed, added: added.attachments.length };
    }

    /**
     * Reads an amend's new version back from WildDuck under its own
     * {@link AMEND_READ_BACK_DEADLINE_MS} deadline: its Cc and attachment counts and its
     * References, or undefined when it is not found, unreadable, or the read fails or times out
     * (logged by status or error name, never by WildDuck's error text). Never throws, so the new
     * UID is always reported. Runs holding `email-draft:<oldUid>`; the amend's budget
     * (`amendSignal`) aborts it too.
     */
    async function readBackAmended(newUid: number, amendSignal: AbortSignal): Promise<StoredDraft | undefined> {
        const deadline = createDeadline(AMEND_READ_BACK_DEADLINE_MS);
        try {
            const parsed = storedDraftSchema.safeParse(await wildDuckClient.getMessage(EmailFolder.Drafts, newUid, AbortSignal.any([deadline.signal, amendSignal])));
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
     * attachments it keeps and reads the files it adds, works out the reply threading
     * ({@link resolveThreading}), uploads the new version built from THAT read (subject, body, To
     * and Cc fall back to it; its attachments and its reply threading are carried; the card link
     * and edit number come from it), removes the old UID — WildDuck's replace, else a
     * delete, else `supersededBy` — so no decision can land on the old UID between the read and its
     * removal, and reads the new version back once to check what it stores and its reply threading.
     * Returns the refusal as a tool result, or the new UID, the notes for the tool text and the
     * edit number the card will show. Every WildDuck call is bounded by `signal`, the amend's
     * {@link AMEND_DEADLINE_MS} budget: one that runs out before or during the upload throws (the
     * upload is never retried); after a successful upload nothing throws, so the new UID is
     * reported with whatever could not be completed (the old UID's removal, the read-back).
     */
    async function replaceAmendedDraft(uid: number, draftRef: string, amendment: DraftAmendment, signal: AbortSignal): Promise<AmendedDraft | CallToolResult> {
        const original = await wildDuckClient.getMessage(EmailFolder.Drafts, uid, signal);
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
        const attachments = await gatherAttachments(uid, draftRef, original, amendment, signal);
        if('content' in attachments) {
            return attachments;
        }

        // Re-upload as a new UID replacing the old one, carrying the card link (one more edit) and
        // a fresh preview token, and nothing else of the old metaData — never a decision, a
        // reason or the old token. The explicit To and Cc (empty lists included) win over the
        // recipients WildDuck would derive from the reply reference; the subject wins only when it
        // is not empty, so a reference is passed only with a non-empty one. A reply is threaded by
        // its reference or by its own headers, never both.
        const cc = amendment.cc ?? original.cc ?? [];
        const subject = amendment.subject ?? original.subject ?? '';
        const threading = await resolveThreading(uid, original, subject, signal);
        const carry = amendCarry(original.metaData, meta);
        const { id: newUid, previousDeleted } = await wildDuckClient.uploadReplacingDraft({
            from:        amendment.from,
            to:          amendment.to ?? original.to ?? [],
            cc,
            subject,
            text:        amendment.body ?? original.text ?? '',
            ...threadingFields(threading),
            attachments: attachments.attachments,
            draft:       true,
            metaData:    carry.metaData,
        }, uid, signal);

        // WildDuck's replace is not atomic: if it did not delete the old UID, delete it now, or
        // failing that mark it superseded so no click, amend or preview uses it.
        const removal = previousDeleted ? '' : await removeReplacedDraft(uid, newUid, signal);
        const stored = await readBackAmended(newUid, signal);
        const carried = carryNote({ cc: cc.length, ccGiven: amendment.cc !== undefined, kept: attachments.kept, removed: attachments.removed, added: attachments.added }, stored);
        return { newUid, notes: `${carried}${threadingNote(threading, stored)}${removal}`, edits: carry.edits };
    }

    return { replaceAmendedDraft };
}
