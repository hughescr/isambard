/**
 * Context injection policy for the long-lived session core.
 *
 * Owns two independent, per-process gates that decide what re-seeds into an envelope's
 * context sections rather than being re-sent on every turn:
 *
 * - Per-user memory: {@link ContextPolicy.shouldInjectUserMemory} answers whether the
 *   `[About this user]` block should be rendered again for a given user, and
 *   {@link ContextPolicy.markInjected} records that it just was. Both take the block's
 *   current text (R1): a user's memory block is re-injected on first contact, or whenever its
 *   content fingerprint (`contentFingerprint`, a cheap stable hash — see below) differs from
 *   the fingerprint recorded at the last `markInjected` call. There is no time window; an
 *   unchanged block is never re-injected no matter how long it has been, and a changed block
 *   is re-injected immediately regardless of how little time has passed.
 * - Events delta: {@link ContextPolicy.eventsDelta} returns the memory-preview-formatted
 *   events recorded since the last {@link ContextPolicy.markEventsSeen} call (or `[]` before
 *   the first mark). {@link ContextPolicy.eventsSinceMs} exposes that same mark (an absolute
 *   epoch ms) so a caller building its own windowed query (the boot bundle, after a
 *   compaction) can render "events since the mark" without going through `eventsDelta`'s own
 *   memory-preview formatting, and {@link ContextPolicy.markEventsSeenAt} seeds the mark
 *   directly from a journal-derived boundary (e.g. after a restart) rather than "now".
 *   Deliberately does NOT construct or wrap `EventDeltaTracker` (event-delta-tracker.ts) —
 *   that class reads `Date.now()` directly and cannot be driven by an injected clock, which
 *   this policy needs for deterministic tests and for the compaction-time reset.
 *   `event-delta-tracker.ts` is untouched by this module.
 * - State top-set delta: {@link ContextPolicy.stateTopSetDelta} diffs the CURRENT state top set
 *   (`loadStateTopSet(now)` — the same top-8-full-plus-30-preview set `loadHotState` renders)
 *   against the set captured at the last {@link ContextPolicy.markStateTopSetSeen} call,
 *   reporting paths that newly entered the set (`added`), paths that fell out of it
 *   (`removed`), and paths present at both marks whose content fingerprint
 *   (`StateTopSetItem.contentFingerprint`, a hash of the item's content — deliberately NOT its
 *   `updatedAt`, which read-only access also bumps) differs (`changed`). Empty before the first
 *   mark, matching `eventsDelta`.
 *   {@link ContextPolicy.markStateTopSetSeen} is deliberately async and itself fetches the
 *   top set, unlike the synchronous `markEventsSeen()`: a timestamp is enough to drive
 *   `eventsDelta`'s time-windowed query, but a set-membership-plus-fingerprint diff has no
 *   "since" query equivalent — the mark must capture the actual baseline set to compare
 *   against next time. This is a deliberate asymmetry with `markEventsSeen`, not an oversight.
 *
 * {@link ContextPolicy.resetAll} clears every user fingerprint mark, the state top-set mark,
 * the calendar poll cache and baselines, and the health mark — but deliberately NOT the events
 * mark (R1): a compaction can run for minutes with perch active in parallel, and events written
 * during that window must still be captured by the next `eventsDelta`/`eventsSinceMs` read
 * rather than falling through a reset boundary. The compaction sink (P9) calls `resetAll` after
 * a compaction completes so every OTHER gate re-arms as if this were a cold start.
 *
 * - Calendar delta (Q12): {@link ContextPolicy.calendarDelta} answers, per user, whether the
 *   day's agenda has changed since it was last injected. It is a per-user hourly HOST POLL, not
 *   a per-call fetch: `calendarPollIntervalMs` (default 60 minutes) gates how often
 *   `contextBuilder.loadCalendarAgenda` is actually called, and a local-day rollover (per
 *   {@link dayWindow}, computed from the caller-supplied IANA `timezone`) forces a fresh poll
 *   even inside the interval, so the CalDAV query window realigns to the new day. Between polls
 *   the cached agenda for that user is reused and re-diffed against the last
 *   {@link ContextPolicy.markCalendarSeen} baseline — the diff is deliberately always
 *   `diffAgenda(baseline, agenda)`, not a special-cased "empty when unpolled" branch: since the
 *   caller is expected to call `markCalendarSeen` every turn that injects the delta, the
 *   baseline already equals the cached agenda by the next unpolled call, so an unpolled delta
 *   comes out empty on its own.
 * - Health note (Q12): {@link ContextPolicy.healthNote} renders `healthRegistry.buildStatusSummary()`
 *   as the `[Service health]` body only when the registry's underlying STATE has changed since
 *   the last {@link ContextPolicy.markHealthSeen} mark — including the transition back to
 *   nominal, which has no summary text of its own (`buildStatusSummary()` returns `undefined`
 *   when every service is online) and is rendered as the fixed string `'All services are back
 *   online.'` instead. The initial, unmarked baseline is treated as "all online" (`undefined`),
 *   so a pre-existing outage is still surfaced the first time `healthNote()` is called after
 *   construction or a `resetAll()`, exactly like {@link diffAgenda}'s `isFirst` convention
 *   treats "no baseline yet" as something worth rendering rather than staying silent.
 *   `healthRegistry` is optional; `healthNote()` returns `undefined` unconditionally without one.
 *   Deliberately does NOT compare `buildStatusSummary()`'s own rendered text across calls: that
 *   string embeds a live relative-time-offline display and a whole-second retry countdown (see
 *   `src/services/health-registry.ts`'s `buildServiceStatusLine`/`buildRetryPart`), so it differs
 *   on almost every call during an ongoing outage even though nothing has actually changed. The
 *   comparison key instead comes from `getAll()` — per-service `state` plus `lastError?.code`,
 *   which only moves on a real transition — and `buildStatusSummary()` is called only to render
 *   the body once a change has already been detected. `markHealthSeen()` commits the exact key
 *   `healthNote()` most recently computed rather than re-sampling `getAll()` at mark time, so a
 *   state change that lands between the envelope-build call to `healthNote()` and the
 *   after-the-turn call to `markHealthSeen()` is never silently marked seen without ever having
 *   been shown (the same hazard `markCalendarSeen` avoids by committing the cached agenda that
 *   was actually diffed, not a fresh re-poll).
 *
 * @module agent/session/context-policy
 */
