import { describe, expect, it } from 'bun:test';
import { projectQuotaPolled, unifiedAnthropicQuotaId, type VendorSnapshot } from '@/agent/session/provider-snapshot';

const NOW = new Date('2026-09-11T20:00:00Z');
function snapshot(overrides: Partial<VendorSnapshot['providers'][number]> = {}): VendorSnapshot {
    return {
        generatedAt: NOW,
        providers:   [{
            provider:    'anthropic',
            status:      'ok',
            lastAttempt: NOW,
            freshness:   { cached: false, stale: false, ageSeconds: 0 },
            errors:      [],
            quota:       {
                collectedAt: NOW,
                available:   true,
                balances:    [],
                spendLimits: [],
                quotas:      [
                    { id: 'session', bucket: 'five_hour', kind: 'session', usedPercent: 42, resetsAt: new Date(NOW.getTime() + 1000) },
                    { id: 'scope', bucket: 'weekly_scoped', kind: 'weekly_scoped', usedPercent: 84 },
                ],
            },
            ...overrides,
        }],
    };
}
describe('provider quota projection', () => {
    it('files only fresh active unscoped unexpired Anthropic windows at observation time', () => {
        expect(projectQuotaPolled(snapshot(), NOW.getTime())).toEqual({
            type: 'quota_polled', at: NOW, quota: { fiveHour: { utilization: 42, resetsAt: new Date(NOW.getTime() + 1000) } },
        });
        expect(unifiedAnthropicQuotaId('weekly_all', undefined, false)).toBe('seven_day');
        expect(unifiedAnthropicQuotaId('five_hour', undefined, false)).toBe('five_hour');
    });
    it('rejects unavailable, stale, errored and expired observations', () => {
        expect(projectQuotaPolled(snapshot({ freshness: { cached: true, stale: true, ageSeconds: 1 } }), NOW.getTime())).toBeUndefined();
        expect(projectQuotaPolled(snapshot({ errors: [{ section: 'quota', code: 'failure' }] }), NOW.getTime())).toBeUndefined();
        expect(projectQuotaPolled(snapshot({ quota: undefined }), NOW.getTime())).toBeUndefined();
        expect(projectQuotaPolled(snapshot({ quota: { collectedAt: NOW, available: false, balances: [], spendLimits: [], quotas: [] } }), NOW.getTime())).toBeUndefined();
        expect(projectQuotaPolled(snapshot(), NOW.getTime() + 1000)).toBeUndefined();
    });
});
