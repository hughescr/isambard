import { describe, expect, it } from 'bun:test';
import { composeAmbientLines } from '@/agent/session/ambient-lines';
import { initialLedger, type QuotaWindows } from '@/agent/session/ledger';
import type {
    ProviderBalance,
    ProviderHistory,
    ProviderObservation,
    ProviderQuota,
    ProviderReferencePrices,
    ProviderSnapshot,
    ProviderStatus,
    ProviderTokenMix
} from '@/agent/session/quota-poller';

const TIMEZONE = 'America/Los_Angeles';
const NOW = new Date('2026-09-09T22:07:00Z');
const THU_0900 = new Date('2026-09-10T17:00:00Z');
const ESTIMATE_RESET = new Date('2026-09-10T01:07:00Z');

type JsonValue = boolean | number | string | null | JsonObject | JsonValue[];
interface JsonObject { [key: string]: JsonValue | undefined }

function observation(overrides: Partial<ProviderObservation> = {}): ProviderObservation {
    return { source: 'codex', collectedAt: NOW, available: true, quotas: [], balances: [], spendControls: [], ...overrides };
}

function provider(overrides: Partial<ProviderStatus> = {}): ProviderStatus {
    return {
        provider:    'codex', status:      'ok', lastAttempt: NOW,
        freshness:   { cached: false, stale: false, ageSeconds: 0 }, errors:      [], quotaAfter:  observation(), ...overrides,
    };
}

function snapshot(providers: readonly ProviderStatus[], overrides: Partial<ProviderSnapshot> = {}): ProviderSnapshot {
    return { generatedAt: NOW, expiresAt: new Date(NOW.getTime() + 600_000), providers, ...overrides };
}

function quota(overrides: Partial<ProviderQuota> = {}): ProviderQuota {
    return { id: 'limit', usedPercent: 35, resetsAt: THU_0900, ...overrides };
}

function tokens(overrides: Partial<ProviderTokenMix> = {}): ProviderTokenMix {
    return { inputTokens: 100, outputTokens: 200, cacheCreationTokens: 300, cacheReadTokens: 400, totalTokens: 1000, ...overrides };
}

function history(providerName: string, overrides: Partial<ProviderHistory> = {}): ProviderHistory {
    const recentTokens = tokens({ inputTokens: 700, outputTokens: 1400, cacheCreationTokens: 2100, cacheReadTokens: 2800, totalTokens: 7000 });
    return {
        source:       'ccusage', coverage:     'local_only', costBasis:    'calculated_api_reference_usd',
        startedAt:    new Date('2026-09-09T22:06:00Z'), finishedAt:   NOW,
        recentSince:  new Date('2026-09-03T00:00:00Z'), recentUntil:  new Date('2026-09-09T00:00:00Z'), recentDays:   7,
        recentTokens,
        recentModels: [{ model: `${providerName}-history-model`, tokens: recentTokens, costUsd: 0.007 }],
        blocks:       [{
            startTime:      new Date(ESTIMATE_RESET.getTime() - 5 * 3_600_000), endTime:        ESTIMATE_RESET,
            active:         true, gap:            false, mixedProvider:  false, modelProviders: [providerName], modelNames:     [`${providerName}-history-model`],
            tokens:         tokens(), costUsd:        0.001,
        }],
        ...overrides,
    };
}

function prices(providerName: string, models: ProviderReferencePrices['models'] = [{
    model: `${providerName}-cheap`, input: 1, output: 1, cacheRead: 1, cacheWrite: 1, eligible: true,
}]): ProviderReferencePrices {
    return {
        source: 'models.dev', observedAt: NOW, stale: false, unit: 'usd_per_million_tokens', models, assumptions: ['base_tier'],
    };
}

function render(report: ProviderSnapshot, now = NOW, sharedQuotaNote = false): string {
    return composeAmbientLines({ self: initialLedger('conversation'), now, timezone: TIMEZONE, providerSnapshot: report, sharedQuotaNote })[0] ?? '';
}

function renderJson(report: ProviderSnapshot, now = NOW, sharedQuotaNote = false): JsonObject {
    const line = render(report, now, sharedQuotaNote);
    const prefix = 'Quota: \n```json\n';
    expect(line.startsWith(prefix)).toBe(true);
    expect(line.endsWith('\n```')).toBe(true);
    return JSON.parse(line.slice(prefix.length, -'\n```'.length)) as JsonObject;
}

function object(value: JsonValue | undefined): JsonObject {
    expect(value).toBeTypeOf('object');
    expect(Array.isArray(value)).toBe(false);
    return value as JsonObject;
}

function array(value: JsonValue | undefined): JsonValue[] {
    expect(Array.isArray(value)).toBe(true);
    return value as JsonValue[];
}

function providerJson(report: ProviderSnapshot, name = 'codex', now = NOW): JsonObject {
    return object(renderJson(report, now)[name]);
}

function quotaLineJson(line: string): JsonObject {
    const prefix = 'Quota: \n```json\n';
    expect(line.startsWith(prefix)).toBe(true);
    return JSON.parse(line.slice(prefix.length, -'\n```'.length)) as JsonObject;
}

