/**
 * addPapers (#157, design §6.2): add papers by DOI, arXiv id or URL, batch-first.
 *
 * Per call: at most two Crossref and two arXiv requests (the second round only for identifiers found
 * on fetched pages), one paged scan of the library for duplicates, one create for all new parents,
 * then the PDFs through `storePdfs` (one create, per-file upload, one cleanup).
 *
 * Duplicates are found by identity keys (DOI, arXiv id, URL) compared against a complete transient
 * scan of the library, because Zotero's search does not look at DOI, archiveID, url or extra. If the
 * scan fails nothing is created. The whole call holds the shared lock, so the two sessions cannot
 * race between the scan and the create.
 */

import pLimit, { type LimitFunction } from 'p-limit';
import { forceExtension, lastPathSegment, storePdfs } from './files';
import type { UrlFetchResult } from './url-fetch';
import {
    classifyUrl,
    doiIdentityKey,
    fitToTemplate,
    identityKeys,
    normalizeArxivId,
    normalizeDoi,
    parseCitationMeta,
    urlIdentityKey,
    type ArxivId,
    type CitationMeta,
    type IdentitySource,
    type MappedItem,
    type NewItemData,
    type ZoteroClient,
    type ZoteroItem,
    type ZoteroMetadataLookup
} from '@/integrations/zotero';

export type PaperInput = { doi: string } | { arxivId: string } | { url: string };

export interface PaperResult {
    input:             PaperInput
    status:            'added' | 'exists' | 'duplicate' | 'not_found' | 'failed'
    key?:              string
    duplicateOfInput?: number
    title?:            string
    itemType?:         string
    inTrash?:          boolean
    /** `attached`, `already_stored`, `no_candidate`, `skipped`, or `failed: <reason>`. */
    pdf?:              string
    error?:            string
}

export interface AddPapersDeps {
    client:    ZoteroClient
    metadata:  ZoteroMetadataLookup
    /** Shared by both sessions: one addPapers at a time. */
    lock:      LimitFunction
    /** Fetches a page or PDF under the browser host policy and caps. */
    fetchPage: (url: string) => Promise<UrlFetchResult>
    /** Fetches a PDF under the browser host policy and download cap. */
    fetchPdf:  (url: string) => Promise<UrlFetchResult>
    now:       () => number
}

export interface AddPapersOptions {
    collectionKeys?: string[]
    tags?:           string[]
    attachPdf:       boolean
}

type Parsed = { kind: 'doi', doi: string } | { kind: 'arxiv', arxiv: ArxivId } | { kind: 'url', url: string } | { kind: 'invalid', error: string };

type Page = { kind: 'pdf', finalUrl: string, bytes: Uint8Array } | { kind: 'html', finalUrl: string, meta: CitationMeta } | { kind: 'error', error: string };

type Lookup = { found: Map<string, MappedItem> } | { error: string };

/** A resolved input: its metadata and identity keys, or a terminal result. */
type Resolution = { mapped: MappedItem, keys: Set<string>, pdfBytes?: Uint8Array, pdfUrl?: string } | { status: 'not_found' | 'failed', error?: string };

const UNAVAILABLE = 'duplicate check unavailable';

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * A DOI to look up. arXiv-minted DOIs (`10.48550/arXiv.<id>`) are DataCite DOIs that Crossref does
 * not know, so they go to arXiv instead. `doi` has been through `normalizeDoi` (no whitespace), so
 * the capture runs to its end without a `$`.
 */
function routeDoi(doi: string): { kind: 'doi', doi: string } | { kind: 'arxiv', arxiv: ArxivId } {
    const minted = /^10\.48550\/arxiv\.(.+)/i.exec(doi);
    const arxiv = minted === null ? undefined : normalizeArxivId(minted[1]!);
    return arxiv === undefined ? { kind: 'doi', doi } : { kind: 'arxiv', arxiv };
}

