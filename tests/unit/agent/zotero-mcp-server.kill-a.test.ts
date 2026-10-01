/**
 * Kills mutants surviving in src/agent/zotero-mcp-server.ts lines < 357 (#157, group mcp-a):
 * constants, schemas, validation helpers, and the searchLibrary tool. See
 * tests/unit/agent/zotero-mcp-server.test.ts for the shared test-double patterns this file
 * duplicates locally (per the mutant-killing brief, new tests live in their own file).
 */
import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import pLimit from 'p-limit';
import type { UrlFetchOptions, UrlFetchResult } from '../../../src/agent/zotero';
import { createZoteroMCPServer, type ZoteroMCPServerDeps } from '../../../src/agent/zotero-mcp-server';
import { callSdkTool, listSdkTools } from '../../helpers/sdk-mcp-client';
import { FakeZoteroServer, clientFor, type RecordedCall } from '../../helpers/zotero-fake';
import { mockLogger, textContent } from '../../setup';

const IZZY = 21_862_647;

type ZoteroMcp = ReturnType<typeof createZoteroMCPServer>;

function setup(configure?: (server: FakeZoteroServer) => void, overrides: Partial<ZoteroMCPServerDeps> = {}) {
    const server = new FakeZoteroServer();
    configure?.(server);
    const fetches: { url: string, options: UrlFetchOptions }[] = [];
    const deps: ZoteroMCPServerDeps = {
        client:   clientFor(server),
        metadata: {
            lookupDois:  async () => new Map(),
            lookupArxiv: async () => new Map(),
        },
        maxStoredFileBytes: 5000,
        izzyUserId:         IZZY,
        addPapersLock:      pLimit(1),
        hostPolicy:         { allowlist: ['papers.test'] },
        fetchUrl:           async (url, options): Promise<UrlFetchResult> => {
            fetches.push({ url, options });
            return { finalUrl: url, kind: 'pdf', bytes: new Uint8Array(), truncated: false };
        },
        now: () => 1_700_000_000_000,
        ...overrides,
    };
    return { server, deps, mcp: createZoteroMCPServer(deps), fetches };
}

function pathOf(url: string): string {
    return new URL(url).pathname.replace('/groups/6692257', '');
}

function writes(server: FakeZoteroServer): RecordedCall[] {
    return server.calls.filter(recorded => recorded.method === 'POST');
}

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

/** The server's advertised `serverInfo.version`, read through a real MCP client (not exposed by the shared listSdkTools/callSdkTool helpers). */
async function serverVersion(mcp: ZoteroMcp): Promise<string | undefined> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcp.instance.connect(serverTransport);
    const client = new Client({ name: 'version-probe', version: '1.0.0' });
    await client.connect(clientTransport);
    try {
        return client.getServerVersion()?.version;
    } finally {
        await client.close();
    }
}