import { formatMemoryPreview, type ContextBuilder } from '../context-builder';
import { dayWindow, diffAgenda, eventsInWindow, toAgenda, type AgendaEntry } from './calendar-delta';
import type { CalendarEvent } from '@/integrations/caldav';
import type { ServiceHealthRegistry, ServiceHealthEntry, ServiceName } from '@/services';

/** The subset of `ContextBuilder` this policy depends on for the events-delta gate. */
export type EventsDeltaSource = Pick<ContextBuilder, 'loadRecentEventsSince'>;

/** The subset of `ContextBuilder` this policy depends on for the state-top-set-delta gate. */
export type StateTopSetSource = Pick<ContextBuilder, 'loadStateTopSet'>;

/** The subset of `ContextBuilder` this policy depends on for the calendar-delta gate. */
export type CalendarAgendaSource = Pick<ContextBuilder, 'loadCalendarAgenda'>;

/** Default poll cadence for {@link ContextPolicy.calendarDelta} — one hour. */
export const DEFAULT_CALENDAR_POLL_INTERVAL_MS = 60 * 60 * 1000;

/** Inputs to {@link createContextPolicy}. */
export interface CreateContextPolicyParams {
    /** Millisecond clock, e.g. `() => clock.now()`. Plain function so this module stays independent of any particular Clock type. */
    now:                     () => number
    contextBuilder:          EventsDeltaSource & StateTopSetSource & CalendarAgendaSource
    /** Max events fetched per `eventsDelta()` call. Defaults to 50. */
    eventLimit?:             number
    /** Drives {@link ContextPolicy.healthNote}/{@link ContextPolicy.markHealthSeen}. Omit to disable the gate entirely — `healthNote()` then always returns `undefined`. `getAll()` feeds the change-detection fingerprint; `buildStatusSummary()` renders the body once a change is detected — see the module doc's healthNote paragraph. */
    healthRegistry?:         Pick<ServiceHealthRegistry, 'buildStatusSummary' | 'getAll'>
    /** How often {@link ContextPolicy.calendarDelta} actually polls `loadCalendarAgenda` for a given user, absent a local-day rollover. Defaults to {@link DEFAULT_CALENDAR_POLL_INTERVAL_MS}. */
    calendarPollIntervalMs?: number
}

