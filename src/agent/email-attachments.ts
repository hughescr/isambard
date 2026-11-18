/**
 * Attachment I/O for the email tools: the local files `sendEmail`, `replyToEmail` and an amend
 * attach (read only from Izzy's working directory, through the contained reader), the
 * attachments an amend carries from the original draft (fetched from WildDuck within the same
 * byte budget), and the attachments `getEmailContent` saves for Izzy to open.
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '@hughescr/logger';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import pLimit from 'p-limit';
import { failureDetail, recordEmailToolFailure } from './email-tool-errors';
import { amendError, displayName, quotedNames, UNSAFE_NAME_CHARACTERS } from './email-tool-text';
import { EmailFolder } from '@/config';
import { PathSecurityError, type PathSecurityReason } from '@/errors';
// eslint-disable-next-line @hughescr/module-boundaries/dependencies -- The MCP server is the email integration's public agent-facing boundary.
import { formatAttachmentSize, isWildDuckAttachmentId, type WildDuckAttachment, type WildDuckAttachmentMeta, type WildDuckClient, type WildDuckMessageAttachment } from '@/integrations/email';
import { sanitizeFilename, deduplicateFilename, processLocalVideo, createSpawnRunner, createBinarySpawnRunner, createDeadline, discardBody } from '@/utils';

/**
 * The most attachment bytes one email carries, all its attachments together — local files and,
 * for an amend, the attachments it keeps: WildDuck's own 25 MiB attachment ceiling
 * (`MAX_ALLOWED_ATTACHMENT_SIZE`). Sizes are checked against it before any read (WildDuck's
 * reported sizes, a local file's size on disk), and the reads then share it as a budget: a
 * carried attachment's fetch stops, and every fetch is aborted, as soon as the bytes read pass
 * it, and each local file is read only up to what is left of it.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * The most attachments one email carries, local files and kept attachments together. It bounds
 * the reads and fetches a send or an amend makes (an amend's while it holds the draft's key);
 * WildDuck itself sets no count.
 */
export const MAX_ATTACHMENTS = 50;

/** A local file's content type, by its lower-cased extension; any other is `application/octet-stream`. */
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

/** The longest attachment file name, in UTF-8 bytes. */
const MAX_FILENAME_BYTES = 255;

/**
 * Reads a regular file under `root` (`relPath` relative to it) of at most `maxBytes`, following
 * no symbolic link on the way: {@link openContainedForRead}'s shape, injectable for tests. It
 * rejects with a `PathSecurityError` for every path it refuses.
 */
export type ContainedFileReader = (root: string, relPath: string, maxBytes: number) => Promise<{ bytes: Uint8Array, size: number }>;

/** Where the email tools read attachment files from: Izzy's working directory, through the contained reader. */
export interface LocalAttachmentSource {
    root: string
    read: ContainedFileReader
}

/** A local file to attach: the path as given, the same path relative to the root, and the attachment's name. */
export interface LocalAttachmentPlan {
    given:    string
    relative: string
    filename: string
}

/** Why local attachments were refused, as a clause for the tool text ("the attachment "x" was not found"). */
export interface AttachmentProblem {
    problem: string
}

/** The control characters and bidi marks {@link displayName} strips, as a test (no `g` flag, so no state between calls). */
const UNSAFE_NAME_CHARACTER = new RegExp(UNSAFE_NAME_CHARACTERS.source, 'u');

/** A path as given, made safe for tool text and quoted. */
function shownPath(given: string): string {
    return JSON.stringify(displayName(given));
}

/**
 * Why a file name cannot be an attachment's, ported from wildduck-mcp's filename rules: it is
 * empty, has a control or bidi character, has an `=?` (which mail
 * readers would decode as an RFC 2047 encoded word), starts or ends with whitespace (which
 * WildDuck trims), has a backslash, or is longer than {@link MAX_FILENAME_BYTES}.
 */
function filenameProblem(name: string): string | undefined {
    if(name === '') {
        return 'it is empty';
    }
    if(UNSAFE_NAME_CHARACTER.test(name)) {
        return 'it contains a control or text-direction character';
    }
    if(name.includes('=?')) {
        return 'it contains "=?"';
    }
    if(/^\s|\s$/u.test(name)) {
        return 'it starts or ends with whitespace';
    }
    if(name.includes('\\')) {
        return 'it contains a backslash';
    }
    return Buffer.byteLength(name) > MAX_FILENAME_BYTES ? `it is longer than ${MAX_FILENAME_BYTES} bytes` : undefined;
}

