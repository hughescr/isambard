import { describe, expect, it } from 'bun:test';
import { composeAmbientLines } from '@/agent/session/ambient-lines';
import { initialLedger, type QuotaWindows } from '@/agent/session/ledger';
import type { ProviderBalance, ProviderObservation, ProviderQuota, ProviderSnapshot, ProviderStatus } from '@/agent/session/quota-poller';

const TIMEZONE = 'America/Los_Angeles';
/** Wednesday 2026-09-09, 14:07 in the fixed test timezone. */
const NOW = new Date('2026-09-09T22:07:00Z');
const THU_0900 = new Date('2026-09-10T17:00:00Z');

function observation(overrides: Partial<ProviderObservation> = {}): ProviderObservation {
    return {
        source:        'codex',
        collectedAt:   NOW,
        available:     true,
        quotas:        [],
        balances:      [],
        spendControls: [],
        ...overrides,
    };
}

function provider(overrides: Partial<ProviderStatus> = {}): ProviderStatus {
    return {
        provider:    'codex',
        status:      'ok',
        lastAttempt: NOW,
        freshness:   { cached: false, stale: false, ageSeconds: 0 },
        errors:      [],
        quotaAfter:  observation(),
        ...overrides,
    };
}

function snapshot(providers: readonly ProviderStatus[], overrides: Partial<ProviderSnapshot> = {}): ProviderSnapshot {
    return {
        generatedAt: NOW,
        expiresAt:   new Date(NOW.getTime() + 600_000),
        providers,
        ...overrides,
    };
}

function render(report: ProviderSnapshot, now = NOW): string {
    return composeAmbientLines({ self: initialLedger('conversation'), now, timezone: TIMEZONE, providerSnapshot: report })[0] ?? '';
}

function quota(overrides: Partial<ProviderQuota> = {}): ProviderQuota {
    return { id: 'limit', usedPercent: 35, resetsAt: THU_0900, ...overrides };
}

describe('composeAmbientLines provider quota rendering', () => {
    it.each([
        [1_209_600, '2w'],
        [172_800, '2d'],
        [7200, '2h'],
        [90, '90s'],
    ] as const)('renders a %s-second duration as %s', (durationSeconds, rendered) => {
        const report = snapshot([provider({ quotaAfter: observation({ quotas: [quota({ durationSeconds })] }) })]);

        expect(render(report)).toBe(`Quota: Codex limit [window=${rendered}] 35% used/65% left, resets Thu 09:00 (source 14:07)`);
    });

    it('preserves distinct names, ids, groups, slots, and model and surface scopes', () => {
        const quotas = [
            quota({
                id:    'weekly_primary',
                name:  'Weekly primary',
                group: 'general',
                slot:  'primary',
                scope: { model: { id: 'gpt-5', displayName: 'GPT Five' }, surface: { id: 'chat', displayName: 'Chat UI' } },
            }),
            quota({ id: 'model-id', name: 'model-id', scope: { model: { id: 'o3' }, surface: { id: 'api' } } }),
            quota({ id: 'unknown-scope', scope: { model: {}, surface: {} } }),
        ];

        expect(render(snapshot([provider({ quotaAfter: observation({ quotas }) })]))).toBe(
            'Quota: Codex Weekly primary (weekly_primary) [group=general, slot=primary, model=GPT Five, surface=Chat UI] 35% used/65% left, resets Thu 09:00, '
            + 'model-id [model=o3, surface=api] 35% used/65% left, resets Thu 09:00, '
            + 'unknown-scope [model=unknown, surface=unknown] 35% used/65% left, resets Thu 09:00 (source 14:07)'
        );
    });

    it('renders inactive, expired, and active quota states at the reset boundary', () => {
        const quotas = [
            quota({ id: 'disabled', active: false, group: 'coding' }),
            quota({ id: 'just_expired', resetsAt: NOW }),
            quota({ id: 'active', usedPercent: 35.6, resetsAt: new Date(NOW.getTime() + 1) }),
        ];

        expect(render(snapshot([provider({ quotaAfter: observation({ quotas }) })]))).toBe(
            'Quota: Codex disabled [group=coding] inactive, just_expired expired, active 36% used/64% left, resets 14:07 (source 14:07)'
        );
    });

    it('renders all provider balance states without treating them as quota percentages', () => {
        const balances: ProviderBalance[] = [
            { kind: 'enterprise', scopeId: 'org', unlimited: true },
            { kind: 'prepaid', scopeId: 'team', available: false },
            { kind: 'cash', currency: 'USD', total: '9.35' },
            { kind: 'credits', total: '120', amountUnit: 'credits' },
            { kind: 'requests', total: '40' },
            { kind: 'grant' },
        ];

        expect(render(snapshot([provider({ quotaAfter: observation({ balances }) })]))).toBe(
            'Quota: Codex enterprise (org) unlimited balance, prepaid (team) balance unavailable, cash USD 9.35 balance, '
            + 'credits 120 credits balance, requests 40 units balance, grant balance reported (source 14:07)'
        );
    });

    it('reports empty observations and only reached spend controls', () => {
        const empty = provider({ provider: 'deepseek', quotaAfter: observation({ source: 'deepseek' }) });
        const controlled = provider({ quotaAfter: observation({ spendControls: [{ scopeId: 'soft', reached: false }, { scopeId: 'hard', reached: true }] }) });

        expect(render(snapshot([empty, controlled]))).toBe(
            'Quota: Deepseek no quota or balance reported (source 14:07) · Codex spend control reached (hard) (source 14:07)'
        );
    });
});

