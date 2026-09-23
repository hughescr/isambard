/**
 * Calendar delta primitive: agenda entries, identity/content keys, diffing, and day-window
 * computation. Pure module -- no I/O, no service dependencies.
 *
 * Consumed by `ContextPolicy.calendarDelta` (Q12) to detect whether a user's day agenda has
 * changed since it was last injected into the envelope, and to compute the day-aligned CalDAV
 * query window: two polls on the same local calendar day compute the identical window from
 * {@link dayWindow}, so `toAgenda`'s output -- and therefore {@link diffAgenda}'s result -- is
 * churn-free across a rolling-window slide within the same day, even though the underlying CalDAV
 * fetch's own time bounds may differ slightly between polls.
 *
 * Event times keep their `CalendarTimeRange` variant throughout: an all-day date is matched against
 * the window's local dates (never converted to an instant), and a floating wall-clock time is
 * resolved in the viewer's display zone by the CalDAV module's single policy (`resolveToInstant`).
 *
 * @module agent/session/calendar-delta
 */

import { DateTime } from 'luxon';
import { dayOrderMs, displayDay, resolveToInstant, type CalendarEvent, type CalendarTimeRange } from '@/integrations/caldav';

/**
 * One calendar agenda entry: the fields relevant to change detection, independent of
 * `CalendarEvent`'s richer CalDAV-specific shape (`calendarLabel`, `description`, `attendees`).
 * `time` keeps the event's variant, so a date-only entry is never re-flattened into an instant.
 */
export interface AgendaEntry {
    uid:           string
    recurrenceId?: string
    time:          CalendarTimeRange
    summary:       string
    location?:     string
    status?:       string
}

/**
 * Stable identity key for an agenda entry. Two entries with the same `uid` but different
 * `recurrenceId` (distinct instances of a recurring series) are different keys, so an edited
 * single instance is reported as changed rather than the whole series being replaced.
 */
export function agendaKey(entry: AgendaEntry): string {
    return `${entry.uid}|${entry.recurrenceId ?? ''}`;
}

/** The fingerprint form of a time range: its variant plus endpoints, with timed instants as ISO strings. */
function fingerprintTime(time: CalendarTimeRange): Record<string, string | undefined> {
    switch(time.kind) {
        case 'all_day': {
            return { kind: time.kind, start: time.start, endExclusive: time.endExclusive };
        }
        case 'floating': {
            return { kind: time.kind, start: time.start, end: time.end };
        }
        case 'timed': {
            return { kind: time.kind, start: time.start.toISOString(), end: time.end.toISOString(), timezone: time.timezone };
        }
    }
}

/**
 * Stable content fingerprint for an agenda entry: a deterministic JSON string of the fields
 * whose change should count as the entry having changed. Two calls with field-for-field
 * identical entries always produce byte-identical fingerprints (fixed key order). The time
 * variant is part of the fingerprint, so a floating 09:00 and a timed 09:00Z differ.
 */
export function agendaFingerprint(entry: AgendaEntry): string {
    return JSON.stringify({
        time:     fingerprintTime(entry.time),
        summary:  entry.summary,
        location: entry.location,
        status:   entry.status,
    });
}

/**
 * Diff a baseline agenda snapshot against the current one, keyed by {@link agendaKey}.
 * `isFirst: true` with every list empty when there is no baseline yet -- the caller should
 * render the full agenda in that case rather than a change list. Otherwise: entries present
 * only in `current` are `added`, entries present only in `baseline` are `removed`, and entries
 * present in both whose {@link agendaFingerprint} differs are `changed`.
 */
export function diffAgenda(
    baseline: readonly AgendaEntry[] | undefined,
    current:  readonly AgendaEntry[]
): { added: AgendaEntry[], removed: AgendaEntry[], changed: AgendaEntry[], isFirst: boolean } {
    // Stryker disable next-line llm: the declared type is array or undefined and both production calls pass Map.get, which cannot yield null, so strict and loose checks coincide.
    if(baseline === undefined) {
        return { added: [], removed: [], changed: [], isFirst: true };
    }

    const baselineByKey = new Map(baseline.map(entry => [agendaKey(entry), entry]));
    const currentByKey  = new Map(current.map(entry => [agendaKey(entry), entry]));

    const added: AgendaEntry[]   = [];
    const changed: AgendaEntry[] = [];
    for(const [key, entry] of currentByKey) {
        const baselineEntry = baselineByKey.get(key);
        if(!baselineEntry) {
            added.push(entry);
        } else if(agendaFingerprint(baselineEntry) !== agendaFingerprint(entry)) {
            changed.push(entry);
        }
    }

    const removed: AgendaEntry[] = [];
    for(const [key, entry] of baselineByKey) {
        if(!currentByKey.has(key)) {
            removed.push(entry);
        }
    }

    return { added, removed, changed, isFirst: false };
}

