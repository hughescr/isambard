import { describe, expect, test } from 'bun:test';
import pLimit from 'p-limit';
import { addPapers, type AddPapersDeps, type PaperInput } from '../../../../src/agent/zotero/add-papers';
import type { UrlFetchResult } from '../../../../src/agent/zotero/url-fetch';
import { ZoteroMetadataError, ZoteroUrlFetchError } from '../../../../src/errors';
import type { MappedItem } from '../../../../src/integrations/zotero';
import journalTemplate from '../../../fixtures/zotero/template-journalArticle.json';
import preprintTemplate from '../../../fixtures/zotero/template-preprint.json';
import webpageTemplate from '../../../fixtures/zotero/template-webpage.json';
import { FakeZoteroServer, clientFor, status, type RecordedCall } from '../../../helpers/zotero-fake';

const PDF = new TextEncoder().encode('%PDF-1.7 paper');
const DOCUMENT_TEMPLATE = { itemType: 'document', title: '', creators: [{ creatorType: 'author', firstName: '', lastName: '' }], url: '', accessDate: '', extra: '', tags: [], collections: [], relations: {} };

function journal(doi: string, title: string, pdfCandidates: string[] = []): MappedItem {
    return { itemType: 'journalArticle', fields: { title, DOI: doi, url: `https://doi.org/${doi}` }, creators: [{ creatorType: 'author', firstName: 'Ada', lastName: 'Lovelace' }], pdfCandidates };
}

function preprint(id: string, title: string): MappedItem {
    return {
        itemType:      'preprint',
        fields:        { title, archiveID: `arXiv:${id}`, DOI: `10.48550/arXiv.${id}`, url: `https://arxiv.org/abs/${id}` },
        creators:      [],
        pdfCandidates: [`https://arxiv.org/pdf/${id}v1`],
    };
}