describe('composeAmbientLines provider freshness and failures', () => {
    it('ages a cached report from its generation time and marks a partial report', () => {
        const generatedAt = new Date(NOW.getTime() - 30_000);
        const report = snapshot([
            provider({
                status:    'partial',
                freshness: { cached: true, stale: false, ageSeconds: 45 },
            }),
        ], { generatedAt });

        expect(render(report)).toBe('Quota: Codex no quota or balance reported (source 14:07; cached 75s old; partial)');
    });

    it('does not turn a future generation stamp into negative cache age', () => {
        const generatedAt = new Date(NOW.getTime() + 30_000);
        const report = snapshot([
            provider({ freshness: { cached: true, stale: false, ageSeconds: 45 } }),
        ], { generatedAt });

        expect(render(report)).toBe('Quota: Codex no quota or balance reported (source 14:07; cached 45s old)');
    });

    it.each([
        ['stale source', provider({ freshness: { cached: false, stale: true, ageSeconds: 0 } }), undefined, 'Quota: Codex unavailable (stale; ok; 14:07)'],
        ['missing observation', provider({ quotaAfter: undefined }), undefined, 'Quota: Codex unavailable (ok; 14:07)'],
        ['unavailable observation', provider({ quotaAfter: observation({ available: false }) }), undefined, 'Quota: Codex unavailable (ok; 14:07)'],
        ['quota error', provider({ status: 'partial', errors: [{ section: 'quota_after', code: 'unauthorized' }] }), undefined, 'Quota: Codex unavailable (unauthorized; 14:07)'],
        ['report expiry boundary', provider(), NOW, 'Quota: Codex unavailable (stale; ok; 14:07)'],
    ] as const)('renders %s as unavailable', (_case, status, expiresAt, expected) => {
        expect(render(snapshot([status], { expiresAt }))).toBe(expected);
    });

    it('keeps non-quota errors visible through partial status without discarding fresh quota data', () => {
        const status = provider({
            status:     'partial',
            errors:     [{ section: 'balances', code: 'timed_out' }],
            quotaAfter: observation({ quotas: [quota({ resetsAt: undefined })] }),
        });

        expect(render(snapshot([status]))).toBe('Quota: Codex limit 35% used/65% left (source 14:07; partial)');
    });

    it('lists each quota-source failure code while excluding unrelated errors', () => {
        const status = provider({
            status: 'partial',
            errors: [
                { section: 'quota_after', code: 'unauthorized' },
                { section: 'balances', code: 'timed_out' },
                { section: 'quota_after', code: 'malformed' },
            ],
        });

        expect(render(snapshot([status]))).toBe('Quota: Codex unavailable (unauthorized, malformed; 14:07)');
    });

    it('appends the provider-specific shared-subscription note exactly once', () => {
        const report = snapshot([provider()]);
        const line = composeAmbientLines({
            self: initialLedger('conversation'), now: NOW, timezone: TIMEZONE, providerSnapshot: report, sharedQuotaNote: true,
        })[0];

        expect(line).toBe('Quota: Codex no quota or balance reported (source 14:07) · shared subscriptions; provider balances are separate');
    });
});

