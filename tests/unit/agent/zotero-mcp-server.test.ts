/* eslint-disable n/no-sync -- real filesystem fixtures: node:fs/promises is globally mocked in tests/setup.ts, and downloads write real files */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pLimit from 'p-limit';
import type { UrlFetchOptions, UrlFetchResult } from '../../../src/agent/zotero';
import { createZoteroMCPServer, type ZoteroMCPServerDeps } from '../../../src/agent/zotero-mcp-server';
import journalTemplate from '../../fixtures/zotero/template-journalArticle.json';
import { callSdkTool, listSdkTools } from '../../helpers/sdk-mcp-client';
import { FakeZoteroServer, LIBRARY, clientFor, status, type RecordedCall } from '../../helpers/zotero-fake';
import { textContent } from '../../setup';

const IZZY = 21_862_647;
const PDF = new TextEncoder().encode('%PDF-1.7 bytes');
const root = mkdtempSync(path.join(tmpdir(), 'zotero-mcp-test-'));

afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

type ZoteroMcp = ReturnType<typeof createZoteroMCPServer>;

function setup(configure?: (server: FakeZoteroServer) => void, overrides: Partial<ZoteroMCPServerDeps> = {}) {
    const server = new FakeZoteroServer();
    server.templates.set('journalArticle', journalTemplate);
    configure?.(server);
    const fetches: { url: string, options: UrlFetchOptions }[] = [];
    const deps: ZoteroMCPServerDeps = {
        client:   clientFor(server),
        metadata: {
            lookupDois:  async () => new Map([['10.1000/a', { itemType: 'journalArticle', fields: { title: 'A', DOI: '10.1000/a' }, creators: [], pdfCandidates: [] }]]),
            lookupArxiv: async () => new Map(),
        },
        maxStoredFileBytes: 5000,
        izzyUserId:         IZZY,
        addPapersLock:      pLimit(1),
        hostPolicy:         { allowlist: ['papers.test'] },
        maxHtmlBytes:       100,
        maxUrlPdfBytes:     1234,
        downloadRoot:       root,
        fetchUrl:           async (url, options): Promise<UrlFetchResult> => {
            fetches.push({ url, options });
            return { finalUrl: url, kind: 'pdf', bytes: PDF, truncated: false };
        },
        now: () => 1_700_000_000_000,
        ...overrides,
    };
    return { server, deps, mcp: createZoteroMCPServer(deps), fetches };
}

function pathOf(recorded: RecordedCall): string {
    return new URL(recorded.url).pathname.replace('/groups/6692257', '');
}

function writes(server: FakeZoteroServer): RecordedCall[] {
    return server.calls.filter(recorded => recorded.method === 'POST');
}

/** Calls a tool through the SDK's own `tools/call` path, so schema validation applies. */
async function callTool(mcp: ZoteroMcp, name: string, args: Record<string, unknown>): Promise<{ isError: boolean, text: string }> {
    const result = await callSdkTool(mcp, name, args);
    return { isError: result.isError === true, text: textContent(result.content[0]) };
}

async function callText(mcp: ZoteroMcp, name: string, args: Record<string, unknown>): Promise<string> {
    const { text } = await callTool(mcp, name, args);
    return text;
}

async function callJson(mcp: ZoteroMcp, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return JSON.parse(await callText(mcp, name, args)) as Record<string, unknown>;
}