function parseInput(input: PaperInput): Parsed {
    if('doi' in input) {
        const doi = normalizeDoi(input.doi);
        return doi === undefined ? { kind: 'invalid', error: `not a DOI: ${input.doi}` } : routeDoi(doi);
    }
    if('arxivId' in input) {
        const arxiv = normalizeArxivId(input.arxivId);
        return arxiv === undefined ? { kind: 'invalid', error: `not an arXiv id: ${input.arxivId}` } : { kind: 'arxiv', arxiv };
    }
    const classified = classifyUrl(input.url);
    if(classified.kind === 'doi') {
        return routeDoi(classified.doi);
    }
    return classified.kind === 'arxiv' ? { kind: 'arxiv', arxiv: classified.arxiv } : { kind: 'url', url: input.url };
}

/** The identifier a fetched page names, if any: its DOI (routed as above), else its arXiv id. */
function pageIdentifier(meta: CitationMeta): { kind: 'doi', doi: string } | { kind: 'arxiv', arxiv: ArxivId } | undefined {
    if(meta.doi !== undefined) {
        return routeDoi(meta.doi);
    }
    return meta.arxiv === undefined ? undefined : { kind: 'arxiv', arxiv: meta.arxiv };
}

async function lookup(fn: (ids: string[]) => Promise<Map<string, MappedItem>>, ids: string[]): Promise<Lookup> {
    const unique = [...new Set(ids)];
    if(unique.length === 0) {
        return { found: new Map() };
    }
    try {
        return { found: await fn(unique) };
    } catch (error) {
        return { error: errorMessage(error) };
    }
}

async function fetchPageFor(deps: AddPapersDeps, url: string): Promise<Page> {
    try {
        const fetched = await deps.fetchPage(url);
        if(fetched.kind === 'pdf') {
            return { kind: 'pdf', finalUrl: fetched.finalUrl, bytes: fetched.bytes };
        }
        const accessDate = new Date(deps.now()).toISOString();
        return { kind: 'html', finalUrl: fetched.finalUrl, meta: parseCitationMeta(new TextDecoder().decode(fetched.bytes), fetched.finalUrl, accessDate) };
    } catch (error) {
        return { kind: 'error', error: errorMessage(error) };
    }
}

function withKeys(mapped: MappedItem, inputKeys: (string | undefined)[], extra: Partial<Resolution> = {}): Resolution {
    const keys = identityKeys(mapped.fields);
    for(const key of inputKeys) {
        if(key !== undefined) {
            keys.add(key);
        }
    }
    return { mapped, keys, ...extra };
}

function fromLookup(result: Lookup, id: string, source: string): Resolution | MappedItem {
    if('error' in result) {
        return { status: 'failed', error: `${source} lookup failed: ${result.error}` };
    }
    return result.found.get(id) ?? { status: 'not_found' };
}

function arxivKey(arxiv: ArxivId): string {
    return `arxiv:${arxiv.id.toLowerCase()}`;
}

/** A PDF fetched by URL becomes a minimal `document`; updateItems can fill it in later. */
function pdfDocument(finalUrl: string, accessDate: string): MappedItem {
    const title = lastPathSegment(finalUrl).replace(/\.pdf$/i, '');
    return {
        itemType:      'document',
        fields:        { title, url: finalUrl, accessDate },
        creators:      [],
        // Stryker disable next-line ArrayDeclaration: this resolution carries the fetched PDF's bytes, so attachFound never reads its candidates
        pdfCandidates: [],
    };
}

