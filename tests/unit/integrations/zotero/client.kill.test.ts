/**
 * Kills surviving mutants in `src/integrations/zotero/client.ts` (#157, group "client").
 *
 * Each test targets one or more specific mutants left alive by the existing `client.test.ts`
 * suite: an unchecked error message/context, an `idempotent`/`file` flag whose only observable
 * effect is retry/timeout behaviour, an `await` whose only observable effect is ordering a
 * rejection before a fallback throw, or an array-order mutation whose only observable effect is
 * the shape of a follow-up request. No test here weakens an existing assertion.
 */
import { describe, expect, test } from 'bun:test';
import {
    FakeZoteroServer,
    STORAGE,
    TEST_API_KEY,
    fakeKey,
    json,
    status,
    type RecordedCall
} from '../../../helpers/zotero-fake';
import {
    InvariantViolationError,
    type ZoteroError,
    ZoteroFileError,
    ZoteroServerError
} from '@/errors';
import { ZoteroClient } from '@/integrations/zotero/client';

function setup(configure?: (server: FakeZoteroServer) => void, readConcurrency?: number) {
    const server = new FakeZoteroServer();
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

function addItems(server: FakeZoteroServer, count: number): string[] {
    return Array.from({ length: count }, (_, i) => server.addItem({ key: fakeKey(i), title: `T${i}` }).key);
}

/**
 * A `ReadableStream` whose `cancel()` rejects. It must stay open (never call `close()`): a stream
 * the spec already considers closed resolves `cancel()` immediately without running this handler,
 * which would silently defeat the test.
 */
function rejectingBody(reason: string): ReadableStream<Uint8Array> {
    return new ReadableStream({
        pull(controller) {
            controller.enqueue(new TextEncoder().encode('x'));
        },
        cancel() {
            return Promise.reject(new Error(reason));
        },
    });
}

const PDF = new TextEncoder().encode('%PDF-1.7 test');
const file = { bytes: PDF, filename: 'paper.pdf', contentType: 'application/pdf' as const, mtimeMs: 1_700_000_000_123 };

function uploadServer(steps: { authorize?: Response, storage?: Response, register?: Response }) {
    return setup((s) => {
        s.override = (call) => {
            if(call.url === `${STORAGE}/upload`) {
                return steps.storage ?? status(201);
            }
            if(pathOf(call) === '/items/ATTC2345/file') {
                return call.bodyText?.startsWith('upload=')
                    ? steps.register ?? status(204)
                    : steps.authorize ?? json({ url: `${STORAGE}/upload`, contentType: 'multipart/form-data; boundary=XYZ', prefix: 'PRE', suffix: 'SUF', uploadKey: 'UPKEY' });
            }
            return undefined;
        };
    });
}

function downloadServer(fileResponse: Response, storageResponse?: Response) {
    return setup((s) => {
        s.override = (call) => {
            if(call.url.startsWith(`${STORAGE}/`)) {
                return storageResponse ?? status(500);
            }
            return pathOf(call) === '/items/ATTC2345/file' ? fileResponse : undefined;
        };
    });
}

describe('assertKey error text and defense-in-depth masking', () => {
    test("assertKey's invariant names the location and the offending key verbatim", async () => {
        const { client } = setup();

        const error = await caught(client.getItems(['abcd2345'])) as InvariantViolationError;

        expect(error.message).toBe('Invariant violated in ZoteroClient: invalid Zotero key "abcd2345"');
    });

    test('searchItems rejects a malformed collection key that would not trip the URL path guard', async () => {
        const { server, client } = setup();

        expect(await caught(client.searchItems({ collectionKey: 'abcd2345', limit: 1, start: 0, sort: 'title', direction: 'asc' }))).toBeInstanceOf(InvariantViolationError);
        expect(server.calls).toHaveLength(0);
    });

    test('getChildren rejects a malformed parent key that would not trip the URL path guard', async () => {
        const { server, client } = setup();

        expect(await caught(client.getChildren(['abcd2345']))).toBeInstanceOf(InvariantViolationError);
        expect(server.calls).toHaveLength(0);
    });

    test('uploadAttachmentFile rejects a malformed key that would not trip the URL path guard', async () => {
        const { server, client } = uploadServer({});

        expect(await caught(client.uploadAttachmentFile('abcd2345', file))).toBeInstanceOf(InvariantViolationError);
        expect(server.calls).toHaveLength(0);
    });

    test('downloadAttachmentFile rejects a malformed key that would not trip the URL path guard', async () => {
        const { server, client } = downloadServer(status(200));

        expect(await caught(client.downloadAttachmentFile('abcd2345', 10))).toBeInstanceOf(InvariantViolationError);
        expect(server.calls).toHaveLength(0);
    });
});

describe('read-modify-write: strict field omission', () => {
    // No test for usernameOf's `user !== null` branch (client.ts ~L158): `meta.lastModifiedByUser`
    // is parsed through `userRefSchema` (a non-nullable z.looseObject) on every read, so a
    // schema-valid response can never hand that branch a literal `null`; that mutant is left in
    // notKilled as effectively unreachable through the client's public API.

    test('a conflict without a known editor strictly omits the lastModifiedBy field, not just as undefined', async () => {
        const { client } = setup((s) => {
            s.addItem({ key: 'EFGH6789', version: 3 });
        });

        const outcomes = await client.modifyItems([{ key: 'EFGH6789', expectedVersion: 1, apply: data => data }]);

        expect(outcomes[0]).toStrictEqual({ key: 'EFGH6789', status: 'conflict', expectedVersion: 1, currentVersion: 3 });
        expect(Object.hasOwn(outcomes[0], 'lastModifiedBy')).toBe(false);
    });

    test('a duplicate batch key reports the offending key in its context', async () => {
        const { client } = setup();

        const error = await caught(client.modifyItems([
            { key: 'ABCD2345', apply: data => data },
            { key: 'ABCD2345', apply: data => data },
        ])) as ZoteroError;

        expect(error.context).toEqual({ key: 'ABCD2345' });
    });
});

describe('cleanupPlaceholders: version drift without a file', () => {
    test('a version drift alone, with no file, is changed without attempting to trash it', async () => {
        const { server, client } = setup((s) => {
            s.addItem({ key: 'EDIT2345', version: 9, itemType: 'attachment', md5: null });
        });

        const outcomes = await client.cleanupPlaceholders([{ key: 'EDIT2345', createdVersion: 5, md5: 'a'.repeat(32) }]);

        expect(outcomes).toEqual([{ key: 'EDIT2345', outcome: 'changed', detail: 'attachment changed concurrently; left as is' }]);
        // Only the one fresh-read GET: a real drift-only case never reaches the trash write, unlike
        // a version-drift-plus-conflict path which would need an extra read to resolve the 412.
        expect(server.calls).toHaveLength(1);
    });
});

describe('setCollectionsDeleted: already-deleted is unchanged', () => {
    test('setCollectionsDeleted leaves an already-deleted collection unchanged and sends no write', async () => {
        const { server, client } = setup((s) => {
            s.addCollection({ key: 'CLLN2345', version: 2, deleted: true });
        });

        const outcomes = await client.setCollectionsDeleted([{ key: 'CLLN2345', expectedVersion: 2 }], true);

        expect(outcomes[0]?.status).toBe('unchanged');
        expect(posts(server)).toHaveLength(0);
    });
});

describe('idempotent/file flags: retry and timeout are the only observable effects', () => {
    test('getItemTemplate retries after a transient server error, since the read is idempotent', async () => {
        let attempts = 0;
        const { server, client } = setup((s) => {
            s.templates.set('book', { itemType: 'book' });
            s.override = (call) => {
                if(pathOf(call) !== '/items/new') {
                    return undefined;
                }
                attempts++;
                return attempts === 1 ? status(500, 'boom') : undefined;
            };
        });

        const template = await client.getItemTemplate('book');

        expect(template).toEqual({ itemType: 'book' });
        expect(server.calls).toHaveLength(2);
    });

    test('the upload authorisation POST is not retried after a transient error (writes are unsafe to repeat blind)', async () => {
        let attempts = 0;
        const { client } = setup((s) => {
            s.override = (call) => {
                if(pathOf(call) !== '/items/ATTC2345/file') {
                    return undefined;
                }
                attempts++;
                return status(500, 'boom');
            };
        });

        const error = await caught(client.uploadAttachmentFile('ATTC2345', file)) as ZoteroServerError;

        expect(error).toBeInstanceOf(ZoteroServerError);
        expect(error.message).toContain('may or may not have been applied');
        expect(attempts).toBe(1);
    });

    test('a transient storage upload failure is retried since the upload is treated as idempotent', async () => {
        let attempts = 0;
        const { client } = setup((s) => {
            s.override = (call) => {
                if(call.url === `${STORAGE}/upload`) {
                    attempts++;
                    return attempts === 1 ? status(500, 'boom') : status(201);
                }
                if(pathOf(call) === '/items/ATTC2345/file') {
                    return call.bodyText?.startsWith('upload=')
                        ? status(204)
                        : json({ url: `${STORAGE}/upload`, contentType: 'application/pdf', prefix: '', suffix: '', uploadKey: 'UPKEY' });
                }
                return undefined;
            };
        });

        expect(await client.uploadAttachmentFile('ATTC2345', file)).toBe('uploaded');
        expect(attempts).toBe(2);
    });

    test('the registration POST is not retried after a transient error (writes are unsafe to repeat blind)', async () => {
        let attempts = 0;
        const { client } = setup((s) => {
            s.override = (call) => {
                if(call.url === `${STORAGE}/upload`) {
                    return status(201);
                }
                if(pathOf(call) !== '/items/ATTC2345/file') {
                    return undefined;
                }
                if(call.bodyText?.startsWith('upload=')) {
                    attempts++;
                    return status(500, 'boom');
                }
                return json({ url: `${STORAGE}/upload`, contentType: 'application/pdf', prefix: '', suffix: '', uploadKey: 'UPKEY' });
            };
        });

        const error = await caught(client.uploadAttachmentFile('ATTC2345', file)) as ZoteroServerError;

        expect(error).toBeInstanceOf(ZoteroServerError);
        expect(error.message).toContain('may or may not have been applied');
        expect(attempts).toBe(1);
    });

    test('the raw file GET retries after a transient error, since the read is idempotent', async () => {
        let attempts = 0;
        const { client } = setup((s) => {
            s.override = (call) => {
                if(pathOf(call) !== '/items/ATTC2345/file' || call.method !== 'GET') {
                    return undefined;
                }
                attempts++;
                return attempts === 1 ? status(500, 'boom') : new Response('hi', { status: 200 });
            };
        });

        const result = await client.downloadAttachmentFile('ATTC2345', 100);

        expect(new TextDecoder().decode(result.bytes)).toBe('hi');
        expect(attempts).toBe(2);
    });

    test('downloadAttachmentFile requests the raw file with the longer file timeout, not the request timeout', async () => {
        const server = new FakeZoteroServer();
        server.override = call => (pathOf(call) === '/items/ATTC2345/file' ? new Response('hi', { status: 200 }) : undefined);
        const timeouts: number[] = [];
        const client = new ZoteroClient({
            apiKey:        TEST_API_KEY,
            groupId:       6_692_257,
            fetch:         server.fetch,
            sleep:         server.clock.sleep,
            now:           server.clock.now,
            timeoutSignal: (ms) => {
                timeouts.push(ms);
                return new AbortController().signal;
            },
        });

        await client.downloadAttachmentFile('ATTC2345', 100);

        expect(timeouts).toEqual([120_000]);
    });

    test('the storage GET following a redirect retries after a transient error, since it is idempotent', async () => {
        let attempts = 0;
        const { client } = setup((s) => {
            s.override = (call) => {
                if(call.url === `${STORAGE}/f`) {
                    attempts++;
                    return attempts === 1 ? status(500, 'boom') : new Response('hi', { status: 200 });
                }
                return pathOf(call) === '/items/ATTC2345/file' ? status(302, '', { Location: `${STORAGE}/f` }) : undefined;
            };
        });

        const result = await client.downloadAttachmentFile('ATTC2345', 100);

        expect(new TextDecoder().decode(result.bytes)).toBe('hi');
        expect(attempts).toBe(2);
    });

    test('a plain library GET retries after a transient error, since reads are idempotent', async () => {
        let attempts = 0;
        const { client } = setup((s) => {
            s.override = (call) => {
                if(call.method !== 'GET' || pathOf(call) !== '/items/top') {
                    return undefined;
                }
                attempts++;
                return attempts === 1 ? status(500, 'boom') : undefined;
            };
        });

        const result = await client.searchItems({ limit: 25, start: 0, sort: 'title', direction: 'asc' });

        expect(result.totalResults).toBe(0);
        expect(attempts).toBe(2);
    });
});

describe('a non-https upload URL is refused by substring, not by prefix', () => {
    test('a URL that merely contains https:// without starting with it is refused before it is used', async () => {
        const { server, client } = uploadServer({ authorize: json({ url: 'http://evil.test/a?x=https://y', contentType: 'x', prefix: '', suffix: '', uploadKey: 'K' }) });

        const error = await caught(client.uploadAttachmentFile('ATTC2345', file)) as ZoteroFileError;

        expect(error).toBeInstanceOf(ZoteroFileError);
        expect(error.message).toBe('Zotero returned a non-https upload URL for ATTC2345; refusing to upload');
        expect(server.calls).toHaveLength(1);
    });
});

describe('response bodies are drained (awaited) before being discarded', () => {
    test('the storage response body is drained before its status is checked', async () => {
        const { client } = setup((s) => {
            s.override = (call) => {
                if(call.url === `${STORAGE}/upload`) {
                    return new Response(rejectingBody('cancel boom'), { status: 201 });
                }
                if(pathOf(call) === '/items/ATTC2345/file') {
                    return call.bodyText?.startsWith('upload=')
                        ? status(204)
                        : json({ url: `${STORAGE}/upload`, contentType: 'application/pdf', prefix: '', suffix: '', uploadKey: 'UPKEY' });
                }
                return undefined;
            };
        });

        await expect(client.uploadAttachmentFile('ATTC2345', file)).rejects.toThrow('cancel boom');
    });

    test('the redirect response body is drained before the redirect is followed', async () => {
        const { client } = setup((s) => {
            s.override = (call) => {
                if(call.url === `${STORAGE}/f`) {
                    return new Response('ok', { status: 200 });
                }
                return pathOf(call) === '/items/ATTC2345/file' ? new Response(rejectingBody('cancel boom'), { status: 302, headers: { Location: `${STORAGE}/f` } }) : undefined;
            };
        });

        await expect(client.downloadAttachmentFile('ATTC2345', 10)).rejects.toThrow('cancel boom');
    });

    test('a non-200 response is drained before it is discarded', async () => {
        const { client } = setup((s) => {
            s.override = call => (pathOf(call) === '/items/ATTC2345/file' ? new Response(rejectingBody('cancel boom'), { status: 206 }) : undefined);
        });

        await expect(client.downloadAttachmentFile('ATTC2345', 10)).rejects.toThrow('cancel boom');
    });

    test('the body is drained before refusing an over-cap declared Content-Length', async () => {
        const { client } = downloadServer(new Response(rejectingBody('cancel boom'), { status: 200, headers: { 'Content-Length': '999' } }));

        await expect(client.downloadAttachmentFile('ATTC2345', 10)).rejects.toThrow('cancel boom');
    });

    test('the stream reader is awaited when cancelling an over-cap download', async () => {
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.enqueue(new TextEncoder().encode('123456'));
            },
            cancel() {
                return Promise.reject(new Error('reader cancel boom'));
            },
        });
        const { client } = downloadServer(new Response(body, { status: 200 }));

        await expect(client.downloadAttachmentFile('ATTC2345', 10)).rejects.toThrow('reader cancel boom');
    });
});

