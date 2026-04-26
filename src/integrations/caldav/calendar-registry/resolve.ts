import { isCalendarServerId, type CalendarServerEntry } from './types';
import { AmbiguousCalendarMatchError, InvariantViolationError } from '@/errors';

/**
 * Resolves a server identifier (UUID or description name) to a CalendarServerEntry.
 * Tries exact UUID match first, then case-insensitive description match.
 * Returns null if not found, throws AmbiguousCalendarMatchError if multiple match.
 */

export function resolveServer(servers: CalendarServerEntry[], input: string): CalendarServerEntry | null {
    // Stryker disable next-line ConditionalExpression,BlockStatement: equivalent mutant — empty string falls through to matching and returns null anyway (no entity has empty description/label)
    if(!input) {
        return null;
    }
    if(isCalendarServerId(input)) {
        return servers.find(s => s.serverId === input) ?? null;
    }

    const lower = input.toLowerCase();
    const matches = servers.filter(s => s.description.toLowerCase() === lower);

    if(matches.length === 0) {
        return null;
    }
    if(matches.length === 1) {
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
    // Stryker disable next-line ConditionalExpression,BlockStatement: equivalent mutant — empty string falls through to matching and returns null anyway (no entity has empty description/label)
    if(!input) {
        return null;
    }
    if(input.startsWith('/') || input.startsWith('http')) {
        return server.calendars.find(c => c.calendarPath === input) ?? null;
    }

    const lower = input.toLowerCase();
    const matches = server.calendars.filter(c => c.label.toLowerCase() === lower);

    if(matches.length === 0) {
        return null;
    }
    if(matches.length === 1) {
        const cal = matches[0];
        // Stryker disable next-line ConditionalExpression,BlockStatement: invariant guard — matches.length === 1 ensures index 0 exists; unreachable in practice
        if(cal === undefined) {
            // Stryker disable next-line StringLiteral: invariant violation message — debug context only
            throw new InvariantViolationError('resolveCalendar', 'matches[0] undefined despite matches.length === 1');
        }
        return { calendarPath: cal.calendarPath, label: cal.label };
    }
    throw new AmbiguousCalendarMatchError(
        'calendar',
        input,
        matches.map(c => ({ id: c.calendarPath, label: c.label }))
    );
}