/** {@link ContextPolicy.calendarDelta}'s result for one user. */
export interface CalendarDelta {
    /** The current day's agenda entries, in {@link toAgenda}'s deterministic order. */
    agenda:  AgendaEntry[]
    /**
     * The `CalendarEvent`s behind `agenda`, filtered to the same day window (via
     * {@link eventsInWindow}) that {@link toAgenda} itself filters to — NOT the raw, several-day
     * `loadCalendarAgenda` result. Kept alongside `agenda` (rather than only the `AgendaEntry`
     * projection) for callers that render with `formatCalendarContext`, which wants
     * `CalendarEvent`'s richer fields. Window-scoping this list matters: `added`/`removed`/
     * `changed` are diffed on the SAME day window, so rendering the unfiltered multi-day fetch
     * here would silently show a wider (and staler, for days other than today) span than what
     * the change list actually describes.
     */
    events:  CalendarEvent[]
    /** Entries present in `agenda` but absent from the last {@link ContextPolicy.markCalendarSeen} baseline. */
    added:   AgendaEntry[]
    /** Entries present in the last baseline but absent from `agenda` now. */
    removed: AgendaEntry[]
    /** Entries present in both, whose {@link AgendaEntry} content fingerprint differs. */
    changed: AgendaEntry[]
    /** `true` when this user has no baseline yet (no {@link ContextPolicy.markCalendarSeen} call has ever landed for them). */
    isFirst: boolean
    /** `true` when this call actually fetched via `loadCalendarAgenda` rather than reusing the per-user poll cache. */
    polled:  boolean
}

/** The paths that changed between two state-top-set marks. */
export interface StateTopSetDelta {
    /** Paths present now that were absent from the last mark's set. */
    added:   string[]
    /** Paths present at the last mark's set that are absent now. */
    removed: string[]
    /** Paths present at both marks whose content fingerprint differs. */
    changed: string[]
}

/** Per-user memory gate plus self-owned events-delta and state-top-set-delta tracking. */
export interface ContextPolicy {
    /** True when no fingerprint is recorded for `userId` (since construction or the last `resetAll`), or the recorded fingerprint differs from `block`'s current content fingerprint. No time window (R1). */
    shouldInjectUserMemory: (userId: string, block: string) => boolean
    /** Records `block`'s content fingerprint as `userId`'s just-injected mark. */
    markInjected:           (userId: string, block: string) => void
    /** Clears every user's fingerprint mark, the state-top-set mark, the calendar poll cache/baselines, and the health mark, re-arming every gate EXCEPT the events mark (see the module doc). */
    resetAll:               () => void
    /** Memory-preview-formatted events recorded since the last `markEventsSeen()`/`markEventsSeenAt()`; `[]` before the first mark. */
    eventsDelta:            () => Promise<string[]>
    /** Records the current clock time as the events high-water mark. */
    markEventsSeen:         () => void
    /** The current events high-water mark (absolute epoch ms), or `undefined` before the first `markEventsSeen`/`markEventsSeenAt` call. Lets a caller (the boot bundle, after a compaction) render its own "events since the mark" window without going through `eventsDelta`'s formatting. */
    eventsSinceMs:          () => number | undefined
    /** Seeds the events high-water mark directly from a journal-derived boundary (e.g. after a restart) rather than "now". */
    markEventsSeenAt:       (ms: number) => void
    /** Added/removed/changed paths in the state top set since the last `markStateTopSetSeen()`; all empty before the first mark. */
    stateTopSetDelta:       () => Promise<StateTopSetDelta>
    /** Fetches the current state top set and records it as the next comparison baseline. */
    markStateTopSetSeen:    () => Promise<void>
    /** This user's day agenda delta — polls at most once per `calendarPollIntervalMs` (or on a local-day rollover), otherwise reuses the per-user cache. See the module doc for the poll/diff contract. */
    calendarDelta:          (userId: string, timezone: string) => Promise<CalendarDelta>
    /** Records the agenda from this user's most recent `calendarDelta()` call as the next diff baseline. A no-op when `calendarDelta` was never called for this user. */
    markCalendarSeen:       (userId: string) => void
    /** `healthRegistry.buildStatusSummary()` rendered as the `[Service health]` body when it differs from the last `markHealthSeen()` mark (including the return to all-online, rendered as `'All services are back online.'`); `undefined` when unchanged or when no `healthRegistry` was supplied. */
    healthNote:             () => string | undefined
    /** Records the current `healthRegistry.buildStatusSummary()` as the next comparison baseline. A no-op without a `healthRegistry`. */
    markHealthSeen:         () => void
}

