/**
 * Mutation-kill tests for `src/agent/zotero/add-papers.ts` (#157, group add-papers).
 *
 * A separate file from `add-papers.test.ts` so parallel mutant-killing work does not conflict; the
 * harness below is a trimmed copy of that file's `setup()` plus the `doiError`/`arxivError` options
 * this group's survivors need. No network, no real timers, no dynamic imports.
 */
import { describe, expect, test } from 'bun:test';
import pLimit from 'p-limit';
import { addPapers, type AddPapersDeps, type PaperInput } from '../../../../src/agent/zotero/add-papers';
import type { UrlFetchResult } from '../../../../src/agent/zotero/url-fetch';
import { ZoteroMetadataError, ZoteroUrlFetchError } from '../../../../src/errors';
import type { MappedItem } from '../../../../src/integrations/zotero';
import journalTemplate from '../../../fixtures/zotero/template-journalArticle.json';
import preprintTemplate from '../../../fixtures/zotero/template-preprint.json';
import webpageTemplate from '../../../fixtures/zotero/template-webpage.json';
import { FakeZoteroServer, clientFor, type RecordedCall } from '../../../helpers/zotero-fake';

const PDF = new TextEncoder().encode('%PDF-1.7 paper');
const DOCUMENT_TEMPLATE = { itemType: 'document', title: '', creators: [{ creatorType: 'author', firstName: '', lastName: '' }], url: '', accessDate: '', extra: '', tags: [], collections: [], relations: {} };
const NO_PDF = { attachPdf: false };

function journal(doi: string, title: string, pdfCandidates: string[] = []): MappedItem {
    return { itemType: 'journalArticle', fields: { title, DOI: doi, url: `https://doi.org/${doi}` }, creators: [{ creatorType: 'author', firstName: 'Ada', lastName: 'Lovelace' }], pdfCandidates };
}

/** A journal item whose only identity fields are DOI and a URL that does not derive from the DOI (for key-fallback tests). */
function journalWithUrl(doi: string, title: string, url: string): MappedItem {
    return { itemType: 'journalArticle', fields: { title, DOI: doi, url }, creators: [], pdfCandidates: [] };
}

/** An arXiv-metadata result with no `archiveID`/`DOI`/`url` field of its own, so its only identity key comes from `arxivKey`. */
function bareArxiv(title: string): MappedItem {
    return { itemType: 'preprint', fields: { title }, creators: [], pdfCandidates: [] };
}

function html(head: string, url: string): UrlFetchResult {
    return { finalUrl: url, kind: 'html', bytes: new TextEncoder().encode(`<html><head>${head}</head><body></body></html>`), truncated: false };
}

function pdfResult(url: string): UrlFetchResult {
    return { finalUrl: url, kind: 'pdf', bytes: PDF, truncated: false };
}

interface Harness {
    server:     FakeZoteroServer
    deps:       AddPapersDeps
    doiCalls:   string[][]
    arxivCalls: string[][]
    pageCalls:  string[]
    pdfCalls:   string[]
}

function setup(options: {
    dois?:       Record<string, MappedItem>
    arxiv?:      Record<string, MappedItem>
    pages?:      Record<string, UrlFetchResult | Error>
    pdfs?:       Record<string, UrlFetchResult | Error>
    configure?:  (server: FakeZoteroServer) => void
    doiError?:   Error
    arxivError?: Error
} = {}): Harness {
    const server = new FakeZoteroServer();
    server.templates.set('journalArticle', journalTemplate);
    server.templates.set('preprint', preprintTemplate);
    server.templates.set('webpage', webpageTemplate);
    server.templates.set('document', DOCUMENT_TEMPLATE);
    options.configure?.(server);
    const doiCalls: string[][] = [];
    const arxivCalls: string[][] = [];
    const pageCalls: string[] = [];
    const pdfCalls: string[] = [];
    const answer = (table: Record<string, UrlFetchResult | Error> | undefined, url: string): UrlFetchResult => {
        const result = table?.[url];
        if(result === undefined) {
            throw new ZoteroUrlFetchError(`Fetching ${url} failed: HTTP 404`, { url, reason: 'HTTP 404', status: 404 });
        }
        if(result instanceof Error) {
            throw result;
        }
        return result;
    };
    const deps: AddPapersDeps = {
        client:   clientFor(server),
        metadata: {
            lookupDois: async (dois) => {
                doiCalls.push(dois);
                if(options.doiError) {
                    throw options.doiError;
                }
                return new Map(dois.flatMap(doi => (options.dois?.[doi] ? [[doi, options.dois[doi]]] : [])));
            },
            lookupArxiv: async (ids) => {
                arxivCalls.push(ids);
                if(options.arxivError) {
                    throw options.arxivError;
                }
                return new Map(ids.flatMap(id => (options.arxiv?.[id] ? [[id, options.arxiv[id]]] : [])));
            },
        },
        lock:      pLimit(1),
        fetchPage: async (url) => {
            pageCalls.push(url);
            return answer(options.pages, url);
        },
        fetchPdf: async (url) => {
            pdfCalls.push(url);
            return answer(options.pdfs, url);
        },
        now: () => Date.UTC(2026, 8, 27),
    };
    return { server, deps, doiCalls, arxivCalls, pageCalls, pdfCalls };
}

