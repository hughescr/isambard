import _ from 'lodash';
import { z } from 'zod';

/**
 * Time of day categories based on UTC hour.
 */
export const timeOfDaySchema = z.enum(['morning', 'afternoon', 'evening', 'night']);
export type TimeOfDay = z.infer<typeof timeOfDaySchema>;

/**
 * Day of week names.
 */
export const dayOfWeekSchema = z.enum([
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
]);
export type DayOfWeek = z.infer<typeof dayOfWeekSchema>;

/**
 * Complete time context for prompt injection.
 */
export const timeContextSchema = z.object({
    utc:           z.string().datetime(),
    dayOfWeek:     dayOfWeekSchema,
    timeOfDay:     timeOfDaySchema,
    userTimezone:  z.string().optional(),
    userLocalTime: z.string().optional(),
});
export type TimeContext = z.infer<typeof timeContextSchema>;

// Time constants in milliseconds
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const MS_PER_WEEK = 7 * MS_PER_DAY;
const MS_PER_MONTH = 30 * MS_PER_DAY;
const MS_PER_YEAR = 365 * MS_PER_DAY;

/**
 * Formats a date as human-readable relative time.
 * @param date - The date to format
 * @param now - Optional reference time (defaults to current time)
 * @returns Human-readable string like "just now", "2 hours ago", "3 days ago"
 */
export function formatRelativeTime(date: Date, now: Date = new Date()): string {
    const diffMs = now.getTime() - date.getTime();

    if(diffMs < MS_PER_MINUTE) {
        return 'just now';
    }

    if(diffMs < MS_PER_HOUR) {
        const minutes = Math.floor(diffMs / MS_PER_MINUTE);
        return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
    }

    if(diffMs < MS_PER_DAY) {
        const hours = Math.floor(diffMs / MS_PER_HOUR);
        return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
    }

    if(diffMs < MS_PER_WEEK) {
        const days = Math.floor(diffMs / MS_PER_DAY);
        return days === 1 ? '1 day ago' : `${days} days ago`;
    }

    if(diffMs < MS_PER_MONTH) {
        const weeks = Math.floor(diffMs / MS_PER_WEEK);
        return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`;
    }

    if(diffMs < MS_PER_YEAR) {
        const months = Math.floor(diffMs / MS_PER_MONTH);
        return months === 1 ? '1 month ago' : `${months} months ago`;
    }

    const years = Math.floor(diffMs / MS_PER_YEAR);
    return years === 1 ? '1 year ago' : `${years} years ago`;
}

/**
 * Gets the time of day category based on UTC hour.
 * - morning: 5:00-11:59
 * - afternoon: 12:00-16:59
 * - evening: 17:00-20:59
 * - night: 21:00-4:59
 * @param date - The date to categorize
 * @returns Time of day category
 */
export function getTimeOfDay(date: Date): TimeOfDay {
    const hour = date.getUTCHours();

    if(hour >= 5 && hour < 12) {
        return 'morning';
    }
    if(hour >= 12 && hour < 17) {
        return 'afternoon';
    }
    if(hour >= 17 && hour < 21) {
        return 'evening';
    }
    return 'night';
}

/**
 * Gets the full day name for a date.
 * @param date - The date
 * @returns Full day name (e.g., "Monday", "Tuesday")
 */
export function getDayOfWeek(date: Date): DayOfWeek {
    const days = [
        'Sunday',
        'Monday',
        'Tuesday',
        'Wednesday',
        'Thursday',
        'Friday',
        'Saturday',
    ] as const;
    return days[date.getUTCDay()];
}

/**
 * Builds a complete time context for prompt injection.
 * @param userTimezone - Optional IANA timezone (e.g., "America/Los_Angeles")
 * @returns TimeContext object with UTC time and optional local time
 */
export function getCurrentTimeContext(userTimezone?: string): TimeContext {
    const now = new Date();

    const context: TimeContext = {
        utc:       now.toISOString(),
        dayOfWeek: getDayOfWeek(now),
        timeOfDay: getTimeOfDay(now),
    };

    if(userTimezone) {
        context.userTimezone = userTimezone;
        try {
            // Stryker disable next-line StringLiteral: DateTimeFormat options must use exact strings
            const formatter = new Intl.DateTimeFormat('en-CA', {
                timeZone: userTimezone,
                // Stryker disable next-line StringLiteral: DateTimeFormat options must use exact strings
                year:     'numeric',
                // Stryker disable next-line StringLiteral: DateTimeFormat options must use exact strings
                month:    '2-digit',
                // Stryker disable next-line StringLiteral: DateTimeFormat options must use exact strings
                day:      '2-digit',
                hour:     '2-digit',
                minute:   '2-digit',
                second:   '2-digit',
                hour12:   false,
            });
            const parts = formatter.formatToParts(now);
            // Intl.DateTimeFormat always returns all requested part types, so we can safely
            // use non-null assertion. The find will always succeed for valid timezones.
            const get = (type: string): string =>
                _.find(parts, ['type', type])!.value;
            context.userLocalTime = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
        } catch{
            // Invalid timezone - leave userLocalTime undefined
        }
    }

    return context;
}

/**
 * Formats a memory timestamp for display.
 * @param updatedAt - ISO string timestamp
 * @param now - Optional reference time (defaults to current time)
 * @returns Compact format like "(2 days ago, 2025-01-13T10:00:00Z)"
 */
export function formatMemoryTimestamp(updatedAt: string, now: Date = new Date()): string {
    const date = new Date(updatedAt);
    const relative = formatRelativeTime(date, now);
    return `(${relative}, ${updatedAt})`;
}

/**
 * Formats a date as short relative time for search results.
 * @param date - The date to format
 * @param now - Optional reference time (defaults to current time)
 * @returns Compact form like "2h ago", "3d ago", "2w ago"
 */
export function formatShortRelativeTime(date: Date, now: Date = new Date()): string {
    const diffMs = now.getTime() - date.getTime();

    if(diffMs < MS_PER_MINUTE) {
        return 'now';
    }

    if(diffMs < MS_PER_HOUR) {
        const minutes = Math.floor(diffMs / MS_PER_MINUTE);
        return `${minutes}m ago`;
    }

    if(diffMs < MS_PER_DAY) {
        const hours = Math.floor(diffMs / MS_PER_HOUR);
        return `${hours}h ago`;
    }

    if(diffMs < MS_PER_WEEK) {
        const days = Math.floor(diffMs / MS_PER_DAY);
        return `${days}d ago`;
    }

    if(diffMs < MS_PER_MONTH) {
        const weeks = Math.floor(diffMs / MS_PER_WEEK);
        return `${weeks}w ago`;
    }

    if(diffMs < MS_PER_YEAR) {
        const months = Math.floor(diffMs / MS_PER_MONTH);
        return `${months}mo ago`;
    }

    const years = Math.floor(diffMs / MS_PER_YEAR);
    return `${years}y ago`;
}
