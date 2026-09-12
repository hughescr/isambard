/** Process-wide provider quota polling via utraque, optionally with a direct Anthropic fallback. */
import type { Logger } from '@hughescr/logger';
import { type LedgerStore, type QuotaWindows, fileQuotaWindow, hasQuotaWindow } from './ledger';
import type { Clock, TimerHandle } from './types';

export const DEFAULT_QUOTA_POLL_INTERVAL_MS = 300_000;
export const DEFAULT_QUOTA_RESULT_DEBOUNCE_MS = 30_000;
export const DEFAULT_QUOTA_REQUEST_TIMEOUT_MS = 100_000;
export const DEFAULT_PROVIDER_REPORT_URL = 'http://127.0.0.1:8317/v1/utraque/providers';
export const DEFAULT_ANTHROPIC_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export type AnthropicQuotaSource = 'provider' | 'sdk';

export interface QuotaFetchResponse {
    ok:     boolean
    status: number
    json:   () => Promise<unknown>
}
export type QuotaFetch = (url: string, init: { headers: Record<string, string>, signal?: AbortSignal }) => Promise<QuotaFetchResponse>;

export interface ProviderScopeLabel {
    id?:          string
    displayName?: string
}
export interface ProviderQuota {
    id:               string
    name?:            string
    kind?:            string
    group?:           string
    slot?:            string
    usedPercent:      number
    durationSeconds?: number
    resetsAt?:        Date
    scope?:           { model?: ProviderScopeLabel, surface?: ProviderScopeLabel }
    active?:          boolean
}
export interface ProviderBalance {
    kind:        string
    scopeId?:    string
    currency?:   string
    amountUnit?: string
    total?:      string
    available?:  boolean
    unlimited?:  boolean
}
export interface ProviderObservation {
    source:        string
    collectedAt:   Date
    quotas:        readonly ProviderQuota[]
    balances:      readonly ProviderBalance[]
    spendControls: readonly { scopeId: string, reached: boolean }[]
    available?:    boolean
}
export interface ProviderTokenMix {
    inputTokens:         number
    outputTokens:        number
    cacheCreationTokens: number
    cacheReadTokens:     number
    totalTokens:         number
}
export interface ProviderHistoryModel {
    model:    string
    tokens:   ProviderTokenMix
    costUsd?: number
}
export interface ProviderHistoryBlock {
    startTime:      Date
    endTime:        Date
    active:         boolean
    gap:            boolean
    mixedProvider:  boolean
    modelProviders: readonly string[]
    modelNames:     readonly string[]
    tokens:         ProviderTokenMix
    costUsd?:       number
}
export interface ProviderHistory {
    source:       string
    coverage:     string
    costBasis:    string
    startedAt:    Date
    finishedAt:   Date
    recentSince:  Date
    recentUntil:  Date
    recentDays:   number
    recentTokens: ProviderTokenMix
    recentModels: readonly ProviderHistoryModel[]
    blocks:       readonly ProviderHistoryBlock[]
}
export interface ProviderReferencePrice {
    model:       string
    input:       number
    output:      number
    cacheRead?:  number
    cacheWrite?: number
    eligible:    boolean
}
export interface ProviderReferencePrices {
    source:      'models.dev'
    observedAt:  Date
    stale:       boolean
    unit:        'usd_per_million_tokens'
    models:      readonly ProviderReferencePrice[]
    assumptions: readonly ('base_tier' | 'cache_write_5m')[]
}
export interface ProviderStatus {
    provider:    string
    status:      string
    lastAttempt: Date
    freshness:   { cached: boolean, stale: boolean, ageSeconds: number }
    errors:      readonly { section: string, code: string, retryAt?: Date }[]
    quotaAfter?: ProviderObservation
    history?:    ProviderHistory
    prices?:     ProviderReferencePrices
}
export interface ProviderSnapshot {
    generatedAt:        Date
    providers:          readonly ProviderStatus[]
    expiresAt?:         Date
    previous?:          ProviderSnapshot
    anthropicFallback?: { collectedAt: Date, expiresAt: Date, windows: QuotaWindows }
}

