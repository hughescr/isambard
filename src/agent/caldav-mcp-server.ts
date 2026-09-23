import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { mcpJsonResult, withHealthGuard, withToolErrorHandling } from './mcp-helpers';
import type { CalDAVClient, CalendarRegistryBackend, CalendarEvent } from '@/integrations/caldav';
import type { ServiceHealthRegistry, ReconnectionLoop } from '@/services';

/** Date-only and floating tool values must never masquerade as ISO instants. */
function serializeEvent(event: CalendarEvent): Record<string, unknown> {
    let time: Record<string, unknown>;
    switch(event.time.kind) {
        case 'all_day': {
            time = { kind: 'all_day', start: event.time.start, endExclusive: event.time.endExclusive };
            break;
        }
        case 'floating': {
            time = { kind: 'floating', start: event.time.start, end: event.time.end };
            break;
        }
        case 'timed': {
            time = { kind: 'timed', start: event.time.start.toISOString(), end: event.time.end.toISOString(), timezone: event.time.timezone };
            break;
        }
    }
    return { ...event, time };
}

/**
 * Result of resolving a user name to a Discord user ID.
 * Mirrors UserResolveResult from DMTracker without importing from the discord module.
 */
export type UserResolveResult
    = | { status: 'resolved',  user: { userId: string, username: string, displayName: string, nickname: string | null } }
      | { status: 'ambiguous', matches: Omit<{ userId: string, username: string, displayName: string, nickname: string | null }, 'userId'>[] }
      | { status: 'not_found' };

interface CaldavMCPServerOptions {
    client:            CalDAVClient
    registry:          CalendarRegistryBackend
    resolveUser?:      (name: string) => Promise<UserResolveResult>
    healthRegistry?:   ServiceHealthRegistry
    reconnectionLoop?: ReconnectionLoop
}

/**
 * Creates an MCP server for CalDAV calendar operations.
 *
 * Provides tools for:
 * - Getting calendar events in a date range
 * - Getting upcoming events over the next N days
 * - Listing calendars configured for a user
 *
 * This server resolves human-readable user names to Discord user IDs internally,
 * then resolves userId → calendar records → CalDAV fetch,
 * so the agent never sees raw CalDAV URLs, credentials, or Discord user IDs.
 */
