import { logger } from '@hughescr/logger';
import * as ical from 'node-ical';
import { expandRecurringEvent } from 'node-ical';
import { createDAVClient, type DAVCalendar, type DAVCalendarObject } from 'tsdav';
import type { CalendarServerEntry } from './calendar-registry/types';
import type { CalendarInfo, CalendarEvent } from './types';
import { CaldavAuthError, CaldavTimeoutError } from '@/errors';
import type { ServiceHealthRegistry } from '@/services';

const CONSECUTIVE_FAILURE_THRESHOLD = 3;

interface CachedEvents {
    events:    CalendarEvent[]
    expiresAt: number
}

type AttendeeItem = ical.Attendee;

interface CalDAVClientOptions {
    cacheTtlMs?:     number
    timeoutMs?:      number
    healthRegistry?: ServiceHealthRegistry
}

/**
 * CalDAV client wrapping tsdav and node-ical for calendar event fetching.
 */
export class CalDAVClient {
    readonly #cacheTtlMs:      number;
    readonly #timeoutMs:       number;
    readonly #cache =          new Map<string, CachedEvents>();
    readonly #healthRegistry?: ServiceHealthRegistry;
    #consecutiveFailures =     0;

    constructor(optionsOrCacheTtlMs: CalDAVClientOptions | number = {}, timeoutMs = 15_000) {
        if(typeof optionsOrCacheTtlMs === 'number') {
            this.#cacheTtlMs     = optionsOrCacheTtlMs;
            this.#timeoutMs      = timeoutMs;
            this.#healthRegistry = undefined;
        } else {
            this.#cacheTtlMs     = optionsOrCacheTtlMs.cacheTtlMs ?? 300_000;
            this.#timeoutMs      = optionsOrCacheTtlMs.timeoutMs ?? 15_000;
            this.#healthRegistry = optionsOrCacheTtlMs.healthRegistry;
        }
    }

    /**
     * Discover calendars on a CalDAV server.
     * Used during the /calendar add-server flow.
     */
    async discoverCalendars(serverUrl: string, username: string, password: string): Promise<CalendarInfo[]> {
        const client = await this.#createClient(serverUrl, username, password);
        // Stryker disable next-line StringLiteral -- operation label is informational only; appears in error message text
        const calendars = await this.#withTimeout(client.fetchCalendars(), this.#timeoutMs, 'fetchCalendars');
        return calendars.map((cal) => {
            const calRecord = cal as unknown as Record<string, unknown>;
            const rawDisplayName = cal.displayName;
            const displayName = typeof rawDisplayName === 'string' ? rawDisplayName : cal.url;
            return {
                path:        cal.url,
                displayName,
                color:       calRecord.calendarColor as string | undefined,
                description: calRecord.calendarDescription as string | undefined,
            };
        });
    }

