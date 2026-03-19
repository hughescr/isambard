import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '@hughescr/logger';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { mcpErrorResult, mcpJsonResult } from './mcp-helpers';
import type { CalDAVClient, CalendarRegistryBackend } from '@/integrations/caldav';

export interface CaldavMCPServerOptions {
    client:   CalDAVClient
    registry: CalendarRegistryBackend
}

/**
 * Creates an MCP server for CalDAV calendar operations.
 *
 * Provides tools for:
 * - Getting calendar events in a date range
 * - Getting upcoming events over the next N days
 * - Listing calendars configured for a user
 *
 * This server resolves userId → calendar records → CalDAV fetch internally,
 * so the agent never sees raw CalDAV URLs or credentials.
 */
export function createCaldavMCPServer(options: CaldavMCPServerOptions) {
    const { client, registry } = options;

    return createSdkMcpServer({
        name:    'caldav',
        version: '1.0.0',
        tools:   [
            tool(
                'getCalendarEvents',
                'Get calendar events for a user in a specific date range. Returns events from all calendars associated with the user plus shared/public calendars.',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    userId:    z.string().min(1).describe('Discord user ID to look up calendars for'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    startDate: z.string().describe('Start date in ISO 8601 format (e.g., 2026-03-18)'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    endDate:   z.string().describe('End date in ISO 8601 format (e.g., 2026-03-25)'),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        const servers = await registry.getAllCalendars(args.userId);
                        if(servers.length === 0) {
                            return mcpJsonResult({ events: [], message: 'No calendars configured for this user' });
                        }

                        const events = await client.getEvents(servers, new Date(args.startDate), new Date(args.endDate));
                        return mcpJsonResult({
                            events: events.map(e => ({
                                ...e,
                                start: e.start.toISOString(),
                                end:   e.end.toISOString(),
                            })),
                            count: events.length,
                        });
                    } catch (error) {
                        // Stryker disable next-line ObjectLiteral,StringLiteral: log context is informational only
                        logger.error({ error, userId: args.userId }, 'Failed to get calendar events');
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Get Calendar Events', readOnlyHint: true, idempotentHint: true } }
            ),

            tool(
                'getUpcomingEvents',
                'Get upcoming calendar events for a user over the next N days. Convenience wrapper that defaults to 7 days.',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    userId: z.string().min(1).describe('Discord user ID to look up calendars for'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    days:   z.number().int().positive().optional().default(7).describe('Number of days to look ahead (default: 7)'),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        const servers = await registry.getAllCalendars(args.userId);
                        if(servers.length === 0) {
                            return mcpJsonResult({ events: [], message: 'No calendars configured for this user' });
                        }

                        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Zod default doesn't apply when handler called directly in tests
                        const days   = args.days ?? 7;
                        const now    = new Date();
                        const end    = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
                        const events = await client.getEvents(servers, now, end);
                        return mcpJsonResult({
                            events: events.map(e => ({
                                ...e,
                                start: e.start.toISOString(),
                                end:   e.end.toISOString(),
                            })),
                            count:     events.length,
                            daysAhead: days,
                        });
                    } catch (error) {
                        // Stryker disable next-line ObjectLiteral,StringLiteral: log context is informational only
                        logger.error({ error, userId: args.userId }, 'Failed to get upcoming events');
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Get Upcoming Events', readOnlyHint: true, idempotentHint: true } }
            ),

            tool(
                'listUserCalendars',
                'List all calendar labels configured for a user. Shows calendar names grouped by server, without exposing URLs or credentials.',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    userId: z.string().min(1).describe('Discord user ID to list calendars for'),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        const servers = await registry.getAllCalendars(args.userId);
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
                    } catch (error) {
                        // Stryker disable next-line ObjectLiteral,StringLiteral: log context is informational only
                        logger.error({ error, userId: args.userId }, 'Failed to list user calendars');
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'List User Calendars', readOnlyHint: true, idempotentHint: true } }
            ),
        ],
    });
}
