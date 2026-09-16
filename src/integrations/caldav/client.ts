import { logger } from '@hughescr/logger';
import * as ical from 'node-ical';
import { expandRecurringEvent } from 'node-ical';
import { createDAVClient, type DAVCalendar, type DAVCalendarObject } from 'tsdav';
import type { CalendarServerEntry } from './calendar-registry/types';
import type { CalendarInfo, CalendarEvent, CalendarEventsResult, FailedCalendarEvent } from './types';
import { CaldavAuthError, CaldavTimeoutError } from '@/errors';
import type { ServiceHealthRegistry } from '@/services';

const CONSECUTIVE_FAILURE_THRESHOLD = 3;

interface CachedResult {
    events:    CalendarEvent[]
    failed:    FailedCalendarEvent[]
    expiresAt: number
}

type AttendeeItem = ical.Attendee;

interface CalDAVClientOptions {
    cacheTtlMs?:     number
    timeoutMs?:      number
    healthRegistry?: ServiceHealthRegistry
    dependencies?:   CalDAVClientDependencies
}

/** Dependencies supplied per client so test doubles cannot replace process-wide modules. */
export interface CalDAVClientDependencies {
    createDAVClient:      typeof createDAVClient
    parseICS:             typeof ical.sync.parseICS
    expandRecurringEvent: typeof expandRecurringEvent
}

const DEFAULT_DEPENDENCIES: CalDAVClientDependencies = {
    createDAVClient,
    parseICS: ical.sync.parseICS,
    expandRecurringEvent,
};

/**
 * CalDAV client wrapping tsdav and node-ical for calendar event fetching.
 */
export class CalDAVClient {
    readonly #cacheTtlMs:      number;
    readonly #timeoutMs:       number;
    readonly #cache =          new Map<string, CachedResult>();
    readonly #healthRegistry?: ServiceHealthRegistry;
    readonly #dependencies:    CalDAVClientDependencies;
    #consecutiveFailures =     0;

    constructor(optionsOrCacheTtlMs: CalDAVClientOptions | number = {}, timeoutMs = 15_000, dependencies: CalDAVClientDependencies = DEFAULT_DEPENDENCIES) {
        if(typeof optionsOrCacheTtlMs === 'number') {
            this.#cacheTtlMs     = optionsOrCacheTtlMs;
            this.#timeoutMs      = timeoutMs;
            this.#healthRegistry = undefined;
            this.#dependencies   = dependencies;
        } else {
            this.#cacheTtlMs     = optionsOrCacheTtlMs.cacheTtlMs ?? 300_000;
            this.#timeoutMs      = optionsOrCacheTtlMs.timeoutMs ?? 15_000;
            this.#healthRegistry = optionsOrCacheTtlMs.healthRegistry;
            this.#dependencies   = optionsOrCacheTtlMs.dependencies ?? DEFAULT_DEPENDENCIES;
        }
    }

