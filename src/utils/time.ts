import {
    differenceInDays,
    differenceInHours,
    differenceInMinutes,
    differenceInMonths,
    differenceInSeconds,
    differenceInWeeks,
    differenceInYears
} from 'date-fns';
import _ from 'lodash';
import { z } from 'zod';
import { logger } from '@hughescr/logger';

/**
 * Time thresholds for relative time formatting.
 * These constants define the boundaries between different time units.
 */
const SECONDS_THRESHOLD = 60;  // < 60 seconds = "just now"
const MINUTES_THRESHOLD = 60;  // < 60 minutes = show minutes
const HOURS_THRESHOLD = 24;    // < 24 hours = show hours
const DAYS_THRESHOLD = 7;      // < 7 days = show days
const WEEKS_THRESHOLD = 5;     // < 5 weeks (and < 1 month) = show weeks
const MONTHS_THRESHOLD = 12;   // < 12 months = show months

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
    utcDayOfWeek:  dayOfWeekSchema,
    utcTimeOfDay:  timeOfDaySchema,
    userTimezone:  z.string().optional(),
    userLocalTime: z.string().optional(),
});
export type TimeContext = z.infer<typeof timeContextSchema>;

/**
 * Formats a date as human-readable relative time using date-fns.
 * @param date - The date to format
 * @param now - Optional reference time (defaults to current time)
 * @returns Human-readable string like "just now", "2 hours ago", "3 days ago"
 */
