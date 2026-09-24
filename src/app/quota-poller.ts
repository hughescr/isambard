/** Process-wide quota polling lifecycle and ledger fan-out. Wire formats live in the integration adapters. */
import type { Logger } from '@hughescr/logger';
import { projectQuotaPolled, type AnthropicQuotaSource, type Clock, type LedgerStore, type TimerHandle, type VendorSnapshot, type QuotaWindows } from '@/agent';
import { DEFAULT_ANTHROPIC_USAGE_URL, fetchUsageFallback } from '@/integrations/anthropic';
import { DEFAULT_VENDOR_REPORT_URL, fetchVendorSnapshot } from '@/integrations/utraque';
import type { QuotaFetch } from '@/utils';

export const DEFAULT_QUOTA_POLL_INTERVAL_MS = 300_000;
export const DEFAULT_QUOTA_RESULT_DEBOUNCE_MS = 30_000;
export const DEFAULT_QUOTA_REQUEST_TIMEOUT_MS = 100_000;
export interface CreateQuotaPollerParams {
    clock:                 Clock
    fetch:                 QuotaFetch
    ledgers:               readonly Pick<LedgerStore, 'dispatch'>[]
    logger:                Pick<Logger, 'debug' | 'warn'>
    url?:                  string
    fallbackUrl?:          string
    headers?:              () => Record<string, string>
    fallbackHeaders?:      () => Record<string, string>
    preferVendorReport?:   boolean
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
    getSnapshot?: () => VendorSnapshot | undefined
}

export function createQuotaPoller(params: CreateQuotaPollerParams): QuotaPoller {
    const { clock, fetch, ledgers, logger, url = DEFAULT_VENDOR_REPORT_URL, fallbackUrl = DEFAULT_ANTHROPIC_USAGE_URL,
        headers = () => ({}), fallbackHeaders = () => ({}), pollIntervalMs = DEFAULT_QUOTA_POLL_INTERVAL_MS,
        preferVendorReport = true, anthropicQuotaSource = 'provider', resultDebounceMs = DEFAULT_QUOTA_RESULT_DEBOUNCE_MS,
        requestTimeoutMs = DEFAULT_QUOTA_REQUEST_TIMEOUT_MS } = params;
    let timer: TimerHandle | undefined;
    let running = false;
    let inFlight: Promise<void> | undefined;
    let abortController: AbortController | undefined;
    // Stryker disable next-line NumberLiteralValue: generation is an opaque equality token; its initial numeric offset is never observed.
    let generation = 0;
    let snapshot: VendorSnapshot | undefined;
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
                freshness: { ...provider.freshness, stale: true, ageSeconds: provider.freshness.ageSeconds + elapsed },
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
        const outcome = await fetchUsageFallback(fetch, fallbackUrl, signal, fallbackHeaders());
        if(outcome.kind === 'http-error') {
            markSnapshotStale(clock.now(), attemptGeneration);
            logger.debug({ status: outcome.status }, 'Quota poll: direct Anthropic fallback returned a non-OK status');
            return;
        }
        const parsed = outcome.usage;
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
    // eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- coordinates one bounded attempt, fallback and generation guards
    async function pollOnce(): Promise<void> {
        lastPollStartedAt = clock.now();
        const controller = new AbortController();
        abortController = controller;
        const attemptGeneration = generation;
        const timeout = clock.setTimer(() => controller.abort(), requestTimeoutMs);
        try {
            if(!preferVendorReport) {
                if(anthropicQuotaSource === 'sdk') {
                    return;
                }
                await directFallback(controller.signal, attemptGeneration);
                return;
            }
            let useFallback = false;
            try {
                const outcome = await fetchVendorSnapshot(fetch, url, controller.signal, headers());
                if(outcome.kind === 'invalid-schema') {
                    markSnapshotStale(clock.now(), attemptGeneration);
                    logger.debug('Quota poll: utraque provider report was not valid schema version 2');
                } else if(outcome.kind === 'valid') {
                    if(running && generation === attemptGeneration) {
                        const currentSnapshot = snapshot;
                        const previous = currentSnapshot === undefined
                            ? undefined
                            : { generatedAt: currentSnapshot.generatedAt, providers: currentSnapshot.providers, expiresAt: currentSnapshot.expiresAt };
                        snapshot = { ...outcome.snapshot, expiresAt: new Date(clock.now() + pollIntervalMs * 2), previous };
                        if(anthropicQuotaSource === 'provider') {
                            const event = projectQuotaPolled(outcome.snapshot, clock.now());
                            if(event !== undefined) {
                                dispatch(event.quota, event.at, attemptGeneration);
                            }
                        }
                    }
                } else {
                    logger.debug({ status: outcome.status }, 'Quota poll: utraque provider report returned a non-OK status');
                    markSnapshotStale(clock.now(), attemptGeneration);
                    useFallback = anthropicQuotaSource === 'provider'
                      && (outcome.status === 404 || outcome.status === 405 || outcome.status >= 500);
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
                // Stryker disable next-line NumberLiteralValue: stop's increment invalidates any prior attempt even if this start-side delta is zero or two.
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
            // Stryker disable next-line NumberLiteralValue: running=false blocks stopped publication, and the next start increment invalidates the old token.
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
