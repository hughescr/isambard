/**
 * Mutation-kill tests for `zotero-mcp-server.ts` lines >= 458 (#157, group mcp-c): the write tools
 * `updateItems`, `writeNotes`, `manageCollections` and `trashOrRestore` — their zod schema bounds
 * (array/string min/max, exact `.describe()` text) and a few behavioural edges (the cycle check's
 * trashed-collection scan, the two-phase "nothing was created yet" error shape, and the tool name
 * `withToolErrorHandling` logs on an unexpected throw).
 */
import { afterEach, describe, expect, jest, test } from 'bun:test';
import pLimit from 'p-limit';
import { createZoteroMCPServer, type ZoteroMCPServerDeps } from '../../../src/agent/zotero-mcp-server';
import { callSdkTool, listSdkTools } from '../../helpers/sdk-mcp-client';
import { FakeZoteroServer, clientFor, fakeKey, status } from '../../helpers/zotero-fake';
import { mockLogger, textContent } from '../../setup';

type ZoteroMcp = ReturnType<typeof createZoteroMCPServer>;

/** The shape of the JSON schema nodes this file inspects; the SDK's `Tool.inputSchema` is looser than this. */
interface JsonSchemaNode {
    description?: string
    minItems?:    number
    maxItems?:    number
    minLength?:   number
    minimum?:     number
    properties?:  Record<string, JsonSchemaNode>
    items?:       JsonSchemaNode
}

