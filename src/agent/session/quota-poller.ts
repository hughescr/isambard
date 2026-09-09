/**
 * The subscription-usage quota poller (docs/plans/session-peers-and-quota.md, block 3).
 *
 * The SDK's own `rate_limit_event` frames are the PRIMARY source of the ledger's `quota` field: the
 * block-0 probe (P4) found `rate_limit_info.unifiedWindows` on every frame, carrying both the
 * five-hour and seven-day windows, so `./ledger.ts` already has a full picture from headers
 * alone. Those frames are change-driven, though, not per-turn, so a session that sits idle can
 * hold a stale reading — this poller is the secondary source that refreshes it.
 *
 * Everything it touches is injected: a {@link Clock} (never a real timer — see ./clock.ts), a
 * narrow {@link QuotaFetch} port satisfied by the global `fetch`, and the {@link LedgerStore}s to
 * dispatch into. It NEVER throws and never rejects: a refused connection, a non-OK status, a
 * body it cannot parse, or a throwing `dispatch` all log one `debug` line and leave the last
 * known quota in place. The usage endpoint's real headers and response shape are UNVERIFIED
 * (probe P5 could not reach it, so no token was available), which is exactly why the URL, the
 * request headers and the parser are all tolerant and swappable; {@link parseUsageWindows}
 * documents the shape it is built against. The one case loud enough for a `warn` — ONCE per
 * poller instance, never once per poll — is a body that DOES carry windows whose `utilization`
 * the ledger refused: that is the endpoint answering in units this parser does not accept
 * (percents, most likely), which silently produces no quota at all until an operator sees it.
 *
 * WIRING (`createSessionAmbience` in `src/app/sessions.ts`, started from `src/index.ts`):
 * - ONE poller per process, handed the live registration array, so both roles share a single
 *   subscription and see the same numbers;
 * - `fetch: globalThis.fetch`, `clock: systemClock`, and a `headers` factory supplying the
 *   subscription's OAuth authorization header (re-read per poll, so a rotated token is picked
 *   up without a restart);
 * - `pollIntervalMs` from `config.agent.quota.pollIntervalMs`;
 * - `start()` in `app.start()` and `stop()` in `app.stop()` — the recurring poll is the ONLY
 *   refresh an idle process gets, and the subscription is shared with Craig's own sessions, so
 *   without it the ledger's quota (and the block-5 perch ceiling that reads it) goes stale
 *   whenever Izzy is not taking turns;
 * - `noteResult()` from the ambience's own `result`-frame subscription, so a busy session
 *   refreshes promptly (rate-limited to one poll per {@link DEFAULT_QUOTA_RESULT_DEBOUNCE_MS}).
 *
 * @module agent/session/quota-poller
 */
import type { Logger } from '@hughescr/logger';
import { type LedgerStore, type QuotaWindows, fileQuotaWindow, hasQuotaWindow, toQuotaWindow } from './ledger';
import type { Clock, TimerHandle } from './types';

/** Five minutes: the spec's default gap between background polls. */
export const DEFAULT_QUOTA_POLL_INTERVAL_MS = 300_000;

/** Thirty seconds: the most often a run of `result` frames may drive a poll. */
export const DEFAULT_QUOTA_RESULT_DEBOUNCE_MS = 30_000;

/** The part of a `Response` this module uses; the global `fetch`'s `Response` satisfies it. */
export interface QuotaFetchResponse {
    ok:     boolean
    status: number
    json:   () => Promise<unknown>
}

/** The narrow fetch port. `globalThis.fetch` is assignable to it. */
export type QuotaFetch = (url: string, init: { headers: Record<string, string> }) => Promise<QuotaFetchResponse>;

/** Dependencies for {@link createQuotaPoller}. */
export interface CreateQuotaPollerParams {
    clock:             Clock
    fetch:             QuotaFetch
    /** Every ledger to dispatch a `quota_polled` event into — one poller feeds both roles. */
    ledgers:           readonly Pick<LedgerStore, 'dispatch'>[]
    logger:            Pick<Logger, 'debug' | 'warn'>
    /**
     * The usage endpoint to poll; defaults to `https://api.anthropic.com/api/oauth/usage`. Kept
     * overridable because that URL, its auth and its response shape are all UNVERIFIED (probe P5).
     */
    url?:              string
    /** Request headers, re-read on every poll so a rotated token is picked up; defaults to none. */
    headers?:          () => Record<string, string>
    /** Defaults to {@link DEFAULT_QUOTA_POLL_INTERVAL_MS}. */
    pollIntervalMs?:   number
    /** Defaults to {@link DEFAULT_QUOTA_RESULT_DEBOUNCE_MS}. */
    resultDebounceMs?: number
}

