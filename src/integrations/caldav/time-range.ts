/**
 * The one display-zone policy for {@link CalendarTimeRange}s, shared by the calendar context
 * formatter, the session agenda window/projection and the Discord change-list renderer.
 *
 * - `timed` ranges are instants; the display zone only changes how they are rendered.
 * - `floating` wall-clock times are interpreted in the display zone. A wall time that falls in a
 *   DST gap shifts forward by the gap (Luxon's rule); a repeated wall time resolves to the earlier
 *   of its two instants. Neither depends on the host zone or on the current date.
 * - `all_day` ranges stay date-valued: they group under their own start date and are never
 *   converted to an instant.
 *
 * @module integrations/caldav/time-range
 */

import { DateTime } from 'luxon';
import type { CalendarTimeRange, LocalDateTime } from './types';

/** A floating wall-clock time as an instant in `displayZone`, under the module's DST policy. */
export function resolveFloating(value: LocalDateTime, displayZone: string): DateTime {
    const resolved = DateTime.fromISO(value, { zone: displayZone });
    if(!resolved.isValid) {
        throw new RangeError(`Invalid calendar display zone: ${displayZone}`);
    }
    // Luxon lists an ambiguous (repeated) wall time's instants earliest first; any other time has one.
    return resolved.getPossibleOffsets()[0]!;
}

/** Epoch-millisecond endpoints of a floating or timed range. All-day ranges have no instant form. */
export function resolveToInstant(range: Exclude<CalendarTimeRange, { kind: 'all_day' }>, displayZone: string): { startMs: number, endMs: number } {
    switch(range.kind) {
        case 'floating': {
            return { startMs: resolveFloating(range.start, displayZone).toMillis(), endMs: resolveFloating(range.end, displayZone).toMillis() };
        }
        case 'timed': {
            return { startMs: range.start.getTime(), endMs: range.end.getTime() };
        }
    }
}

/**
 * The `YYYY-MM-DD` day a range starts on for a viewer in `displayZone`; all-day dates never move.
 *
 * The `timed` case is deliberately kept immediately after `all_day` (rather than beside the
 * similar-looking `floating` slice): an `all_day` start is always exactly 10 chars, so a fallthrough
 * into `floating`'s `slice(0, 10)` would be a byte-for-byte equivalent mutant. Falling into `timed`'s
 * `DateTime.fromJSDate` instead feeds it a string where a `Date` is expected, which is observably
 * `Invalid DateTime` — so a mutant collapsing the `all_day` case is caught by the existing assertion.
 */
export function displayDay(range: CalendarTimeRange, displayZone: string): string {
    switch(range.kind) {
        case 'all_day': {
            return range.start;
        }
        case 'timed': {
            return DateTime.fromJSDate(range.start, { zone: displayZone }).toFormat('yyyy-MM-dd');
        }
        case 'floating': {
            return range.start.slice(0, 10);
        }
    }
}

/**
 * Sort position of a range within one display day: all-day ranges ahead of every floating or timed
 * start (which order by their resolved instant). Only meaningful between ranges on the same day.
 */
export function dayOrderMs(range: CalendarTimeRange, displayZone: string): number {
    switch(range.kind) {
        case 'all_day': {
            return Number.MIN_SAFE_INTEGER;
        }
        case 'floating':
        case 'timed': {
            return resolveToInstant(range, displayZone).startMs;
        }
    }
}

/**
 * Zone-independent total-order key for raw event lists that have no display zone (the CalDAV
 * client's merged results): start date (all-day date / floating local date / timed UTC date),
 * then all-day, floating, timed, then the local or UTC time of day. Plain string comparison of
 * these keys is transitive across mixed variants.
 */
export function calendarSortKey(range: CalendarTimeRange): string {
    switch(range.kind) {
        case 'all_day': {
            return `${range.start}|0|`;
        }
        case 'floating': {
            return `${range.start.slice(0, 10)}|1|${range.start.slice(11)}`;
        }
        case 'timed': {
            const iso = range.start.toISOString();
            return `${iso.slice(0, 10)}|2|${iso.slice(11)}`;
        }
    }
}
