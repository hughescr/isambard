import { describe, it, expect } from 'bun:test';
import { formatCalendarContext } from '@/integrations/caldav/formatter';
import { createLocalDate, createLocalDateTime, type CalendarEvent } from '@/integrations/caldav/types';

const TZ = 'America/Los_Angeles';

// Reference: 'now' is Tuesday 2026-03-18 at 10:00 AM Pacific (18:00 UTC)
// Test mock uses fixed offsets: LA=UTC-8 (PST), ET=UTC-5 (EST)
const NOW = new Date('2026-03-18T18:00:00Z');

function makeEvent(overrides: Partial<CalendarEvent> & { summary: string, start: Date, end: Date, isAllDay?: boolean, timezone?: string }): CalendarEvent {
    const { start, end, isAllDay, timezone, ...fields } = overrides;
    return {
        uid:           `uid-${overrides.summary}`,
        calendarLabel: 'Work',
        time:          isAllDay
            ? { kind: 'all_day', start: createLocalDate(start.toISOString().slice(0, 10)), endExclusive: createLocalDate(end.toISOString().slice(0, 10)) }
            : { kind: 'timed', start, end, timezone },
        ...fields,
    };
}

function makeFloating(summary: string, start: string, end: string): CalendarEvent {
    return {
        uid:           `uid-${summary}`,
        summary,
        calendarLabel: 'Work',
        time:          { kind: 'floating', start: createLocalDateTime(start), end: createLocalDateTime(end) },
    };
}