/** Round 1 (batched DOIs, arXiv ids, pages) and round 2 (identifiers the pages named), then one resolution per input. */
async function resolveAll(deps: AddPapersDeps, parsed: Parsed[]): Promise<Resolution[]> {
    const dois = parsed.flatMap(p => (p.kind === 'doi' ? [p.doi.toLowerCase()] : []));
    const arxivIds = parsed.flatMap(p => (p.kind === 'arxiv' ? [p.arxiv.id] : []));
    const limit = pLimit(3);
    const [doiRound1, arxivRound1, pages] = await Promise.all([
        lookup(deps.metadata.lookupDois, dois),
        lookup(deps.metadata.lookupArxiv, arxivIds),
        Promise.all(parsed.map(async p => (p.kind === 'url' ? limit(async () => fetchPageFor(deps, p.url)) : undefined))),
    ]);

    const pageIds = pages.map(page => (page?.kind === 'html' ? pageIdentifier(page.meta) : undefined));
    const pageDois = pageIds.flatMap(id => (id?.kind === 'doi' ? [id.doi.toLowerCase()] : [])).filter(doi => !dois.includes(doi));
    const pageArxiv = pageIds.flatMap(id => (id?.kind === 'arxiv' ? [id.arxiv.id] : [])).filter(id => !arxivIds.includes(id));
    const [doiRound2, arxivRound2] = await Promise.all([lookup(deps.metadata.lookupDois, pageDois), lookup(deps.metadata.lookupArxiv, pageArxiv)]);
    const doiResult = (doi: string) => fromLookup(dois.includes(doi) ? doiRound1 : doiRound2, doi, 'Crossref');
    const arxivResult = (id: string) => fromLookup(arxivIds.includes(id) ? arxivRound1 : arxivRound2, id, 'arXiv');
    const accessDate = new Date(deps.now()).toISOString();

    const lookups: Lookups = { doi: doiResult, arxiv: arxivResult };

    return parsed.map((p, index): Resolution => {
        if(p.kind === 'invalid') {
            return { status: 'failed', error: p.error };
        }
        if(p.kind === 'doi') {
            const result = doiResult(p.doi.toLowerCase());
            return 'itemType' in result ? withKeys(result, [doiIdentityKey(p.doi)]) : result;
        }
        if(p.kind === 'arxiv') {
            const result = arxivResult(p.arxiv.id);
            return 'itemType' in result ? withKeys(result, [arxivKey(p.arxiv)]) : result;
        }
        return resolveUrlInput(p.url, pages[index]!, pageIds[index], lookups, accessDate);
    });
}

interface Lookups {
    doi:   (doi: string) => Resolution | MappedItem
    arxiv: (id: string) => Resolution | MappedItem
}

/** A URL input: a PDF becomes a minimal document; a page resolves through the identifier it names, else its own metadata. */
function resolveUrlInput(url: string, page: Page, id: ReturnType<typeof pageIdentifier>, lookups: Lookups, accessDate: string): Resolution {
    if(page.kind === 'error') {
        return { status: 'failed', error: page.error };
    }
    if(page.kind === 'pdf') {
        return withKeys(pdfDocument(page.finalUrl, accessDate), [urlIdentityKey(url)], { pdfBytes: page.bytes, pdfUrl: page.finalUrl });
    }
    const { meta } = page;
    let resolved: MappedItem | Resolution | undefined;
    let identifierKey: string | undefined;
    if(id?.kind === 'doi') {
        resolved = lookups.doi(id.doi.toLowerCase());
        identifierKey = doiIdentityKey(id.doi);
    } else if(id?.kind === 'arxiv') {
        resolved = lookups.arxiv(id.arxiv.id);
        identifierKey = arxivKey(id.arxiv);
    }
    // An identifier the page names but Crossref/arXiv cannot resolve falls back to the page's own metadata.
    const mapped = resolved !== undefined && 'itemType' in resolved ? resolved : meta.item;
    const pdfCandidates = [...new Set([...mapped.pdfCandidates, ...meta.item.pdfCandidates])];
    return withKeys({ ...mapped, pdfCandidates }, [urlIdentityKey(url), urlIdentityKey(page.finalUrl), identifierKey]);
}

/** Union-find over shared identity keys: each input's representative is the first input it shares a key with, transitively. */
function groupDuplicates(resolutions: Resolution[]): { root: number[], keysOf: Map<number, Set<string>> } {
    const root = resolutions.map((_, i) => i);
    const find = (i: number): number => {
        let r = i;
        while(root[r] !== r) {
            r = root[r]!;
        }
        return r;
    };
    const owner = new Map<string, number>();
    for(const [i, resolution] of resolutions.entries()) {
        if(!('keys' in resolution)) {
            continue;
        }
        for(const key of resolution.keys) {
            const other = owner.get(key);
            if(other === undefined) {
                owner.set(key, i);
                continue;
            }
            const [a, b] = [find(other), find(i)];
            root[Math.max(a, b)] = Math.min(a, b);
        }
    }
    const keysOf = new Map<number, Set<string>>();
    for(const [i, resolution] of resolutions.entries()) {
        root[i] = find(i);
        if('keys' in resolution) {
            const keys = keysOf.get(root[i]) ?? new Set<string>();
            for(const key of resolution.keys) {
                keys.add(key);
            }
            keysOf.set(root[i], keys);
        }
    }
    return { root, keysOf };
}

