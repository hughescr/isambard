/** Direct Anthropic OAuth usage response, separate from SDK rate-limit frames. */
import { fileQuotaWindow, hasQuotaWindow, unifiedAnthropicQuotaId, type QuotaWindows } from '@/agent';
import { asRecord, booleanValue, dateValue, finiteNumber, scopeLabel, stringValue, type QuotaFetch } from '@/utils';

export const DEFAULT_ANTHROPIC_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export interface ParsedUsage { windows?: QuotaWindows, rejected: boolean }

// eslint-disable-next-line complexity -- accepts legacy windows and limits while rejecting invalid percentages independently
export function parseUsageWindows(body: unknown): ParsedUsage {
    const raw = asRecord(body);
    let windows: QuotaWindows = {};
    let rejected = false;
    const add = (id: string, percent: unknown, reset: unknown): void => {
        if(percent === undefined) {
            return;
        }
        const used = finiteNumber(percent);
        if(id.length === 0 || used === undefined || used < 0 || used > 100) {
            rejected = true;
            return;
        }
        const resetsAt = typeof reset === 'number' ? new Date(reset * 1000) : dateValue(reset);
        windows = fileQuotaWindow(windows, id, { utilization: used, ...(resetsAt === undefined ? {} : { resetsAt }) });
    };
    // Stryker disable next-line llm: asRecord returns a truthy record or undefined, making nullish and falsy fallback identical here.
    for(const [id, value] of Object.entries(raw ?? {})) {
        const entry = asRecord(value);
        add(id, entry?.utilization, entry?.resetsAt ?? entry?.resets_at);
    }
    if(Array.isArray(raw?.limits)) {
        for(const value of raw.limits) {
            const limit = asRecord(value);
            const kind = stringValue(limit?.kind);
            const group = stringValue(limit?.group);
            const scope = asRecord(limit?.scope);
            const scoped = scopeLabel(scope?.model) !== undefined || scopeLabel(scope?.surface) !== undefined;
            const id = unifiedAnthropicQuotaId(kind, group, scoped);
            if(id !== undefined && booleanValue(limit?.is_active) !== false) {
                add(id, limit?.percent, limit?.resets_at);
            }
        }
    }
    return { windows: hasQuotaWindow(windows) ? windows : undefined, rejected };
}

/** No catch: network, body parsing, and abort failures retain their original semantics. */
export async function fetchUsageFallback(fetch: QuotaFetch, url: string, signal: AbortSignal, headers: Record<string, string>): Promise<
    { kind: 'valid', usage: ParsedUsage } | { kind: 'http-error', status: number }
> {
    const response = await fetch(url, { headers, signal });
    if(!response.ok) {
        return { kind: 'http-error', status: response.status };
    }
    return { kind: 'valid', usage: parseUsageWindows(await response.json()) };
}