describe('composeAmbientLines provider burn pace', () => {
    function paceReport(current: ProviderQuota, prior: ProviderQuota, elapsedMs: number, priorCollectedAt?: Date): ProviderSnapshot {
        const previousAt = priorCollectedAt ?? new Date(NOW.getTime() - elapsedMs);
        const previous = snapshot([provider({ quotaAfter: observation({ collectedAt: previousAt, quotas: [prior] }) })], { generatedAt: previousAt });
        return snapshot([provider({ quotaAfter: observation({ quotas: [current] }) })], { previous });
    }

    it('computes positive pace at the exact one-minute boundary', () => {
        const report = paceReport(quota({ usedPercent: 35 }), quota({ usedPercent: 34 }), 60_000);

        expect(render(report)).toContain('+60.0pp/h shared burn');
    });

    it.each([
        ['less than one minute', quota({ usedPercent: 35 }), quota({ usedPercent: 34 }), 59_999, undefined],
        ['unchanged use', quota({ usedPercent: 35 }), quota({ usedPercent: 35 }), 3_600_000, undefined],
        ['falling use', quota({ usedPercent: 34 }), quota({ usedPercent: 35 }), 3_600_000, undefined],
        ['same timestamp', quota({ usedPercent: 35 }), quota({ usedPercent: 34 }), 0, NOW],
        ['later prior timestamp', quota({ usedPercent: 35 }), quota({ usedPercent: 34 }), 0, new Date(NOW.getTime() + 1)],
        ['changed group identity', quota({ usedPercent: 35, group: 'a' }), quota({ usedPercent: 34, group: 'b' }), 3_600_000, undefined],
        ['changed model identity', quota({ usedPercent: 35, scope: { model: { id: 'gpt-5' } } }), quota({ usedPercent: 34, scope: { model: { id: 'o3' } } }), 3_600_000, undefined],
    ] as const)('suppresses pace for %s', (_case, current, prior, elapsedMs, priorCollectedAt) => {
        expect(render(paceReport(current, prior, elapsedMs, priorCollectedAt))).not.toContain('pp/h');
    });

    it('matches the previous sample from the same provider even when provider order changes', () => {
        const previousAt = new Date(NOW.getTime() - 3_600_000);
        const previous = snapshot([
            provider({ provider: 'deepseek', quotaAfter: observation({ source: 'deepseek' }) }),
            provider({ quotaAfter: observation({ collectedAt: previousAt, quotas: [quota({ usedPercent: 25 })] }) }),
        ], { generatedAt: previousAt });
        const report = snapshot([
            provider({ quotaAfter: observation({ quotas: [quota({ usedPercent: 35 })] }) }),
            provider({ provider: 'deepseek', quotaAfter: observation({ source: 'deepseek' }) }),
        ], { previous });

        expect(render(report)).toContain('+10.0pp/h shared burn');
    });

    it('keeps adjacent identity fields distinct when their plain concatenations collide', () => {
        const report = paceReport(
            quota({ id: 'ab', group: 'c', usedPercent: 35 }),
            quota({ id: 'a', group: 'bc', usedPercent: 25 }),
            3_600_000
        );

        expect(render(report)).not.toContain('pp/h');
    });
});

