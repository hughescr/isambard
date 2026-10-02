import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
    API,
    FakeZoteroServer,
    LIBRARY,
    TEST_API_KEY,
    fakeKey,
    json,
    status,
    type RecordedCall
} from '../../../helpers/zotero-fake';
import {
    InvariantViolationError,
    ZoteroAuthError,
    ZoteroError,
    ZoteroFileError,
    ZoteroQuotaError,
    ZoteroServerError
} from '@/errors';
import { ZoteroClient, type ModifyOutcome } from '@/integrations/zotero/client';
import type { ZoteroItemData } from '@/integrations/zotero/types';

const servers: FakeZoteroServer[] = [];

afterAll(() => {
    // Every API call anywhere in this suite stayed inside the group library or the template endpoint.
    const escaped = servers
        .flatMap(server => server.calls)
        .filter(call => call.headers.get('Zotero-API-Key') !== null)
        .filter(call => !call.url.startsWith(`${LIBRARY}/`) && !call.url.startsWith(`${API}/items/new?`));
    if(escaped.length > 0) {
        throw new Error(`API calls outside the group library: ${escaped.map(call => call.url).join(', ')}`);
    }
});

function setup(configure?: (server: FakeZoteroServer) => void, readConcurrency?: number) {
    const server = new FakeZoteroServer();
    servers.push(server);
    configure?.(server);
    const client = new ZoteroClient({
        apiKey:        TEST_API_KEY,
        groupId:       6_692_257,
        fetch:         server.fetch,
        sleep:         server.clock.sleep,
        now:           server.clock.now,
        timeoutSignal: () => new AbortController().signal,
        ...readConcurrency === undefined ? {} : { readConcurrency },
    });
    return { server, client };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    throw new Error('expected a rejection');
}

function params(call: RecordedCall): URLSearchParams {
    return new URL(call.url).searchParams;
}

function pathOf(call: RecordedCall): string {
    return new URL(call.url).pathname.replace('/groups/6692257', '');
}

function posts(server: FakeZoteroServer): RecordedCall[] {
    return server.calls.filter(call => call.method === 'POST');
}

function addItems(server: FakeZoteroServer, count: number, extra: (i: number) => Record<string, unknown> = () => ({})): string[] {
    return Array.from({ length: count }, (_, i) => server.addItem({ key: fakeKey(i), title: `T${i}`, ...extra(i) }).key);
}