function libraryIndex(items: ZoteroItem[]): Map<string, ZoteroItem> {
    const index = new Map<string, ZoteroItem>();
    for(const item of items) {
        for(const key of identityKeys(item.data as IdentitySource)) {
            if(!index.has(key)) {
                index.set(key, item);
            }
        }
    }
    return index;
}

function isDeleted(data: Record<string, unknown>): boolean {
    return data.deleted === true || data.deleted === 1;
}

async function buildItems(client: ZoteroClient, entries: { index: number, mapped: MappedItem }[], options: AddPapersOptions): Promise<({ item: NewItemData } | { error: string })[]> {
    const types = [...new Set(entries.map(entry => entry.mapped.itemType))];
    const templates = new Map(await Promise.all(types.map(async (type): Promise<[string, Record<string, unknown> | Error]> => {
        try {
            return [type, await client.getItemTemplate(type)];
        } catch (error) {
            return [type, error instanceof Error ? error : new Error(String(error))];
        }
    })));
    return entries.map((entry) => {
        const template = templates.get(entry.mapped.itemType)!;
        if(template instanceof Error) {
            return { error: `no Zotero template for ${entry.mapped.itemType}: ${template.message}` };
        }
        return { item: fitToTemplate(entry.mapped, template, { ...options.tags ? { tags: options.tags } : {}, ...options.collectionKeys ? { collections: options.collectionKeys } : {} }) };
    });
}

/** Tries each candidate URL in order; the first PDF wins. */
async function findPdf(deps: AddPapersDeps, candidates: string[]): Promise<{ bytes: Uint8Array, url: string } | { pdf: string }> {
    if(candidates.length === 0) {
        return { pdf: 'no_candidate' };
    }
    let lastError: unknown;
    for(const url of candidates) {
        try {
            // eslint-disable-next-line no-await-in-loop -- sequential by design: stop at the first candidate that is a PDF
            const fetched = await deps.fetchPdf(url);
            return { bytes: fetched.bytes, url: fetched.finalUrl };
        } catch (error) {
            lastError = error;
        }
    }
    return { pdf: `failed: ${errorMessage(lastError)}` };
}

async function attachFound(deps: AddPapersDeps, added: { index: number, key: string, resolution: Extract<Resolution, { mapped: MappedItem }> }[], results: PaperResult[]): Promise<void> {
    const limit = pLimit(3);
    const found = await Promise.all(added.map(async entry => limit(async () => (entry.resolution.pdfBytes === undefined
        ? findPdf(deps, entry.resolution.mapped.pdfCandidates)
        : { bytes: entry.resolution.pdfBytes, url: entry.resolution.pdfUrl! }))));
    const toStore: { index: number, key: string, bytes: Uint8Array, url: string }[] = [];
    for(const [i, entry] of added.entries()) {
        const outcome = found[i]!;
        if('pdf' in outcome) {
            results[entry.index]!.pdf = outcome.pdf;
        } else {
            toStore.push({ index: entry.index, key: entry.key, ...outcome });
        }
    }
    const stored = await storePdfs(deps.client, toStore.map(entry => ({
        parentKey: entry.key,
        title:     'Full Text PDF',
        filename:  forceExtension(lastPathSegment(entry.url), '.pdf'),
        bytes:     entry.bytes,
    })), deps.now);
    for(const [i, entry] of toStore.entries()) {
        results[entry.index]!.pdf = stored[i]!.pdf;
    }
}