/** What {@link createQuotaPoller} returns. */
export interface QuotaPoller {
    /** Arms the recurring poll. Idempotent: a second call while running arms no second timer. */
    start:      () => void
    /**
     * Cancels the pending poll so the timer can never fire into a torn-down process, and closes
     * the poller: {@link QuotaPoller.noteResult} stops polling and a poll still in flight files
     * nothing when it lands. `start()` may arm again afterwards.
     */
    stop:       () => void
    /** Call once per `result` frame; polls unless the poller is stopped or a poll started within `resultDebounceMs`. */
    noteResult: () => void
    /**
     * Polls once, now, or joins the poll already in flight. Resolves — never rejects — whatever
     * the endpoint does. Like every other path, it files its reading into the ledgers only while
     * the poller is started.
     */
    poll:       () => Promise<void>
}

/**
 * Reads `value` as a bag of properties, for a payload whose shape is unverified. `null` is the
 * only thing that has to be filtered: `Object.entries` and `?.` both cope with `undefined` and
 * with primitives (a string or a number simply yields no property this parser recognises),
 * whereas `Object.entries(null)` throws.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
    if(value === null) {
        return undefined;
    }
    return value as Record<string, unknown> | undefined;
}

/** What {@link parseUsageWindows} makes of one body. */
export interface ParsedUsage {
    /** Every window the body carried, or undefined when it carried none the ledger tracks. */
    windows?: QuotaWindows
    /**
     * True when at least one entry DID carry a `utilization` that {@link toQuotaWindow} refused —
     * the endpoint reporting percents (`87`) rather than the 0-1 fraction the SDK's own windows
     * use is the shape mismatch this exists to surface. An entry with no `utilization` at all is
     * simply not a window and is not counted here.
     */
    rejected: boolean
}

/** The accumulator {@link collectWindows} threads; {@link parseUsageWindows} narrows it for its callers. */
interface UsageAccumulator {
    windows:  QuotaWindows
    rejected: boolean
}

/**
 * Folds every window-shaped entry of `source` into `accumulated.windows`, keyed by the raw
 * rate-limit type its property name gives (`five_hour`, `seven_day`, `seven_day_opus`, …). An
 * entry that is not an object, carries no usable `utilization`, or names a type the ledger does
 * not track is skipped, and a `source` that is nullish (or any other value carrying no such
 * property) contributes nothing. An entry that carried a `utilization` the ledger refused raises
 * `rejected` — see {@link ParsedUsage.rejected}.
 */
function collectWindows(source: unknown, accumulated: UsageAccumulator): UsageAccumulator {
    const record = asRecord(source);
    if(record === undefined) {
        return accumulated;
    }
    let { windows, rejected } = accumulated;
    for(const [type, raw] of Object.entries(record)) {
        const entry = asRecord(raw);
        const utilization = entry?.utilization;
        const window = toQuotaWindow(utilization, entry?.resetsAt ?? entry?.resets_at);
        if(window === undefined) {
            rejected ||= utilization !== undefined;
        } else {
            windows = fileQuotaWindow(windows, type, window);
        }
    }
    return { windows, rejected };
}

/**
 * Parses a usage-endpoint body into {@link QuotaWindows}. The endpoint's real shape is
 * UNVERIFIED (probe P5), so this is built against the one window shape that IS verified — the
 * SDK's `rate_limit_info.unifiedWindows`: a map of raw rate-limit type to
 * `{ utilization: 0-1 fraction, resetsAt: unix seconds or an ISO-8601 instant }`. Both a top-level
 * map and one nested under `unifiedWindows` are accepted (the nested one wins, being the more
 * specific), `resets_at` is accepted alongside `resetsAt`, and every unknown field, unusable entry
 * and untracked window type is ignored. A body with no recognisable window yields no `windows`,
 * which the poller treats as a failed poll: the last known quota stands.
 * @param body The parsed JSON body
 * @returns The windows found, and whether any entry's `utilization` was refused
 */
