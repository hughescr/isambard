import { DateTime } from 'luxon';
import { dayOrderMs, displayDay, resolveToInstant } from './time-range';
import type { CalendarEvent, CalendarTimeRange } from './types';

/**
 * Format calendar events for context injection.
 * Groups by day, shows relative timing, includes all details since events are small.
 *
 * @param events - Calendar events to format
 * @param now - Current time reference
 * @param timezone - IANA timezone string (e.g., 'America/Los_Angeles')
 * @returns Formatted calendar context string
 */
export function formatCalendarContext(
    events:   CalendarEvent[],
    now:      Date,
    timezone: string
): string {
    // Stryker disable next-line llm: an array length is a non-negative integer, so `<= 0` and `=== 0` select the same inputs.
    if(events.length === 0) {
        return '';
    }

    const nowDT      = DateTime.fromJSDate(now, { zone: timezone });
    const todayStart = nowDT.startOf('day');

    // Group events by day
    const dayGroups = new Map<string, CalendarEvent[]>();

    for(const event of events) {
        const dayKey   = displayDay(event.time, timezone);
        const existing = dayGroups.get(dayKey) ?? [];
        existing.push(event);
        dayGroups.set(dayKey, existing);
    }

    // Sort days chronologically
    const sortedDays = [...dayGroups.entries()].toSorted(([a], [b]) => a.localeCompare(b));

    const sections: string[] = ['## Calendar'];

    for(const [dayKey, dayEvents] of sortedDays) {
        const dayDT    = DateTime.fromISO(dayKey, { zone: timezone });
        const dayLabel = formatDayLabel(dayDT, todayStart);

        sections.push(`### ${dayLabel}`);

        // Sort events: all-day first, then by start time
        const sorted = dayEvents.toSorted((a, b) => dayOrderMs(a.time, timezone) - dayOrderMs(b.time, timezone));

        for(const event of sorted) {
            sections.push(formatEventLine(event, timezone));
        }
    }

    return sections.join('\n');
}

function formatDayLabel(dayDT: DateTime, todayStart: DateTime): string {
    // Stryker disable next-line llm: dayDT is parsed from a date-only yyyy-MM-dd key, so it already sits at the start of its day in this zone (luxon resolves a DST midnight gap identically for both).
    const diff    = dayDT.startOf('day').diff(todayStart, 'days').days;
    const dayName = dayDT.toFormat('ccc');   // Mon, Tue, etc.
    const dateStr = dayDT.toFormat('LLL d'); // Mar 18

    if(diff === -1) {
        return `Yesterday (${dayName} ${dateStr})`;
    }
    if(diff === 0) {
        return `Today (${dayName} ${dateStr})`;
    }
    if(diff === 1) {
        return `Tomorrow (${dayName} ${dateStr})`;
    }
    return `${dayName} ${dateStr}`;
}

function formatTimeRange(startMs: number, endMs: number, zone: string): string {
    const startDT = DateTime.fromMillis(startMs, { zone });
    const endDT   = DateTime.fromMillis(endMs, { zone });
    const startTime = startDT.toFormat('HH:mm');
    const endTime   = endDT.toFormat('HH:mm');
    const abbr      = startDT.toFormat('ZZZZ');
    return `${startTime}–${endTime} ${abbr}`;
}

function buildTimeSuffix(time: Extract<CalendarTimeRange, { kind: 'timed' }>, displayTimezone: string): string {
    // Collect all relevant timezones, deduplicate, preserve order.
    // Primary display timezone is already shown by formatEventLine, so skip it.
    const seen = new Set<string>([displayTimezone]);
    const suffixZones: string[] = [];

    // Event's native timezone (from iCal data)
    // Stryker disable next-line llm: the very next guard is a truthiness check, and undefined and '' are both falsy there, so the `|| ''` fallback is inert.
    const eventTz = time.timezone;
    if(eventTz && !seen.has(eventTz)) {
        // Stryker disable next-line ArrayMethodSwap: suffixZones is newly allocated and still empty here, so this first insertion has the same order.
        suffixZones.push(eventTz);
        seen.add(eventTz);
    }

    // UTC as reference
    if(!seen.has('UTC')) {
        suffixZones.push('UTC');
    }

    if(suffixZones.length === 0) {
        return '';
    }

    const parts = suffixZones.map(tz => formatTimeRange(time.start.getTime(), time.end.getTime(), tz));
    return ` (${parts.join(' / ')})`;
}

function formatEventLine(event: CalendarEvent, izzyTimezone: string): string {
    let line: string;

    switch(event.time.kind) {
        case 'all_day': {
            line = `- All day: ${event.summary}`;
            break;
        }
        case 'floating': {
            // A floating time has no native zone, so there is no suffix: it is shown in (and means) the display zone.
            const { startMs, endMs } = resolveToInstant(event.time, izzyTimezone);
            line = `- ${formatTimeRange(startMs, endMs, izzyTimezone)}: ${event.summary}`;
            break;
        }
        case 'timed': {
            const izzyRange = formatTimeRange(event.time.start.getTime(), event.time.end.getTime(), izzyTimezone);
            const suffix = buildTimeSuffix(event.time, izzyTimezone);
            line = `- ${izzyRange}${suffix}: ${event.summary}`;
            break;
        }
    }

    // Calendar label
    line += ` [${event.calendarLabel}]`;

    // Location
    if(event.location) {
        line += ` @ ${event.location}`;
    }

    // Attendee count
    if(event.attendees && event.attendees.length > 0) {
        const count  = event.attendees.length;
        const plural = count === 1 ? 'attendee' : 'attendees';
        line += ` (${count} ${plural})`;
    }

    // Status if not confirmed (tentative or cancelled)
    if(event.status && event.status !== 'confirmed') {
        line += ` [${event.status}]`;
    }

    return line;
}