describe('composeAmbientLines direct Anthropic fallback', () => {
    function fallback(windows: QuotaWindows, expiresAt = new Date(NOW.getTime() + 60_000)): ProviderSnapshot['anthropicFallback'] {
        return { collectedAt: NOW, expiresAt, windows };
    }

    it('inserts a fresh direct fallback ahead of provider data when Anthropic is absent', () => {
        const report = snapshot([provider()], {
            anthropicFallback: fallback({ fiveHour: { utilization: 42 }, sevenDay: { utilization: 61, resetsAt: THU_0900 } }),
        });

        expect(render(report)).toBe(
            'Quota: Anthropic fallback (direct) 5-hour 42% used (source 14:07), week 61% used (resets Thu 09:00) (source 14:07) '
            + '· Codex no quota or balance reported (source 14:07)'
        );
    });

    it('uses the direct fallback for an unavailable Anthropic provider but keeps other providers', () => {
        const report = snapshot([
            provider({ provider: 'anthropic', status: 'error', quotaAfter: undefined }),
            provider({ provider: 'deepseek', quotaAfter: observation({ source: 'deepseek' }) }),
        ], { anthropicFallback: fallback({ sevenDay: { utilization: 61 } }) });

        expect(render(report)).toBe(
            'Quota: Anthropic fallback (direct) week 61% used (source 14:07) · Deepseek no quota or balance reported (source 14:07)'
        );
    });

    it.each([
        ['an unavailable observation', provider({ provider: 'anthropic', quotaAfter: observation({ source: 'anthropic', available: false }) }), undefined],
        ['a quota-source error', provider({ provider: 'anthropic', errors: [{ section: 'quota_after', code: 'timed_out' }] }), undefined],
        ['an expired provider report', provider({ provider: 'anthropic' }), NOW],
    ] as const)('uses the direct fallback for %s', (_case, anthropic, expiresAt) => {
        const report = snapshot([anthropic], {
            expiresAt,
            anthropicFallback: fallback({ fiveHour: { utilization: 42 } }),
        });

        expect(render(report)).toBe('Quota: Anthropic fallback (direct) 5-hour 42% used (source 14:07)');
    });

    it('keeps fresh Anthropic provider data instead of replacing it with the direct fallback', () => {
        const anthropic = provider({
            provider:   'anthropic',
            quotaAfter: observation({ source: 'anthropic', quotas: [quota({ id: 'provider-limit', resetsAt: undefined })] }),
        });
        const report = snapshot([anthropic], { anthropicFallback: fallback({ fiveHour: { utilization: 99 } }) });

        expect(render(report)).toBe('Quota: Anthropic provider-limit 35% used/65% left (source 14:07)');
    });

    it('expires the direct fallback at its exact expiry boundary', () => {
        const report = snapshot([], { anthropicFallback: fallback({ fiveHour: { utilization: 42 } }, NOW) });

        expect(render(report)).toBe('Quota: Anthropic fallback unavailable (last attempt 14:07)');
    });

    it('marks a direct fallback quota expired at its reset boundary', () => {
        const report = snapshot([], { anthropicFallback: fallback({ fiveHour: { utilization: 99, resetsAt: NOW } }) });

        expect(render(report)).toBe('Quota: Anthropic fallback (direct) 5-hour expired (source 14:07)');
    });

    it('does not replace the provider report with an SDK ledger fallback of unknown age', () => {
        const report = snapshot([]);
        const self = initialLedger('conversation');
        self.quota = { fiveHour: { utilization: 42 }, source: 'headers', at: NOW };

        expect(composeAmbientLines({ self, now: NOW, timezone: TIMEZONE, providerSnapshot: report })).toEqual([
            'Quota: Anthropic fallback unavailable (last attempt 14:07)',
        ]);
    });
});
