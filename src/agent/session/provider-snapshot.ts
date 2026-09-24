import { type LedgerEvent, type QuotaWindows, fileQuotaWindow, hasQuotaWindow } from './ledger';

export type AnthropicQuotaSource = 'provider' | 'sdk';
export interface VendorScopeLabel { id?: string, displayName?: string }
export type VendorQuotaKind = 'session' | 'weekly' | 'weekly_scoped' | 'other';
export interface VendorQuota {
    id:               string
    bucket:           string
    kind:             VendorQuotaKind
    name?:            string
    group?:           string
    slot?:            string
    usedPercent:      number
    durationSeconds?: number
    resetsAt?:        Date
    scope?:           { model?: VendorScopeLabel, surface?: VendorScopeLabel }
    active?:          boolean
}
export interface VendorBalance {
    kind:        string
    limitId?:    string
    currency?:   string
    amountUnit?: string
    remaining?:  string
    available?:  boolean
    unlimited?:  boolean
}
export interface VendorSpendLimit {
    limitId?:     string
    enabled?:     boolean
    limit?:       string
    used?:        string
    amountUnit?:  string
    currency?:    string
    usedPercent?: number
    resetsAt?:    Date
    reached?:     boolean
}
export interface VendorObservation {
    collectedAt: Date
    quotas:      readonly VendorQuota[]
    balances:    readonly VendorBalance[]
    spendLimits: readonly VendorSpendLimit[]
    available?:  boolean
}
export interface VendorTokenMix {
    inputTokens:         number
    outputTokens:        number
    cacheCreationTokens: number
    cacheReadTokens:     number
    totalTokens:         number
}
export interface VendorHistoryModel { model: string, tokens: VendorTokenMix, costUsd?: number }
export interface VendorHistoryBlock {
    startTime:    Date
    endTime:      Date
    active:       boolean
    gap:          boolean
    mixedVendor:  boolean
    modelVendors: readonly string[]
    modelNames:   readonly string[]
    tokens:       VendorTokenMix
    costUsd?:     number
}
export interface VendorHistory {
    collector:    'ccusage'
    coverage:     string
    costBasis:    string
    startedAt:    Date
    finishedAt:   Date
    recentSince:  Date
    recentUntil:  Date
    recentDays:   number
    recentTokens: VendorTokenMix
    recentModels: readonly VendorHistoryModel[]
    blocks:       readonly VendorHistoryBlock[]
}
export interface VendorReferencePrice {
    model:       string
    input:       number
    output:      number
    cacheRead?:  number
    cacheWrite?: number
    eligible:    boolean
}
export interface VendorReferencePrices {
    catalog:     'models.dev'
    observedAt:  Date
    stale:       boolean
    unit:        'usd_per_million_tokens'
    models:      readonly VendorReferencePrice[]
    assumptions: readonly ('base_tier' | 'cache_write_5m')[]
}
export interface VendorStatus {
    provider:    string
    status:      string
    lastAttempt: Date
    freshness:   { cached: boolean, stale: boolean, ageSeconds: number }
    errors:      readonly { section: string, code: string, retryAt?: Date, attemptedAt?: Date }[]
    quota?:      VendorObservation
    history?:    VendorHistory
    prices?:     VendorReferencePrices
}
export interface VendorSnapshot {
    generatedAt:        Date
    providers:          readonly VendorStatus[]
    expiresAt?:         Date
    previous?:          VendorSnapshot
    anthropicFallback?: { collectedAt: Date, expiresAt: Date, windows: QuotaWindows }
}

/** Shared identity rule for provider reports and the direct Anthropic usage response. */
export function unifiedAnthropicQuotaId(id: string | undefined, group: string | undefined, scoped: boolean): string | undefined {
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

/** Keep the provider report visible even when its Anthropic quota is not suitable for ledger dispatch. */
// eslint-disable-next-line complexity -- independently excludes stale, unavailable, scoped, inactive and expired observations
export function projectQuotaPolled(snapshot: VendorSnapshot, now: number): Extract<LedgerEvent, { type: 'quota_polled' }> | undefined {
    const anthropic = snapshot.providers.find(provider => provider.provider === 'anthropic');
    const observation = anthropic?.quota;
    if(anthropic === undefined || anthropic.freshness.stale || observation === undefined || observation.available === false
      || anthropic.errors.some(error => error.section === 'quota')) {
        return undefined;
    }
    let windows: QuotaWindows = {};
    for(const quota of observation.quotas) {
        const id = unifiedAnthropicQuotaId(quota.bucket, quota.group, quota.scope?.model !== undefined || quota.scope?.surface !== undefined);
        if(id === undefined || quota.slot !== undefined || quota.active === false || (quota.resetsAt !== undefined && quota.resetsAt.getTime() <= now)) {
            continue;
        }
        windows = fileQuotaWindow(windows, id, { utilization: quota.usedPercent, ...(quota.resetsAt === undefined ? {} : { resetsAt: quota.resetsAt }) });
    }
    return hasQuotaWindow(windows) ? { type: 'quota_polled', quota: windows, at: observation.collectedAt } : undefined;
}