describe('ZoteroClient reads', () => {
    test('searchItems reads top-level items with every filter, tags repeated for AND', async () => {
        const { server, client } = setup((s) => {
            addItems(s, 3);
        });

        const result = await client.searchItems({
            q:         'deep',
            qmode:     'everything',
            tags:      ['ml', 'to read'],
            itemType:  '-attachment',
            limit:     10,
            start:     5,
            sort:      'dateModified',
            direction: 'desc',
        });

        expect(result.totalResults).toBe(3);
        expect(result.items).toEqual([]);
        const call = server.calls[0];
        expect(pathOf(call)).toBe('/items/top');
        expect(params(call).get('q')).toBe('deep');
        expect(params(call).get('qmode')).toBe('everything');
        expect(params(call).getAll('tag')).toEqual(['ml', 'to read']);
        expect(params(call).get('itemType')).toBe('-attachment');
        expect(params(call).get('limit')).toBe('10');
        expect(params(call).get('start')).toBe('5');
        expect(params(call).get('sort')).toBe('dateModified');
        expect(params(call).get('direction')).toBe('desc');
    });

    test('searchItems sends only the filters it was given', async () => {
        const { server, client } = setup((s) => {
            addItems(s, 2);
        });

        const result = await client.searchItems({ limit: 25, start: 0, sort: 'title', direction: 'asc' });

        expect(result.items.map(item => item.key)).toEqual([fakeKey(0), fakeKey(1)]);
        expect([...params(server.calls[0]).keys()]).toEqual(['limit', 'start', 'sort', 'direction']);
    });

    test('searchItems reads a collection, or the trash (which wins)', async () => {
        const { server, client } = setup((s) => {
            s.addItem({ key: fakeKey(1), collections: ['CLLN2345'] });
            s.addItem({ key: fakeKey(2), deleted: 1 });
        });

        const inCollection = await client.searchItems({ collectionKey: 'CLLN2345', limit: 25, start: 0, sort: 'title', direction: 'asc' });
        const trashed = await client.searchItems({ collectionKey: 'CLLN2345', inTrash: true, limit: 25, start: 0, sort: 'title', direction: 'asc' });

        expect(pathOf(server.calls[0])).toBe('/collections/CLLN2345/items/top');
        expect(inCollection.items.map(item => item.key)).toEqual([fakeKey(1)]);
        expect(pathOf(server.calls[1])).toBe('/items/trash');
        expect(trashed.items.map(item => item.key)).toEqual([fakeKey(2)]);
    });

    test.each([
        ['searchItems', (client: ZoteroClient) => client.searchItems({ limit: 25, start: 0, sort: 'title', direction: 'asc' }), '/items/top'],
        ['getItems', (client: ZoteroClient) => client.getItems(['ABCD2345']), '/items'],
        ['getChildren', (client: ZoteroClient) => client.getChildren(['ABCD2345']), '/items/ABCD2345/children'],
        ['scanTopItems', (client: ZoteroClient) => client.scanTopItems(), '/items/top'],
    ] as const)('%s refuses a list without Total-Results rather than guess it is complete', async (_label, read, path) => {
        const { client } = setup((s) => {
            s.override = () => json([{ key: 'ABCD2345', version: 1, data: { key: 'ABCD2345', version: 1, itemType: 'book' } }], { headers: { 'Last-Modified-Version': '3' } });
        });

        const error = await caught(read(client)) as ZoteroError;

        expect(error).toBeInstanceOf(ZoteroError);
        expect(error.message).toBe(`Zotero did not report Total-Results for ${path}`);
        expect(error.context).toEqual({ path });
    });

    test('searchItems rejects a malformed collection key before sending', async () => {
        const { server, client } = setup();

        expect(await caught(client.searchItems({ collectionKey: '../x', limit: 1, start: 0, sort: 'title', direction: 'asc' }))).toBeInstanceOf(InvariantViolationError);
        expect(server.calls).toHaveLength(0);
    });

    test('getItems reads 30 keys in one request with an explicit limit of 50', async () => {
        let keys: string[] = [];
        const { server, client } = setup((s) => {
            keys = addItems(s, 30);
        });

        const result = await client.getItems(keys);

        expect(server.calls).toHaveLength(1);
        expect(pathOf(server.calls[0])).toBe('/items');
        expect(params(server.calls[0]).get('limit')).toBe('50');
        expect(params(server.calls[0]).get('includeTrashed')).toBe('1');
        expect(params(server.calls[0]).get('itemKey')).toBe(keys.join(','));
        expect(result.items).toHaveLength(30);
        expect(result.missing).toEqual([]);
    });

    test('getItems chunks 120 keys into 3 requests, dedupes, and reports missing keys', async () => {
        let keys: string[] = [];
        const { server, client } = setup((s) => {
            keys = addItems(s, 100);
        });
        const wanted = [...keys, ...Array.from({ length: 20 }, (_, i) => fakeKey(900 + i)), keys[0]];

        const result = await client.getItems(wanted);

        expect(server.calls).toHaveLength(3);
        expect(result.items).toHaveLength(100);
        expect(result.missing).toEqual(Array.from({ length: 20 }, (_, i) => fakeKey(900 + i)));
    });

    test('getItems returns trashed items and makes no request for no keys', async () => {
        const { server, client } = setup((s) => {
            s.addItem({ key: fakeKey(1), deleted: 1 });
        });

        expect(await client.getItems([])).toEqual({ items: [], missing: [] });
        expect(server.calls).toHaveLength(0);
        const result = await client.getItems([fakeKey(1)]);
        expect(result.items[0]?.data.deleted).toBe(1);
    });

    test('getItems throws rather than reporting keys missing when a chunk comes back short', async () => {
        const { client } = setup((s) => {
            addItems(s, 3);
            s.override = () => json([], { headers: { 'Total-Results': '3' } });
        });

        const error = await caught(client.getItems([fakeKey(0), fakeKey(1), fakeKey(2)])) as ZoteroError;

        expect(error).toBeInstanceOf(ZoteroError);
        expect(error.message).toBe('incomplete keyed read from /items: Zotero reported 3 results but returned 0');
    });

    test('getItems rejects malformed keys before sending', async () => {
        const { server, client } = setup();

        expect(await caught(client.getItems(['abcd2345']))).toBeInstanceOf(InvariantViolationError);
        expect(await caught(client.getItems(['ABCD234O']))).toBeInstanceOf(InvariantViolationError);
        expect(await caught(client.getItems(['ABCD23456']))).toBeInstanceOf(InvariantViolationError);
        expect(server.calls).toHaveLength(0);
    });

    test('keyed chunks run at most readConcurrency at a time', async () => {
        let inFlight = 0;
        let peak = 0;
        let keys: string[] = [];
        const { client } = setup((s) => {
            keys = addItems(s, 250);
            s.override = async () => {
                inFlight++;
                peak = Math.max(peak, inFlight);
                await Promise.resolve();
                await Promise.resolve();
                inFlight--;
                return undefined;
            };
        }, 2);

        await client.getItems(keys);

        expect(peak).toBe(2);
    });

    test('the default read concurrency is 4', async () => {
        let inFlight = 0;
        let peak = 0;
        let keys: string[] = [];
        const { client } = setup((s) => {
            keys = addItems(s, 400);
            s.override = async () => {
                inFlight++;
                peak = Math.max(peak, inFlight);
                await Promise.resolve();
                await Promise.resolve();
                inFlight--;
                return undefined;
            };
        });

        await client.getItems(keys);

        expect(peak).toBe(4);
    });

    test('getCollections reads 30 keys in one request and reports missing keys', async () => {
        const keys: string[] = [];
        const { server, client } = setup((s) => {
            for(let i = 0; i < 30; i++) {
                keys.push(s.addCollection({ key: fakeKey(300 + i), name: `C${i}` }).key);
            }
        });

        const result = await client.getCollections([...keys, fakeKey(999)]);

        expect(server.calls).toHaveLength(1);
        expect(pathOf(server.calls[0])).toBe('/collections');
        expect(params(server.calls[0]).get('limit')).toBe('50');
        expect(params(server.calls[0]).get('includeTrashed')).toBe('1');
        expect(result.collections).toHaveLength(30);
        expect(result.missing).toEqual([fakeKey(999)]);
    });

    test('getChildren pages a PDF with 130 annotations over two requests', async () => {
        const { server, client } = setup((s) => {
            s.addItem({ key: 'PDFK2345', itemType: 'attachment' });
            for(let i = 0; i < 130; i++) {
                s.addItem({ key: fakeKey(i), itemType: 'annotation', parentItem: 'PDFK2345' });
            }
            s.addItem({ key: 'EMPT2345' });
        });

        const children = await client.getChildren(['PDFK2345', 'EMPT2345']);

        expect(children.get('PDFK2345')).toHaveLength(130);
        expect(children.get('EMPT2345')).toEqual([]);
        const pdfCalls = server.calls.filter(call => pathOf(call) === '/items/PDFK2345/children');
        expect(pdfCalls.map(call => params(call).get('start'))).toEqual(['0', '100']);
        expect(pdfCalls.map(call => params(call).get('limit'))).toEqual(['100', '100']);
    });

    test('getChildren refuses a parent with more than 5,000 children after one request', async () => {
        const { server, client } = setup((s) => {
            s.override = () => json([], { headers: { 'Total-Results': '5001' } });
        });

        const error = await caught(client.getChildren(['PDFK2345'])) as ZoteroError;

        expect(error.message).toBe('PDFK2345 has 5001 children, more than the 5000 this client reads; nothing was returned');
        expect(error.context).toEqual({ parentKey: 'PDFK2345', totalResults: 5001 });
        expect(server.calls).toHaveLength(1);
    });

    test('getChildren accepts a parent with exactly 5,000 children', async () => {
        const { server, client } = setup((s) => {
            s.override = () => json([], { headers: { 'Total-Results': '5000' } });
        });

        const error = await caught(client.getChildren(['PDFK2345'])) as ZoteroError;

        // Not refused as too many: it went on to read, and the (fake) empty page tripped the completeness check.
        expect(error.message).toBe('incomplete paged read from /items/PDFK2345/children: got 0 of 5000');
        expect(server.calls).toHaveLength(1);
    });

    test('getChildren throws when a page ends before Total-Results', async () => {
        const { client } = setup((s) => {
            s.override = call => (params(call).get('start') === '0'
                ? json(Array.from({ length: 100 }, (_, i) => ({ key: fakeKey(i), version: 1, data: { key: 'X', version: 1, itemType: 'note' } })), { headers: { 'Total-Results': '150' } })
                : json([], { headers: { 'Total-Results': '150' } }));
        });

        const error = await caught(client.getChildren(['PDFK2345'])) as ZoteroError;

        expect(error.message).toBe('incomplete paged read from /items/PDFK2345/children: got 100 of 150');
    });

    test('listCollections pages every collection, optionally including the trash', async () => {
        const { server, client } = setup((s) => {
            for(let i = 0; i < 150; i++) {
                s.addCollection({ key: fakeKey(600 + i), name: `C${i}`, ...i === 0 ? { deleted: true } : {} });
            }
        });

        const live = await client.listCollections({ includeTrashed: false });
        const all = await client.listCollections({ includeTrashed: true });

        expect(live).toHaveLength(149);
        expect(all).toHaveLength(150);
        expect(server.calls).toHaveLength(4);
        expect(params(server.calls[0]).get('includeTrashed')).toBeNull();
        expect(params(server.calls[2]).get('includeTrashed')).toBe('1');
        expect(params(server.calls[1]).get('start')).toBe('100');
    });

    test('listCollections refuses more than 5,000 collections', async () => {
        const { client } = setup((s) => {
            s.override = () => json([], { headers: { 'Total-Results': '5001' } });
        });

        const error = await caught(client.listCollections({ includeTrashed: false })) as ZoteroError;

        expect(error.message).toBe('the group has 5001 collections, more than the 5000 this client reads');
        expect(error.context).toEqual({ totalResults: 5001 });
    });

    test('scanTopItems reads every top-level item, trash included, oldest first', async () => {
        const { server, client } = setup((s) => {
            addItems(s, 250, i => ({ dateAdded: `2026-01-01T00:00:${String(i).padStart(3, '0')}Z`, ...i === 7 ? { deleted: 1 } : {} }));
            s.addItem({ key: 'CHLD2345', parentItem: fakeKey(0) });
            s.libraryVersion = 42;
        });

        const result = await client.scanTopItems();

        expect(result.items).toHaveLength(250);
        expect(result.libraryVersion).toBe(42);
        expect(server.calls).toHaveLength(3);
        for(const call of server.calls) {
            expect(pathOf(call)).toBe('/items/top');
            expect(params(call).get('includeTrashed')).toBe('1');
            expect(params(call).get('sort')).toBe('dateAdded');
            expect(params(call).get('direction')).toBe('asc');
            expect(params(call).get('limit')).toBe('100');
        }
        expect(server.calls.map(call => Number(params(call).get('start'))).toSorted((a, b) => a - b)).toEqual([0, 100, 200]);
    });

    test('scanTopItems of an empty library is one request', async () => {
        const { server, client } = setup();

        expect(await client.scanTopItems()).toEqual({ items: [], libraryVersion: 1 });
        expect(server.calls).toHaveLength(1);
    });

    test('scanTopItems rescans once when the library changes mid-scan', async () => {
        let bumped = false;
        const { server, client } = setup((s) => {
            addItems(s, 150);
            s.override = (call) => {
                if(params(call).get('start') === '100' && !bumped) {
                    bumped = true;
                    s.libraryVersion++;
                }
                return undefined;
            };
        });

        const result = await client.scanTopItems();

        expect(result.items).toHaveLength(150);
        expect(result.libraryVersion).toBe(2);
        expect(server.calls).toHaveLength(4);
    });

    test('scanTopItems gives up when the library changes during the rescan too', async () => {
        const { server, client } = setup((s) => {
            addItems(s, 150);
            s.override = (call) => {
                if(params(call).get('start') === '100') {
                    s.libraryVersion++;
                }
                return undefined;
            };
        });

        const error = await caught(client.scanTopItems()) as ZoteroError;

        expect(error.message).toBe('library changed during duplicate check; retry');
        expect(server.calls).toHaveLength(4);
    });

    test('scanTopItems refuses a library over 20,000 top-level items after one request', async () => {
        const { server, client } = setup((s) => {
            s.override = () => json([], { headers: { 'Total-Results': '20001', 'Last-Modified-Version': '3' } });
        });

        const error = await caught(client.scanTopItems()) as ZoteroError;

        expect(error.message).toBe('the library has 20001 top-level items, more than the 20000 a duplicate check reads');
        expect(error.context).toEqual({ totalResults: 20_001 });
        expect(server.calls).toHaveLength(1);
    });

    test('scanTopItems reads a library of exactly 20,000 items in 200 pages', async () => {
        const { server, client } = setup((s) => {
            s.override = () => json([], { headers: { 'Total-Results': '20000', 'Last-Modified-Version': '3' } });
        });

        const result = await client.scanTopItems();

        expect(result).toEqual({ items: [], libraryVersion: 3 });
        expect(server.calls).toHaveLength(200);
        expect(params(server.calls.at(-1)!).get('start')).toBe('19900');
    });

    test('scanTopItems needs the library version to detect changes', async () => {
        const { client } = setup((s) => {
            s.override = () => json([], { headers: { 'Total-Results': '0' } });
        });

        const error = await caught(client.scanTopItems()) as ZoteroError;

        expect(error.message).toBe('Zotero did not report a library version for /items/top');
    });

    test('getItemTemplate is memoised per item type and hands out copies', async () => {
        const { server, client } = setup((s) => {
            s.templates.set('book', { itemType: 'book', title: '', tags: [] });
            s.templates.set('note', { itemType: 'note', note: '' });
        });

        const first = await client.getItemTemplate('book');
        first.title = 'changed';
        const second = await client.getItemTemplate('book');
        await client.getItemTemplate('note');

        expect(second).toEqual({ itemType: 'book', title: '', tags: [] });
        expect(server.calls).toHaveLength(2);
        expect(server.calls[0].url).toBe(`${API}/items/new?itemType=book`);
    });

    test('a failed template read is not memoised', async () => {
        const { server, client } = setup();

        expect(await caught(client.getItemTemplate('book'))).toBeInstanceOf(ZoteroError);
        server.templates.set('book', { itemType: 'book' });

        expect(await client.getItemTemplate('book')).toEqual({ itemType: 'book' });
    });

    test('a template without an itemType is refused as an unexpected response shape', async () => {
        const { client } = setup(s => s.templates.set('book', { title: '' }));

        const error = await caught(client.getItemTemplate('book')) as ZoteroError;

        expect(error).toBeInstanceOf(ZoteroError);
        expect(error.message).toBe('unexpected Zotero response shape from /items/new');
    });
});