describe('provider quota JSON', () => {
    it.each([[1_209_600, '2w'], [172_800, '2d'], [7200, '2h'], [90, '90s']] as const)(
        'renders a %s-second duration as %s', (durationSeconds, window) => {
            const data = providerJson(snapshot([provider({ quotaAfter: observation({ quotas: [quota({ durationSeconds })] }) })]));
            expect(object(array(data.quotas)[0]).window).toBe(window);
        }
    );

    it.each([
        ['session kind', { id: 'limit', kind: 'session' }, '5h'],
        ['five-hour kind', { id: 'limit', kind: 'five_hour' }, '5h'],
        ['session id', { id: 'session' }, '5h'],
        ['five-hour id', { id: 'five_hour' }, '5h'],
        ['weekly kind', { id: 'limit', kind: 'weekly_all' }, '1w'],
        ['seven-day kind', { id: 'limit', kind: 'seven_day_team' }, '1w'],
        ['weekly id', { id: 'weekly_all' }, '1w'],
        ['seven-day id', { id: 'seven_day_team' }, '1w'],
        ['unrecognized kind', { id: 'limit', kind: 'daily_custom' }, undefined],
        ['unknown id', { id: 'monthly' }, undefined],
    ] as const)('infers the window from the %s alone', (_case, identity, expected) => {
        const data = providerJson(snapshot([provider({ quotaAfter: observation({ quotas: [quota(identity)] }) })]));
        expect(object(array(data.quotas)[0]).window).toBe(expected);
    });

    it('uses explicit UTC timestamps and preserves fractional percentages', () => {
        const data = providerJson(snapshot([provider({ quotaAfter: observation({
            quotas: [quota({ id: 'weekly', durationSeconds: 604_800, usedPercent: 35.25 })],
        }) })]));
        expect(data.observed_at).toBe('2026-09-09T22:07:00.000Z');
        expect(array(data.quotas)).toEqual([{
            id:                'weekly', window:            '1w', used_percent:      35.25, remaining_percent: 64.75,
            resets_at:         '2026-09-10T17:00:00.000Z',
        }]);
    });

    it('infers known 5h and 1w windows when duration is absent', () => {
        const data = providerJson(snapshot([provider({ quotaAfter: observation({ quotas: [
            quota({ id: 'session', kind: 'session' }), quota({ id: 'weekly_all', kind: 'weekly_all' }),
            quota({ id: 'seven_day', kind: 'seven_day' }),
        ] }) })]));
        expect(array(data.quotas).map(value => object(value).window)).toEqual(['5h', '1w', '1w']);
    });

    it('retains meaningful scope labels while omitting a redundant slot', () => {
        const data = providerJson(snapshot([provider({ quotaAfter: observation({ quotas: [quota({
            id:    'weekly_primary', name:  'Weekly primary', group: 'general', slot:  'primary',
            scope: { model: { id: 'gpt-5', displayName: 'GPT Five' }, surface: { id: 'chat', displayName: 'Chat UI' } },
        })] }) })]));
        expect(array(data.quotas)).toEqual([{
            id:                'weekly_primary', name:              'Weekly primary', window:            '1w',
            scope:             { group: 'general', model: { id: 'gpt-5', name: 'GPT Five' }, surface: { id: 'chat', name: 'Chat UI' } },
            used_percent:      35, remaining_percent: 65, resets_at:         '2026-09-10T17:00:00.000Z',
        }]);
    });

    it('retains a slot only when duplicate id and window buckets need it', () => {
        const data = providerJson(snapshot([provider({ quotaAfter: observation({ quotas: [
            quota({ id: 'shared', durationSeconds: 18_000, slot: 'primary' }),
            quota({ id: 'shared', durationSeconds: 18_000, slot: 'secondary' }),
        ] }) })]));
        expect(array(data.quotas).map(value => object(object(value).scope).slot)).toEqual(['primary', 'secondary']);
    });

    it.each([
        ['no slot', quota({ id: 'shared', durationSeconds: 18_000 }), quota({ id: 'shared', durationSeconds: 18_000, slot: 'secondary' })],
        ['different id', quota({ id: 'shared', durationSeconds: 18_000, slot: 'primary' }), quota({ id: 'other', durationSeconds: 18_000, slot: 'secondary' })],
        ['different window', quota({ id: 'shared', durationSeconds: 18_000, slot: 'primary' }), quota({ id: 'shared', durationSeconds: 604_800, slot: 'secondary' })],
        ['same slot', quota({ id: 'shared', durationSeconds: 18_000, slot: 'primary' }), quota({ id: 'shared', durationSeconds: 18_000, slot: 'primary' })],
    ] as const)('omits a slot when there is %s', (_case, current, candidate) => {
        const data = providerJson(snapshot([provider({ quotaAfter: observation({ quotas: [current, candidate] }) })]));
        expect(object(array(data.quotas)[0]).scope).toBeUndefined();
    });

    it('retains each scope label field independently and omits empty labels', () => {
        const data = providerJson(snapshot([provider({ quotaAfter: observation({ quotas: [
            quota({ id: 'one', scope: { model: { id: 'o3' } } }),
            quota({ id: 'two', scope: { surface: { displayName: 'API' } } }),
            quota({ id: 'three', group: 'general' }),
            quota({ id: 'empty', scope: { model: {}, surface: {} } }),
        ] }) })]));
        expect(object(array(data.quotas)[0]).scope).toEqual({ model: { id: 'o3' } });
        expect(object(array(data.quotas)[1]).scope).toEqual({ surface: { name: 'API' } });
        expect(object(array(data.quotas)[2]).scope).toEqual({ group: 'general' });
        expect(object(array(data.quotas)[3]).scope).toBeUndefined();
    });

    it('omits optional quota identity and reset fields exactly when absent or redundant', () => {
        const data = providerJson(snapshot([provider({ quotaAfter: observation({ quotas: [
            quota({ id: 'same', name: 'same', resetsAt: undefined }), quota({ id: 'unnamed', name: undefined, resetsAt: undefined }),
        ] }) })]));
        expect(data.quotas).toEqual([
            { id: 'same', used_percent: 35, remaining_percent: 65 },
            { id: 'unnamed', used_percent: 35, remaining_percent: 65 },
        ]);
    });

    it('renders inactive, expired, and active quota states distinctly', () => {
        const data = providerJson(snapshot([provider({ quotaAfter: observation({ quotas: [
            quota({ id: 'disabled', active: false }), quota({ id: 'expired', resetsAt: NOW }),
            quota({ id: 'active', resetsAt: new Date(NOW.getTime() + 1) }),
        ] }) })]));
        expect(array(data.quotas)).toEqual([
            { id: 'disabled', status: 'inactive' }, { id: 'expired', status: 'expired' },
            { id: 'active', used_percent: 35, remaining_percent: 65, resets_at: '2026-09-09T22:07:00.001Z' },
        ]);
    });

    it('filters the retired Spark meter only from Codex and retains shared Codex quota', () => {
        const spark = quota({ id: 'codex_bengalfox', name: 'GPT-5.3-Codex-Spark', scope: { model: { displayName: 'GPT-5.3-Codex-Spark' } } });
        const shared = quota({ id: 'codex_shared', name: 'Shared Codex' });
        const data = renderJson(snapshot([
            provider({ quotaAfter: observation({
                quotas:        [spark, shared],
                balances:      [{ kind: 'requests', scopeId: 'codex_bengalfox', total: '7' }, { kind: 'requests', scopeId: 'codex_shared', total: '93' }],
                spendControls: [{ scopeId: 'codex_bengalfox', reached: true }, { scopeId: 'codex_shared', reached: true }],
            }) }),
            provider({ provider: 'other', quotaAfter: observation({ source: 'other', quotas: [spark] }) }),
        ]));
        expect(array(object(data.codex).quotas).map(value => object(value).id)).toEqual(['codex_shared']);
        expect(array(object(data.codex).balances).map(value => object(value).scope_id)).toEqual(['codex_shared']);
        expect(array(object(data.codex).spend_controls).map(value => object(value).scope_id)).toEqual(['codex_shared']);
        expect(array(object(data.other).quotas).map(value => object(value).id)).toEqual(['codex_bengalfox']);
    });

    it.each([
        ['id', quota({ id: 'codex_bengalfox' })],
        ['name', quota({ id: 'different', name: 'GPT-5.3-Codex-Spark' })],
        ['model id', quota({ id: 'different', scope: { model: { id: 'gpt-5.3-codex-spark' } } })],
        ['model display name', quota({ id: 'different', scope: { model: { displayName: 'GPT-5.3-Codex-Spark' } } })],
    ] as const)('filters the verified Spark %s alias', (_case, spark) => {
        const data = providerJson(snapshot([provider({ quotaAfter: observation({ quotas: [spark] }) })]));
        expect(data.quotas).toBeUndefined();
    });

    it('filters balances and spend controls linked to a Spark alias with a nonstandard id', () => {
        const data = providerJson(snapshot([provider({ quotaAfter: observation({
            quotas:        [quota({ id: 'retired-meter', name: 'GPT-5.3-Codex-Spark' })],
            balances:      [{ kind: 'requests', scopeId: 'retired-meter', total: '7' }],
            spendControls: [{ scopeId: 'retired-meter', reached: true }],
        }) })]));
        expect(data).toEqual({
            quota_lookup: { status: 'ok', last_attempt_at: '2026-09-09T22:07:00.000Z' },
            observed_at:  '2026-09-09T22:07:00.000Z',
        });
    });

    it('filters known Spark-scoped Codex rows even when the quota meter is absent', () => {
        const data = providerJson(snapshot([provider({ quotaAfter: observation({
            balances: [
                { kind: 'requests', scopeId: 'codex_bengalfox', total: '7' },
                { kind: 'requests', scopeId: 'codex_shared', total: '93' },
            ],
            spendControls: [
                { scopeId: 'codex_bengalfox', reached: true },
                { scopeId: 'codex_shared', reached: true },
            ],
        }) })]));
        expect(data).toEqual({
            quota_lookup:   { status: 'ok', last_attempt_at: '2026-09-09T22:07:00.000Z' },
            observed_at:    '2026-09-09T22:07:00.000Z',
            balances:       [{ kind: 'requests', scope_id: 'codex_shared', total: '93' }],
            spend_controls: [{ scope_id: 'codex_shared', reached: true }],
        });
    });

    it('retains the same scope id when it belongs to a non-Codex provider', () => {
        const data = providerJson(snapshot([provider({
            provider:   'other',
            quotaAfter: observation({
                source:        'other',
                balances:      [{ kind: 'requests', scopeId: 'codex_bengalfox', total: '7' }],
                spendControls: [{ scopeId: 'codex_bengalfox', reached: true }],
            }),
        })]), 'other');
        expect(data).toEqual({
            quota_lookup:   { status: 'ok', last_attempt_at: '2026-09-09T22:07:00.000Z' },
            observed_at:    '2026-09-09T22:07:00.000Z',
            balances:       [{ kind: 'requests', scope_id: 'codex_bengalfox', total: '7' }],
            spend_controls: [{ scope_id: 'codex_bengalfox', reached: true }],
        });
    });
});