/**
 * A cheap, deterministic fingerprint of a text block (`Bun.hash(text).toString()`). Mirrors the
 * technique `loadStateTopSet`'s `StateTopSetItem.contentFingerprint` uses (context-builder.ts),
 * but that value is computed inline there and is not an exported helper, so this module defines
 * its own rather than importing one that doesn't exist.
 */
function contentFingerprint(text: string): string {
    return Bun.hash(text).toString();
}

/**
 * A deterministic, non-volatile fingerprint of a health registry's per-service state: `state`
 * plus `lastError?.code` for every service that isn't `'online'` or `'disabled'` (mirroring
 * `buildServiceStatusLine`'s own online/disabled collapse in health-registry.ts), sorted by
 * service name and joined into one string. Deliberately excludes `lastOfflineAt`, `nextRetryAt`,
 * `failureCount` and `lastError.message` — those (and `buildStatusSummary()`'s rendered text
 * built from them) change on almost every call during an ongoing outage without the service's
 * actual state having changed. Returns `undefined` when every service is online or disabled
 * (nothing to report), exactly matching when `buildStatusSummary()` itself returns `undefined`.
 */
function healthStateKey(entries: Readonly<Record<ServiceName, ServiceHealthEntry>>): string | undefined {
    const lines: string[] = [];
    for(const name of Object.keys(entries).toSorted((a, b) => a.localeCompare(b)) as ServiceName[]) {
        const entry = entries[name];
        if(entry.state === 'online' || entry.state === 'disabled') {
            continue;
        }
        lines.push(`${name}:${entry.state}:${entry.lastError?.code ?? ''}`);
    }
    return lines.length > 0 ? lines.join('|') : undefined;
}

/**
 * Creates a {@link ContextPolicy}.
 * @param params Clock, window and dependencies
 * @returns A fresh policy with no user marks and no events mark
 */