describe('a declared Content-Length over the cap is trusted, not re-derived from a short body', () => {
    test('is refused even though the actual body sent is smaller than declared', async () => {
        const { client } = downloadServer(new Response('hi', { status: 200, headers: { 'Content-Length': '999' } }));

        const error = await caught(client.downloadAttachmentFile('ATTC2345', 10)) as ZoteroFileError;

        expect(error.reason).toBe('too_large');
        expect(error.context).toEqual({ reason: 'too_large', limit: 10, key: 'ATTC2345' });
    });
});

describe('error messages the existing suite checks only by instance/reason', () => {
    test('a non-https redirect location names the attachment in its error message', async () => {
        const { client } = downloadServer(status(302, '', { Location: 'http://storage.test/f' }));

        const error = await caught(client.downloadAttachmentFile('ATTC2345', 10)) as ZoteroFileError;

        expect(error.message).toBe('Zotero redirected the download of ATTC2345 to a non-https location');
    });

    test('a Content-Type with a charset parameter is split, trimmed, and lowercased', async () => {
        const { client } = downloadServer(new Response('x', { status: 200, headers: { 'Content-Type': 'TEXT/HTML ; charset=utf-8' } }));

        const result = await client.downloadAttachmentFile('ATTC2345', 10);

        expect(result.contentType).toBe('text/html');
    });
});

