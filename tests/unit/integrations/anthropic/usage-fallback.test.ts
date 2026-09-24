import { describe, expect, it, jest } from 'bun:test';
import { DEFAULT_ANTHROPIC_USAGE_URL, fetchUsageFallback, parseUsageWindows } from '@/integrations/anthropic';
import type { QuotaFetch } from '@/utils';

describe('Anthropic direct usage adapter', () => {
    it('uses the official usage endpoint and preserves percentage units for legacy windows', () => {
        expect(DEFAULT_ANTHROPIC_USAGE_URL).toBe('https://api.anthropic.com/api/oauth/usage');
        expect(parseUsageWindows({ five_hour: { utilization: 0.42 }, seven_day: { utilization: 87 } })).toEqual({
            windows: { fiveHour: { utilization: 0.42 }, sevenDay: { utilization: 87 } }, rejected: false,
        });
    });
    it('maps unscoped limits but excludes inactive and model-scoped limits', () => {
        expect(parseUsageWindows({ limits: [
            { kind: 'session', group: 'session', percent: 31.5, resets_at: '2026-09-11T22:00:00Z' },
            { kind: 'session', group: 'session', percent: 95, is_active: false },
            { kind: 'weekly_all', group: 'weekly', percent: 35 },
            { kind: 'weekly_scoped', percent: 90, scope: { model: { id: 'opus' } } },
        ] })).toEqual({
            windows:  { fiveHour: { utilization: 31.5, resetsAt: new Date('2026-09-11T22:00:00Z') }, sevenDay: { utilization: 35 } },
            rejected: false,
        });
    });
    it('rejects invalid known percentages while ignoring unknown limit kinds', () => {
        expect(parseUsageWindows({ five_hour: { utilization: -0.01 }, seven_day: { utilization: 100.01 } }))
            .toEqual({ windows: undefined, rejected: true });
        expect(parseUsageWindows({ five_hour: { utilization: null } })).toEqual({ windows: undefined, rejected: true });
        expect(parseUsageWindows({ limits: [{ kind: 'unknown', percent: 101 }] })).toEqual({ windows: undefined, rejected: false });
    });
    it('normalizes direct limits with the same provider identities', () => {
        expect(parseUsageWindows({ limits: [{ kind: 'weekly_all', percent: 13 }] }).windows).toEqual({ sevenDay: { utilization: 13 } });
    });
    it('passes exact URL, headers and signal; returns non-OK status', async () => {
        const fetch = jest.fn<QuotaFetch>(async () => ({ ok: false, status: 405, json: async () => ({}) }));
        const signal = new AbortController().signal;
        expect(await fetchUsageFallback(fetch, 'https://example.test/usage', signal, { Authorization: 'Bearer secret' })).toEqual({ kind: 'http-error', status: 405 });
        expect(fetch).toHaveBeenCalledWith('https://example.test/usage', { signal, headers: { Authorization: 'Bearer secret' } });
    });
    it('propagates fetch and JSON failures unchanged', async () => {
        const error = new Error('network');
        const signal = new AbortController().signal;
        await expect(fetchUsageFallback(async () => {
            throw error;
        }, 'x', signal, {})).rejects.toBe(error);
        await expect(fetchUsageFallback(async () => ({ ok:     true, status: 200, json:   async () => {
            throw error;
        } }), 'x', signal, {})).rejects.toBe(error);
    });
});