describe('ZoteroClient batch creates', () => {
    test('createItems sends 120 objects as 3 sequential POSTs with fresh write tokens', async () => {
        const { server, client } = setup();

        const result = await client.createItems(Array.from({ length: 120 }, (_, i) => ({ itemType: 'book', title: `B${i}` })));

        const writes = posts(server);
        expect(writes).toHaveLength(3);
        expect(writes.map(call => (JSON.parse(call.bodyText!) as unknown[]).length)).toEqual([50, 50, 20]);
        expect(writes.every(call => pathOf(call) === '/items')).toBe(true);
        expect(server.writeTokens).toHaveLength(3);
        expect(new Set(server.writeTokens).size).toBe(3);
        for(const token of server.writeTokens) {
            expect(token).toMatch(/^[0-9a-f]{32}$/);
        }
        expect(result.successful.map(s => s.index)).toEqual(Array.from({ length: 120 }, (_, i) => i));
        expect(result.successful[119]?.data.title).toBe('B119');
        expect(result.successful[119]?.version).toBe(4);
        expect(result.unchanged).toEqual([]);
        expect(result.failed).toEqual([]);
    });

    test('per-object failures and unchanged objects are remapped to input indices, not thrown', async () => {
        let writes = 0;
        const { client } = setup((s) => {
            s.override = (call) => {
                if(call.method !== 'POST') {
                    return undefined;
                }
                writes++;
                return writes === 2
                    ? json({ successful: {}, unchanged: { '1': 'UNCH2345' }, failed: { '0': { key: 'FAIL2345', code: 400, message: 'bad field' }, '2': { code: 413, message: 'too big' } } })
                    : json({ successful: {} });
            };
        });

        const result = await client.createItems(Array.from({ length: 53 }, () => ({ itemType: 'book' })));

        expect(result.unchanged).toEqual([{ index: 51, key: 'UNCH2345' }]);
        expect(result.failed).toEqual([
            { index: 50, key: 'FAIL2345', code: 400, message: 'bad field' },
            { index: 52, code: 413, message: 'too big' },
        ]);
    });

    test('an empty create sends nothing', async () => {
        const { server, client } = setup();

        expect(await client.createItems([])).toEqual({ successful: [], unchanged: [], failed: [] });
        expect(server.calls).toHaveLength(0);
    });

    test('createCollections posts to /collections', async () => {
        const { server, client } = setup();

        const result = await client.createCollections([{ name: 'Reading', parentCollection: false }, { name: 'Sub', parentCollection: 'PARN2345' }]);

        expect(pathOf(posts(server)[0])).toBe('/collections');
        expect(JSON.parse(posts(server)[0].bodyText!)).toEqual([{ name: 'Reading', parentCollection: false }, { name: 'Sub', parentCollection: 'PARN2345' }]);
        expect(result.successful.map(s => s.data.name)).toEqual(['Reading', 'Sub']);
    });

    test('a request-level failure on a create throws with the ambiguous-write warning', async () => {
        const { client } = setup((s) => {
            s.override = call => (call.method === 'POST' ? status(500, 'oops') : undefined);
        });

        const error = await caught(client.createItems([{ itemType: 'book' }])) as ZoteroServerError;

        expect(error).toBeInstanceOf(ZoteroServerError);
        expect(error.message).toContain('may or may not have been applied');
    });
});

