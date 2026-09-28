/**
 * Mutation-kill tests for `src/integrations/zotero/request.ts` (#157): exact boundaries, exact
 * error messages and exact response shapes that `tests/unit/integrations/zotero/request.test.ts`
 * left unpinned. New file so parallel mutant-killing groups do not conflict; no shared helper
 * edits. No network, no real timers: every clock here is a fake one whose `sleep` resolves at
 * once and whose `now` is fully controlled by the test.
 */
import { describe, expect, test } from 'bun:test';
import {
    TEST_API_KEY,
    fakeClock,
    json,
    recordingFetch,
    status,
    type FakeClock,
    type FakeHandler
} from '../../../helpers/zotero-fake';
import {
    InvariantViolationError,
    ZoteroError,
    ZoteroRateLimitError,
    ZoteroServerError,
    type ZoteroVersionConflictError
} from '@/errors';
import { intHeader, ZoteroRequester, type ZoteroMethod, type ZoteroTarget } from '@/integrations/zotero/request';

const ITEMS: ZoteroTarget = { scope: 'library', path: '/items' };

function setup(handler: FakeHandler, options: { clock?: FakeClock, maxWaitMs?: number } = {}) {
    const clock = options.clock ?? fakeClock();
    const { fetch, calls } = recordingFetch(handler, clock);
    const requester = new ZoteroRequester({
        apiKey:        TEST_API_KEY,
        groupId:       6_692_257,
        fetch,
        sleep:         clock.sleep,
        now:           clock.now,
        timeoutSignal: () => new AbortController().signal,
        ...options.maxWaitMs === undefined ? {} : { maxWaitMs: options.maxWaitMs },
    });
    return { requester, calls, clock };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    throw new Error('expected a rejection');
}

/** A clock whose `now()` starts at `start` instead of 0 (the shared `fakeClock` always starts at 0). */
function clockStartingAt(start: number): FakeClock {
    let time = start;
    const sleeps: number[] = [];
    return {
        now:   () => time,
        sleep: async (ms: number) => {
            sleeps.push(ms);
            time += ms;
        },
        sleeps,
        advance: (ms: number) => {
            time += ms;
        },
    };
}

describe('intHeader', () => {
    test('requires the whole value to be digits (not merely to end in one)', () => {
        const headers = new Headers({ 'X-Trailing': 'abc123', 'X-Plain': '0' });

        expect(intHeader(headers, 'X-Trailing')).toBeUndefined();
        expect(intHeader(headers, 'X-Plain')).toBe(0);
        expect(intHeader(headers, 'X-Missing')).toBeUndefined();
    });
});

describe('ZoteroRequester invariant messages', () => {
    test('the groupId invariant names the requester and the exact bad value', () => {
        let error: unknown;
        try {
            new ZoteroRequester({ apiKey: TEST_API_KEY, groupId: -3 });
        } catch (error_) {
            error = error_;
        }

        expect(error).toBeInstanceOf(InvariantViolationError);
        expect((error as Error).message).toBe('Invariant violated in ZoteroRequester: groupId must be a positive integer, got -3');
    });

    test('the disallowed-method invariant names the requester and the exact method', async () => {
        const { requester } = setup(() => json([]));

        const error = await caught(requester.request('DELETE' as ZoteroMethod, ITEMS, { idempotent: true }));

        expect((error as Error).message).toBe('Invariant violated in ZoteroRequester: method DELETE is not allowed');
    });

    test('the external-https invariant names ZoteroRequester.external exactly', async () => {
        const { requester } = setup(() => status(201));

        const error = await caught(requester.external('GET', 'http://storage.test/f', { idempotent: true }));

        expect((error as Error).message).toBe('Invariant violated in ZoteroRequester.external: storage URLs must be absolute https URLs');
    });

    test('the invalid-library-path invariant names the requester and quotes the path', async () => {
        const { requester } = setup(() => json([]));

        const error = await caught(requester.request('GET', { scope: 'library', path: 'items' }, { idempotent: true }));

        expect((error as Error).message).toBe('Invariant violated in ZoteroRequester: invalid library path "items"');
    });

    test('the unknown-scope invariant names the requester and its exact reason', async () => {
        const { requester } = setup(() => json([]));

        const error = await caught(requester.request('GET', { scope: 'users', path: '/items' } as unknown as ZoteroTarget, { idempotent: true }));

        expect((error as Error).message).toBe('Invariant violated in ZoteroRequester: only the group library and /items/new may be requested');
    });

    test('rejects a library path that contains a slash without starting with one', async () => {
        const { requester, calls } = setup(() => json([]));

        expect(await caught(requester.request('GET', { scope: 'library', path: 'a/items' }, { idempotent: true }))).toBeInstanceOf(InvariantViolationError);
        expect(calls).toHaveLength(0);
    });

    test('an unknown scope is rejected even when its path matches the schema endpoint', async () => {
        const { requester, calls } = setup(() => json({}));

        expect(await caught(requester.request('GET', { scope: 'users', path: '/items/new' } as unknown as ZoteroTarget, { idempotent: true }))).toBeInstanceOf(InvariantViolationError);
        expect(calls).toHaveLength(0);
    });
});