describe('createZoteroMCPServer (mcp-a: constants, schemas, validation helpers, searchLibrary)', () => {
    test('advertises server version 1.0.0', async () => {
        const { mcp } = setup();

        expect(await serverVersion(mcp)).toBe('1.0.0');
    });

    test('getItems keys schema carries the exact Zotero-key description and pattern', async () => {
        const { mcp } = setup();

        const tools = await listSdkTools(mcp);
        const getItems = tools.find(entry => entry.name === 'getItems')!;

        expect(getItems.inputSchema.properties?.keys).toEqual({
            minItems:    1,
            maxItems:    25,
            type:        'array',
            items:       { type: 'string', pattern: '^[2-9A-NP-Z]{8}$', description: 'A Zotero item or collection key (8 characters)' },
            description: 'Item keys (up to 25)',
        });
    });

    test('searchLibrary schema exposes every field\'s exact bounds and description', async () => {
        const { mcp } = setup();

        const tools = await listSdkTools(mcp);
        const search = tools.find(entry => entry.name === 'searchLibrary')!;

        expect(search.inputSchema).toEqual({
            type:       'object',
            properties: {
                query:         { description: 'Search text', type: 'string', minLength: 1 },
                mode:          { description: 'What the query matches (default titleCreatorYear)', type: 'string', 'enum': ['titleCreatorYear', 'everything'] },
                tags:          { description: 'Only items with every one of these tags', minItems: 1, type: 'array', items: { type: 'string', minLength: 1 } },
                collectionKey: { description: 'Only items in this collection', type: 'string', pattern: '^[2-9A-NP-Z]{8}$' },
                itemType:      { description: 'Item type, e.g. journalArticle, or -attachment to exclude one', type: 'string', minLength: 1 },
                inTrash:       { description: 'Search the whole group Trash instead (default false); cannot be combined with collectionKey', type: 'boolean' },
                limit:         { description: 'Page size, 1-100 (default 25)', type: 'integer', minimum: 1, maximum: 100 },
                start:         { description: 'Offset of the page (default 0)', type: 'integer', minimum: 0, maximum: 9_007_199_254_740_991 },
                sort:          { description: 'Sort field (default dateModified)', type: 'string', 'enum': ['dateAdded', 'dateModified', 'title', 'creator', 'date'] },
                direction:     { description: 'Sort direction (default desc)', type: 'string', 'enum': ['asc', 'desc'] },
            },
            $schema: 'http://json-schema.org/draft-07/schema#',
        });
    });

    test('rejects an empty tag and accepts a one-character tag (tagName min length)', async () => {
        const { server, mcp } = setup();

        const empty = await callTool(mcp, 'searchLibrary', { tags: [''] });
        const one = await callTool(mcp, 'searchLibrary', { tags: ['a'] });

        expect(empty.isError).toBe(true);
        expect(one.isError).toBe(false);
        expect(server.calls).toHaveLength(1);
    });

    test('accepts a single-item tags array and refuses an empty one (array min length)', async () => {
        const { server, mcp } = setup();

        const empty = await callTool(mcp, 'searchLibrary', { tags: [] });
        const one = await callTool(mcp, 'searchLibrary', { tags: ['a'] });

        expect(empty.isError).toBe(true);
        expect(one.isError).toBe(false);
        expect(server.calls).toHaveLength(1);
    });

    test('accepts a single-character itemType and refuses an empty one', async () => {
        const { server, mcp } = setup();

        const empty = await callTool(mcp, 'searchLibrary', { itemType: '' });
        const one = await callTool(mcp, 'searchLibrary', { itemType: 'x' });

        expect(empty.isError).toBe(true);
        expect(one.isError).toBe(false);
        expect(pathOf(server.calls[0].url)).toBe('/items/top');
    });

    test('accepts a limit of exactly 1 and refuses 0 (limit min bound)', async () => {
        const { server, mcp } = setup();

        const zero = await callTool(mcp, 'searchLibrary', { limit: 0 });
        const one = await callTool(mcp, 'searchLibrary', { limit: 1 });

        expect(zero.isError).toBe(true);
        expect(one.isError).toBe(false);
        expect(server.calls).toHaveLength(1);
    });

    test('accepts a limit of exactly 100 (the documented max)', async () => {
        const { server, mcp } = setup();

        const hundred = await callTool(mcp, 'searchLibrary', { limit: 100 });

        expect(hundred.isError).toBe(false);
        expect(new URL(server.calls[0].url).searchParams.get('limit')).toBe('100');
    });

    test('accepts a start of exactly 0 and refuses -1 (start min bound)', async () => {
        const { server, mcp } = setup();

        const negative = await callTool(mcp, 'searchLibrary', { start: -1 });
        const zero = await callTool(mcp, 'searchLibrary', { start: 0 });

        expect(negative.isError).toBe(true);
        expect(zero.isError).toBe(false);
        expect(server.calls).toHaveLength(1);
    });

    test('logs the tool name "searchLibrary" (not empty) when the search itself fails', async () => {
        const { mcp, deps } = setup();
        deps.client.searchItems = async () => {
            throw new Error('boom');
        };

        const result = await callTool(mcp, 'searchLibrary', {});

        expect(result.isError).toBe(true);
        expect(mockLogger.warn).toHaveBeenLastCalledWith({ tool: 'searchLibrary', error: 'boom' }, 'MCP tool error');
    });

    test('sends no q/qmode/tags params when none of query, mode or tags is given', async () => {
        const { server, mcp } = setup();

        await callTool(mcp, 'searchLibrary', {});

        const params = new URL(server.calls[0].url).searchParams;
        expect(params.has('q')).toBe(false);
        expect(params.has('qmode')).toBe(false);
        expect(params.getAll('tag')).toEqual([]);
    });

    test.each([
        'parentItem', 'creators', 'tags', 'relations', 'dateAdded', 'dateModified', 'key',
        'contentType', 'filename', 'charset', 'mtime', 'path',
    ])('refuses to set the protected field %s', async (field) => {
        const { server, mcp } = setup(s => s.addItem({ key: 'ITEM2345', version: 4 }));

        const text = await callText(mcp, 'updateItems', { updates: [{ key: 'ITEM2345', version: 4, fields: { [field]: 'x' } }] });

        expect(text).toBe(`Error: nothing was changed: ITEM2345: these fields cannot be set with updateItems: ${field}`);
        expect(server.calls).toEqual([]);
    });

    test('joins multiple forbidden fields with ", "', async () => {
        const { mcp } = setup(s => s.addItem({ key: 'ITEM2345', version: 4 }));

        const text = await callText(mcp, 'updateItems', { updates: [{ key: 'ITEM2345', version: 4, fields: { itemType: 'x', deleted: 'y' } }] });

        expect(text).toBe('Error: nothing was changed: ITEM2345: these fields cannot be set with updateItems: itemType, deleted');
    });

    test('only forbids fields that start with "annotation", not ones that merely contain it', async () => {
        const { mcp } = setup(s => s.addItem({ key: 'ITEM2345', version: 4 }));

        const body = await callJson(mcp, 'updateItems', { updates: [{ key: 'ITEM2345', version: 4, fields: { xannotationY: 'v' } }] });

        expect(body.results).toEqual([{ key: 'ITEM2345', status: 'updated', version: 2 }]);
    });

    test('rejects the whole update when any one creator (not necessarily all) lacks a name and lastName', async () => {
        const { mcp } = setup(s => s.addItem({ key: 'ITEM2345', version: 4 }));

        const text = await callText(mcp, 'updateItems', { updates: [{
            key: 'ITEM2345', version: 4, creators: [{ creatorType: 'author', name: 'Valid' }, { creatorType: 'editor', firstName: 'NoLast' }],
        }] });

        expect(text).toBe('Error: nothing was changed: ITEM2345: every creator needs a name or a lastName');
    });

    test('defaults a nameless creator\'s missing first name to an empty string', async () => {
        const { server, mcp } = setup(s => s.addItem({ key: 'ITEM2345', version: 4 }));

        await callTool(mcp, 'updateItems', { updates: [{ key: 'ITEM2345', version: 4, creators: [{ creatorType: 'author', lastName: 'Smith' }] }] });

        expect(server.items.get('ITEM2345')!.data.creators).toEqual([{ creatorType: 'author', firstName: '', lastName: 'Smith' }]);
    });

    test('reports a conflict without an editor name when Zotero has none on record', async () => {
        const { mcp } = setup(s => s.addItem({ key: 'ITEM2345', version: 7, title: 'Craig edit' }));

        const body = await callJson(mcp, 'updateItems', { updates: [{ key: 'ITEM2345', version: 4, fields: { title: 'Izzy edit' } }] });

        expect(body.results).toEqual([{
            key:             'ITEM2345',
            status:          'conflict',
            expectedVersion: 4,
            currentVersion:  7,
            message:         'ITEM2345 changed since you read it (you had v4, now v7); nothing was written. Re-read it and redo the edit.',
        }]);
    });

    test('reports failed creates alongside successful ones with their real index/code/message', async () => {
        const { mcp } = setup((s) => {
            s.override = (call) => {
                if(call.method === 'POST' && pathOf(call.url) === '/items') {
                    return Response.json({ successful: { '0': { key: 'NTE99999', version: 2, data: {} } }, unchanged: {}, failed: { '1': { code: 400, message: 'bad note' } } }, { headers: { 'Last-Modified-Version': '2' } });
                }
                return undefined;
            };
        });

        const body = await callJson(mcp, 'writeNotes', { create: [{ text: 'A' }, { text: 'B' }] });

        expect(body.created).toEqual({
            created: [{ index: 0, key: 'NTE99999', version: 2 }],
            failed:  [{ index: 1, code: 400, message: 'bad note' }],
        });
    });

    test('does not touch tags or collections when neither is requested (no spurious write)', async () => {
        const { mcp } = setup(s => s.addItem({ key: 'ITEM2345', version: 4, title: 'Same' }));

        const body = await callJson(mcp, 'updateItems', { updates: [{ key: 'ITEM2345', version: 4, fields: { title: 'Same' } }] });

        expect(body.results).toEqual([{ key: 'ITEM2345', status: 'unchanged' }]);
    });

    test('removes a tag without adding a spurious one when addTags is omitted', async () => {
        const { server, mcp } = setup(s => s.addItem({ key: 'ITEM2345', version: 4, tags: [{ tag: 'keep' }, { tag: 'drop' }] }));

        await callTool(mcp, 'updateItems', { updates: [{ key: 'ITEM2345', removeTags: ['drop'] }] });

        expect(server.items.get('ITEM2345')!.data.tags).toEqual([{ tag: 'keep' }]);
    });

    test('keeps a collection not being removed, without adding a spurious one (removeFromCollections alone)', async () => {
        const { server, mcp } = setup(s => s.addItem({ key: 'ITEM2345', version: 4, collections: ['CLLA2345', 'CLLB2345'] }));

        await callTool(mcp, 'updateItems', { updates: [{ key: 'ITEM2345', removeFromCollections: ['CLLA2345'] }] });

        expect(server.items.get('ITEM2345')!.data.collections).toEqual(['CLLB2345']);
    });

    test('adds to collections with no prior collections field, without a spurious entry (addToCollections alone)', async () => {
        const { server, mcp } = setup(s => s.addItem({ key: 'ITEM2345', version: 4 }));

        await callTool(mcp, 'updateItems', { updates: [{ key: 'ITEM2345', addToCollections: ['CLLB2345'] }] });

        expect(server.items.get('ITEM2345')!.data.collections).toEqual(['CLLB2345']);
    });

    test('sends no write when an edited note already has exactly that text', async () => {
        const { server, mcp } = setup(s => s.addItem({ key: 'NTE32345', version: 3, itemType: 'note', note: '<p>same</p>' }));

        const body = await callJson(mcp, 'writeNotes', { edit: [{ key: 'NTE32345', version: 3, text: 'same' }] });

        expect(body.edited).toEqual([{ key: 'NTE32345', status: 'unchanged' }]);
        expect(writes(server)).toEqual([]);
    });

    test('keeps the current parent when only renaming a collection', async () => {
        const { server, mcp } = setup((s) => {
            s.addCollection({ key: 'RTTT2345', version: 1, name: 'Root' });
            s.addCollection({ key: 'KIDS2345', version: 1, name: 'Kid', parentCollection: 'RTTT2345' });
        });

        await callTool(mcp, 'manageCollections', { update: [{ key: 'KIDS2345', version: 1, name: 'Renamed' }] });

        expect(server.collections.get('KIDS2345')!.data.parentCollection).toBe('RTTT2345');
    });

    test('sends no write for a manageCollections update that changes nothing', async () => {
        const { server, mcp } = setup((s) => {
            s.addCollection({ key: 'RTTT2345', version: 1, name: 'Root' });
            s.addCollection({ key: 'KIDS2345', version: 1, name: 'Kid', parentCollection: 'RTTT2345' });
        });

        const body = await callJson(mcp, 'manageCollections', { update: [{ key: 'KIDS2345', version: 1, name: 'Kid', parentKey: 'RTTT2345' }] });

        expect(body.updated).toEqual([{ key: 'KIDS2345', status: 'unchanged' }]);
        expect(writes(server)).toEqual([]);
    });

    test('refuses a move whose chain runs into an unrelated pre-existing cycle, without looping forever', async () => {
        const { mcp } = setup((s) => {
            s.addCollection({ key: 'AAAA2222', version: 1, name: 'A' });
            s.addCollection({ key: 'BBBB2222', version: 1, name: 'B', parentCollection: 'CCCC2222' });
            s.addCollection({ key: 'CCCC2222', version: 1, name: 'C', parentCollection: 'BBBB2222' });
        });

        const text = await callText(mcp, 'manageCollections', { update: [{ key: 'AAAA2222', version: 1, parentKey: 'BBBB2222' }] });

        expect(text).not.toStartWith('Error: moving');
    });

    test('does not treat a non-attachment item with a matching content type as a PDF attachment', async () => {
        const { server, mcp } = setup(s => s.addItem({ key: 'ITEM2345', contentType: 'application/pdf' }));

        await callJson(mcp, 'getItems', { keys: ['ITEM2345'], includeChildren: false });

        expect(server.calls).toHaveLength(1);
    });

    test('does not treat a non-pdf attachment as a PDF attachment', async () => {
        const { server, mcp } = setup(s => s.addItem({ key: 'ATTC2345', itemType: 'attachment', linkMode: 'imported_url', contentType: 'text/html' }));

        await callJson(mcp, 'getItems', { keys: ['ATTC2345'], includeChildren: false });

        expect(server.calls).toHaveLength(1);
    });

    test('filters a PDF attachment\'s children to itemType annotation, ignoring any other child type', async () => {
        const { mcp } = setup((s) => {
            s.addItem({ key: 'ATTC2345', itemType: 'attachment', linkMode: 'imported_file', contentType: 'application/pdf', title: 'PDF' });
            s.addItem({ key: 'ANN22345', itemType: 'annotation', parentItem: 'ATTC2345', annotationType: 'highlight', annotationText: 'hi', annotationSortIndex: '00000' });
            s.addItem({ key: 'ODDD2345', itemType: 'note', parentItem: 'ATTC2345', note: '<p>weird child</p>' });
        });

        const body = await callJson(mcp, 'getItems', { keys: ['ATTC2345'] });

        const [attachment] = body.items as { annotations: { key: string }[], annotationCount: number }[];
        expect(attachment.annotations.map(a => a.key)).toEqual(['ANN22345']);
        expect(attachment.annotationCount).toBe(1);
    });

    test('omits the abstract field entirely for an empty abstractNote', async () => {
        const { mcp } = setup(s => s.addItem({ key: 'ITEM2345', abstractNote: '' }));

        const body = await callJson(mcp, 'getItems', { keys: ['ITEM2345'] });

        const [item] = body.items as Record<string, unknown>[];
        expect(item).not.toHaveProperty('abstract');
    });

    test('marks a long abstract as truncated at exactly the true bit and the true cap', async () => {
        const { mcp } = setup(s => s.addItem({ key: 'ITEM2345', abstractNote: 'A'.repeat(9000) }));

        const body = await callJson(mcp, 'getItems', { keys: ['ITEM2345'] });

        const [item] = body.items as { abstractTruncated?: boolean, 'abstract': string }[];
        expect(item.abstractTruncated).toBe(true);
        expect(item.abstract).toHaveLength(8000);
    });
});