function setup(configure?: (server: FakeZoteroServer) => void): { server: FakeZoteroServer, deps: ZoteroMCPServerDeps, mcp: ZoteroMcp } {
    const server = new FakeZoteroServer();
    configure?.(server);
    const deps: ZoteroMCPServerDeps = {
        client:             clientFor(server),
        metadata:           { lookupDois: async () => new Map(), lookupArxiv: async () => new Map() },
        maxStoredFileBytes: 5000,
        izzyUserId:         21_862_647,
        addPapersLock:      pLimit(1),
        hostPolicy:         { allowlist: [] },
        maxHtmlBytes:       100,
        maxUrlPdfBytes:     1234,
    };
    return { server, deps, mcp: createZoteroMCPServer(deps) };
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

/** `n` distinct, pattern-valid Zotero keys that exist in no fixture (writes against them resolve `not_found`). */
function keys(n: number): string[] {
    return Array.from({ length: n }, (_, i) => fakeKey(i));
}

afterEach(() => {
    jest.restoreAllMocks();
});

describe('updateItems boundaries (#157)', () => {
    function item(s: FakeZoteroServer): void {
        s.addItem({ key: 'ITEM2345', version: 4, title: 'Old', tags: [{ tag: 'keep' }, { tag: 'drop' }], collections: ['CLLA2345'], creators: [] });
    }

    test('advertises the exact title and field descriptions', async () => {
        const { mcp } = setup();

        const tools = await listSdkTools(mcp);
        const tool = tools.find(entry => entry.name === 'updateItems')!;
        const schema = tool.inputSchema as JsonSchemaNode;
        const updateProps = schema.properties!.updates.items!.properties!;

        expect(tool.annotations?.title).toBe('Update Zotero Items');
        expect(schema.properties!.updates.description).toBe('Up to 50 updates, one per item');
        expect(updateProps.version.description).toBe('The version you read; required with fields or creators');
        expect(updateProps.fields.description).toBe('Field name to new value, e.g. {"title": "..."}');
        expect(updateProps.creators.description).toBe('Replaces the whole creator list');
        expect(updateProps.creators.items!.properties!.name.description).toBe('A single-field name, for organisations');
    });

    test('accepts version 0 (as a version conflict, not a schema error) and rejects a negative version at the schema', async () => {
        const { mcp: zeroMcp } = setup(item);
        const { server: negativeServer, mcp: negativeMcp } = setup(item);

        const zero = await callJson(zeroMcp, 'updateItems', { updates: [{ key: 'ITEM2345', version: 0, addTags: ['x'] }] });
        const negative = await callTool(negativeMcp, 'updateItems', { updates: [{ key: 'ITEM2345', version: -1, addTags: ['x'] }] });

        expect(zero.results).toEqual([expect.objectContaining({ key: 'ITEM2345', status: 'conflict', expectedVersion: 0, currentVersion: 4 })]);
        expect(negative.isError).toBe(true);
        expect(negativeServer.calls).toEqual([]);
    });

    test('rejects an empty updates array and a batch of 51, accepts exactly 50', async () => {
        const { mcp } = setup();

        const empty = await callTool(mcp, 'updateItems', { updates: [] });
        const fifty = await callTool(mcp, 'updateItems', { updates: keys(50).map(key => ({ key, addTags: ['x'] })) });
        const fiftyOne = await callTool(mcp, 'updateItems', { updates: keys(51).map(key => ({ key, addTags: ['x'] })) });

        expect(empty.isError).toBe(true);
        expect(fifty.isError).toBe(false);
        expect(fiftyOne.isError).toBe(true);
    });

    test('rejects a 0-length creatorType and accepts exactly 1 character', async () => {
        const { mcp } = setup(item);

        const short = await callTool(mcp, 'updateItems', { updates: [{ key: 'ITEM2345', version: 4, creators: [{ creatorType: '', name: 'X' }] }] });
        const one = await callTool(mcp, 'updateItems', { updates: [{ key: 'ITEM2345', version: 4, creators: [{ creatorType: 'a', name: 'X' }] }] });

        expect(short.isError).toBe(true);
        expect(one.isError).toBe(false);
    });

    test('rejects an empty creator name at the schema, rather than silently writing a blank one', async () => {
        const { server, mcp } = setup(item);

        const result = await callTool(mcp, 'updateItems', { updates: [{ key: 'ITEM2345', version: 4, creators: [{ creatorType: 'author', name: '' }] }] });

        expect(result.isError).toBe(true);
        expect(server.calls).toEqual([]);
    });

    test('rejects an empty addTags, removeTags, addToCollections or removeFromCollections array', async () => {
        const { mcp } = setup(item);

        const addTags = await callTool(mcp, 'updateItems', { updates: [{ key: 'ITEM2345', addTags: [] }] });
        const removeTags = await callTool(mcp, 'updateItems', { updates: [{ key: 'ITEM2345', removeTags: [] }] });
        const addToCollections = await callTool(mcp, 'updateItems', { updates: [{ key: 'ITEM2345', addToCollections: [] }] });
        const removeFromCollections = await callTool(mcp, 'updateItems', { updates: [{ key: 'ITEM2345', removeFromCollections: [] }] });

        expect([addTags, removeTags, addToCollections, removeFromCollections].map(result => result.isError)).toEqual([true, true, true, true]);
    });

    test('accepts more than one removeTags, addToCollections and removeFromCollections entry (not capped at 1)', async () => {
        const { server, mcp } = setup(item);

        const body = await callJson(mcp, 'updateItems', {
            updates: [{ key: 'ITEM2345', removeTags: ['keep', 'drop'], addToCollections: ['CLLB2345', 'CLLC2345'], removeFromCollections: ['CLLA2345', 'CLLD2345'] }],
        });

        expect(body.results).toEqual([{ key: 'ITEM2345', status: 'updated', version: 2 }]);
        expect(server.items.get('ITEM2345')!.data.tags).toEqual([]);
        expect(server.items.get('ITEM2345')!.data.collections).toEqual(['CLLB2345', 'CLLC2345']);
    });

    test('logs the failing tool name when the write throws', async () => {
        const { mcp } = setup((s) => {
            item(s);
            s.override = () => status(400, 'bad read');
        });
        mockLogger.warn.mockClear();

        const result = await callTool(mcp, 'updateItems', { updates: [{ key: 'ITEM2345', version: 4, fields: { title: 'x' } }] });

        expect(result.isError).toBe(true);
        expect(mockLogger.warn).toHaveBeenCalledWith({ tool: 'updateItems', error: expect.any(String) }, 'MCP tool error');
    });
});

describe('writeNotes boundaries (#157)', () => {
    test('advertises the exact tool description and field descriptions', async () => {
        const { mcp } = setup();

        const tools = await listSdkTools(mcp);
        const tool = tools.find(entry => entry.name === 'writeNotes')!;
        const schema = tool.inputSchema as JsonSchemaNode;
        const createItem = schema.properties!.create.items!.properties!;
        const editItem = schema.properties!.edit.items!.properties!;

        expect(tool.description).toBe(
            'Create Zotero notes (child notes under an item, or standalone) and edit existing notes, from plain text (blank lines separate paragraphs). Editing replaces the whole note and needs the version you read; a note changed since is reported as a conflict and left alone.'
        );
        expect(tool.annotations?.title).toBe('Write Zotero Notes');
        expect(schema.properties!.create.description).toBe('Notes to create');
        expect(schema.properties!.edit.description).toBe('Notes to rewrite');
        expect(createItem.parentKey.description).toBe('Item to attach the note to (omit for a standalone note)');
        expect(editItem.version.description).toBe('The version you read');
        expect(editItem.text.description).toBe('The full new text');
    });

    test('rejects an empty create.text and an empty edit.text', async () => {
        const { mcp } = setup();

        const emptyCreate = await callTool(mcp, 'writeNotes', { create: [{ text: '' }] });
        const emptyEdit = await callTool(mcp, 'writeNotes', { edit: [{ key: 'NTE22345', version: 3, text: '' }] });

        expect(emptyCreate.isError).toBe(true);
        expect(emptyEdit.isError).toBe(true);
    });

    test('rejects an empty create.tags array and accepts more than one tag', async () => {
        const { server, mcp } = setup(s => s.addItem({ key: 'ITEM2345' }));

        const empty = await callTool(mcp, 'writeNotes', { create: [{ text: 'A', tags: [] }] });
        const two = await callJson(mcp, 'writeNotes', { create: [{ text: 'A', tags: ['x', 'y'] }] });

        expect(empty.isError).toBe(true);
        const sent = JSON.parse(server.calls.find(call => call.method === 'POST')!.bodyText!) as { tags: { tag: string }[] }[];
        expect(sent[0].tags).toEqual([{ tag: 'x' }, { tag: 'y' }]);
        expect((two.created as { created: unknown[] }).created).toHaveLength(1);
    });

    test('rejects an empty create array and a batch of 51, accepts exactly 50', async () => {
        const { mcp } = setup();

        const empty = await callTool(mcp, 'writeNotes', { create: [] });
        const fifty = await callTool(mcp, 'writeNotes', { create: Array.from({ length: 50 }, () => ({ text: 'x' })) });
        const fiftyOne = await callTool(mcp, 'writeNotes', { create: Array.from({ length: 51 }, () => ({ text: 'x' })) });

        expect(empty.isError).toBe(true);
        expect(fifty.isError).toBe(false);
        expect(fiftyOne.isError).toBe(true);
    });

    test('rejects an empty edit array and a batch of 51, accepts exactly 50', async () => {
        const { mcp } = setup();

        const empty = await callTool(mcp, 'writeNotes', { edit: [] });
        const fifty = await callTool(mcp, 'writeNotes', { edit: keys(50).map(key => ({ key, version: 1, text: 'x' })) });
        const fiftyOne = await callTool(mcp, 'writeNotes', { edit: keys(51).map(key => ({ key, version: 1, text: 'x' })) });

        expect(empty.isError).toBe(true);
        expect(fifty.isError).toBe(false);
        expect(fiftyOne.isError).toBe(true);
    });

    test('accepts edit version 0 and rejects a negative edit version at the schema', async () => {
        const { mcp } = setup(s => s.addItem({ key: 'NTE22345', version: 3, itemType: 'note', note: '<p>old</p>' }));

        const zero = await callTool(mcp, 'writeNotes', { edit: [{ key: 'NTE22345', version: 0, text: 'x' }] });
        const negative = await callTool(mcp, 'writeNotes', { edit: [{ key: 'NTE22345', version: -1, text: 'x' }] });

        expect(zero.isError).toBe(false);
        expect(negative.isError).toBe(true);
    });

    test('reports both created and edited together when both succeed', async () => {
        const { mcp } = setup(s => s.addItem({ key: 'NTE22345', version: 3, itemType: 'note', note: '<p>old</p>' }));

        const body = await callJson(mcp, 'writeNotes', { create: [{ text: 'New' }], edit: [{ key: 'NTE22345', version: 3, text: 'updated' }] });

        expect(body).toHaveProperty('created');
        expect(body).toHaveProperty('edited');
        expect((body.created as { created: unknown[] }).created).toHaveLength(1);
        expect(body.edited).toEqual([expect.objectContaining({ key: 'NTE22345', status: 'updated' })]);
    });

    test('logs the failing tool name when create throws before any edit', async () => {
        const { mcp } = setup((s) => {
            s.override = () => status(400, 'bad read');
        });
        mockLogger.warn.mockClear();

        const result = await callTool(mcp, 'writeNotes', { create: [{ text: 'A' }] });

        expect(result.isError).toBe(true);
        expect(mockLogger.warn).toHaveBeenCalledWith({ tool: 'writeNotes', error: expect.any(String) }, 'MCP tool error');
    });
});

describe('manageCollections boundaries (#157)', () => {
    function tree(s: FakeZoteroServer): void {
        s.addCollection({ key: 'RTTT2345', version: 1, name: 'Root' });
        s.addCollection({ key: 'KIDS2345', version: 1, name: 'Kid', parentCollection: 'RTTT2345' });
        s.addCollection({ key: 'GRND2345', version: 1, name: 'Grandkid', parentCollection: 'KIDS2345' });
    }

    test('advertises the exact tool description and field descriptions', async () => {
        const { mcp } = setup();

        const tools = await listSdkTools(mcp);
        const tool = tools.find(entry => entry.name === 'manageCollections')!;
        const schema = tool.inputSchema as JsonSchemaNode;
        const createItem = schema.properties!.create.items!.properties!;
        const updateItem = schema.properties!.update.items!.properties!;

        expect(tool.description).toBe(
            'Create, rename and move Zotero collections. Renaming or moving needs the version from listCollections; a collection changed since is reported as a conflict and left alone. parentKey null moves a collection to the top level. A move into the collection itself or one of its descendants is refused.'
        );
        expect(tool.annotations?.title).toBe('Manage Zotero Collections');
        expect(createItem.parentKey.description).toBe('Parent collection (omit for top level)');
        expect(updateItem.version.description).toBe('The version you read');
        expect(updateItem.name.description).toBe('New name');
        expect(updateItem.parentKey.description).toBe('New parent collection, or null for top level');
    });

    test('rejects an empty create.name and an empty update.name, accepts a 1-character create.name', async () => {
        const { mcp } = setup(tree);

        const emptyCreate = await callTool(mcp, 'manageCollections', { create: [{ name: '' }] });
        const emptyUpdate = await callTool(mcp, 'manageCollections', { update: [{ key: 'KIDS2345', version: 1, name: '' }] });
        const oneChar = await callTool(mcp, 'manageCollections', { create: [{ name: 'C' }] });

        expect(emptyCreate.isError).toBe(true);
        expect(emptyUpdate.isError).toBe(true);
        expect(oneChar.isError).toBe(false);
    });

    test('rejects an empty create array and a batch of 51, accepts exactly 50', async () => {
        const { mcp } = setup();

        const empty = await callTool(mcp, 'manageCollections', { create: [] });
        const fifty = await callTool(mcp, 'manageCollections', { create: Array.from({ length: 50 }, (_, i) => ({ name: `C${i}` })) });
        const fiftyOne = await callTool(mcp, 'manageCollections', { create: Array.from({ length: 51 }, (_, i) => ({ name: `C${i}` })) });

        expect(empty.isError).toBe(true);
        expect(fifty.isError).toBe(false);
        expect(fiftyOne.isError).toBe(true);
    });

    test('rejects an empty update array and a batch of 51, accepts exactly 50', async () => {
        const { mcp } = setup();

        const empty = await callTool(mcp, 'manageCollections', { update: [] });
        const fifty = await callTool(mcp, 'manageCollections', { update: keys(50).map(key => ({ key, version: 1, name: 'N' })) });
        const fiftyOne = await callTool(mcp, 'manageCollections', { update: keys(51).map(key => ({ key, version: 1, name: 'N' })) });

        expect(empty.isError).toBe(true);
        expect(fifty.isError).toBe(false);
        expect(fiftyOne.isError).toBe(true);
    });

    test('accepts update version 0 and rejects a negative update version at the schema', async () => {
        const { mcp } = setup(tree);

        const zero = await callTool(mcp, 'manageCollections', { update: [{ key: 'KIDS2345', version: 0, name: 'X' }] });
        const negative = await callTool(mcp, 'manageCollections', { update: [{ key: 'KIDS2345', version: -1, name: 'X' }] });

        expect(zero.isError).toBe(false);
        expect(negative.isError).toBe(true);
    });

    test('separates multiple "give a name or parentKey" keys with ", "', async () => {
        const { mcp } = setup(tree);

        const text = await callText(mcp, 'manageCollections', { update: [{ key: 'KIDS2345', version: 1 }, { key: 'GRND2345', version: 1 }] });

        expect(text).toBe('Error: nothing was changed: give a name or a parentKey for KIDS2345, GRND2345');
    });

    test('skips the cycle check entirely when every move is to the top level', async () => {
        const { deps, mcp } = setup(tree);
        const listSpy = jest.spyOn(deps.client, 'listCollections');

        const result = await callTool(mcp, 'manageCollections', { update: [{ key: 'GRND2345', version: 1, parentKey: null }] });

        expect(result.isError).toBe(false);
        expect(listSpy).not.toHaveBeenCalled();
    });

    test('includes trashed collections in the cycle scan', async () => {
        const { mcp } = setup((s) => {
            s.addCollection({ key: 'RTTT2345', version: 1, name: 'Root' });
            s.addCollection({ key: 'KIDS2345', version: 1, name: 'Kid', parentCollection: 'RTTT2345', deleted: true });
            s.addCollection({ key: 'GRND2345', version: 1, name: 'Grandkid', parentCollection: 'KIDS2345' });
        });

        const text = await callText(mcp, 'manageCollections', { update: [{ key: 'RTTT2345', version: 1, parentKey: 'GRND2345' }] });

        expect(text).toStartWith('Error: moving RTTT2345 under GRND2345');
        expect(text).toEndWith('would put it inside itself; nothing was changed');
    });

    test('an update-only failure is a plain error: nothing was created to report', async () => {
        const { mcp } = setup((s) => {
            tree(s);
            s.override = call => (call.method === 'GET' ? status(400, 'bad read') : undefined);
        });

        const text = await callText(mcp, 'manageCollections', { update: [{ key: 'KIDS2345', version: 1, name: 'Renamed' }] });

        expect(text).toStartWith('Error: Zotero rejected the request');
        expect(text).not.toContain('already written');
    });

    test('reports both created and updated together when both succeed', async () => {
        const { mcp } = setup(tree);

        const body = await callJson(mcp, 'manageCollections', { create: [{ name: 'New' }], update: [{ key: 'KIDS2345', version: 1, name: 'Renamed' }] });

        expect(body).toHaveProperty('created');
        expect(body).toHaveProperty('updated');
        expect((body.created as { created: unknown[] }).created).toHaveLength(1);
        expect(body.updated).toEqual([expect.objectContaining({ key: 'KIDS2345', status: 'updated' })]);
    });

    test('logs the failing tool name when create throws before any update', async () => {
        const { mcp } = setup((s) => {
            s.override = () => status(400, 'bad read');
        });
        mockLogger.warn.mockClear();

        const result = await callTool(mcp, 'manageCollections', { create: [{ name: 'New' }] });

        expect(result.isError).toBe(true);
        expect(mockLogger.warn).toHaveBeenCalledWith({ tool: 'manageCollections', error: expect.any(String) }, 'MCP tool error');
    });
});

describe('trashOrRestore boundaries (#157)', () => {
    test('advertises the exact annotations title', async () => {
        const { mcp } = setup();

        const tools = await listSdkTools(mcp);
        const tool = tools.find(entry => entry.name === 'trashOrRestore')!;

        expect(tool.annotations?.title).toBe('Trash or Restore in Zotero');
    });

    test('rejects an empty itemKeys and an empty collectionKeys array', async () => {
        const { mcp } = setup();

        const emptyItems = await callTool(mcp, 'trashOrRestore', { action: 'trash', itemKeys: [] });
        const emptyCollections = await callTool(mcp, 'trashOrRestore', { action: 'trash', collectionKeys: [] });

        expect(emptyItems.isError).toBe(true);
        expect(emptyCollections.isError).toBe(true);
    });

    test('rejects a batch of 51 itemKeys and accepts exactly 50', async () => {
        const { mcp } = setup();

        const fifty = await callTool(mcp, 'trashOrRestore', { action: 'trash', itemKeys: keys(50) });
        const fiftyOne = await callTool(mcp, 'trashOrRestore', { action: 'trash', itemKeys: keys(51) });

        expect(fifty.isError).toBe(false);
        expect(fiftyOne.isError).toBe(true);
    });

    test('rejects a batch of 51 collectionKeys and accepts exactly 50', async () => {
        const { mcp } = setup();

        const fifty = await callTool(mcp, 'trashOrRestore', { action: 'trash', collectionKeys: keys(50) });
        const fiftyOne = await callTool(mcp, 'trashOrRestore', { action: 'trash', collectionKeys: keys(51) });

        expect(fifty.isError).toBe(false);
        expect(fiftyOne.isError).toBe(true);
    });

    test('logs the failing tool name when the write throws', async () => {
        const { mcp } = setup((s) => {
            s.addItem({ key: 'ITEM2345' });
            s.override = () => status(400, 'bad read');
        });
        mockLogger.warn.mockClear();

        const result = await callTool(mcp, 'trashOrRestore', { action: 'trash', itemKeys: ['ITEM2345'] });

        expect(result.isError).toBe(true);
        expect(mockLogger.warn).toHaveBeenCalledWith({ tool: 'trashOrRestore', error: expect.any(String) }, 'MCP tool error');
    });
});