    /**
     * Discover calendars on a CalDAV server.
     * Used during the /calendar add-server flow.
     */
    async discoverCalendars(serverUrl: string, username: string, password: string): Promise<CalendarInfo[]> {
        const client = await this.#createClient(serverUrl, username, password);
        const calendars = await this.#withTimeout(client.fetchCalendars(), this.#timeoutMs, 'fetchCalendars');
        return calendars.map((cal) => {
            // boundary cast: tsdav DAVCalendar omits calendarColor/calendarDescription from its .d.ts; these properties exist at runtime per CalDAV RFC 4791
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
     *
     * Returns `{ events, failed }` — `failed` is never silently dropped; each entry
     * that could not be expanded (e.g. malformed RRULE) appears in `failed` with
     * its uid, reason string, and the rrule string if available.
     */
    async getEvents(servers: CalendarServerEntry[], start: Date, end: Date): Promise<CalendarEventsResult> {
        const allEvents: CalendarEvent[]       = [];
        const allFailed: FailedCalendarEvent[] = [];

        for(const server of servers) {
            const cacheKey = this.#buildCacheKey(server, start, end);
            const cached = this.#cache.get(cacheKey);
            if(cached && cached.expiresAt > Date.now()) {
                allEvents.push(...cached.events);
                allFailed.push(...cached.failed);
                continue;
            }

            try {
                // eslint-disable-next-line no-await-in-loop -- preserve server-order partial results and consecutive-failure threshold health events
                const result = await this.#fetchServerEvents(server, start, end);
                this.#cache.set(cacheKey, {
                    events:    result.events,
                    failed:    result.failed,
                    expiresAt: Date.now() + this.#cacheTtlMs,
                });
                allEvents.push(...result.events);
                allFailed.push(...result.failed);
                this.#recordSuccess();
            } catch (error) {
                // Log and continue — partial results are better than total failure
                logger.warn({ error, serverUrl: server.serverUrl }, 'Failed to fetch events from CalDAV server, continuing with partial results');
                this.#recordFailure(error);
            }
        }

        return {
            events: allEvents.toSorted((a, b) => a.start.getTime() - b.start.getTime()),
            failed: allFailed,
        };
    }

    /**
     * Convenience: fetch events for context injection (past 24h + next 3 days).
     */
    async getContextEvents(servers: CalendarServerEntry[], now = new Date()): Promise<CalendarEventsResult> {
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

    async #fetchServerEvents(server: CalendarServerEntry, start: Date, end: Date): Promise<CalendarEventsResult> {
        const client = await this.#createClient(server.serverUrl, server.username, server.password);
        const calendars = await this.#withTimeout(client.fetchCalendars(), this.#timeoutMs, 'fetchCalendars');
        const events: CalendarEvent[]       = [];
        const failed: FailedCalendarEvent[] = [];

        const calendarByUrl = new Map(calendars.map((calendar: DAVCalendar) => [calendar.url, calendar]));
        const matchingCalendars = server.calendars.flatMap((calEntry) => {
            // Stryker disable next-line llm: calendarPath is required and non-empty in the validated server schema.
            const davCalendar = calendarByUrl.get(calEntry.calendarPath);
            return davCalendar ? [{ calEntry, davCalendar }] : [];
        });
        const fetched: DAVCalendarObject[][] = [];
        let nextIndex = 0;
        let stopped = false;
        const fetchWorker = async (): Promise<void> => {
            while(nextIndex < matchingCalendars.length && !stopped) {
                const index = nextIndex++;
                const davCalendar = matchingCalendars[index]!.davCalendar;
                try {
                    // eslint-disable-next-line no-await-in-loop -- each worker admits one calendar at a time, with at most two in flight
                    fetched[index] = await this.#withTimeout(client.fetchCalendarObjects({
                        calendar:  davCalendar,
                        timeRange: { start: start.toISOString(), end: end.toISOString() },
                    }), this.#timeoutMs, 'fetchCalendarObjects');
                } catch (error) {
                    // eslint-disable-next-line require-atomic-updates -- this flag only transitions from false to true
                    stopped = true;
                    throw error;
                }
            }
        };
        // Promise.all rejects on the first failure and observes the other in-flight worker.
        await Promise.all(Array.from({ length: Math.min(2, matchingCalendars.length) }, fetchWorker));
        for(const [index, calObjects] of fetched.entries()) {
            const calEntry = matchingCalendars[index]!.calEntry;
            for(const obj of calObjects) {
                if(!obj.data) {
                    continue;
                }
                const parsed = this.#dependencies.parseICS(obj.data as string);
                const result = this.#extractEvents(parsed, calEntry.label, start, end);
                events.push(...result.events);
                failed.push(...result.failed);
            }
        }

