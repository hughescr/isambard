import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
    API,
    LIBRARY,
    TEST_API_KEY,
    deferred,
    fakeClock,
    json,
    recordingFetch,
    status,
    type FakeClock,
    type FakeHandler
} from '../../../helpers/zotero-fake';
import {
    InvariantViolationError,
    ZoteroAuthError,
    ZoteroError,
    ZoteroNotFoundError,
    ZoteroQuotaError,
    ZoteroRateLimitError,
    ZoteroServerError,
    ZoteroVersionConflictError
} from '@/errors';
import { ZoteroRequester, type ZoteroMethod, type ZoteroTarget } from '@/integrations/zotero/request';

const ITEMS: ZoteroTarget = { scope: 'library', path: '/items' };

function setup(handler: FakeHandler, options: { clock?: FakeClock, maxWaitMs?: number } = {}) {
    const clock = options.clock ?? fakeClock();
    const { fetch, calls } = recordingFetch(handler, clock);
    const signals: number[] = [];
    const requester = new ZoteroRequester({
        apiKey:        TEST_API_KEY,
        groupId:       6_692_257,
        fetch,
        sleep:         clock.sleep,
        now:           clock.now,
        timeoutSignal: (ms) => {
            signals.push(ms);
            return new AbortController().signal;
        },
        ...options.maxWaitMs === undefined ? {} : { maxWaitMs: options.maxWaitMs },
    });
    return { requester, calls, clock, signals };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    throw new Error('expected a rejection');
}

/** Asserts the API key appears nowhere in a thrown error's message or context. */
function expectNoKey(error: unknown): void {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(TEST_API_KEY);
    expect(JSON.stringify((error as ZoteroError).context ?? {})).not.toContain(TEST_API_KEY);
}

describe('ZoteroRequester construction and URLs', () => {
    test('sends the key, API version and user agent to a URL under the group', async () => {
        const { requester, calls } = setup(() => json([]));

        await requester.request('GET', { scope: 'library', path: '/items/top' }, { idempotent: true, query: { limit: 25, tag: ['a', 'b'], q: 'deep learning' } });

        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe(`${LIBRARY}/items/top?limit=25&tag=a&tag=b&q=deep+learning`);
        expect(calls[0].method).toBe('GET');
        expect(calls[0].headers.get('Zotero-API-Key')).toBe(TEST_API_KEY);
        expect(calls[0].headers.get('Zotero-API-Version')).toBe('3');
        expect(calls[0].headers.get('User-Agent')).toBe('Isambard (+https://github.com/hughescr/isambard)');
        expect(calls[0].init.redirect).toBe('follow');
    });

    test('the only global endpoint is the item template', async () => {
        const { requester, calls } = setup(() => json({ itemType: 'book' }));

        await requester.request('GET', { scope: 'schema', path: '/items/new' }, { idempotent: true, query: { itemType: 'book' } });

        expect(calls[0].url).toBe(`${API}/items/new?itemType=book`);
    });

    test('a custom base URL is used as given', async () => {
        const clock = fakeClock();
        const { fetch, calls } = recordingFetch(() => json([]), clock);
        const requester = new ZoteroRequester({ apiKey: TEST_API_KEY, groupId: 5, baseUrl: 'https://zotero.test', fetch, sleep: clock.sleep, now: clock.now });

        await requester.request('GET', ITEMS, { idempotent: true });

        expect(calls[0].url).toBe('https://zotero.test/groups/5/items');
        expect(requester.groupId).toBe(5);
    });

    test.each([0, -1, 1.5, Number.NaN])('rejects group id %p', (groupId) => {
        expect(() => new ZoteroRequester({ apiKey: TEST_API_KEY, groupId })).toThrow(InvariantViolationError);
    });

    test.each([
        ['no leading slash', 'items'],
        ['a parent segment', '/items/../../users/1/items'],
        ['an embedded URL', '/items?x=https://evil.test/'],
    ])('rejects a library path with %s, sending nothing', async (_label, path) => {
        const { requester, calls } = setup(() => json([]));

        expect(await caught(requester.request('GET', { scope: 'library', path }, { idempotent: true }))).toBeInstanceOf(InvariantViolationError);
        expect(calls).toHaveLength(0);
    });

    test('rejects any schema path but /items/new, and an unknown scope', async () => {
        const { requester, calls } = setup(() => json([]));

        expect(await caught(requester.request('GET', { scope: 'schema', path: '/itemTypes' } as unknown as ZoteroTarget, { idempotent: true }))).toBeInstanceOf(InvariantViolationError);
        expect(await caught(requester.request('GET', { scope: 'users', path: '/items' } as unknown as ZoteroTarget, { idempotent: true }))).toBeInstanceOf(InvariantViolationError);
        expect(calls).toHaveLength(0);
    });

    test.each(['DELETE', 'PUT', 'delete'])('has no %s verb, even through a cast', async (method) => {
        const { requester, calls } = setup(() => json([]));

        const error = await caught(requester.request(method as ZoteroMethod, ITEMS, { idempotent: false }));

        expect(error).toBeInstanceOf(InvariantViolationError);
        expect(calls).toHaveLength(0);
    });

    test('sends a PATCH', async () => {
        const { requester, calls } = setup(() => status(204));

        await requester.request('PATCH', { scope: 'library', path: '/items/ABCD2345' }, { idempotent: false, json: { title: 'x' } });

        expect(calls.map(call => call.method)).toEqual(['PATCH']);
    });
});