describe('rough token estimates', () => {
    it('estimates Codex five-hour and weekly headroom in the cheapest eligible routed model', () => {
        const report = snapshot([provider({
            history: history('codex'),
            prices:  prices('codex', [
                { model: 'GPT-5.3-Codex-Spark', input: 0.01, output: 0.01, cacheRead: 0.01, eligible: true },
                { model: 'codex_bengalfox', input: 0.02, output: 0.02, cacheRead: 0.02, eligible: true },
                { model: 'gpt-5.5', input: 0.1, output: 0.1, cacheRead: 0.1, eligible: true },
                { model: 'retired-cheap', input: 0.1, output: 0.1, cacheRead: 0.1, eligible: false },
                { model: 'gpt-5.6-sol', input: 2, output: 4, cacheRead: 0.2, eligible: true },
                { model: 'gpt-5.6-luna', input: 1, output: 2, cacheRead: 0.1, eligible: true },
            ]),
            quotaAfter: observation({ quotas: [
                quota({ id: 'five_hour', group: 'session', durationSeconds: 18_000, usedPercent: 20, resetsAt: ESTIMATE_RESET }),
                quota({ id: 'weekly', group: 'weekly', durationSeconds: 604_800, usedPercent: 35 }),
            ] }),
        })]);

        const data = providerJson(report);
        expect(data.estimates).toEqual({
            history: {
                source:           'ccusage', coverage:         'local_only', cost_basis:       'calculated_api_reference_usd',
                finished_at:      '2026-09-09T22:07:00.000Z',
                recent_7d_tokens: { input: 700, output: 1400, cache_creation: 2100, cache_read: 2800, total: 7000 },
                recent_7d_period: { since: '2026-09-03T00:00:00.000Z', until: '2026-09-09T00:00:00.000Z' },
            },
            reference_prices: {
                source:      'models.dev', observed_at: '2026-09-09T22:07:00.000Z', unit:        'usd_per_million_tokens',
                assumptions: ['base_tier'],
            },
        });
        expect(data.quotas).toEqual([
            {
                id:                        'five_hour', window:                    '5h', scope:                     { group: 'session' }, used_percent:              20, remaining_percent:         80,
                resets_at:                 '2026-09-10T01:07:00.000Z', estimate_tokens_remaining: 4800,
                estimate_model:            'gpt-5.6-luna', estimate_basis:            'current_5h_local_ratio',
                estimate_sample_tokens:    { input: 100, output: 200, cache_creation: 300, cache_read: 400, total: 1000 },
                estimate_sample_period:    { since: '2026-09-09T20:07:00.000Z', until: '2026-09-10T01:07:00.000Z' },
            },
            {
                id:                        'weekly', window:                    '1w', scope:                     { group: 'weekly' }, used_percent:              35, remaining_percent:         65,
                resets_at:                 '2026-09-10T17:00:00.000Z', estimate_tokens_remaining: 15_000,
                estimate_model:            'gpt-5.6-luna', estimate_basis:            'recent_7d_local_ratio',
                estimate_sample_tokens:    { input: 700, output: 1400, cache_creation: 2100, cache_read: 2800, total: 7000 },
                estimate_sample_period:    { since: '2026-09-03T00:00:00.000Z', until: '2026-09-09T00:00:00.000Z' },
            },
        ]);
    });

    it('uses a matching eligible model for a model-scoped quota instead of a cheaper unrelated model', () => {
        const sample = tokens();
        const scopedHistory = history('codex', {
            recentTokens: { inputTokens: 200, outputTokens: 400, cacheCreationTokens: 600, cacheReadTokens: 800, totalTokens: 2000 },
            recentModels: [
                { model: 'gpt-5.6-luna', tokens: sample, costUsd: 0.001 },
                { model: 'gpt-5.6-sol', tokens: sample, costUsd: 0.002 },
            ],
        });
        const data = providerJson(snapshot([provider({
            history: scopedHistory,
            prices:  prices('codex', [
                { model: 'gpt-5.6-luna', input: 1, output: 2, cacheRead: 0.1, eligible: true },
                { model: 'gpt-5.6-sol', input: 2, output: 4, cacheRead: 0.2, eligible: true },
            ]),
            quotaAfter: observation({ quotas: [quota({
                id: 'sol-weekly', durationSeconds: 604_800, scope: { model: { id: 'router-sol', displayName: 'GPT-5.6-SOL' } },
            })] }),
        })]));

        expect(object(array(data.quotas)[0])).toMatchObject({
            estimate_model: 'gpt-5.6-sol', estimate_tokens_remaining: 2200,
        });
    });

    it('matches a model-scoped quota by its stable model id alone', () => {
        const sample = tokens();
        const data = providerJson(snapshot([provider({
            history: history('codex', {
                recentModels: [{ model: 'gpt-5.6-sol', tokens: sample, costUsd: 0.002 }],
            }),
            prices:     prices('codex', [{ model: 'gpt-5.6-sol', input: 2, output: 4, cacheRead: 0.2, eligible: true }]),
            quotaAfter: observation({ quotas: [quota({
                id: 'sol-weekly', durationSeconds: 604_800, scope: { model: { id: 'GPT-5.6-SOL' } },
            })] }),
        })]));

        expect(object(array(data.quotas)[0])).toMatchObject({
            estimate_model: 'gpt-5.6-sol', estimate_tokens_remaining: 2200,
        });
    });

    it.each([
        ['surface', { group: undefined, scope: { surface: { id: 'cli' } } }],
        ['unknown group', { group: 'special' }],
    ] as const)('omits an estimate for an unmapped %s scope', (_case, scope) => {
        const data = providerJson(snapshot([provider({
            history:    history('codex'), prices:     prices('codex'),
            quotaAfter: observation({ quotas: [quota({ id: 'weekly', durationSeconds: 604_800, ...scope })] }),
        })]));

        expect(object(array(data.quotas)[0]).estimate_tokens_remaining).toBeUndefined();
    });

    it('omits an estimate when a provider does not identify the quota window', () => {
        const data = providerJson(snapshot([provider({
            history:    history('codex'), prices:     prices('codex'),
            quotaAfter: observation({ quotas: [quota({ id: 'custom', kind: 'custom', resetsAt: ESTIMATE_RESET })] }),
        })]));

        expect(object(array(data.quotas)[0]).estimate_tokens_remaining).toBeUndefined();
    });

    it('omits a model-scoped weekly estimate with no matching local history', () => {
        const data = providerJson(snapshot([provider({
            history:    history('codex'), prices:     prices('codex'),
            quotaAfter: observation({ quotas: [quota({
                id: 'unknown-weekly', durationSeconds: 604_800, scope: { model: { id: 'unknown-model' } },
            })] }),
        })]));

        expect(object(array(data.quotas)[0]).estimate_tokens_remaining).toBeUndefined();
    });

    it('omits a model-scoped five-hour estimate when its current block belongs to another model', () => {
        const data = providerJson(snapshot([provider({
            history: history('codex', {
                blocks: [{ ...history('codex').blocks[0], modelNames: ['gpt-5.6-sol', 'gpt-5.6-luna'] }],
            }),
            prices: prices('codex', [
                { model: 'gpt-5.6-luna', input: 1, output: 2, cacheRead: 0.1, eligible: true },
                { model: 'gpt-5.6-sol', input: 2, output: 4, cacheRead: 0.2, eligible: true },
            ]),
            quotaAfter: observation({ quotas: [quota({
                id:              'sol-five-hour', durationSeconds: 18_000, usedPercent:     20, resetsAt:        ESTIMATE_RESET,
                scope:           { model: { id: 'gpt-5.6-sol' } },
            })] }),
        })]));

        expect(object(array(data.quotas)[0]).estimate_tokens_remaining).toBeUndefined();
    });

    it('breaks equal-price model ties by model id for deterministic output', () => {
        const data = providerJson(snapshot([provider({
            history: history('codex'),
            prices:  prices('codex', [
                { model: 'z-model', input: 1, output: 1, cacheRead: 1, eligible: true },
                { model: 'a-model', input: 1, output: 1, cacheRead: 1, eligible: true },
            ]),
            quotaAfter: observation({ quotas: [quota({ id: 'weekly', durationSeconds: 604_800 })] }),
        })]));

        expect(object(array(data.quotas)[0]).estimate_model).toBe('a-model');
    });

    it.each([
        ['inactive', { active: false }],
        ['gap', { gap: true }],
        ['mixed provider', { mixedProvider: true }],
        ['different reset', {
            startTime: new Date(ESTIMATE_RESET.getTime() - 5 * 3_600_000 + 1), endTime: new Date(ESTIMATE_RESET.getTime() + 1),
        }],
        ['four-hour duration', { startTime: new Date(ESTIMATE_RESET.getTime() - 4 * 3_600_000) }],
        ['missing provider', { modelProviders: [] }],
        ['different provider', { modelProviders: ['anthropic'] }],
        ['partly different provider', { modelProviders: ['codex', 'anthropic'] }],
        ['Spark model', { modelNames: ['GPT-5.3-Codex-Spark'] }],
        ['partly Spark model', { modelNames: ['codex-history-model', 'codex_bengalfox'] }],
        ['missing cost', { costUsd: undefined }],
        ['zero cost', { costUsd: 0 }],
    ] as const)('omits a five-hour estimate for a %s block while retaining the weekly estimate', (_case, blockOverride) => {
        const reportHistory = history('codex', {
            blocks: [{ ...history('codex').blocks[0], ...blockOverride }],
        });
        const data = providerJson(snapshot([provider({
            history:    reportHistory,
            prices:     prices('codex'),
            quotaAfter: observation({ quotas: [
                quota({ id: 'five_hour', durationSeconds: 18_000, usedPercent: 20, resetsAt: ESTIMATE_RESET }),
                quota({ id: 'weekly', durationSeconds: 604_800, usedPercent: 35 }),
            ] }),
        })]));

        expect(object(array(data.quotas)[0]).estimate_tokens_remaining).toBeUndefined();
        expect(object(array(data.quotas)[1]).estimate_tokens_remaining).toBe(13_000);
    });

    it.each([
        ['missing cost', { recentModels: [{ model: 'codex-history-model', tokens: tokens(), costUsd: undefined }] }],
        ['zero cost', { recentModels: [{ model: 'codex-history-model', tokens: tokens(), costUsd: 0 }] }],
        ['no used models', { recentModels: [] }],
    ] as const)('omits a weekly estimate with %s', (_case, historyOverride) => {
        const data = providerJson(snapshot([provider({
            history:    history('codex', historyOverride), prices:     prices('codex'),
            quotaAfter: observation({ quotas: [quota({ id: 'weekly', durationSeconds: 604_800 })] }),
        })]));

        expect(object(array(data.quotas)[0]).estimate_tokens_remaining).toBeUndefined();
    });

    it('ignores an unused model without a reference cost', () => {
        const used = history('codex').recentModels[0];
        const data = providerJson(snapshot([provider({
            history: history('codex', {
                recentModels: [
                    { model: 'unused', tokens: tokens({ inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0 }) },
                    used,
                ],
            }),
            prices:     prices('codex'),
            quotaAfter: observation({ quotas: [quota({ id: 'weekly', durationSeconds: 604_800 })] }),
        })]));

        expect(object(array(data.quotas)[0]).estimate_tokens_remaining).toBe(13_000);
    });

    it('renders zero remaining at a full bucket and omits an estimate before there is a usable ratio', () => {
        const data = providerJson(snapshot([provider({
            history:    history('codex'), prices:     prices('codex'),
            quotaAfter: observation({ quotas: [
                quota({ id: 'empty', durationSeconds: 604_800, usedPercent: 0 }),
                quota({ id: 'full', durationSeconds: 604_800, usedPercent: 100 }),
            ] }),
        })]));

        expect(object(array(data.quotas)[0]).estimate_tokens_remaining).toBeUndefined();
        expect(object(array(data.quotas)[1]).estimate_tokens_remaining).toBe(0);
    });

    it('estimates a one-percent bucket and fails closed when finite inputs overflow', () => {
        const onePercent = providerJson(snapshot([provider({
            history:    history('codex'), prices:     prices('codex'),
            quotaAfter: observation({ quotas: [quota({ id: 'one-percent', durationSeconds: 604_800, usedPercent: 1 })] }),
        })]));
        const overflow = providerJson(snapshot([provider({
            history: history('codex', {
                recentModels: [{ model: 'overflowing', tokens: history('codex').recentTokens, costUsd: 0.007 }],
            }),
            prices: prices('codex', [
                { model: 'ordinary', input: 1, output: 1, cacheRead: 1, eligible: true },
                { model: 'overflowing', input: Number.MAX_VALUE, output: Number.MAX_VALUE, cacheRead: Number.MAX_VALUE, eligible: true },
            ]),
            quotaAfter: observation({ quotas: [quota({
                id: 'overflow', durationSeconds: 604_800, usedPercent: 35, scope: { model: { id: 'overflowing' } },
            })] }),
        })]));
        const roundingOverflow = providerJson(snapshot([provider({
            history: history('codex', {
                recentModels: [{
                    model: 'codex-history-model', tokens: history('codex').recentTokens, costUsd: Number.MAX_VALUE / 1_000_000,
                }],
            }),
            prices:     prices('codex'),
            quotaAfter: observation({ quotas: [quota({ id: 'rounding-overflow', durationSeconds: 604_800, usedPercent: 50 })] }),
        })]));

        expect(object(array(onePercent.quotas)[0]).estimate_tokens_remaining).toBe(690_000);
        expect(object(array(overflow.quotas)[0])).toEqual({
            id:                'overflow', window:            '1w', scope:             { model: { id: 'overflowing' } },
            used_percent:      35, remaining_percent: 65, resets_at:         '2026-09-10T17:00:00.000Z',
        });
        expect(object(array(roundingOverflow.quotas)[0])).toEqual({
            id:                'rounding-overflow', window:            '1w', used_percent:      50,
            remaining_percent: 50, resets_at:         '2026-09-10T17:00:00.000Z',
        });
    });

    it('uses Anthropic cache-write pricing while Codex treats cache creation as input', () => {
        const referenceModels = [{
            model: 'shared-model', input: 1, output: 1, cacheRead: 1, cacheWrite: 10, eligible: true,
        }];
        const anthropic = provider({
            provider:   'anthropic', history:    history('anthropic'), prices:     prices('anthropic', referenceModels),
            quotaAfter: observation({
                source: 'anthropic', quotas: [quota({ id: 'weekly', durationSeconds: 604_800 })],
            }),
        });
        const codex = provider({
            history:    history('codex'), prices:     prices('codex', referenceModels),
            quotaAfter: observation({ quotas: [quota({ id: 'weekly', durationSeconds: 604_800 })] }),
        });

        expect(object(array(providerJson(snapshot([anthropic]), 'anthropic').quotas)[0]).estimate_tokens_remaining).toBe(3500);
        expect(object(array(providerJson(snapshot([codex])).quotas)[0]).estimate_tokens_remaining).toBe(13_000);
    });

    it('does not apply Codex retired-model exclusions to another provider', () => {
        const anthropic = provider({
            provider: 'anthropic', history:  history('anthropic'),
            prices:   prices('anthropic', [{
                model: 'gpt-5.5', input: 1, output: 1, cacheRead: 1, cacheWrite: 1, eligible: true,
            }]),
            quotaAfter: observation({ source: 'anthropic', quotas: [quota({ id: 'weekly', durationSeconds: 604_800 })] }),
        });

        expect(object(array(providerJson(snapshot([anthropic]), 'anthropic').quotas)[0]).estimate_model).toBe('gpt-5.5');
    });

    it('requires only the cache prices used by the observed token mix', () => {
        const withoutCache = tokens({ cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 300 });
        const noCacheHistory = history('anthropic', {
            recentTokens: withoutCache,
            recentModels: [{ model: 'shared-model', tokens: withoutCache, costUsd: 0.0003 }],
        });
        const price = { model: 'shared-model', input: 1, output: 1, eligible: true };
        const usable = provider({
            provider:   'anthropic', history:    noCacheHistory, prices:     prices('anthropic', [price]),
            quotaAfter: observation({ source: 'anthropic', quotas: [quota({ id: 'weekly', durationSeconds: 604_800 })] }),
        });
        const missingUsedRate = provider({
            ...usable,
            history: history('anthropic'),
            prices:  prices('anthropic', [{ ...price, cacheRead: 1 }]),
        });

        expect(object(array(providerJson(snapshot([usable]), 'anthropic').quotas)[0]).estimate_tokens_remaining).toBe(560);
        expect(object(array(providerJson(snapshot([missingUsedRate]), 'anthropic').quotas)[0]).estimate_tokens_remaining).toBeUndefined();
    });

    it('skips an underflowed price and uses the next finite positive candidate', () => {
        const underflowMix = tokens({ inputTokens: 1, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 2 });
        const data = providerJson(snapshot([provider({
            history: history('codex', {
                recentModels: [{ model: 'observed', tokens: underflowMix, costUsd: 0.001 }],
            }),
            prices: prices('codex', [
                { model: 'underflow', input: Number.MIN_VALUE, output: Number.MIN_VALUE, eligible: true },
                { model: 'usable', input: 1, output: 1, eligible: true },
            ]),
            quotaAfter: observation({ quotas: [quota({ id: 'weekly', durationSeconds: 604_800 })] }),
        })]));

        expect(object(array(data.quotas)[0])).toMatchObject({
            estimate_model: 'usable', estimate_tokens_remaining: 3700,
        });
    });

    it('renders stale and empty optional reference-price provenance exactly', () => {
        const stale = prices('codex');
        stale.stale = true;
        stale.assumptions = [];
        const data = providerJson(snapshot([provider({ prices: stale })]));

        expect(data.estimates).toEqual({
            reference_prices: {
                source: 'models.dev', observed_at: '2026-09-09T22:07:00.000Z', stale: true, unit: 'usd_per_million_tokens',
            },
        });
    });

    it('keeps history provenance when reference prices are absent', () => {
        const data = providerJson(snapshot([provider({ history: history('codex') })]));

        expect(object(data.estimates).history).toEqual({
            source:           'ccusage', coverage:         'local_only', cost_basis:       'calculated_api_reference_usd',
            finished_at:      '2026-09-09T22:07:00.000Z',
            recent_7d_tokens: { input: 700, output: 1400, cache_creation: 2100, cache_read: 2800, total: 7000 },
            recent_7d_period: { since: '2026-09-03T00:00:00.000Z', until: '2026-09-09T00:00:00.000Z' },
        });
    });

    it('keeps price provenance and live quota when local history is absent', () => {
        const data = providerJson(snapshot([provider({
            prices:     prices('codex'),
            quotaAfter: observation({ quotas: [quota({ id: 'weekly', durationSeconds: 604_800 })] }),
        })]));

        expect(data.estimates).toEqual({
            reference_prices: {
                source:      'models.dev', observed_at: '2026-09-09T22:07:00.000Z', unit:        'usd_per_million_tokens',
                assumptions: ['base_tier'],
            },
        });
        expect(object(array(data.quotas)[0]).estimate_tokens_remaining).toBeUndefined();
    });

    it('keeps live quota but suppresses estimates when the local history section failed', () => {
        const data = providerJson(snapshot([provider({
            history:    history('codex'),
            prices:     prices('codex'),
            errors:     [{ section: 'history', code: 'timed_out' }],
            quotaAfter: observation({ quotas: [quota({ id: 'weekly', durationSeconds: 604_800 })] }),
        })]));

        expect(array(data.quotas)).toHaveLength(1);
        expect(data.estimates).toEqual({
            reference_prices: {
                source:      'models.dev', observed_at: '2026-09-09T22:07:00.000Z', unit:        'usd_per_million_tokens',
                assumptions: ['base_tier'],
            },
        });
        expect(object(array(data.quotas)[0]).estimate_tokens_remaining).toBeUndefined();
    });

    it('estimates each eligible DeepSeek model from a fresh USD balance and observed token mix', () => {
        const deepseek = provider({
            provider: 'deepseek',
            history:  history('deepseek'),
            prices:   prices('deepseek', [
                { model: 'deepseek-flash', input: 1, output: 1, cacheRead: 1, eligible: true },
                { model: 'deepseek-pro', input: 2, output: 2, cacheRead: 2, eligible: true },
                { model: 'deepseek-no-cache-rate', input: 0.5, output: 0.5, eligible: true },
                { model: 'deepseek-retired', input: 0.5, output: 0.5, cacheRead: 0.5, eligible: false },
            ]),
            quotaAfter: observation({
                source: 'deepseek', balances: [{ kind: 'prepaid', currency: 'USD', total: '9.33' }],
            }),
        });

        expect(object(providerJson(snapshot([deepseek]), 'deepseek').estimates).remaining_by_model).toEqual([
            {
                estimate_model:            'deepseek-flash', currency:                  'USD', balance:                   '9.33',
                estimate_tokens_remaining: 9_300_000, estimate_tokens_per_usd:   1_000_000,
                basis:                     'models_dev_observed_mix',
            },
            {
                estimate_model:            'deepseek-pro', currency:                  'USD', balance:                   '9.33',
                estimate_tokens_remaining: 4_700_000, estimate_tokens_per_usd:   500_000,
                basis:                     'models_dev_observed_mix',
            },
        ]);
    });

    it('selects only an available unscoped finite USD balance', () => {
        const data = providerJson(snapshot([provider({
            provider:   'deepseek', history:    history('deepseek'), prices:     prices('deepseek'),
            quotaAfter: observation({
                source:   'deepseek',
                balances: [
                    { kind: 'eur', currency: 'EUR', total: '1' },
                    { kind: 'scoped', currency: 'USD', scopeId: 'team', total: '2' },
                    { kind: 'unknown', currency: 'USD', available: false, total: '3' },
                    { kind: 'unlimited', currency: 'USD', unlimited: true, total: '4' },
                    { kind: 'missing', currency: 'USD' },
                    { kind: 'usable', currency: 'USD', total: '9.33' },
                ],
            }),
        })]), 'deepseek');

        expect(object(data.estimates).remaining_by_model).toEqual([{
            estimate_model:            'deepseek-cheap', currency:                  'USD', balance:                   '9.33',
            estimate_tokens_remaining: 9_300_000, estimate_tokens_per_usd:   1_000_000,
            basis:                     'models_dev_observed_mix',
        }]);
    });

    it.each(['not-a-number', '-1', 'Infinity'])(
        'omits DeepSeek remaining estimates for the invalid balance %s', (total) => {
            const data = providerJson(snapshot([provider({
                provider:   'deepseek', history:    history('deepseek'), prices:     prices('deepseek'),
                quotaAfter: observation({ source: 'deepseek', balances: [{ kind: 'prepaid', currency: 'USD', total }] }),
            })]), 'deepseek');

            expect(object(data.estimates).remaining_by_model).toBeUndefined();
        }
    );

    it('omits DeepSeek remaining estimates when no balance matches the required scope and currency', () => {
        const data = providerJson(snapshot([provider({
            provider:   'deepseek', history:    history('deepseek'), prices:     prices('deepseek'),
            quotaAfter: observation({ source: 'deepseek', balances: [{ kind: 'eur', currency: 'EUR', total: '9.33' }] }),
        })]), 'deepseek');

        expect(object(data.estimates).remaining_by_model).toBeUndefined();
    });

    it('requires DeepSeek history and prices independently and never estimates another provider balance', () => {
        const balance = observation({ source: 'deepseek', balances: [{ kind: 'prepaid', currency: 'USD', total: '9.33' }] });
        const withoutHistory = providerJson(snapshot([provider({
            provider: 'deepseek', prices: prices('deepseek'), quotaAfter: balance,
        })]), 'deepseek');
        const withoutPrices = providerJson(snapshot([provider({
            provider: 'deepseek', history: history('deepseek'), quotaAfter: balance,
        })]), 'deepseek');
        const codex = providerJson(snapshot([provider({
            history:    history('codex'), prices:     prices('codex'),
            quotaAfter: observation({ balances: [{ kind: 'prepaid', currency: 'USD', total: '9.33' }] }),
        })]));

        expect(object(withoutHistory.estimates).remaining_by_model).toBeUndefined();
        expect(object(withoutPrices.estimates).remaining_by_model).toBeUndefined();
        expect(object(codex.estimates).remaining_by_model).toBeUndefined();
    });

    it('supports a missing cache rate for a mix that did not use cache', () => {
        const noCache = tokens({ cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 300 });
        const data = providerJson(snapshot([provider({
            provider: 'deepseek',
            history:  history('deepseek', {
                recentTokens: noCache,
                recentModels: [{ model: 'deepseek-model', tokens: noCache, costUsd: 0.0003 }],
            }),
            prices:     prices('deepseek', [{ model: 'deepseek-no-cache-rate', input: 1, output: 2, eligible: true }]),
            quotaAfter: observation({ source: 'deepseek', balances: [{ kind: 'prepaid', currency: 'USD', total: '1' }] }),
        })]), 'deepseek');

        expect(object(data.estimates).remaining_by_model).toEqual([{
            estimate_model:            'deepseek-no-cache-rate', currency:                  'USD', balance:                   '1',
            estimate_tokens_remaining: 600_000, estimate_tokens_per_usd:   600_000,
            basis:                     'models_dev_observed_mix',
        }]);
    });

    it('omits non-finite DeepSeek token conversions', () => {
        const tiny = Number.MIN_VALUE;
        const tinyPrice = prices('deepseek', [{ model: 'tiny', input: tiny, output: tiny, cacheRead: tiny, eligible: true }]);
        const hugeBalance = providerJson(snapshot([provider({
            provider:   'deepseek', history:    history('deepseek'), prices:     prices('deepseek'),
            quotaAfter: observation({ source: 'deepseek', balances: [{ kind: 'prepaid', currency: 'USD', total: `${Number.MAX_VALUE}` }] }),
        })]), 'deepseek');
        const tinyRate = providerJson(snapshot([provider({
            provider:   'deepseek', history:    history('deepseek'), prices:     tinyPrice,
            quotaAfter: observation({ source: 'deepseek', balances: [{ kind: 'prepaid', currency: 'USD', total: '0' }] }),
        })]), 'deepseek');

        expect(object(hugeBalance.estimates).remaining_by_model).toBeUndefined();
        expect(object(tinyRate.estimates).remaining_by_model).toBeUndefined();
    });

    it('allows a zero DeepSeek balance but suppresses remaining estimates for stale or spend-blocked quota', () => {
        const base = provider({
            provider:   'deepseek', history:    history('deepseek'), prices:     prices('deepseek'),
            quotaAfter: observation({ source: 'deepseek', balances: [{ kind: 'prepaid', currency: 'USD', total: '0' }] }),
        });
        const zero = providerJson(snapshot([base]), 'deepseek');
        expect(object(zero.estimates).remaining_by_model).toEqual([{
            estimate_model:            'deepseek-cheap', currency:                  'USD', balance:                   '0', estimate_tokens_remaining: 0,
            estimate_tokens_per_usd:   1_000_000, basis:                     'models_dev_observed_mix',
        }]);

        for(const blocked of [
            { ...base, freshness: { cached: false, stale: true, ageSeconds: 1 } },
            { ...base, errors: [{ section: 'balances', code: 'timed_out' }] },
            { ...base, quotaAfter: observation({
                source: 'deepseek', available: false, balances: [{ kind: 'prepaid', currency: 'USD', total: '9.33' }],
            }) },
            { ...base, quotaAfter: observation({
                source:        'deepseek', balances:      [{ kind: 'prepaid', currency: 'USD', total: '9.33' }],
                spendControls: [{ scopeId: 'monthly', reached: true }],
            }) },
        ]) {
            expect(object(providerJson(snapshot([blocked]), 'deepseek').estimates).remaining_by_model).toBeUndefined();
        }
    });

    it('retains DeepSeek remaining estimates after an unrelated report section fails', () => {
        const data = providerJson(snapshot([provider({
            provider:   'deepseek', history:    history('deepseek'), prices:     prices('deepseek'),
            errors:     [{ section: 'spend_controls', code: 'timed_out' }],
            quotaAfter: observation({ source: 'deepseek', balances: [{ kind: 'prepaid', currency: 'USD', total: '1' }] }),
        })]), 'deepseek');

        expect(object(data.estimates).remaining_by_model).toEqual([{
            estimate_model:            'deepseek-cheap', currency:                  'USD', balance:                   '1',
            estimate_tokens_remaining: 1_000_000, estimate_tokens_per_usd:   1_000_000,
            basis:                     'models_dev_observed_mix',
        }]);
    });

    it('keeps Anthropic history for SDK quota estimates without exposing the skipped quota lookup', () => {
        const anthropic = provider({
            provider:   'anthropic', status:     'error', quotaAfter: undefined,
            errors:     [{ section: 'quota_after', code: 'credential_unavailable' }],
            history:    history('anthropic'), prices:     prices('anthropic'),
        });
        const self = {
            ...initialLedger('conversation'),
            quota: {
                fiveHour: { utilization: 20, resetsAt: ESTIMATE_RESET },
                sevenDay: { utilization: 35, resetsAt: THU_0900 },
                source:   'headers' as const,
                at:       NOW,
            },
        };
        const line = composeAmbientLines({
            self, now: NOW, timezone: TIMEZONE, providerSnapshot: snapshot([provider(), anthropic]), anthropicQuotaSource: 'sdk',
        })[0] ?? '';
        const data = object(quotaLineJson(line).anthropic);

        expect(data.quota_lookup).toBeUndefined();
        expect(data.quota_values).toEqual({
            status: 'ok', source: 'session_ledger', last_update_source: 'sdk_rate_limit_event', age: 'unknown',
        });
        expect(array(data.quotas).map(row => object(row).estimate_tokens_remaining)).toEqual([4000, 13_000]);
        expect(object(data.estimates).history).toBeDefined();
    });

    it('keeps expired report provenance but does not use it to estimate an SDK quota', () => {
        const anthropic = provider({
            provider: 'anthropic', history: history('anthropic'), prices: prices('anthropic'),
        });
        const self = {
            ...initialLedger('conversation'),
            quota: {
                fiveHour: { utilization: 20, resetsAt: ESTIMATE_RESET },
                source:   'headers' as const,
                at:       NOW,
            },
        };
        const line = composeAmbientLines({
            self,
            now:                  NOW,
            timezone:             TIMEZONE,
            providerSnapshot:     snapshot([anthropic, provider()], { expiresAt: NOW }),
            anthropicQuotaSource: 'sdk',
        })[0] ?? '';
        const report = quotaLineJson(line);
        const data = object(report.anthropic);

        expect(object(data.estimates).history).toBeDefined();
        expect(object(array(data.quotas)[0]).estimate_tokens_remaining).toBeUndefined();
        expect(object(object(report.codex).quota_lookup)).toEqual({
            status:            'unknown', error:             'quota_data_stale', last_attempt_at:   '2026-09-09T22:07:00.000Z',
            report_expired_at: '2026-09-09T22:07:00.000Z',
        });
    });

    it('uses only the Anthropic report row to enrich the legacy SDK-ledger fallback', () => {
        const self = {
            ...initialLedger('conversation'),
            quota: {
                sevenDay: { utilization: 35, resetsAt: THU_0900 },
                source:   'headers' as const,
                at:       NOW,
            },
        };
        const anthropic = provider({
            provider:   'anthropic', status:     'error', quotaAfter: undefined,
            errors:     [{ section: 'quota_after', code: 'credential_unavailable' }],
            history:    history('anthropic'), prices:     prices('anthropic'),
        });
        const codex = provider({ history: history('codex'), prices: prices('codex') });
        const line = composeAmbientLines({
            self, now: NOW, timezone: TIMEZONE, providerSnapshot: snapshot([codex, anthropic]), anthropicQuotaSource: 'provider',
        })[0] ?? '';
        const data = object(quotaLineJson(line).anthropic);

        expect(object(array(data.quotas)[0])).toMatchObject({
            estimate_model: 'anthropic-cheap', estimate_tokens_remaining: 13_000,
        });
    });

    it('does not enrich a legacy SDK-ledger fallback from an expired provider report', () => {
        const self = {
            ...initialLedger('conversation'),
            quota: {
                sevenDay: { utilization: 35, resetsAt: THU_0900 },
                source:   'headers' as const,
                at:       NOW,
            },
        };
        const anthropic = provider({
            provider:   'anthropic', status:     'error', quotaAfter: undefined,
            errors:     [{ section: 'quota_after', code: 'credential_unavailable' }],
            history:    history('anthropic'), prices:     prices('anthropic'),
        });
        const line = composeAmbientLines({
            self,
            now:                  NOW,
            timezone:             TIMEZONE,
            providerSnapshot:     snapshot([anthropic], { expiresAt: NOW }),
            anthropicQuotaSource: 'provider',
        })[0] ?? '';
        const data = object(quotaLineJson(line).anthropic);

        expect(array(data.quotas)).toEqual([{
            id:                'seven_day', window:            '1w', used_percent:      35, remaining_percent: 65,
            resets_at:         '2026-09-10T17:00:00.000Z',
        }]);
    });
});