        return { events, failed };
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
        // Stryker restore BlockStatement
        try {
            return await Promise.race([promise, timeout]);
        } finally {
            clearTimeout(timeoutId);
        }
        // Stryker restore BlockStatement
    }

    async #createClient(serverUrl: string, username: string, password: string) {
        try {
            return await this.#withTimeout(this.#dependencies.createDAVClient({
                serverUrl,
                credentials:        { username, password },
                authMethod:         'Basic',
                defaultAccountType: 'caldav',
            }), this.#timeoutMs, 'connect');
        } catch (error) {
            if(error instanceof CaldavTimeoutError) {
                throw error;
            }
            throw new CaldavAuthError(
                `Failed to connect to CalDAV server: ${serverUrl}`,
                { serverUrl, originalError: String(error) }
            );
            // Stryker restore StringLiteral
        }
    }

    #extractEvents(parsed: ical.CalendarResponse, calendarLabel: string, rangeStart: Date, rangeEnd: Date): CalendarEventsResult {
        const events: CalendarEvent[]       = [];
        const failed: FailedCalendarEvent[] = [];

        for(const [, component] of Object.entries(parsed)) {
            if(component?.type !== 'VEVENT') {
                continue;
            }

            // We've confirmed type === 'VEVENT' above
            const vevent = component;

            if(vevent.rrule || vevent.recurrences) {
                const result = this.#expandRecurringVEvent(vevent, calendarLabel, rangeStart, rangeEnd);
                events.push(...result.events);
                failed.push(...result.failed);
                continue;
            }

            events.push(this.#buildCalendarEvent(vevent, vevent.start, vevent.end, this.#isAllDay(vevent), calendarLabel));
        }

        return { events, failed };
    }

    #expandRecurringVEvent(vevent: ical.VEvent, calendarLabel: string, rangeStart: Date, rangeEnd: Date): CalendarEventsResult {
        let instances: ical.EventInstance[];
        try {
            instances = this.#dependencies.expandRecurringEvent(vevent, { from: rangeStart, to: rangeEnd, expandOngoing: true });
        } catch (error) {
            // Extract the rrule string for diagnostics (may be absent for recurrences-only events)
            const rruleRaw = vevent.rrule as unknown;
            // eslint-disable-next-line @typescript-eslint/no-base-to-string -- rrule is a node-ical RRule object; toString() produces the RRULE string, best-effort for diagnostics
            const rruleStr = rruleRaw ? String(rruleRaw) : undefined;
            const reason   = error instanceof Error ? error.message : String(error);
            logger.warn({ error, uid: vevent.uid, rrule: rruleStr }, 'Failed to expand recurring event; it will appear in failed[] for caller visibility');
            return {
                events: [],
                failed: [{ uid: vevent.uid, reason, rrule: rruleStr }],
            };
        }

        if(instances.length === 0) {
            logger.debug({ uid: vevent.uid, summary: vevent.summary }, 'Recurring event had rrule/recurrences but produced no instances in range');
            return { events: [], failed: [] };
        }

        return {
            events: instances.map((instance) => {
                const instanceVEvent = instance.event;
                return this.#buildCalendarEvent(instanceVEvent, instance.start, instance.end, instance.isFullDay, calendarLabel);
            }),
            failed: [],
        };
    }

    #buildCalendarEvent(vevent: ical.VEvent, start: ical.DateWithTimeZone | undefined, end: ical.DateWithTimeZone | undefined, isAllDay: boolean, calendarLabel: string): CalendarEvent {
        // boundary cast: node-ical DateWithTimeZone lacks a `.tz` property in its .d.ts; the property exists at runtime and contains the TZID string
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
                if('params' in a) {
                    const cn = (a.params as Record<string, unknown>).CN as string | undefined;
                    if(cn) {
                        return cn;
                    }
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
        // boundary cast: node-ical VEvent.start is typed as Date but carries a `.dateOnly` boolean at runtime for all-day events
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
        // Round absolute instants to the UTC hour so repeated local DST hours stay distinct.
        // Stryker disable next-line llm: valid Date construction and copying its timestamp are equivalent here.
        const startHour = new Date(start);
        startHour.setUTCMinutes(0, 0, 0);
        // Stryker disable next-line llm: valid Date construction and copying its timestamp are equivalent here.
        const endHour = new Date(end);
        endHour.setUTCMinutes(0, 0, 0);

        const calPaths = JSON.stringify(server.calendars.map(c => c.calendarPath).toSorted((a, b) => {
            if(a < b) {
                return -1;
            }
            if(a > b) {
                return 1;
            }
            return 0;
        }));
        return `${server.serverId}|${server.serverUrl}|${calPaths}|${startHour.toISOString()}|${endHour.toISOString()}`;
    }
}
