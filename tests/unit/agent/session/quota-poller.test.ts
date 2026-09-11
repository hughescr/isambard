import { describe, expect, it, jest, type Mock } from 'bun:test';
import type { Logger } from '@hughescr/logger';
import { FakeClock } from '../../../helpers/fake-clock';
import { composeAmbientLines } from '@/agent/session/ambient-lines';
import { createLedgerStore, type LedgerEvent } from '@/agent/session/ledger';
import {
    DEFAULT_ANTHROPIC_USAGE_URL,
    DEFAULT_PROVIDER_REPORT_URL,
    type CreateQuotaPollerParams,
    type QuotaFetch,
    type QuotaFetchResponse,
    createQuotaPoller,
    parseProviderSnapshot,
    parseUsageWindows
} from '@/agent/session/quota-poller';

const RESET = '2026-09-11T22:00:00Z';
const GENERATED = '2026-09-11T20:00:01Z';

function providerReport(overrides: Record<string, unknown> = {}) {
    return {
        schema_version: 1,
        generated_at:   GENERATED,
        providers:      [{
            provider:         'anthropic',
            status:           'ok',
            last_attempt:     GENERATED,
            source_freshness: { cached: false, stale: false, age_seconds: 0 },
            errors:           [],
            quota_after:      {
                source:       'anthropic',
                collected_at: GENERATED,
                quotas:       [
                    { id: 'session', kind: 'session', group: 'session', used_percent: 31.5, unit: 'percent_0_100', duration_seconds: 18_000, resets_at: RESET },
                    { id: 'weekly_all', kind: 'weekly_all', group: 'weekly', used_percent: 35, unit: 'percent_0_100', duration_seconds: 604_800, resets_at: RESET },
                    { id: 'weekly_scoped:model:opus', kind: 'weekly_scoped', group: 'weekly', used_percent: 5, unit: 'percent_0_100', scope: { model: { id: 'opus', display_name: 'Opus' } } },
                ],
            },
            ...overrides,
        }],
    };
}

function ok(body: unknown): QuotaFetchResponse {
    return { ok: true, status: 200, json: async () => body };
}

interface Harness {
    clock:   FakeClock
    fetch:   Mock<QuotaFetch>
    ledgers: { dispatch: Mock<(event: LedgerEvent) => void> }[]
    logger:  { debug: Mock<Logger['debug']>, warn: Mock<Logger['warn']> }
    poller:  ReturnType<typeof createQuotaPoller>
}

function harness(overrides: Partial<CreateQuotaPollerParams> = {}): Harness {
    const clock = overrides.clock instanceof FakeClock ? overrides.clock : new FakeClock(Date.parse(GENERATED));
    const fetch = jest.fn<QuotaFetch>(overrides.fetch ?? (async () => ok(providerReport())));
    const ledgers = [{ dispatch: jest.fn<(event: LedgerEvent) => void>() }];
    const logger = { debug: jest.fn<Logger['debug']>(), warn: jest.fn<Logger['warn']>() };
    const poller = createQuotaPoller({ ...overrides, clock, fetch, ledgers, logger });
    return { clock, fetch, ledgers, logger, poller };
}

describe('provider report parsing', () => {
    it('preserves quota identifiers, scopes, durations, freshness and monetary balances', () => {
        const body = providerReport({
            source_freshness: { cached: true, stale: false, age_seconds: 12 },
            quota_after:      {
                source:         'anthropic',
                collected_at:   GENERATED,
                quotas:         [{ id: 'weekly_scoped:model:opus', kind: 'weekly_scoped', group: 'weekly', slot: 'secondary', used_percent: 5, unit: 'percent_0_100', duration_seconds: 604_800, scope: { model: { id: 'opus', display_name: 'Opus' }, surface: { id: 'cli' } } }],
                balances:       [{ kind: 'prepaid', currency: 'USD', total: '9.35', available: true }],
                spend_controls: [{ scope_id: 'monthly', reached: false }],
            },
        });

        const snapshot = parseProviderSnapshot(body);

        expect(snapshot?.providers[0]).toMatchObject({
            freshness:  { cached: true, stale: false, ageSeconds: 12 },
            quotaAfter: {
                quotas:        [{ id: 'weekly_scoped:model:opus', kind: 'weekly_scoped', group: 'weekly', slot: 'secondary', durationSeconds: 604_800, scope: { model: { id: 'opus', displayName: 'Opus' }, surface: { id: 'cli' } } }],
                balances:      [{ kind: 'prepaid', currency: 'USD', total: '9.35', available: true }],
                spendControls: [{ scopeId: 'monthly', reached: false }],
            },
        });
    });

    it('rejects unknown schemas and refuses a future, negative-age, or wrong-provider source as fresh quota', () => {
        expect(parseProviderSnapshot({ ...providerReport(), schema_version: 2 })).toBeUndefined();
        expect(parseProviderSnapshot(providerReport({ source_freshness: { cached: false, stale: false, age_seconds: -1 } }))).toBeUndefined();
        expect(parseProviderSnapshot(providerReport({ quota_after: { source: 'anthropic', collected_at: '2026-09-11T20:00:02Z' } }))?.providers[0]?.quotaAfter).toBeUndefined();
        const snapshot = parseProviderSnapshot(providerReport({ quota_after: { source: 'codex', collected_at: GENERATED } }));
        expect(snapshot?.providers[0]?.quotaAfter).toBeUndefined();
    });
});

