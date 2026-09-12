import { describe, expect, it, jest, type Mock } from 'bun:test';
import type { Logger } from '@hughescr/logger';
import { FakeClock } from '../../../helpers/fake-clock';
import { composeAmbientLines } from '@/agent/session/ambient-lines';
import { createLedgerStore, initialLedger, type LedgerEvent } from '@/agent/session/ledger';
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

function historyReport(provider = 'anthropic') {
    let model = 'deepseek-flash';
    if(provider === 'anthropic') {
        model = 'claude-sonnet-5';
    } else if(provider === 'codex') {
        model = 'gpt-5.6-luna';
    }
    return {
        source:      'ccusage', coverage:    'local_only', cost_basis:  'calculated_api_reference_usd',
        started_at:  '2026-09-11T20:00:00Z', finished_at: GENERATED,
        seven_days:  {
            since:  '2026-09-05T00:00:00Z', until:  '2026-09-11T00:00:00Z',
            models: [{
                source:                'claude', model, provider,
                input_tokens:          100, output_tokens:         200, cache_creation_tokens: 300, cache_read_tokens:     400,
                total_tokens:          1000, cost_usd:              0.003, cost_status:           'available',
            }],
        },
        blocks: [{
            id:                    'current', source:                'claude', start_time:            '2026-09-11T17:00:00Z', end_time:              RESET,
            actual_end_time:       GENERATED, is_active:             true, is_gap:                false, mixed_provider:        false, entries:               1,
            input_tokens:          10, output_tokens:         20, cache_creation_tokens: 30, cache_read_tokens:     40,
            total_tokens:          100, cost_usd:              0.0003, cost_status:           'available',
            models:                [{ model, provider }],
        }],
    };
}

