import { describe, expect, it, jest, type Mock } from 'bun:test';
import type { Logger } from '@hughescr/logger';
import { FakeClock } from '../../../helpers/fake-clock';
import { composeAmbientLines } from '@/agent/session/ambient-lines';
import { createLedgerStore, initialLedger, type LedgerEvent } from '@/agent/session/ledger';
import {
    DEFAULT_ANTHROPIC_USAGE_URL,
    DEFAULT_VENDOR_REPORT_URL,
    DEFAULT_QUOTA_REQUEST_TIMEOUT_MS,
    DEFAULT_QUOTA_RESULT_DEBOUNCE_MS,
    type CreateQuotaPollerParams,
    type QuotaFetch,
    type QuotaFetchResponse,
    createQuotaPoller,
    parseVendorSnapshot,
    parseUsageWindows
} from '@/agent/session/quota-poller';

const RESET = '2026-09-11T22:00:00Z';
const GENERATED = '2026-09-11T20:00:01Z';

function providerReport(overrides: Record<string, unknown> = {}) {
    return {
        schema_version: 2,
        generated_at:   GENERATED,
        providers:      [{
            provider:         'anthropic',
            status:           'ok',
            last_attempt:     GENERATED,
            source_freshness: { cached: false, stale: false, age_seconds: 0 },
            errors:           [],
            quota:            {
                collected_at: GENERATED,
                quotas:       [
                    { id: 'session', bucket: 'session', kind: 'session', group: 'session', used_percent: 31.5, unit: 'percent_0_100', duration_seconds: 18_000, resets_at: RESET },
                    { id: 'weekly_all', bucket: 'weekly_all', kind: 'weekly', group: 'weekly', used_percent: 35, unit: 'percent_0_100', duration_seconds: 604_800, resets_at: RESET },
                    { id: 'weekly_scoped:model=opus', bucket: 'weekly_scoped', kind: 'weekly_scoped', group: 'weekly', used_percent: 5, unit: 'percent_0_100', scope: { model: { id: 'opus', display_name: 'Opus' } } },
                ],
            },
            ...overrides,
        }],
    };
}