/**
 * The local files to attach, checked before any is read: each path must be well-formed Unicode
 * (normalising would silently replace a lone surrogate), relative to `root` or absolute, must stay
 * inside `root` once normalised, may not have a segment starting with `.` (a hidden file, or one
 * in a hidden folder: `.env`, `.git/…`, `.ssh/…`), and must end in a usable file name
 * ({@link filenameProblem}). The first path that fails, in the order given, is the problem.
 */
export function planLocalAttachments(root: string, filePaths: readonly string[]): LocalAttachmentPlan[] | AttachmentProblem {
    const plans: LocalAttachmentPlan[] = [];
    for(const given of filePaths) {
        if(!given.isWellFormed()) {
            return { problem: `the attachment ${shownPath(given)} is not valid Unicode text` };
        }
        const relative = path.relative(root, path.resolve(root, given));
        const segments = relative.split(path.sep);
        if(segments[0] === '..') {
            return { problem: `the attachment ${shownPath(given)} is outside your working directory` };
        }
        if(segments.some(segment => segment.startsWith('.'))) {
            return { problem: `the attachment ${shownPath(given)} is a hidden file or in a hidden folder (a name starting with ".")` };
        }
        const filename = segments.at(-1)!;
        const nameProblem = filenameProblem(filename);
        if(nameProblem !== undefined) {
            return { problem: `the attachment ${shownPath(given)} has a file name that can't be sent (${nameProblem})` };
        }
        plans.push({ given, relative, filename });
    }
    return plans;
}

/** How a contained read's refusal reads in tool text; any other reason, or another failure, could not be read. */
const READ_REFUSALS: ReadonlyMap<PathSecurityReason, string> = new Map<PathSecurityReason, string>([
    ['not_found', 'was not found'],
    ['is_symlink', 'is a symbolic link'],
    ['not_directory', 'is in a folder that is missing, is a symbolic link or is not a folder'],
    ['not_file', 'is not a regular file'],
    ['hardlinked', 'has more than one hard link'],
    ['changed_during_read', 'changed while it was being read'],
    ['outside_cwd', 'is outside your working directory'],
]);

const TOO_LARGE = `the attachments come to more than the ${formatAttachmentSize(MAX_ATTACHMENT_BYTES)} one email can carry`;

/** The problem for more than {@link MAX_ATTACHMENTS} attachments in one email. */
export function tooManyAttachments(count: number): AttachmentProblem {
    return { problem: `that would be ${count} attachments, more than the ${MAX_ATTACHMENTS} one email can carry` };
}

/**
 * Reads planned local files through the contained reader, two at a time, each capped at what is
 * left of `budget` when its read starts, and counts every file read against it, so the files
 * together can never pass it by more than the reads still running. Fails closed: a read the
 * contained reader refuses (a symbolic link, a missing or non-regular file, one over the cap) or
 * that fails any other way, or files that together pass the budget, is the problem — the first
 * failed read in the order given, else the overrun — and nothing is returned to upload. A file's
 * content type comes from its extension, else `application/octet-stream`.
 */
export async function readLocalAttachments(source: LocalAttachmentSource, plans: readonly LocalAttachmentPlan[], budget: { remaining: number }): Promise<{ attachments: WildDuckAttachment[] } | AttachmentProblem> {
    const limit = pLimit(2);
    const reads = await Promise.allSettled(plans.map(async plan => limit(async (): Promise<WildDuckAttachment> => {
        const { bytes } = await source.read(source.root, plan.relative, Math.max(budget.remaining, 0));
        budget.remaining -= bytes.length;
        const contentType = MIME_TYPE_MAP[path.extname(plan.filename).toLowerCase().slice(1)] ?? 'application/octet-stream';
        return { filename: plan.filename, contentType, content: Buffer.from(bytes).toString('base64') };
    })));
    const attachments: WildDuckAttachment[] = [];
    for(const [index, read] of reads.entries()) {
        if(read.status === 'rejected') {
            const reason: unknown = read.reason;
            if(reason instanceof PathSecurityError && reason.context.reason === 'too_large') {
                return { problem: TOO_LARGE };
            }
            const phrase = (reason instanceof PathSecurityError ? READ_REFUSALS.get(reason.context.reason) : undefined) ?? 'could not be read';
            return { problem: `the attachment ${shownPath(plans[index]!.given)} ${phrase}` };
        }
        attachments.push(read.value);
    }
    return budget.remaining < 0 ? { problem: TOO_LARGE } : { attachments };
}

/**
 * The local files `sendEmail` and `replyToEmail` attach, read from `source.root` only: at most
 * {@link MAX_ATTACHMENTS} files, planned ({@link planLocalAttachments}) before any is read, then
 * read within one {@link MAX_ATTACHMENT_BYTES} budget ({@link readLocalAttachments}).
 */
