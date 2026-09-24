/** Utraque provider-report schema 2 wire adapter. */
import type { VendorQuotaKind, VendorQuota, VendorBalance, VendorSpendLimit, VendorObservation, VendorTokenMix, VendorHistoryModel, VendorHistoryBlock, VendorHistory, VendorReferencePrice, VendorReferencePrices, VendorStatus, VendorSnapshot } from '@/agent';
import { asRecord, stringValue, booleanValue, finiteNumber, dateValue, scopeLabel, type QuotaFetch } from '@/utils';

export const DEFAULT_VENDOR_REPORT_URL = 'http://127.0.0.1:8317/utraque/providers/v2';
const VENDOR_QUOTA_KINDS: readonly VendorQuotaKind[] = ['session', 'weekly', 'weekly_scoped', 'other'];

function tokenCount(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function quotaKind(value: unknown): VendorQuotaKind | undefined {
    return VENDOR_QUOTA_KINDS.find(kind => kind === value);
}
function percentValue(value: unknown, unit: unknown): number | undefined {
    const percent = finiteNumber(value);
    return unit === 'percent_0_100' && percent !== undefined && percent >= 0 && percent <= 100 ? percent : undefined;
}
function providerQuota(value: unknown): VendorQuota | undefined {
    const raw = asRecord(value);
    const id = stringValue(raw?.id);
    const bucket = stringValue(raw?.bucket);
    const kind = quotaKind(raw?.kind);
    const usedPercent = percentValue(raw?.used_percent, raw?.unit);
    if(raw === undefined || id === undefined || bucket === undefined || kind === undefined || usedPercent === undefined) {
        return undefined;
    }
    const rawScope = asRecord(raw.scope);
    const model = scopeLabel(rawScope?.model);
    const surface = scopeLabel(rawScope?.surface);
    return {
        id,
        bucket,
        kind,
        usedPercent,
        name:            stringValue(raw.name),
        group:           stringValue(raw.group),
        slot:            stringValue(raw.slot),
        durationSeconds: finiteNumber(raw.duration_seconds),
        resetsAt:        dateValue(raw.resets_at),
        active:          booleanValue(raw.active),
        scope:           model === undefined && surface === undefined ? undefined : { model, surface },
    };
}
function providerBalance(value: unknown): VendorBalance | undefined {
    const raw = asRecord(value);
    const kind = stringValue(raw?.kind);
    if(kind === undefined) {
        return undefined;
    }
    return {
        kind,
        limitId:    stringValue(raw?.limit_id),
        currency:   stringValue(raw?.currency),
        amountUnit: stringValue(raw?.amount_unit),
        remaining:  stringValue(raw?.remaining),
        available:  booleanValue(raw?.available),
        unlimited:  booleanValue(raw?.unlimited),
    };
}
function providerSpendLimit(value: unknown): VendorSpendLimit | undefined {
    const raw = asRecord(value);
    if(raw === undefined) {
        return undefined;
    }
    return {
        limitId:     stringValue(raw.limit_id),
        enabled:     booleanValue(raw.enabled),
        limit:       stringValue(raw.limit),
        used:        stringValue(raw.used),
        amountUnit:  stringValue(raw.amount_unit),
        currency:    stringValue(raw.currency),
        usedPercent: percentValue(raw.used_percent, raw.unit),
        resetsAt:    dateValue(raw.resets_at),
        reached:     booleanValue(raw.reached),
    };
}
function providerObservation(value: unknown): VendorObservation | undefined {
    const raw = asRecord(value);
    const collectedAt = dateValue(raw?.collected_at);
    if(raw === undefined || collectedAt === undefined) {
        return undefined;
    }
    const quotas = Array.isArray(raw.quotas)
        ? raw.quotas.map(entry => providerQuota(entry)).filter(q => q !== undefined)
        : [];
    const balances = Array.isArray(raw.balances)
        ? raw.balances.map(entry => providerBalance(entry)).filter(b => b !== undefined)
        : [];
    const spendLimits = Array.isArray(raw.spend_limits)
        ? raw.spend_limits.map(entry => providerSpendLimit(entry)).filter(limit => limit !== undefined)
        : [];
    return { collectedAt, quotas, balances, spendLimits, available: booleanValue(raw.available) };
}

function tokenMix(value: unknown): VendorTokenMix | undefined {
    const raw = asRecord(value);
    const inputTokens = tokenCount(raw?.input_tokens);
    const outputTokens = tokenCount(raw?.output_tokens);
    const cacheCreationTokens = tokenCount(raw?.cache_creation_tokens);
    const cacheReadTokens = tokenCount(raw?.cache_read_tokens);
    if(inputTokens === undefined || outputTokens === undefined || cacheCreationTokens === undefined || cacheReadTokens === undefined) {
        return undefined;
    }
    const totalTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;
    const reportedTotal = tokenCount(raw?.total_tokens);
    return Number.isSafeInteger(totalTokens) && (reportedTotal === undefined || reportedTotal === totalTokens)
        ? { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, totalTokens }
        : undefined;
}

function addTokenMix(total: VendorTokenMix, value: VendorTokenMix): VendorTokenMix | undefined {
    return tokenMix({
        input_tokens:          total.inputTokens + value.inputTokens,
        output_tokens:         total.outputTokens + value.outputTokens,
        cache_creation_tokens: total.cacheCreationTokens + value.cacheCreationTokens,
        cache_read_tokens:     total.cacheReadTokens + value.cacheReadTokens,
    });
}

function isSparkHistoryModel(provider: string, model: string): boolean {
    const normalized = model.toLowerCase();
    return provider === 'codex' && (normalized === 'gpt-5.3-codex-spark' || normalized === 'codex_bengalfox');
}

interface ParsedCost { valid: boolean, value?: number }

function parsedCost(value: Record<string, unknown> | undefined): ParsedCost {
    const status = stringValue(value?.cost_status);
    // Stryker disable next-line llm: stringValue returns undefined or a non-empty string, so !status and status === undefined accept the same inputs.
    if(status === undefined) {
        return { valid: false };
    }
    if(status !== 'available') {
        return { valid: true };
    }
    const cost = finiteNumber(value?.cost_usd);
    // Stryker disable next-line llm: finiteNumber yields undefined or a finite number, so this predicate and its De Morgan complement are identical here.
    return cost === undefined || cost < 0 ? { valid: false } : { valid: true, value: cost };
}

function historyModel(value: unknown, provider: string): VendorHistoryModel | undefined {
    const raw = asRecord(value);
    const model = stringValue(raw?.model);
    const modelVendor = stringValue(raw?.provider);
    const tokens = tokenMix(raw);
    const cost = parsedCost(raw);
    return model === undefined || modelVendor !== provider || tokens === undefined || !cost.valid
        ? undefined
        : { model, tokens, costUsd: cost.value };
}

// eslint-disable-next-line complexity -- rejects each independently malformed history-block field
function historyBlock(value: unknown): VendorHistoryBlock | undefined {
    const raw = asRecord(value);
    const startTime = dateValue(raw?.start_time);
    const endTime = dateValue(raw?.end_time);
    const active = booleanValue(raw?.is_active);
    const gap = booleanValue(raw?.is_gap);
    const mixedVendor = booleanValue(raw?.mixed_provider);
    const tokens = tokenMix(raw);
    const cost = parsedCost(raw);
    if(startTime === undefined || endTime === undefined || startTime >= endTime || active === undefined
      || gap === undefined || mixedVendor === undefined || tokens === undefined || !cost.valid
      || !Array.isArray(raw?.models)) {
        return undefined;
    }
    const modelNames: string[] = [];
    const modelVendors: string[] = [];
    for(const entry of raw.models) {
        const model = asRecord(entry);
        const name = stringValue(model?.model);
        const provider = stringValue(model?.provider);
        if(name === undefined || provider === undefined) {
            return undefined;
        }
        modelNames.push(name);
        modelVendors.push(provider);
    }
    return { startTime, endTime, active, gap, mixedVendor, modelNames, modelVendors, tokens, costUsd: cost.value };
}

// eslint-disable-next-line complexity -- validates report metadata and every aggregate/block before estimates can use them
function providerHistory(value: unknown, provider: string, generatedAt: Date): VendorHistory | undefined {
    const raw = asRecord(value);
    const coverage = stringValue(raw?.coverage);
    const costBasis = stringValue(raw?.cost_basis);
    const startedAt = dateValue(raw?.started_at);
    const finishedAt = dateValue(raw?.finished_at);
    const recent = asRecord(raw?.seven_days);
    const recentSince = dateValue(recent?.since);
    const recentUntil = dateValue(recent?.until);
    if(raw?.collector !== 'ccusage' || coverage !== 'local_only' || costBasis !== 'calculated_api_reference_usd'
      || startedAt === undefined || finishedAt === undefined
      || startedAt > finishedAt || finishedAt > generatedAt || recentSince === undefined || recentUntil === undefined
      || recentUntil.getTime() - recentSince.getTime() !== 6 * 86_400_000 || !Array.isArray(recent?.models)
      || !Array.isArray(raw.blocks)) {
        return undefined;
    }
    let recentTokens: VendorTokenMix = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0 };
    const recentModels: VendorHistoryModel[] = [];
    for(const entry of recent.models) {
        const model = historyModel(entry, provider);
        if(model === undefined) {
            return undefined;
        }
        if(!isSparkHistoryModel(provider, model.model)) {
            const next = addTokenMix(recentTokens, model.tokens);
            if(next === undefined) {
                return undefined;
            }
            recentTokens = next;
            recentModels.push(model);
        }
    }
    const blocks: VendorHistoryBlock[] = [];
    for(const entry of raw.blocks) {
        const block = historyBlock(entry);
        if(block === undefined) {
            return undefined;
        }
        blocks.push(block);
    }
    return { collector: 'ccusage', coverage, costBasis, startedAt, finishedAt, recentSince, recentUntil, recentDays: 7, recentTokens, recentModels, blocks };
}

