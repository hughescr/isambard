import { DateTime } from 'luxon';

/**
 * Calendar info returned from CalDAV server discovery.
 */
export interface CalendarInfo {
    path:         string
    displayName:  string
    color?:       string
    description?: string
}

/** A `YYYY-MM-DD` calendar date. It names a day, not an instant, so it never shifts across zones. */
export type LocalDate = string & { readonly __localDate: unique symbol };

/** A zone-less `YYYY-MM-DDTHH:mm:ss` wall-clock time (an iCalendar floating DATE-TIME). */
export type LocalDateTime = string & { readonly __localDateTime: unique symbol };

const LOCAL_DATE_FORMAT = 'yyyy-MM-dd';
const LOCAL_DATE_TIME_FORMAT = "yyyy-MM-dd'T'HH:mm:ss";

/**
 * Round-trips `value` through `format`, so only a real calendar value in exactly that shape survives.
 * Validity is checked first: an invalid DateTime formats as `Invalid DateTime`, which would round-trip itself.
 */
function isExactLocalValue(value: string, format: string): boolean {
    const parsed = DateTime.fromFormat(value, format, { zone: 'utc' });
    return parsed.isValid && parsed.toFormat(format) === value;
}

/** Checked constructor for {@link LocalDate}: rejects impossible dates (`2026-02-29`) and any other shape. */
export function createLocalDate(value: string): LocalDate {
    if(!isExactLocalValue(value, LOCAL_DATE_FORMAT)) {
        throw new RangeError(`Invalid calendar date: ${value}`);
    }
    return value as LocalDate;
}

/** Checked constructor for {@link LocalDateTime}: rejects offsets, `Z`, fractional seconds and impossible times. */
export function createLocalDateTime(value: string): LocalDateTime {
    if(!isExactLocalValue(value, LOCAL_DATE_TIME_FORMAT)) {
        throw new RangeError(`Invalid floating calendar time: ${value}`);
    }
    return value as LocalDateTime;
}

/**
 * When a calendar event happens. The three iCalendar shapes are genuinely different things:
 * - `all_day`: a run of calendar dates, `endExclusive` being the first date not covered.
 * - `floating`: zone-less wall-clock times, interpreted in whoever is viewing's display zone.
 * - `timed`: real instants, with the IANA/offset zone the source calendar gave them.
 */
export type CalendarTimeRange
    = | { kind: 'all_day', start: LocalDate, endExclusive: LocalDate }
      | { kind: 'floating', start: LocalDateTime, end: LocalDateTime }
      | { kind: 'timed', start: Date, end: Date, timezone?: string };

/** Unchecked input for {@link createCalendarTimeRange}: the same variants with plain strings. */
export type CalendarTimeRangeInput
    = | { kind: 'all_day', start: string, endExclusive: string }
      | { kind: 'floating', start: string, end: string }
      | { kind: 'timed', start: Date, end: Date, timezone?: string };

/**
 * The one checked constructor for {@link CalendarTimeRange}. Throws `RangeError` for a malformed
 * endpoint, an invalid `Date`, or an end before its start (an all-day range must cover at least
 * one date). Timed endpoints are copied so the range never shares a mutable `Date` with its source.
 */
export function createCalendarTimeRange(input: CalendarTimeRangeInput): CalendarTimeRange {
    switch(input.kind) {
        case 'all_day': {
            const start = createLocalDate(input.start);
            const endExclusive = createLocalDate(input.endExclusive);
            if(endExclusive <= start) {
                throw new RangeError(`All-day end ${endExclusive} must be after start ${start}`);
            }
            return { kind: 'all_day', start, endExclusive };
        }
        case 'floating': {
            const start = createLocalDateTime(input.start);
            const end = createLocalDateTime(input.end);
            if(end < start) {
                throw new RangeError(`Floating end ${end} precedes start ${start}`);
            }
            return { kind: 'floating', start, end };
        }
        case 'timed': {
            const startMs = input.start.getTime();
            const endMs = input.end.getTime();
            if(Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) {
                throw new RangeError('Invalid timed calendar endpoints');
            }
            return { kind: 'timed', start: new Date(startMs), end: new Date(endMs), timezone: input.timezone };
        }
    }
}

/**
 * Normalized calendar event.
 */
export interface CalendarEvent {
    uid:           string
    summary:       string
    time:          CalendarTimeRange
    location?:     string
    description?:  string
    attendees?:    string[]
    calendarLabel: string    // Which calendar this came from
    status?:       'confirmed' | 'tentative' | 'cancelled'
    recurrenceId?: string    // For recurring event instances
}

/**
 * A VEVENT that could not be represented: a recurring event that could not be expanded
 * (e.g. malformed RRULE, with `rrule` set) or an event whose time could not be decoded.
 */
export interface FailedCalendarEvent {
    uid:    string
    reason: string
    rrule?: string
}

/**
 * Result of fetching calendar events.
 * `events` contains successfully parsed events; `failed` contains events that
 * could not be expanded or decoded — never silently dropped.
 */
export interface CalendarEventsResult {
    events: CalendarEvent[]
    failed: FailedCalendarEvent[]
}