describe('balances and report state', () => {
    it('preserves monetary strings and distinguishes balance states', () => {
        const balances: ProviderBalance[] = [
            { kind: 'enterprise', scopeId: 'org', unlimited: true }, { kind: 'prepaid', scopeId: 'team', available: false },
            { kind: 'cash', currency: 'USD', total: '9.35' }, { kind: 'credits', total: '120', amountUnit: 'credits' }, { kind: 'grant' },
        ];
        const data = providerJson(snapshot([provider({ quotaAfter: observation({ balances }) })]));
        expect(array(data.balances)).toEqual([
            { kind: 'enterprise', scope_id: 'org', status: 'unlimited' }, { kind: 'prepaid', scope_id: 'team', status: 'unknown' },
            { kind: 'cash', currency: 'USD', total: '9.35' }, { kind: 'credits', total: '120', amount_unit: 'credits' },
            { kind: 'grant', status: 'reported' },
        ]);
    });

    it('shows only reached spend controls', () => {
        const data = providerJson(snapshot([provider({ quotaAfter: observation({
            spendControls: [{ scopeId: 'soft', reached: false }, { scopeId: 'hard', reached: true }],
        }) })]));
        expect(data.spend_controls).toEqual([{ scope_id: 'hard', reached: true }]);
    });

    it('ages cached data from report generation and keeps report status separate', () => {
        const data = providerJson(snapshot([provider({
            status: 'partial', freshness: { cached: true, stale: false, ageSeconds: 45 },
        })], { generatedAt: new Date(NOW.getTime() - 30_000) }));
        expect(data.quota_lookup).toEqual({ status: 'ok', last_attempt_at: '2026-09-09T22:07:00.000Z', cached: true, age_seconds: 75 });
        expect(data.report_status).toBe('partial');
    });

    it('does not turn a future generation stamp into negative cache age', () => {
        const data = providerJson(snapshot([provider({ freshness: { cached: true, stale: false, ageSeconds: 45 } })], {
            generatedAt: new Date(NOW.getTime() + 30_000),
        }));
        expect(object(data.quota_lookup).age_seconds).toBe(45);
    });

    it('uses unknown for report expiry and emits the actual expiry time', () => {
        const expiresAt = new Date(NOW.getTime() - 1);
        const data = providerJson(snapshot([provider({ status: 'error' })], { expiresAt }));
        expect(data.quota_lookup).toEqual({
            status:            'unknown', error:             'quota_data_stale', last_attempt_at:   '2026-09-09T22:07:00.000Z',
            report_expired_at: '2026-09-09T22:06:59.999Z',
        });
        expect(data.report_status).toBe('error');
    });

    it('expires a report exactly at its expiry boundary', () => {
        const data = providerJson(snapshot([provider({
            quotaAfter: observation({ quotas: [quota({ id: 'fresh-until-boundary' })] }),
        })], { expiresAt: NOW }));
        expect(data).toEqual({
            quota_lookup: {
                status:            'unknown', error:             'quota_data_stale',
                last_attempt_at:   '2026-09-09T22:07:00.000Z', report_expired_at: '2026-09-09T22:07:00.000Z',
            },
        });
    });

    it.each([
        ['stale', provider({ freshness: { cached: false, stale: true, ageSeconds: 0 } }), 'quota_data_stale'],
        ['missing', provider({ quotaAfter: undefined }), 'quota_api_no_observation'],
        ['unknown reading', provider({ quotaAfter: observation({ available: false }) }), 'quota_api_no_reading'],
    ] as const)('marks a %s quota reading unknown', (_case, status, error) => {
        const lookup = object(providerJson(snapshot([status])).quota_lookup);
        expect(lookup).toMatchObject({ status: 'unknown', error, last_attempt_at: '2026-09-09T22:07:00.000Z' });
    });

    it('labels a 429 as a quota API error and shows retry time', () => {
        const retryAt = new Date('2026-09-09T22:12:00Z');
        const data = providerJson(snapshot([provider({
            provider:   'anthropic', status:     'partial', quotaAfter: undefined,
            errors:     [{ section: 'quota_after', code: 'rate_limited', retryAt }, { section: 'history', code: 'timed_out' }],
        })]), 'anthropic');
        expect(data.quota_lookup).toEqual({
            status:          'unknown', error:           'quota_api_rate_limited', last_attempt_at: '2026-09-09T22:07:00.000Z',
            retry_at:        '2026-09-09T22:12:00.000Z',
        });
        expect(data.quotas).toBeUndefined();
        expect(data.errors).toEqual([{ section: 'history', code: 'timed_out' }]);
        expect(JSON.stringify(data.errors)).not.toContain('rate_limited');
    });

    it('maps multiple quota API errors and preserves unrelated report errors', () => {
        const data = providerJson(snapshot([provider({ status: 'partial', errors: [
            { section: 'quota_after', code: 'unauthorized' }, { section: 'balances', code: 'timed_out' },
            { section: 'quota_after', code: 'malformed' },
        ] })]));
        expect(data.quota_lookup).toEqual({
            status:          'unknown', error:           'quota_api_multiple_errors', last_attempt_at: '2026-09-09T22:07:00.000Z',
            errors:          ['quota_api_unauthorized', 'quota_api_malformed'],
        });
        expect(data.errors).toEqual([{ section: 'balances', code: 'timed_out' }]);
        expect(JSON.stringify(data.errors)).not.toContain('unauthorized');
        expect(JSON.stringify(data.errors)).not.toContain('malformed');
    });

    it('keeps non-quota errors visible without discarding fresh quota', () => {
        const data = providerJson(snapshot([provider({
            status:     'partial', errors:     [{ section: 'balances', code: 'timed_out' }],
            quotaAfter: observation({ quotas: [quota({ resetsAt: undefined })] }),
        })]));
        expect(object(data.quota_lookup).status).toBe('ok');
        expect(array(data.quotas)).toHaveLength(1);
        expect(data.errors).toEqual([{ section: 'balances', code: 'timed_out' }]);
    });

    it('adds the shared-subscription note when requested', () => {
        expect(renderJson(snapshot([provider()]), NOW, true).note).toBe('Subscription quotas are shared; provider balances are separate.');
    });

    it('omits report metadata and the shared note exactly when they are absent', () => {
        expect(renderJson(snapshot([provider()]))).toEqual({
            codex: {
                quota_lookup: { status: 'ok', last_attempt_at: '2026-09-09T22:07:00.000Z' },
                observed_at:  '2026-09-09T22:07:00.000Z',
            },
        });
    });

    it.each([
        ['rate-limited', 'quota_api_rate_limited'],
        ['HTTP_429', 'quota_api_rate_limited'],
        ['Token Expired', 'quota_api_token_expired'],
    ] as const)('normalizes the quota API error code %s', (code, expected) => {
        const data = providerJson(snapshot([provider({ quotaAfter: undefined, errors: [{ section: 'quota_after', code }] })]));
        expect(data.quota_lookup).toEqual({
            status: 'unknown', error: expected, last_attempt_at: '2026-09-09T22:07:00.000Z',
        });
    });

    it('maps http_429 to the quota API rate-limit error', () => {
        const data = providerJson(snapshot([provider({
            quotaAfter: undefined, errors: [{ section: 'quota_after', code: 'http_429' }],
        })]));
        expect(data).toEqual({
            quota_lookup: {
                status: 'unknown', error: 'quota_api_rate_limited', last_attempt_at: '2026-09-09T22:07:00.000Z',
            },
        });
    });
});

