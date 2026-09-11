/** Process-wide provider quota polling via utraque, with a direct Anthropic fallback. */
import type { Logger } from '@hughescr/logger';
import { type LedgerStore, type QuotaWindows, fileQuotaWindow, hasQuotaWindow } from './ledger';
import type { Clock, TimerHandle } from './types';

export const DEFAULT_QUOTA_POLL_INTERVAL_MS = 300_000;
export const DEFAULT_QUOTA_RESULT_DEBOUNCE_MS = 30_000;
export const DEFAULT_QUOTA_REQUEST_TIMEOUT_MS = 100_000;
export const DEFAULT_PROVIDER_REPORT_URL = 'http://127.0.0.1:8317/v1/utraque/providers';
export const DEFAULT_ANTHROPIC_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

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
export interface ProviderStatus {
    provider:    string
    status:      string
    lastAttempt: Date
    freshness:   { cached: boolean, stale: boolean, ageSeconds: number }
    errors:      readonly { section: string, code: string }[]
    quotaAfter?: ProviderObservation
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
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
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
                return section === undefined || code === undefined ? [] : [{ section, code }];
            })
            : [];
        const observation = providerObservation(item.quota_after);
        const quotaAfter = observation?.source === provider && observation.collectedAt <= generatedAt ? observation : undefined;
        return [{ provider, status, lastAttempt, freshness: { cached, stale, ageSeconds }, errors, quotaAfter }];
    });
    return providers.length === 0 ? undefined : { generatedAt, providers };
}

export interface ParsedUsage { windows?: QuotaWindows, rejected: boolean }

function unifiedAnthropicQuotaId(id: string, group: string | undefined, scoped: boolean): string | undefined {
    if(scoped) {
        return undefined;
    }
    if(id === 'five_hour' || id === 'session' || group === 'session') {
        return 'five_hour';
    }
    if(id === 'seven_day' || id === 'weekly_all') {
        return 'seven_day';
    }
    return id;
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
            const id = unifiedAnthropicQuotaId(kind ?? 'session', group, scoped);
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
        preferProviderReport = true, resultDebounceMs = DEFAULT_QUOTA_RESULT_DEBOUNCE_MS,
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
                } else {
                    logger.debug({ status: response.status }, 'Quota poll: utraque provider report returned a non-OK status');
                    markSnapshotStale(clock.now(), attemptGeneration);
                    useFallback = response.status === 404 || response.status === 405 || response.status >= 500;
                }
            } catch (error) {
                if(controller.signal.aborted) {
                    throw error;
                }
                markSnapshotStale(clock.now(), attemptGeneration);
                logger.debug({ errorName: error instanceof Error ? error.name : 'unknown' }, 'Quota poll: utraque provider report failed; trying direct Anthropic fallback');
                useFallback = true;
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
