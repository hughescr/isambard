import { describe, expect, it } from 'bun:test';
import { composeAmbientLines } from '@/agent/session/ambient-lines';
import { initialLedger, type QuotaWindows } from '@/agent/session/ledger';
import type { ProviderBalance, ProviderObservation, ProviderQuota, ProviderSnapshot, ProviderStatus } from '@/agent/session/quota-poller';

const TIMEZONE = 'America/Los_Angeles';
const NOW = new Date('2026-09-09T22:07:00Z');
const THU_0900 = new Date('2026-09-10T17:00:00Z');

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
        const noReset = providerJson(paceReport(quota({ resetsAt: undefined }), quota({ resetsAt: undefined }), 3_600_000));
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