// eslint-disable-next-line complexity -- every required and optional price category is independently validated
function referencePrice(value: unknown): VendorReferencePrice | undefined {
    const raw = asRecord(value);
    const model = stringValue(raw?.model);
    const input = finiteNumber(raw?.input);
    const output = finiteNumber(raw?.output);
    const cacheRead = finiteNumber(raw?.cache_read);
    const cacheWrite = finiteNumber(raw?.cache_write);
    const eligible = booleanValue(raw?.eligible);
    if(model === undefined || input === undefined || input <= 0 || output === undefined || output <= 0
      || eligible === undefined || (cacheRead !== undefined && cacheRead <= 0)
      || (cacheWrite !== undefined && cacheWrite <= 0)) {
        return undefined;
    }
    return { model, input, output, cacheRead, cacheWrite, eligible };
}

type ReferencePriceAssumption = 'base_tier' | 'cache_write_5m';

function referencePriceAssumptions(value: unknown): ReferencePriceAssumption[] | undefined {
    if(!Array.isArray(value)) {
        return undefined;
    }
    const assumptions: ReferencePriceAssumption[] = [];
    const entries: readonly unknown[] = value;
    for(const assumption of entries) {
        if(assumption !== 'base_tier' && assumption !== 'cache_write_5m') {
            return undefined;
        }
        assumptions.push(assumption);
    }
    return assumptions;
}