describe('ZoteroRequester response shape', () => {
    test('a missing version or total-results header omits the key, not just its value', async () => {
        const bare = setup(() => json([]));
        const response = await bare.requester.request('GET', ITEMS, { idempotent: true });
        expect(Object.keys(response)).not.toContain('libraryVersion');
        expect(Object.keys(response)).not.toContain('totalResults');

        const withHeaders = setup(() => json([], { headers: { 'Last-Modified-Version': '3', 'Total-Results': '5' } }));
        const full = await withHeaders.requester.request('GET', ITEMS, { idempotent: true });
        expect(Object.keys(full)).toContain('libraryVersion');
        expect(Object.keys(full)).toContain('totalResults');
    });

    test('a request with neither json nor form sends no body and no content-type', async () => {
        const { requester, calls } = setup(() => json([]));

        await requester.request('GET', ITEMS, { idempotent: true });

        expect(calls[0].bodyText).toBeUndefined();
        expect(calls[0].headers.get('Content-Type')).toBeNull();
    });

    test('a 412 without a version header omits currentVersion from the context entirely', async () => {
        const { requester } = setup(() => status(412, 'no header'));

        const error = await caught(requester.request('POST', ITEMS, { idempotent: false })) as ZoteroVersionConflictError;

        expect(error.context).toStrictEqual({ path: '/items' });
    });

    test('a non-JSON response error carries the path in its context, not an empty one', async () => {
        const { requester } = setup(() => status(200, '<html>'));

        const error = await caught(requester.request('GET', ITEMS, { idempotent: true })) as ZoteroError;

        expect(error.context).toStrictEqual({ path: '/items' });
    });

    test('HTTP 499 maps to the generic rejection, not a server error', async () => {
        const { requester } = setup(() => status(499, 'weird'));

        const error = await caught(requester.request('POST', ITEMS, { idempotent: false }));

        expect(error).toBeInstanceOf(ZoteroError);
        expect(error).not.toBeInstanceOf(ZoteroServerError);
        expect((error as Error).message).toBe('Zotero rejected the request to /items (HTTP 499): weird');
    });

    test('API calls treat HTTP 399 as an ordinary response, not a client error', async () => {
        const { requester } = setup(() => status(399, ''));

        const response = await requester.request('GET', ITEMS, { idempotent: true });

        expect(response.status).toBe(399);
    });

    test('external calls treat HTTP 499 as an ordinary response, not a server error', async () => {
        const { requester } = setup(() => status(499, 'weird client code'));

        const response = await requester.external('GET', 'https://storage.test/f', { idempotent: true });

        expect(response.status).toBe(499);
    });
});

describe('ZoteroRequester shared-deadline boundaries', () => {
    test('the shared deadline starts at exactly zero, not before it', async () => {
        const clock = clockStartingAt(-0.5);
        const { fetch, calls } = recordingFetch(() => json([]), clock);
        const requester = new ZoteroRequester({
            apiKey: TEST_API_KEY, groupId: 1, fetch, sleep: clock.sleep, now: clock.now, timeoutSignal: () => new AbortController().signal,
        });

        await requester.request('GET', ITEMS, { idempotent: true });

        expect(clock.sleeps).toEqual([0.5]);
        expect(calls).toHaveLength(1);
    });

    test('the default wait budget is exactly 60 seconds, not a millisecond more', async () => {
        const { requester, calls, clock } = setup(() => json([], { headers: { Backoff: '61' } }));

        await requester.request('GET', ITEMS, { idempotent: true });
        clock.advance(999);
        const error = await caught(requester.request('GET', ITEMS, { idempotent: true })) as ZoteroRateLimitError;

        expect(error).toBeInstanceOf(ZoteroRateLimitError);
        expect(error.overBudget).toBe(true);
        expect(error.retryAfterMs).toBe(60_001);
        expect(calls).toHaveLength(1);
    });

    test('a one-millisecond remaining wait is still honoured, not skipped', async () => {
        const responses = [json([], { headers: { Backoff: '1' } }), json([])];
        const { requester, calls, clock } = setup(() => responses.shift()!);

        await requester.request('GET', ITEMS, { idempotent: true });
        clock.advance(999);
        await requester.request('GET', ITEMS, { idempotent: true });

        expect(clock.sleeps).toEqual([1]);
        expect(calls).toHaveLength(2);
    });

    test('the over-budget wait message rounds a whole number of seconds up', async () => {
        const { requester, calls } = setup(() => json([], { headers: { Backoff: '9' } }), { maxWaitMs: 5000 });

        await requester.request('GET', ITEMS, { idempotent: true });
        const error = await caught(requester.request('GET', ITEMS, { idempotent: true })) as ZoteroRateLimitError;

        expect(error.message).toBe('Zotero asked us to wait ~9s before the next request to /items; try again later');
        expect(calls).toHaveLength(1);
    });

    test('the over-budget wait message rounds up from just under a whole second', async () => {
        const { requester, calls, clock } = setup(() => json([], { headers: { Backoff: '10' } }), { maxWaitMs: 5000 });

        await requester.request('GET', ITEMS, { idempotent: true });
        clock.advance(991);
        const error = await caught(requester.request('GET', ITEMS, { idempotent: true })) as ZoteroRateLimitError;

        expect(error.message).toBe('Zotero asked us to wait ~10s before the next request to /items; try again later');
        expect(calls).toHaveLength(1);
    });

    test('the rate-limit message rounds a large Retry-After using whole seconds', async () => {
        const { requester, calls } = setup(() => status(429, '', { 'Retry-After': '1001' }));

        const error = await caught(requester.request('GET', ITEMS, { idempotent: true })) as ZoteroRateLimitError;

        expect(error.message).toBe('Zotero rate-limited /items (HTTP 429); retry after ~1001s');
        expect(error.overBudget).toBe(true);
        expect(calls).toHaveLength(1);
    });

    test('a failed body cancel during a rate limit is not silently dropped', async () => {
        const stream = new ReadableStream({
            cancel() {
                throw new Error('cancel exploded');
            },
        });
        const response = new Response(stream, { status: 429, headers: { 'Retry-After': '1' } });
        const { requester, calls } = setup(() => response);

        const error = await caught(requester.request('GET', ITEMS, { idempotent: true }));

        expect((error as Error).message).toBe('cancel exploded');
        expect(calls).toHaveLength(1);
    });
});
