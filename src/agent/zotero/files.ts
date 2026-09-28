/**
 * Zotero file flows for the agent (#157, design §6.3–§6.4).
 *
 * - `storePdfs` is the one path that puts PDFs into the group: one batched create of the attachment
 *   items, the per-file three-step upload (Zotero's protocol is per file), then one cleanup call for
 *   the uploads that failed, which trashes only placeholders that are unchanged and still empty.
 * - `attachPdfs` gets the bytes from a URL (browser host policy and caps) or from a local file under
 *   Izzy's working directory (contained, no-follow read), then calls `storePdfs`.
 * - `downloadAttachments` writes stored files to `<root>/zotero-files/<key>/<name>` with a
 *   contained atomic write, reusing an existing copy whose md5 still matches.
 */

import { createHash } from 'node:crypto';
import pLimit from 'p-limit';
import type { UrlFetchResult } from './url-fetch';
import { ZoteroFileError } from '@/errors';
import { ZOTERO_KEY_PATTERN, type PlaceholderCheck, type ZoteroClient, type ZoteroItem } from '@/integrations/zotero';
import { openContainedForRead, sanitizeFilename, writeContainedAtomic } from '@/utils';

/** Stored content types a download may write, and the extension each is forced to. */
const DOWNLOAD_TYPES = new Map([
    ['application/pdf', '.pdf'],
    ['text/html', '.html'],
    ['text/plain', '.txt'],
]);
const STORED_LINK_MODES = new Set(['imported_file', 'imported_url']);
const DOWNLOAD_DIR = 'zotero-files';
const MAX_BASENAME = 150;
const PDF_MAGIC = '%PDF-';

export interface ZoteroFileDeps {
    client:             ZoteroClient
    /** Izzy's working directory; downloads land under `<root>/zotero-files/`, local uploads are read from under it. */
    root:               string
    /** Cap for Zotero-storage downloads and local-file uploads. */
    maxStoredFileBytes: number
    /** Fetches a PDF by URL under the browser host policy and the browser download cap. */
    fetchPdf:           (url: string) => Promise<UrlFetchResult>
    now:                () => number
}

/** One PDF to store as a new child attachment of `parentKey`. */
export interface PdfToStore {
    parentKey: string
    title:     string
    filename:  string
    bytes:     Uint8Array
}

export interface StoredPdf {
    /** `attached`, `already_stored` (Zotero had these bytes), or `failed: <reason>`. */
    pdf:            string
    attachmentKey?: string
}