describe('shared burn pace', () => {
    function paceReport(current: ProviderQuota, prior: ProviderQuota, elapsedMs: number, priorCollectedAt?: Date): ProviderSnapshot {
        const previousAt = priorCollectedAt ?? new Date(NOW.getTime() - elapsedMs);
        const previous = snapshot([provider({ quotaAfter: observation({ collectedAt: previousAt, quotas: [prior] }) })], { generatedAt: previousAt });
        return snapshot([provider({ quotaAfter: observation({ quotas: [current] }) })], { previous });
    }

    it('computes positive pace at the exact one-minute boundary', () => {
        const data = providerJson(paceReport(quota({ usedPercent: 35 }), quota({ usedPercent: 34 }), 60_000));
        expect(object(array(data.quotas)[0]).shared_burn_percent_per_hour).toBe(60);
    });

    it.each([
        ['under one minute', quota({ usedPercent: 35 }), quota({ usedPercent: 34 }), 59_999, undefined],
        ['unchanged', quota({ usedPercent: 35 }), quota({ usedPercent: 35 }), 3_600_000, undefined],
        ['falling', quota({ usedPercent: 34 }), quota({ usedPercent: 35 }), 3_600_000, undefined],
        ['same time', quota({ usedPercent: 35 }), quota({ usedPercent: 34 }), 0, NOW],
        ['later prior', quota({ usedPercent: 35 }), quota({ usedPercent: 34 }), 0, new Date(NOW.getTime() + 1)],
        ['different identity', quota({ group: 'a', usedPercent: 35 }), quota({ group: 'b', usedPercent: 34 }), 3_600_000, undefined],
    ] as const)('suppresses pace for %s', (_case, current, prior, elapsedMs, priorAt) => {
        const data = providerJson(paceReport(current, prior, elapsedMs, priorAt));
        expect(object(array(data.quotas)[0]).shared_burn_percent_per_hour).toBeUndefined();
    });

    it.each([
        ['id', quota({ id: 'current' }), quota({ id: 'prior' })],
        ['slot', quota({ slot: 'primary' }), quota({ slot: 'secondary' })],
        ['duration', quota({ durationSeconds: 18_000 }), quota({ durationSeconds: 604_800 })],
        ['reset', quota({ resetsAt: THU_0900 }), quota({ resetsAt: new Date(THU_0900.getTime() + 1) })],
        ['model id', quota({ scope: { model: { id: 'current' } } }), quota({ scope: { model: { id: 'prior' } } })],
        ['model name', quota({ scope: { model: { displayName: 'Current' } } }), quota({ scope: { model: { displayName: 'Prior' } } })],
        ['surface id', quota({ scope: { surface: { id: 'current' } } }), quota({ scope: { surface: { id: 'prior' } } })],
        ['surface name', quota({ scope: { surface: { displayName: 'Current' } } }), quota({ scope: { surface: { displayName: 'Prior' } } })],
        ['delimiter-bearing identity', quota({ id: 'a\0b', group: 'c' }), quota({ id: 'a', group: 'b\0c' })],
    ] as const)('does not compare burn across a different %s', (_case, current, prior) => {
        const data = providerJson(paceReport(current, prior, 3_600_000));
        expect(object(array(data.quotas)[0]).shared_burn_percent_per_hour).toBeUndefined();
    });

    it('omits burn without a current reset, previous observation, or matching prior quota', () => {
        const noReset = providerJson(paceReport(
            quota({ resetsAt: undefined, usedPercent: 35 }), quota({ resetsAt: undefined, usedPercent: 34 }), 3_600_000
        ));
        const noPrevious = providerJson(snapshot([provider({ quotaAfter: observation({ quotas: [quota()] }) })]));
        const noPriorQuota = providerJson(snapshot([provider({ quotaAfter: observation({ quotas: [quota()] }) })], {
            previous: snapshot([provider({ quotaAfter: observation({ collectedAt: new Date(NOW.getTime() - 3_600_000) }) })]),
        }));
        for(const data of [noReset, noPrevious, noPriorQuota]) {
            expect(object(array(data.quotas)[0]).shared_burn_percent_per_hour).toBeUndefined();
        }
    });
});