/**
 * Local-calendar-day bounds, in `timezone`, covering the instant `nowMs`. Two instants that
 * fall on the same local calendar day always yield the identical `{startMs, endMs}` pair --
 * that day-alignment is what makes the CalDAV rolling query window churn-free: two polls made
 * hours apart on the same local day compare the same day's agenda instead of two slightly
 * offset rolling windows.
 */
export function dayWindow(nowMs: number, timezone: string): { startMs: number, endMs: number } {
    const dt = DateTime.fromMillis(nowMs, { zone: timezone });
    return {
        startMs: dt.startOf('day').toMillis(),
        endMs:   dt.endOf('day').toMillis(),
    };
}

/**
 * The subset of `events` that overlaps `window`, as seen from `displayZone`:
 * - floating and timed events (floating resolved in `displayZone`) are kept when
 *   `end >= window.startMs AND start <= window.endMs` -- inclusive on both boundaries, so an event
 *   ending exactly at the window's start, or starting exactly at its end, counts as overlapping, and
 *   an event straddling midnight is kept while one entirely before or after the window is dropped;
 * - all-day events are compared as dates against the window's first and last local dates in
 *   `displayZone`, with an exclusive end: `start <= lastDate AND endExclusive > firstDate`, so a
 *   one-day event on the day after the window's last date, or ending (exclusively) on its first
 *   date, is dropped.
 *
 * Exported so callers that need the raw, window-scoped `CalendarEvent`s themselves (not just their
 * `AgendaEntry` projection -- see `ContextPolicy.calendarDelta`'s `events` field) can filter with
 * the identical predicate {@link toAgenda} uses, rather than re-deriving it.
 */
export function eventsInWindow(events: readonly CalendarEvent[], window: { startMs: number, endMs: number }, displayZone: string): CalendarEvent[] {
    const bounds: WindowBounds = {
        ...window,
        firstDate: DateTime.fromMillis(window.startMs, { zone: displayZone }).toFormat('yyyy-MM-dd'),
        lastDate:  DateTime.fromMillis(window.endMs, { zone: displayZone }).toFormat('yyyy-MM-dd'),
    };
    return events.filter(event => overlapsWindow(event.time, bounds, displayZone));
}

/** A day window as both instants and its first/last local dates in the display zone. */
interface WindowBounds {
    startMs:   number
    endMs:     number
    firstDate: string
    lastDate:  string
}

/** {@link eventsInWindow}'s per-variant overlap predicate. */
function overlapsWindow(time: CalendarTimeRange, bounds: WindowBounds, displayZone: string): boolean {
    switch(time.kind) {
        case 'all_day': {
            return time.start <= bounds.lastDate && time.endExclusive > bounds.firstDate;
        }
        case 'floating':
        case 'timed': {
            const { startMs, endMs } = resolveToInstant(time, displayZone);
            return endMs >= bounds.startMs && startMs <= bounds.endMs;
        }
    }
}

/** Copies a timed range's `Date`s so an agenda entry never shares a mutable `Date` with the raw event cache; string-valued ranges are immutable. */
function cloneTime(time: CalendarTimeRange): CalendarTimeRange {
    switch(time.kind) {
        case 'all_day':
        case 'floating': {
            return time;
        }
        case 'timed': {
            return { ...time, start: new Date(time.start), end: new Date(time.end) };
        }
    }
}

/**
 * Convert raw CalDAV events into agenda entries, keeping only events that overlap `window`
 * (see {@link eventsInWindow}) and sorting the result deterministically across polls that fetch
 * the same events in a different order: by the display day each starts on, then all-day entries
 * first, then by resolved start instant, then by {@link agendaKey}.
 */
export function toAgenda(events: readonly CalendarEvent[], window: { startMs: number, endMs: number }, displayZone: string): AgendaEntry[] {
    const entries = eventsInWindow(events, window, displayZone)
        .map((event): AgendaEntry => ({
            uid:          event.uid,
            recurrenceId: event.recurrenceId,
            time:         cloneTime(event.time),
            summary:      event.summary,
            location:     event.location,
            status:       event.status,
        }));

    return entries.toSorted((a, b) => (
        displayDay(a.time, displayZone).localeCompare(displayDay(b.time, displayZone))
        || dayOrderMs(a.time, displayZone) - dayOrderMs(b.time, displayZone)
        || agendaKey(a).localeCompare(agendaKey(b))
    ));
}
