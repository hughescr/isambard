/**
 * The usage-endpoint quota poller (docs/plans/session-peers-and-quota.md block 3). No real
 * timers and no real network: a {@link FakeClock} drives every schedule and an injected fetch
 * stands in for the endpoint, whose exact shape probe P5 could not verify.
 */
import { afterEach, describe, expect, it, jest, type Mock } from 'bun:test';
import type { Logger } from '@hughescr/logger';
import { FakeClock } from '../../../helpers/fake-clock';
import type { LedgerEvent } from '@/agent/session/ledger';
import {
    DEFAULT_QUOTA_POLL_INTERVAL_MS,
    DEFAULT_QUOTA_RESULT_DEBOUNCE_MS,
    type CreateQuotaPollerParams,
    type QuotaFetch,
    type QuotaFetchResponse,
    type QuotaPoller,
    createQuotaPoller,
    parseUsageWindows
} from '@/agent/session/quota-poller';

const FIVE_HOUR_RESET_SECONDS = 1_788_993_000;
const FIVE_HOUR_RESET = new Date(FIVE_HOUR_RESET_SECONDS * 1000);

/** A body in the shape the SDK's own `unifiedWindows` uses, which is what the parser is built against. */
const USAGE_BODY = {
    five_hour: { utilization: 0.42, resetsAt: FIVE_HOUR_RESET_SECONDS },
    seven_day: { utilization: 0.61 },
};

function okResponse(body: unknown): QuotaFetchResponse {
    return { ok: true, status: 200, json: async () => body };
}

/** The injected logger's methods, typed as the real pino-style ones (they return the logger). */
type DebugMock = Mock<Logger['debug']>;
type WarnMock = Mock<Logger['warn']>;

interface Harness {
    clock:   FakeClock
    fetch:   Mock<QuotaFetch>
    logger:  { debug: DebugMock, warn: WarnMock }
    ledgers: { dispatch: Mock<(event: LedgerEvent) => void> }[]
    poller:  QuotaPoller
}

function harness(overrides: Partial<CreateQuotaPollerParams> = {}, ledgerCount = 1): Harness {
    const clock = new FakeClock();
    const fetch = jest.fn<QuotaFetch>(overrides.fetch ?? (async () => okResponse(USAGE_BODY)));
    const logger = { debug: jest.fn<Logger['debug']>(), warn: jest.fn<Logger['warn']>() };
    const ledgers = Array.from({ length: ledgerCount }, () => ({ dispatch: jest.fn<(event: LedgerEvent) => void>() }));
    const poller = createQuotaPoller({ ...overrides, clock, fetch, logger, ledgers });
    return { clock, fetch, logger, ledgers, poller };
}

/** Lets every already-scheduled microtask (fetch -> json -> dispatch) run; no macrotasks involved. */
async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

afterEach(() => {
    jest.restoreAllMocks();
});

