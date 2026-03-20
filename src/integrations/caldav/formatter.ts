import { DateTime } from 'luxon';
import type { CalendarEvent } from './types';

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
    if(events.length === 0) {
        return '';
    }

    const nowDT      = DateTime.fromJSDate(now, { zone: timezone });
    const todayStart = nowDT.startOf('day');

    // Group events by day
    const dayGroups = new Map<string, CalendarEvent[]>();

    for(const event of events) {
        const eventDT  = DateTime.fromJSDate(event.start, { zone: timezone });
        const dayKey   = eventDT.toFormat('yyyy-MM-dd');
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
        const sorted = dayEvents.toSorted((a, b) => {
            if(a.isAllDay && !b.isAllDay) {
                return -1;
            }
            if(!a.isAllDay && b.isAllDay) {
                return 1;
            }
            return a.start.getTime() - b.start.getTime();
        });

        for(const event of sorted) {
            sections.push(formatEventLine(event, timezone));
        }
    }

    return sections.join('\n');
}

function formatDayLabel(dayDT: DateTime, todayStart: DateTime): string {
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

function formatTimeRange(start: Date, end: Date, zone: string): string {
    const startDT = DateTime.fromJSDate(start, { zone });
    const endDT   = DateTime.fromJSDate(end, { zone });
    // Stryker disable StringLiteral: format strings are cosmetic display detail
    const startTime = startDT.toFormat('HH:mm');
    const endTime   = endDT.toFormat('HH:mm');
    const abbr      = startDT.toFormat('ZZZZ');
    // Stryker restore StringLiteral
    return `${startTime}–${endTime} ${abbr}`;
}

function buildTimeSuffix(event: CalendarEvent, displayTimezone: string): string {
    // Collect all relevant timezones, deduplicate, preserve order.
    // Primary display timezone is already shown by formatEventLine, so skip it.
    const seen = new Set<string>([displayTimezone]);
    const suffixZones: string[] = [];

    // Event's native timezone (from iCal data)
    const eventTz = event.timezone;
    if(eventTz && !seen.has(eventTz)) {
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

    const parts = suffixZones.map(tz => formatTimeRange(event.start, event.end, tz));
    return ` (${parts.join(' / ')})`;
}

function formatEventLine(event: CalendarEvent, izzyTimezone: string): string {
    let line: string;

    if(event.isAllDay) {
        line = `- All day: ${event.summary}`;
    } else {
        const izzyRange = formatTimeRange(event.start, event.end, izzyTimezone);
        const suffix    = buildTimeSuffix(event, izzyTimezone);
        line = `- ${izzyRange}${suffix}: ${event.summary}`;
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