describe('direct Anthropic fallback', () => {
    function fallback(windows: QuotaWindows, expiresAt = new Date(NOW.getTime() + 60_000)): ProviderSnapshot['anthropicFallback'] {
        return { collectedAt: NOW, expiresAt, windows };
    }

    it('inserts a fresh direct fallback when Anthropic is absent', () => {
        const data = renderJson(snapshot([provider()], { anthropicFallback: fallback({ fiveHour: { utilization: 42 } }) }));
        expect(object(object(data.anthropic).quota_lookup)).toEqual({
            status: 'ok', last_attempt_at: '2026-09-09T22:07:00.000Z', source: 'direct_anthropic',
        });
        expect(array(object(data.anthropic).quotas)).toEqual([{ id: 'five_hour', window: '5h', used_percent: 42, remaining_percent: 58 }]);
    });

    it('uses direct fallback only for unknown Anthropic data and retains other providers', () => {
        const report = snapshot([
            provider({ provider: 'anthropic', status: 'error', quotaAfter: undefined }),
            provider({ provider: 'deepseek', quotaAfter: observation({ source: 'deepseek' }) }),
        ], { anthropicFallback: fallback({ sevenDay: { utilization: 61 } }) });
        const data = renderJson(report);
        expect(array(object(data.anthropic).quotas)).toEqual([{
            id: 'seven_day', window: '1w', used_percent: 61, remaining_percent: 39,
        }]);
        expect(object(data.deepseek).observed_at).toBe('2026-09-09T22:07:00.000Z');
    });

    it.each([
        ['stale source', { freshness: { cached: false, stale: true, ageSeconds: 0 } }, {}],
        ['missing observation', { quotaAfter: undefined }, {}],
        ['unknown reading', { quotaAfter: observation({ source: 'anthropic', available: false }) }, {}],
        ['quota API error', { errors: [{ section: 'quota_after', code: 'timed_out' }] }, {}],
        ['expired report', {}, { expiresAt: new Date(NOW.getTime() - 1) }],
    ] as const)('uses the direct fallback for an Anthropic %s', (_case, providerOverrides, snapshotOverrides) => {
        const anthropic = provider({ provider: 'anthropic', quotaAfter: observation({ source: 'anthropic' }), ...providerOverrides });
        const data = renderJson(snapshot([anthropic], {
            anthropicFallback: fallback({ fiveHour: { utilization: 42 } }), ...snapshotOverrides,
        }));
        expect(object(object(data.anthropic).quota_lookup).source).toBe('direct_anthropic');
    });

    it('keeps fresh Anthropic provider data instead of replacing it', () => {
        const anthropic = provider({ provider: 'anthropic', quotaAfter: observation({ source: 'anthropic', quotas: [quota({ id: 'provider-limit' })] }) });
        const data = renderJson(snapshot([anthropic], { anthropicFallback: fallback({ fiveHour: { utilization: 99 } }) }));
        expect(object(array(object(data.anthropic).quotas)[0]).id).toBe('provider-limit');
    });

    it('keeps a fresh protocol observation when its optional available field is omitted', () => {
        const anthropic = provider({
            provider:   'anthropic',
            quotaAfter: {
                source:        'anthropic', collectedAt:   NOW,
                quotas:        [quota({ id: 'protocol-limit', usedPercent: 17 })],
                balances:      [], spendControls: [],
            },
        });
        const data = renderJson(snapshot([anthropic], { anthropicFallback: fallback({ fiveHour: { utilization: 99 } }) }));
        expect(object(data.anthropic)).toEqual({
            quota_lookup: { status: 'ok', last_attempt_at: '2026-09-09T22:07:00.000Z' },
            observed_at:  '2026-09-09T22:07:00.000Z',
            quotas:       [{
                id:                'protocol-limit', used_percent:      17, remaining_percent: 83,
                resets_at:         '2026-09-10T17:00:00.000Z',
            }],
        });
    });

    it('does not replace fresh data after an unrelated report section failed', () => {
        const anthropic = provider({
            provider: 'anthropic', status: 'partial', errors: [{ section: 'balances', code: 'timed_out' }], quotaAfter: observation({ source: 'anthropic' }),
        });
        const data = renderJson(snapshot([anthropic], { anthropicFallback: fallback({ fiveHour: { utilization: 99 } }) }));
        expect(object(object(data.anthropic).quota_lookup).status).toBe('ok');
        expect(object(data.anthropic).quotas).toBeUndefined();
    });

    it('marks an empty or expired direct observation unknown', () => {
        const empty = renderJson(snapshot([], { anthropicFallback: fallback({}) }));
        const expired = renderJson(snapshot([], { anthropicFallback: fallback({ fiveHour: { utilization: 42 } }, NOW) }));
        expect(object(empty.anthropic)).toEqual({
            quota_lookup: { status: 'unknown', error: 'quota_api_no_reading', last_attempt_at: '2026-09-09T22:07:00.000Z', source: 'direct_anthropic' },
        });
        expect(object(expired.anthropic)).toEqual({
            quota_lookup: { status: 'unknown', error: 'quota_api_no_reading', last_attempt_at: '2026-09-09T22:07:00.000Z' },
        });
    });

    it('marks a reset bucket expired without showing old headroom', () => {
        const data = renderJson(snapshot([], { anthropicFallback: fallback({ fiveHour: { utilization: 99, resetsAt: NOW } }) }));
        expect(array(object(data.anthropic).quotas)).toEqual([{ id: 'five_hour', window: '5h', status: 'expired' }]);
    });

    it('does not replace a provider snapshot with SDK ledger data', () => {
        const data = renderJson(snapshot([]));
        expect(object(object(data.anthropic).quota_lookup).error).toBe('quota_api_no_reading');
    });
});