function html(head: string, url: string): UrlFetchResult {
    return { finalUrl: url, kind: 'html', bytes: new TextEncoder().encode(`<html><head>${head}</head><body></body></html>`), truncated: false };
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
    dois?:      Record<string, MappedItem>
    arxiv?:     Record<string, MappedItem>
    pages?:     Record<string, UrlFetchResult | Error>
    pdfs?:      Record<string, UrlFetchResult | Error>
    configure?: (server: FakeZoteroServer) => void
    doiError?:  Error
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

function creates(server: FakeZoteroServer): unknown[][] {
    return server.calls.filter(call => call.method === 'POST' && pathOf(call) === '/items').map(call => JSON.parse(call.bodyText!) as unknown[]);
}

function scans(server: FakeZoteroServer): RecordedCall[] {
    return server.calls.filter(call => pathOf(call) === '/items/top');
}

const NO_PDF = { attachPdf: false };

describe('addPapers', () => {
    test('resolves mixed input with one batch per source, one scan and one create', async () => {
        const { server, deps, doiCalls, arxivCalls, pageCalls } = setup({
            dois:  { '10.1000/a': journal('10.1000/a', 'A'), '10.1000/b': journal('10.1000/b', 'B') },
            arxiv: { '1706.03762': preprint('1706.03762', 'Attention') },
            pages: { 'https://blog.test/post': html('<title>Blog post</title><meta property="og:site_name" content="Blog">', 'https://blog.test/post') },
        });

        const results = await addPapers(deps, [{ doi: '10.1000/A' }, { arxivId: 'arXiv:1706.03762v7' }, { url: 'https://blog.test/post' }, { doi: 'doi:10.1000/b' }], NO_PDF);

        expect(doiCalls).toEqual([['10.1000/a', '10.1000/b']]);
        expect(arxivCalls).toEqual([['1706.03762']]);
        expect(pageCalls).toEqual(['https://blog.test/post']);
        expect(scans(server)).toHaveLength(1);
        expect(scans(server)[0].url).toContain('includeTrashed=1');
        expect(creates(server)).toHaveLength(1);
        expect(creates(server)[0]).toHaveLength(4);
        expect(results.map(result => [result.status, result.itemType, result.title, result.pdf])).toEqual([
            ['added', 'journalArticle', 'A', 'skipped'],
            ['added', 'preprint', 'Attention', 'skipped'],
            ['added', 'webpage', 'Blog post', 'skipped'],
            ['added', 'journalArticle', 'B', 'skipped'],
        ]);
        expect(results.every(result => typeof result.key === 'string')).toBe(true);
        expect(server.calls.some(call => call.url.includes('q='))).toBe(false);
    });

    test('applies tags and collections to every new item', async () => {
        const { server, deps } = setup({ dois: { '10.1000/a': journal('10.1000/a', 'A') } });

        await addPapers(deps, [{ doi: '10.1000/a' }], { attachPdf: false, tags: ['to-read'], collectionKeys: ['COLL2345'] });

        expect(creates(server)[0][0]).toMatchObject({ tags: [{ tag: 'to-read' }], collections: ['COLL2345'], DOI: '10.1000/a', title: 'A' });
    });

    test('classifies doi.org and arxiv.org URLs without fetching them', async () => {
        const { deps, doiCalls, arxivCalls, pageCalls } = setup({ dois: { '10.1000/a': journal('10.1000/a', 'A') }, arxiv: { '2101.00001': preprint('2101.00001', 'P') } });

        const results = await addPapers(deps, [{ url: 'https://doi.org/10.1000/a' }, { url: 'https://arxiv.org/pdf/2101.00001v2.pdf' }], NO_PDF);

        expect(pageCalls).toEqual([]);
        expect(doiCalls).toEqual([['10.1000/a']]);
        expect(arxivCalls).toEqual([['2101.00001']]);
        expect(results.map(result => result.status)).toEqual(['added', 'added']);
    });

    describe('duplicates in the library', () => {
        test.each([
            ['data.DOI', { DOI: '10.1000/A' }],
            ['an extra DOI line', { extra: 'Note\nDOI: 10.1000/a' }],
            ['the URL', { url: 'https://doi.org/10.1000/a' }],
        ])('finds an existing item by %s', async (_label, data) => {
            const { server, deps } = setup({ dois: { '10.1000/a': journal('10.1000/a', 'A') }, configure: s => s.addItem({ key: 'EXST2345', title: 'Existing', ...data }) });

            const [result] = await addPapers(deps, [{ doi: '10.1000/a' }], NO_PDF);

            expect(result).toEqual({ input: { doi: '10.1000/a' }, status: 'exists', key: 'EXST2345', title: 'Existing', itemType: 'journalArticle', inTrash: false });
            expect(creates(server)).toEqual([]);
        });

        test('finds an existing preprint by archiveID', async () => {
            const { deps } = setup({ arxiv: { '2101.00001': preprint('2101.00001', 'P') }, configure: s => s.addItem({ key: 'EXST2345', itemType: 'preprint', archiveID: 'arXiv:2101.00001' }) });

            const [result] = await addPapers(deps, [{ arxivId: '2101.00001' }], NO_PDF);

            expect(result.status).toBe('exists');
            expect(result.title).toBe('P');
        });

        test('finds a match on the last page of a three-page scan', async () => {
            const { server, deps } = setup({
                dois:      { '10.1000/a': journal('10.1000/a', 'A') },
                configure: (s) => {
                    for(let i = 0; i < 250; i++) {
                        s.addItem({ title: `Item ${i}`, dateAdded: `2026-01-01T00:00:${String(i).padStart(3, '0')}` });
                    }
                    s.addItem({ key: 'LAST2345', DOI: '10.1000/a', dateAdded: '2026-12-31' });
                },
            });

            const [result] = await addPapers(deps, [{ doi: '10.1000/a' }], NO_PDF);

            expect(result.key).toBe('LAST2345');
            expect(scans(server)).toHaveLength(3);
        });

        test('reports a trashed duplicate as in the trash', async () => {
            const { deps } = setup({ dois: { '10.1000/a': journal('10.1000/a', 'A') }, configure: s => s.addItem({ key: 'EXST2345', DOI: '10.1000/a', deleted: 1 }) });

            const [result] = await addPapers(deps, [{ doi: '10.1000/a' }], NO_PDF);

            expect(result).toMatchObject({ status: 'exists', inTrash: true });
        });

        test('does not treat a Published version DOI line as identity', async () => {
            const { deps } = setup({ dois: { '10.1000/a': journal('10.1000/a', 'A') }, configure: s => s.addItem({ key: 'EXST2345', itemType: 'preprint', extra: 'Published version DOI: 10.1000/a' }) });

            const [result] = await addPapers(deps, [{ doi: '10.1000/a' }], NO_PDF);

            expect(result.status).toBe('added');
        });

        test('creates nothing when the duplicate check cannot run', async () => {
            const { server, deps } = setup({
                dois:      { '10.1000/a': journal('10.1000/a', 'A') },
                configure: (s) => {
                    s.override = call => (pathOf(call) === '/items/top' ? status(403, 'Forbidden') : undefined);
                },
            });

            const results = await addPapers(deps, [{ doi: '10.1000/a' }, { doi: '10.1000/missing' }], NO_PDF);

            expect(results[0]).toMatchObject({ status: 'failed', title: 'A', error: expect.stringMatching(/^duplicate check unavailable: .*; nothing was added$/) });
            expect(results[1]).toEqual({ input: { doi: '10.1000/missing' }, status: 'not_found' });
            expect(creates(server)).toEqual([]);
        });
    });

    describe('duplicates within one call', () => {
        test('merges a DOI and a page that names the same DOI, first input wins', async () => {
            const { server, deps } = setup({
                dois:  { '10.1000/a': journal('10.1000/a', 'A') },
                pages: { 'https://pub.test/a': html('<meta name="citation_doi" content="10.1000/A">', 'https://pub.test/a') },
            });

            const results = await addPapers(deps, [{ doi: '10.1000/a' }, { url: 'https://pub.test/a' }], NO_PDF);

            expect(results.map(result => result.status)).toEqual(['added', 'duplicate']);
            expect(results[1].duplicateOfInput).toBe(0);
            expect(creates(server)[0]).toHaveLength(1);
        });

        test('merges an arXiv id with its arXiv-minted DOI', async () => {
            const { deps } = setup({ arxiv: { '2101.00001': preprint('2101.00001', 'P') } });

            const results = await addPapers(deps, [{ arxivId: '2101.00001' }, { doi: '10.48550/arXiv.2101.00001' }], NO_PDF);

            expect(results[0].status).toBe('added');
            expect(results[1]).toMatchObject({ status: 'duplicate', duplicateOfInput: 0 });
        });

        test('merges transitively through a later input', async () => {
            const { deps } = setup({
                dois:  { '10.1000/a': journal('10.1000/a', 'A') },
                pages: {
                    'https://x.test/1': html('<meta name="citation_title" content="One">', 'https://x.test/1'),
                    'https://x.test/2': html('<meta name="citation_doi" content="10.1000/a">', 'https://x.test/1'),
                },
            });

            const results = await addPapers(deps, [{ url: 'https://x.test/1' }, { doi: '10.1000/a' }, { url: 'https://x.test/2' }], NO_PDF);

            expect(results.map(result => [result.status, result.duplicateOfInput])).toEqual([['added', undefined], ['duplicate', 0], ['duplicate', 0]]);
        });

        test('reports a page naming a DOI already in the library as existing', async () => {
            const { deps, doiCalls } = setup({
                dois:      { '10.1000/a': journal('10.1000/a', 'A') },
                pages:     { 'https://pub.test/a': html('<meta name="citation_doi" content="10.1000/a">', 'https://pub.test/a') },
                configure: s => s.addItem({ key: 'EXST2345', DOI: '10.1000/a' }),
            });

            const [result] = await addPapers(deps, [{ url: 'https://pub.test/a' }], NO_PDF);

            expect(result).toMatchObject({ status: 'exists', key: 'EXST2345' });
            expect(doiCalls).toEqual([['10.1000/a']]);
        });
    });

    describe('page resolution', () => {
        test('looks up identifiers found on pages in a second round', async () => {
            const { deps, doiCalls, arxivCalls } = setup({
                dois:  { '10.1000/a': journal('10.1000/a', 'A'), '10.1000/b': journal('10.1000/b', 'B') },
                arxiv: { '2101.00001': preprint('2101.00001', 'P') },
                pages: {
                    'https://pub.test/b': html('<meta name="citation_doi" content="10.1000/b"><meta name="citation_pdf_url" content="/b.pdf">', 'https://pub.test/b'),
                    'https://pub.test/p': html('<meta name="citation_arxiv_id" content="2101.00001">', 'https://pub.test/p'),
                },
            });

            const results = await addPapers(deps, [{ doi: '10.1000/a' }, { url: 'https://pub.test/b' }, { url: 'https://pub.test/p' }], NO_PDF);

            expect(doiCalls).toEqual([['10.1000/a'], ['10.1000/b']]);
            expect(arxivCalls).toEqual([['2101.00001']]);
            expect(results.map(result => [result.status, result.title])).toEqual([['added', 'A'], ['added', 'B'], ['added', 'P']]);
        });

        test('sends an arXiv-minted DOI found on a page to arXiv, not Crossref', async () => {
            const { deps, doiCalls, arxivCalls } = setup({
                arxiv: { '2101.00001': preprint('2101.00001', 'P') },
                pages: { 'https://mirror.test/p': html('<meta name="citation_doi" content="10.48550/arXiv.2101.00001">', 'https://mirror.test/p') },
            });

            const [result] = await addPapers(deps, [{ url: 'https://mirror.test/p' }], NO_PDF);

            expect(doiCalls).toEqual([]);
            expect(arxivCalls).toEqual([['2101.00001']]);
            expect(result).toMatchObject({ status: 'added', itemType: 'preprint' });
        });

        test('falls back to the page metadata when the DOI it names is unknown', async () => {
            const { server, deps } = setup({
                pages: { 'https://pub.test/x': html('<meta name="citation_doi" content="10.9999/zzz"><meta name="citation_title" content="Page title"><meta name="citation_journal_title" content="J">', 'https://pub.test/x') },
            });

            const [result] = await addPapers(deps, [{ url: 'https://pub.test/x' }], NO_PDF);

            expect(result).toMatchObject({ status: 'added', title: 'Page title', itemType: 'journalArticle' });
            expect(creates(server)[0][0]).toMatchObject({ DOI: '10.9999/zzz', publicationTitle: 'J' });
        });

        test('adds a URL that serves a PDF as a minimal document and attaches the bytes already fetched', async () => {
            const { server, deps, pdfCalls } = setup({ pages: { 'https://files.test/My%20Paper.pdf': { finalUrl: 'https://files.test/My%20Paper.pdf', kind: 'pdf', bytes: PDF, truncated: false } } });

            const [result] = await addPapers(deps, [{ url: 'https://files.test/My%20Paper.pdf' }], { attachPdf: true });

            expect(result).toMatchObject({ status: 'added', itemType: 'document', title: 'My Paper', pdf: 'attached' });
            expect(creates(server)[0][0]).toMatchObject({ itemType: 'document', title: 'My Paper', url: 'https://files.test/My%20Paper.pdf', accessDate: '2026-09-27 00:00:00' });
            expect(creates(server)[1][0]).toMatchObject({ itemType: 'attachment', parentItem: result.key, filename: 'My Paper.pdf', title: 'Full Text PDF' });
            expect(pdfCalls).toEqual([]);
        });
    });

    describe('accessDate format', () => {
        // Regression: a clock with milliseconds made toISOString() emit "...:51.133Z", which Zotero rejects
        // ("'accessDate' must be in ISO 8601 or UTC 'YYYY-MM-DD[ hh:mm:ss]' format ..."). The fake library now
        // enforces the same rule, so a bad format fails the add rather than passing silently.
        const NOW_WITH_MS = Date.UTC(2026, 8, 28, 23, 15, 51, 133);

        test('a page URL is added with a whole-second UTC accessDate', async () => {
            const { server, deps } = setup({ pages: { 'https://pub.test/x': html('<meta name="citation_title" content="Page title">', 'https://pub.test/x') } });

            const [result] = await addPapers({ ...deps, now: () => NOW_WITH_MS }, [{ url: 'https://pub.test/x' }], NO_PDF);

            expect(result).toMatchObject({ status: 'added', title: 'Page title' });
            expect(creates(server)[0][0]).toMatchObject({ accessDate: '2026-09-28 23:15:51' });
        });

        test('a PDF URL is added with a whole-second UTC accessDate', async () => {
            const { server, deps } = setup({ pages: { 'https://files.test/a.pdf': { finalUrl: 'https://files.test/a.pdf', kind: 'pdf', bytes: PDF, truncated: false } } });

            const [result] = await addPapers({ ...deps, now: () => NOW_WITH_MS }, [{ url: 'https://files.test/a.pdf' }], NO_PDF);

            expect(result).toMatchObject({ status: 'added', itemType: 'document' });
            expect(creates(server)[0][0]).toMatchObject({ accessDate: '2026-09-28 23:15:51' });
        });
    });

    describe('failures', () => {
        test('reports invalid identifiers without touching the library', async () => {
            const { server, deps } = setup();

            const papers: PaperInput[] = [{ doi: 'nope' }, { arxivId: 'x' }];
            const results = await addPapers(deps, papers, NO_PDF);

            expect(results).toEqual([
                { input: { doi: 'nope' }, status: 'failed', error: 'not a DOI: nope' },
                { input: { arxivId: 'x' }, status: 'failed', error: 'not an arXiv id: x' },
            ]);
            expect(server.calls).toEqual([]);
        });

        test('reports invalid input alongside valid input', async () => {
            const { deps } = setup({ dois: { '10.1000/a': journal('10.1000/a', 'A') } });

            const results = await addPapers(deps, [{ doi: 'nope' }, { doi: '10.1000/a' }], NO_PDF);

            expect(results.map(result => [result.status, result.error])).toEqual([['failed', 'not a DOI: nope'], ['added', undefined]]);
        });

        test('reports unknown identifiers as not found', async () => {
            const { deps } = setup();

            const results = await addPapers(deps, [{ doi: '10.1000/zzz' }, { arxivId: '2101.99999' }], NO_PDF);

            expect(results).toEqual([
                { input: { doi: '10.1000/zzz' }, status: 'not_found' },
                { input: { arxivId: '2101.99999' }, status: 'not_found' },
            ]);
        });

        test('reports a failed metadata batch for each input that needed it', async () => {
            const { deps } = setup({ doiError: new ZoteroMetadataError('Crossref request rejected', { source: 'crossref' }) });

            const [result] = await addPapers(deps, [{ doi: '10.1000/a' }], NO_PDF);

            expect(result).toEqual({ input: { doi: '10.1000/a' }, status: 'failed', error: 'Crossref lookup failed: Crossref request rejected' });
        });

        test('reports a page that could not be fetched', async () => {
            const { deps } = setup();

            const [result] = await addPapers(deps, [{ url: 'https://gone.test/' }], NO_PDF);

            expect(result).toEqual({ input: { url: 'https://gone.test/' }, status: 'failed', error: 'Fetching https://gone.test/ failed: HTTP 404' });
        });

        test('reports an item type Zotero has no template for', async () => {
            const { deps } = setup({ dois: { '10.1000/a': { ...journal('10.1000/a', 'A'), itemType: 'hologram' } } });

            const [result] = await addPapers(deps, [{ doi: '10.1000/a' }], NO_PDF);

            expect(result.status).toBe('failed');
            expect(result.error).toStartWith('no Zotero template for hologram: ');
        });

        test('reports an item Zotero refused to create', async () => {
            const { deps } = setup({
                dois:      { '10.1000/a': journal('10.1000/a', 'A') },
                configure: (s) => {
                    s.override = call => (call.method === 'POST' && pathOf(call) === '/items'
                        ? Response.json({ successful: {}, unchanged: {}, failed: { '0': { code: 400, message: 'Invalid collection' } } })
                        : undefined);
                },
            });

            const [result] = await addPapers(deps, [{ doi: '10.1000/a' }], NO_PDF);

            expect(result).toMatchObject({ status: 'failed', error: 'Invalid collection' });
        });
    });

    describe('PDFs', () => {
        test('tries candidates in order and attaches the first PDF', async () => {
            const { server, deps, pdfCalls } = setup({
                dois: { '10.1000/a': journal('10.1000/a', 'A', ['https://pay.test/a.pdf', 'https://oa.test/a.pdf']) },
                pdfs: { 'https://oa.test/a.pdf': { finalUrl: 'https://oa.test/final.pdf', kind: 'pdf', bytes: PDF, truncated: false } },
            });

            const [result] = await addPapers(deps, [{ doi: '10.1000/a' }], { attachPdf: true });

            expect(pdfCalls).toEqual(['https://pay.test/a.pdf', 'https://oa.test/a.pdf']);
            expect(result.pdf).toBe('attached');
            expect(creates(server)[1][0]).toMatchObject({ filename: 'final.pdf' });
        });

        test('uses the page citation_pdf_url after the resolved candidates', async () => {
            const { deps, pdfCalls } = setup({
                dois:  { '10.1000/b': journal('10.1000/b', 'B', ['https://pub.test/b.pdf']) },
                pages: { 'https://pub.test/b': html('<meta name="citation_doi" content="10.1000/b"><meta name="citation_pdf_url" content="/other.pdf">', 'https://pub.test/b') },
            });

            const [result] = await addPapers(deps, [{ url: 'https://pub.test/b' }], { attachPdf: true });

            expect(pdfCalls).toEqual(['https://pub.test/b.pdf', 'https://pub.test/other.pdf']);
            expect(result.pdf).toBe('failed: Fetching https://pub.test/other.pdf failed: HTTP 404');
        });

        test('reports a paper with no PDF candidate', async () => {
            const { deps, pdfCalls } = setup({ dois: { '10.1000/a': journal('10.1000/a', 'A') } });

            const [result] = await addPapers(deps, [{ doi: '10.1000/a' }], { attachPdf: true });

            expect(result.pdf).toBe('no_candidate');
            expect(pdfCalls).toEqual([]);
        });

        test('does not fetch PDFs for papers that already exist', async () => {
            const { deps, pdfCalls } = setup({ dois: { '10.1000/a': journal('10.1000/a', 'A', ['https://oa.test/a.pdf']) }, configure: s => s.addItem({ key: 'EXST2345', DOI: '10.1000/a' }) });

            const [result] = await addPapers(deps, [{ doi: '10.1000/a' }], { attachPdf: true });

            expect(result).not.toHaveProperty('pdf');
            expect(pdfCalls).toEqual([]);
        });
    });

    test('serialises concurrent calls so the second sees the first create', async () => {
        const { server, deps } = setup({ dois: { '10.1000/a': journal('10.1000/a', 'A') } });

        const [first, second] = await Promise.all([addPapers(deps, [{ doi: '10.1000/a' }], NO_PDF), addPapers(deps, [{ doi: '10.1000/a' }], NO_PDF)]);

        expect(first[0].status).toBe('added');
        expect(second[0]).toMatchObject({ status: 'exists', key: first[0].key });
        expect(creates(server)).toHaveLength(1);
    });
});
