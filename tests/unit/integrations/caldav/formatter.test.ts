import { describe, it, expect } from 'bun:test';
import { formatCalendarContext } from '@/integrations/caldav/formatter';
import { type CalendarEvent } from '@/integrations/caldav/types';

const TZ = 'America/Los_Angeles';

// Reference: 'now' is Tuesday 2026-03-18 at 10:00 AM Pacific (18:00 UTC)
const NOW = new Date('2026-03-18T18:00:00Z');

function makeEvent(overrides: Partial<CalendarEvent> & Pick<CalendarEvent, 'summary' | 'start' | 'end'>): CalendarEvent {
    return {
        uid:           `uid-${overrides.summary}`,
        isAllDay:      false,
        calendarLabel: 'Work',
        ...overrides,
    };
}

describe.concurrent('formatCalendarContext', () => {
    it('returns empty string for empty events array', () => {
        expect(formatCalendarContext([], NOW, TZ)).toBe('');
    });

    it('formats a single timed event with time, label, and no extras', () => {
        const event = makeEvent({
            summary: 'Team Standup',
            start:   new Date('2026-03-18T17:00:00Z'), // 9:00 AM PT
            end:     new Date('2026-03-18T17:30:00Z'), // 9:30 AM PT
        });
        const result = formatCalendarContext([event], NOW, TZ);
        expect(result).toContain('9:00 AM – 9:30 AM: Team Standup [Work]');
        expect(result).not.toContain('@');
        expect(result).not.toContain('attendee');
    });

    it('formats a single timed event with location', () => {
        const event = makeEvent({
            summary:  'Product Review',
            start:    new Date('2026-03-18T17:00:00Z'), // 9:00 AM PT
            end:      new Date('2026-03-18T18:00:00Z'), // 10:00 AM PT
            location: 'Conference Room A',
        });
        const result = formatCalendarContext([event], NOW, TZ);
        expect(result).toContain('9:00 AM – 10:00 AM: Product Review [Work] @ Conference Room A');
    });

    it('formats an all-day event', () => {
        const event = makeEvent({
            summary:       "Craig's Birthday",
            start:         new Date('2026-03-18T08:00:00Z'), // all-day, local start
            end:           new Date('2026-03-19T08:00:00Z'),
            isAllDay:      true,
            calendarLabel: 'Personal',
        });
        const result = formatCalendarContext([event], NOW, TZ);
        expect(result).toContain("All day: Craig's Birthday [Personal]");
        expect(result).not.toContain('AM');
        expect(result).not.toContain('PM');
    });

    it('groups multiple events on the same day under one header', () => {
        const events = [
            makeEvent({
                summary: 'Morning Standup',
                start:   new Date('2026-03-18T16:00:00Z'), // 8:00 AM PT
                end:     new Date('2026-03-18T16:30:00Z'),
            }),
            makeEvent({
                summary: 'Afternoon Sync',
                start:   new Date('2026-03-18T21:00:00Z'), // 1:00 PM PT
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
                start:   new Date('2026-03-17T17:00:00Z'), // yesterday PT
                end:     new Date('2026-03-17T18:00:00Z'),
            }),
            makeEvent({
                summary: 'Tuesday Meeting',
                start:   new Date('2026-03-18T17:00:00Z'), // today PT
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
            start:   new Date('2026-03-17T17:00:00Z'), // Tue Mar 17 in LA (UTC-8 in test mock)
            end:     new Date('2026-03-17T18:00:00Z'),
        });
        const result = formatCalendarContext([event], NOW, TZ);
        expect(result).toContain('### Yesterday (Tue Mar 17)');
    });

    it('shows "Today" label for today', () => {
        const event = makeEvent({
            summary: 'Today Event',
            start:   new Date('2026-03-18T17:00:00Z'), // Wed Mar 18 in LA (UTC-8 in test mock)
            end:     new Date('2026-03-18T18:00:00Z'),
        });
        const result = formatCalendarContext([event], NOW, TZ);
        expect(result).toContain('### Today (Wed Mar 18)');
    });

    it('shows "Tomorrow" label for one day after today', () => {
        const event = makeEvent({
            summary: 'Tomorrow Event',
            start:   new Date('2026-03-19T17:00:00Z'), // Thu Mar 19 in LA (UTC-8 in test mock)
            end:     new Date('2026-03-19T18:00:00Z'),
        });
        const result = formatCalendarContext([event], NOW, TZ);
        expect(result).toContain('### Tomorrow (Thu Mar 19)');
    });

    it('shows "DayName Mon D" for days beyond tomorrow', () => {
        const event = makeEvent({
            summary: 'Future Event',
            start:   new Date('2026-03-20T17:00:00Z'), // Fri Mar 20 in LA (UTC-8 in test mock)
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
                start:   new Date('2026-03-18T08:00:00Z'), // early morning PT
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
        const timedPos = result.indexOf('12:00 AM');
        expect(allDayPos).toBeLessThan(timedPos);
    });

    it('sorts timed events by start time within a day', () => {
        const events = [
            makeEvent({
                summary: 'Late Event',
                start:   new Date('2026-03-18T23:00:00Z'), // 3:00 PM PT
                end:     new Date('2026-03-18T23:30:00Z'),
            }),
            makeEvent({
                summary: 'Early Event',
                start:   new Date('2026-03-18T16:00:00Z'), // 8:00 AM PT
                end:     new Date('2026-03-18T16:30:00Z'),
            }),
        ];
        const result = formatCalendarContext(events, NOW, TZ);
        const earlyPos = result.indexOf('Early Event');
        const latePos = result.indexOf('Late Event');
        expect(earlyPos).toBeLessThan(latePos);
    });

    it('displays times in the specified timezone', () => {
        // Test mock uses fixed offsets: LA=UTC-8, ET=UTC-5 (no DST adjustment)
        // 19:00 UTC → 11:00 AM LA (UTC-8), 2:00 PM ET (UTC-5)
        const event = makeEvent({
            summary: 'Morning Call',
            start:   new Date('2026-03-18T19:00:00Z'), // 11:00 AM LA, 2:00 PM ET
            end:     new Date('2026-03-18T20:00:00Z'), // 12:00 PM LA, 3:00 PM ET
        });
        const resultPT = formatCalendarContext([event], NOW, 'America/Los_Angeles');
        const resultET = formatCalendarContext([event], NOW, 'America/New_York');
        expect(resultPT).toContain('11:00 AM – 12:00 PM');
        expect(resultET).toContain('2:00 PM – 3:00 PM');
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
});