describe('error context the existing suite checks only by message', () => {
    test('an incomplete keyed read reports the path in its context', async () => {
        const { client } = setup((s) => {
            addItems(s, 3);
            s.override = () => json([], { headers: { 'Total-Results': '3' } });
        });

        const error = await caught(client.getItems([fakeKey(0), fakeKey(1), fakeKey(2)])) as ZoteroError;

        expect(error.context).toEqual({ path: '/items' });
    });

    test('an incomplete paged read reports the path in its context', async () => {
        const parentKey = fakeKey(999);
        const { client } = setup((s) => {
            s.override = call => (params(call).get('start') === '0'
                ? json(Array.from({ length: 100 }, (_, i) => ({ key: fakeKey(i), version: 1, data: { key: 'X', version: 1, itemType: 'note' } })), { headers: { 'Total-Results': '150' } })
                : json([], { headers: { 'Total-Results': '150' } }));
        });

        const error = await caught(client.getChildren([parentKey])) as ZoteroError;

        expect(error.context).toEqual({ path: `/items/${parentKey}/children` });
    });

    test('a missing library version reports the path in its context', async () => {
        const { client } = setup((s) => {
            s.override = () => json([], { headers: { 'Total-Results': '0' } });
        });

        const error = await caught(client.scanTopItems()) as ZoteroError;

        expect(error.context).toEqual({ path: '/items/top' });
    });
});