export function createCaldavMCPServer(options: CaldavMCPServerOptions) {
    const { client, registry, resolveUser } = options;

    /**
     * Resolves a user name to a Discord user ID for registry lookup.
     * Returns either the resolved userId string, or a CallToolResult to return to the agent.
     */
    async function resolveUserId(user: string): Promise<string | CallToolResult> {
        if(!resolveUser) {
            // No resolver provided (e.g., in tests) — use raw input
            return user;
        }
        const result = await resolveUser(user);
        switch(result.status) {
            case 'resolved': {
                // Stryker disable next-line llm: `?? ''` is unreachable — UserResolveResult declares userId: string and dm-tracker always supplies createUserId(...); only a type-violating cast could observe it
                return result.user.userId;
            }
            case 'ambiguous': {
                return mcpJsonResult({
                    error:   'ambiguous_user',
                    message: `Multiple users match "${user}". Please be more specific.`,
                    matches: result.matches,
                });
            }
            case 'not_found': {
                return mcpJsonResult({
                    error:   'user_not_found',
                    message: `No user found matching "${user}".`,
                });
            }
        }
    }

    return createSdkMcpServer({
        name:    'caldav',
        version: '2.0.0',
        tools:   [
            tool(
                'getCalendarEvents',
                'Get calendar events for a user in a specific date range, including shared calendars. Each event.time is all_day (dates, exclusive end), floating (zone-less local times), or timed (ISO instants and source timezone).',
                {
                    user:      z.string().min(1).describe("Person's name to look up calendars for (e.g., 'Craig')"),
                    startDate: z.string().describe('Start date in ISO 8601 format (e.g., 2026-03-18)'),
                    endDate:   z.string().describe('End date in ISO 8601 format (e.g., 2026-03-25)'),
                },
                withHealthGuard(options.healthRegistry, 'caldav', options.reconnectionLoop,
                    withToolErrorHandling('getCalendarEvents', async (args): Promise<CallToolResult> => {
                        const resolved = await resolveUserId(args.user);
                        if(typeof resolved !== 'string') {
                            return resolved; // MCP result (ambiguous or not_found)
                        }
                        const servers = await registry.getAllCalendars(resolved);
                        if(servers.length === 0) {
                            return mcpJsonResult({ events: [], message: 'No calendars configured for this user' });
                        }

                        const { events, failed } = await client.getEvents(servers, new Date(args.startDate), new Date(args.endDate));
                        return mcpJsonResult({
                            events:       events.map(event => serializeEvent(event)),
                            count:        events.length,
                            failedCount:  failed.length > 0 ? failed.length : undefined,
                            failedEvents: failed.length > 0 ? failed.map(f => f.uid) : undefined,
                        });
                    })),
                { annotations: { title: 'Get Calendar Events', readOnlyHint: true, idempotentHint: true } }
            ),

            tool(
                'getUpcomingEvents',
                'Get upcoming calendar events over the next N days (default 7). Each event.time is all_day (dates, exclusive end), floating (zone-less local times), or timed (ISO instants and source timezone).',
                {
                    user: z.string().min(1).describe("Person's name to look up calendars for (e.g., 'Craig')"),
                    days: z.number().int().positive().optional().describe('Number of days to look ahead (default: 7)'),
                },
                withHealthGuard(options.healthRegistry, 'caldav', options.reconnectionLoop,
                    withToolErrorHandling('getUpcomingEvents', async (args): Promise<CallToolResult> => {
                        const resolved = await resolveUserId(args.user);
                        if(typeof resolved !== 'string') {
                            return resolved; // MCP result (ambiguous or not_found)
                        }
                        const servers = await registry.getAllCalendars(resolved);
                        if(servers.length === 0) {
                            return mcpJsonResult({ events: [], message: 'No calendars configured for this user' });
                        }

                        const days             = args.days ?? 7;
                        const now              = new Date();
                        const end              = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
                        const { events, failed } = await client.getEvents(servers, now, end);
                        return mcpJsonResult({
                            events:       events.map(event => serializeEvent(event)),
                            count:        events.length,
                            daysAhead:    days,
                            failedCount:  failed.length > 0 ? failed.length : undefined,
                            failedEvents: failed.length > 0 ? failed.map(f => f.uid) : undefined,
                        });
                    })),
                { annotations: { title: 'Get Upcoming Events', readOnlyHint: true, idempotentHint: true } }
            ),

            tool(
                'listUserCalendars',
                'List all calendar labels configured for a user. Shows calendar names grouped by server, without exposing URLs or credentials.',
                {
                    user: z.string().min(1).describe("Person's name to list calendars for (e.g., 'Craig')"),
                },
                withHealthGuard(options.healthRegistry, 'caldav', options.reconnectionLoop,
                    withToolErrorHandling('listUserCalendars', async (args): Promise<CallToolResult> => {
                        const resolved = await resolveUserId(args.user);
                        if(typeof resolved !== 'string') {
                            return resolved; // MCP result (ambiguous or not_found)
                        }
                        const servers = await registry.getAllCalendars(resolved);
                        if(servers.length === 0) {
                            return mcpJsonResult({ calendars: [], message: 'No calendars configured for this user' });
                        }

                        // Strip credentials — only expose labels
                        const calendars = servers.map(s => ({
                            serverDescription: s.description,
                            calendars:         s.calendars.map(c => ({
                                label: c.label,
                                path:  c.calendarPath,
                            })),
                        }));
                        return mcpJsonResult({ calendars });
                    })),
                { annotations: { title: 'List User Calendars', readOnlyHint: true, idempotentHint: true } }
            ),
        ],
    });
}
