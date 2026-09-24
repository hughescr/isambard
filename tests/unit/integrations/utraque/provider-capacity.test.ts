import { describe, expect, it, jest } from 'bun:test';
import { DEFAULT_VENDOR_REPORT_URL, fetchVendorSnapshot, parseVendorSnapshot } from '@/integrations/utraque';
import type { QuotaFetch } from '@/utils';

describe('utraque provider capacity adapter', () => {
    const generatedAt = '2026-09-11T20:00:01Z';
    const report = (overrides: Record<string, unknown> = {}) => ({
        schema_version: 2,
        generated_at:   generatedAt,
        providers:      [{
            provider:         'anthropic',
            status:           'ok',
            last_attempt:     generatedAt,
            source_freshness: { cached: false, stale: false, age_seconds: 0 },
            errors:           [],
            quota:            { collected_at: generatedAt, quotas:       [
                { id: 'session', bucket: 'session', kind: 'session', used_percent: 31.5, unit: 'percent_0_100' },
            ] },
            ...overrides,
        }],
    });

    it('uses the documented local report endpoint and fails closed on all other schema versions', () => {
        expect(DEFAULT_VENDOR_REPORT_URL).toBe('http://127.0.0.1:8317/utraque/providers/v2');
        expect(parseVendorSnapshot(report())?.providers[0]?.quota?.quotas[0]?.usedPercent).toBe(31.5);
        expect(parseVendorSnapshot({ ...report(), schema_version: 1 })).toBeUndefined();
        expect(parseVendorSnapshot({ ...report(), schema_version: 3 })).toBeUndefined();
        expect(parseVendorSnapshot({ ...report(), schema_version: '2' })).toBeUndefined();
    });

    it('preserves scoped quota identities and monetary balances without projecting away provider details', () => {
        const parsed = parseVendorSnapshot(report({ quota: {
            collected_at: generatedAt,
            quotas:       [{ id:               'weekly_scoped:model=opus', bucket:           'weekly_scoped', kind:             'weekly_scoped', used_percent:     5,
                unit:             'percent_0_100', duration_seconds: 604_800, scope:            { model: { id: 'opus', display_name: 'Opus' } } }],
            balances:     [{ kind: 'workspace_credits', limit_id: 'codex', remaining: '0', amount_unit: 'credits', available: false }],
            spend_limits: [{ limit_id: 'codex', reached: false }],
        } }));
        expect(parsed?.providers[0]?.quota).toMatchObject({
            quotas:      [{ id: 'weekly_scoped:model=opus', durationSeconds: 604_800, scope: { model: { id: 'opus', displayName: 'Opus' } } }],
            balances:    [{ kind: 'workspace_credits', limitId: 'codex', remaining: '0', amountUnit: 'credits', available: false }],
            spendLimits: [{ limitId: 'codex', reached: false }],
        });
    });

    it('rejects malformed provider metadata and out-of-range or non-percent quota rows independently', () => {
        expect(parseVendorSnapshot(report({ provider: '' }))).toBeUndefined();
        expect(parseVendorSnapshot(report({ last_attempt: '2026-09-11T20:00:02Z' }))).toBeUndefined();
        expect(parseVendorSnapshot(report({ source_freshness: { cached: false, stale: false, age_seconds: -1 } }))).toBeUndefined();
        const parsed = parseVendorSnapshot(report({ quota: { collected_at: generatedAt, quotas:       [
            { id: 'empty', bucket: 'session', kind: 'session', used_percent: 0, unit: 'percent_0_100' },
            { id: 'full', bucket: 'session', kind: 'session', used_percent: 100, unit: 'percent_0_100' },
            { id: 'negative', bucket: 'session', kind: 'session', used_percent: -1, unit: 'percent_0_100' },
            { id: 'fraction', bucket: 'session', kind: 'session', used_percent: 0.5, unit: 'fraction_0_1' },
        ] } }));
        expect(parsed?.providers[0]?.quota?.quotas.map(quota => [quota.id, quota.usedPercent])).toEqual([['empty', 0], ['full', 100]]);
    });

    it('distinguishes invalid schema and non-OK response', async () => {
        const signal = new AbortController().signal;
        const fetch = jest.fn<QuotaFetch>(async () => ({ ok: true, status: 200, json: async () => ({ schema_version: 1 }) }));
        expect(await fetchVendorSnapshot(fetch, 'http://localhost/report', signal, { 'X-Utraque-Token': 'secret' })).toEqual({ kind: 'invalid-schema' });
        expect(fetch).toHaveBeenCalledWith('http://localhost/report', { signal, headers: { 'X-Utraque-Token': 'secret' } });
        fetch.mockImplementation(async () => ({ ok: false, status: 499, json: async () => ({}) }));
        expect(await fetchVendorSnapshot(fetch, 'http://localhost/report', signal, {})).toEqual({ kind: 'http-error', status: 499 });
    });
    it('propagates fetch and JSON failures unchanged', async () => {
        const error = new Error('body');
        const signal = new AbortController().signal;
        await expect(fetchVendorSnapshot(async () => {
            throw error;
        }, 'x', signal, {})).rejects.toBe(error);
        await expect(fetchVendorSnapshot(async () => ({ ok:     true, status: 200, json:   async () => {
            throw error;
        } }), 'x', signal, {})).rejects.toBe(error);
    });
});