describe('parseUsageWindows', () => {
    it('reads the two unified windows off a top-level object', () => {
        expect(parseUsageWindows(USAGE_BODY)).toEqual({
            windows:  { fiveHour: { utilization: 42, resetsAt: FIVE_HOUR_RESET }, sevenDay: { utilization: 61 } },
            rejected: false,
        });
    });

    it('reads windows nested under unifiedWindows', () => {
        expect(parseUsageWindows({ unifiedWindows: USAGE_BODY })).toEqual({
            windows:  { fiveHour: { utilization: 42, resetsAt: FIVE_HOUR_RESET }, sevenDay: { utilization: 61 } },
            rejected: false,
        });
    });

    it('lets a unifiedWindows entry win over the same window at the top level', () => {
        const parsed = parseUsageWindows({ five_hour: { utilization: 0.1 }, unifiedWindows: { five_hour: { utilization: 0.9 } } });

        expect(parsed).toEqual({ windows: { fiveHour: { utilization: 90 } }, rejected: false });
    });

    it('accepts a snake_case resets_at as unix seconds', () => {
        expect(parseUsageWindows({ five_hour: { utilization: 0.42, resets_at: FIVE_HOUR_RESET_SECONDS } })).toEqual({
            windows: { fiveHour: { utilization: 42, resetsAt: FIVE_HOUR_RESET } }, rejected: false,
        });
    });

    it('files seven_day_* variants under perModel and ignores unknown keys and unusable entries', () => {
        const parsed = parseUsageWindows({
            seven_day_opus: { utilization: 0.4 },
            five_hour:      5,
            overage:        { utilization: 0.9 },
            account:        'craig',
        });

        expect(parsed).toEqual({ windows: { perModel: { seven_day_opus: { utilization: 40 } } }, rejected: false });
    });

    it('returns no windows for a body with nothing recognisable in it, and reports no rejection — a body that is simply not window-shaped is not a units mismatch', () => {
        expect(parseUsageWindows({ account: 'craig' })).toEqual({ windows: undefined, rejected: false });
        expect(parseUsageWindows(null)).toEqual({ windows: undefined, rejected: false });
        expect(parseUsageWindows('nope')).toEqual({ windows: undefined, rejected: false });
        expect(parseUsageWindows({ five_hour: 5 })).toEqual({ windows: undefined, rejected: false });
        expect(parseUsageWindows({ five_hour: { resetsAt: FIVE_HOUR_RESET_SECONDS } })).toEqual({ windows: undefined, rejected: false });
    });

    it('reports a rejection when an entry carries a utilization the ledger refuses, alongside the windows it could read', () => {
        expect(parseUsageWindows({ five_hour: { utilization: 0.42 }, seven_day: { utilization: 87 } })).toEqual({
            windows: { fiveHour: { utilization: 42 } }, rejected: true,
        });
        expect(parseUsageWindows({ unifiedWindows: { seven_day: { utilization: 61 } } })).toEqual({ windows: undefined, rejected: true });
    });
});

describe('createQuotaPoller poll()', () => {
    it('fetches the default usage URL with no extra headers and dispatches to every ledger', async () => {
        const { clock, fetch, ledgers, poller } = harness({}, 2);
        poller.start();
        clock.advance(1000);

        await poller.poll();

        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledWith('https://api.anthropic.com/api/oauth/usage', { headers: {} });
        const expected: LedgerEvent = {
            type:  'quota_polled',
            quota: { fiveHour: { utilization: 42, resetsAt: FIVE_HOUR_RESET }, sevenDay: { utilization: 61 } },
            at:    new Date(1000),
        };
        for(const ledger of ledgers) {
            expect(ledger.dispatch).toHaveBeenCalledTimes(1);
            expect(ledger.dispatch).toHaveBeenCalledWith(expected);
        }
    });

    it('uses the configured URL and re-reads the headers factory on every poll', async () => {
        let token = 'first';
        const { fetch, poller } = harness({ url: 'https://example.test/usage', headers: () => ({ authorization: token }) });

        await poller.poll();
        token = 'second';
        await poller.poll();

        expect(fetch).toHaveBeenNthCalledWith(1, 'https://example.test/usage', { headers: { authorization: 'first' } });
        expect(fetch).toHaveBeenNthCalledWith(2, 'https://example.test/usage', { headers: { authorization: 'second' } });
    });

    it('dispatches nothing and logs at debug when the endpoint returns a non-OK status', async () => {
        // The body is a perfectly good one: only the status must stop this poll, so a guard that
        // fell through would dispatch it.
        const { logger, ledgers, poller } = harness({ fetch: async () => ({ ok: false, status: 401, json: async () => USAGE_BODY }) });

        await poller.poll();

        expect(ledgers[0]?.dispatch).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalledTimes(1);
        expect(logger.debug).toHaveBeenCalledWith({ status: 401 }, 'Quota poll: usage endpoint returned a non-OK status');
    });

    it('dispatches nothing and logs at debug when the fetch rejects', async () => {
        const error = new Error('offline');
        const { logger, ledgers, poller } = harness({
            fetch: async () => {
                throw error;
            },
        });

        await poller.poll();

        expect(ledgers[0]?.dispatch).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalledTimes(1);
        expect(logger.debug).toHaveBeenCalledWith({ error }, 'Quota poll failed; keeping the last known quota');
    });

    it('dispatches nothing and logs at debug when the body parses to no window', async () => {
        const { logger, ledgers, poller } = harness({ fetch: async () => okResponse({ account: 'craig' }) });

        await poller.poll();

        expect(ledgers[0]?.dispatch).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalledTimes(1);
        expect(logger.debug).toHaveBeenCalledWith('Quota poll: usage response carried no recognisable rate-limit window');
    });

    it('does not propagate a throwing ledger dispatch', async () => {
        const error = new Error('ledger exploded');
        const { logger, poller, ledgers } = harness();
        poller.start();
        ledgers[0]?.dispatch.mockImplementation(() => {
            throw error;
        });

        await poller.poll();

        expect(logger.debug).toHaveBeenCalledTimes(1);
        expect(logger.debug).toHaveBeenCalledWith({ error }, 'Quota poll failed; keeping the last known quota');
    });

    it('skips a poll while one is already in flight, and polls again once it settles', async () => {
        let release = (_response: QuotaFetchResponse): void => {};
        const gate = new Promise<QuotaFetchResponse>((resolve) => {
            release = resolve;
        });
        const { fetch, poller } = harness({ fetch: async () => gate });

        const first = poller.poll();
        const skipped = poller.poll();
        expect(fetch).toHaveBeenCalledTimes(1);

        release(okResponse(USAGE_BODY));
        await first;
        await skipped;
        await poller.poll();

        expect(fetch).toHaveBeenCalledTimes(2);
    });
});