describe('direct Anthropic fallback parsing', () => {
    it('treats utilization as a real 0-100 percentage', () => {
        expect(parseUsageWindows({ five_hour: { utilization: 0.42 }, seven_day: { utilization: 87 } })).toEqual({
            windows:  { fiveHour: { utilization: 0.42 }, sevenDay: { utilization: 87 } },
            rejected: false,
        });
    });

    it('maps the current unscoped limits schema and excludes scoped weekly limits', () => {
        const parsed = parseUsageWindows({ limits: [
            { kind: 'session', group: 'session', percent: 31.5, resets_at: RESET },
            { kind: 'session', group: 'session', percent: 95, is_active: false },
            { kind: 'weekly_all', group: 'weekly', percent: 35, resets_at: RESET, scope: null },
            { kind: 'weekly_scoped', group: 'weekly', percent: 90, scope: { model: { id: 'opus' } } },
        ] });
        expect(parsed.windows).toEqual({
            fiveHour: { utilization: 31.5, resetsAt: new Date(RESET) },
            sevenDay: { utilization: 35, resetsAt: new Date(RESET) },
        });
    });
});

describe('provider polling', () => {
    it('starts one nonblocking initial poll immediately', async () => {
        const { fetch, poller } = harness();
        poller.start();
        expect(fetch).toHaveBeenCalledTimes(1);
        await poller.poll();
    });

    it('fetches utraque with a bounded signal, stores the snapshot, and adapts only unscoped Anthropic limits', async () => {
        const { fetch, ledgers, poller } = harness();
        poller.start();
        await poller.poll();

        expect(fetch).toHaveBeenCalledWith(DEFAULT_PROVIDER_REPORT_URL, { headers: {}, signal: expect.any(AbortSignal) });
        expect(poller.getSnapshot?.()?.providers[0]?.provider).toBe('anthropic');
        expect(ledgers[0]?.dispatch).toHaveBeenCalledWith({
            type:  'quota_polled', at:    new Date(GENERATED),
            quota: {
                fiveHour: { utilization: 31.5, resetsAt: new Date(RESET) },
                sevenDay: { utilization: 35, resetsAt: new Date(RESET) },
            },
        });
    });

    it('keeps a stale source out of the Claude ledger', async () => {
        const { ledgers, poller } = harness({ fetch: async () => ok(providerReport({ source_freshness: { cached: true, stale: true, age_seconds: 900 } })) });
        poller.start();
        await poller.poll();
        expect(ledgers[0]?.dispatch).not.toHaveBeenCalled();
    });

    it('retains the known provider set as stale when a later report fails', async () => {
        const fetch = jest.fn<QuotaFetch>()
            .mockResolvedValueOnce(ok(providerReport()))
            .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });
        const { poller } = harness({ fetch });
        poller.start();
        await poller.poll();
        await poller.poll();
        expect(poller.getSnapshot?.()?.providers).toHaveLength(1);
        expect(poller.getSnapshot?.()?.providers[0]?.freshness.stale).toBe(true);
    });

    it('does not send the bearer to the direct endpoint after a local-auth rejection', async () => {
        const { fetch, poller } = harness({ fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
        poller.start();
        await poller.poll();
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('falls back after a missing report route and uses separate official OAuth headers', async () => {
        const fetch = jest.fn<QuotaFetch>(async url => (url === DEFAULT_PROVIDER_REPORT_URL
            ? { ok: false, status: 404, json: async () => ({}) }
            : ok({ five_hour: { utilization: 42 } })));
        const { ledgers, poller } = harness({ fetch, fallbackHeaders: () => ({ Authorization: 'Bearer secret', 'anthropic-beta': 'oauth-2025-04-20' }) });
        poller.start();
        await poller.poll();
        expect(fetch).toHaveBeenNthCalledWith(2, DEFAULT_ANTHROPIC_USAGE_URL, {
            headers: { Authorization: 'Bearer secret', 'anthropic-beta': 'oauth-2025-04-20' }, signal: expect.any(AbortSignal),
        });
        expect(ledgers[0]?.dispatch).toHaveBeenCalledWith(expect.objectContaining({ quota: { fiveHour: { utilization: 42 } } }));
    });

    it('keeps the provider snapshot stale while a fresh direct fallback updates Claude pacing', async () => {
        const fetch = jest.fn<QuotaFetch>()
            .mockResolvedValueOnce(ok(providerReport()))
            .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
            .mockResolvedValueOnce(ok({ five_hour: { utilization: 42 } }));
        const { ledgers, poller } = harness({ fetch });
        poller.start();
        await poller.poll();
        await poller.poll();
        expect(poller.getSnapshot?.()?.providers[0]?.freshness.stale).toBe(true);
        expect(ledgers[0]?.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ quota: { fiveHour: { utilization: 42 } } }));
    });

    it('dates repeated direct observations separately and does not re-present a retained partial window', async () => {
        const clock = new FakeClock(Date.parse(GENERATED));
        const fetch = jest.fn<QuotaFetch>()
            .mockResolvedValueOnce(ok({ five_hour: { utilization: 42 }, seven_day: { utilization: 61 } }))
            .mockResolvedValueOnce(ok({ five_hour: { utilization: 42 } }));
        const logger = { debug: jest.fn<Logger['debug']>(), warn: jest.fn<Logger['warn']>(), error: jest.fn<Logger['error']>() };
        const ledger = createLedgerStore('conversation', { logger });
        const poller = createQuotaPoller({ clock, fetch, ledgers: [ledger], logger, preferProviderReport: false });
        poller.start();
        await poller.poll();
        clock.advance(60_000);
        await poller.poll();

        expect(ledger.get().quota?.sevenDay?.utilization).toBe(61);
        const line = composeAmbientLines({
            self: ledger.get(), now: new Date(clock.now()), timezone: 'UTC', providerSnapshot: poller.getSnapshot?.(),
        })[0] ?? '';
        expect(line).toContain('Anthropic fallback (direct) 5-hour 42% used (source 20:01)');
        expect(line).not.toContain('week');
    });

    it('joins a single in-flight request', async () => {
        let release = (_response: QuotaFetchResponse): void => {};
        const gate = new Promise<QuotaFetchResponse>((resolve) => {
            release = resolve;
        });
        const { fetch, poller } = harness({ fetch: async () => gate });
        poller.start();
        const first = poller.poll();
        const second = poller.poll();
        expect(fetch).toHaveBeenCalledTimes(1);
        release(ok(providerReport()));
        await Promise.all([first, second]);
    });

    it('aborts at the injected-clock deadline', async () => {
        const { clock, logger, poller } = harness({
            requestTimeoutMs: 1000,
            fetch:            (_url, init) => new Promise((_resolve, reject) => {
                init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            }),
        });
        poller.start();
        const attempt = poller.poll();
        clock.advance(1000);
        await attempt;
        expect(logger.debug).toHaveBeenCalledWith({ errorName: 'Error' }, 'Quota poll failed; keeping the last known readings');
    });

    it('does not publish an old response after stop and restart, and starts a new-generation poll', async () => {
        let release = (_response: QuotaFetchResponse): void => {};
        const gate = new Promise<QuotaFetchResponse>((resolve) => {
            release = resolve;
        });
        const fetch = jest.fn<QuotaFetch>()
            .mockImplementationOnce(async () => gate)
            .mockResolvedValueOnce(ok(providerReport({ quota_after: {
                source:       'anthropic', collected_at: GENERATED,
                quotas:       [{ id: 'session', kind: 'session', group: 'session', used_percent: 55, unit: 'percent_0_100' }],
            } })));
        const { ledgers, poller } = harness({ fetch });
        poller.start();
        const attempt = poller.poll();
        poller.stop();
        poller.start();
        release(ok(providerReport()));
        await attempt;
        await Promise.resolve();
        await poller.poll();
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(ledgers[0]?.dispatch).toHaveBeenCalledTimes(1);
        expect(ledgers[0]?.dispatch).toHaveBeenCalledWith(expect.objectContaining({ quota: { fiveHour: { utilization: 55 } } }));
    });
});