describe('ZoteroRequester bodies and responses', () => {
    test('sends a JSON body with its content type', async () => {
        const { requester, calls } = setup(() => json({ successful: {} }));

        await requester.request('POST', ITEMS, { idempotent: false, json: [{ itemType: 'book' }], headers: { 'Zotero-Write-Token': 'abc' } });

        expect(calls[0].method).toBe('POST');
        expect(calls[0].bodyText).toBe('[{"itemType":"book"}]');
        expect(calls[0].headers.get('Content-Type')).toBe('application/json');
        expect(calls[0].headers.get('Zotero-Write-Token')).toBe('abc');
    });

    test('sends a form body with its content type', async () => {
        const { requester, calls } = setup(() => json({ exists: 1 }));

        await requester.request('POST', { scope: 'library', path: '/items/ABCD2345/file' }, { idempotent: false, form: { md5: 'x y', filename: 'a&b.pdf' } });

        expect(calls[0].bodyText).toBe('md5=x+y&filename=a%26b.pdf');
        expect(calls[0].headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
    });

    test('parses the body with the schema, plus the library version and total results', async () => {
        const { requester } = setup(() => json([{ a: 1 }], { headers: { 'Last-Modified-Version': '17', 'Total-Results': '240' } }));

        const response = await requester.request('GET', ITEMS, { idempotent: true, schema: z.array(z.object({ a: z.number() })) });

        expect(response.status).toBe(200);
        expect(response.body).toEqual([{ a: 1 }]);
        expect(response.libraryVersion).toBe(17);
        expect(response.totalResults).toBe(240);
        expect(response.headers.get('Total-Results')).toBe('240');
    });

    test('non-numeric or missing version headers are undefined; an empty or 204 body is undefined', async () => {
        const responses = [status(204, '', { 'Last-Modified-Version': 'abc' }), status(200, ''), json({ x: 1 }, { headers: { 'Total-Results': '12a' } })];
        const { requester } = setup(() => responses.shift()!);

        const noContent = await requester.request('POST', ITEMS, { idempotent: false });
        expect(noContent.body).toBeUndefined();
        expect(noContent.libraryVersion).toBeUndefined();
        expect(noContent.totalResults).toBeUndefined();
        const empty = await requester.request('GET', ITEMS, { idempotent: true });
        expect(empty.body).toBeUndefined();
        const unparsed = await requester.request('GET', ITEMS, { idempotent: true });
        expect(unparsed.body).toEqual({ x: 1 });
        expect(unparsed.totalResults).toBeUndefined();
    });

    test('an empty body where a schema expects one is a shape error', async () => {
        const { requester } = setup(() => status(200, ''));

        const error = await caught(requester.request('POST', ITEMS, { idempotent: false, schema: z.object({ a: z.number() }) }));

        expect((error as ZoteroError).message).toBe('unexpected Zotero response shape from /items');
    });

    test('an unexpected shape or a non-JSON body is a ZoteroError naming the path', async () => {
        const responses = [json({ a: 'x' }), status(200, '<html>')];
        const { requester } = setup(() => responses.shift()!);

        const shape = await caught(requester.request('GET', ITEMS, { idempotent: true, schema: z.object({ a: z.number() }) }));
        expect(shape).toBeInstanceOf(ZoteroError);
        expect((shape as ZoteroError).message).toBe('unexpected Zotero response shape from /items');
        expect((shape as ZoteroError).context).toEqual({ path: '/items' });

        const notJson = await caught(requester.request('GET', ITEMS, { idempotent: true }));
        expect((notJson as ZoteroError).message).toBe('unexpected Zotero response shape from /items (not JSON)');
    });

    test('uses the request timeout, or the file timeout for file transfers', async () => {
        const { requester, signals } = setup(() => json([]));

        await requester.request('GET', ITEMS, { idempotent: true });
        await requester.request('GET', ITEMS, { idempotent: true, file: true });

        expect(signals).toEqual([30_000, 120_000]);
    });

    test('custom timeouts are honoured', async () => {
        const clock = fakeClock();
        const { fetch } = recordingFetch(() => json([]), clock);
        const signals: number[] = [];
        const requester = new ZoteroRequester({
            apiKey:           TEST_API_KEY,
            groupId:          1,
            fetch,
            sleep:            clock.sleep,
            now:              clock.now,
            requestTimeoutMs: 5,
            fileTimeoutMs:    6,
            timeoutSignal:    (ms) => {
                signals.push(ms);
                return new AbortController().signal;
            },
        });

        await requester.request('GET', ITEMS, { idempotent: true });
        await requester.request('GET', ITEMS, { idempotent: true, file: true });

        expect(signals).toEqual([5, 6]);
    });

    test('without an injected clock the shared deadline runs on wall-clock time', async () => {
        const { fetch, calls } = recordingFetch(() => json([], { headers: { Backoff: '90' } }));
        const requester = new ZoteroRequester({ apiKey: TEST_API_KEY, groupId: 1, fetch });

        await requester.request('GET', ITEMS, { idempotent: true });
        const error = await caught(requester.request('GET', ITEMS, { idempotent: true })) as ZoteroRateLimitError;

        expect(error.overBudget).toBe(true);
        expect(error.retryAfterMs).toBeGreaterThan(89_000);
        expect(error.retryAfterMs).toBeLessThanOrEqual(90_000);
        expect(calls).toHaveLength(1);
    });

    test('without a timeout seam the fetch still gets an abort signal', async () => {
        const clock = fakeClock();
        const { fetch, calls } = recordingFetch(() => json([]), clock);
        const requester = new ZoteroRequester({ apiKey: TEST_API_KEY, groupId: 1, fetch, sleep: clock.sleep, now: clock.now });

        await requester.request('GET', ITEMS, { idempotent: true });

        expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    });
});

describe('ZoteroRequester error mapping', () => {
    test.each([
        [400, ZoteroError, 'ZoteroError'],
        [428, ZoteroError, 'ZoteroError'],
        [401, ZoteroAuthError, 'ZoteroAuthError'],
        [403, ZoteroAuthError, 'ZoteroAuthError'],
        [404, ZoteroNotFoundError, 'ZoteroNotFoundError'],
        [412, ZoteroVersionConflictError, 'ZoteroVersionConflictError'],
        [413, ZoteroQuotaError, 'ZoteroQuotaError'],
        [409, ZoteroServerError, 'ZoteroServerError'],
        [500, ZoteroServerError, 'ZoteroServerError'],
    ] as const)('HTTP %d maps to %p', async (code, ErrorClass, name) => {
        const { requester, calls } = setup(() => status(code, 'server says no', { 'Last-Modified-Version': '9' }));

        const error = await caught(requester.request('POST', ITEMS, { idempotent: false }));

        expect(error).toBeInstanceOf(ErrorClass);
        expect((error as Error).name).toBe(name);
        expect(calls).toHaveLength(1);
        expectNoKey(error);
    });

    test('messages and contexts carry status, path and body text', async () => {
        const responses = [
            status(400, 'bad field'),
            status(403, 'Forbidden'),
            status(404, 'Not found'),
            status(412, 'Item has been modified', { 'Last-Modified-Version': '15' }),
            status(412, 'no header'),
            status(413, 'quota'),
            status(500, 'boom'),
        ];
        const { requester } = setup(() => responses.shift()!);
        const post = () => caught(requester.request('POST', ITEMS, { idempotent: false }));

        const bad = await post() as ZoteroError;
        expect(bad.message).toBe('Zotero rejected the request to /items (HTTP 400): bad field');
        expect(bad.context).toEqual({ status: 400, path: '/items' });

        const auth = await post() as ZoteroAuthError;
        expect(auth.message).toBe('Zotero refused access to /items (HTTP 403): the API key is invalid or cannot reach group 6692257. Forbidden');
        expect(auth.context).toEqual({ status: 403, path: '/items' });

        const missing = await post() as ZoteroNotFoundError;
        expect(missing.message).toBe('Zotero has no such object: /items');
        expect(missing.context).toEqual({ path: '/items' });

        const conflict = await post() as ZoteroVersionConflictError;
        expect(conflict.message).toBe('Zotero rejected a version precondition on /items (HTTP 412): Item has been modified');
        expect(conflict.context).toEqual({ currentVersion: 15, path: '/items' });
        expect((await post() as ZoteroVersionConflictError).context).toEqual({ path: '/items' });

        const quota = await post() as ZoteroQuotaError;
        expect(quota.message).toBe('Zotero storage is full or the file exceeds the plan limit; Craig owns the storage plan (HTTP 413)');
        expect(quota.context).toEqual({ status: 413, path: '/items' });

        const server = await post() as ZoteroServerError;
        expect(server.message).toBe('Zotero server error on /items (HTTP 500): boom; the write may or may not have been applied, so re-read before retrying');
        expect(server.context).toEqual({ status: 500, idempotent: false, path: '/items' });
    });

    test('the body in an error message is capped at 500 characters', async () => {
        const { requester } = setup(() => status(400, 'x'.repeat(2000)));

        const error = await caught(requester.request('GET', ITEMS, { idempotent: true })) as ZoteroError;

        expect(error.message).toBe(`Zotero rejected the request to /items (HTTP 400): ${'x'.repeat(500)}`);
    });

    test('an unreadable error body leaves the message without body text', async () => {
        const broken = new Response(new ReadableStream({
            start(controller) {
                controller.error(new Error('stream broke'));
            },
        }), { status: 400 });
        const { requester } = setup(() => broken);

        const error = await caught(requester.request('GET', ITEMS, { idempotent: true })) as ZoteroError;

        expect(error.message).toBe('Zotero rejected the request to /items (HTTP 400): ');
    });

    test('5xx is retried for an idempotent GET, up to three attempts', async () => {
        const { requester, calls, clock } = setup(() => status(502, 'bad gateway'));

        const error = await caught(requester.request('GET', ITEMS, { idempotent: true })) as ZoteroServerError;

        expect(error).toBeInstanceOf(ZoteroServerError);
        expect(error.message).toBe('Zotero server error on /items (HTTP 502): bad gateway');
        expect(error.idempotent).toBe(true);
        expect(calls).toHaveLength(3);
        expect(clock.sleeps).toHaveLength(2);
        expect(clock.sleeps[0]).toBeGreaterThanOrEqual(900);
        expect(clock.sleeps[0]).toBeLessThanOrEqual(1100);
        expect(clock.sleeps[1]).toBeGreaterThanOrEqual(1800);
        expect(clock.sleeps[1]).toBeLessThanOrEqual(2200);
    });

    test('a GET that recovers after a 5xx returns the good response', async () => {
        const responses = [status(500), json([1])];
        const { requester, calls } = setup(() => responses.shift()!);

        const response = await requester.request('GET', ITEMS, { idempotent: true });

        expect(response.body).toEqual([1]);
        expect(calls).toHaveLength(2);
    });

    test('a network failure is a ZoteroServerError, retried only when idempotent', async () => {
        const { requester, calls } = setup(() => {
            throw new TypeError('fetch failed: ECONNRESET');
        });

        const get = await caught(requester.request('GET', ITEMS, { idempotent: true })) as ZoteroServerError;
        expect(get).toBeInstanceOf(ZoteroServerError);
        expect(get.message).toBe('Zotero request to /items failed: fetch failed: ECONNRESET');
        expect(get.context).toEqual({ idempotent: true, path: '/items' });
        expect(calls).toHaveLength(3);

        const post = await caught(requester.request('POST', ITEMS, { idempotent: false })) as ZoteroServerError;
        expect(post.message).toBe('Zotero request to /items failed: fetch failed: ECONNRESET; the write may or may not have been applied, so re-read before retrying');
        expect(calls).toHaveLength(4);
        expectNoKey(post);
    });

    test('a non-Error rejection is described as a string', async () => {
        const { requester } = setup(() => {
            throw 'socket closed';
        });

        const error = await caught(requester.request('POST', ITEMS, { idempotent: false })) as ZoteroServerError;

        expect(error.message).toContain('failed: socket closed;');
    });

    test('a timeout is a ZoteroServerError flagged as a timeout', async () => {
        const { requester } = setup(() => {
            throw new DOMException('The operation timed out.', 'TimeoutError');
        });

        const error = await caught(requester.request('POST', ITEMS, { idempotent: false })) as ZoteroServerError;

        expect(error).toBeInstanceOf(ZoteroServerError);
        expect(error.message).toBe('Zotero request to /items timed out after 30000 ms; the write may or may not have been applied, so re-read before retrying');
        expect(error.context).toEqual({ timeout: true, idempotent: false, path: '/items' });
    });

    test('a file transfer timeout reports the file timeout', async () => {
        const { requester } = setup(() => {
            throw new DOMException('The operation timed out.', 'TimeoutError');
        });

        const error = await caught(requester.request('GET', ITEMS, { idempotent: true, file: true })) as ZoteroServerError;

        expect(error.message).toBe('Zotero request to /items timed out after 120000 ms');
    });
});

describe('ZoteroRequester rate limits and the shared deadline', () => {
    test.each(['GET', 'POST'] as const)('a 429 on %s honours Retry-After and retries', async (method) => {
        const responses = [status(429, '', { 'Retry-After': '10' }), json({ ok: true })];
        const { requester, calls, clock } = setup(() => responses.shift()!);

        const response = await requester.request(method, ITEMS, { idempotent: method === 'GET' });

        expect(response.body).toEqual({ ok: true });
        expect(calls).toHaveLength(2);
        expect(calls[1].at).toBeGreaterThanOrEqual(10_000);
        for(const ms of clock.sleeps) {
            expect(ms).toBeLessThanOrEqual(60_000);
        }
    });

    test('a 503 is a rate limit too, and a missing Retry-After waits one second', async () => {
        const responses = [status(503), json({ ok: true })];
        const { requester, calls } = setup(() => responses.shift()!);

        await requester.request('POST', ITEMS, { idempotent: false });

        expect(calls).toHaveLength(2);
        expect(calls[1].at).toBeGreaterThanOrEqual(900);
    });

    test('a persistent 503 without Retry-After reports the one-second default', async () => {
        const { requester, calls } = setup(() => status(503));

        const error = await caught(requester.request('GET', ITEMS, { idempotent: true })) as ZoteroRateLimitError;

        expect(error.context).toEqual({ retryAfterMs: 1000, overBudget: false });
        expect(error.message).toBe('Zotero rate-limited /items (HTTP 503); retry after ~1s');
        expect(calls).toHaveLength(3);
    });

    test('a Backoff exactly at the budget still waits', async () => {
        const responses = [json([], { headers: { Backoff: '60' } }), json([])];
        const { requester, calls, clock } = setup(() => responses.shift()!);

        await requester.request('GET', ITEMS, { idempotent: true });
        await requester.request('GET', ITEMS, { idempotent: true });

        expect(clock.sleeps).toEqual([60_000]);
        expect(calls).toHaveLength(2);
    });

    test('rate limits that never clear give up after three attempts with a typed error', async () => {
        const { requester, calls } = setup(() => status(429, '', { 'Retry-After': '2' }));

        const error = await caught(requester.request('GET', ITEMS, { idempotent: true })) as ZoteroRateLimitError;

        expect(error).toBeInstanceOf(ZoteroRateLimitError);
        expect(error.message).toBe('Zotero rate-limited /items (HTTP 429); retry after ~2s');
        expect(error.context).toEqual({ retryAfterMs: 2000, overBudget: false });
        expect(calls).toHaveLength(3);
    });

    test('a Retry-After beyond the wait budget fails fast after one fetch, and so do later calls', async () => {
        const { requester, calls, clock } = setup(() => status(429, '', { 'Retry-After': '120' }));

        const error = await caught(requester.request('GET', ITEMS, { idempotent: true })) as ZoteroRateLimitError;

        expect(error.overBudget).toBe(true);
        expect(error.retryAfterMs).toBe(120_000);
        expect(calls).toHaveLength(1);
        expect(clock.sleeps).toEqual([]);

        clock.advance(1500);
        const again = await caught(requester.request('GET', ITEMS, { idempotent: true })) as ZoteroRateLimitError;
        expect(again).toBeInstanceOf(ZoteroRateLimitError);
        expect(again.overBudget).toBe(true);
        expect(again.retryAfterMs).toBe(118_500);
        expect(again.message).toBe('Zotero asked us to wait ~119s before the next request to /items; try again later');
        expect(calls).toHaveLength(1);
    });

    test('a Retry-After exactly at the budget still waits', async () => {
        const responses = [status(429, '', { 'Retry-After': '5' }), json({})];
        const { requester, calls } = setup(() => responses.shift()!, { maxWaitMs: 5000 });

        await requester.request('GET', ITEMS, { idempotent: true });

        expect(calls).toHaveLength(2);
    });

    test('Backoff on a success delays the next request', async () => {
        const responses = [json([], { headers: { Backoff: '5' } }), json([])];
        const { requester, calls, clock } = setup(() => responses.shift()!);

        await requester.request('GET', ITEMS, { idempotent: true });
        await requester.request('GET', ITEMS, { idempotent: true });

        expect(clock.sleeps).toEqual([5000]);
        expect(calls[1].at).toBe(5000);
    });

    test('Backoff on an error response is honoured too', async () => {
        const responses = [status(404, '', { Backoff: '3' }), json([])];
        const { requester, calls } = setup(() => responses.shift()!);

        await caught(requester.request('GET', ITEMS, { idempotent: true }));
        await requester.request('GET', ITEMS, { idempotent: true });

        expect(calls[1].at).toBe(3000);
    });

    test('a Backoff beyond the budget makes the next call fail fast without sending', async () => {
        const responses = [json([], { headers: { Backoff: '90' } })];
        const { requester, calls } = setup(() => responses.shift()!);

        await requester.request('GET', ITEMS, { idempotent: true });
        const error = await caught(requester.request('POST', ITEMS, { idempotent: false })) as ZoteroRateLimitError;

        expect(error.overBudget).toBe(true);
        expect(calls).toHaveLength(1);
    });

    test('a shorter Backoff or Retry-After arriving later never shortens the deadline', async () => {
        const slowBackoff = deferred<Response>();
        const slow429 = deferred<Response>();
        let slow429Calls = 0;
        const { requester, calls } = setup((call) => {
            if(call.url.endsWith('/slow-backoff')) {
                return slowBackoff.promise;
            }
            if(call.url.endsWith('/slow-429')) {
                slow429Calls++;
                return slow429Calls === 1 ? slow429.promise : json([]);
            }
            return json([], { headers: { Backoff: '30' } });
        });

        const backoffInFlight = requester.request('GET', { scope: 'library', path: '/slow-backoff' }, { idempotent: true });
        const limitedInFlight = requester.request('POST', { scope: 'library', path: '/slow-429' }, { idempotent: false });
        await requester.request('GET', ITEMS, { idempotent: true });
        slowBackoff.resolve(json([], { headers: { Backoff: '2' } }));
        await backoffInFlight;
        slow429.resolve(status(429, '', { 'Retry-After': '1' }));
        await limitedInFlight;

        const retried = calls.filter(call => call.url.endsWith('/slow-429'));
        expect(retried).toHaveLength(2);
        expect(retried[1].at).toBe(30_000);
    });

    test('non-numeric Backoff and Retry-After headers are ignored or defaulted', async () => {
        const responses = [json([], { headers: { Backoff: 'soon' } }), status(429, '', { 'Retry-After': 'Wed, 21 Oct 2015 07:28:00 GMT' }), json([])];
        const { requester, calls } = setup(() => responses.shift()!);

        await requester.request('GET', ITEMS, { idempotent: true });
        expect(calls).toHaveLength(1);
        await requester.request('GET', ITEMS, { idempotent: true });

        expect(calls[1].at).toBe(0);
        expect(calls[2].at).toBeGreaterThanOrEqual(1000);
    });

    test('a concurrent request issued during a 429 wait sleeps until the shared deadline', async () => {
        let startB: (() => void) | undefined;
        const clock = fakeClock(() => {
            const start = startB;
            startB = undefined;
            start?.();
        });
        const responses = [status(429, '', { 'Retry-After': '10' }), json(['a']), json(['b'])];
        const { requester, calls } = setup(() => responses.shift()!, { clock });
        let requestB: Promise<unknown> | undefined;
        startB = () => {
            requestB = requester.request('GET', { scope: 'library', path: '/collections' }, { idempotent: true });
        };

        await requester.request('GET', ITEMS, { idempotent: true });
        await requestB;

        const bCall = calls.find(call => call.url.endsWith('/collections'));
        expect(bCall?.at).toBeGreaterThanOrEqual(10_000);
        expect(calls).toHaveLength(3);
    });

    test('the gate re-checks after sleeping when the deadline moved during the sleep', async () => {
        const slow = deferred<Response>();
        let onFirstSleep: (() => Promise<void>) | undefined;
        const clock = fakeClock(async () => {
            const hook = onFirstSleep;
            onFirstSleep = undefined;
            await hook?.();
        });
        const { requester, calls } = setup((call) => {
            if(call.url.endsWith('/slow')) {
                return slow.promise;
            }
            return calls.length === 2 ? json([], { headers: { Backoff: '5' } }) : json([]);
        }, { clock });

        const inFlight = requester.request('GET', { scope: 'library', path: '/slow' }, { idempotent: true });
        await requester.request('GET', ITEMS, { idempotent: true });
        onFirstSleep = async () => {
            slow.resolve(json([], { headers: { Backoff: '20' } }));
            await inFlight;
        };
        await requester.request('GET', ITEMS, { idempotent: true });

        expect(clock.sleeps).toHaveLength(2);
        expect(clock.sleeps[0]).toBe(5000);
        expect(clock.sleeps[1]).toBe(20_000);
        expect(calls.at(-1)!.at).toBe(25_000);
    });
});

describe('ZoteroRequester raw and external requests', () => {
    test('requestRaw returns the response unparsed, passing the redirect mode', async () => {
        const { requester, calls } = setup(() => status(302, '', { Location: 'https://storage.test/f' }));

        const response = await requester.requestRaw('GET', { scope: 'library', path: '/items/ABCD2345/file' }, { idempotent: true, file: true, redirect: 'manual' });

        expect(response.status).toBe(302);
        expect(calls[0].init.redirect).toBe('manual');
        expect(calls[0].headers.get('Zotero-API-Key')).toBe(TEST_API_KEY);
    });

    test('requestRaw still maps error statuses', async () => {
        const { requester } = setup(() => status(404));

        expect(await caught(requester.requestRaw('GET', { scope: 'library', path: '/items/ABCD2345/file' }, { idempotent: true }))).toBeInstanceOf(ZoteroNotFoundError);
    });

    test('external requests carry no Zotero headers and follow redirects', async () => {
        const { requester, calls, signals } = setup(() => status(201));

        const body = new Uint8Array([1, 2, 3]);
        const response = await requester.external('POST', 'https://storage.test/upload', { idempotent: true, headers: { 'Content-Type': 'application/pdf' }, body });

        expect(response.status).toBe(201);
        expect(calls[0].url).toBe('https://storage.test/upload');
        expect(calls[0].headers.get('Zotero-API-Key')).toBeNull();
        expect(calls[0].headers.get('Zotero-API-Version')).toBeNull();
        expect(calls[0].headers.get('Content-Type')).toBe('application/pdf');
        expect(calls[0].bodyBytes).toEqual(body);
        expect(calls[0].init.redirect).toBe('follow');
        expect(signals).toEqual([120_000]);
    });

    test('external requests return client errors to the caller unmapped', async () => {
        const { requester } = setup(() => status(400, 'bad policy'));

        const response = await requester.external('POST', 'https://storage.test/upload', { idempotent: true });

        expect(response.status).toBe(400);
    });

    test('external 5xx is retried when idempotent and 429 is a rate limit', async () => {
        const responses = [status(500), status(429, '', { 'Retry-After': '1' }), status(201)];
        const { requester, calls } = setup(() => responses.shift()!);

        const response = await requester.external('POST', 'https://storage.test/upload', { idempotent: true });

        expect(response.status).toBe(201);
        expect(calls).toHaveLength(3);
    });

    test('an external 5xx that persists is a ZoteroServerError naming the storage host', async () => {
        const { requester } = setup(() => status(502, 'upstream'));

        const error = await caught(requester.external('GET', 'https://storage.test/f?sig=secret', { idempotent: true })) as ZoteroServerError;

        expect(error.message).toBe('Zotero server error on storage.test (HTTP 502): upstream');
        expect(error.context).toEqual({ status: 502, idempotent: true, path: 'storage.test' });
    });

    test('external requests refuse anything but https', async () => {
        const { requester, calls } = setup(() => status(201));

        expect(await caught(requester.external('GET', 'http://storage.test/f', { idempotent: true }))).toBeInstanceOf(InvariantViolationError);
        expect(await caught(requester.external('GET', 'not a url', { idempotent: true }))).toBeInstanceOf(InvariantViolationError);
        expect(calls).toHaveLength(0);
    });
});