export function createContextPolicy(params: CreateContextPolicyParams): ContextPolicy {
    const { now, contextBuilder, eventLimit = 50, healthRegistry, calendarPollIntervalMs = DEFAULT_CALENDAR_POLL_INTERVAL_MS } = params;

    const userMarks = new Map<string, string>();
    let lastEventsSeenMs: number | undefined;
    let stateTopSetBaseline: Map<string, string> | undefined;

    interface CalendarPollCacheEntry {
        agenda:     AgendaEntry[]
        events:     CalendarEvent[]
        polledAtMs: number
        window:     { startMs: number, endMs: number }
    }
    const calendarPollCache = new Map<string, CalendarPollCacheEntry>();
    const calendarBaselines = new Map<string, AgendaEntry[]>();
    // `undefined` doubles as "no mark yet" and "last known state was all-online" — see the
    // module doc's healthNote paragraph for why that collapse is deliberate, not an oversight.
    let lastHealthStateKey: string | undefined;
    // The key `healthNote()` most recently computed, committed verbatim by `markHealthSeen()`
    // instead of re-sampling `healthRegistry.getAll()` at mark time — see the module doc's
    // healthNote paragraph for the race a re-sample would otherwise reintroduce.
    let pendingHealthStateKey: string | undefined;

    return {
        shouldInjectUserMemory(userId: string, block: string): boolean {
            const mark = userMarks.get(userId);
            // Stryker disable next-line ConditionalExpression: `mark === undefined` is subsumed by
            // `mark !== contentFingerprint(block)` — contentFingerprint always returns a defined
            // string (Bun.hash(...).toString()), so `undefined !== <string>` is already true;
            // forcing this sub-expression to `false` cannot change the result. Kept for readability
            // (states the "no mark yet" case explicitly) rather than removed.
            return mark === undefined || mark !== contentFingerprint(block);
        },

        markInjected(userId: string, block: string): void {
            userMarks.set(userId, contentFingerprint(block));
        },

        resetAll(): void {
            userMarks.clear();
            stateTopSetBaseline = undefined;
            calendarPollCache.clear();
            calendarBaselines.clear();
            lastHealthStateKey = undefined;
            pendingHealthStateKey = undefined;
        },

        async eventsDelta(): Promise<string[]> {
            if(lastEventsSeenMs === undefined) {
                return [];
            }

            const currentNow = now();
            const items = await contextBuilder.loadRecentEventsSince(currentNow - lastEventsSeenMs, eventLimit, new Date(currentNow));
            return items.map(item => formatMemoryPreview(item.path, item.content, item.contentPreview, item.updatedAt, new Date(currentNow)));
        },

        markEventsSeen(): void {
            lastEventsSeenMs = now();
        },

        eventsSinceMs(): number | undefined {
            return lastEventsSeenMs;
        },

        markEventsSeenAt(ms: number): void {
            lastEventsSeenMs = ms;
        },

        async stateTopSetDelta(): Promise<StateTopSetDelta> {
            if(stateTopSetBaseline === undefined) {
                return { added: [], removed: [], changed: [] };
            }

            const baseline = stateTopSetBaseline;
            const currentItems = await contextBuilder.loadStateTopSet(new Date(now()));
            const currentPaths = new Set<string>(currentItems.map(item => item.path));

            const added: string[] = [];
            const changed: string[] = [];
            for(const item of currentItems) {
                const baselineFingerprint = baseline.get(item.path);
                if(baselineFingerprint === undefined) {
                    added.push(item.path);
                } else if(baselineFingerprint !== item.contentFingerprint) {
                    changed.push(item.path);
                }
            }

            const removed: string[] = [];
            for(const path of baseline.keys()) {
                if(!currentPaths.has(path)) {
                    removed.push(path);
                }
            }

            return { added, removed, changed };
        },

        async markStateTopSetSeen(): Promise<void> {
            const items = await contextBuilder.loadStateTopSet(new Date(now()));
            stateTopSetBaseline = new Map<string, string>(items.map(item => [item.path, item.contentFingerprint]));
        },

        async calendarDelta(userId: string, timezone: string): Promise<CalendarDelta> {
            const nowMs = now();
            const window = dayWindow(nowMs, timezone);
            const cached = calendarPollCache.get(userId);

            if(cached !== undefined) {
                const sameDay = cached.window.startMs === window.startMs;
                const withinInterval = nowMs - cached.polledAtMs < calendarPollIntervalMs;
                if(sameDay && withinInterval) {
                    const diff = diffAgenda(calendarBaselines.get(userId), cached.agenda);
                    return { agenda: cached.agenda, events: cached.events, ...diff, polled: false };
                }
            }

            const fetchedEvents = await contextBuilder.loadCalendarAgenda(userId, new Date(nowMs));
            // Window-scope the raw events BEFORE caching, not just the AgendaEntry projection --
            // `loadCalendarAgenda` returns several days (CalDAV's rolling query window), but the
            // added/removed/changed lists below are diffed on this one day's window, so the
            // `events` a caller renders alongside them must cover exactly that same day (see the
            // `CalendarDelta.events` doc).
            const events = eventsInWindow(fetchedEvents, window);
            const agenda = toAgenda(events, window);
            calendarPollCache.set(userId, { agenda, events, polledAtMs: nowMs, window });
            const diff = diffAgenda(calendarBaselines.get(userId), agenda);
            return { agenda, events, ...diff, polled: true };
        },

        markCalendarSeen(userId: string): void {
            const cached = calendarPollCache.get(userId);
            if(cached === undefined) {
                return;
            }
            calendarBaselines.set(userId, cached.agenda);
        },

        healthNote(): string | undefined {
            if(!healthRegistry) {
                return undefined;
            }
            const currentKey = healthStateKey(healthRegistry.getAll());
            pendingHealthStateKey = currentKey;
            if(currentKey === lastHealthStateKey) {
                return undefined;
            }
            return healthRegistry.buildStatusSummary() ?? 'All services are back online.';
        },

        markHealthSeen(): void {
            // Stryker disable next-line ConditionalExpression,BlockStatement: equivalent guard -- lastHealthStateKey/pendingHealthStateKey are only ever read or written behind this same `!healthRegistry` check (see healthNote() above), so without a healthRegistry both stay undefined whether or not this guard runs, and with one the guard is always false anyway; removing it changes no observable behavior.
            if(!healthRegistry) {
                return;
            }
            lastHealthStateKey = pendingHealthStateKey;
        },
    };
}
