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
 * @module agent/session/calendar-delta
 */

import { DateTime } from 'luxon';
import type { CalendarEvent } from '@/integrations/caldav';

/**
 * One calendar agenda entry: the fields relevant to change detection, independent of
 * `CalendarEvent`'s richer CalDAV-specific shape (`calendarLabel`, `description`, `attendees`,
 * `timezone`). `start`/`end` are ISO strings so entries are plain, comparable data.
 */
export interface AgendaEntry {
    uid:           string
    recurrenceId?: string
    start:         string // ISO
    end:           string
    summary:       string
    location?:     string
    status?:       string
    isAllDay:      boolean
}

/**
 * Stable identity key for an agenda entry. Two entries with the same `uid` but different
 * `recurrenceId` (distinct instances of a recurring series) are different keys, so an edited
 * single instance is reported as changed rather than the whole series being replaced.
 */
export function agendaKey(entry: AgendaEntry): string {
    return `${entry.uid}|${entry.recurrenceId ?? ''}`;
}

/**
 * Stable content fingerprint for an agenda entry: a deterministic JSON string of the fields
 * whose change should count as the entry having changed. Two calls with field-for-field
 * identical entries always produce byte-identical fingerprints (fixed key order).
 */
export function agendaFingerprint(entry: AgendaEntry): string {
    return JSON.stringify({
        start:    entry.start,
        end:      entry.end,
        summary:  entry.summary,
        location: entry.location,
        status:   entry.status,
        isAllDay: entry.isAllDay,
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
 * The subset of `events` that overlaps `window`: kept when `event.end >= window.startMs AND
 * event.start <= window.endMs` (inclusive on both boundaries, so an event ending exactly at
 * the window's start, or starting exactly at its end, counts as overlapping), so an event
 * straddling midnight -- starting before the window and ending inside it, or vice versa -- is
 * kept, while one entirely before or after the window is dropped. Exported so callers that need
 * the raw, window-scoped `CalendarEvent`s themselves (not just their `AgendaEntry` projection --
 * see `ContextPolicy.calendarDelta`'s `events` field) can filter with the identical predicate
 * {@link toAgenda} uses, rather than re-deriving it.
 */
export function eventsInWindow(events: readonly CalendarEvent[], window: { startMs: number, endMs: number }): CalendarEvent[] {
    return events.filter(event => event.end.getTime() >= window.startMs && event.start.getTime() <= window.endMs);
}

/**
 * Convert raw CalDAV events into agenda entries, keeping only events that overlap `window`
 * (see {@link eventsInWindow}) and sorting the result by start time then {@link agendaKey}, so
 * the ordering is deterministic across polls that fetch the same events in a different order.
 */
export function toAgenda(events: readonly CalendarEvent[], window: { startMs: number, endMs: number }): AgendaEntry[] {
    const entries = eventsInWindow(events, window)
        .map((event): AgendaEntry => ({
            uid:          event.uid,
            recurrenceId: event.recurrenceId,
            start:        event.start.toISOString(),
            end:          event.end.toISOString(),
            summary:      event.summary,
            location:     event.location,
            status:       event.status,
            isAllDay:     event.isAllDay,
        }));

    return entries.toSorted((a, b) => a.start.localeCompare(b.start) || agendaKey(a).localeCompare(agendaKey(b)));
}