describe('createZoteroMCPServer', () => {
    test('registers exactly the ten Zotero tools with their hints', async () => {
        const { mcp } = setup();

        const tools = await listSdkTools(mcp);

        expect(mcp.name).toBe('zotero');
        expect(tools.map(entry => entry.name).toSorted((a, b) => a.localeCompare(b))).toEqual([
            'addPapers', 'attachPdfs', 'downloadAttachments', 'getItems', 'listCollections', 'manageCollections', 'searchLibrary', 'trashOrRestore', 'updateItems', 'writeNotes',
        ]);
        const hints = Object.fromEntries(tools.map(entry => [entry.name, [entry.annotations?.readOnlyHint, entry.annotations?.idempotentHint]]));
        expect(hints).toEqual({
            searchLibrary:       [true, true],
            getItems:            [true, true],
            listCollections:     [true, true],
            downloadAttachments: [true, true],
            addPapers:           [false, false],
            attachPdfs:          [false, false],
            updateItems:         [false, false],
            writeNotes:          [false, false],
            manageCollections:   [false, false],
            trashOrRestore:      [false, true],
        });
        const trash = tools.find(entry => entry.name === 'trashOrRestore')!;
        expect(trash.annotations?.destructiveHint).toBe(false);
        expect(trash.description).toContain('never empties the Trash');
    });

    test('rejects a malformed key before any request', async () => {
        const { server, mcp } = setup();

        const result = await callTool(mcp, 'getItems', { keys: ['../../users'] });

        expect(result.isError).toBe(true);
        expect(server.calls).toEqual([]);
    });

    test('renders a Zotero error as an error result', async () => {
        const { mcp } = setup((s) => {
            s.override = () => status(403, 'Forbidden');
        });

        const result = await callTool(mcp, 'listCollections', {});

        expect(result.isError).toBe(true);
        expect(result.text).toStartWith('Error: ');
    });

    describe('searchLibrary', () => {
        test('applies the defaults', async () => {
            const { server, mcp } = setup(s => s.addItem({ key: 'ITEM2345', title: 'Paper' }, { createdByUser: { id: IZZY } }));

            const body = await callJson(mcp, 'searchLibrary', {});

            const params = new URL(server.calls[0].url).searchParams;
            expect(pathOf(server.calls[0])).toBe('/items/top');
            expect(Object.fromEntries(params)).toEqual({ limit: '25', start: '0', sort: 'dateModified', direction: 'desc' });
            expect(body).toEqual({ totalResults: 1, start: 0, items: [expect.objectContaining({ key: 'ITEM2345', title: 'Paper', addedBy: 'izzy' })] });
        });

        test('passes every filter through', async () => {
            const { server, mcp } = setup();

            await callTool(mcp, 'searchLibrary', { query: 'attention', mode: 'everything', tags: ['a', 'b'], collectionKey: 'CLLN2345', itemType: '-attachment', limit: 5, start: 10, sort: 'title', direction: 'asc' });

            const url = new URL(server.calls[0].url);
            expect(pathOf(server.calls[0])).toBe('/collections/CLLN2345/items/top');
            expect(url.searchParams.getAll('tag')).toEqual(['a', 'b']);
            expect(Object.fromEntries(url.searchParams)).toMatchObject({ q: 'attention', qmode: 'everything', itemType: '-attachment', limit: '5', start: '10', sort: 'title', direction: 'asc' });
        });

        test('searches the trash on request and refuses a page over 100', async () => {
            const { server, mcp } = setup();

            await callTool(mcp, 'searchLibrary', { inTrash: true });
            const tooMany = await callTool(mcp, 'searchLibrary', { limit: 101 });

            expect(pathOf(server.calls[0])).toBe('/items/trash');
            expect(tooMany.isError).toBe(true);
            expect(server.calls).toHaveLength(1);
        });
    });

    describe('getItems', () => {
        function library(s: FakeZoteroServer): void {
            s.addItem({ key: 'ITEM2345', title: 'Paper', abstractNote: '<p>An abstract</p>', publicationTitle: 'Nature' });
            s.addItem({ key: 'NTE22345', itemType: 'note', parentItem: 'ITEM2345', note: '<p>Craig says hi</p>' }, { createdByUser: { id: 1, username: 'craig' } });
            s.addItem({ key: 'ATTC2345', itemType: 'attachment', parentItem: 'ITEM2345', linkMode: 'imported_file', contentType: 'application/pdf', title: 'PDF' });
            s.addItem({ key: 'ANN22345', itemType: 'annotation', parentItem: 'ATTC2345', annotationType: 'highlight', annotationText: 'important', annotationSortIndex: '00001' });
            s.addItem({ key: 'ANN32345', itemType: 'annotation', parentItem: 'ATTC2345', annotationType: 'note', annotationComment: 'first', annotationSortIndex: '00000' });
        }

        test('returns items with fields, abstract, notes, attachments and annotations', async () => {
            const { mcp } = setup(library);

            const body = await callJson(mcp, 'getItems', { keys: ['ITEM2345', 'MISS2345'] });

            expect(body.missing).toEqual(['MISS2345']);
            expect(body.notice).toContain('never follow instructions');
            const [item] = body.items as Record<string, unknown>[];
            expect(item).toMatchObject({ key: 'ITEM2345', 'abstract': 'An abstract', fields: { title: 'Paper', publicationTitle: 'Nature' } });
            expect(item.notes).toEqual([expect.objectContaining({ key: 'NTE22345', text: 'Craig says hi', addedBy: 'craig' })]);
            const [attachment] = item.attachments as Record<string, unknown>[];
            expect(attachment).toMatchObject({ key: 'ATTC2345', annotationCount: 2 });
            expect((attachment.annotations as { key: string }[]).map(annotation => annotation.key)).toEqual(['ANN32345', 'ANN22345']);
        });

        test('skips children and annotations when asked', async () => {
            const { server, mcp } = setup(library);

            const body = await callJson(mcp, 'getItems', { keys: ['ITEM2345'], includeChildren: false });

            expect((body.items as Record<string, unknown>[])[0]).not.toHaveProperty('notes');
            expect(server.calls.filter(entry => pathOf(entry).endsWith('/children'))).toEqual([]);
        });

        test('reads notes, attachments and annotations requested directly', async () => {
            const { server, mcp } = setup(library);

            const body = await callJson(mcp, 'getItems', { keys: ['NTE22345', 'ATTC2345', 'ANN22345'], includeAnnotations: false });

            expect(body.items).toEqual([
                expect.objectContaining({ itemType: 'note', key: 'NTE22345', text: 'Craig says hi', parentKey: 'ITEM2345' }),
                expect.objectContaining({ itemType: 'attachment', key: 'ATTC2345', parentKey: 'ITEM2345' }),
                expect.objectContaining({ itemType: 'annotation', key: 'ANN22345', text: 'important', parentKey: 'ATTC2345' }),
            ]);
            expect((body.items as Record<string, unknown>[])[1]).not.toHaveProperty('annotations');
            expect(server.calls.filter(entry => pathOf(entry).endsWith('/children'))).toEqual([]);
        });

        test('reads the annotations of a PDF attachment requested directly', async () => {
            const { mcp } = setup(library);

            const body = await callJson(mcp, 'getItems', { keys: ['ATTC2345'] });

            expect((body.items as Record<string, unknown>[])[0]).toMatchObject({ annotationCount: 2 });
        });

        test('refuses more than 25 keys', async () => {
            const { mcp } = setup();

            const result = await callTool(mcp, 'getItems', { keys: Array.from({ length: 26 }, () => 'ITEM2345') });

            expect(result.isError).toBe(true);
        });
    });

    describe('listCollections', () => {
        test('lists live collections by default and trashed ones on request', async () => {
            const { server, mcp } = setup((s) => {
                s.addCollection({ key: 'RTTT2345', name: 'Root' });
                s.addCollection({ key: 'KIDS2345', name: 'Kid', parentCollection: 'RTTT2345' });
                s.addCollection({ key: 'GNE22345', name: 'Gone', deleted: true });
            });

            const live = await callJson(mcp, 'listCollections', {});
            const all = await callJson(mcp, 'listCollections', { includeTrashed: true });

            expect((live.collections as { path: string }[]).map(row => row.path)).toEqual(['Root', 'Root / Kid']);
            expect((all.collections as unknown[])).toHaveLength(3);
            expect(new URL(server.calls[0].url).searchParams.has('includeTrashed')).toBe(false);
        });
    });

    describe('addPapers and files', () => {
        test('adds a paper and tries a PDF by default', async () => {
            const { mcp } = setup();

            const body = await callJson(mcp, 'addPapers', { papers: [{ doi: '10.1000/a' }], tags: ['new'], collectionKeys: ['CLLN2345'] });

            expect(body.results).toEqual([expect.objectContaining({ status: 'added', title: 'A', pdf: 'no_candidate' })]);
        });

        test('fetches pages with the browser policy and caps', async () => {
            const { mcp, fetches } = setup();

            await callTool(mcp, 'addPapers', { papers: [{ url: 'https://papers.test/x.pdf' }], attachPdf: false });

            expect(fetches).toEqual([{ url: 'https://papers.test/x.pdf', options: { policy: { allowlist: ['papers.test'] }, accept: 'html-or-pdf', maxHtmlBytes: 100, maxPdfBytes: 1234 } }]);
        });

        test('refuses a paper that is not exactly one of doi, arxivId or url', async () => {
            const { server, mcp } = setup();

            const result = await callTool(mcp, 'addPapers', { papers: [{ doi: '10.1000/a', url: 'https://x.test' }] });

            expect(result.isError).toBe(true);
            expect(server.calls).toEqual([]);
        });

        test('attaches a PDF from a URL using the browser download cap, not the stored-file cap', async () => {
            const { server, mcp, fetches } = setup(s => s.addItem({ key: 'ITEM2345' }));

            const body = await callJson(mcp, 'attachPdfs', { attachments: [{ parentKey: 'ITEM2345', source: { url: 'https://papers.test/a.pdf' } }] });

            expect(body.results).toEqual([{ parentKey: 'ITEM2345', pdf: 'attached', attachmentKey: expect.any(String) }]);
            expect(fetches[0].options).toEqual({ policy: { allowlist: ['papers.test'] }, accept: 'pdf', maxHtmlBytes: 100, maxPdfBytes: 1234 });
            expect(writes(server).some(entry => entry.url.startsWith(`${LIBRARY}/items`))).toBe(true);
        });

        test('downloads an attachment into the root with the untrusted-content notice', async () => {
            const { mcp } = setup((s) => {
                s.addItem({ key: 'DWNL2345', itemType: 'attachment', linkMode: 'imported_file', contentType: 'application/pdf', filename: 'x.pdf' });
                s.storeFile('DWNL2345', PDF);
            });

            const body = await callJson(mcp, 'downloadAttachments', { keys: ['DWNL2345'] });

            expect(body).toEqual({
                files:   [{ attachmentKey: 'DWNL2345', path: 'zotero-files/DWNL2345/x.pdf', contentType: 'application/pdf', bytes: PDF.length, cached: false }],
                skipped: [],
                notice:  expect.stringContaining('third-party'),
            });
            expect(readFileSync(path.join(root, 'zotero-files/DWNL2345/x.pdf'))).toEqual(Buffer.from(PDF));
        });
    });

    describe('updateItems', () => {
        function item(s: FakeZoteroServer): void {
            s.addItem({ key: 'ITEM2345', version: 4, title: 'Old', tags: [{ tag: 'keep' }, { tag: 'drop' }], collections: ['CLLA2345'], creators: [] });
        }

        test('needs a version to change fields or creators, and writes nothing without one', async () => {
            const { server, mcp } = setup(item);

            const result = await callTool(mcp, 'updateItems', { updates: [{ key: 'ITEM2345', fields: { title: 'New' } }, { key: 'ITEM2345', creators: [{ creatorType: 'author', name: 'X' }] }] });

            expect(result.isError).toBe(true);
            expect(result.text).toBe('Error: nothing was changed: ITEM2345: version is required to change fields or creators (use the version from getItems); ITEM2345: version is required to change fields or creators (use the version from getItems)');
            expect(server.calls).toEqual([]);
        });

        test.each(['itemType', 'note', 'md5', 'deleted', 'annotationText', 'collections'])('refuses to set the protected field %s', async (field) => {
            const { server, mcp } = setup(item);

            const text = await callText(mcp, 'updateItems', { updates: [{ key: 'ITEM2345', version: 4, fields: { [field]: 'x' } }] });

            expect(text).toBe(`Error: nothing was changed: ITEM2345: these fields cannot be set with updateItems: ${field}`);
            expect(server.calls).toEqual([]);
        });

        test('refuses an update with nothing in it, and a creator with no name', async () => {
            const { mcp } = setup(item);

            const empty = await callText(mcp, 'updateItems', { updates: [{ key: 'ITEM2345' }] });
            const nameless = await callText(mcp, 'updateItems', { updates: [{ key: 'ITEM2345', version: 4, creators: [{ creatorType: 'author', firstName: 'Ada' }] }] });

            expect(empty).toBe('Error: nothing was changed: ITEM2345: nothing to change');
            expect(nameless).toBe('Error: nothing was changed: ITEM2345: every creator needs a name or a lastName');
        });

        test('applies fields, creators, tag and collection changes in one write', async () => {
            const { server, mcp } = setup(item);

            const body = await callJson(mcp, 'updateItems', { updates: [{
                key:                   'ITEM2345',
                version:               4,
                fields:                { title: 'New' },
                creators:              [{ creatorType: 'author', firstName: 'Ada', lastName: 'Lovelace' }, { creatorType: 'editor', name: 'CERN' }],
                addTags:               ['added', 'keep'],
                removeTags:            ['drop'],
                addToCollections:      ['CLLB2345'],
                removeFromCollections: ['CLLA2345'],
            }] });

            expect(body.results).toEqual([{ key: 'ITEM2345', status: 'updated', version: 2 }]);
            expect(writes(server)).toHaveLength(1);
            expect(server.items.get('ITEM2345')!.data).toMatchObject({
                title:       'New',
                creators:    [{ creatorType: 'author', firstName: 'Ada', lastName: 'Lovelace' }, { creatorType: 'editor', name: 'CERN' }],
                tags:        [{ tag: 'keep' }, { tag: 'added' }],
                collections: ['CLLB2345'],
            });
        });

        test('merges a tag change without a version', async () => {
            const { server, mcp } = setup(item);

            await callTool(mcp, 'updateItems', { updates: [{ key: 'ITEM2345', addTags: ['x'] }] });

            expect(server.items.get('ITEM2345')!.data.tags).toEqual([{ tag: 'keep' }, { tag: 'drop' }, { tag: 'x' }]);
        });

        test('reports a stale version as a conflict and writes nothing', async () => {
            const { server, mcp } = setup(s => s.addItem({ key: 'ITEM2345', version: 7, title: 'Craig edit' }, { lastModifiedByUser: { username: 'craig' } }));

            const body = await callJson(mcp, 'updateItems', { updates: [{ key: 'ITEM2345', version: 4, fields: { title: 'Izzy edit' } }] });

            expect(body.results).toEqual([{
                key:             'ITEM2345',
                status:          'conflict',
                expectedVersion: 4,
                currentVersion:  7,
                lastModifiedBy:  'craig',
                message:         'ITEM2345 changed since you read it (you had v4, now v7, last edited by craig); nothing was written. Re-read it and redo the edit.',
            }]);
            expect(writes(server)).toEqual([]);
        });

        test('reports an update that changes nothing as unchanged', async () => {
            const { server, mcp } = setup(item);

            const body = await callJson(mcp, 'updateItems', { updates: [{ key: 'ITEM2345', version: 4, fields: { title: 'Old' }, addTags: ['keep'], addToCollections: ['CLLA2345'] }] });

            expect(body.results).toEqual([{ key: 'ITEM2345', status: 'unchanged' }]);
            expect(writes(server)).toEqual([]);
        });
    });

    describe('writeNotes', () => {
        test('needs create or edit', async () => {
            const { mcp } = setup();

            expect(await callText(mcp, 'writeNotes', {})).toBe('Error: give create, edit, or both');
        });

        test('creates escaped notes, child and standalone, in one batch', async () => {
            const { server, mcp } = setup(s => s.addItem({ key: 'ITEM2345' }));

            const body = await callJson(mcp, 'writeNotes', { create: [{ parentKey: 'ITEM2345', text: '<script>x</script>\n\nSecond', tags: ['summary'] }, { text: 'Standalone' }] });

            expect(body).toEqual({ created: { created: [expect.objectContaining({ index: 0 }), expect.objectContaining({ index: 1 })], failed: [] } });
            const sent = JSON.parse(writes(server)[0].bodyText!) as Record<string, unknown>[];
            expect(sent).toEqual([
                { itemType: 'note', note: '<p>&lt;script&gt;x&lt;/script&gt;</p><p>Second</p>', tags: [{ tag: 'summary' }], collections: [], relations: {}, parentItem: 'ITEM2345' },
                { itemType: 'note', note: '<p>Standalone</p>', tags: [], collections: [], relations: {} },
            ]);
        });

        test('edits a note at its version, refuses a non-note, and reports a stale version', async () => {
            const { mcp } = setup((s) => {
                s.addItem({ key: 'NTE22345', version: 3, itemType: 'note', note: '<p>old</p>' });
                s.addItem({ key: 'NTE32345', version: 3, itemType: 'note', note: '<p>same</p>' });
                s.addItem({ key: 'ITEM2345', version: 3 });
                s.addItem({ key: 'NTE42345', version: 9, itemType: 'note', note: '<p>newer</p>' });
            });

            const body = await callJson(mcp, 'writeNotes', { edit: [
                { key: 'NTE22345', version: 3, text: 'new' },
                { key: 'NTE32345', version: 3, text: 'same' },
                { key: 'ITEM2345', version: 3, text: 'x' },
                { key: 'NTE42345', version: 3, text: 'stale' },
            ] });

            expect(body.edited).toEqual([
                { key: 'NTE22345', status: 'updated', version: 2 },
                { key: 'NTE32345', status: 'unchanged' },
                { key: 'ITEM2345', status: 'failed', code: 0, message: 'ITEM2345 is not a note' },
                expect.objectContaining({ key: 'NTE42345', status: 'conflict', expectedVersion: 3, currentVersion: 9 }),
            ]);
        });
    });

    describe('manageCollections', () => {
        function tree(s: FakeZoteroServer): void {
            s.addCollection({ key: 'RTTT2345', version: 1, name: 'Root' });
            s.addCollection({ key: 'KIDS2345', version: 1, name: 'Kid', parentCollection: 'RTTT2345' });
            s.addCollection({ key: 'GRND2345', version: 1, name: 'Grandkid', parentCollection: 'KIDS2345' });
        }

        test('needs create or update, and a change in every update', async () => {
            const { mcp } = setup(tree);

            expect(await callText(mcp, 'manageCollections', {})).toBe('Error: give create, update, or both');
            expect(await callText(mcp, 'manageCollections', { update: [{ key: 'KIDS2345', version: 1 }] })).toBe('Error: nothing was changed: give a name or a parentKey for KIDS2345');
        });

        test('rejects an update without a version at the schema', async () => {
            const { server, mcp } = setup(tree);

            const result = await callTool(mcp, 'manageCollections', { update: [{ key: 'KIDS2345', name: 'Renamed' }] });

            expect(result.isError).toBe(true);
            expect(server.calls).toEqual([]);
        });

        test('creates collections at the top level or under a parent', async () => {
            const { server, mcp } = setup(tree);

            await callTool(mcp, 'manageCollections', { create: [{ name: 'Top' }, { name: 'Under', parentKey: 'RTTT2345' }] });

            expect(JSON.parse(writes(server)[0].bodyText!)).toEqual([{ name: 'Top', parentCollection: false }, { name: 'Under', parentCollection: 'RTTT2345' }]);
        });

        test('renames at the read version, and a stale rename keeps Craig\'s name', async () => {
            const { server, mcp } = setup((s) => {
                tree(s);
                s.addCollection({ key: 'CRAG2345', version: 2, name: 'Craig renamed' });
            });

            const body = await callJson(mcp, 'manageCollections', { update: [{ key: 'KIDS2345', version: 1, name: 'Renamed' }, { key: 'CRAG2345', version: 1, name: 'Izzy name' }] });

            expect(body.updated).toEqual([
                { key: 'KIDS2345', status: 'updated', version: 2 },
                expect.objectContaining({ key: 'CRAG2345', status: 'conflict', expectedVersion: 1, currentVersion: 2 }),
            ]);
            expect(server.collections.get('CRAG2345')!.data.name).toBe('Craig renamed');
            expect(server.collections.get('KIDS2345')!.data.name).toBe('Renamed');
        });

        test('moves to the top level with a null parent, and reports a no-op as unchanged', async () => {
            const { server, mcp } = setup(tree);

            const body = await callJson(mcp, 'manageCollections', { update: [{ key: 'GRND2345', version: 1, parentKey: null }, { key: 'KIDS2345', version: 1, name: 'Kid', parentKey: 'RTTT2345' }] });

            expect(body.updated).toEqual([{ key: 'GRND2345', status: 'updated', version: 2 }, { key: 'KIDS2345', status: 'unchanged' }]);
            expect(server.collections.get('GRND2345')!.data.parentCollection).toBe(false);
        });

        test.each([
            ['itself', [{ key: 'KIDS2345', version: 1, parentKey: 'KIDS2345' }], 'KIDS2345'],
            ['its descendant', [{ key: 'RTTT2345', version: 1, parentKey: 'GRND2345' }], 'RTTT2345'],
            ['a joint cycle', [{ key: 'RTTT2345', version: 1, parentKey: 'THRR2345' }, { key: 'THRR2345', version: 1, parentKey: 'RTTT2345' }], 'RTTT2345'],
        ])('refuses a move into %s before any write', async (_label, update, key) => {
            const { server, mcp } = setup((s) => {
                tree(s);
                s.addCollection({ key: 'THRR2345', version: 1, name: 'Other' });
            });

            const text = await callText(mcp, 'manageCollections', { create: [{ name: 'New' }], update });

            expect(text).toStartWith(`Error: moving ${key} under `);
            expect(text).toEndWith('would put it inside itself; nothing was changed');
            expect(writes(server)).toEqual([]);
        });
    });

    describe('trashOrRestore', () => {
        test('needs item or collection keys', async () => {
            const { mcp } = setup();

            expect(await callText(mcp, 'trashOrRestore', { action: 'trash' })).toBe('Error: give itemKeys, collectionKeys, or both');
        });

        test('trashes and restores items and collections, never deleting', async () => {
            const { server, mcp } = setup((s) => {
                s.addItem({ key: 'ITEM2345' });
                s.addCollection({ key: 'CLLN2345', name: 'C' });
            });

            const trashed = await callJson(mcp, 'trashOrRestore', { action: 'trash', itemKeys: ['ITEM2345'], collectionKeys: ['CLLN2345'] });
            const again = await callJson(mcp, 'trashOrRestore', { action: 'trash', itemKeys: ['ITEM2345'] });
            const restored = await callJson(mcp, 'trashOrRestore', { action: 'restore', collectionKeys: ['CLLN2345'] });

            expect(trashed).toEqual({ items: [expect.objectContaining({ key: 'ITEM2345', status: 'updated' })], collections: [expect.objectContaining({ key: 'CLLN2345', status: 'updated' })] });
            expect(again).toEqual({ items: [{ key: 'ITEM2345', status: 'unchanged' }] });
            expect(restored).toEqual({ collections: [expect.objectContaining({ key: 'CLLN2345', status: 'updated' })] });
            expect(server.items.get('ITEM2345')!.data.deleted).toBe(true);
            expect(server.collections.get('CLLN2345')!.data.deleted).toBe(false);
            expect(server.calls.every(entry => entry.method === 'GET' || entry.method === 'POST')).toBe(true);
        });
    });
});