function md5Hex(bytes: Uint8Array): string {
    // eslint-disable-next-line sonarjs/hashing -- Zotero's file protocol uses md5 as a content identity; it is not used for security
    return createHash('md5').update(bytes).digest('hex');
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function isPdf(bytes: Uint8Array): boolean {
    return new TextDecoder().decode(bytes.subarray(0, PDF_MAGIC.length)) === PDF_MAGIC;
}

/** A safe file name ending in `extension`: sanitised, capped, and the extension appended when it is not already there. */
export function forceExtension(name: string, extension: string): string {
    const base = sanitizeFilename(name).slice(0, MAX_BASENAME);
    return base.toLowerCase().endsWith(extension) ? base : `${base}${extension}`;
}

/** The decoded last path segment of a URL, or `download`. */
export function lastPathSegment(url: string): string {
    const segment = new URL(url).pathname.split('/').findLast(part => part !== '') ?? '';
    try {
        return decodeURIComponent(segment) || 'download';
    } catch{
        return segment;
    }
}

function describeCleanup(uploadError: string, outcome: { outcome: string, detail?: string }, key: string): string {
    switch(outcome.outcome) {
        case 'trashed': {
            return `failed: ${uploadError}; the empty attachment ${key} was moved to the Trash`;
        }
        case 'changed': {
            return `failed: ${uploadError}; attachment changed concurrently; left as is (key ${key})`;
        }
        default: {
            return `failed: ${uploadError}; ${outcome.detail ?? 'state unknown'} (key ${key})`;
        }
    }
}

/**
 * Creates one attachment item per PDF in a single batch, uploads each file (two at a time), and
 * sends every failed upload to one `cleanupPlaceholders` call. Results are in input order.
 */
export async function storePdfs(client: ZoteroClient, pdfs: PdfToStore[], now: () => number): Promise<StoredPdf[]> {
    const results: StoredPdf[] = pdfs.map(() => ({ pdf: 'failed: not created' }));
    if(pdfs.length === 0) {
        return results;
    }
    const created = await client.createItems(pdfs.map(pdf => ({
        itemType:    'attachment',
        parentItem:  pdf.parentKey,
        linkMode:    'imported_file',
        title:       pdf.title,
        contentType: 'application/pdf',
        filename:    pdf.filename,
        tags:        [],
        relations:   {},
    })));
    for(const failure of created.failed) {
        results[failure.index] = { pdf: `failed: ${failure.message}` };
    }

    const limit = pLimit(2);
    const failedUploads: (PlaceholderCheck & { index: number, error: string })[] = [];
    await Promise.all(created.successful.map(async success => limit(async () => {
        const pdf = pdfs[success.index]!;
        try {
            const outcome = await client.uploadAttachmentFile(success.key, { bytes: pdf.bytes, filename: pdf.filename, contentType: 'application/pdf', mtimeMs: now() });
            results[success.index] = { pdf: outcome === 'uploaded' ? 'attached' : 'already_stored', attachmentKey: success.key };
        } catch (error) {
            failedUploads.push({ index: success.index, key: success.key, createdVersion: success.version, md5: md5Hex(pdf.bytes), error: errorMessage(error) });
        }
    })));

    if(failedUploads.length > 0) {
        failedUploads.sort((a, b) => a.index - b.index);
        const outcomes = await client.cleanupPlaceholders(failedUploads.map(({ key, createdVersion, md5 }) => ({ key, createdVersion, md5 })));
        for(const [i, upload] of failedUploads.entries()) {
            const outcome = outcomes[i]!;
            results[upload.index] = outcome.outcome === 'completed'
                ? { pdf: 'attached', attachmentKey: upload.key }
                : { pdf: describeCleanup(upload.error, outcome, upload.key), attachmentKey: upload.key };
        }
    }
    return results;
}

export interface AttachPdfInput {
    parentKey: string
    source:    { url: string } | { path: string }
    title?:    string
}

interface LoadedPdf {
    bytes:    Uint8Array
    filename: string
}

async function loadPdf(deps: ZoteroFileDeps, source: AttachPdfInput['source']): Promise<LoadedPdf> {
    if('url' in source) {
        const fetched = await deps.fetchPdf(source.url);
        return { bytes: fetched.bytes, filename: forceExtension(lastPathSegment(fetched.finalUrl), '.pdf') };
    }
    const { bytes } = await openContainedForRead(deps.root, source.path, deps.maxStoredFileBytes);
    if(!isPdf(bytes)) {
        throw new ZoteroFileError(`${source.path} is not a PDF`, { reason: 'not_pdf' });
    }
    return { bytes, filename: forceExtension(source.path.split('/').at(-1)!, '.pdf') };
}

/** attachPdfs: every source is loaded (three at a time), then all loaded PDFs are stored together. */
export async function attachPdfs(deps: ZoteroFileDeps, inputs: AttachPdfInput[]): Promise<(StoredPdf & { parentKey: string })[]> {
    const limit = pLimit(3);
    const loaded = await Promise.all(inputs.map(async input => limit(async () => {
        try {
            return { ok: true as const, pdf: await loadPdf(deps, input.source) };
        } catch (error) {
            return { ok: false as const, error: errorMessage(error) };
        }
    })));

    const toStore: { index: number, pdf: PdfToStore }[] = [];
    for(const [index, result] of loaded.entries()) {
        if(result.ok) {
            const input = inputs[index]!;
            toStore.push({ index, pdf: { parentKey: input.parentKey, title: input.title ?? 'Full Text PDF', ...result.pdf } });
        }
    }
    const stored = await storePdfs(deps.client, toStore.map(entry => entry.pdf), deps.now);
    const byIndex = new Map(toStore.map((entry, i) => [entry.index, stored[i]!]));
    return inputs.map((input, index) => {
        const result = loaded[index]!;
        return { parentKey: input.parentKey, ...result.ok ? byIndex.get(index)! : { pdf: `failed: ${result.error}` } };
    });
}

export interface DownloadedFile {
    attachmentKey: string
    parentKey?:    string
    /** Relative to Izzy's working directory. */
    path:          string
    contentType:   string
    bytes:         number
    cached:        boolean
}

export interface SkippedDownload {
    key:    string
    reason: string
}

interface DownloadTarget {
    attachment: ZoteroItem
    parentKey?: string
}

/** Why an attachment cannot be downloaded, or undefined when it can. */
function ineligible(item: ZoteroItem, maxBytes: number): string | undefined {
    const { data } = item;
    if(data.itemType !== 'attachment') {
        return `not an attachment (${data.itemType})`;
    }
    if(!STORED_LINK_MODES.has(String(data.linkMode))) {
        return 'no_stored_file: linked files and links are not stored in Zotero';
    }
    if(!DOWNLOAD_TYPES.has(String(data.contentType))) {
        return `unsupported content type ${String(data.contentType)}`;
    }
    if(!ZOTERO_KEY_PATTERN.test(item.key)) {
        return 'invalid attachment key';
    }
    const length = (item as { links?: { enclosure?: { length?: unknown } } }).links?.enclosure?.length;
    if(typeof length === 'number' && length > maxBytes) {
        return `too_large: ${length} bytes is over the ${maxBytes}-byte limit`;
    }
    return undefined;
}

async function resolveTargets(deps: ZoteroFileDeps, keys: string[]): Promise<{ targets: DownloadTarget[], skipped: SkippedDownload[] }> {
    const { items, missing } = await deps.client.getItems(keys);
    const skipped: SkippedDownload[] = missing.map(key => ({ key, reason: 'not_found' }));
    const targets = new Map<string, DownloadTarget>();
    const parents: ZoteroItem[] = [];
    for(const item of items) {
        if(item.data.itemType === 'attachment') {
            const reason = ineligible(item, deps.maxStoredFileBytes);
            if(reason === undefined) {
                targets.set(item.key, { attachment: item });
            } else {
                skipped.push({ key: item.key, reason });
            }
        } else if(item.data.itemType === 'note' || item.data.itemType === 'annotation') {
            skipped.push({ key: item.key, reason: `not an attachment (${item.data.itemType})` });
        } else {
            parents.push(item);
        }
    }

    if(parents.length > 0) {
        await addChildTargets(deps, parents, targets, skipped);
    }
    return { targets: [...targets.values()], skipped };
}

/** Each parent's downloadable attachments, unless already a target; a parent with none is skipped. */
async function addChildTargets(deps: ZoteroFileDeps, parents: ZoteroItem[], targets: Map<string, DownloadTarget>, skipped: SkippedDownload[]): Promise<void> {
    const children = await deps.client.getChildren(parents.map(parent => parent.key));
    for(const parent of parents) {
        const eligible = (children.get(parent.key) ?? []).filter(child => child.data.itemType === 'attachment' && ineligible(child, deps.maxStoredFileBytes) === undefined);
        if(eligible.length === 0) {
            skipped.push({ key: parent.key, reason: 'no_stored_file: no stored PDF, HTML or text attachment within the size limit' });
        }
        for(const child of eligible.filter(entry => !targets.has(entry.key))) {
            targets.set(child.key, { attachment: child, parentKey: parent.key });
        }
    }
}

async function cachedCopy(deps: ZoteroFileDeps, relPath: string, md5: unknown): Promise<Uint8Array | undefined> {
    if(typeof md5 !== 'string') {
        return undefined;
    }
    try {
        const { bytes } = await openContainedForRead(deps.root, relPath, deps.maxStoredFileBytes);
        return md5Hex(bytes) === md5 ? bytes : undefined;
    } catch{
        // A symlink, hard link, missing file or anything else is simply "not cached"; it is replaced below.
        return undefined;
    }
}

async function downloadOne(deps: ZoteroFileDeps, target: DownloadTarget): Promise<DownloadedFile> {
    const { attachment } = target;
    const { data } = attachment;
    const contentType = String(data.contentType);
    const extension = DOWNLOAD_TYPES.get(contentType)!;
    const nameSource = [data.filename, data.title].find(value => typeof value === 'string' && value !== '') as string | undefined;
    const name = forceExtension(nameSource ?? attachment.key, extension);
    const relPath = `${DOWNLOAD_DIR}/${attachment.key}/${name}`;
    const base = { attachmentKey: attachment.key, ...target.parentKey === undefined ? {} : { parentKey: target.parentKey }, path: relPath, contentType };

    const cached = await cachedCopy(deps, relPath, data.md5);
    if(cached !== undefined) {
        return { ...base, bytes: cached.length, cached: true };
    }

    const { bytes } = await deps.client.downloadAttachmentFile(attachment.key, deps.maxStoredFileBytes);
    if(contentType === 'application/pdf' && !isPdf(bytes)) {
        throw new ZoteroFileError(`The stored file for ${attachment.key} is not a PDF`, { reason: 'not_pdf', key: attachment.key });
    }
    if(typeof data.md5 === 'string' && md5Hex(bytes) !== data.md5) {
        throw new ZoteroFileError(`The downloaded file for ${attachment.key} does not match its md5; nothing was written`, { reason: 'md5_mismatch', key: attachment.key });
    }
    await writeContainedAtomic(deps.root, [DOWNLOAD_DIR, attachment.key], name, bytes);
    return { ...base, bytes: bytes.length, cached: false };
}

/**
 * Downloads the stored files of the given attachments, or of the stored PDF/HTML/text attachments
 * of the given parent items, two at a time. Each failure is reported in `skipped`.
 */
export async function downloadAttachments(deps: ZoteroFileDeps, keys: string[]): Promise<{ files: DownloadedFile[], skipped: SkippedDownload[] }> {
    const { targets, skipped } = await resolveTargets(deps, keys);
    const limit = pLimit(2);
    const outcomes = await Promise.all(targets.map(async target => limit(async () => {
        try {
            return { file: await downloadOne(deps, target) };
        } catch (error) {
            return { skip: { key: target.attachment.key, reason: errorMessage(error) } };
        }
    })));
    const files: DownloadedFile[] = [];
    for(const outcome of outcomes) {
        if(outcome.file) {
            files.push(outcome.file);
        } else {
            skipped.push(outcome.skip);
        }
    }
    return { files, skipped };
}