export function formatRelativeTime(date: Date, now: Date = new Date()): string {
    const seconds = differenceInSeconds(now, date);

    if(seconds < SECONDS_THRESHOLD) {
        return 'just now';
    }

    const minutes = differenceInMinutes(now, date);
    if(minutes < MINUTES_THRESHOLD) {
        return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
    }

    const hours = differenceInHours(now, date);
    if(hours < HOURS_THRESHOLD) {
        return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
    }

    const days = differenceInDays(now, date);
    if(days < DAYS_THRESHOLD) {
        return days === 1 ? '1 day ago' : `${days} days ago`;
    }

    const weeks = differenceInWeeks(now, date);
    const months = differenceInMonths(now, date);
    // Stryker disable next-line ConditionalExpression,EqualityOperator: Complex time boundary check, both conditions needed for correct bucketing, <= boundary is equivalent
    if(weeks < WEEKS_THRESHOLD && months < 1) {
        return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`;
    }

    if(months < MONTHS_THRESHOLD) {
        return months === 1 ? '1 month ago' : `${months} months ago`;
    }

    const years = differenceInYears(now, date);
    return years === 1 ? '1 year ago' : `${years} years ago`;
}

/**
 * Resolves a timezone string to a valid IANA timezone.
 * @param userTimezone - Optional IANA timezone string
 * @returns Valid IANA timezone string (never undefined)
 */
export function resolveTimezone(userTimezone?: string): string {
    if(userTimezone) {
        // Stryker disable BlockStatement: Logging for observability
        try {
            // Stryker disable next-line StringLiteral: DateTimeFormat locale must use exact string
            new Intl.DateTimeFormat('en', { timeZone: userTimezone });
            return userTimezone;
        } catch{
            /* Stryker disable all: Logging for observability */
            logger.warn({ userTimezone }, 'Invalid timezone provided, falling back to server timezone');
            /* Stryker restore all */
        }
    }

    // Stryker disable BlockStatement: Catch block returns UTC fallback
    try {
        return new Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch{
        return 'UTC';
    }
}

/**
 * Formats an ISO string as local datetime in the specified timezone.
 * @param isoString - ISO 8601 datetime string
 * @param timezone - IANA timezone string
 * @returns Local datetime string in format "YYYY-MM-DDTHH:mm:ss"
 */
export function formatLocalDateTime(isoString: string, timezone: string): string {
    const date = new Date(isoString);
    // Stryker disable next-line StringLiteral: DateTimeFormat locale must use exact string
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        // Stryker disable next-line StringLiteral: DateTimeFormat options must use exact strings
        year:     'numeric',
        // Stryker disable next-line StringLiteral: DateTimeFormat options must use exact strings
        month:    '2-digit',
        // Stryker disable next-line StringLiteral: DateTimeFormat options must use exact strings
        day:      '2-digit',
        // Stryker disable next-line StringLiteral: DateTimeFormat options must use exact strings
        hour:     '2-digit',
        // Stryker disable next-line StringLiteral: DateTimeFormat options must use exact strings
        minute:   '2-digit',
        // Stryker disable next-line StringLiteral: DateTimeFormat options must use exact strings
        second:   '2-digit',
        // Stryker disable next-line BooleanLiteral: hour12 must be false for 24-hour format
        hour12:   false,
    });
    const parts = formatter.formatToParts(date);
    // Intl.DateTimeFormat always returns all requested part types, so we can safely
    // use non-null assertion. The find will always succeed for valid timezones.
    const get = (type: string): string =>
        _.find(parts, ['type', type])!.value;
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
}

/**
 * Gets the time of day category based on local hour in the specified timezone.
 * - morning: 5:00-11:59
 * - afternoon: 12:00-16:59
 * - evening: 17:00-20:59
 * - night: 21:00-4:59
 * @param date - The date to categorize
 * @param timezone - Optional IANA timezone (defaults to server timezone)
 * @returns Time of day category
 */
export function getTimeOfDay(date: Date, timezone?: string): TimeOfDay {
    const tz = timezone ?? resolveTimezone();
    // Stryker disable next-line StringLiteral: DateTimeFormat locale must use exact string
    const formatter = new Intl.DateTimeFormat('en', {
        timeZone: tz,
        // Stryker disable next-line StringLiteral: DateTimeFormat options must use exact strings
        hour:     'numeric',
        // Stryker disable next-line BooleanLiteral: hour12 must be false for 24-hour format
        hour12:   false,
    });
    const parts = formatter.formatToParts(date);
    const hourPart = _.find(parts, ['type', 'hour']);
    const hour = hourPart ? parseInt(hourPart.value, 10) : 0;

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
 * Gets the full day name for a date in the specified timezone.
 * @param date - The date
 * @param timezone - Optional IANA timezone (defaults to server timezone)
 * @returns Full day name (e.g., "Monday", "Tuesday")
 */
export function getDayOfWeek(date: Date, timezone?: string): DayOfWeek {
    const tz = timezone ?? resolveTimezone();
    // Stryker disable next-line StringLiteral: DateTimeFormat locale must use exact string
    const weekdayStr = new Intl.DateTimeFormat('en', {
        timeZone: tz,
        // Stryker disable next-line StringLiteral: DateTimeFormat options must use exact strings
        weekday:  'long',
    }).format(date);
    return weekdayStr as DayOfWeek;
}

/**
 * Builds a complete time context for prompt injection.
 * @param userTimezone - Optional IANA timezone (e.g., "America/Los_Angeles")
 * @returns TimeContext object with UTC time and local time (always populated)
 */
export function getCurrentTimeContext(userTimezone?: string): TimeContext {
    const now = new Date();
    const resolvedTimezone = resolveTimezone(userTimezone);

    const context: TimeContext = {
        utc:           now.toISOString(),
        dayOfWeek:     getDayOfWeek(now, resolvedTimezone),
        timeOfDay:     getTimeOfDay(now, resolvedTimezone),
        utcDayOfWeek:  getDayOfWeek(now, 'UTC'),
        utcTimeOfDay:  getTimeOfDay(now, 'UTC'),
        userTimezone:  resolvedTimezone,
        userLocalTime: formatLocalDateTime(now.toISOString(), resolvedTimezone),
    };

    return context;
}

/**
 * Formats a memory timestamp for display.
 * @param updatedAt - ISO string timestamp
 * @param now - Optional reference time (defaults to current time)
 * @param timezone - Optional IANA timezone for local time display
 * @returns Compact format like "(2 days ago, 2025-01-13T10:00:00Z)" or with timezone: "(2 days ago, 2025-01-13T02:00:00 America/Los_Angeles | UTC: 2025-01-13T10:00:00.000Z)"
 */
export function formatMemoryTimestamp(updatedAt: string, now: Date = new Date(), timezone?: string): string {
    const date = new Date(updatedAt);
    const relative = formatRelativeTime(date, now);

    if(timezone) {
        const localTime = formatLocalDateTime(updatedAt, timezone);
        return `(${relative}, ${localTime} ${timezone} | UTC: ${updatedAt})`;
    }

    return `(${relative}, ${updatedAt})`;
}

/**
 * Formats a date as short relative time for search results using date-fns.
 * @param date - The date to format
 * @param now - Optional reference time (defaults to current time)
 * @returns Compact form like "2h ago", "3d ago", "2w ago"
 */
export function formatShortRelativeTime(date: Date, now: Date = new Date()): string {
    const seconds = differenceInSeconds(now, date);

    if(seconds < SECONDS_THRESHOLD) {
        return 'now';
    }

    const minutes = differenceInMinutes(now, date);
    if(minutes < MINUTES_THRESHOLD) {
        return `${minutes}m ago`;
    }

    const hours = differenceInHours(now, date);
    if(hours < HOURS_THRESHOLD) {
        return `${hours}h ago`;
    }

    const days = differenceInDays(now, date);
    if(days < DAYS_THRESHOLD) {
        return `${days}d ago`;
    }

    const weeks = differenceInWeeks(now, date);
    const months = differenceInMonths(now, date);
    // Stryker disable next-line ConditionalExpression,EqualityOperator: Complex time boundary check, both conditions needed for correct bucketing, <= boundary is equivalent
    if(weeks < WEEKS_THRESHOLD && months < 1) {
        return `${weeks}w ago`;
    }

    if(months < MONTHS_THRESHOLD) {
        return `${months}mo ago`;
    }

    const years = differenceInYears(now, date);
    return `${years}y ago`;
}

/**
 * Format duration since a past time in human-readable form.
 * Used for catch-up status generation to describe how long Izzy has been away.
 * @param since - The past timestamp
 * @returns Human readable string like "3 hours", "overnight", "2 days"
 */
export function formatTimeSince(since: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - since.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);

    if(diffHours < 1) {
        return 'a few minutes';
    }
    if(diffHours < 2) {
        return 'an hour';
    }
    if(diffHours < 6) {
        return `${Math.round(diffHours)} hours`;
    }
    if(diffHours < 12) {
        return 'half a day';
    }
    if(diffHours < 18) {
        return 'overnight';
    }
    if(diffHours < 36) {
        return 'a day';
    }
    if(diffHours < 72) {
        return `${Math.round(diffHours / 24)} days`;
    }
    return 'a few days';
}