describe('ZoteroClient read-modify-write', () => {
    const retitle = (title: string) => (data: ZoteroItemData): ZoteroItemData => ({ ...data, title });

    test('an expectedVersion that no longer matches is a conflict and nothing is written', async () => {
        const { server, client } = setup((s) => {
            s.addItem({ key: 'ABCD2345', version: 15, title: 'Craig edited', dateModified: '2026-09-27T10:00:00Z' }, { lastModifiedByUser: { username: 'craig' }, createdByUser: { username: 'isambard' } });
        });

        const outcomes = await client.modifyItems([{ key: 'ABCD2345', expectedVersion: 12, apply: retitle('Izzy') }]);

        expect(outcomes).toEqual([{ key: 'ABCD2345', status: 'conflict', expectedVersion: 12, currentVersion: 15, lastModifiedBy: 'craig', dateModified: '2026-09-27T10:00:00Z' }]);
        expect(posts(server)).toHaveLength(0);
        expect(server.items.get('ABCD2345')?.data.title).toBe('Craig edited');
    });

    test('a conflict falls back to the creator and omits unknown details', async () => {
        const { client } = setup((s) => {
            s.addItem({ key: 'ABCD2345', version: 3 }, { createdByUser: { username: 'isambard' } });
            s.addItem({ key: 'EFGH6789', version: 3 });
        });

        const outcomes = await client.modifyItems([
            { key: 'ABCD2345', expectedVersion: 1, apply: retitle('x') },
            { key: 'EFGH6789', expectedVersion: 1, apply: retitle('x') },
        ]);

        expect(outcomes).toEqual([
            { key: 'ABCD2345', status: 'conflict', expectedVersion: 1, currentVersion: 3, lastModifiedBy: 'isambard' },
            { key: 'EFGH6789', status: 'conflict', expectedVersion: 1, currentVersion: 3 },
        ]);
    });

    test('writes the full fresh object with its version and reports the new version', async () => {
        const { server, client } = setup((s) => {
            s.addItem({ key: 'ABCD2345', version: 7, title: 'Old', tags: [{ tag: 'a' }], extra: 'keep me' });
        });

        const outcomes = await client.modifyItems([{ key: 'ABCD2345', expectedVersion: 7, apply: retitle('New') }]);

        const body = JSON.parse(posts(server)[0].bodyText!) as Record<string, unknown>[];
        expect(body).toEqual([{ itemType: 'journalArticle', key: 'ABCD2345', version: 7, title: 'New', tags: [{ tag: 'a' }], extra: 'keep me' }]);
        expect(server.writeTokens[0]).toMatch(/^[0-9a-f]{32}$/);
        expect(outcomes).toEqual([{ key: 'ABCD2345', status: 'updated', version: 2, data: { itemType: 'journalArticle', key: 'ABCD2345', version: 2, title: 'New', tags: [{ tag: 'a' }], extra: 'keep me' } }]);
    });

    test('an update omits dateModified so Zotero stamps the edit time, and keeps dateAdded', async () => {
        const { server, client } = setup((s) => {
            s.addItem({ key: 'ABCD2345', version: 7, title: 'Old', dateAdded: '2020-01-01T00:00:00Z', dateModified: '2020-02-02T00:00:00Z' });
            s.addItem({ key: 'EFGH6789', version: 7, title: 'Same', dateModified: '2020-02-02T00:00:00Z' });
        });
        server.clock.advance(86_400_000);

        const outcomes = await client.modifyItems([
            { key: 'ABCD2345', expectedVersion: 7, apply: retitle('New') },
            { key: 'EFGH6789', expectedVersion: 7, apply: retitle('Same') },
        ]);

        const body = JSON.parse(posts(server)[0].bodyText!) as Record<string, unknown>[];
        expect(body).toEqual([
            { itemType: 'journalArticle', key: 'ABCD2345', version: 7, title: 'New', dateAdded: '2020-01-01T00:00:00Z' },
            { itemType: 'journalArticle', key: 'EFGH6789', version: 7, title: 'Same' },
        ]);
        expect(outcomes.map(outcome => outcome.status)).toEqual(['updated', 'unchanged']);
        expect(server.items.get('ABCD2345')!.data.dateModified).toBe('1970-01-02T00:00:00.000Z');
        expect(server.items.get('EFGH6789')!.data.dateModified).toBe('2020-02-02T00:00:00Z');
    });

    test('without expectedVersion the fresh version is used', async () => {
        const { server, client } = setup((s) => {
            s.addItem({ key: 'ABCD2345', version: 9, title: 'Old' });
        });

        await client.modifyItems([{ key: 'ABCD2345', apply: retitle('New') }]);

        expect((JSON.parse(posts(server)[0].bodyText!) as { version: number }[])[0]?.version).toBe(9);
    });

    test('apply may decline, missing keys are not_found, and Zotero may report unchanged', async () => {
        const { server, client } = setup((s) => {
            s.addItem({ key: 'ABCD2345', title: 'Same' });
            s.addItem({ key: 'EFGH6789', title: 'Same' });
        });

        const outcomes = await client.modifyItems([
            { key: 'ABCD2345', apply: () => 'unchanged' },
            { key: 'MISS2345', apply: retitle('x') },
            { key: 'EFGH6789', apply: retitle('Same') },
        ]);

        expect(outcomes).toEqual([
            { key: 'ABCD2345', status: 'unchanged' },
            { key: 'MISS2345', status: 'not_found' },
            { key: 'EFGH6789', status: 'unchanged' },
        ]);
        expect(posts(server)).toHaveLength(1);
    });

    test('nothing to write sends no POST', async () => {
        const { server, client } = setup((s) => {
            s.addItem({ key: 'ABCD2345' });
        });

        await client.modifyItems([{ key: 'ABCD2345', apply: () => 'unchanged' }]);

        expect(posts(server)).toHaveLength(0);
    });

    test('apply gets a copy, so a mutating apply cannot corrupt the fresh read', async () => {
        const { server, client } = setup((s) => {
            s.addItem({ key: 'ABCD2345', version: 7, tags: [{ tag: 'a' }] });
        });

        await client.modifyItems([{
            key:   'ABCD2345',
            apply: (data) => {
                (data.tags as { tag: string }[]).push({ tag: 'b' });
                return data;
            },
        }]);

        expect((JSON.parse(posts(server)[0].bodyText!) as { tags: unknown }[])[0]?.tags).toEqual([{ tag: 'a' }, { tag: 'b' }]);
    });

    test('a per-object 412 becomes a conflict whose current version comes from a re-read', async () => {
        const { server, client } = setup((s) => {
            s.addItem({ key: 'ABCD2345', version: 7, title: 'Old' });
            s.addItem({ key: 'EFGH6789', version: 7, title: 'Old' });
            s.override = (call) => {
                if(call.method === 'POST') {
                    const craigEdit = s.items.get('ABCD2345')!;
                    craigEdit.version = 11;
                    craigEdit.data.version = 11;
                    craigEdit.meta = { lastModifiedByUser: { username: 'craig' } };
                }
                return undefined;
            };
        });

        const outcomes = await client.modifyItems([
            { key: 'ABCD2345', expectedVersion: 7, apply: retitle('Izzy') },
            { key: 'EFGH6789', expectedVersion: 7, apply: retitle('Izzy') },
        ]);

        expect(outcomes[0]).toEqual({ key: 'ABCD2345', status: 'conflict', expectedVersion: 7, currentVersion: 11, lastModifiedBy: 'craig' });
        expect(outcomes[1]).toMatchObject({ key: 'EFGH6789', status: 'updated' });
        expect(server.calls.filter(call => call.method === 'GET')).toHaveLength(2);
    });

    test('a 412 is reported, never re-applied', async () => {
        let applied = 0;
        const { server, client } = setup((s) => {
            s.addItem({ key: 'ABCD2345', version: 7 });
            s.override = call => (call.method === 'POST' ? json({ failed: { '0': { key: 'ABCD2345', code: 412, message: 'modified' } } }) : undefined);
        });

        const outcomes = await client.modifyItems([{
            key:   'ABCD2345',
            apply: (data) => {
                applied++;
                return { ...data, title: 'x' };
            },
        }]);

        expect(applied).toBe(1);
        expect(posts(server)).toHaveLength(1);
        expect(outcomes).toEqual([{ key: 'ABCD2345', status: 'conflict', expectedVersion: 7, currentVersion: 7 }]);
    });

    test('a re-read that finds the item gone reports not_found', async () => {
        let posted = false;
        const { client } = setup((s) => {
            s.addItem({ key: 'ABCD2345', version: 7 });
            s.override = (call) => {
                if(call.method === 'POST') {
                    posted = true;
                    return json({ failed: { '0': { key: 'ABCD2345', code: 412, message: 'modified' } } });
                }
                return posted ? json([], { headers: { 'Total-Results': '0' } }) : undefined;
            };
        });

        const outcomes = await client.modifyItems([{ key: 'ABCD2345', apply: retitle('x') }]);

        expect(outcomes).toEqual([{ key: 'ABCD2345', status: 'not_found' }]);
    });

    test('a re-read failure after a 412 is reported per key, keeping the other outcomes', async () => {
        let posted = false;
        const { client } = setup((s) => {
            s.addItem({ key: 'ABCD2345', version: 7 });
            s.addItem({ key: 'EFGH6789', version: 7 });
            s.override = (call) => {
                if(call.method === 'POST') {
                    posted = true;
                    return json({ successful: { '1': { key: 'EFGH6789', version: 8, data: { key: 'EFGH6789', version: 8, itemType: 'book' } } }, failed: { '0': { key: 'ABCD2345', code: 412, message: 'modified' } } });
                }
                return posted ? status(403, 'no') : undefined;
            };
        });

        const outcomes = await client.modifyItems([
            { key: 'ABCD2345', apply: retitle('x') },
            { key: 'EFGH6789', apply: retitle('x') },
        ]);

        expect(outcomes[0]).toEqual({ key: 'ABCD2345', status: 'failed', code: 412, message: expect.stringContaining('changed since it was read; re-reading it failed: Zotero refused access') as unknown as string });
        expect(outcomes[1]).toEqual({ key: 'EFGH6789', status: 'updated', version: 8, data: { key: 'EFGH6789', version: 8, itemType: 'book' } });
    });

    test('a request-level 412 reports every key in the batch as a conflict', async () => {
        const { client } = setup((s) => {
            s.addItem({ key: 'ABCD2345', version: 7 });
            s.addItem({ key: 'EFGH6789', version: 7 });
            s.override = call => (call.method === 'POST' ? status(412, 'Library has been modified', { 'Last-Modified-Version': '20' }) : undefined);
        });

        const outcomes = await client.modifyItems([
            { key: 'ABCD2345', apply: retitle('x') },
            { key: 'EFGH6789', apply: retitle('x') },
        ]);

        expect(outcomes.map(o => o.status)).toEqual(['conflict', 'conflict']);
    });

    test('other per-object failures are reported with their code and message', async () => {
        const { client } = setup((s) => {
            s.addItem({ key: 'ABCD2345', version: 7 });
            s.override = call => (call.method === 'POST' ? json({ failed: { '0': { key: 'ABCD2345', code: 400, message: "Invalid field 'bogus'" } } }) : undefined);
        });

        const outcomes = await client.modifyItems([{ key: 'ABCD2345', apply: data => ({ ...data, bogus: 'x' }) }]);

        expect(outcomes).toEqual([{ key: 'ABCD2345', status: 'failed', code: 400, message: "Invalid field 'bogus'" }]);
    });

    test('a write Zotero does not account for is reported as failed', async () => {
        const { client } = setup((s) => {
            s.addItem({ key: 'ABCD2345', version: 7 });
            s.override = call => (call.method === 'POST' ? json({}) : undefined);
        });

        const outcomes = await client.modifyItems([{ key: 'ABCD2345', apply: retitle('x') }]);

        expect(outcomes).toEqual([{ key: 'ABCD2345', status: 'failed', code: 0, message: 'Zotero returned no result for this object' }]);
    });

    test('other request-level write failures propagate', async () => {
        const { client } = setup((s) => {
            s.addItem({ key: 'ABCD2345', version: 7 });
            s.override = call => (call.method === 'POST' ? status(400, 'bad') : undefined);
        });

        expect(await caught(client.modifyItems([{ key: 'ABCD2345', apply: retitle('x') }]))).toBeInstanceOf(ZoteroError);
    });

    test('a key may appear only once in a batch', async () => {
        const { server, client } = setup();

        const error = await caught(client.modifyItems([{ key: 'ABCD2345', apply: retitle('a') }, { key: 'ABCD2345', apply: retitle('b') }])) as ZoteroError;

        expect(error.message).toBe('ABCD2345 appears more than once in one batch; combine the edits');
        expect(server.calls).toHaveLength(0);
    });

    test('more than 50 edits are written in sequential chunks of 50', async () => {
        const keys: string[] = [];
        const { server, client } = setup((s) => {
            keys.push(...addItems(s, 60));
        });

        const outcomes = await client.modifyItems(keys.map(key => ({ key, apply: retitle('x') })));

        expect(posts(server).map(call => (JSON.parse(call.bodyText!) as unknown[]).length)).toEqual([50, 10]);
        expect(outcomes.every(o => o.status === 'updated')).toBe(true);
    });

    test('modifyCollections renames with the collection version', async () => {
        const { server, client } = setup((s) => {
            s.addCollection({ key: 'CLLN2345', version: 4, name: 'Old' });
        });

        const outcomes = await client.modifyCollections([{ key: 'CLLN2345', expectedVersion: 4, apply: data => ({ ...data, name: 'New' }) }]);

        expect(pathOf(posts(server)[0])).toBe('/collections');
        expect(JSON.parse(posts(server)[0].bodyText!)).toEqual([{ key: 'CLLN2345', version: 4, name: 'New', parentCollection: false }]);
        expect(outcomes[0]).toMatchObject({ key: 'CLLN2345', status: 'updated' });
    });

    test('a stale collection rename is a conflict and keeps the name', async () => {
        const { server, client } = setup((s) => {
            s.addCollection({ key: 'CLLN2345', version: 2, name: 'Craig name' });
        });

        const outcomes = await client.modifyCollections([{ key: 'CLLN2345', expectedVersion: 1, apply: data => ({ ...data, name: 'Izzy name' }) }]);

        expect(outcomes[0]?.status).toBe('conflict');
        expect(posts(server)).toHaveLength(0);
    });

    test('setItemsDeleted trashes and restores, and leaves items already in that state unchanged', async () => {
        const { server, client } = setup((s) => {
            s.addItem({ key: 'ABCD2345', version: 3 });
            s.addItem({ key: 'EFGH6789', version: 3, deleted: 1 });
            s.addItem({ key: 'JKLM2345', version: 3, deleted: true });
        });

        const trashed = await client.setItemsDeleted([{ key: 'ABCD2345', expectedVersion: 3 }, { key: 'EFGH6789' }, { key: 'JKLM2345' }], true);
        expect(trashed.map(o => o.status)).toEqual(['updated', 'unchanged', 'unchanged']);
        expect(JSON.parse(posts(server)[0].bodyText!)).toEqual([{ itemType: 'journalArticle', key: 'ABCD2345', version: 3, deleted: true }]);

        const restored = await client.setItemsDeleted([{ key: 'EFGH6789' }, { key: 'MISS2345' }], false);
        expect(restored.map(o => o.status)).toEqual(['updated', 'not_found']);
        expect((JSON.parse(posts(server)[1].bodyText!) as { deleted: unknown }[])[0]?.deleted).toBe(false);
    });

    test('setCollectionsDeleted trashes a collection with the deleted flag', async () => {
        const { server, client } = setup((s) => {
            s.addCollection({ key: 'CLLN2345', version: 2 });
        });

        const outcomes = await client.setCollectionsDeleted([{ key: 'CLLN2345', expectedVersion: 2 }], true);

        expect(outcomes[0]?.status).toBe('updated');
        expect((JSON.parse(posts(server)[0].bodyText!) as { deleted: unknown }[])[0]?.deleted).toBe(true);
    });
});