describe.concurrent('formatCalendarContext', () => {
    it('returns empty string for empty events array', () => {
        expect(formatCalendarContext([], NOW, TZ)).toBe('');
    });

    it('keeps a March 1 all-day date on March 1 west of UTC', () => {
        const event = makeEvent({ summary: 'Date-only', start: new Date('2026-03-01T00:00:00Z'), end: new Date('2026-03-02T00:00:00Z'), isAllDay: true });
        const result = formatCalendarContext([event], new Date('2026-03-01T18:00:00Z'), TZ);
        expect(result).toContain('Today (Sun Mar 1)');
        expect(result).toContain('All day: Date-only');
        expect(result).not.toContain('Feb 28');
    });

    it('renders a floating wall-clock time in the display zone with no suffix', () => {
        const event = makeFloating('Floating', '2026-03-18T09:00:00', '2026-03-18T09:30:00');
        expect(formatCalendarContext([event], NOW, TZ)).toBe('## Calendar\n### Today (Wed Mar 18)\n- 09:00–09:30 PST: Floating [Work]');
        expect(formatCalendarContext([event], NOW, 'Asia/Tokyo')).toBe('## Calendar\n### Yesterday (Wed Mar 18)\n- 09:00–09:30 JST: Floating [Work]');
    });

    it('orders a floating event among timed events by its display-zone start', () => {
        const events = [
            makeEvent({ summary: 'Timed 10:00', start: new Date('2026-03-18T18:00:00Z'), end: new Date('2026-03-18T18:30:00Z') }),
            makeFloating('Floating 09:30', '2026-03-18T09:30:00', '2026-03-18T09:45:00'),
            makeEvent({ summary: 'Timed 09:00', start: new Date('2026-03-18T17:00:00Z'), end: new Date('2026-03-18T17:30:00Z') }),
        ];
        const lines = formatCalendarContext(events, NOW, TZ).split('\n').filter(line => line.startsWith('- '));
        expect(lines.map(line => line.slice(line.lastIndexOf(': ') + 2))).toEqual(['Timed 09:00 [Work]', 'Floating 09:30 [Work]', 'Timed 10:00 [Work]']);
    });

    it('formats a single timed event with 24h time, TZ abbreviation, and UTC suffix', () => {
        const event = makeEvent({
            summary: 'Team Standup',
            start:   new Date('2026-03-18T17:00:00Z'), // 09:00 PST
            end:     new Date('2026-03-18T17:30:00Z'), // 09:30 PST
        });
        const result = formatCalendarContext([event], NOW, TZ);
        expect(result).toContain('09:00–09:30 PST');
        expect(result).toContain('(17:00–17:30 UTC)');
        expect(result).toContain('Team Standup [Work]');
        expect(result).not.toContain('@');
        expect(result).not.toContain('attendee');
    });

    it('formats a single timed event with location', () => {
        const event = makeEvent({
            summary:  'Product Review',
            start:    new Date('2026-03-18T17:00:00Z'), // 09:00 PST
            end:      new Date('2026-03-18T18:00:00Z'), // 10:00 PST
            location: 'Conference Room A',
        });
        const result = formatCalendarContext([event], NOW, TZ);
        expect(result).toContain('09:00–10:00 PST');
        expect(result).toContain('(17:00–18:00 UTC)');
        expect(result).toContain('Product Review [Work] @ Conference Room A');
    });

    it('formats an all-day event without time or timezone info', () => {
        const event = makeEvent({
            summary:       "Craig's Birthday",
            start:         new Date('2026-03-18T08:00:00Z'), // all-day, local start
            end:           new Date('2026-03-19T08:00:00Z'),
            isAllDay:      true,
            calendarLabel: 'Personal',
        });
        const result = formatCalendarContext([event], NOW, TZ);
        expect(result).toContain("All day: Craig's Birthday [Personal]");
        expect(result).not.toContain('PST');
        expect(result).not.toContain('UTC');
        expect(result).not.toContain(':00');
    });

    it('groups multiple events on the same day under one header', () => {
        const events = [
            makeEvent({
                summary: 'Morning Standup',
                start:   new Date('2026-03-18T16:00:00Z'), // 08:00 PST
                end:     new Date('2026-03-18T16:30:00Z'),
            }),
            makeEvent({
                summary: 'Afternoon Sync',
                start:   new Date('2026-03-18T21:00:00Z'), // 13:00 PST
                end:     new Date('2026-03-18T21:30:00Z'),
            }),
        ];
        const result = formatCalendarContext(events, NOW, TZ);
        const todayHeaders = (result.match(/### Today/g) ?? []).length;
        expect(todayHeaders).toBe(1);
        expect(result).toContain('Morning Standup');
        expect(result).toContain('Afternoon Sync');
    });

    it('produces separate day headers for multiple days', () => {
        const events = [
            makeEvent({
                summary: 'Monday Meeting',
                start:   new Date('2026-03-17T17:00:00Z'), // yesterday PST
                end:     new Date('2026-03-17T18:00:00Z'),
            }),
            makeEvent({
                summary: 'Tuesday Meeting',
                start:   new Date('2026-03-18T17:00:00Z'), // today PST
                end:     new Date('2026-03-18T18:00:00Z'),
            }),
        ];
        const result = formatCalendarContext(events, NOW, TZ);
        expect(result).toContain('### Yesterday');
        expect(result).toContain('### Today');
        expect(result).toContain('Monday Meeting');
        expect(result).toContain('Tuesday Meeting');
    });

    it('shows "Yesterday" label for one day before today', () => {
        const event = makeEvent({
            summary: 'Yesterday Event',
            start:   new Date('2026-03-17T17:00:00Z'),
            end:     new Date('2026-03-17T18:00:00Z'),
        });
        const result = formatCalendarContext([event], NOW, TZ);
        expect(result).toContain('### Yesterday (Tue Mar 17)');
    });

    it('shows "Today" label for today', () => {
        const event = makeEvent({
            summary: 'Today Event',
            start:   new Date('2026-03-18T17:00:00Z'),
            end:     new Date('2026-03-18T18:00:00Z'),
        });
        const result = formatCalendarContext([event], NOW, TZ);
        expect(result).toContain('### Today (Wed Mar 18)');
    });

    it('shows "Tomorrow" label for one day after today', () => {
        const event = makeEvent({
            summary: 'Tomorrow Event',
            start:   new Date('2026-03-19T17:00:00Z'),
            end:     new Date('2026-03-19T18:00:00Z'),
        });
        const result = formatCalendarContext([event], NOW, TZ);
        expect(result).toContain('### Tomorrow (Thu Mar 19)');
    });

    it('shows "DayName Mon D" for days beyond tomorrow', () => {
        const event = makeEvent({
            summary: 'Future Event',
            start:   new Date('2026-03-20T17:00:00Z'),
            end:     new Date('2026-03-20T18:00:00Z'),
        });
        const result = formatCalendarContext([event], NOW, TZ);
        expect(result).toContain('### Fri Mar 20');
        expect(result).not.toContain('Yesterday');
        expect(result).not.toContain('Today');
        expect(result).not.toContain('Tomorrow');
    });

    it('includes attendee count for multiple attendees', () => {
        const event = makeEvent({
            summary:   'Big Meeting',
            start:     new Date('2026-03-18T17:00:00Z'),
            end:       new Date('2026-03-18T18:00:00Z'),
            attendees: ['alice@example.com', 'bob@example.com', 'charlie@example.com'],
        });
        const result = formatCalendarContext([event], NOW, TZ);
        expect(result).toContain('(3 attendees)');
    });

    it('uses singular "attendee" for exactly one attendee', () => {
        const event = makeEvent({
            summary:   'One on One',
            start:     new Date('2026-03-18T17:00:00Z'),
            end:       new Date('2026-03-18T18:00:00Z'),
            attendees: ['alice@example.com'],
        });
        const result = formatCalendarContext([event], NOW, TZ);
        expect(result).toContain('(1 attendee)');
        expect(result).not.toContain('(1 attendees)');
    });

    it('appends tentative status for tentative events', () => {
        const event = makeEvent({
            summary: 'Maybe Meeting',
            start:   new Date('2026-03-20T17:00:00Z'),
            end:     new Date('2026-03-20T18:00:00Z'),
            status:  'tentative',
        });
        const result = formatCalendarContext([event], NOW, TZ);
        expect(result).toContain('[tentative]');
    });

    it('appends cancelled status for cancelled events', () => {
        const event = makeEvent({
            summary: 'Cancelled Meeting',
            start:   new Date('2026-03-20T17:00:00Z'),
            end:     new Date('2026-03-20T18:00:00Z'),
            status:  'cancelled',
        });
        const result = formatCalendarContext([event], NOW, TZ);
        expect(result).toContain('[cancelled]');
    });

    it('does not append status for confirmed events', () => {
        const event = makeEvent({
            summary: 'Normal Meeting',
            start:   new Date('2026-03-18T17:00:00Z'),
            end:     new Date('2026-03-18T18:00:00Z'),
            status:  'confirmed',
        });
        const result = formatCalendarContext([event], NOW, TZ);
        expect(result).not.toContain('[confirmed]');
    });

    it('does not append status when status is undefined', () => {
        const event = makeEvent({
            summary: 'Statusless Meeting',
            start:   new Date('2026-03-18T17:00:00Z'),
            end:     new Date('2026-03-18T18:00:00Z'),
        });
        const result = formatCalendarContext([event], NOW, TZ);
        expect(result).not.toMatch(/\[(confirmed|tentative|cancelled)\]/);
    });

    it('sorts all-day events before timed events on same day', () => {
        const events = [
            makeEvent({
                summary: 'Timed Event',
                start:   new Date('2026-03-18T08:00:00Z'), // 00:00 PST (early morning)
                end:     new Date('2026-03-18T09:00:00Z'),
            }),
            makeEvent({
                summary:  'All Day Event',
                start:    new Date('2026-03-18T08:00:00Z'),
                end:      new Date('2026-03-19T08:00:00Z'),
                isAllDay: true,
            }),
        ];
        const result = formatCalendarContext(events, NOW, TZ);
        const allDayPos = result.indexOf('All day:');
        const timedPos = result.indexOf('00:00');
        expect(allDayPos).toBeLessThan(timedPos);
    });

    it('sorts timed events by start time within a day', () => {
        const events = [
            makeEvent({
                summary: 'Late Event',
                start:   new Date('2026-03-18T23:00:00Z'), // 15:00 PST
                end:     new Date('2026-03-18T23:30:00Z'),
            }),
            makeEvent({
                summary: 'Early Event',
                start:   new Date('2026-03-18T16:00:00Z'), // 08:00 PST
                end:     new Date('2026-03-18T16:30:00Z'),
            }),
        ];
        const result = formatCalendarContext(events, NOW, TZ);
        const earlyPos = result.indexOf('Early Event');
        const latePos = result.indexOf('Late Event');
        expect(earlyPos).toBeLessThan(latePos);
    });

    it('displays times in the specified timezone', () => {
        // Test mock uses fixed offsets: LA=UTC-8 (PST), ET=UTC-5 (EST)
        // 19:00 UTC → 11:00 PST (UTC-8), 14:00 EST (UTC-5)
        const event = makeEvent({
            summary: 'Morning Call',
            start:   new Date('2026-03-18T19:00:00Z'), // 11:00 PST, 14:00 EST
            end:     new Date('2026-03-18T20:00:00Z'), // 12:00 PST, 15:00 EST
        });
        const resultPT = formatCalendarContext([event], NOW, 'America/Los_Angeles');
        const resultET = formatCalendarContext([event], NOW, 'America/New_York');
        expect(resultPT).toContain('11:00–12:00 PST');
        expect(resultET).toContain('14:00–15:00 EST');
    });

    it('omits location, attendees, and status suffixes when fields are absent', () => {
        const event = makeEvent({
            summary: 'Minimal Event',
            start:   new Date('2026-03-18T17:00:00Z'),
            end:     new Date('2026-03-18T18:00:00Z'),
        });
        const result = formatCalendarContext([event], NOW, TZ);
        expect(result).not.toContain('@');
        expect(result).not.toContain('attendee');
        expect(result).not.toContain('[confirmed]');
        expect(result).not.toContain('[tentative]');
        expect(result).not.toContain('[cancelled]');
    });

    it('includes calendar header', () => {
        const event = makeEvent({
            summary: 'Any Event',
            start:   new Date('2026-03-18T17:00:00Z'),
            end:     new Date('2026-03-18T18:00:00Z'),
        });
        const result = formatCalendarContext([event], NOW, TZ);
        expect(result).toContain('## Calendar');
    });

    it('sorts days chronologically', () => {
        const events = [
            makeEvent({
                summary: 'Future Event',
                start:   new Date('2026-03-20T17:00:00Z'), // Thu
                end:     new Date('2026-03-20T18:00:00Z'),
            }),
            makeEvent({
                summary: 'Past Event',
                start:   new Date('2026-03-17T17:00:00Z'), // Mon (yesterday)
                end:     new Date('2026-03-17T18:00:00Z'),
            }),
            makeEvent({
                summary: 'Today Event',
                start:   new Date('2026-03-18T17:00:00Z'), // Tue (today)
                end:     new Date('2026-03-18T18:00:00Z'),
            }),
        ];
        const result = formatCalendarContext(events, NOW, TZ);
        const yesterdayPos = result.indexOf('Yesterday');
        const todayPos = result.indexOf('Today');
        const futurePos = result.indexOf('Fri Mar 20');
        expect(yesterdayPos).toBeLessThan(todayPos);
        expect(todayPos).toBeLessThan(futurePos);
    });

    it('groups event by local date, not UTC date (timezone boundary)', () => {
        // 2026-03-19T05:00:00Z is 10:00 PM on Mar 18 in America/Los_Angeles (PDT = UTC-7)
        // Without { zone: timezone }, this would be grouped under Mar 19 (UTC date)
        // With the correct timezone, it must group under Mar 18
        const event = makeEvent({
            summary: 'Late Night Event',
            start:   new Date('2026-03-19T05:00:00Z'), // Mar 18 21:00 PST, Mar 19 UTC
            end:     new Date('2026-03-19T06:00:00Z'),
        });
        const result = formatCalendarContext([event], NOW, TZ);
        expect(result).toContain('### Today');
        expect(result).not.toContain('### Tomorrow');
    });

    it('sorts all-day events by start time and timed events by start time, all-day first', () => {
        // Shuffled input order: timed-late, all-day-A, timed-early, all-day-B
        // Expected output order: all-day-A, all-day-B (both 2026-03-18; equal sort
        //   positions keep input order), timed-early, timed-late
        //
        // Timed Early (09:00Z) starts before any all-day date could be mistaken for an
        // instant, so all-day ranges must outrank it by variant, not by time; and a
        // timed event first in the input catches a reversed or summed comparator.
        const events = [
            makeEvent({
                summary: 'Timed Late',
                start:   new Date('2026-03-18T17:00:00Z'), // 09:00 PST
                end:     new Date('2026-03-18T18:00:00Z'),
            }),
            makeEvent({
                summary:  'All Day A',
                start:    new Date('2026-03-18T12:00:00Z'), // all-day, 04:00 PST
                end:      new Date('2026-03-19T12:00:00Z'),
                isAllDay: true,
            }),
            makeEvent({
                summary: 'Timed Early',
                start:   new Date('2026-03-18T09:00:00Z'), // 01:00 PST — same local day, BEFORE All Day A's 12:00Z
                end:     new Date('2026-03-18T10:00:00Z'),
            }),
            makeEvent({
                summary:  'All Day B',
                start:    new Date('2026-03-18T22:00:00Z'), // all-day, 14:00 PST — later than timed events
                end:      new Date('2026-03-19T22:00:00Z'),
                isAllDay: true,
            }),
        ];
        const result = formatCalendarContext(events, NOW, TZ);
        const allDayAPos    = result.indexOf('All Day A');
        const allDayBPos    = result.indexOf('All Day B');
        const timedEarlyPos = result.indexOf('Timed Early');
        const timedLatePos  = result.indexOf('Timed Late');
        expect(allDayAPos).toBeLessThan(allDayBPos);
        expect(allDayBPos).toBeLessThan(timedEarlyPos);
        expect(timedEarlyPos).toBeLessThan(timedLatePos);
    });

    it('separates sections with newlines', () => {
        const event = makeEvent({
            summary: 'Newline Test',
            start:   new Date('2026-03-18T17:00:00Z'),
            end:     new Date('2026-03-18T18:00:00Z'),
        });
        const result = formatCalendarContext([event], NOW, TZ);
        // The output must have the calendar header and day header on separate lines
        const lines = result.split('\n');
        expect(lines[0]).toBe('## Calendar');
        expect(lines[1]).toMatch(/^### /);
    });

    it('omits attendee count for empty attendees array', () => {
        // event.attendees.length > 0 must be false for [], so "(0 attendees)" must not appear
        const event = makeEvent({
            summary:   'Empty Attendees',
            start:     new Date('2026-03-18T17:00:00Z'),
            end:       new Date('2026-03-18T18:00:00Z'),
            attendees: [],
        });
        const result = formatCalendarContext([event], NOW, TZ);
        expect(result).not.toContain('0 attendee');
        expect(result).not.toContain('attendee');
    });

    // --- Multi-timezone display ---

    it('shows only local+UTC for event with no source timezone', () => {
        // No timezone property on the event — should show izzy TZ and UTC
        const event = makeEvent({
            summary: 'No TZ Event',
            start:   new Date('2026-03-18T17:00:00Z'), // 09:00 PST
            end:     new Date('2026-03-18T18:00:00Z'), // 10:00 PST
        });
        const result = formatCalendarContext([event], NOW, TZ);
        expect(result).toContain('09:00–10:00 PST');
        expect(result).toContain('(17:00–18:00 UTC)');
        // Event line should have exactly one parenthetical (the UTC suffix only)
        const eventLine = result.split('\n').find(l => l.startsWith('- ')) ?? '';
        expect(eventLine.match(/\(/g) ?? []).toHaveLength(1);
    });

    it('shows local + event TZ + UTC when event has a different source timezone', () => {
        // Event created in America/New_York (EST = UTC-5), displayed in America/Los_Angeles (PST = UTC-8)
        // 17:00 UTC = 09:00 PST, = 12:00 EST
        const event = makeEvent({
            summary:  'East Coast Meeting',
            start:    new Date('2026-03-18T17:00:00Z'), // 09:00 PST, 12:00 EST
            end:      new Date('2026-03-18T18:00:00Z'), // 10:00 PST, 13:00 EST
            timezone: 'America/New_York',
        });
        const result = formatCalendarContext([event], NOW, TZ);
        // Izzy's local time
        expect(result).toContain('09:00–10:00 PST');
        // Event's source timezone
        expect(result).toContain('12:00–13:00 EST');
        // UTC
        expect(result).toContain('17:00–18:00 UTC');
        // Format: local (eventTZ / UTC)
        expect(result).toContain('(12:00–13:00 EST / 17:00–18:00 UTC)');
    });

    it('shows only local+UTC when event source timezone equals izzy timezone', () => {
        // Event timezone same as Izzy's — no need to show event TZ separately
        const event = makeEvent({
            summary:  'Same TZ Event',
            start:    new Date('2026-03-18T17:00:00Z'), // 09:00 PST
            end:      new Date('2026-03-18T18:00:00Z'), // 10:00 PST
            timezone: 'America/Los_Angeles',             // same as izzyTimezone
        });
        const result = formatCalendarContext([event], NOW, TZ);
        expect(result).toContain('09:00–10:00 PST');
        expect(result).toContain('(17:00–18:00 UTC)');
        // Event line should have exactly one parenthetical (UTC only, no event TZ duplicate)
        const eventLine = result.split('\n').find(l => l.startsWith('- ')) ?? '';
        expect(eventLine.match(/\(/g) ?? []).toHaveLength(1);
        // No duplicate PST in parens
        expect(result).not.toContain('(09:00');
    });

    it('shows only UTC when izzyTimezone is UTC (no duplicate)', () => {
        // UTC context: no extra suffix needed — just show UTC
        const event = makeEvent({
            summary: 'Zulu Event',
            start:   new Date('2026-03-18T17:00:00Z'),
            end:     new Date('2026-03-18T18:00:00Z'),
        });
        const result = formatCalendarContext([event], NOW, 'UTC');
        // Event line must be exactly this format with no extra suffix
        expect(result).toContain('- 17:00–18:00 UTC: Zulu Event [Work]');
    });

    it('shows event native timezone suffix when izzyTimezone is UTC and event has a non-UTC timezone', () => {
        // Bug fix: when izzyTimezone=UTC but event has America/Los_Angeles, show the event's native TZ
        // 22:00 UTC = 14:00 PST (UTC-8)
        const event = makeEvent({
            summary:  'Pacific Event',
            start:    new Date('2026-03-18T22:00:00Z'), // 14:00 PST
            end:      new Date('2026-03-18T23:45:00Z'), // 15:45 PST
            timezone: 'America/Los_Angeles',
        });
        const result = formatCalendarContext([event], NOW, 'UTC');
        // Primary display is in UTC
        expect(result).toContain('22:00–23:45 UTC');
        // Suffix shows event's native timezone
        expect(result).toContain('(14:00–15:45 PST)');
    });

    it('shows no suffix when izzyTimezone is UTC and event has no timezone', () => {
        // When izzyTimezone=UTC and event has no timezone property, no suffix needed
        const event = makeEvent({
            summary: 'No TZ UTC Event',
            start:   new Date('2026-03-18T17:00:00Z'),
            end:     new Date('2026-03-18T18:00:00Z'),
        });
        const result = formatCalendarContext([event], NOW, 'UTC');
        expect(result).toContain('- 17:00–18:00 UTC: No TZ UTC Event [Work]');
        // No suffix parenthetical
        const eventLine = result.split('\n').find(l => l.startsWith('- ')) ?? '';
        expect(eventLine).not.toContain('(');
    });

    it('shows no suffix when izzyTimezone is UTC and event timezone is also UTC', () => {
        // When izzyTimezone=UTC and event.timezone=UTC, no suffix — they are identical
        const event = makeEvent({
            summary:  'Explicit UTC Event',
            start:    new Date('2026-03-18T17:00:00Z'),
            end:      new Date('2026-03-18T18:00:00Z'),
            timezone: 'UTC',
        });
        const result = formatCalendarContext([event], NOW, 'UTC');
        expect(result).toContain('- 17:00–18:00 UTC: Explicit UTC Event [Work]');
        // No suffix parenthetical
        const eventLine = result.split('\n').find(l => l.startsWith('- ')) ?? '';
        expect(eventLine).not.toContain('(');
    });

    it('does not duplicate UTC when event source timezone is UTC', () => {
        // Event stored in UTC — should show UTC once (as event TZ), not twice
        const event = makeEvent({
            summary:  'Zulu Meeting',
            start:    new Date('2026-03-18T17:00:00Z'), // 09:00 PST, 17:00 UTC
            end:      new Date('2026-03-18T18:00:00Z'), // 10:00 PST, 18:00 UTC
            timezone: 'UTC',
        });
        const result = formatCalendarContext([event], NOW, TZ);
        // Izzy's local time shown
        expect(result).toContain('09:00–10:00 PST');
        // UTC is the event source timezone, so it appears once in the parenthetical
        expect(result).toContain('(17:00–18:00 UTC)');
        // UTC must appear exactly once (not twice) in the event line
        const eventLine = result.split('\n').find(l => l.startsWith('- ')) ?? '';
        const utcCount = (eventLine.match(/UTC/g) ?? []).length;
        expect(utcCount).toBe(1);
    });

    it('all-day events show no timezone info regardless of event.timezone', () => {
        const event = makeEvent({
            summary:  'All Day TZ Test',
            start:    new Date('2026-03-18T08:00:00Z'),
            end:      new Date('2026-03-19T08:00:00Z'),
            isAllDay: true,
            timezone: 'America/New_York',
        });
        const result = formatCalendarContext([event], NOW, TZ);
        expect(result).toContain('All day: All Day TZ Test');
        expect(result).not.toContain('PST');
        expect(result).not.toContain('EST');
        expect(result).not.toContain('UTC');
    });

    it('uses dated labels for events earlier than yesterday', () => {
        const event = makeEvent({
            summary: 'Earlier Event',
            start:   new Date('2026-03-16T17:00:00Z'),
            end:     new Date('2026-03-16T18:00:00Z'),
        });
        const result = formatCalendarContext([event], NOW, TZ);
        expect(result).toContain('### Mon Mar 16');
        expect(result).not.toContain('### Yesterday');
    });

    it('keeps source and UTC timezones in display priority order', () => {
        const event = makeEvent({
            summary:  'Priority Meeting',
            start:    new Date('2026-03-18T17:00:00Z'),
            end:      new Date('2026-03-18T18:00:00Z'),
            timezone: 'America/New_York',
        });
        const result = formatCalendarContext([event], NOW, TZ);
        expect(result).toContain(
            '- 09:00–10:00 PST (12:00–13:00 EST / 17:00–18:00 UTC): Priority Meeting [Work]'
        );
    });

    it('renders all optional event details as one readable calendar line', () => {
        const event = makeEvent({
            summary:       'Complete Event',
            start:         new Date('2026-03-18T17:00:00Z'),
            end:           new Date('2026-03-18T18:00:00Z'),
            isAllDay:      true,
            location:      'Room 1',
            attendees:     ['attendee@example.com'],
            status:        'tentative',
            calendarLabel: 'Personal',
        });
        const result = formatCalendarContext([event], NOW, TZ);
        expect(result).toContain(
            '- All day: Complete Event [Personal] @ Room 1 (1 attendee) [tentative]'
        );
    });
});