function referencePrices(model = 'claude-haiku-4-5-20251001') {
    return {
        source:      'models.dev', observed_at: GENERATED, unit:        'usd_per_million_tokens', assumptions: ['base_tier', 'cache_write_5m'],
        models:      [{ model, input: 1, output: 5, cache_read: 0.1, cache_write: 1.25, eligible: true }],
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
    it('uses the documented local report and official Anthropic fallback endpoints', () => {
        expect(DEFAULT_PROVIDER_REPORT_URL).toBe('http://127.0.0.1:8317/v1/utraque/providers');
        expect(DEFAULT_ANTHROPIC_USAGE_URL).toBe('https://api.anthropic.com/api/oauth/usage');
    });

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

    it('parses compact history inputs and models.dev reference prices from the report contract', () => {
        const snapshot = parseProviderSnapshot(providerReport({
            history: historyReport(), reference_prices: referencePrices(),
        }));

        expect(snapshot?.providers[0]?.history).toMatchObject({
            source:       'ccusage', coverage:     'local_only', costBasis:    'calculated_api_reference_usd', recentDays:   7,
            recentTokens: { inputTokens: 100, outputTokens: 200, cacheCreationTokens: 300, cacheReadTokens: 400, totalTokens: 1000 },
            recentModels: [{ model: 'claude-sonnet-5', costUsd: 0.003 }],
            blocks:       [{ active: true, gap: false, mixedProvider: false, costUsd: 0.0003, modelProviders: ['anthropic'] }],
        });
        expect(snapshot?.providers[0]?.prices).toEqual({
            source:      'models.dev', observedAt:  new Date(GENERATED), stale:       false, unit:        'usd_per_million_tokens',
            assumptions: ['base_tier', 'cache_write_5m'],
            models:      [{ model: 'claude-haiku-4-5-20251001', input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, eligible: true }],
        });
    });

    it('accepts zero-valued history usage and cost while preserving exact block model identities', () => {
        const history = historyReport();
        Object.assign(history.seven_days.models[0], {
            input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, total_tokens: 0, cost_usd: 0,
        });
        Object.assign(history.blocks[0], {
            input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, total_tokens: 0, cost_usd: 0,
        });

        expect(parseProviderSnapshot(providerReport({ history }))?.providers[0]?.history).toEqual({
            source:       'ccusage',
            coverage:     'local_only',
            costBasis:    'calculated_api_reference_usd',
            startedAt:    new Date('2026-09-11T20:00:00Z'),
            finishedAt:   new Date(GENERATED),
            recentSince:  new Date('2026-09-05T00:00:00Z'),
            recentUntil:  new Date('2026-09-11T00:00:00Z'),
            recentDays:   7,
            recentTokens: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0 },
            recentModels: [{
                model: 'claude-sonnet-5', tokens: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0 }, costUsd: 0,
            }],
            blocks: [{
                startTime:      new Date('2026-09-11T17:00:00Z'),
                endTime:        new Date(RESET),
                active:         true,
                gap:            false,
                mixedProvider:  false,
                modelNames:     ['claude-sonnet-5'],
                modelProviders: ['anthropic'],
                tokens:         { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0 },
                costUsd:        0,
            }],
        });
    });

    it('drops malformed history and reference prices without rejecting live quota', () => {
        const snapshot = parseProviderSnapshot(providerReport({
            history:          { ...historyReport(), seven_days: { ...historyReport().seven_days, until: '2026-09-10T00:00:00Z' } },
            reference_prices: { ...referencePrices(), models: [{ model: 'claude-haiku', input: 0, output: 5, eligible: true }] },
        }));

        expect(snapshot?.providers[0]?.quotaAfter).toBeDefined();
        expect(snapshot?.providers[0]?.history).toBeUndefined();
        expect(snapshot?.providers[0]?.prices).toBeUndefined();
    });

    it('requires trusted local API-reference history and internally consistent token totals', () => {
        const wrongCoverage = parseProviderSnapshot(providerReport({
            history: { ...historyReport(), coverage: 'remote' },
        }));
        const wrongTotal = historyReport();
        wrongTotal.seven_days.models[0].total_tokens = 999;
        const mismatched = parseProviderSnapshot(providerReport({ history: wrongTotal }));

        expect(wrongCoverage?.providers[0]?.history).toBeUndefined();
        expect(mismatched?.providers[0]?.history).toBeUndefined();
    });

    it('filters Spark from Codex history aggregates without dropping current Codex history', () => {
        const current = historyReport('codex').seven_days.models[0];
        const spark = { ...current, model: 'GPT-5.3-Codex-Spark', input_tokens: 1, total_tokens: 901 };
        const sparkId = { ...current, model: 'CODEX_BENGALFOX', input_tokens: 1, total_tokens: 901 };
        const rawHistory = historyReport('codex');
        rawHistory.seven_days.models = [spark, sparkId, current];
        const snapshot = parseProviderSnapshot(providerReport({
            provider:    'codex',
            quota_after: { source: 'codex', collected_at: GENERATED },
            history:     rawHistory,
        }));

        expect(snapshot?.providers[0]?.history?.recentTokens).toEqual({
            inputTokens: 100, outputTokens: 200, cacheCreationTokens: 300, cacheReadTokens: 400, totalTokens: 1000,
        });
        expect(snapshot?.providers[0]?.history?.recentModels.map(model => model.model)).toEqual(['gpt-5.6-luna']);
    });

    it('retains a Spark-named history sample when it belongs to another provider', () => {
        const history = historyReport();
        history.seven_days.models[0].model = 'GPT-5.3-Codex-Spark';

        expect(parseProviderSnapshot(providerReport({ history }))?.providers[0]?.history?.recentModels.map(model => model.model))
            .toEqual(['GPT-5.3-Codex-Spark']);
    });

    it('requires a cost status and rejects negative available costs', () => {
        const missingStatus = historyReport();
        delete (missingStatus.seven_days.models[0] as { cost_status?: string }).cost_status;
        const negativeCost = historyReport();
        negativeCost.seven_days.models[0].cost_usd = -0.001;

        expect(parseProviderSnapshot(providerReport({ history: missingStatus }))?.providers[0]?.history).toBeUndefined();
        expect(parseProviderSnapshot(providerReport({ history: negativeCost }))?.providers[0]?.history).toBeUndefined();
    });

    it('accepts an unavailable cost status without inventing a cost sample', () => {
        const history = historyReport();
        const model: Record<string, unknown> = { ...history.seven_days.models[0], cost_status: 'unavailable' };
        delete model.cost_usd;
        history.seven_days.models = [model as typeof history.seven_days.models[number]];

        const parsed = parseProviderSnapshot(providerReport({ history }))?.providers[0]?.history?.recentModels[0];
        expect(parsed).toEqual({
            model:   'claude-sonnet-5',
            tokens:  { inputTokens: 100, outputTokens: 200, cacheCreationTokens: 300, cacheReadTokens: 400, totalTokens: 1000 },
            costUsd: undefined,
        });
        expect(Object.hasOwn(parsed!, 'costUsd')).toBe(true);
    });

    it('requires each history sample to name the report provider', () => {
        const history = historyReport();
        history.seven_days.models[0].provider = 'codex';

        expect(parseProviderSnapshot(providerReport({ history }))?.providers[0]?.history).toBeUndefined();
    });

    it.each([
        ['an empty block', '2026-09-11T17:00:00Z', '2026-09-11T17:00:00Z'],
        ['a reversed block', RESET, '2026-09-11T17:00:00Z'],
    ])('rejects %s time interval', (_description, startTime, endTime) => {
        const history = historyReport();
        history.blocks[0].start_time = startTime;
        history.blocks[0].end_time = endTime;

        expect(parseProviderSnapshot(providerReport({ history }))?.providers[0]?.history).toBeUndefined();
    });

    it('rejects reversed collection times and histories completed after report generation', () => {
        const reversed = historyReport();
        reversed.started_at = '2026-09-11T20:00:02Z';
        const future = historyReport();
        future.finished_at = '2026-09-11T20:00:02Z';

        expect(parseProviderSnapshot(providerReport({ history: reversed }))?.providers[0]?.history).toBeUndefined();
        expect(parseProviderSnapshot(providerReport({ history: future }))?.providers[0]?.history).toBeUndefined();
    });

    it('parses stale price provenance and rejects malformed optional price fields', () => {
        const stale = parseProviderSnapshot(providerReport({
            reference_prices: { ...referencePrices(), stale: true },
        }));
        const malformed = parseProviderSnapshot(providerReport({
            reference_prices: { ...referencePrices(), stale: 'yes' },
        }));

        expect(stale?.providers[0]?.prices?.stale).toBe(true);
        expect(malformed?.providers[0]?.prices).toBeUndefined();
    });

    it('accepts omitted cache prices without manufacturing values', () => {
        const prices = referencePrices();
        delete (prices.models[0] as { cache_read?: number }).cache_read;
        delete (prices.models[0] as { cache_write?: number }).cache_write;

        const parsed = parseProviderSnapshot(providerReport({ reference_prices: prices }))?.providers[0]?.prices?.models[0];
        expect(parsed).toEqual({
            model: 'claude-haiku-4-5-20251001', input: 1, output: 5, cacheRead: undefined, cacheWrite: undefined, eligible: true,
        });
        expect(Object.hasOwn(parsed!, 'cacheRead')).toBe(true);
        expect(Object.hasOwn(parsed!, 'cacheWrite')).toBe(true);
    });

    it.each([
        ['output', { output: 0 }],
        ['cache-read', { cache_read: 0 }],
        ['cache-write', { cache_write: 0 }],
    ])('rejects a non-positive %s reference price', (_category, overrides) => {
        const prices = referencePrices();
        prices.models = [{ ...prices.models[0], ...overrides }];

        expect(parseProviderSnapshot(providerReport({ reference_prices: prices }))?.providers[0]?.prices).toBeUndefined();
    });

    it('rejects future observations and a missing reference-price sample list', () => {
        const future = { ...referencePrices(), observed_at: '2026-09-11T20:00:02Z' };
        const missingModels = { ...referencePrices(), models: undefined };

        expect(parseProviderSnapshot(providerReport({ reference_prices: future }))?.providers[0]?.prices).toBeUndefined();
        expect(parseProviderSnapshot(providerReport({ reference_prices: missingModels }))?.providers[0]?.prices).toBeUndefined();
    });

    it('rejects unknown schemas and refuses a future, negative-age, or wrong-provider source as fresh quota', () => {
        expect(parseProviderSnapshot({ ...providerReport(), schema_version: 2 })).toBeUndefined();
        expect(parseProviderSnapshot(providerReport({ source_freshness: { cached: false, stale: false, age_seconds: -1 } }))).toBeUndefined();
        expect(parseProviderSnapshot(providerReport({ last_attempt: '2026-09-11T20:00:02Z' }))).toBeUndefined();
        expect(parseProviderSnapshot(providerReport({ quota_after: { source: 'anthropic', collected_at: '2026-09-11T20:00:02Z' } }))?.providers[0]?.quotaAfter).toBeUndefined();
        const snapshot = parseProviderSnapshot(providerReport({ quota_after: { source: 'codex', collected_at: GENERATED } }));
        expect(snapshot?.providers[0]?.quotaAfter).toBeUndefined();
    });

    it('rejects empty or non-string required provider fields', () => {
        expect(parseProviderSnapshot(providerReport({ provider: '' }))).toBeUndefined();
        expect(parseProviderSnapshot(providerReport({ provider: 42 }))).toBeUndefined();
        expect(parseProviderSnapshot(providerReport({ status: '' }))).toBeUndefined();
        expect(parseProviderSnapshot(providerReport({ quota_after: { source: '', collected_at: GENERATED } }))?.providers[0]?.quotaAfter).toBeUndefined();
    });

    it('rejects report-shaped arrays and callable values at the unknown input boundary', () => {
        expect(parseProviderSnapshot(Object.assign([], providerReport()))).toBeUndefined();
        expect(parseProviderSnapshot(Object.assign(() => undefined, providerReport()))).toBeUndefined();
    });

    it('preserves display-name-only scopes, omits an absent scope, and validates error entries independently', () => {
        const snapshot = parseProviderSnapshot(providerReport({
            errors:      [{ section: 'quota_after', code: 'expired' }, { section: '', code: 'ignored' }, null],
            quota_after: {
                source:       'anthropic', collected_at: GENERATED,
                quotas:       [
                    { id: 'named-scope', used_percent: 5, unit: 'percent_0_100', scope: { model: { display_name: 'Named model' } } },
                    { id: 'unscoped', used_percent: 6, unit: 'percent_0_100' },
                ],
            },
        }));

        expect(snapshot?.providers[0]?.errors).toEqual([{ section: 'quota_after', code: 'expired' }]);
        expect(snapshot?.providers[0]?.quotaAfter?.quotas[0]?.scope).toEqual({ model: { displayName: 'Named model' } });
        expect(snapshot?.providers[0]?.quotaAfter?.quotas[1]?.scope).toBeUndefined();
    });

    it('preserves an optional quota API retry timestamp after a rate-limited lookup', () => {
        const retryAt = '2026-09-11T20:05:00Z';
        const snapshot = parseProviderSnapshot(providerReport({
            status: 'partial',
            errors: [{ section: 'quota_after', code: 'rate_limited', retry_at: retryAt }],
        }));

        expect(snapshot?.providers[0]?.errors).toEqual([
            { section: 'quota_after', code: 'rate_limited', retryAt: new Date(retryAt) },
        ]);
    });

    it('leaves retry metadata undefined when the report has no valid retry timestamp', () => {
        const snapshot = parseProviderSnapshot(providerReport({
            errors: [{ section: 'quota_after', code: 'timed_out' }, { section: 'quota_after', code: 'rate_limited', retry_at: 'invalid' }],
        }));
        expect(snapshot?.providers[0]?.errors.map(error => error.retryAt)).toEqual([undefined, undefined]);
    });

    it('accepts inclusive percentage boundaries and drops out-of-range or wrongly-unitized quotas', () => {
        const snapshot = parseProviderSnapshot(providerReport({ quota_after: {
            source:       'anthropic', collected_at: GENERATED,
            quotas:       [
                { id: 'empty', used_percent: 0, unit: 'percent_0_100' },
                { id: 'full', used_percent: 100, unit: 'percent_0_100' },
                { id: 'negative', used_percent: -0.01, unit: 'percent_0_100' },
                { id: 'over', used_percent: 100.01, unit: 'percent_0_100' },
                { id: 'fraction', used_percent: 0.5, unit: 'fraction_0_1' },
            ],
        } }));

        expect(snapshot?.providers[0]?.quotaAfter?.quotas.map(quota => [quota.id, quota.usedPercent])).toEqual([
            ['empty', 0], ['full', 100],
        ]);
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

    it('maps a session-group limit whose kind is omitted', () => {
        expect(parseUsageWindows({ limits: [{ group: 'session', percent: 17 }] })).toEqual({
            windows:  { fiveHour: { utilization: 17 } },
            rejected: false,
        });
    });

    it('supports legacy window ids, inclusive boundaries, and epoch-second resets', () => {
        expect(parseUsageWindows({
            five_hour: { utilization: 0, resets_at: 1_800_000_000 },
            seven_day: { utilization: 100 },
        })).toEqual({
            windows: {
                fiveHour: { utilization: 0, resetsAt: new Date(1_800_000_000_000) },
                sevenDay: { utilization: 100 },
            },
            rejected: false,
        });
        expect(parseUsageWindows({
            five_hour: { utilization: -0.01 },
            seven_day: { utilization: 100.01 },
        })).toEqual({ windows: undefined, rejected: true });
    });

    it('excludes a surface-scoped limit even when its kind and group look unified', () => {
        expect(parseUsageWindows({ limits: [{
            kind: 'session', group: 'session', percent: 95, scope: { surface: { id: 'cli' } },
        }] })).toEqual({ windows: undefined, rejected: false });
    });

    it('maps each supported limit kind independently and ignores scoped or unknown kinds', () => {
        expect(parseUsageWindows({ limits: [
            { kind: 'session', percent: 10 },
            { kind: 'new-session-kind', group: 'session', percent: 11 },
            { group: 'session', percent: 12 },
            { kind: 'seven_day', percent: 20 },
            { kind: 'seven_day_opus', percent: 30 },
            { kind: 'weekly_scoped', percent: 40 },
            { kind: 'weekly_scoped', group: 'session', percent: 41 },
            { kind: 'session', percent: 50, scope: { model: { display_name: 'Named model' } } },
            { kind: 'unknown', percent: 60 },
            { percent: 70 },
        ] })).toEqual({
            windows: {
                fiveHour: { utilization: 12 },
                sevenDay: { utilization: 20 },
                perModel: { seven_day_opus: { utilization: 30 } },
            },
            rejected: false,
        });
    });

    it('maps a session kind without relying on its group or another later limit', () => {
        const parsed = parseUsageWindows({ limits: [{ kind: 'session', percent: 10 }] });
        expect(parsed).toEqual({
            windows:  { fiveHour: { utilization: 10, resetsAt: undefined } },
            rejected: false,
        });
        expect(Object.hasOwn(parsed.windows!.fiveHour!, 'resetsAt')).toBe(false);
    });

    it('ignores an invalid percentage on an unknown limit kind', () => {
        expect(parseUsageWindows({ limits: [{ kind: 'unknown', percent: 101 }] })).toEqual({
            windows:  undefined,
            rejected: false,
        });
    });

    it('rejects an empty legacy id instead of silently accepting its percentage', () => {
        expect(parseUsageWindows({ '': { utilization: 42 } })).toEqual({ windows: undefined, rejected: true });
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
        const { clock, fetch, ledgers, poller } = harness();
        poller.start();
        await poller.poll();

        expect(fetch).toHaveBeenCalledWith(DEFAULT_PROVIDER_REPORT_URL, { headers: {}, signal: expect.any(AbortSignal) });
        expect(poller.getSnapshot?.()?.providers[0]?.provider).toBe('anthropic');
        expect(poller.getSnapshot?.()?.expiresAt).toEqual(new Date(clock.now() + 600_000));
        expect(ledgers[0]?.dispatch).toHaveBeenCalledWith({
            type:  'quota_polled', at:    new Date(GENERATED),
            quota: {
                fiveHour: { utilization: 31.5, resetsAt: new Date(RESET) },
                sevenDay: { utilization: 35, resetsAt: new Date(RESET) },
            },
        });
    });

    it('adapts an Anthropic unified quota identified by id when kind is absent', async () => {
        const { ledgers, poller } = harness({ fetch: async () => ok(providerReport({ quota_after: {
            source:       'anthropic', collected_at: GENERATED,
            quotas:       [{ id: 'five_hour', used_percent: 42, unit: 'percent_0_100', resets_at: RESET }],
        } })) });

        poller.start();
        await poller.poll();

        expect(ledgers[0]?.dispatch).toHaveBeenCalledWith({
            type:  'quota_polled', at:    new Date(GENERATED),
            quota: { fiveHour: { utilization: 42, resetsAt: new Date(RESET) } },
        });
    });

    it('retains Anthropic history in SDK-only mode without dispatching its provider quota', async () => {
        const report = providerReport({ history: historyReport(), reference_prices: referencePrices() });
        const codex = {
            ...report.providers[0],
            provider:    'codex',
            quota_after: { ...report.providers[0].quota_after, source: 'codex' },
        };
        const { ledgers, poller } = harness({
            anthropicQuotaSource: 'sdk', fetch: async () => ok({ ...report, providers: [report.providers[0], codex] }),
        });

        poller.start();
        await poller.poll();

        expect(poller.getSnapshot?.()?.providers.map(provider => provider.provider)).toEqual(['anthropic', 'codex']);
        expect(poller.getSnapshot?.()?.providers[0]?.history?.recentTokens.totalTokens).toBe(1000);
        expect(ledgers[0]?.dispatch).not.toHaveBeenCalled();
    });

    it('does not call the direct Anthropic fallback when an SDK-only provider report fails', async () => {
        const { fetch, poller } = harness({
            anthropicQuotaSource: 'sdk', fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
        });

        poller.start();
        await poller.poll();

        expect(fetch).toHaveBeenCalledTimes(1);
        expect(poller.getSnapshot?.()).toBeUndefined();
    });

    it('does not call or advertise the direct fallback when an SDK-only provider report throws', async () => {
        const { fetch, logger, poller } = harness({
            anthropicQuotaSource: 'sdk', fetch: async () => { throw new TypeError('offline'); },
        });

        poller.start();
        await poller.poll();

        expect(fetch).toHaveBeenCalledTimes(1);
        expect(logger.debug).toHaveBeenCalledWith({ errorName: 'TypeError' }, 'Quota poll: utraque provider report failed');
        expect(logger.debug).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('direct Anthropic fallback'));
    });

    it('does not call the direct Anthropic fallback when an SDK-only provider report times out', async () => {
        const { clock, fetch, poller } = harness({
            anthropicQuotaSource: 'sdk',
            requestTimeoutMs:     1000,
            fetch:                (_url, init) => new Promise((_resolve, reject) => {
                init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            }),
        });

        poller.start();
        const attempt = poller.poll();
        clock.advance(1000);
        await attempt;

        expect(fetch).toHaveBeenCalledTimes(1);
        expect(poller.getSnapshot?.()).toBeUndefined();
    });

    it('performs no quota HTTP request in SDK-only direct-Claude mode', async () => {
        const { fetch, poller } = harness({ anthropicQuotaSource: 'sdk', preferProviderReport: false });

        poller.start();
        await poller.poll();

        expect(fetch).not.toHaveBeenCalled();
        expect(poller.getSnapshot?.()).toBeUndefined();
    });

    it('excludes surface-scoped, slotted, inactive, and already-reset Anthropic report quotas', async () => {
        const { ledgers, poller } = harness({ fetch: async () => ok(providerReport({ quota_after: {
            source:       'anthropic', collected_at: GENERATED,
            quotas:       [
                { id: 'five_hour', kind: 'five_hour', used_percent: 42, unit: 'percent_0_100' },
                { id: 'surface', kind: 'session', group: 'session', used_percent: 91, unit: 'percent_0_100', scope: { surface: { id: 'cli' } } },
                { id: 'model', kind: 'session', group: 'session', used_percent: 90, unit: 'percent_0_100', scope: { model: { id: 'opus' } } },
                { id: 'slot', kind: 'session', group: 'session', slot: 'secondary', used_percent: 92, unit: 'percent_0_100' },
                { id: 'inactive', kind: 'session', group: 'session', active: false, used_percent: 93, unit: 'percent_0_100' },
                { id: 'reset', kind: 'session', group: 'session', resets_at: GENERATED, used_percent: 94, unit: 'percent_0_100' },
            ],
        } })) });

        poller.start();
        await poller.poll();

        expect(ledgers[0]?.dispatch).toHaveBeenCalledTimes(1);
        expect(ledgers[0]?.dispatch).toHaveBeenCalledWith(expect.objectContaining({
            quota: { fiveHour: { utilization: 42 } },
        }));
    });

    it('accepts an unscoped provider quota identified only by its session group', async () => {
        const { ledgers, poller } = harness({ fetch: async () => ok(providerReport({ quota_after: {
            source:       'anthropic', collected_at: GENERATED,
            quotas:       [{ id: 'primary', group: 'session', used_percent: 37, unit: 'percent_0_100' }],
        } })) });
        poller.start();
        await poller.poll();
        expect(ledgers[0]?.dispatch).toHaveBeenCalledWith(expect.objectContaining({
            quota: { fiveHour: { utilization: 37 } },
        }));
        const event = ledgers.at(0)?.dispatch.mock.calls.at(0)?.at(0);
        expect(event?.type).toBe('quota_polled');
        if(event?.type === 'quota_polled' && event.quota.fiveHour) {
            expect(Object.hasOwn(event.quota.fiveHour, 'resetsAt')).toBe(false);
        }
    });

    it('selects Anthropic by provider name when another provider is listed first', async () => {
        const report = providerReport();
        const codex = {
            ...report.providers[0],
            provider:    'codex',
            quota_after: { ...report.providers[0].quota_after, source: 'codex' },
        };
        const { ledgers, poller } = harness({ fetch: async () => ok({ ...report, providers: [codex, report.providers[0]] }) });
        poller.start();
        await poller.poll();

        expect(ledgers[0]?.dispatch).toHaveBeenCalledWith(expect.objectContaining({
            quota: expect.objectContaining({ fiveHour: expect.objectContaining({ utilization: 31.5 }) }),
        }));
    });

    it('uses non-quota errors for status only, but refuses an errored quota source', async () => {
        const unrelated = harness({ fetch: async () => ok(providerReport({ errors: [{ section: 'models', code: 'partial' }] })) });
        unrelated.poller.start();
        await unrelated.poller.poll();
        expect(unrelated.ledgers[0]?.dispatch).toHaveBeenCalledTimes(1);

        const quotaError = harness({ fetch: async () => ok(providerReport({ errors: [{ section: 'quota_after', code: 'expired' }] })) });
        quotaError.poller.start();
        await quotaError.poller.poll();
        expect(quotaError.ledgers[0]?.dispatch).not.toHaveBeenCalled();
    });

    it('does not dispatch an observation whose source says it is unavailable', async () => {
        const { ledgers, poller } = harness({ fetch: async () => ok(providerReport({ quota_after: {
            ...providerReport().providers[0].quota_after,
            available: false,
        } })) });
        poller.start();
        await poller.poll();
        expect(ledgers[0]?.dispatch).not.toHaveBeenCalled();
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

    it('accumulates source age across repeated report failures', async () => {
        const clock = new FakeClock(Date.parse(GENERATED));
        const fetch = jest.fn<QuotaFetch>()
            .mockResolvedValueOnce(ok(providerReport({ source_freshness: { cached: true, stale: false, age_seconds: 12 } })))
            .mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
        const { poller } = harness({ clock, fetch });
        poller.start();
        await poller.poll();

        clock.advance(300_000);
        await poller.poll();
        expect(poller.getSnapshot?.()?.providers[0]?.freshness.ageSeconds).toBe(312);

        clock.advance(300_000);
        await poller.poll();
        expect(poller.getSnapshot?.()?.providers[0]?.freshness.ageSeconds).toBe(612);
    });

    it('does not send the bearer to the direct endpoint after a local-auth rejection', async () => {
        const { fetch, logger, poller } = harness({ fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
        poller.start();
        await poller.poll();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(logger.debug).toHaveBeenCalledWith({ status: 401 }, 'Quota poll: utraque provider report returned a non-OK status');
    });

    it('marks a prior direct reading stale when its next response is non-OK', async () => {
        const fetch = jest.fn<QuotaFetch>()
            .mockResolvedValueOnce(ok({ five_hour: { utilization: 42 } }))
            .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
        const { logger, poller } = harness({ fetch, preferProviderReport: false });
        poller.start();
        await poller.poll();
        await poller.poll();

        expect(poller.getSnapshot?.()?.anthropicFallback).toBeUndefined();
        expect(poller.getSnapshot?.()?.expiresAt?.getTime()).toBe(Date.parse(GENERATED));
        expect(logger.debug).toHaveBeenCalledWith({ status: 503 }, 'Quota poll: direct Anthropic fallback returned a non-OK status');
    });

    it('marks a prior direct reading stale when a successful response has no usable windows', async () => {
        const fetch = jest.fn<QuotaFetch>()
            .mockResolvedValueOnce(ok({ five_hour: { utilization: 42 } }))
            .mockResolvedValueOnce(ok({}));
        const { poller } = harness({ fetch, preferProviderReport: false });
        poller.start();
        await poller.poll();
        await poller.poll();

        expect(poller.getSnapshot?.()?.anthropicFallback).toBeUndefined();
        expect(poller.getSnapshot?.()?.expiresAt?.getTime()).toBe(Date.parse(GENERATED));
    });

    it('marks a prior report stale and logs when a later 200 response has an invalid schema', async () => {
        const fetch = jest.fn<QuotaFetch>()
            .mockResolvedValueOnce(ok(providerReport()))
            .mockResolvedValueOnce(ok({ schema_version: 2 }));
        const { logger, poller } = harness({ fetch });
        poller.start();
        await poller.poll();
        await poller.poll();

        expect(poller.getSnapshot?.()?.providers[0]?.freshness.stale).toBe(true);
        expect(logger.debug).toHaveBeenCalledWith('Quota poll: utraque provider report was not valid schema version 1');
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

    it.each([405, 500])('falls back after provider report status %d', async (status) => {
        const fetch = jest.fn<QuotaFetch>(async url => (url === DEFAULT_PROVIDER_REPORT_URL
            ? { ok: false, status, json: async () => ({}) }
            : ok({ five_hour: { utilization: 42 } })));
        const { poller } = harness({ fetch });
        poller.start();
        await poller.poll();
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fetch).toHaveBeenLastCalledWith(DEFAULT_ANTHROPIC_USAGE_URL, expect.any(Object));
    });

    it('warns once for invalid percentages while retaining valid fallback windows', async () => {
        const { logger, poller } = harness({
            preferProviderReport: false,
            fetch:                async () => ok({ five_hour: { utilization: 101 }, seven_day: { utilization: 42 } }),
        });
        poller.start();
        await poller.poll();
        await poller.poll();
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(
            { fallbackUrl: DEFAULT_ANTHROPIC_USAGE_URL },
            'Quota poll: direct Anthropic usage response contained an invalid percentage'
        );
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
        expect(line).toContain('"source": "direct_anthropic"');
        expect(line).toContain('"observed_at": "2026-09-11T20:01:01.000Z"');
        expect(line).toContain('"window": "5h"');
        expect(line).not.toContain('"window": "1w"');
    });

    it('expires reset-less direct headroom and renews it after an identical successful observation', async () => {
        const clock = new FakeClock(Date.parse(GENERATED));
        const fetch = jest.fn<QuotaFetch>(async () => ok({ five_hour: { utilization: 42 } }));
        const { poller } = harness({ clock, fetch, preferProviderReport: false, pollIntervalMs: 60_000 });
        poller.start();
        await poller.poll();
        poller.stop();
        clock.advance(120_001);

        const expired = poller.getSnapshot?.();
        expect(composeAmbientLines({ self: initialLedger('conversation'), now: new Date(clock.now()), timezone: 'UTC', providerSnapshot: expired })[0])
            .toContain('"status": "unknown"');

        poller.start();
        await poller.poll();
        const refreshed = poller.getSnapshot?.();
        expect(composeAmbientLines({ self: initialLedger('conversation'), now: new Date(clock.now()), timezone: 'UTC', providerSnapshot: refreshed })[0])
            .toContain('"source": "direct_anthropic"');
        expect(refreshed?.anthropicFallback?.expiresAt.getTime()).toBe(clock.now() + 120_000);
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

    it('clears the request timeout and completed controller after a successful attempt', async () => {
        let requestSignal: AbortSignal | undefined;
        const { clock, poller } = harness({ fetch: async (_url, init) => {
            requestSignal = init.signal;
            return ok(providerReport());
        } });
        poller.start();
        await poller.poll();

        expect(clock.pending()).toBe(1); // recurring poll only
        poller.stop();
        expect(requestSignal?.aborted).toBe(false);
        expect(clock.pending()).toBe(0);
    });

    it('marks providers stale when the report throws, then retains a successful direct fallback', async () => {
        const fetch = jest.fn<QuotaFetch>()
            .mockResolvedValueOnce(ok(providerReport()))
            .mockRejectedValueOnce(new TypeError('network down'))
            .mockResolvedValueOnce(ok({ five_hour: { utilization: 42 } }));
        const { logger, poller } = harness({ fetch });
        poller.start();
        await poller.poll();
        await poller.poll();

        expect(fetch).toHaveBeenCalledTimes(3);
        expect(poller.getSnapshot?.()?.providers[0]?.freshness.stale).toBe(true);
        expect(poller.getSnapshot?.()?.anthropicFallback?.windows.fiveHour?.utilization).toBe(42);
        expect(logger.debug).toHaveBeenCalledWith(
            { errorName: 'TypeError' },
            'Quota poll: utraque provider report failed; trying direct Anthropic fallback'
        );
    });

    it('labels a non-Error provider failure unknown and still enables fallback', async () => {
        const fetch = jest.fn<QuotaFetch>()
            .mockRejectedValueOnce('network down')
            .mockResolvedValueOnce(ok({ five_hour: { utilization: 42 } }));
        const { logger, poller } = harness({ fetch });
        poller.start();
        await poller.poll();

        expect(fetch).toHaveBeenCalledTimes(2);
        expect(logger.debug).toHaveBeenCalledWith(
            { errorName: 'unknown' },
            'Quota poll: utraque provider report failed; trying direct Anthropic fallback'
        );
    });

    it('marks a prior direct reading stale when the direct request throws', async () => {
        const fetch = jest.fn<QuotaFetch>()
            .mockResolvedValueOnce(ok({ five_hour: { utilization: 42 } }))
            .mockRejectedValueOnce('direct down');
        const { logger, poller } = harness({ fetch, preferProviderReport: false });
        poller.start();
        await poller.poll();
        await poller.poll();

        expect(poller.getSnapshot?.()?.anthropicFallback).toBeUndefined();
        expect(logger.debug).toHaveBeenCalledWith(
            { errorName: 'unknown' },
            'Quota poll failed; keeping the last known readings'
        );
    });

    it('does not publish an old response after stop and restart, and starts a new-generation poll', async () => {
        let releaseOld = (_response: QuotaFetchResponse): void => {};
        let releaseCurrent = (_response: QuotaFetchResponse): void => {};
        const oldGate = new Promise<QuotaFetchResponse>((resolve) => {
            releaseOld = resolve;
        });
        const currentGate = new Promise<QuotaFetchResponse>((resolve) => {
            releaseCurrent = resolve;
        });
        const fetch = jest.fn<QuotaFetch>()
            .mockImplementationOnce(async () => oldGate)
            .mockImplementationOnce(async () => currentGate);
        const { ledgers, poller } = harness({ fetch });
        poller.start();
        const attempt = poller.poll();
        poller.stop();
        poller.start();
        releaseOld(ok(providerReport()));
        await attempt;
        await Promise.resolve();

        expect(fetch).toHaveBeenCalledTimes(2);
        expect(ledgers[0]?.dispatch).not.toHaveBeenCalled();
        expect(poller.getSnapshot?.()).toBeUndefined();

        releaseCurrent(ok(providerReport({ quota_after: {
            source:       'anthropic', collected_at: GENERATED,
            quotas:       [{ id: 'session', kind: 'session', group: 'session', used_percent: 55, unit: 'percent_0_100' }],
        } })));
        await poller.poll();
        expect(ledgers[0]?.dispatch).toHaveBeenCalledTimes(1);
        expect(ledgers[0]?.dispatch).toHaveBeenCalledWith(expect.objectContaining({ quota: { fiveHour: { utilization: 55 } } }));
    });

    it('does not let an obsolete failed attempt stale the prior snapshot after restart', async () => {
        let releaseOld = (_response: QuotaFetchResponse): void => {};
        let releaseCurrent = (_response: QuotaFetchResponse): void => {};
        const oldGate = new Promise<QuotaFetchResponse>((resolve) => {
            releaseOld = resolve;
        });
        const currentGate = new Promise<QuotaFetchResponse>((resolve) => {
            releaseCurrent = resolve;
        });
        const fetch = jest.fn<QuotaFetch>()
            .mockResolvedValueOnce(ok(providerReport()))
            .mockImplementationOnce(async () => oldGate)
            .mockImplementationOnce(async () => currentGate);
        const { poller } = harness({ fetch });
        poller.start();
        await poller.poll();
        const attempt = poller.poll();
        poller.stop();
        poller.start();
        releaseOld({ ok: false, status: 500, json: async () => ({}) });
        await attempt;
        await Promise.resolve();

        expect(poller.getSnapshot?.()?.providers[0]?.freshness.stale).toBe(false);
        releaseCurrent(ok(providerReport()));
        await poller.poll();
    });

    it('does not publish an old direct-fallback response after stop and restart', async () => {
        let releaseOld = (_response: QuotaFetchResponse): void => {};
        let releaseCurrent = (_response: QuotaFetchResponse): void => {};
        const oldGate = new Promise<QuotaFetchResponse>((resolve) => {
            releaseOld = resolve;
        });
        const currentGate = new Promise<QuotaFetchResponse>((resolve) => {
            releaseCurrent = resolve;
        });
        const fetch = jest.fn<QuotaFetch>()
            .mockImplementationOnce(async () => oldGate)
            .mockImplementationOnce(async () => currentGate);
        const { ledgers, poller } = harness({ fetch, preferProviderReport: false });
        poller.start();
        const attempt = poller.poll();
        poller.stop();
        poller.start();
        releaseOld(ok({ five_hour: { utilization: 42 } }));
        await attempt;
        await Promise.resolve();

        expect(fetch).toHaveBeenCalledTimes(2);
        expect(ledgers[0]?.dispatch).not.toHaveBeenCalled();
        expect(poller.getSnapshot?.()).toBeUndefined();

        releaseCurrent(ok({ five_hour: { utilization: 55 } }));
        await poller.poll();

        expect(ledgers[0]?.dispatch).toHaveBeenCalledTimes(1);
        expect(ledgers[0]?.dispatch).toHaveBeenCalledWith(expect.objectContaining({ quota: { fiveHour: { utilization: 55 } } }));
        expect(poller.getSnapshot?.()?.anthropicFallback?.windows.fiveHour?.utilization).toBe(55);
    });

    it('starts idempotently and schedules only one recurring poll', async () => {
        let release = (_response: QuotaFetchResponse): void => {};
        const gate = new Promise<QuotaFetchResponse>((resolve) => {
            release = resolve;
        });
        const { clock, fetch, poller } = harness({ fetch: async () => gate });
        poller.start();
        poller.start();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(clock.pending()).toBe(2); // one recurrence and one request timeout
        release(ok(providerReport()));
        await poller.poll();
    });

    it('polls on a result only after the debounce boundary and never while stopped', async () => {
        const { clock, fetch, poller } = harness({ resultDebounceMs: 30_000 });
        poller.start();
        await poller.poll();
        clock.advance(29_999);
        poller.noteResult();
        expect(fetch).toHaveBeenCalledTimes(1);
        clock.advance(1);
        poller.noteResult();
        expect(fetch).toHaveBeenCalledTimes(2);
        await Promise.resolve();
        poller.stop();
        clock.advance(30_000);
        poller.noteResult();
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('keeps recurring polls scheduled after every interval', async () => {
        const { clock, fetch, poller } = harness();
        poller.start();
        await poller.poll();

        clock.advance(300_000);
        expect(fetch).toHaveBeenCalledTimes(2);
        await poller.poll();
        clock.advance(300_000);
        expect(fetch).toHaveBeenCalledTimes(3);
        await poller.poll();
    });

    it('does not queue a replacement poll when stopped before an in-flight attempt settles', async () => {
        let release = (_response: QuotaFetchResponse): void => {};
        const gate = new Promise<QuotaFetchResponse>((resolve) => {
            release = resolve;
        });
        const { fetch, poller } = harness({ fetch: async () => gate });
        poller.start();
        const attempt = poller.poll();
        poller.stop();
        poller.start();
        poller.stop();
        release(ok(providerReport()));
        await attempt;
        await Promise.resolve();
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});