/** The live Codex `quota` section shape (schema 2): a slotted window, workspace credits and a reached-only spend limit. */
function codexQuota(overrides: Record<string, unknown> = {}) {
    return {
        collected_at: GENERATED,
        quotas:       [{
            id:               'codex:primary', bucket:           'codex', kind:             'session', slot:             'primary', used_percent:     17, unit:             'percent_0_100',
            duration_seconds: 604_800, resets_at:        RESET, plan:             { type: 'pro' },
        }],
        balances:     [{ kind: 'workspace_credits', limit_id: 'codex', amount_unit: 'credits', remaining: '0', available: false, unlimited: false }],
        spend_limits: [{ limit_id: 'codex', reached: false }],
        plan:         { type: 'pro' },
        ...overrides,
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
        collector:   'ccusage', coverage:    'local_only', cost_basis:  'calculated_api_reference_usd',
        started_at:  '2026-09-11T20:00:00Z', finished_at: GENERATED,
        seven_days:  {
            since:  '2026-09-05T00:00:00Z', until:  '2026-09-11T00:00:00Z',
            models: [{
                log_source:            'claude', model, provider,
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
        catalog:     'models.dev', observed_at: GENERATED, unit:        'usd_per_million_tokens', assumptions: ['base_tier', 'cache_write_5m'],
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
        expect(DEFAULT_VENDOR_REPORT_URL).toBe('http://127.0.0.1:8317/utraque/providers/v2');
        expect(DEFAULT_ANTHROPIC_USAGE_URL).toBe('https://api.anthropic.com/api/oauth/usage');
    });

    it('keeps the documented result debounce and request timeout defaults exact', () => {
        expect(DEFAULT_QUOTA_RESULT_DEBOUNCE_MS).toBe(30_000);
        expect(DEFAULT_QUOTA_REQUEST_TIMEOUT_MS).toBe(100_000);
    });

    it('preserves quota identifiers, scopes, durations, freshness and monetary balances', () => {
        const body = providerReport({
            source_freshness: { cached: true, stale: false, age_seconds: 12 },
            quota:            {
                collected_at: GENERATED,
                quotas:       [{ id: 'weekly_scoped:model=opus:surface=cli', bucket: 'weekly_scoped', kind: 'weekly_scoped', group: 'weekly', slot: 'secondary', used_percent: 5, unit: 'percent_0_100', duration_seconds: 604_800, scope: { model: { id: 'opus', display_name: 'Opus' }, surface: { id: 'cli' } } }],
                balances:     [{ kind: 'account_balance', currency: 'USD', amount_unit: 'currency', remaining: '9.35', parts: [{ name: 'topped_up', amount: '9.35' }] }],
                spend_limits: [{ limit_id: 'codex', reached: false }],
            },
        });

        const snapshot = parseVendorSnapshot(body);

        expect(snapshot?.providers[0]).toMatchObject({
            freshness: { cached: true, stale: false, ageSeconds: 12 },
            quota:     {
                quotas:      [{ id: 'weekly_scoped:model=opus:surface=cli', bucket: 'weekly_scoped', kind: 'weekly_scoped', group: 'weekly', slot: 'secondary', durationSeconds: 604_800, scope: { model: { id: 'opus', displayName: 'Opus' }, surface: { id: 'cli' } } }],
                balances:    [{ kind: 'account_balance', currency: 'USD', amountUnit: 'currency', remaining: '9.35' }],
                spendLimits: [{ limitId: 'codex', reached: false }],
            },
        });
    });

    it('parses the live Codex quota section: slotted window, workspace credits by limit id, and a reached-only spend limit', () => {
        const snapshot = parseVendorSnapshot(providerReport({ provider: 'codex', quota: codexQuota() }));

        expect(snapshot?.providers[0]?.quota).toEqual({
            collectedAt: new Date(GENERATED),
            available:   undefined,
            quotas:      [{
                id:              'codex:primary', bucket:          'codex', kind:            'session', slot:            'primary', usedPercent:     17,
                name:            undefined, group:           undefined, durationSeconds: 604_800, resetsAt:        new Date(RESET), active:          undefined, scope:           undefined,
            }],
            balances: [{
                kind: 'workspace_credits', limitId: 'codex', currency: undefined, amountUnit: 'credits', remaining: '0', available: false, unlimited: false,
            }],
            spendLimits: [{
                limitId:     'codex', reached:     false, enabled:     undefined, limit:       undefined, used:        undefined, amountUnit:  undefined,
                currency:    undefined, usedPercent: undefined, resetsAt:    undefined,
            }],
        });
    });

    it('parses a full Codex spend limit and an Anthropic extra-usage row that has no limit id', () => {
        const codex = parseVendorSnapshot(providerReport({ provider: 'codex', quota:    codexQuota({ spend_limits: [{
            limit_id: 'codex', limit: '50.00', used: '12.25', amount_unit: 'provider_units', used_percent: 24.5, unit: 'percent_0_100', resets_at: RESET, reached: false,
        }] }) }));
        const anthropic = parseVendorSnapshot(providerReport({ quota: { collected_at: GENERATED, spend_limits: [{
            enabled: true, limit: '100.00', used: '3.50', amount_unit: 'provider_units', currency: 'USD', used_percent: 3.5, unit: 'percent_0_100',
        }] } }));

        expect(codex?.providers[0]?.quota?.spendLimits).toEqual([{
            limitId:     'codex', enabled:     undefined, limit:       '50.00', used:        '12.25', amountUnit:  'provider_units', currency:    undefined,
            usedPercent: 24.5, resetsAt:    new Date(RESET), reached:     false,
        }]);
        expect(anthropic?.providers[0]?.quota?.spendLimits).toEqual([{
            limitId:     undefined, enabled:     true, limit:       '100.00', used:        '3.50', amountUnit:  'provider_units', currency:    'USD',
            usedPercent: 3.5, resetsAt:    undefined, reached:     undefined,
        }]);
    });

    it('keeps a spend limit row while dropping an unusable used_percent and non-object rows', () => {
        const snapshot = parseVendorSnapshot(providerReport({ quota: { collected_at: GENERATED, spend_limits: [
            { limit_id: 'fraction', used_percent: 0.5, unit: 'fraction_0_1' },
            { limit_id: 'unitless', used_percent: 50 },
            { limit_id: 'over', used_percent: 100.01, unit: 'percent_0_100' },
            { limit_id: 'negative', used_percent: -0.01, unit: 'percent_0_100' },
            { limit_id: 'full', used_percent: 100, unit: 'percent_0_100' },
            { limit_id: 'empty', used_percent: 0, unit: 'percent_0_100' },
            null, 'reached', 42,
        ] } }));

        expect(snapshot?.providers[0]?.quota?.spendLimits.map(limit => [limit.limitId, limit.usedPercent])).toEqual([
            ['fraction', undefined], ['unitless', undefined], ['over', undefined], ['negative', undefined], ['full', 100], ['empty', 0],
        ]);
    });

    it('drops a quota row that lacks a bucket or carries a kind outside the closed vocabulary', () => {
        const snapshot = parseVendorSnapshot(providerReport({ quota: { collected_at: GENERATED, quotas:       [
            { id: 'no-bucket', kind: 'session', used_percent: 1, unit: 'percent_0_100' },
            { id: 'empty-bucket', bucket: '', kind: 'session', used_percent: 2, unit: 'percent_0_100' },
            { id: 'no-kind', bucket: 'five_hour', used_percent: 3, unit: 'percent_0_100' },
            { id: 'v1-kind', bucket: 'weekly_all', kind: 'weekly_all', used_percent: 4, unit: 'percent_0_100' },
            { id: 'spend-control', bucket: 'codex', kind: 'spend_control', used_percent: 5, unit: 'percent_0_100' },
            { id: 'other', bucket: 'cinder_cove', kind: 'other', used_percent: 6, unit: 'percent_0_100' },
            { id: 'scoped', bucket: 'weekly_scoped', kind: 'weekly_scoped', used_percent: 7, unit: 'percent_0_100' },
        ] } }));

        expect(snapshot?.providers[0]?.quota?.quotas.map(quota => [quota.id, quota.bucket, quota.kind])).toEqual([
            ['other', 'cinder_cove', 'other'], ['scoped', 'weekly_scoped', 'weekly_scoped'],
        ]);
    });

    it('takes a quota display name from its own field rather than borrowing the identifier', () => {
        const body = providerReport({ quota: {
            collected_at: GENERATED,
            quotas:       [{ id: 'session', bucket: 'session', kind: 'session', group: 'session', used_percent: 31.5, unit: 'percent_0_100', name: 'Claude session' }],
        } });

        expect(parseVendorSnapshot(body)?.providers[0]?.quota?.quotas[0]).toMatchObject({
            id:   'session',
            name: 'Claude session',
        });
    });

    it('parses compact history inputs and models.dev reference prices from the report contract', () => {
        const snapshot = parseVendorSnapshot(providerReport({
            history: historyReport(), reference_prices: referencePrices(),
        }));

        expect(snapshot?.providers[0]?.history).toMatchObject({
            collector:    'ccusage', coverage:     'local_only', costBasis:    'calculated_api_reference_usd', recentDays:   7,
            recentTokens: { inputTokens: 100, outputTokens: 200, cacheCreationTokens: 300, cacheReadTokens: 400, totalTokens: 1000 },
            recentModels: [{ model: 'claude-sonnet-5', costUsd: 0.003 }],
            blocks:       [{ active: true, gap: false, mixedVendor: false, costUsd: 0.0003, modelVendors: ['anthropic'] }],
        });
        expect(snapshot?.providers[0]?.prices).toEqual({
            catalog:     'models.dev', observedAt:  new Date(GENERATED), stale:       false, unit:        'usd_per_million_tokens',
            assumptions: ['base_tier', 'cache_write_5m'],
            models:      [{ model: 'claude-haiku-4-5-20251001', input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, eligible: true }],
        });
    });

    it('preserves source order across history models, block identities, blocks, and reference prices', () => {
        const history = historyReport();
        history.seven_days.models.push({
            ...history.seven_days.models[0], model: 'claude-opus-5', input_tokens: 101, total_tokens: 1001,
        });
        history.blocks[0].mixed_provider = true;
        history.blocks[0].models.push({ model: 'claude-opus-5', provider: 'codex' });
        history.blocks.push({
            ...history.blocks[0],
            id:         'next',
            start_time: '2026-09-11T18:00:00Z',
            models:     [{ model: 'claude-haiku-5', provider: 'anthropic' }],
        });
        const prices = referencePrices();
        prices.models.push({ ...prices.models[0], model: 'claude-opus-5', input: 2 });

        const parsed = parseVendorSnapshot(providerReport({ history, reference_prices: prices }))?.providers[0];

        expect(parsed?.history?.recentModels.map(model => model.model)).toEqual(['claude-sonnet-5', 'claude-opus-5']);
        expect(parsed?.history?.blocks.map(block => block.modelNames)).toEqual([
            ['claude-sonnet-5', 'claude-opus-5'],
            ['claude-haiku-5'],
        ]);
        expect(parsed?.history?.blocks[0]?.modelVendors).toEqual(['anthropic', 'codex']);
        expect(parsed?.prices?.models.map(model => model.model)).toEqual(['claude-haiku-4-5-20251001', 'claude-opus-5']);
    });

    it('reports zero recent tokens for empty and Spark-only Codex history', () => {
        const empty = historyReport('codex');
        empty.seven_days.models = [];
        const sparkOnly = historyReport('codex');
        sparkOnly.seven_days.models[0].model = 'gpt-5.3-codex-spark';
        const parse = (history: ReturnType<typeof historyReport>) => parseVendorSnapshot(providerReport({
            provider: 'codex', quota: { collected_at: GENERATED }, history,
        }))?.providers[0]?.history;

        expect(parse(empty)?.recentTokens.totalTokens).toBe(0);
        expect(parse(sparkOnly)?.recentTokens.totalTokens).toBe(0);
    });

    it('accepts zero-valued history usage and cost while preserving exact block model identities', () => {
        const history = historyReport();
        Object.assign(history.seven_days.models[0], {
            input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, total_tokens: 0, cost_usd: 0,
        });
        Object.assign(history.blocks[0], {
            input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, total_tokens: 0, cost_usd: 0,
        });

        expect(parseVendorSnapshot(providerReport({ history }))?.providers[0]?.history).toEqual({
            collector:    'ccusage',
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
                startTime:    new Date('2026-09-11T17:00:00Z'),
                endTime:      new Date(RESET),
                active:       true,
                gap:          false,
                mixedVendor:  false,
                modelNames:   ['claude-sonnet-5'],
                modelVendors: ['anthropic'],
                tokens:       { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0 },
                costUsd:      0,
            }],
        });
    });

    it('drops malformed history and reference prices without rejecting live quota', () => {
        const snapshot = parseVendorSnapshot(providerReport({
            history:          { ...historyReport(), seven_days: { ...historyReport().seven_days, until: '2026-09-10T00:00:00Z' } },
            reference_prices: { ...referencePrices(), models: [{ model: 'claude-haiku', input: 0, output: 5, eligible: true }] },
        }));

        expect(snapshot?.providers[0]?.quota).toBeDefined();
        expect(snapshot?.providers[0]?.history).toBeUndefined();
        expect(snapshot?.providers[0]?.prices).toBeUndefined();
    });

    it('requires trusted local API-reference history and internally consistent token totals', () => {
        const wrongCoverage = parseVendorSnapshot(providerReport({
            history: { ...historyReport(), coverage: 'remote' },
        }));
        const wrongTotal = historyReport();
        wrongTotal.seven_days.models[0].total_tokens = 999;
        const mismatched = parseVendorSnapshot(providerReport({ history: wrongTotal }));

        expect(wrongCoverage?.providers[0]?.history).toBeUndefined();
        expect(mismatched?.providers[0]?.history).toBeUndefined();
    });

    it('rejects a negative history token count even when the reported total matches', () => {
        const history = historyReport();
        history.seven_days.models[0].input_tokens = -1;
        history.seven_days.models[0].total_tokens = 899;

        expect(parseVendorSnapshot(providerReport({ history }))?.providers[0]?.history).toBeUndefined();
    });

    it('filters Spark from Codex history aggregates without dropping current Codex history', () => {
        const current = historyReport('codex').seven_days.models[0];
        const spark = { ...current, model: 'GPT-5.3-Codex-Spark', input_tokens: 1, total_tokens: 901 };
        const sparkId = { ...current, model: 'CODEX_BENGALFOX', input_tokens: 1, total_tokens: 901 };
        const rawHistory = historyReport('codex');
        rawHistory.seven_days.models = [spark, sparkId, current];
        const snapshot = parseVendorSnapshot(providerReport({
            provider: 'codex',
            quota:    { collected_at: GENERATED },
            history:  rawHistory,
        }));

        expect(snapshot?.providers[0]?.history?.recentTokens).toEqual({
            inputTokens: 100, outputTokens: 200, cacheCreationTokens: 300, cacheReadTokens: 400, totalTokens: 1000,
        });
        expect(snapshot?.providers[0]?.history?.recentModels.map(model => model.model)).toEqual(['gpt-5.6-luna']);
    });

    it('retains a Spark-named history sample when it belongs to another provider', () => {
        const history = historyReport();
        history.seven_days.models[0].model = 'GPT-5.3-Codex-Spark';

        expect(parseVendorSnapshot(providerReport({ history }))?.providers[0]?.history?.recentModels.map(model => model.model))
            .toEqual(['GPT-5.3-Codex-Spark']);
    });

    it('requires a cost status and rejects negative available costs', () => {
        const missingStatus = historyReport();
        delete (missingStatus.seven_days.models[0] as { cost_status?: string }).cost_status;
        const negativeCost = historyReport();
        negativeCost.seven_days.models[0].cost_usd = -0.001;

        expect(parseVendorSnapshot(providerReport({ history: missingStatus }))?.providers[0]?.history).toBeUndefined();
        expect(parseVendorSnapshot(providerReport({ history: negativeCost }))?.providers[0]?.history).toBeUndefined();
    });

    it.each([
        ['a numeric', 1],
        ['an empty', ''],
    ])('rejects %s cost status without admitting the sample', (_description, costStatus) => {
        const history = historyReport();
        const model: Record<string, unknown> = { ...history.seven_days.models[0], cost_status: costStatus };
        history.seven_days.models = [model as typeof history.seven_days.models[number]];

        expect(parseVendorSnapshot(providerReport({ history }))?.providers[0]?.history).toBeUndefined();
    });

    it('accepts an unavailable cost status without inventing a cost sample', () => {
        const history = historyReport();
        const model: Record<string, unknown> = { ...history.seven_days.models[0], cost_status: 'unavailable' };
        delete model.cost_usd;
        history.seven_days.models = [model as typeof history.seven_days.models[number]];

        const parsed = parseVendorSnapshot(providerReport({ history }))?.providers[0]?.history?.recentModels[0];
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

        expect(parseVendorSnapshot(providerReport({ history }))?.providers[0]?.history).toBeUndefined();
    });

    it.each([
        ['an empty block', '2026-09-11T17:00:00Z', '2026-09-11T17:00:00Z'],
        ['a reversed block', RESET, '2026-09-11T17:00:00Z'],
    ])('rejects %s time interval', (_description, startTime, endTime) => {
        const history = historyReport();
        history.blocks[0].start_time = startTime;
        history.blocks[0].end_time = endTime;

        expect(parseVendorSnapshot(providerReport({ history }))?.providers[0]?.history).toBeUndefined();
    });

    it('rejects reversed collection times and histories completed after report generation', () => {
        const reversed = historyReport();
        reversed.started_at = '2026-09-11T20:00:02Z';
        const future = historyReport();
        future.finished_at = '2026-09-11T20:00:02Z';

        expect(parseVendorSnapshot(providerReport({ history: reversed }))?.providers[0]?.history).toBeUndefined();
        expect(parseVendorSnapshot(providerReport({ history: future }))?.providers[0]?.history).toBeUndefined();
    });

    it('parses stale price provenance and rejects malformed optional price fields', () => {
        const stale = parseVendorSnapshot(providerReport({
            reference_prices: { ...referencePrices(), stale: true },
        }));
        const malformed = parseVendorSnapshot(providerReport({
            reference_prices: { ...referencePrices(), stale: 'yes' },
        }));

        expect(stale?.providers[0]?.prices?.stale).toBe(true);
        expect(malformed?.providers[0]?.prices).toBeUndefined();
    });

    it('rejects reference prices expressed in the wrong unit', () => {
        const prices = { ...referencePrices(), unit: 'usd_per_token' };

        expect(parseVendorSnapshot(providerReport({ reference_prices: prices }))?.providers[0]?.prices).toBeUndefined();
    });

    it('accepts omitted cache prices without manufacturing values', () => {
        const prices = referencePrices();
        delete (prices.models[0] as { cache_read?: number }).cache_read;
        delete (prices.models[0] as { cache_write?: number }).cache_write;

        const parsed = parseVendorSnapshot(providerReport({ reference_prices: prices }))?.providers[0]?.prices?.models[0];
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

        expect(parseVendorSnapshot(providerReport({ reference_prices: prices }))?.providers[0]?.prices).toBeUndefined();
    });

    it('rejects future observations and a missing reference-price sample list', () => {
        const future = { ...referencePrices(), observed_at: '2026-09-11T20:00:02Z' };
        const missingModels = { ...referencePrices(), models: undefined };

        expect(parseVendorSnapshot(providerReport({ reference_prices: future }))?.providers[0]?.prices).toBeUndefined();
        expect(parseVendorSnapshot(providerReport({ reference_prices: missingModels }))?.providers[0]?.prices).toBeUndefined();
    });

    it('rejects schema 1 and every other schema version, and refuses a future or negative-age reading', () => {
        expect(parseVendorSnapshot({ ...providerReport(), schema_version: 1 })).toBeUndefined();
        expect(parseVendorSnapshot({ ...providerReport(), schema_version: 3 })).toBeUndefined();
        expect(parseVendorSnapshot({ ...providerReport(), schema_version: '2' })).toBeUndefined();
        expect(parseVendorSnapshot(providerReport({ source_freshness: { cached: false, stale: false, age_seconds: -1 } }))).toBeUndefined();
        expect(parseVendorSnapshot(providerReport({ last_attempt: '2026-09-11T20:00:02Z' }))).toBeUndefined();
        expect(parseVendorSnapshot(providerReport({ quota: { collected_at: '2026-09-11T20:00:02Z' } }))?.providers[0]?.quota).toBeUndefined();
    });

    it('accepts an observation without a source field and keeps its reading under whichever provider carries it', () => {
        const snapshot = parseVendorSnapshot(providerReport({ provider: 'codex', quota: { collected_at: GENERATED } }));
        expect(snapshot?.providers[0]?.quota).toMatchObject({ collectedAt: new Date(GENERATED), quotas: [], balances: [], spendLimits: [] });
    });

    it('rejects empty or non-string required provider fields', () => {
        expect(parseVendorSnapshot(providerReport({ provider: '' }))).toBeUndefined();
        expect(parseVendorSnapshot(providerReport({ provider: 42 }))).toBeUndefined();
        expect(parseVendorSnapshot(providerReport({ status: '' }))).toBeUndefined();
        expect(parseVendorSnapshot(providerReport({ quota: { collected_at: '' } }))?.providers[0]?.quota).toBeUndefined();
        expect(parseVendorSnapshot(providerReport({ quota: [] }))?.providers[0]?.quota).toBeUndefined();
    });

    it('accepts one-character required strings and requires both freshness flags', () => {
        const oneCharacter = providerReport({
            provider: 'p',
            status:   'o',
            quota:    { collected_at: GENERATED, quotas:       [
                { id: 'x', bucket: 'b', kind: 'other', used_percent: 1, unit: 'percent_0_100' },
            ] },
        });
        expect(parseVendorSnapshot(oneCharacter)?.providers[0]?.quota?.quotas[0]).toMatchObject({ id: 'x', bucket: 'b', kind: 'other' });
        expect(parseVendorSnapshot(providerReport({ source_freshness: { stale: false, age_seconds: 0 } }))).toBeUndefined();
        expect(parseVendorSnapshot(providerReport({ source_freshness: { cached: false, age_seconds: 0 } }))).toBeUndefined();
    });

    it('rejects report-shaped arrays and callable values at the unknown input boundary', () => {
        expect(parseVendorSnapshot(null)).toBeUndefined();
        expect(parseVendorSnapshot(Object.assign([], providerReport()))).toBeUndefined();
        expect(parseVendorSnapshot(Object.assign(() => undefined, providerReport()))).toBeUndefined();
    });

    it('preserves display-name-only scopes, omits an absent scope, and validates error entries independently', () => {
        const snapshot = parseVendorSnapshot(providerReport({
            errors: [{ section: 'quota', code: 'expired' }, { section: '', code: 'ignored' }, null],
            quota:  {
                collected_at: GENERATED,
                quotas:       [
                    { id: 'named-scope', bucket: 'weekly_scoped', kind: 'weekly_scoped', used_percent: 5, unit: 'percent_0_100', scope: { model: { display_name: 'Named model' } } },
                    { id: 'unscoped', bucket: 'weekly_all', kind: 'weekly', used_percent: 6, unit: 'percent_0_100' },
                ],
            },
        }));

        expect(snapshot?.providers[0]?.errors).toEqual([{ section: 'quota', code: 'expired' }]);
        expect(snapshot?.providers[0]?.quota?.quotas[0]?.scope).toEqual({ model: { displayName: 'Named model' } });
        expect(snapshot?.providers[0]?.quota?.quotas[1]?.scope).toBeUndefined();
    });

    it('preserves an optional quota API retry timestamp after a rate-limited lookup', () => {
        const retryAt = '2026-09-11T20:05:00Z';
        const snapshot = parseVendorSnapshot(providerReport({
            status: 'partial',
            errors: [{ section: 'quota', code: 'rate_limited', retry_at: retryAt }],
        }));

        expect(snapshot?.providers[0]?.errors).toEqual([
            { section: 'quota', code: 'rate_limited', retryAt: new Date(retryAt) },
        ]);
    });

    it('preserves the real upstream attempt time on a quota error, even one predating the collection', () => {
        const attemptedAt = '2026-09-11T19:58:00Z';
        const snapshot = parseVendorSnapshot(providerReport({
            status: 'partial',
            errors: [
                { section: 'quota', code: 'rate_limited', retryable: true, retry_at: '2026-09-11T20:05:00Z', attempted_at: attemptedAt, message: 'provider reading unavailable' },
                { section: 'history', code: 'timeout', retryable: true, message: 'local usage history unavailable' },
                { section: 'quota', code: 'unavailable', attempted_at: 'not-a-date' },
            ],
        }));

        expect(snapshot?.providers[0]?.errors).toEqual([
            { section: 'quota', code: 'rate_limited', retryAt: new Date('2026-09-11T20:05:00Z'), attemptedAt: new Date(attemptedAt) },
            { section: 'history', code: 'timeout', retryAt: undefined, attemptedAt: undefined },
            { section: 'quota', code: 'unavailable', retryAt: undefined, attemptedAt: undefined },
        ]);
    });

    it('leaves retry metadata undefined when the report has no valid retry timestamp', () => {
        const snapshot = parseVendorSnapshot(providerReport({
            errors: [{ section: 'quota', code: 'timed_out' }, { section: 'quota', code: 'rate_limited', retry_at: 'invalid' }],
        }));
        expect(snapshot?.providers[0]?.errors.map(error => error.retryAt)).toEqual([undefined, undefined]);
    });

    it('accepts inclusive percentage boundaries and drops out-of-range or wrongly-unitized quotas', () => {
        const snapshot = parseVendorSnapshot(providerReport({ quota: {
            collected_at: GENERATED,
            quotas:       [
                { id: 'empty', bucket: 'five_hour', kind: 'session', used_percent: 0, unit: 'percent_0_100' },
                { id: 'full', bucket: 'five_hour', kind: 'session', used_percent: 100, unit: 'percent_0_100' },
                { id: 'negative', bucket: 'five_hour', kind: 'session', used_percent: -0.01, unit: 'percent_0_100' },
                { id: 'over', bucket: 'five_hour', kind: 'session', used_percent: 100.01, unit: 'percent_0_100' },
                { id: 'fraction', bucket: 'five_hour', kind: 'session', used_percent: 0.5, unit: 'fraction_0_1' },
            ],
        } }));

        expect(snapshot?.providers[0]?.quota?.quotas.map(quota => [quota.id, quota.usedPercent])).toEqual([
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

    it('ignores a kind-less limit outside the session group while retaining the documented kind-less session mapping', () => {
        expect(parseUsageWindows({ limits: [
            { group: 'weekly', percent: 91 },
            { group: 'session', percent: 17 },
        ] })).toEqual({
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

    it('rejects an explicit null legacy utilization', () => {
        expect(parseUsageWindows({ five_hour: { utilization: null } })).toEqual({ windows: undefined, rejected: true });
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

    it('ignores an invalid percentage on a kind that merely shares the seven_day prefix', () => {
        // 'seven_days' is not a unified window (only 'seven_day' and 'seven_day_<model>' are), so
        // its percentage must be skipped outright rather than validated and flagged as rejected.
        expect(parseUsageWindows({ limits: [{ kind: 'seven_days', percent: 101 }] })).toEqual({
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

        expect(fetch).toHaveBeenCalledWith(DEFAULT_VENDOR_REPORT_URL, { headers: {}, signal: expect.any(AbortSignal) });
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

    it('adapts a legacy Anthropic five_hour bucket by its bucket name', async () => {
        const { ledgers, poller } = harness({ fetch: async () => ok(providerReport({ quota: {
            collected_at: GENERATED,
            quotas:       [{ id: 'five_hour', bucket: 'five_hour', kind: 'session', used_percent: 42, unit: 'percent_0_100', resets_at: RESET }],
        } })) });

        poller.start();
        await poller.poll();

        expect(ledgers[0]?.dispatch).toHaveBeenCalledWith({
            type:  'quota_polled', at:    new Date(GENERATED),
            quota: { fiveHour: { utilization: 42, resetsAt: new Date(RESET) } },
        });
    });

    it('adapts by the upstream bucket rather than the derived id or the closed kind', async () => {
        const { ledgers, poller } = harness({ fetch: async () => ok(providerReport({ quota: {
            collected_at: GENERATED,
            quotas:       [{ id: 'custom:id', bucket: 'session', kind: 'other', used_percent: 42, unit: 'percent_0_100' }],
        } })) });

        poller.start();
        await poller.poll();

        expect(ledgers[0]?.dispatch).toHaveBeenCalledWith({
            type:  'quota_polled', at:    new Date(GENERATED),
            quota: { fiveHour: { utilization: 42 } },
        });
    });

    it('retains Anthropic history in SDK-only mode without dispatching its provider quota', async () => {
        const report = providerReport({ history: historyReport(), reference_prices: referencePrices() });
        const codex = {
            ...report.providers[0],
            provider: 'codex',
            quota:    { ...report.providers[0].quota },
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
        const { fetch, poller } = harness({ anthropicQuotaSource: 'sdk', preferVendorReport: false });

        poller.start();
        await poller.poll();

        expect(fetch).not.toHaveBeenCalled();
        expect(poller.getSnapshot?.()).toBeUndefined();
    });

    it('excludes surface-scoped, slotted, inactive, and already-reset Anthropic report quotas', async () => {
        const { ledgers, poller } = harness({ fetch: async () => ok(providerReport({ quota: {
            collected_at: GENERATED,
            quotas:       [
                { id: 'five_hour', bucket: 'five_hour', kind: 'session', used_percent: 42, unit: 'percent_0_100' },
                { id: 'surface', bucket: 'session', kind: 'session', group: 'session', used_percent: 91, unit: 'percent_0_100', scope: { surface: { id: 'cli' } } },
                { id: 'model', bucket: 'session', kind: 'session', group: 'session', used_percent: 90, unit: 'percent_0_100', scope: { model: { id: 'opus' } } },
                { id: 'slot', bucket: 'session', kind: 'session', group: 'session', slot: 'secondary', used_percent: 92, unit: 'percent_0_100' },
                { id: 'inactive', bucket: 'session', kind: 'session', group: 'session', active: false, used_percent: 93, unit: 'percent_0_100' },
                { id: 'reset', bucket: 'session', kind: 'session', group: 'session', resets_at: GENERATED, used_percent: 94, unit: 'percent_0_100' },
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
        const { ledgers, poller } = harness({ fetch: async () => ok(providerReport({ quota: {
            collected_at: GENERATED,
            quotas:       [{ id: 'primary', bucket: 'primary', kind: 'other', group: 'session', used_percent: 37, unit: 'percent_0_100' }],
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
        // The codex entry's quota has no windows, so it must be skipped rather than matched by
        // position: if the provider lookup ever regressed to "take the first entry", this would
        // dispatch nothing at all instead of the real Anthropic windows below.
        const codex = {
            ...report.providers[0],
            provider: 'codex',
            quota:    { collected_at: GENERATED },
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

        const quotaError = harness({ fetch: async () => ok(providerReport({ errors: [{ section: 'quota', code: 'expired' }] })) });
        quotaError.poller.start();
        await quotaError.poller.poll();
        expect(quotaError.ledgers[0]?.dispatch).not.toHaveBeenCalled();
    });

    it('does not dispatch an observation whose source says it is unavailable', async () => {
        const { ledgers, poller } = harness({ fetch: async () => ok(providerReport({ quota: {
            ...providerReport().providers[0].quota,
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

    it('clamps stale age at zero when the clock moves behind the retained report', async () => {
        const clock = new FakeClock(Date.parse(GENERATED));
        const fetch = jest.fn<QuotaFetch>()
            .mockResolvedValueOnce(ok(providerReport({ source_freshness: { cached: true, stale: false, age_seconds: 12 } })))
            .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });
        const { poller } = harness({ clock, fetch });
        poller.start();
        await poller.poll();
        clock.advance(-1000);
        await poller.poll();

        expect(poller.getSnapshot?.()?.providers[0]?.freshness.ageSeconds).toBe(12);
    });

    it('retains the latest successful report and its previous provenance when a later poll fails', async () => {
        const first = providerReport({ status: 'first' });
        const second = { ...providerReport({ status: 'second' }), generated_at: '2026-09-11T20:00:02Z' };
        second.providers[0].last_attempt = '2026-09-11T20:00:02Z';
        second.providers[0].quota.collected_at = '2026-09-11T20:00:02Z';
        const fetch = jest.fn<QuotaFetch>()
            .mockResolvedValueOnce(ok(first))
            .mockResolvedValueOnce(ok(second))
            .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });
        const { poller } = harness({ fetch });
        poller.start();
        await poller.poll();
        await poller.poll();
        await poller.poll();

        const snapshot = poller.getSnapshot?.();
        expect(snapshot?.providers[0]?.status).toBe('second');
        expect(snapshot?.previous?.providers[0]?.status).toBe('first');
        expect(snapshot?.previous?.generatedAt).toEqual(new Date(GENERATED));
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
        const { logger, poller } = harness({ fetch, preferVendorReport: false });
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
        const { poller } = harness({ fetch, preferVendorReport: false });
        poller.start();
        await poller.poll();
        await poller.poll();

        expect(poller.getSnapshot?.()?.anthropicFallback).toBeUndefined();
        expect(poller.getSnapshot?.()?.expiresAt?.getTime()).toBe(Date.parse(GENERATED));
    });

    it.each([
        ['a schema 1 body', { ...providerReport(), schema_version: 1 }],
        ['a schema 2 body without providers', { schema_version: 2, generated_at: GENERATED }],
    ] as const)('marks a prior report stale and logs when a later 200 response is %s', async (_case, body) => {
        const fetch = jest.fn<QuotaFetch>()
            .mockResolvedValueOnce(ok(providerReport()))
            .mockResolvedValueOnce(ok(body));
        const { logger, poller } = harness({ fetch });
        poller.start();
        await poller.poll();
        await poller.poll();

        expect(poller.getSnapshot?.()?.providers[0]?.freshness.stale).toBe(true);
        expect(logger.debug).toHaveBeenCalledWith('Quota poll: utraque provider report was not valid schema version 2');
    });

    it('falls back after a missing report route and uses separate official OAuth headers', async () => {
        const fetch = jest.fn<QuotaFetch>(async url => (url === DEFAULT_VENDOR_REPORT_URL
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
        const fetch = jest.fn<QuotaFetch>(async url => (url === DEFAULT_VENDOR_REPORT_URL
            ? { ok: false, status, json: async () => ({}) }
            : ok({ five_hour: { utilization: 42 } })));
        const { poller } = harness({ fetch });
        poller.start();
        await poller.poll();
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fetch).toHaveBeenLastCalledWith(DEFAULT_ANTHROPIC_USAGE_URL, expect.any(Object));
    });

    it('does not use the direct fallback for HTTP 499', async () => {
        const { fetch, poller } = harness({ fetch: async () => ({ ok: false, status: 499, json: async () => ({}) }) });
        poller.start();
        await poller.poll();
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('keeps a fallback poll pending and its timeout armed until the fallback settles', async () => {
        let releaseFallback = (_response: QuotaFetchResponse): void => {};
        let announceFallback = (): void => {};
        const fallbackStarted = new Promise<void>((resolve) => {
            announceFallback = resolve;
        });
        const fallbackGate = new Promise<QuotaFetchResponse>((resolve) => {
            releaseFallback = resolve;
        });
        const fetch = jest.fn<QuotaFetch>(async (url) => {
            if(url === DEFAULT_VENDOR_REPORT_URL) {
                return { ok: false, status: 404, json: async () => ({}) };
            }
            announceFallback();
            return fallbackGate;
        });
        const { clock, poller } = harness({ fetch });
        poller.start();
        const attempt = poller.poll();
        let settled = false;
        void attempt.then(() => {
            settled = true;
            return undefined;
        });
        await fallbackStarted;
        await Promise.resolve();

        expect(settled).toBe(false);
        expect(clock.pending()).toBe(2); // recurrence and the request timeout remain live
        expect(poller.poll()).toBe(attempt);

        releaseFallback(ok({ five_hour: { utilization: 42 } }));
        await attempt;
        expect(clock.pending()).toBe(1);
    });

    it('warns once for invalid percentages while retaining valid fallback windows', async () => {
        const { logger, poller } = harness({
            preferVendorReport: false,
            fetch:              async () => ok({ five_hour: { utilization: 101 }, seven_day: { utilization: 42 } }),
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
        const poller = createQuotaPoller({ clock, fetch, ledgers: [ledger], logger, preferVendorReport: false });
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
        const { poller } = harness({ clock, fetch, preferVendorReport: false, pollIntervalMs: 60_000 });
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

    it('aborts at the default injected-clock deadline', async () => {
        const { clock, logger, poller } = harness({
            fetch: (_url, init) => new Promise((_resolve, reject) => {
                init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            }),
        });
        poller.start();
        const attempt = poller.poll();
        clock.advance(99_999);
        expect(logger.debug).not.toHaveBeenCalled();
        clock.advance(1);
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
        const { logger, poller } = harness({ fetch, preferVendorReport: false });
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

        releaseCurrent(ok(providerReport({ quota: {
            collected_at: GENERATED,
            quotas:       [{ id: 'session', bucket: 'session', kind: 'session', group: 'session', used_percent: 55, unit: 'percent_0_100' }],
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
        const { ledgers, poller } = harness({ fetch, preferVendorReport: false });
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
        const { clock, fetch, poller } = harness();
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
