import { isCalendarServerId, type CalendarServerEntry } from './types';
import { AmbiguousCalendarMatchError } from '@/errors';

/**
 * Resolves a server identifier (UUID or description name) to a CalendarServerEntry.
 * Tries exact UUID match first, then case-insensitive description match.
 * Returns null if not found, throws AmbiguousCalendarMatchError if multiple match.
 */

export function resolveServer(servers: CalendarServerEntry[], input: string): CalendarServerEntry | null {
    if(!input) {
        return null;
    }
    if(isCalendarServerId(input)) {
        // Stryker disable next-line llm: find and filter()[0] return the same first match (or undefined) for a dense server array
        return servers.find(s => s.serverId === input) ?? null;
    }

    const lower = input.toLowerCase();
    const matches = servers.filter(s => s.description.toLowerCase() === lower);

    if(matches.length === 0) {
        return null;
    }
    if(matches.length === 1) {
        // Stryker disable next-line llm: after the length-one guard, index zero is defined and coincides with the last index
        return matches[0] ?? null;
    }
    throw new AmbiguousCalendarMatchError('server', input, matches.map(s => ({ id: s.serverId, label: s.description })));
}

/**
 * Resolves a calendar identifier (path/URL or label name) within a server.
 * Tries exact calendarPath match if input looks like a path/URL, else case-insensitive label match.
 * Returns null if not found, throws AmbiguousCalendarMatchError if multiple match.
 */

export function resolveCalendar(
    server: CalendarServerEntry,
    input: string
): { calendarPath: string, label: string } | null {
    if(!input) {
        return null;
    }
    if(input.startsWith('/') || input.startsWith('http')) {
        return server.calendars.find(c => c.calendarPath === input) ?? null;
    }

    const lower = input.toLowerCase();
    const matches = server.calendars.filter(c => c.label.toLowerCase() === lower);

    // Stryker disable next-line llm: array length cannot be negative, so === 0 and <= 0 coincide
    if(matches.length === 0) {
        return null;
    }
    if(matches.length === 1) {
        const cal = matches[0]!;
        return { calendarPath: cal.calendarPath, label: cal.label };
    }
    throw new AmbiguousCalendarMatchError(
        'calendar',
        input,
        matches.map(c => ({ id: c.calendarPath, label: c.label }))
    );
}