describe('createQuotaPoller scheduling', () => {
    it('polls once per default interval while started, and not before', async () => {
        const { clock, fetch, poller } = harness();
        poller.start();

        clock.advance(DEFAULT_QUOTA_POLL_INTERVAL_MS - 1);
        expect(fetch).not.toHaveBeenCalled();

        clock.advance(1);
        expect(fetch).toHaveBeenCalledTimes(1);
        await flush();

        clock.advance(DEFAULT_QUOTA_POLL_INTERVAL_MS);
        expect(fetch).toHaveBeenCalledTimes(2);
        await flush();
    });

    it('honours a configured pollIntervalMs', async () => {
        const { clock, fetch, poller } = harness({ pollIntervalMs: 1000 });
        poller.start();

        clock.advance(1000);

        expect(fetch).toHaveBeenCalledTimes(1);
        await flush();
    });

    it('arms only one timer when start() is called twice', async () => {
        const { clock, fetch, poller } = harness();
        poller.start();
        poller.start();

        clock.advance(DEFAULT_QUOTA_POLL_INTERVAL_MS);

        expect(clock.pending()).toBe(1);
        expect(fetch).toHaveBeenCalledTimes(1);
        await flush();
    });

    it('stop() cancels the pending poll, and start() can arm again afterwards', () => {
        const { clock, fetch, poller } = harness();
        poller.start();
        poller.stop();

        clock.advance(DEFAULT_QUOTA_POLL_INTERVAL_MS * 2);
        expect(fetch).not.toHaveBeenCalled();
        expect(clock.pending()).toBe(0);

        poller.start();
        clock.advance(DEFAULT_QUOTA_POLL_INTERVAL_MS);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('a poll still in flight when stop() lands dispatches nothing into the torn-down process', async () => {
        let release = (_response: QuotaFetchResponse): void => {};
        const gate = new Promise<QuotaFetchResponse>((resolve) => {
            release = resolve;
        });
        const { ledgers, poller } = harness({ fetch: async () => gate });
        poller.start();
        const inFlight = poller.poll();

        poller.stop();
        release(okResponse(USAGE_BODY));
        await inFlight;

        expect(ledgers[0]?.dispatch).not.toHaveBeenCalled();
    });

    it('stop() before start() clears nothing', () => {
        const { clock, poller } = harness();
        const clearTimer = jest.spyOn(clock, 'clearTimer');

        poller.stop();

        expect(clearTimer).not.toHaveBeenCalled();
    });
});

describe('createQuotaPoller shape warning', () => {
    /** A body in the endpoint's plausible-but-wrong units: percents, not the SDK's 0-1 fraction. */
    const PERCENT_BODY = { five_hour: { utilization: 42 }, seven_day: { utilization: 61 } };

    it('warns ONCE per poller instance when the endpoint reports utilization outside the 0-1 fraction, and dispatches nothing', async () => {
        const { logger, ledgers, poller } = harness({ fetch: async () => okResponse(PERCENT_BODY) });
        poller.start();

        await poller.poll();
        await poller.poll();

        expect(ledgers[0]?.dispatch).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(
            { url: 'https://api.anthropic.com/api/oauth/usage' },
            'Quota poll: the usage endpoint reported a utilization outside the 0-1 fraction the SDK uses; those windows are being ignored, so this endpoint\'s shape is not what the parser expects'
        );
        // The debug line for an unusable body still stands, once per poll.
        expect(logger.debug).toHaveBeenCalledTimes(2);
        expect(logger.debug).toHaveBeenLastCalledWith('Quota poll: usage response carried no recognisable rate-limit window');
    });

    it('warns about the refused window even when the same body also carried a usable one, and files the usable one', async () => {
        const { logger, ledgers, poller } = harness({ fetch: async () => okResponse({ five_hour: { utilization: 0.42 }, seven_day: { utilization: 61 } }) });
        poller.start();

        await poller.poll();

        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.debug).not.toHaveBeenCalled();
        expect(ledgers[0]?.dispatch).toHaveBeenCalledWith(expect.objectContaining({ quota: { fiveHour: { utilization: 42 } } }));
    });

    it('never warns for a body the parser simply does not recognise', async () => {
        const { logger, poller } = harness({ fetch: async () => okResponse({ account: 'craig' }) });
        poller.start();

        await poller.poll();

        expect(logger.warn).not.toHaveBeenCalled();
    });
});

describe('createQuotaPoller noteResult()', () => {
    it('polls on the first result frame', () => {
        const { fetch, poller } = harness();
        poller.start();

        poller.noteResult();

        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('debounces a second result frame inside the default window and polls again at its edge', async () => {
        const { clock, fetch, poller } = harness();
        poller.start();

        poller.noteResult();
        await flush();
        clock.advance(DEFAULT_QUOTA_RESULT_DEBOUNCE_MS - 1);
        poller.noteResult();
        expect(fetch).toHaveBeenCalledTimes(1);

        clock.advance(1);
        poller.noteResult();
        expect(fetch).toHaveBeenCalledTimes(2);
        await flush();
    });

    it('honours a configured resultDebounceMs', async () => {
        const { clock, fetch, poller } = harness({ resultDebounceMs: 5000 });
        poller.start();

        poller.noteResult();
        await flush();
        clock.advance(4999);
        poller.noteResult();
        expect(fetch).toHaveBeenCalledTimes(1);

        clock.advance(1);
        poller.noteResult();
        expect(fetch).toHaveBeenCalledTimes(2);
        await flush();
    });

    it('polls nothing before start(): a result frame reaching a poller the app never armed is not a poll', () => {
        const { fetch, poller } = harness();

        poller.noteResult();

        expect(fetch).not.toHaveBeenCalled();
    });

    it('polls nothing after stop(): the ambience\'s result subscription outlives the poller\'s lifecycle', () => {
        const { fetch, poller } = harness();
        poller.start();
        poller.stop();

        poller.noteResult();

        expect(fetch).not.toHaveBeenCalled();
    });

    it('counts an interval poll against the debounce window', async () => {
        const { clock, fetch, poller } = harness();
        poller.start();

        clock.advance(DEFAULT_QUOTA_POLL_INTERVAL_MS);
        expect(fetch).toHaveBeenCalledTimes(1);
        await flush();

        poller.noteResult();

        expect(fetch).toHaveBeenCalledTimes(1);
    });
});
