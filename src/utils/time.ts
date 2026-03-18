import { logger } from '@hughescr/logger';
import { DateTime, IANAZone } from 'luxon';
import { z } from 'zod';

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
    utc:           z.iso.datetime(),
    dayOfWeek:     dayOfWeekSchema,
    timeOfDay:     timeOfDaySchema,
    utcDayOfWeek:  dayOfWeekSchema,
    utcTimeOfDay:  timeOfDaySchema,
    userTimezone:  z.string().optional(),
    userLocalTime: z.string().optional(),
});
export type TimeContext = z.infer<typeof timeContextSchema>;

/**
 * Format strategy for relative time output strings.
 * Each property returns the formatted string for a given time unit value.
 */
interface RelativeTimeFormat {
    now:     string
    minutes: (n: number) => string
    hours:   (n: number) => string
    days:    (n: number) => string
    weeks:   (n: number) => string
    months:  (n: number) => string
    years:   (n: number) => string
}

/**
 * Core relative time formatting logic shared by both public formatters.
 * @param date - The date to format
 * @param now - Reference time
 * @param fmt - Format strategy providing output strings for each time unit
 * @returns Formatted relative time string
 */
function formatRelativeTimeCore(date: Date, now: Date, fmt: RelativeTimeFormat): string {
    const dtDate = DateTime.fromJSDate(date);
    const dtNow = DateTime.fromJSDate(now);

    const seconds = Math.floor(dtNow.diff(dtDate, 'seconds').seconds);

    if(seconds < SECONDS_THRESHOLD) {
        return fmt.now;
    }

    const minutes = Math.floor(dtNow.diff(dtDate, 'minutes').minutes);
    if(minutes < MINUTES_THRESHOLD) {
        return fmt.minutes(minutes);
    }

    const hours = Math.floor(dtNow.diff(dtDate, 'hours').hours);
    if(hours < HOURS_THRESHOLD) {
        return fmt.hours(hours);
    }

    const days = Math.floor(dtNow.diff(dtDate, 'days').days);
    if(days < DAYS_THRESHOLD) {
        return fmt.days(days);
    }

    const weeks = Math.floor(dtNow.diff(dtDate, 'weeks').weeks);
    const months = Math.floor(dtNow.diff(dtDate, 'months').months);
    // Stryker disable next-line ConditionalExpression,EqualityOperator: Complex time boundary check, both conditions needed for correct bucketing, <= boundary is equivalent
    if(weeks < WEEKS_THRESHOLD && months < 1) {
        return fmt.weeks(weeks);
    }

    if(months < MONTHS_THRESHOLD) {
        return fmt.months(months);
    }

    const years = Math.floor(dtNow.diff(dtDate, 'years').years);
    return fmt.years(years);
}

const longFormat: RelativeTimeFormat = {
    now:     'just now',
    minutes: n => (n === 1 ? '1 minute ago' : `${n} minutes ago`),
    hours:   n => (n === 1 ? '1 hour ago' : `${n} hours ago`),
    days:    n => (n === 1 ? '1 day ago' : `${n} days ago`),
    weeks:   n => (n === 1 ? '1 week ago' : `${n} weeks ago`),
    months:  n => (n === 1 ? '1 month ago' : `${n} months ago`),
    years:   n => (n === 1 ? '1 year ago' : `${n} years ago`),
};

const shortFormat: RelativeTimeFormat = {
    now:     'now',
    minutes: n => `${n}m ago`,
    hours:   n => `${n}h ago`,
    days:    n => `${n}d ago`,
    weeks:   n => `${n}w ago`,
    months:  n => `${n}mo ago`,
    years:   n => `${n}y ago`,
};

/**
 * Formats a date as human-readable relative time using Luxon.
 * @param date - The date to format
 * @param now - Optional reference time (defaults to current time)
 * @returns Human-readable string like "just now", "2 hours ago", "3 days ago"
 */
export function formatRelativeTime(date: Date, now: Date = new Date()): string {
    return formatRelativeTimeCore(date, now, longFormat);
}

/**
 * Resolves a timezone string to a valid IANA timezone.
 * @param userTimezone - Optional IANA timezone string
 * @returns Valid IANA timezone string (never undefined)
 */
export function resolveTimezone(userTimezone?: string): string {
    if(userTimezone) {
        if(IANAZone.isValidZone(userTimezone)) {
            return userTimezone;
        } else {
            // Stryker disable next-line StringLiteral: log message string is observability-only configuration
            logger.warn({ userTimezone }, 'Invalid timezone provided, falling back to server timezone');
        }
    }

    try {
        return DateTime.local().zoneName;
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
    return DateTime.fromISO(isoString).setZone(timezone).toFormat("yyyy-MM-dd'T'HH:mm:ss");
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
    const hour = DateTime.fromJSDate(date).setZone(tz).hour;

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
    return DateTime.fromJSDate(date).setZone(tz).weekdayLong as DayOfWeek;
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
        // Stryker disable next-line StringLiteral: 'UTC' → '' is equivalent when server timezone is UTC (test environment)
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
 * Formats a date as short relative time for search results using Luxon.
 * @param date - The date to format
 * @param now - Optional reference time (defaults to current time)
 * @returns Compact form like "2h ago", "3d ago", "2w ago"
 */
export function formatShortRelativeTime(date: Date, now: Date = new Date()): string {
    return formatRelativeTimeCore(date, now, shortFormat);
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

/**
 * Formats a time header with UTC, Izzy's timezone, and optionally the user's timezone.
 * Always includes UTC and Izzy (server) timezone lines.
 * Includes user timezone line only if provided and different from Izzy's timezone.
 * @param userTimezone - Optional IANA timezone string for the user
 * @returns Formatted time header with 2-3 lines depending on timezone configuration
 * @example
 * ```
 * ## Current Time
 * - UTC: 2026-02-09T22:30:00.000Z (Sunday evening)
 * - Izzy: 2026-02-09T14:30:00 America/Los_Angeles (Sunday afternoon)
 * - User: 2026-02-09T17:30:00 America/New_York (Sunday evening)
 * ```
 */
export function formatTimeHeader(userTimezone?: string): string {
    const timeContext = getCurrentTimeContext();
    const izzyTimezone = resolveTimezone();
    const izzyLocal = formatLocalDateTime(timeContext.utc, izzyTimezone);
    const izzyDow = getDayOfWeek(new Date(timeContext.utc), izzyTimezone);
    const izzyTod = getTimeOfDay(new Date(timeContext.utc), izzyTimezone);

    const lines = [
        '## Current Time',
        `- UTC: ${timeContext.utc} (${timeContext.utcDayOfWeek} ${timeContext.utcTimeOfDay})`,
        `- Izzy: ${izzyLocal} ${izzyTimezone} (${izzyDow} ${izzyTod})`,
    ];

    if(userTimezone && userTimezone !== izzyTimezone) {
        const userLocal = formatLocalDateTime(timeContext.utc, userTimezone);
        const userDow = getDayOfWeek(new Date(timeContext.utc), userTimezone);
        const userTod = getTimeOfDay(new Date(timeContext.utc), userTimezone);
        lines.push(`- User: ${userLocal} ${userTimezone} (${userDow} ${userTod})`);
    }

    return lines.join('\n');
}