async function run(deps: AddPapersDeps, papers: PaperInput[], options: AddPapersOptions): Promise<PaperResult[]> {
    const results: PaperResult[] = papers.map(input => ({ input, status: 'failed' }));
    const parsed = papers.map(input => parseInput(input));
    if(parsed.every(p => p.kind === 'invalid')) {
        return papers.map((input, i) => ({ input, status: 'failed', error: (parsed[i] as { error: string }).error }));
    }

    const scanning = deps.client.scanTopItems()
        .then((scan): Scan => ({ items: scan.items }))
        .catch((error: unknown): Scan => ({ error: errorMessage(error) }));
    const resolutions = await resolveAll(deps, parsed);
    const toCreate = triage(resolutions, await scanning, results);
    await createAndAttach(deps, toCreate, options, results);
    return results;
}

type Scan = { items: ZoteroItem[] } | { error: string };

type ToCreate = { index: number, resolution: Extract<Resolution, { mapped: MappedItem }> }[];

/** Fills each input's result from its resolution, duplicates and the library scan; returns the inputs to create. */
function triage(resolutions: Resolution[], scan: Scan, results: PaperResult[]): ToCreate {
    const { root, keysOf } = groupDuplicates(resolutions);
    const library = 'items' in scan ? libraryIndex(scan.items) : undefined;
    const toCreate: ToCreate = [];
    for(const [index, resolution] of resolutions.entries()) {
        const result = results[index]!;
        if(!('mapped' in resolution)) {
            Object.assign(result, { status: resolution.status }, resolution.error === undefined ? {} : { error: resolution.error });
            continue;
        }
        result.title = resolution.mapped.fields.title ?? '';
        result.itemType = resolution.mapped.itemType;
        if(library === undefined) {
            result.error = `${UNAVAILABLE}: ${(scan as { error: string }).error}; nothing was added`;
        } else if(root[index] !== index) {
            Object.assign(result, { status: 'duplicate', duplicateOfInput: root[index]! });
        } else if(!markExisting(result, keysOf.get(index)!, library)) {
            toCreate.push({ index, resolution });
        }
    }
    return toCreate;
}

/** Marks `result` as `exists` when any of its keys is in the library; returns whether it did. */
function markExisting(result: PaperResult, keys: Set<string>, library: Map<string, ZoteroItem>): boolean {
    const existing = [...keys].map(key => library.get(key)).find(item => item !== undefined);
    if(existing === undefined) {
        return false;
    }
    const title = existing.data.title;
    Object.assign(result, { status: 'exists', key: existing.key, itemType: existing.data.itemType, inTrash: isDeleted(existing.data) }, typeof title === 'string' ? { title } : {});
    return true;
}

/** One create for every new parent, then their PDFs (or `skipped`). */
async function createAndAttach(deps: AddPapersDeps, toCreate: ToCreate, options: AddPapersOptions, results: PaperResult[]): Promise<void> {
    const built = await buildItems(deps.client, toCreate.map(entry => ({ index: entry.index, mapped: entry.resolution.mapped })), options);
    const creatable = toCreate.flatMap((entry, i) => {
        const item = built[i]!;
        if('error' in item) {
            results[entry.index]!.error = item.error;
            return [];
        }
        return [{ ...entry, item: item.item }];
    });

    // No early `creatable.length === 0` guard: an empty batch already no-ops all the way down
    // (`ZoteroClient#create` chunks nothing and sends no request, and `storePdfs` returns early
    // too), so the guard was a pure micro-optimisation with no observable effect to test.
    const created = await deps.client.createItems(creatable.map(entry => entry.item));
    for(const failure of created.failed) {
        results[creatable[failure.index]!.index]!.error = failure.message;
    }
    const added = created.successful.map((success) => {
        const entry = creatable[success.index]!;
        Object.assign(results[entry.index]!, { status: 'added', key: success.key });
        return { index: entry.index, key: success.key, resolution: entry.resolution };
    });

    if(options.attachPdf) {
        await attachFound(deps, added, results);
    } else {
        for(const entry of added) {
            results[entry.index]!.pdf = 'skipped';
        }
    }
}

/** Adds papers under the shared lock; results are per input, in input order. */
export async function addPapers(deps: AddPapersDeps, papers: PaperInput[], options: AddPapersOptions): Promise<PaperResult[]> {
    return deps.lock(async () => run(deps, papers, options));
}