describe('array ordering: append, never prepend', () => {
    test('paged reads keep pages in request order (page 0 before page 1)', async () => {
        const parentKey = fakeKey(999);
        const { client } = setup((s) => {
            s.addItem({ key: parentKey, itemType: 'attachment' });
            for(let i = 0; i < 150; i++) {
                s.addItem({ key: fakeKey(i), itemType: 'annotation', parentItem: parentKey, title: `T${i}` });
            }
        });

        const children = await client.getChildren([parentKey]);
        const titles = children.get(parentKey)!.map(item => item.data.title);

        expect(titles[0]).toBe('T0');
        expect(titles.at(-1)).toBe('T149');
    });

    test('unchanged creates across write chunks keep append order (not reversed)', async () => {
        let writes = 0;
        const { client } = setup((s) => {
            s.override = (call) => {
                if(call.method !== 'POST') {
                    return undefined;
                }
                writes++;
                return writes === 1
                    ? json({ successful: {}, unchanged: { '0': 'FIRST000' } })
                    : json({ successful: {}, unchanged: { '0': 'SECOND00' } });
            };
        });

        const result = await client.createItems(Array.from({ length: 53 }, () => ({ itemType: 'book' })));

        expect(result.unchanged.map(u => u.key)).toEqual(['FIRST000', 'SECOND00']);
    });

    test('a create failure without a key strictly omits the key field (not key: undefined)', async () => {
        const { client } = setup((s) => {
            s.override = call => (call.method === 'POST' ? json({ failed: { '0': { code: 413, message: 'too big' } } }) : undefined);
        });

        const result = await client.createItems([{ itemType: 'book' }]);

        expect(result.failed[0]).toStrictEqual({ index: 0, code: 413, message: 'too big' });
        expect(Object.hasOwn(result.failed[0], 'key')).toBe(false);
    });

    test('a whole-chunk write conflict is re-read in the order the chunks were attempted', async () => {
        const keys = Array.from({ length: 51 }, (_, i) => fakeKey(i));
        const { server, client } = setup((s) => {
            for(const key of keys) {
                s.addItem({ key, version: 1, title: 'orig' });
            }
            s.override = call => (call.method === 'POST' ? status(412, 'Library has been modified', { 'Last-Modified-Version': '20' }) : undefined);
        }, 1);

        await client.modifyItems(keys.map(key => ({ key, apply: data => ({ ...data, title: 'new' }) })));

        const gets = server.calls.filter(call => call.method === 'GET');
        expect(gets).toHaveLength(4);
        // The conflict re-read must cover the first write chunk's 50 keys (in their original order)
        // before the second chunk's single key.
        expect(params(gets[2]).get('itemKey')?.split(',')[0]).toBe(keys[0]);
        expect(params(gets[3]).get('itemKey')).toBe(keys[50]);
    });

    test('per-object write conflicts within one chunk are re-read in write order', async () => {
        const { server, client } = setup((s) => {
            s.addItem({ key: 'AAAA2345', version: 1 });
            s.addItem({ key: 'BBBB2345', version: 1 });
            s.addItem({ key: 'CCCC2345', version: 1 });
            s.override = call => (call.method === 'POST'
                ? json({
                    successful: { '1': { key: 'BBBB2345', version: 2, data: { key: 'BBBB2345', version: 2, itemType: 'book' } } },
                    failed:     {
                        '0': { key: 'AAAA2345', code: 412, message: 'modified' },
                        '2': { key: 'CCCC2345', code: 412, message: 'modified' },
                    },
                })
                : undefined);
        });

        await client.modifyItems([
            { key: 'AAAA2345', apply: data => ({ ...data, title: 'x' }) },
            { key: 'BBBB2345', apply: data => ({ ...data, title: 'x' }) },
            { key: 'CCCC2345', apply: data => ({ ...data, title: 'x' }) },
        ]);

        const gets = server.calls.filter(call => call.method === 'GET');
        expect(gets).toHaveLength(2);
        expect(params(gets[1]).get('itemKey')).toBe('AAAA2345,CCCC2345');
    });
});