export interface CreateQuotaPollerParams {
    clock:                 Clock
    fetch:                 QuotaFetch
    ledgers:               readonly Pick<LedgerStore, 'dispatch'>[]
    logger:                Pick<Logger, 'debug' | 'warn'>
    url?:                  string
    fallbackUrl?:          string
    headers?:              () => Record<string, string>
    fallbackHeaders?:      () => Record<string, string>
    preferProviderReport?: boolean
    /** `sdk` deliberately excludes Anthropic provider rows, adaptation, and direct HTTP fallback. */
    anthropicQuotaSource?: AnthropicQuotaSource
    pollIntervalMs?:       number
    resultDebounceMs?:     number
    requestTimeoutMs?:     number
}
export interface QuotaPoller {
    start:        () => void
    stop:         () => void
    noteResult:   () => void
    poll:         () => Promise<void>
    getSnapshot?: () => ProviderSnapshot | undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && (
        // Stryker disable next-line ConditionalExpression: current consumers treat null and undefined identically
        value !== null
    ) && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}
function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function booleanValue(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}
function finiteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function tokenCount(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function dateValue(value: unknown): Date | undefined {
    if(typeof value !== 'string') {
        return undefined;
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
function scopeLabel(value: unknown): ProviderScopeLabel | undefined {
    const raw = asRecord(value);
    const id = stringValue(raw?.id);
    const displayName = stringValue(raw?.display_name);
    return id === undefined && displayName === undefined ? undefined : { id, displayName };
}
function providerQuota(value: unknown): ProviderQuota | undefined {
    const raw = asRecord(value);
    const id = stringValue(raw?.id);
    const usedPercent = finiteNumber(raw?.used_percent);
    if(raw === undefined || id === undefined || usedPercent === undefined || usedPercent < 0 || usedPercent > 100 || raw.unit !== 'percent_0_100') {
        return undefined;
    }
    const rawScope = asRecord(raw.scope);
    const model = scopeLabel(rawScope?.model);
    const surface = scopeLabel(rawScope?.surface);
    return {
        id,
        usedPercent,
        name:            stringValue(raw.name),
        kind:            stringValue(raw.kind),
        group:           stringValue(raw.group),
        slot:            stringValue(raw.slot),
        durationSeconds: finiteNumber(raw.duration_seconds),
        resetsAt:        dateValue(raw.resets_at),
        active:          booleanValue(raw.active),
        scope:           model === undefined && surface === undefined ? undefined : { model, surface },
    };
}
function providerBalance(value: unknown): ProviderBalance | undefined {
    const raw = asRecord(value);
    const kind = stringValue(raw?.kind);
    if(kind === undefined) {
        return undefined;
    }
    return {
        kind,
        scopeId:    stringValue(raw?.scope_id),
        currency:   stringValue(raw?.currency),
        amountUnit: stringValue(raw?.amount_unit),
        total:      stringValue(raw?.total),
        available:  booleanValue(raw?.available),
        unlimited:  booleanValue(raw?.unlimited),
    };
}
function providerObservation(value: unknown): ProviderObservation | undefined {
    const raw = asRecord(value);
    const source = stringValue(raw?.source);
    const collectedAt = dateValue(raw?.collected_at);
    if(raw === undefined || source === undefined || collectedAt === undefined) {
        return undefined;
    }
    const quotas = Array.isArray(raw.quotas)
        ? raw.quotas.map(entry => providerQuota(entry)).filter(q => q !== undefined)
        : [];
    const balances = Array.isArray(raw.balances)
        ? raw.balances.map(entry => providerBalance(entry)).filter(b => b !== undefined)
        : [];
    const spendControls = Array.isArray(raw.spend_controls)
        ? raw.spend_controls.flatMap((entry) => {
            const control = asRecord(entry);
            const scopeId = stringValue(control?.scope_id);
            const reached = booleanValue(control?.reached);
            return scopeId === undefined || reached === undefined ? [] : [{ scopeId, reached }];
        })
        : [];
    return { source, collectedAt, quotas, balances, spendControls, available: booleanValue(raw.available) };
}

function tokenMix(value: unknown): ProviderTokenMix | undefined {
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

function addTokenMix(total: ProviderTokenMix, value: ProviderTokenMix): ProviderTokenMix | undefined {
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
    if(status === undefined) {
        return { valid: false };
    }
    if(status !== 'available') {
        return { valid: true };
    }
    const cost = finiteNumber(value?.cost_usd);
    return cost === undefined || cost < 0 ? { valid: false } : { valid: true, value: cost };
}

function historyModel(value: unknown, provider: string): ProviderHistoryModel | undefined {
    const raw = asRecord(value);
    const model = stringValue(raw?.model);
    const modelProvider = stringValue(raw?.provider);
    const tokens = tokenMix(raw);
    const cost = parsedCost(raw);
    return model === undefined || modelProvider !== provider || tokens === undefined || !cost.valid
        ? undefined
        : { model, tokens, costUsd: cost.value };
}

// eslint-disable-next-line complexity -- rejects each independently malformed history-block field
function historyBlock(value: unknown): ProviderHistoryBlock | undefined {
    const raw = asRecord(value);
    const startTime = dateValue(raw?.start_time);
    const endTime = dateValue(raw?.end_time);
    const active = booleanValue(raw?.is_active);
    const gap = booleanValue(raw?.is_gap);
    const mixedProvider = booleanValue(raw?.mixed_provider);
    const tokens = tokenMix(raw);
    const cost = parsedCost(raw);
    if(startTime === undefined || endTime === undefined || startTime >= endTime || active === undefined
      || gap === undefined || mixedProvider === undefined || tokens === undefined || !cost.valid
      || !Array.isArray(raw?.models)) {
        return undefined;
    }
    const modelNames: string[] = [];
    const modelProviders: string[] = [];
    for(const entry of raw.models) {
        const model = asRecord(entry);
        const name = stringValue(model?.model);
        const provider = stringValue(model?.provider);
        if(name === undefined || provider === undefined) {
            return undefined;
        }
        modelNames.push(name);
        modelProviders.push(provider);
    }
    return { startTime, endTime, active, gap, mixedProvider, modelNames, modelProviders, tokens, costUsd: cost.value };
}

// eslint-disable-next-line complexity -- validates report metadata and every aggregate/block before estimates can use them
function providerHistory(value: unknown, provider: string, generatedAt: Date): ProviderHistory | undefined {
    const raw = asRecord(value);
    const source = stringValue(raw?.source);
    const coverage = stringValue(raw?.coverage);
    const costBasis = stringValue(raw?.cost_basis);
    const startedAt = dateValue(raw?.started_at);
    const finishedAt = dateValue(raw?.finished_at);
    const recent = asRecord(raw?.seven_days);
    const recentSince = dateValue(recent?.since);
    const recentUntil = dateValue(recent?.until);
    if(source !== 'ccusage' || coverage !== 'local_only' || costBasis !== 'calculated_api_reference_usd'
      || startedAt === undefined || finishedAt === undefined
      || startedAt > finishedAt || finishedAt > generatedAt || recentSince === undefined || recentUntil === undefined
      || recentUntil.getTime() - recentSince.getTime() !== 6 * 86_400_000 || !Array.isArray(recent?.models)
      || !Array.isArray(raw?.blocks)) {
        return undefined;
    }
    let recentTokens: ProviderTokenMix = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0 };
    const recentModels: ProviderHistoryModel[] = [];
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
    const blocks: ProviderHistoryBlock[] = [];
    for(const entry of raw.blocks) {
        const block = historyBlock(entry);
        if(block === undefined) {
            return undefined;
        }
        blocks.push(block);
    }
    return { source, coverage, costBasis, startedAt, finishedAt, recentSince, recentUntil, recentDays: 7, recentTokens, recentModels, blocks };
}

// eslint-disable-next-line complexity -- every required and optional price category is independently validated
function referencePrice(value: unknown): ProviderReferencePrice | undefined {
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
function providerReferencePrices(value: unknown, generatedAt: Date): ProviderReferencePrices | undefined {
    const raw = asRecord(value);
    const observedAt = dateValue(raw?.observed_at);
    const stale = raw?.stale === undefined ? false : booleanValue(raw.stale);
    const assumptions = referencePriceAssumptions(raw?.assumptions ?? []);
    if(raw?.source !== 'models.dev' || raw.unit !== 'usd_per_million_tokens' || observedAt === undefined || observedAt > generatedAt
      || stale === undefined || !Array.isArray(raw.models) || assumptions === undefined) {
        return undefined;
    }
    const models: ProviderReferencePrice[] = [];
    for(const entry of raw.models) {
        const model = referencePrice(entry);
        if(model === undefined) {
            return undefined;
        }
        models.push(model);
    }
    return {
        source: 'models.dev',
        observedAt,
        stale,
        unit:   'usd_per_million_tokens',
        models,
        assumptions,
    };
}

/** Parse only utraque's schema-v1 contract; unknown or malformed reports fail closed. */
export function parseProviderSnapshot(body: unknown): ProviderSnapshot | undefined {
    const raw = asRecord(body);
    const generatedAt = dateValue(raw?.generated_at);
    if(raw?.schema_version !== 1 || generatedAt === undefined || !Array.isArray(raw.providers)) {
        return undefined;
    }
    // eslint-disable-next-line complexity -- validates all independently optional report fields before admitting a provider
    const providers = raw.providers.flatMap((entry): ProviderStatus[] => {
        const item = asRecord(entry);
        const provider = stringValue(item?.provider);
        const status = stringValue(item?.status);
        const lastAttempt = dateValue(item?.last_attempt);
        const fresh = asRecord(item?.source_freshness);
        const cached = booleanValue(fresh?.cached);
        const stale = booleanValue(fresh?.stale);
        const ageSeconds = finiteNumber(fresh?.age_seconds);
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
                if(section === undefined || code === undefined) {
                    return [];
                }
                return [{ section, code, retryAt }];
            })
            : [];
        const observation = providerObservation(item.quota_after);
        const quotaAfter = observation?.source === provider && observation.collectedAt <= generatedAt ? observation : undefined;
        return [{
            provider, status, lastAttempt, freshness: { cached, stale, ageSeconds }, errors, quotaAfter,
            history:   providerHistory(item.history, provider, generatedAt),
            prices:    providerReferencePrices(item.reference_prices, generatedAt),
        }];
    });
    return providers.length === 0 ? undefined : { generatedAt, providers };
}

export interface ParsedUsage { windows?: QuotaWindows, rejected: boolean }

function unifiedAnthropicQuotaId(id: string | undefined, group: string | undefined, scoped: boolean): string | undefined {
    if(scoped || id === 'weekly_scoped') {
        return undefined;
    }
    if(id === 'five_hour' || id === 'session' || group === 'session') {
        return 'five_hour';
    }
    if(id === 'weekly_all') {
        return 'seven_day';
    }
    if(id === 'seven_day') {
        return id;
    }
    return id?.startsWith('seven_day_') ? id : undefined;
}

/** Direct Anthropic OAuth usage percentages are already 0-100; SDK frames use another parser. */
// eslint-disable-next-line complexity -- accepts both legacy windows and the current limits array while rejecting invalid values independently
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
    for(const [id, value] of Object.entries(raw ?? {})) {
        const entry = asRecord(value);
        add(id, entry?.utilization, entry?.resetsAt ?? entry?.resets_at);
    }
    if(Array.isArray(raw?.limits)) {
        for(const value of raw.limits) {
            const limit = asRecord(value);
            const kind = stringValue(limit?.kind);
            const group = stringValue(limit?.group);
            if(kind === undefined && group !== 'session') {
                continue;
            }
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

function anthropicWindows(observation: ProviderObservation, now: number): QuotaWindows | undefined {
    let windows: QuotaWindows = {};
    for(const quota of observation.quotas) {
        const id = unifiedAnthropicQuotaId(quota.kind ?? quota.id, quota.group, quota.scope?.model !== undefined || quota.scope?.surface !== undefined);
        if(id === undefined || quota.slot !== undefined || quota.active === false || (quota.resetsAt !== undefined && quota.resetsAt.getTime() <= now)) {
            continue;
        }
        windows = fileQuotaWindow(windows, id, { utilization: quota.usedPercent, ...(quota.resetsAt === undefined ? {} : { resetsAt: quota.resetsAt }) });
    }
    return hasQuotaWindow(windows) ? windows : undefined;
}

export function createQuotaPoller(params: CreateQuotaPollerParams): QuotaPoller {
    const { clock, fetch, ledgers, logger, url = DEFAULT_PROVIDER_REPORT_URL, fallbackUrl = DEFAULT_ANTHROPIC_USAGE_URL,
        headers = () => ({}), fallbackHeaders = () => ({}), pollIntervalMs = DEFAULT_QUOTA_POLL_INTERVAL_MS,
        preferProviderReport = true, anthropicQuotaSource = 'provider', resultDebounceMs = DEFAULT_QUOTA_RESULT_DEBOUNCE_MS,
        requestTimeoutMs = DEFAULT_QUOTA_REQUEST_TIMEOUT_MS } = params;
    let timer: TimerHandle | undefined;
    let running = false;
    let inFlight: Promise<void> | undefined;
    let abortController: AbortController | undefined;
    let generation = 0;
    let snapshot: ProviderSnapshot | undefined;
    let lastPollStartedAt = Number.NEGATIVE_INFINITY;
    let warned = false;

    function markSnapshotStale(at: number, attemptGeneration: number): void {
        if(!running || generation !== attemptGeneration || snapshot === undefined) {
            return;
        }
        const elapsed = Math.max(0, (at - snapshot.generatedAt.getTime()) / 1000);
        snapshot = {
            ...snapshot,
            generatedAt:       new Date(at),
            expiresAt:         new Date(at),
            anthropicFallback: undefined,
            providers:         snapshot.providers.map(provider => ({
                ...provider,
                freshness: {
                    ...provider.freshness,
                    stale:      true,
                    ageSeconds: provider.freshness.ageSeconds + elapsed,
                },
            })),
        };
    }

    function dispatch(windows: QuotaWindows, at: Date, attemptGeneration: number): void {
        if(running && generation === attemptGeneration) {
            for(const ledger of ledgers) {
                ledger.dispatch({ type: 'quota_polled', quota: windows, at });
            }
        }
    }
    async function directFallback(signal: AbortSignal, attemptGeneration: number): Promise<void> {
        const response = await fetch(fallbackUrl, { headers: fallbackHeaders(), signal });
        if(!response.ok) {
            markSnapshotStale(clock.now(), attemptGeneration);
            logger.debug({ status: response.status }, 'Quota poll: direct Anthropic fallback returned a non-OK status');
            return;
        }
        const parsed = parseUsageWindows(await response.json());
        if(parsed.rejected && !warned) {
            warned = true;
            logger.warn({ fallbackUrl }, 'Quota poll: direct Anthropic usage response contained an invalid percentage');
        }
        if(parsed.windows === undefined) {
            markSnapshotStale(clock.now(), attemptGeneration);
            return;
        }
        const collectedAt = new Date(clock.now());
        const expiresAt = new Date(clock.now() + pollIntervalMs * 2);
        if(running && generation === attemptGeneration) {
            snapshot = snapshot === undefined
                ? { generatedAt: collectedAt, providers: [], expiresAt, anthropicFallback: { collectedAt, expiresAt, windows: parsed.windows } }
                : { ...snapshot, anthropicFallback: { collectedAt, expiresAt, windows: parsed.windows } };
        }
        dispatch(parsed.windows, collectedAt, attemptGeneration);
    }
    // eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- one bounded attempt coordinates preferred/fallback fetch, validation, lifecycle generation and ledger adaptation
    async function pollOnce(): Promise<void> {
        lastPollStartedAt = clock.now();
        const controller = new AbortController();
        abortController = controller;
        const attemptGeneration = generation;
        const timeout = clock.setTimer(() => controller.abort(), requestTimeoutMs);
        try {
            if(!preferProviderReport) {
                if(anthropicQuotaSource === 'sdk') {
                    return;
                }
                await directFallback(controller.signal, attemptGeneration);
                return;
            }
            let useFallback = false;
            try {
                const response = await fetch(url, { headers: headers(), signal: controller.signal });
                if(response.ok) {
                    const parsed = parseProviderSnapshot(await response.json());
                    if(parsed === undefined) {
                        markSnapshotStale(clock.now(), attemptGeneration);
                        logger.debug('Quota poll: utraque provider report was not valid schema version 1');
                    } else if(running && generation === attemptGeneration) {
                        const currentSnapshot = snapshot;
                        const previous = currentSnapshot === undefined
                            ? undefined
                            : {
                                generatedAt: currentSnapshot.generatedAt,
                                providers:   currentSnapshot.providers,
                                expiresAt:   currentSnapshot.expiresAt,
                            };
                        snapshot = {
                            ...parsed,
                            expiresAt: new Date(clock.now() + pollIntervalMs * 2),
                            previous,
                        };
                        if(anthropicQuotaSource === 'provider') {
                            const anthropic = parsed.providers.find(provider => provider.provider === 'anthropic');
                            const observation = anthropic?.quotaAfter;
                            const fresh = anthropic !== undefined && !anthropic.freshness.stale
                              && observation?.source === 'anthropic' && observation.available !== false
                              && !anthropic.errors.some(error => error.section === 'quota_after');
                            if(fresh) {
                                const windows = anthropicWindows(observation, clock.now());
                                if(windows !== undefined) {
                                    dispatch(windows, observation.collectedAt, attemptGeneration);
                                }
                            }
                        }
                    }
                } else {
                    logger.debug({ status: response.status }, 'Quota poll: utraque provider report returned a non-OK status');
                    markSnapshotStale(clock.now(), attemptGeneration);
                    useFallback = anthropicQuotaSource === 'provider'
                      && (response.status === 404 || response.status === 405 || response.status >= 500);
                }
            } catch (error) {
                if(controller.signal.aborted) {
                    throw error;
                }
                markSnapshotStale(clock.now(), attemptGeneration);
                useFallback = anthropicQuotaSource === 'provider';
                logger.debug(
                    { errorName: error instanceof Error ? error.name : 'unknown' },
                    useFallback
                        ? 'Quota poll: utraque provider report failed; trying direct Anthropic fallback'
                        : 'Quota poll: utraque provider report failed'
                );
            }
            if(useFallback && running && generation === attemptGeneration) {
                await directFallback(controller.signal, attemptGeneration);
            }
        } catch (error) {
            markSnapshotStale(clock.now(), attemptGeneration);
            logger.debug({ errorName: error instanceof Error ? error.name : 'unknown' }, 'Quota poll failed; keeping the last known readings');
        } finally {
            clock.clearTimer(timeout);
            abortController = undefined;
        }
    }
    function poll(): Promise<void> {
        if(inFlight !== undefined) {
            return inFlight;
        }
        const run = pollOnce().finally(() => {
            inFlight = undefined;
        });
        inFlight = run;
        return run;
    }
    function scheduleNext(): void {
        timer = clock.setTimer(() => {
            timer = undefined;
            scheduleNext();
            void poll();
        }, pollIntervalMs);
    }
    return {
        start: () => {
            if(!running) {
                generation += 1;
                running = true;
                scheduleNext();
                if(inFlight === undefined) {
                    void poll();
                } else {
                    void inFlight.finally(() => {
                        if(running) {
                            void poll();
                        }
                    });
                }
            }
        },
        stop: () => {
            generation += 1;
            running = false;
            abortController?.abort();
            abortController = undefined;
            if(timer !== undefined) {
                clock.clearTimer(timer);
                timer = undefined;
            }
        },
        noteResult: () => {
            if(running && clock.now() - lastPollStartedAt >= resultDebounceMs) {
                void poll();
            }
        },
        poll,
        getSnapshot: () => snapshot,
    };
}