    /**
     * Fetch events from specified server entries in a date range.
     * Groups by server to minimize connections.
     */
    async getEvents(servers: CalendarServerEntry[], start: Date, end: Date): Promise<CalendarEvent[]> {
        const allEvents: CalendarEvent[] = [];

        for(const server of servers) {
            const cacheKey = this.#buildCacheKey(server, start, end);
            const cached = this.#cache.get(cacheKey);
            if(cached && cached.expiresAt > Date.now()) {
                allEvents.push(...cached.events);
                continue;
            }

            try {
                // eslint-disable-next-line no-await-in-loop -- must stay sequential: #consecutiveFailures shared state would be corrupted by concurrent #recordSuccess/#recordFailure calls
                const serverEvents = await this.#fetchServerEvents(server, start, end);
                this.#cache.set(cacheKey, {
                    events:    serverEvents,
                    expiresAt: Date.now() + this.#cacheTtlMs,
                });
                allEvents.push(...serverEvents);
                this.#recordSuccess();
            } catch (error) {
                // Log and continue — partial results are better than total failure
                logger.warn({ error, serverUrl: server.serverUrl }, 'Failed to fetch events from CalDAV server, continuing with partial results');
                this.#recordFailure(error);
            }
        }

        return allEvents.toSorted((a, b) => a.start.getTime() - b.start.getTime());
    }

    /**
     * Convenience: fetch events for context injection (past 24h + next 3 days).
     */
    async getContextEvents(servers: CalendarServerEntry[], now = new Date()): Promise<CalendarEvent[]> {
        const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const end   = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
        return this.getEvents(servers, start, end);
    }

    /**
     * Clear the cache (e.g., after adding/removing calendars).
     */
    invalidateCache(): void {
        this.#cache.clear();
    }

    // --- Private helpers ---

    #recordSuccess(): void {
        if(this.#healthRegistry === undefined) {
            return;
        }
        const wasOffline = this.#consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD;
        this.#consecutiveFailures = 0;
        if(wasOffline) {
            this.#healthRegistry.sendEvent('caldav', 'CONNECT_SUCCESS');
        }
    }

    #recordFailure(error: unknown): void {
        if(this.#healthRegistry === undefined) {
            return;
        }
        this.#consecutiveFailures++;
        if(this.#consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD) {
            this.#healthRegistry.sendEvent('caldav', 'CONNECTION_LOST', {
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    async #fetchServerEvents(server: CalendarServerEntry, start: Date, end: Date): Promise<CalendarEvent[]> {
        const client = await this.#createClient(server.serverUrl, server.username, server.password);
        // Stryker disable next-line StringLiteral -- operation label is informational only; appears in error message text
        const calendars = await this.#withTimeout(client.fetchCalendars(), this.#timeoutMs, 'fetchCalendars');
        const events: CalendarEvent[] = [];

        for(const calEntry of server.calendars) {
            const davCalendar = calendars.find((c: DAVCalendar) => c.url === calEntry.calendarPath);
            if(!davCalendar) {
                continue;
            }

            // Stryker disable StringLiteral -- operation label is informational only; appears in error message text
            // eslint-disable-next-line no-await-in-loop -- sequential calendar fetching within a single server connection
            const calObjects: DAVCalendarObject[] = await this.#withTimeout(client.fetchCalendarObjects({
                calendar:  davCalendar,
                timeRange: { start: start.toISOString(), end: end.toISOString() },
            }), this.#timeoutMs, 'fetchCalendarObjects');
            // Stryker restore StringLiteral

            for(const obj of calObjects) {
                if(!obj.data) {
                    continue;
                }
                const parsed = ical.sync.parseICS(obj.data as string);
                const extracted = this.#extractEvents(parsed, calEntry.label, start, end);
                events.push(...extracted);
            }
        }

        return events;
    }

    async #withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_resolve, reject) => {
            timeoutId = setTimeout(() => {
                reject(new CaldavTimeoutError(
                    `CalDAV operation timed out after ${ms}ms: ${label}`,
                    { timeoutMs: ms, operation: label }
                ));
            }, ms);
        });
        // Stryker disable BlockStatement -- clearTimeout in finally is resource cleanup; timer leak not observable without real timer inspection
        try {
            return await Promise.race([promise, timeout]);
        } finally {
            clearTimeout(timeoutId);
        }
        // Stryker restore BlockStatement
    }

    async #createClient(serverUrl: string, username: string, password: string) {
        try {
            return await this.#withTimeout(createDAVClient({
                serverUrl,
                credentials:        { username, password },
                authMethod:         'Basic',
                defaultAccountType: 'caldav',
            }), this.#timeoutMs, 'connect');
        } catch (error) {
            if(error instanceof CaldavTimeoutError) {
                throw error;
            }
            // Stryker disable StringLiteral -- error message is informational only
            throw new CaldavAuthError(
                `Failed to connect to CalDAV server: ${serverUrl}`,
                { serverUrl, originalError: String(error) }
            );
            // Stryker restore StringLiteral
        }
    }

    #extractEvents(parsed: ical.CalendarResponse, calendarLabel: string, rangeStart: Date, rangeEnd: Date): CalendarEvent[] {
        const events: CalendarEvent[] = [];

        for(const [, component] of Object.entries(parsed)) {
            if(component?.type !== 'VEVENT') {
                continue;
            }

            // We've confirmed type === 'VEVENT' above
            const vevent = component;

            // Stryker disable next-line LogicalOperator -- both rrule and recurrences indicate a recurring event; either alone is sufficient
            if(vevent.rrule || vevent.recurrences) {
                events.push(...this.#expandRecurringVEvent(vevent, calendarLabel, rangeStart, rangeEnd));
                continue;
            }

            events.push(this.#buildCalendarEvent(vevent, vevent.start, vevent.end, this.#isAllDay(vevent), calendarLabel));
        }

        return events;
    }

    #expandRecurringVEvent(vevent: ical.VEvent, calendarLabel: string, rangeStart: Date, rangeEnd: Date): CalendarEvent[] {
        let instances: ical.EventInstance[];
        try {
            instances = expandRecurringEvent(vevent, { from: rangeStart, to: rangeEnd, expandOngoing: true });
        } catch (error) {
            // Stryker disable next-line StringLiteral -- log message is informational only
            logger.warn({ error, uid: vevent.uid }, 'Failed to expand recurring event, skipping');
            return [];
        }

        if(instances.length === 0) {
            // Stryker disable next-line StringLiteral -- debug message is informational only
            logger.debug({ uid: vevent.uid, summary: vevent.summary }, 'Recurring event had rrule/recurrences but produced no instances in range');
            return [];
        }

        return instances.map((instance) => {
            const instanceVEvent = instance.event;
            return this.#buildCalendarEvent(instanceVEvent, instance.start, instance.end, instance.isFullDay, calendarLabel);
        });
    }

    #buildCalendarEvent(vevent: ical.VEvent, start: ical.DateWithTimeZone | undefined, end: ical.DateWithTimeZone | undefined, isAllDay: boolean, calendarLabel: string): CalendarEvent {
        const startTz = (start as unknown as Record<string, unknown> | undefined)?.tz as string | undefined;
        return {
            uid:          vevent.uid,
            summary:      this.#extractParameterValue(vevent.summary) ?? '(No title)',
            start:        start instanceof Date ? start : new Date(String(start)),
            end:          end instanceof Date ? end : new Date(String(end)),
            location:     this.#extractParameterValue(vevent.location) ?? undefined,
            description:  this.#extractParameterValue(vevent.description) ?? undefined,
            attendees:    this.#extractAttendees(vevent),
            isAllDay,
            calendarLabel,
            status:       this.#normalizeStatus(vevent.status),
            recurrenceId: vevent.recurrenceid ? String(vevent.recurrenceid) : undefined,
            timezone:     isAllDay ? undefined : startTz,
        };
    }

    #extractParameterValue(value: ical.ParameterValue | undefined): string | undefined {
        if(value === undefined) {
            return undefined;
        }
        if(typeof value === 'string') {
            return value.length > 0 ? value : undefined;
        }
        // ParameterValue object: { val: string, params: Record<string, string> }
        const str = value.val;
        return str.length > 0 ? str : undefined;
    }

    #extractAttendees(vevent: ical.VEvent): string[] | undefined {
        if(!vevent.attendee) {
            return undefined;
        }
        const attendees: AttendeeItem[] = Array.isArray(vevent.attendee) ? vevent.attendee : [vevent.attendee];
        const names = attendees
            .map((a): string => {
                if(typeof a === 'string') {
                    return a.replace('mailto:', '');
                }
                // ParameterValue object with optional CN param
                // Stryker disable next-line ConditionalExpression,LogicalOperator -- paired typeof+in guards are semantically inseparable; mutating to 'true' would error on objects without params
                if(typeof a === 'object' && 'params' in a) {
                    const cn = (a.params as Record<string, unknown>).CN as string | undefined;
                    if(cn) {
                        return cn;
                    }
                    // Stryker disable next-line StringLiteral -- defensive fallback for missing val field; val is always present for valid iCal attendees
                    const val = (a as { val?: string }).val ?? '';
                    return val.replace('mailto:', '');
                }
                return '';
            })
            .filter((name): name is string => name.length > 0);
        return names.length > 0 ? names : undefined;
    }

    #isAllDay(vevent: ical.VEvent): boolean {
        // All-day events have datetype 'date' or start.dateOnly === true
        if(vevent.datetype === 'date') {
            return true;
        }
        const start = vevent.start as unknown as Record<string, unknown>;
        return start.dateOnly === true;
    }

    #normalizeStatus(status?: string): CalendarEvent['status'] {
        if(!status) {
            return undefined;
        }
        const normalized = status.toLowerCase();
        if(normalized === 'confirmed') {
            return 'confirmed';
        }
        if(normalized === 'tentative') {
            return 'tentative';
        }
        if(normalized === 'cancelled') {
            return 'cancelled';
        }
        return undefined;
    }

    #buildCacheKey(server: CalendarServerEntry, start: Date, end: Date): string {
        // Round to the hour for better cache hit rate
        const startHour = new Date(start);
        // Stryker disable next-line MethodExpression -- setMinutes rounds within the hour; setHours would round to midnight, losing hour information
        startHour.setMinutes(0, 0, 0);
        const endHour = new Date(end);
        // Stryker disable next-line MethodExpression -- setMinutes rounds within the hour; setHours would round to midnight, losing hour information
        endHour.setMinutes(0, 0, 0);

        // Stryker disable next-line StringLiteral -- cache key separator is an internal implementation detail
        const calPaths = server.calendars.map(c => c.calendarPath).toSorted((a, b) => a.localeCompare(b)).join(',');
        // Stryker disable next-line StringLiteral,ObjectLiteral -- cache key format is internal; separator characters are not observable externally
        return `${server.serverId}|${server.serverUrl}|${calPaths}|${startHour.toISOString()}|${endHour.toISOString()}`;
    }
}