export async function buildAttachments(source: LocalAttachmentSource, filePaths: readonly string[]): Promise<{ attachments: WildDuckAttachment[] } | AttachmentProblem> {
    if(filePaths.length > MAX_ATTACHMENTS) {
        return tooManyAttachments(filePaths.length);
    }
    const plans = planLocalAttachments(source.root, filePaths);
    if('problem' in plans) {
        return plans;
    }
    return readLocalAttachments(source, plans, { remaining: MAX_ATTACHMENT_BYTES });
}

/** How long an amend waits for all its kept attachments' bytes while it holds the draft's key. */
const AMEND_ATTACHMENT_DEADLINE_MS = 60_000;

/**
 * Where an email's files are saved, keyed by mailbox and UID: its absolute directory and the same
 * directory relative to Izzy's working directory (`attachments/email-<hash>`, the form shown to
 * Izzy). Attachments live in `attachment-<hash>` folders inside it, the full body text beside them.
 */
function emailFilesLocation(mailboxName: string, uid: number): { directory: string, relativeDirectory: string } {
    // ast-grep-ignore: security-no-weak-hash-literal -- sha1 shortens a stable mailbox/UID cache key for a directory name; it does not protect security or integrity
    const hash = createHash('sha1').update(JSON.stringify([mailboxName, uid])).digest('hex');
    return { directory: path.join(process.cwd(), 'attachments', `email-${hash}`), relativeDirectory: `attachments/email-${hash}` };
}

/** The name of the file holding a cut body's full text, in the email's directory. */
const FULL_BODY_FILENAME = 'full-body.txt';

/**
 * Save the whole text of a body that was cut to a file in the email's directory, written afresh on
 * every call (a draft's text can change). Best-effort: a failure is logged and recorded, and
 * becomes a note. Returns the line for the email content display, giving the relative path and the
 * size in bytes.
 */
export async function saveFullEmailBody(mailboxName: string, uid: number, fullBodyText: string): Promise<string> {
    const { directory, relativeDirectory } = emailFilesLocation(mailboxName, uid);
    try {
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, FULL_BODY_FILENAME), fullBodyText, 'utf8');
        return `Full body text (${Buffer.byteLength(fullBodyText)} bytes) saved to ${relativeDirectory}/${FULL_BODY_FILENAME}`;
    } catch (error) {
        const failure = recordEmailToolFailure('getEmailContent', error);
        logger.warn({ reference: failure.reference, msg: 'Failed to save full body text (best-effort)' });
        return `Note: could not save the full body text (${failure.code}; reference ${failure.reference}).`;
    }
}

/**
 * Save email attachments to disk (lazy-fetch from WildDuck, keyed by mailbox, UID, and attachment ID).
 * Returns lines suitable for appending to the email content display.
 */
