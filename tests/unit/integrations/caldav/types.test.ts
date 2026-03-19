import { describe, test, expect } from 'bun:test';
import { type CalendarInfo, type CalendarEvent } from '@/integrations/caldav/types';

describe.concurrent('CalendarInfo', () => {
    test('should accept a minimal CalendarInfo with required fields only', () => {
        const calendar: CalendarInfo = {
            path:        '/calendars/user/default/',
            displayName: 'Default',
        };
        expect(calendar.path).toBe('/calendars/user/default/');
        expect(calendar.displayName).toBe('Default');
        expect(calendar.color).toBeUndefined();
        expect(calendar.description).toBeUndefined();
    });

    test('should accept a full CalendarInfo with all fields', () => {
        const calendar: CalendarInfo = {
            path:        '/calendars/user/work/',
            displayName: 'Work',
            color:       '#ff0000',
            description: 'Work calendar',
        };
        expect(calendar.color).toBe('#ff0000');
        expect(calendar.description).toBe('Work calendar');
    });
});

describe.concurrent('CalendarEvent', () => {
    test('should accept a minimal CalendarEvent with required fields only', () => {
        const event: CalendarEvent = {
            uid:           'abc-123',
            summary:       'Team meeting',
            start:         new Date('2026-03-18T10:00:00Z'),
            end:           new Date('2026-03-18T11:00:00Z'),
            isAllDay:      false,
            calendarLabel: 'Work',
        };
        expect(event.uid).toBe('abc-123');
        expect(event.summary).toBe('Team meeting');
        expect(event.start).toBeInstanceOf(Date);
        expect(event.end).toBeInstanceOf(Date);
        expect(event.isAllDay).toBe(false);
        expect(event.calendarLabel).toBe('Work');
        expect(event.location).toBeUndefined();
        expect(event.description).toBeUndefined();
        expect(event.attendees).toBeUndefined();
        expect(event.status).toBeUndefined();
        expect(event.recurrenceId).toBeUndefined();
    });

    test('should accept a full CalendarEvent with all fields', () => {
        const event: CalendarEvent = {
            uid:           'xyz-789',
            summary:       'Conference',
            start:         new Date('2026-04-01T09:00:00Z'),
            end:           new Date('2026-04-01T17:00:00Z'),
            location:      'Room 101',
            description:   'Annual conference',
            attendees:     ['alice@example.com', 'bob@example.com'],
            isAllDay:      false,
            calendarLabel: 'Work',
            status:        'confirmed',
            recurrenceId:  '20260401T090000Z',
        };
        expect(event.location).toBe('Room 101');
        expect(event.description).toBe('Annual conference');
        expect(event.attendees).toEqual(['alice@example.com', 'bob@example.com']);
        expect(event.status).toBe('confirmed');
        expect(event.recurrenceId).toBe('20260401T090000Z');
    });

    test('should accept all valid status values', () => {
        const statuses: CalendarEvent['status'][] = ['confirmed', 'tentative', 'cancelled'];
        for(const status of statuses) {
            const event: CalendarEvent = {
                uid:           `event-${status ?? 'none'}`,
                summary:       'Test',
                start:         new Date(),
                end:           new Date(),
                isAllDay:      false,
                calendarLabel: 'Personal',
                status,
            };
            expect(event.status).toBe(status);
        }
    });

    test('should accept all-day events', () => {
        const event: CalendarEvent = {
            uid:           'allday-001',
            summary:       'Birthday',
            start:         new Date('2026-03-18'),
            end:           new Date('2026-03-19'),
            isAllDay:      true,
            calendarLabel: 'Personal',
        };
        expect(event.isAllDay).toBe(true);
    });
});
