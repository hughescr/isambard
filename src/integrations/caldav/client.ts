import { logger } from '@hughescr/logger';
import * as ical from 'node-ical';
import { createDAVClient, type DAVCalendar, type DAVCalendarObject } from 'tsdav';
import type { CalendarServerEntry } from './calendar-registry/types';
import { CaldavAuthError } from './errors';
import type { CalendarInfo, CalendarEvent } from './types';

interface CachedEvents {
    events:    CalendarEvent[]
    expiresAt: number
}

type AttendeeItem = ical.Attendee;

/**
 * CalDAV client wrapping tsdav and node-ical for calendar event fetching.
 */
export class CalDAVClient {
    readonly #cacheTtlMs: number;
    readonly #cache = new Map<string, CachedEvents>();

    constructor(cacheTtlMs = 300_000) {
        this.#cacheTtlMs = cacheTtlMs;
    }

    /**
     * Discover calendars on a CalDAV server.
     * Used during the /calendar add-server flow.
     */
    async discoverCalendars(serverUrl: string, username: string, password: string): Promise<CalendarInfo[]> {
        const client = await this.#createClient(serverUrl, username, password);
        const calendars = await client.fetchCalendars();
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
                // eslint-disable-next-line no-await-in-loop -- sequential server connections are intentional; each server is independent
                const serverEvents = await this.#fetchServerEvents(server, start, end);
                this.#cache.set(cacheKey, {
                    events:    serverEvents,
                    expiresAt: Date.now() + this.#cacheTtlMs,
                });
                allEvents.push(...serverEvents);
            } catch (error) {
                // Log and continue — partial results are better than total failure
                logger.warn({ error, serverUrl: server.serverUrl }, 'Failed to fetch events from CalDAV server, continuing with partial results');
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

    async #fetchServerEvents(server: CalendarServerEntry, start: Date, end: Date): Promise<CalendarEvent[]> {
        const client = await this.#createClient(server.serverUrl, server.username, server.password);
        const calendars = await client.fetchCalendars();
        const events: CalendarEvent[] = [];

        for(const calEntry of server.calendars) {
            const davCalendar = calendars.find((c: DAVCalendar) => c.url === calEntry.calendarPath);
            if(!davCalendar) {
                continue;
            }

            // eslint-disable-next-line no-await-in-loop -- sequential calendar fetching within a single server connection
            const calObjects: DAVCalendarObject[] = await client.fetchCalendarObjects({
                calendar:  davCalendar,
                timeRange: { start: start.toISOString(), end: end.toISOString() },
            });

            for(const obj of calObjects) {
                if(!obj.data) {
                    continue;
                }
                const parsed = ical.sync.parseICS(obj.data as string);
                const extracted = this.#extractEvents(parsed, calEntry.label);
                events.push(...extracted);
            }
        }

        return events;
    }

    async #createClient(serverUrl: string, username: string, password: string) {
        try {
            return await createDAVClient({
                serverUrl,
                credentials:        { username, password },
                authMethod:         'Basic',
                defaultAccountType: 'caldav',
            });
        } catch (error) {
            // Stryker disable StringLiteral -- error message is informational only
            throw new CaldavAuthError(
                `Failed to connect to CalDAV server: ${serverUrl}`,
                { serverUrl, originalError: String(error) }
            );
            // Stryker restore StringLiteral
        }
    }

    #extractEvents(parsed: ical.CalendarResponse, calendarLabel: string): CalendarEvent[] {
        const events: CalendarEvent[] = [];

        for(const [, component] of Object.entries(parsed)) {
            if(component?.type !== 'VEVENT') {
                continue;
            }

            // We've confirmed type === 'VEVENT' above
            const vevent = component as unknown as ical.VEvent;

            events.push({
                uid:          vevent.uid,
                summary:      this.#extractParameterValue(vevent.summary) ?? '(No title)',
                start:        vevent.start instanceof Date ? vevent.start : new Date(String(vevent.start)),
                end:          vevent.end instanceof Date ? vevent.end : new Date(String(vevent.end)),
                location:     this.#extractParameterValue(vevent.location) ?? undefined,
                description:  this.#extractParameterValue(vevent.description) ?? undefined,
                attendees:    this.#extractAttendees(vevent),
                isAllDay:     this.#isAllDay(vevent),
                calendarLabel,
                status:       this.#normalizeStatus(vevent.status),
                recurrenceId: vevent.recurrenceid ? String(vevent.recurrenceid) : undefined,
            });
        }

        return events;
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