// eslint-disable-next-line complexity -- validates independently optional freshness and each model price row
function providerReferencePrices(value: unknown, generatedAt: Date): VendorReferencePrices | undefined {
    const raw = asRecord(value);
    const observedAt = dateValue(raw?.observed_at);
    const stale = raw?.stale === undefined ? false : booleanValue(raw.stale);
    const assumptions = referencePriceAssumptions(raw?.assumptions ?? []);
    // Stryker disable llm: the preceding raw?.catalog clause short-circuits when raw is undefined, so raw.models is only read on a defined record.
    if(raw?.catalog !== 'models.dev' || raw.unit !== 'usd_per_million_tokens' || observedAt === undefined || observedAt > generatedAt
      || stale === undefined || !Array.isArray(raw.models) || assumptions === undefined) {
        return undefined;
    }
    // Stryker restore llm
    const models: VendorReferencePrice[] = [];
    for(const entry of raw.models) {
        const model = referencePrice(entry);
        if(model === undefined) {
            return undefined;
        }
        models.push(model);
    }
    return {
        catalog: 'models.dev',
        observedAt,
        stale,
        unit:    'usd_per_million_tokens',
        models,
        assumptions,
    };
}

/** Parse only utraque's provider-report schema 2 (`/utraque/providers/v2`); schema 1 and malformed reports fail closed. */
export function parseVendorSnapshot(body: unknown): VendorSnapshot | undefined {
    const raw = asRecord(body);
    const generatedAt = dateValue(raw?.generated_at);
    if(raw?.schema_version !== 2 || generatedAt === undefined || !Array.isArray(raw.providers)) {
        return undefined;
    }
    // eslint-disable-next-line complexity -- validates all independently optional report fields before admitting a provider
    const providers = raw.providers.flatMap((entry): VendorStatus[] => {
        const item = asRecord(entry);
        // Stryker disable next-line llm: stringValue maps every falsy non-string and the empty-string fallback to the same undefined result.
        const provider = stringValue(item?.provider);
        const status = stringValue(item?.status);
        const lastAttempt = dateValue(item?.last_attempt);
        const fresh = asRecord(item?.source_freshness);
        const cached = booleanValue(fresh?.cached);
        const stale = booleanValue(fresh?.stale);
        const ageSeconds = finiteNumber(fresh?.age_seconds);
        // Stryker disable next-line llm: asRecord/stringValue return a defined value or undefined, never null, so strict and loose undefined checks coincide.
        if(item === undefined || provider === undefined || status === undefined || lastAttempt === undefined
          || lastAttempt > generatedAt || cached === undefined || stale === undefined
          || ageSeconds === undefined || ageSeconds < 0) {
            return [];
        }
        const errors = Array.isArray(item.errors)
            ? item.errors.flatMap((errorEntry) => {
                const error = asRecord(errorEntry);
                const section = stringValue(error?.section);
                const code = stringValue(error?.code);
                const retryAt = dateValue(error?.retry_at);
                const attemptedAt = dateValue(error?.attempted_at);
                // Stryker disable next-line llm: stringValue returns a non-empty string or undefined, never null, so strict and loose undefined checks coincide.
                if(section === undefined || code === undefined) {
                    return [];
                }
                return [{ section, code, retryAt, attemptedAt }];
            })
            : [];
        const observation = providerObservation(item.quota);
        const quota = observation !== undefined && observation.collectedAt <= generatedAt ? observation : undefined;
        return [{
            provider, status, lastAttempt, freshness: { cached, stale, ageSeconds }, errors, quota,
            history:   providerHistory(item.history, provider, generatedAt),
            prices:    providerReferencePrices(item.reference_prices, generatedAt),
        }];
    });
    return providers.length === 0 ? undefined : { generatedAt, providers };
}

/** Network and JSON failures, including aborts, propagate to the lifecycle coordinator. */
export async function fetchVendorSnapshot(fetch: QuotaFetch, url: string, signal: AbortSignal, headers: Record<string, string>): Promise<
    { kind: 'valid', snapshot: VendorSnapshot } | { kind: 'invalid-schema' } | { kind: 'http-error', status: number }
> {
    const response = await fetch(url, { headers, signal });
    if(!response.ok) {
        return { kind: 'http-error', status: response.status };
    }
    const snapshot = parseVendorSnapshot(await response.json());
    return snapshot === undefined ? { kind: 'invalid-schema' } : { kind: 'valid', snapshot };
}