export function parseUsageWindows(body: unknown): ParsedUsage {
    const record = asRecord(body);
    const topLevel = collectWindows(record, { windows: {}, rejected: false });
    const { windows, rejected } = collectWindows(record?.unifiedWindows, topLevel);
    return { windows: hasQuotaWindow(windows) ? windows : undefined, rejected };
}

/**
 * Builds the quota poller. See the module doc for the source hierarchy, the never-throws
 * contract, and the wiring block 4 is expected to add.
 * @param params Poller dependencies
 * @returns A {@link QuotaPoller}
 */
export function createQuotaPoller(params: CreateQuotaPollerParams): QuotaPoller {
    const {
        clock, fetch, ledgers, logger,
        url = 'https://api.anthropic.com/api/oauth/usage',
        headers = () => ({}),
        pollIntervalMs = DEFAULT_QUOTA_POLL_INTERVAL_MS,
        resultDebounceMs = DEFAULT_QUOTA_RESULT_DEBOUNCE_MS,
    } = params;

    let timer: TimerHandle | undefined;
    let running = false;
    let inFlight: Promise<void> | undefined;
    // One warn per poller instance, not one per poll: the endpoint answering in the wrong units is
    // a standing condition, and the recurring poll would otherwise repeat it every five minutes
    // for the life of the process.
    let warnedAboutShape = false;
    // Negative infinity rather than `undefined` so the debounce is one unconditional subtraction:
    // before any poll has run, `now - lastPollStartedAt` is Infinity and never inside the window.
    let lastPollStartedAt = Number.NEGATIVE_INFINITY;

    /** One attempt, start to finish. Every failure ends as a single debug line, never a rejection. */
    async function pollOnce(): Promise<void> {
        lastPollStartedAt = clock.now();
        try {
            const response = await fetch(url, { headers: headers() });
            if(!response.ok) {
                logger.debug({ status: response.status }, 'Quota poll: usage endpoint returned a non-OK status');
                return;
            }
            const parsed = parseUsageWindows(await response.json());
            if(parsed.rejected && !warnedAboutShape) {
                warnedAboutShape = true;
                logger.warn({ url }, 'Quota poll: the usage endpoint reported a utilization outside the 0-1 fraction the SDK uses; those windows are being ignored, so this endpoint\'s shape is not what the parser expects');
            }
            if(parsed.windows === undefined) {
                logger.debug('Quota poll: usage response carried no recognisable rate-limit window');
                return;
            }
            // Re-checked after the await: `stop()` may have landed while this request was in
            // flight, and a torn-down process must not have quota folded into its ledgers.
            if(!running) {
                return;
            }
            const at = new Date(clock.now());
            for(const ledger of ledgers) {
                ledger.dispatch({ type: 'quota_polled', quota: parsed.windows, at });
            }
        } catch (error) {
            logger.debug({ error }, 'Quota poll failed; keeping the last known quota');
        }
    }

    /**
     * Polls unless one is already running, in which case the caller joins that attempt rather
     * than stacking a second request on an endpoint that is evidently slow.
     */
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

    /** Arms the next recurring poll; the callback re-arms before polling, so the cadence never depends on how long a poll takes. */
    function scheduleNext(): void {
        timer = clock.setTimer(() => {
            timer = undefined;
            scheduleNext();
            void poll();
        }, pollIntervalMs);
    }

    return {
        start(): void {
            if(running) {
                return;
            }
            running = true;
            scheduleNext();
        },
        stop(): void {
            running = false;
            if(timer !== undefined) {
                clock.clearTimer(timer);
                timer = undefined;
            }
        },
        noteResult(): void {
            // A `result` frame can still reach the ambience's subscription after `stop()` (the
            // subscription outlives the poller's lifecycle), and a stopped poller must not start
            // a fresh request into a process that is shutting down.
            if(!running) {
                return;
            }
            if(clock.now() - lastPollStartedAt < resultDebounceMs) {
                return;
            }
            void poll();
        },
        poll,
    };
}