function pathOf(call: RecordedCall): string {
    return new URL(call.url).pathname.replace('/groups/6692257', '');
}

function creates(server: FakeZoteroServer): { itemType?: string, title?: string, filename?: string }[][] {
    return server.calls.filter(call => call.method === 'POST' && pathOf(call) === '/items').map(call => JSON.parse(call.bodyText!) as { itemType?: string, title?: string, filename?: string }[]);
}

/** Flushes microtasks (no real timers) until `check` passes or `max` turns run out. */
async function flushUntil(check: () => boolean, max = 300): Promise<void> {
    for(let i = 0; i < max && !check(); i++) {
        // eslint-disable-next-line no-await-in-loop -- polling microtasks by design, no real delay
        await Promise.resolve();
    }
}

describe('addPapers mutant kills (add-papers group)', () => {
    describe('routeDoi anchoring', () => {
        test('does not route a DOI that merely contains an arXiv-minted DOI as a substring to arXiv', async () => {
            const { deps, doiCalls, arxivCalls } = setup();
            const doi = '10.1000/10.48550/arxiv.2101.00001';

            const [result] = await addPapers(deps, [{ doi }], NO_PDF);

            expect(doiCalls).toEqual([[doi]]);
            expect(arxivCalls).toEqual([]);
            expect(result).toEqual({ input: { doi }, status: 'not_found' });
        });
    });

    describe('arxivKey', () => {
        test('uses the lowercased arXiv id as the identity key when the item carries no archiveID of its own', async () => {
            const { deps } = setup({
                arxiv:     { 'hep-th/9901001': bareArxiv('Old style') },
                configure: s => s.addItem({ key: 'EXSTHKEY', itemType: 'preprint', archiveID: 'arXiv:hep-th/9901001' }),
            });

            const [result] = await addPapers(deps, [{ arxivId: 'hep-th/9901001' }], NO_PDF);

            expect(result).toMatchObject({ status: 'exists', key: 'EXSTHKEY' });
        });
    });

    describe('pdfDocument title', () => {
        test('only strips a trailing .pdf extension from the document title, not one mid-name', async () => {
            const url = 'https://files.test/report.pdf.old';
            const { server, deps } = setup({ pages: { [url]: pdfResult(url) } });

            const [result] = await addPapers(deps, [{ url }], NO_PDF);

            expect(result.title).toBe('report.pdf.old');
            expect(creates(server)[0][0]).toMatchObject({ title: 'report.pdf.old' });
        });
    });

    describe('page-fetch concurrency', () => {
        test('fetches at most 3 pages at once, not 2 and not 4', async () => {
            const { deps } = setup();
            const started: string[] = [];
            const gates: (() => void)[] = [];
            deps.fetchPage = async url => new Promise<UrlFetchResult>((resolve) => {
                started.push(url);
                gates.push(() => resolve(html('<title>T</title>', url)));
            });
            const urls = ['https://x.test/1', 'https://x.test/2', 'https://x.test/3', 'https://x.test/4'];

            const resultPromise = addPapers(deps, urls.map(url => ({ url })), NO_PDF);
            await flushUntil(() => started.length >= 3);
            expect(started).toEqual(urls.slice(0, 3));

            gates[0]();
            await flushUntil(() => started.length >= 4);
            expect(started).toEqual(urls);

            for(const gate of gates) {
                gate();
            }
            await resultPromise;
        });
    });

    describe('round-2 dedup against round 1', () => {
        test('does not send a duplicate round-2 DOI lookup for a DOI a page names that round 1 already covers', async () => {
            const { deps, doiCalls } = setup({
                dois:  { '10.1000/a': journal('10.1000/a', 'A') },
                pages: { 'https://pub.test/a': html('<meta name="citation_doi" content="10.1000/A">', 'https://pub.test/a') },
            });

            await addPapers(deps, [{ doi: '10.1000/a' }, { url: 'https://pub.test/a' }], NO_PDF);

            expect(doiCalls).toEqual([['10.1000/a']]);
        });

        test('does not send a duplicate round-2 arXiv lookup for an arXiv id a page names that round 1 already covers', async () => {
            const { deps, arxivCalls } = setup({
                arxiv: { '2101.00001': journal('2101.00001', 'P') },
                pages: { 'https://pub.test/p': html('<meta name="citation_arxiv_id" content="2101.00001">', 'https://pub.test/p') },
            });

            await addPapers(deps, [{ arxivId: '2101.00001' }, { url: 'https://pub.test/p' }], NO_PDF);

            expect(arxivCalls).toEqual([['2101.00001']]);
        });
    });

    describe('lookup failure labels', () => {
        test('labels a failed arXiv metadata batch "arXiv", not blank', async () => {
            const { deps } = setup({ arxivError: new ZoteroMetadataError('arXiv request rejected', { source: 'arxiv' }) });

            const [result] = await addPapers(deps, [{ arxivId: '2101.00001' }], NO_PDF);

            expect(result).toEqual({ input: { arxivId: '2101.00001' }, status: 'failed', error: 'arXiv lookup failed: arXiv request rejected' });
        });
    });

    describe('identity keys added on top of an item\'s own fields', () => {
        test('adds the input DOI as an identity key even when the resolved item carries no DOI field', async () => {
            const { deps } = setup({
                dois:      { '10.1000/a': { itemType: 'journalArticle', fields: { title: 'A' }, creators: [], pdfCandidates: [] } },
                configure: s => s.addItem({ key: 'EXSTDKEY', DOI: '10.1000/a' }),
            });

            const [result] = await addPapers(deps, [{ doi: '10.1000/a' }], NO_PDF);

            expect(result).toMatchObject({ status: 'exists', key: 'EXSTDKEY' });
        });

        test('finds an existing PDF item by the original URL even when the fetch followed a redirect', async () => {
            const { deps } = setup({
                pages:     { 'https://short.test/x': pdfResult('https://cdn.test/actual.pdf') },
                configure: s => s.addItem({ key: 'EXSTUKEY', itemType: 'document', url: 'https://short.test/x' }),
            });

            const [result] = await addPapers(deps, [{ url: 'https://short.test/x' }], NO_PDF);

            expect(result).toMatchObject({ status: 'exists', key: 'EXSTUKEY' });
        });
    });

    describe('libraryIndex duplicate keys', () => {
        test('keeps the first library item at a duplicated identity key, not the last one scanned', async () => {
            const { deps } = setup({
                dois:      { '10.1000/a': journal('10.1000/a', 'A') },
                configure: (s) => {
                    s.addItem({ key: 'FRSTIKEY', DOI: '10.1000/a', dateAdded: '2020-01-01T00:00:00.000Z' });
                    s.addItem({ key: 'SCNDIKEY', DOI: '10.1000/a', dateAdded: '2021-01-01T00:00:00.000Z' });
                },
            });

            const [result] = await addPapers(deps, [{ doi: '10.1000/a' }], NO_PDF);

            expect(result.key).toBe('FRSTIKEY');
        });
    });

    describe('isDeleted', () => {
        test('reports a duplicate whose deleted field is the literal boolean true as in the trash', async () => {
            const { deps } = setup({ dois: { '10.1000/a': journal('10.1000/a', 'A') }, configure: s => s.addItem({ key: 'EXSTTKEY', DOI: '10.1000/a', deleted: true }) });

            const [result] = await addPapers(deps, [{ doi: '10.1000/a' }], NO_PDF);

            expect(result).toMatchObject({ status: 'exists', inTrash: true });
        });
    });

    describe('PDF-fetch concurrency', () => {
        test('fetches at most 3 PDFs at once, not 2 and not 4', async () => {
            const { deps } = setup({
                dois: {
                    '10.1000/a': journal('10.1000/a', 'A', ['https://pdf.test/a.pdf']),
                    '10.1000/b': journal('10.1000/b', 'B', ['https://pdf.test/b.pdf']),
                    '10.1000/c': journal('10.1000/c', 'C', ['https://pdf.test/c.pdf']),
                    '10.1000/d': journal('10.1000/d', 'D', ['https://pdf.test/d.pdf']),
                },
            });
            const started: string[] = [];
            const gates: (() => void)[] = [];
            deps.fetchPdf = async url => new Promise<UrlFetchResult>((resolve) => {
                started.push(url);
                gates.push(() => resolve(pdfResult(url)));
            });
            const papers: PaperInput[] = [{ doi: '10.1000/a' }, { doi: '10.1000/b' }, { doi: '10.1000/c' }, { doi: '10.1000/d' }];

            const resultPromise = addPapers(deps, papers, { attachPdf: true });
            await flushUntil(() => started.length >= 3);
            expect(started).toEqual(['https://pdf.test/a.pdf', 'https://pdf.test/b.pdf', 'https://pdf.test/c.pdf']);

            gates[0]();
            await flushUntil(() => started.length >= 4);
            expect(started).toEqual(['https://pdf.test/a.pdf', 'https://pdf.test/b.pdf', 'https://pdf.test/c.pdf', 'https://pdf.test/d.pdf']);

            for(const gate of gates) {
                gate();
            }
            await resultPromise;
        });
    });

    describe('storing multiple PDFs', () => {
        test('stores PDFs in the order the papers were given, not reversed', async () => {
            const { server, deps } = setup({
                dois: {
                    '10.1000/a': journal('10.1000/a', 'A', ['https://pdf.test/a.pdf']),
                    '10.1000/b': journal('10.1000/b', 'B', ['https://pdf.test/b.pdf']),
                },
                pdfs: {
                    'https://pdf.test/a.pdf': pdfResult('https://pdf.test/a.pdf'),
                    'https://pdf.test/b.pdf': pdfResult('https://pdf.test/b.pdf'),
                },
            });

            await addPapers(deps, [{ doi: '10.1000/a' }, { doi: '10.1000/b' }], { attachPdf: true });

            const attachmentBatch = creates(server)[1];
            expect(attachmentBatch.map(item => item.filename)).toEqual(['a.pdf', 'b.pdf']);
        });
    });

    describe('stored PDF filename', () => {
        test('forces a .pdf extension onto a stored attachment filename that lacks one', async () => {
            const { server, deps } = setup({
                dois: { '10.1000/a': journal('10.1000/a', 'A', ['https://oa.test/paper']) },
                pdfs: { 'https://oa.test/paper': pdfResult('https://oa.test/paper') },
            });

            await addPapers(deps, [{ doi: '10.1000/a' }], { attachPdf: true });

            expect(creates(server)[1][0].filename).toBe('paper.pdf');
        });
    });

    describe('result shape', () => {
        test('does not set an error property on a not-found result', async () => {
            const { deps } = setup();

            const [result] = await addPapers(deps, [{ doi: '10.1000/zzz' }], NO_PDF);

            expect(Object.hasOwn(result, 'error')).toBe(false);
        });

        test('defaults an added item\'s title to empty string when the resolved item has none', async () => {
            const { deps } = setup({ dois: { '10.1000/a': { itemType: 'document', fields: { url: 'https://x.test/a' }, creators: [], pdfCandidates: [] } } });

            const [result] = await addPapers(deps, [{ doi: '10.1000/a' }], NO_PDF);

            expect(result.status).toBe('added');
            expect(result.title).toBe('');
        });
    });

    describe('creating multiple new items', () => {
        test('creates new items in input order, not reversed', async () => {
            const { server, deps } = setup({ dois: { '10.1000/a': journal('10.1000/a', 'A'), '10.1000/b': journal('10.1000/b', 'B') } });

            await addPapers(deps, [{ doi: '10.1000/a' }, { doi: '10.1000/b' }], NO_PDF);

            expect(creates(server)[0].map(item => item.title)).toEqual(['A', 'B']);
        });
    });

    describe('markExisting key fallback', () => {
        test('falls back to a later identity key when an earlier one is not in the library', async () => {
            const { deps } = setup({
                dois:      { '10.1000/a': journalWithUrl('10.1000/a', 'A', 'https://pub.test/a') },
                configure: s => s.addItem({ key: 'EXSTFKEY', url: 'https://pub.test/a' }),
            });

            const [result] = await addPapers(deps, [{ doi: '10.1000/a' }], NO_PDF);

            expect(result).toMatchObject({ status: 'exists', key: 'EXSTFKEY' });
        });
    });
});