describe('ZoteroClient file upload', () => {
    const PDF = new TextEncoder().encode('%PDF-1.7 test');
    // eslint-disable-next-line sonarjs/hashing -- recomputes the md5 Zotero's file protocol uses as a content identity
    const MD5 = createHash('md5').update(PDF).digest('hex');
    const file = { bytes: PDF, filename: 'paper.pdf', contentType: 'application/pdf' as const, mtimeMs: 1_700_000_000_123.7 };

    function uploadServer(steps: { authorize?: Response, storage?: Response, register?: Response }) {
        return setup((s) => {
            s.override = (call) => {
                if(call.url === 'https://storage.test/upload') {
                    return steps.storage ?? status(201);
                }
                if(pathOf(call) === '/items/ATTC2345/file') {
                    return call.bodyText?.startsWith('upload=')
                        ? steps.register ?? status(204)
                        : steps.authorize ?? json({ url: 'https://storage.test/upload', contentType: 'multipart/form-data; boundary=XYZ', prefix: 'PRE', suffix: 'SUF', uploadKey: 'UPKEY' });
                }
                return undefined;
            };
        });
    }

    test('an exists:1 authorisation short-circuits after one request', async () => {
        const { server, client } = uploadServer({ authorize: json({ exists: 1 }) });

        expect(await client.uploadAttachmentFile('ATTC2345', file)).toBe('exists');

        expect(server.calls).toHaveLength(1);
        const call = server.calls[0];
        expect(call.method).toBe('POST');
        expect(call.headers.get('If-None-Match')).toBe('*');
        expect(call.headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
        expect(Object.fromEntries(new URLSearchParams(call.bodyText))).toEqual({ md5: MD5, filename: 'paper.pdf', filesize: String(PDF.length), mtime: '1700000000123' });
    });

    test('the full three-step upload sends the file to storage without the API key', async () => {
        const { server, client } = uploadServer({});

        expect(await client.uploadAttachmentFile('ATTC2345', file)).toBe('uploaded');

        expect(server.calls).toHaveLength(3);
        const storage = server.calls[1];
        expect(storage.url).toBe('https://storage.test/upload');
        expect(storage.method).toBe('POST');
        expect(storage.headers.get('Zotero-API-Key')).toBeNull();
        expect(storage.headers.get('Content-Type')).toBe('multipart/form-data; boundary=XYZ');
        expect(storage.bodyText).toBe('PRE%PDF-1.7 testSUF');
        const register = server.calls[2];
        expect(register.bodyText).toBe('upload=UPKEY');
        expect(register.headers.get('If-None-Match')).toBe('*');
        expect(register.headers.get('Zotero-API-Key')).toBe(TEST_API_KEY);
    });

    test.each([
        ['authorisation', { authorize: status(412, 'If-None-Match') }],
        ['registration', { register: status(412, 'If-None-Match') }],
    ])('a 412 on %s means the attachment already has a file', async (_label, steps) => {
        const { client } = uploadServer(steps);

        const error = await caught(client.uploadAttachmentFile('ATTC2345', file)) as ZoteroFileError;

        expect(error).toBeInstanceOf(ZoteroFileError);
        expect(error.message).toBe('Attachment ATTC2345 already has a file');
        expect(error.context).toEqual({ reason: 'already_has_file', key: 'ATTC2345' });
    });

    test('a 413 on authorisation is a quota error naming Craig\'s plan', async () => {
        const { client } = uploadServer({ authorize: status(413) });

        const error = await caught(client.uploadAttachmentFile('ATTC2345', file));

        expect(error).toBeInstanceOf(ZoteroQuotaError);
        expect((error as Error).message).toContain('Craig owns the storage plan');
    });

    test('a storage response other than 201 is upload_failed', async () => {
        const { server, client } = uploadServer({ storage: status(400, 'policy') });

        const error = await caught(client.uploadAttachmentFile('ATTC2345', file)) as ZoteroFileError;

        expect(error.context).toEqual({ reason: 'upload_failed', status: 400, key: 'ATTC2345' });
        expect(error.message).toBe('Uploading the file for ATTC2345 to Zotero storage failed (HTTP 400)');
        expect(server.calls).toHaveLength(2);
    });

    test('a non-https upload URL is refused before anything is sent to it', async () => {
        const { server, client } = uploadServer({ authorize: json({ url: 'http://storage.test/upload', contentType: 'x', prefix: '', suffix: '', uploadKey: 'K' }) });

        const error = await caught(client.uploadAttachmentFile('ATTC2345', file)) as ZoteroFileError;

        expect(error.context).toEqual({ reason: 'upload_failed', key: 'ATTC2345' });
        expect(error.message).toBe('Zotero returned a non-https upload URL for ATTC2345; refusing to upload');
        expect(server.calls).toHaveLength(1);
    });

    test('a registration that is not 204 is upload_failed', async () => {
        const { client } = uploadServer({ register: json({}) });

        const error = await caught(client.uploadAttachmentFile('ATTC2345', file)) as ZoteroFileError;

        expect(error.context).toEqual({ reason: 'upload_failed', status: 200, key: 'ATTC2345' });
        expect(error.message).toBe('Registering the upload for ATTC2345 returned HTTP 200');
    });

    test('other authorisation failures propagate unchanged', async () => {
        const { client } = uploadServer({ authorize: status(403) });

        expect(await caught(client.uploadAttachmentFile('ATTC2345', file))).toBeInstanceOf(ZoteroAuthError);
    });

    test('a malformed attachment key is rejected before sending', async () => {
        const { server, client } = uploadServer({});

        expect(await caught(client.uploadAttachmentFile('../../x', file))).toBeInstanceOf(InvariantViolationError);
        expect(server.calls).toHaveLength(0);
    });
});

describe('ZoteroClient.cleanupPlaceholders', () => {
    const OURS = 'a'.repeat(32);

    test('nothing to check makes no request', async () => {
        const { server, client } = setup();

        expect(await client.cleanupPlaceholders([])).toEqual([]);
        expect(server.calls).toHaveLength(0);
    });

    test('a registration that committed although its response was lost is completed, not trashed', async () => {
        const { server, client } = setup((s) => {
            s.addItem({ key: 'ATTC2345', version: 6, itemType: 'attachment', md5: OURS });
        });

        const outcomes = await client.cleanupPlaceholders([{ key: 'ATTC2345', createdVersion: 5, md5: OURS }]);

        expect(outcomes).toEqual([{ key: 'ATTC2345', outcome: 'completed' }]);
        expect(posts(server)).toHaveLength(0);
    });

    test('a concurrent file attach or edit is changed and left alone', async () => {
        const { server, client } = setup((s) => {
            s.addItem({ key: 'ATTC2345', version: 6, itemType: 'attachment', md5: 'b'.repeat(32) });
            s.addItem({ key: 'EDIT2345', version: 9, itemType: 'attachment', md5: null });
            s.addItem({ key: 'SAME2345', version: 5, itemType: 'attachment', md5: 'c'.repeat(32) });
        });

        const outcomes = await client.cleanupPlaceholders([
            { key: 'ATTC2345', createdVersion: 5, md5: OURS },
            { key: 'EDIT2345', createdVersion: 5, md5: OURS },
            { key: 'SAME2345', createdVersion: 5, md5: OURS },
        ]);

        expect(outcomes).toEqual([
            { key: 'ATTC2345', outcome: 'changed', detail: 'attachment changed concurrently; left as is' },
            { key: 'EDIT2345', outcome: 'changed', detail: 'attachment changed concurrently; left as is' },
            { key: 'SAME2345', outcome: 'changed', detail: 'attachment changed concurrently; left as is' },
        ]);
        expect(posts(server)).toHaveLength(0);
    });

    test('a failed re-read or a missing key is indeterminate and nothing is trashed', async () => {
        const failing = setup((s) => {
            s.override = () => status(403, 'no');
        });
        const failed = await failing.client.cleanupPlaceholders([{ key: 'ATTC2345', createdVersion: 5, md5: OURS }]);
        expect(failed).toEqual([{ key: 'ATTC2345', outcome: 'indeterminate', detail: expect.stringContaining('could not re-read the attachment: Zotero refused access') }]);
        expect(posts(failing.server)).toHaveLength(0);

        const missing = setup();
        expect(await missing.client.cleanupPlaceholders([{ key: 'ATTC2345', createdVersion: 5, md5: OURS }])).toEqual([
            { key: 'ATTC2345', outcome: 'indeterminate', detail: 'attachment not found on re-read' },
        ]);
    });

    test('unchanged, empty placeholders are trashed in one batch with their creation version', async () => {
        const { server, client } = setup((s) => {
            s.addItem({ key: 'ATTC2345', version: 5, itemType: 'attachment', md5: null });
            s.addItem({ key: 'ATTD2345', version: 5, itemType: 'attachment' });
        });

        const outcomes = await client.cleanupPlaceholders([
            { key: 'ATTC2345', createdVersion: 5, md5: OURS },
            { key: 'ATTD2345', createdVersion: 5, md5: OURS },
        ]);

        expect(outcomes).toEqual([{ key: 'ATTC2345', outcome: 'trashed' }, { key: 'ATTD2345', outcome: 'trashed' }]);
        expect(posts(server)).toHaveLength(1);
        const body = JSON.parse(posts(server)[0].bodyText!) as { key: string, version: number, deleted: boolean }[];
        expect(body.map(o => [o.key, o.version, o.deleted])).toEqual([['ATTC2345', 5, true], ['ATTD2345', 5, true]]);
    });

    test('an empty placeholder already in the trash counts as trashed', async () => {
        const { client } = setup((s) => {
            s.addItem({ key: 'ATTC2345', version: 5, itemType: 'attachment', md5: null, deleted: 1 });
        });

        expect(await client.cleanupPlaceholders([{ key: 'ATTC2345', createdVersion: 5, md5: OURS }])).toEqual([{ key: 'ATTC2345', outcome: 'trashed' }]);
    });

    test('a change between the check and the trash write is reported as changed', async () => {
        let reads = 0;
        const { client } = setup((s) => {
            s.addItem({ key: 'ATTC2345', version: 5, itemType: 'attachment', md5: null });
            s.override = (call) => {
                if(call.method === 'GET') {
                    reads++;
                    if(reads === 2) {
                        const item = s.items.get('ATTC2345')!;
                        item.version = 6;
                        item.data.version = 6;
                    }
                }
                return undefined;
            };
        });

        const outcomes = await client.cleanupPlaceholders([{ key: 'ATTC2345', createdVersion: 5, md5: OURS }]);

        expect(outcomes).toEqual([{ key: 'ATTC2345', outcome: 'changed', detail: 'attachment changed concurrently; left as is' }]);
    });

    test('a per-object 412 on the trash write is reported as changed', async () => {
        const { client } = setup((s) => {
            s.addItem({ key: 'ATTC2345', version: 5, itemType: 'attachment', md5: null });
            s.override = call => (call.method === 'POST' ? json({ failed: { '0': { key: 'ATTC2345', code: 412, message: 'modified' } } }) : undefined);
        });

        const outcomes = await client.cleanupPlaceholders([{ key: 'ATTC2345', createdVersion: 5, md5: OURS }]);

        expect(outcomes[0]?.outcome).toBe('changed');
    });

    test('a trash write that fails outright or per object is indeterminate', async () => {
        const thrown = setup((s) => {
            s.addItem({ key: 'ATTC2345', version: 5, itemType: 'attachment', md5: null });
            s.override = call => (call.method === 'POST' ? status(400, 'nope') : undefined);
        });
        expect(await thrown.client.cleanupPlaceholders([{ key: 'ATTC2345', createdVersion: 5, md5: OURS }])).toEqual([
            { key: 'ATTC2345', outcome: 'indeterminate', detail: 'trashing the empty placeholder failed: Zotero rejected the request to /items (HTTP 400): nope' },
        ]);

        const perObject = setup((s) => {
            s.addItem({ key: 'ATTC2345', version: 5, itemType: 'attachment', md5: null });
            s.override = call => (call.method === 'POST' ? json({ failed: { '0': { key: 'ATTC2345', code: 500, message: 'db down' } } }) : undefined);
        });
        expect(await perObject.client.cleanupPlaceholders([{ key: 'ATTC2345', createdVersion: 5, md5: OURS }])).toEqual([
            { key: 'ATTC2345', outcome: 'indeterminate', detail: 'trashing the empty placeholder failed: db down' },
        ]);

        const vanished = setup((s) => {
            s.addItem({ key: 'ATTC2345', version: 5, itemType: 'attachment', md5: null });
            let reads = 0;
            s.override = (call) => {
                reads++;
                return reads === 2 && call.method === 'GET' ? json([], { headers: { 'Total-Results': '0' } }) : undefined;
            };
        });
        expect(await vanished.client.cleanupPlaceholders([{ key: 'ATTC2345', createdVersion: 5, md5: OURS }])).toEqual([
            { key: 'ATTC2345', outcome: 'indeterminate', detail: 'attachment not found when trashing it' },
        ]);
    });
});

describe('ZoteroClient file download', () => {
    function downloadServer(file: Response, storage?: Response) {
        return setup((s) => {
            s.override = (call) => {
                if(call.url.startsWith('https://storage.test/')) {
                    return storage ?? status(500);
                }
                return pathOf(call) === '/items/ATTC2345/file' ? file : undefined;
            };
        });
    }

    function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
        return new ReadableStream({
            start(controller) {
                for(const chunk of chunks) {
                    controller.enqueue(new TextEncoder().encode(chunk));
                }
                controller.close();
            },
        });
    }

    test('a 302 is followed manually, without the key, to the storage host', async () => {
        const { server, client } = downloadServer(
            status(302, '', { Location: 'https://storage.test/file?sig=abc' }),
            new Response('%PDF-1.7 bytes', { status: 200, headers: { 'Content-Type': 'Application/PDF; charset=binary' } })
        );

        const result = await client.downloadAttachmentFile('ATTC2345', 1000);

        expect(new TextDecoder().decode(result.bytes)).toBe('%PDF-1.7 bytes');
        expect(result.contentType).toBe('application/pdf');
        expect(server.calls[0].init.redirect).toBe('manual');
        expect(server.calls[1].url).toBe('https://storage.test/file?sig=abc');
        expect(server.calls[1].headers.get('Zotero-API-Key')).toBeNull();
    });

    test.each([301, 303, 307, 308])('a %d redirect is followed too', async (code) => {
        const { client } = downloadServer(status(code, '', { Location: 'https://storage.test/f' }), new Response('x', { status: 200 }));

        const result = await client.downloadAttachmentFile('ATTC2345', 10);
        expect(result.contentType).toBe('application/octet-stream');
    });

    test('a declared Content-Length equal to the cap is read', async () => {
        const { client } = downloadServer(new Response('hello', { status: 200, headers: { 'Content-Length': '5' } }));

        const result = await client.downloadAttachmentFile('ATTC2345', 5);

        expect(result.bytes).toHaveLength(5);
    });

    test('a 200 is read directly', async () => {
        const { server, client } = downloadServer(new Response('hello', { status: 200, headers: { 'Content-Type': 'text/plain' } }));

        const result = await client.downloadAttachmentFile('ATTC2345', 5);

        expect(new TextDecoder().decode(result.bytes)).toBe('hello');
        expect(result.contentType).toBe('text/plain');
        expect(server.calls).toHaveLength(1);
    });

    test('a 404 means the attachment has no stored file', async () => {
        const { client } = downloadServer(status(404, 'Not found'));

        const error = await caught(client.downloadAttachmentFile('ATTC2345', 10)) as ZoteroFileError;

        expect(error.context).toEqual({ reason: 'no_file', key: 'ATTC2345' });
        expect(error.message).toBe('Attachment ATTC2345 has no stored file');
    });

    test('other API errors propagate', async () => {
        const { client } = downloadServer(status(403));

        expect(await caught(client.downloadAttachmentFile('ATTC2345', 10))).toBeInstanceOf(ZoteroAuthError);
    });

    test('a declared Content-Length over the cap is refused before reading', async () => {
        const { client } = downloadServer(new Response('hello world', { status: 200, headers: { 'Content-Length': '11' } }));

        const error = await caught(client.downloadAttachmentFile('ATTC2345', 10)) as ZoteroFileError;

        expect(error.context).toEqual({ reason: 'too_large', limit: 10, key: 'ATTC2345' });
        expect(error.message).toBe('The stored file for ATTC2345 is larger than the 10-byte limit');
    });

    test('a stream that passes the cap is cancelled', async () => {
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.enqueue(new TextEncoder().encode('123456'));
            },
            cancel() {
                cancelled = true;
            },
        });
        const { client } = downloadServer(new Response(body, { status: 200 }));

        const error = await caught(client.downloadAttachmentFile('ATTC2345', 10)) as ZoteroFileError;

        expect(error.reason).toBe('too_large');
        expect(cancelled).toBe(true);
    });

    test('a file of exactly the cap, in several chunks, is read whole', async () => {
        const { client } = downloadServer(new Response(streamOf(['12345', '67890']), { status: 200 }));

        const result = await client.downloadAttachmentFile('ATTC2345', 10);

        expect(new TextDecoder().decode(result.bytes)).toBe('1234567890');
    });

    test('an empty body is an empty file', async () => {
        const { client } = downloadServer(status(200));

        const result = await client.downloadAttachmentFile('ATTC2345', 10);
        expect(result.bytes).toHaveLength(0);
    });

    test.each([
        ['a non-https Location', status(302, '', { Location: 'http://storage.test/f' })],
        ['a missing Location', status(302)],
        ['a non-200 API status', status(204)],
    ])('%s is download_failed', async (_label, response) => {
        const { client } = downloadServer(response);

        const error = await caught(client.downloadAttachmentFile('ATTC2345', 10)) as ZoteroFileError;

        expect(error.reason).toBe('download_failed');
        expect(error.context.key).toBe('ATTC2345');
    });

    test('a failing storage host is download_failed with its status', async () => {
        const { client } = downloadServer(status(302, '', { Location: 'https://storage.test/f' }), status(403, 'expired'));

        const error = await caught(client.downloadAttachmentFile('ATTC2345', 10)) as ZoteroFileError;

        expect(error.context).toEqual({ reason: 'download_failed', status: 403, key: 'ATTC2345' });
        expect(error.message).toBe('Downloading the stored file for ATTC2345 failed (HTTP 403)');
    });

    test('a malformed key is rejected before sending', async () => {
        const { server, client } = downloadServer(status(200));

        expect(await caught(client.downloadAttachmentFile('x/../y', 10))).toBeInstanceOf(InvariantViolationError);
        expect(server.calls).toHaveLength(0);
    });
});

describe('ModifyOutcome typing', () => {
    test('outcomes are a discriminated union on status', () => {
        const outcome: ModifyOutcome<ZoteroItemData> = { key: 'ABCD2345', status: 'not_found' };

        expect(outcome.status).toBe('not_found');
    });
});