export async function saveEmailAttachments(
    wildDuckClient: WildDuckClient,
    mailboxName:    string,
    uid:            number,
    attachmentMeta: WildDuckAttachmentMeta[]
): Promise<string[]> {
    const { directory: attachmentDir, relativeDirectory } = emailFilesLocation(mailboxName, uid);
    const usedFilenames = new Set<string>();
    const namedAttachments = attachmentMeta.map((meta) => {
        const safeBase     = sanitizeFilename(meta.filename);
        const safeFilename = deduplicateFilename(safeBase, usedFilenames);
        usedFilenames.add(safeFilename);
        return { meta, safeFilename };
    });
    const limit = pLimit(2);
    const groups = await Promise.all(namedAttachments.map(({ meta, safeFilename }) => limit(() => saveOneEmailAttachment(
        wildDuckClient, mailboxName, uid, meta, safeFilename, attachmentDir, relativeDirectory
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
    relativeDirectory: string
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
        return [`- ${relativeDirectory}/attachment-${attachmentHash}/${safeFilename} (${meta.contentType})`];
    } catch (error) {
        // The failure's own text (WildDuck's response body, say) goes to the log only.
        const failure = recordEmailToolFailure('getEmailContent', error);
        logger.warn({ filename: safeFilename, reference: failure.reference, msg: 'Failed to save attachment (best-effort)' });
        return [`- Note: could not save attachment ${safeFilename} (${failure.code}; reference ${failure.reference}).`];
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

/** The bytes an amend's attachment fetches may still read between them, and the abort that stops them all once those run out. */
interface AttachmentBudget {
    remaining:        number
    readonly overrun: AbortController
}

/**
 * Reads an attachment's bytes, counting each chunk against the amend's shared budget. Once the
 * budget is overrun it stops reading and aborts every other fetch, and returns undefined. Any exit
 * before the body's end (an overrun, or a read that rejects, as an aborted fetch's does) cancels
 * the body, and the reader is released on every path; a cancel that fails rejects, for the caller
 * to log, and the result is a failed fetch either way.
 */
async function readWithinBudget(body: ReadableStream<Uint8Array>, budget: AttachmentBudget): Promise<Buffer | undefined> {
    const reader = body.getReader();
    let complete = false;
    try {
        const chunks: Uint8Array[] = [];
        // eslint-disable-next-line no-await-in-loop -- a body's chunks arrive one after another
        for(let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
            budget.remaining -= chunk.value.length;
            if(budget.remaining < 0) {
                budget.overrun.abort();
                return undefined;
            }
            chunks.push(chunk.value);
        }
        complete = true;
        return Buffer.concat(chunks);
    } finally {
        try {
            if(!complete) {
                await reader.cancel();
            }
        } finally {
            reader.releaseLock();
        }
    }
}

const CARRY_FETCH_FAILED = 'Could not fetch an attachment to carry into the amended draft';

/** The refusal for kept attachments whose reported sizes total over {@link MAX_ATTACHMENT_BYTES}. */
function attachmentsTooLarge(draftRef: string, bytes: number): CallToolResult {
    return amendError(`Could not amend draft ${draftRef}: the attachments it would keep total ${formatAttachmentSize(bytes)}, over the ${formatAttachmentSize(MAX_ATTACHMENT_BYTES)} an amend can carry. Nothing was changed; leave some out with removeAttachments, or delete the draft and create a new one.`);
}

/**
 * Why an amend cannot carry the draft's attachments as WildDuck listed them, before any fetch: an
 * id WildDuck could not have issued or one listed twice (on any attachment, kept or not), more kept
 * attachments than {@link MAX_ATTACHMENTS}, a kept one whose reported size is not a finite
 * non-negative number, or reported sizes totalling over {@link MAX_ATTACHMENT_BYTES}.
 */
function attachmentListRefusal(draftRef: string, attachments: WildDuckMessageAttachment[], keeping: WildDuckMessageAttachment[]): CallToolResult | undefined {
    const ids = attachments.map(attachment => attachment.id);
    if(!ids.every(id => isWildDuckAttachmentId(id)) || new Set(ids).size !== ids.length) {
        return amendError(`Could not amend draft ${draftRef}: WildDuck listed its attachments with an id that is missing, malformed or repeated, so they can't be carried safely. Nothing was changed; delete the draft and create a new one instead.`);
    }
    if(keeping.length > MAX_ATTACHMENTS) {
        return amendError(`Could not amend draft ${draftRef}: it would keep ${keeping.length} attachments, more than the ${MAX_ATTACHMENTS} an amend can carry. Nothing was changed; leave some out with removeAttachments, or delete the draft and create a new one.`);
    }
    // The reported sizes are only a hint (the bytes read are counted again as they arrive), but one that is unusable refuses.
    const reported = keeping.map(attachment => ({ attachment, bytes: attachment.size ?? attachment.sizeKb * 1024 }));
    const unusable = reported.filter(({ bytes }) => !(Number.isFinite(bytes) && bytes >= 0));
    if(unusable.length > 0) {
        return amendError(`Could not amend draft ${draftRef}: WildDuck did not report a usable size for ${quotedNames(unusable.map(({ attachment }) => attachment.filename))}. Nothing was changed; leave them out with removeAttachments, or delete the draft and create a new one.`);
    }
    const reportedBytes = reported.reduce((total, { bytes }) => total + bytes, 0);
    return reportedBytes > MAX_ATTACHMENT_BYTES ? attachmentsTooLarge(draftRef, reportedBytes) : undefined;
}

/**
 * Fetches one kept attachment's bytes through WildDuck's attachment stream, counted against
 * the amend's shared budget. Only a 200 with a body is an attachment; a 200 with no body is one
 * only when WildDuck declared its length as zero. Undefined when it failed (logged by status or
 * error name, never by WildDuck's error text), when WildDuck answered with any other 2xx (its
 * body cancelled unread) or a 200 with no body, when its body was not the length WildDuck
 * declared, when the budget ran out, or when another fetch had already aborted them all.
 */
async function fetchCarried(wildDuckClient: Pick<WildDuckClient, 'openAttachmentStream'>, uid: number, attachment: WildDuckMessageAttachment, budget: AttachmentBudget, signal: AbortSignal): Promise<Buffer | undefined> {
    if(signal.aborted) {
        return undefined;
    }
    try {
        const stream = await wildDuckClient.openAttachmentStream(EmailFolder.Drafts, uid, attachment.id, signal);
        if(stream === null) {
            logger.warn({ uid, attachmentId: attachment.id, status: 404, msg: CARRY_FETCH_FAILED });
            return undefined;
        }
        if(stream.status !== 200) {
            discardBody(stream);
            logger.warn({ uid, attachmentId: attachment.id, status: stream.status, msg: CARRY_FETCH_FAILED });
            return undefined;
        }
        if(stream.body === null) {
            if(stream.contentLength === 0) {
                return Buffer.alloc(0);
            }
            logger.warn({ uid, attachmentId: attachment.id, msg: 'An attachment to carry into the amended draft came back from WildDuck without a body' });
            return undefined;
        }
        const bytes = await readWithinBudget(stream.body, budget);
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
 * deadline, sharing one {@link MAX_ATTACHMENT_BYTES} budget — how many were removed, and what is
 * left of the budget for the files the amend adds (named `change.adding`). Fails closed: a
 * filename the draft does not have, an attachment list it cannot carry
 * ({@link attachmentListRefusal}), added files it cannot take ({@link additionRefusal}), bytes
 * read past the budget (which aborts every fetch) or any fetch that fails returns an error
 * result, so nothing is uploaded and no partial set can be.
 * An inline (`related`) attachment is carried as an ordinary one: the new version is plain
 * text, so it has no HTML that could reference its cid. Runs holding `email-draft:<uid>`; the
 * amend's budget (`amendSignal`) aborts the fetches too.
 */
export async function carriedAttachments(
    wildDuckClient: Pick<WildDuckClient, 'openAttachmentStream'>,
    uid: number,
    draftRef: string,
    attachments: WildDuckMessageAttachment[],
    change: { remove: 'all' | string[] | undefined, adding: readonly string[] },
    amendSignal: AbortSignal
): Promise<{ kept: WildDuckAttachment[], removed: number, remaining: number } | CallToolResult> {
    const names = new Set(attachments.map(attachment => attachment.filename));
    const removing = new Set(change.remove === 'all' ? names : change.remove);
    const unknown = [...removing].filter(name => !names.has(name));
    if(unknown.length > 0) {
        return amendError(`Could not amend draft ${draftRef}: it has no attachment named ${quotedNames(unknown)} (its attachments: ${quotedNames(names) || 'none'}). Nothing was changed.`);
    }
    const keeping = attachments.filter(attachment => !removing.has(attachment.filename));
    const refusal = attachmentListRefusal(draftRef, attachments, keeping) ?? additionRefusal(draftRef, keeping, change.adding);
    if(refusal !== undefined) {
        return refusal;
    }

    const deadline = createDeadline(AMEND_ATTACHMENT_DEADLINE_MS);
    const budget: AttachmentBudget = { remaining: MAX_ATTACHMENT_BYTES, overrun: new AbortController() };
    const signal = AbortSignal.any([deadline.signal, budget.overrun.signal, amendSignal]);
    const limit = pLimit(2);
    const fetched = await Promise.all(keeping.map(attachment => limit(async () => ({ attachment, bytes: await fetchCarried(wildDuckClient, uid, attachment, budget, signal) }))))
        .finally(() => {
            deadline.clear();
        });

    if(budget.overrun.signal.aborted) {
        return amendError(`Could not amend draft ${draftRef}: the attachments it would keep come to more than the ${formatAttachmentSize(MAX_ATTACHMENT_BYTES)} an amend can carry. Nothing was changed; leave some out with removeAttachments, or delete the draft and create a new one.`);
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
    return { kept, removed: attachments.length - keeping.length, remaining: budget.remaining };
}

/**
 * Why an amend cannot add files named `adding` to the attachments it keeps, before any fetch or
 * read: kept and added together would be more than {@link MAX_ATTACHMENTS}, or an added name is
 * a kept attachment's or another added file's.
 */
function additionRefusal(draftRef: string, keeping: readonly WildDuckMessageAttachment[], adding: readonly string[]): CallToolResult | undefined {
    const total = keeping.length + adding.length;
    if(total > MAX_ATTACHMENTS) {
        return amendError(`Could not amend draft ${draftRef}: ${tooManyAttachments(total).problem}. Nothing was changed.`);
    }
    const taken = new Set(keeping.map(attachment => attachment.filename));
    const duplicate = adding.find((name, index) => taken.has(name) || adding.indexOf(name) !== index);
    return duplicate === undefined
        ? undefined
        : amendError(`Could not amend draft ${draftRef}: the added attachment ${JSON.stringify(displayName(duplicate))} has the same name as another attachment of the draft. Nothing was changed.`);
}
