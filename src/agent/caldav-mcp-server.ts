import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '@hughescr/logger';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { mcpErrorResult, mcpJsonResult, checkServiceHealth } from './mcp-helpers';
import type { CalDAVClient, CalendarRegistryBackend } from '@/integrations/caldav';
import type { ServiceHealthRegistry, ReconnectionLoop } from '@/services';

/**
 * Result of resolving a user name to a Discord user ID.
 * Mirrors UserResolveResult from DMTracker without importing from the discord module.
 */
export type UserResolveResult
    = | { status: 'resolved',  user: { userId: string, username: string, displayName: string, nickname: string | null } }
      | { status: 'ambiguous', matches: Omit<{ userId: string, username: string, displayName: string, nickname: string | null }, 'userId'>[] }
      | { status: 'not_found' };

export interface CaldavMCPServerOptions {
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
                return result.user.userId;
            }
            case 'ambiguous': {
                // Stryker disable next-line StringLiteral: error message is informational only
                return mcpJsonResult({
                    error:   'ambiguous_user',
                    // Stryker disable next-line StringLiteral: error message is informational only
                    message: `Multiple users match "${user}". Please be more specific.`,
                    matches: result.matches,
                });
            }
            case 'not_found': {
                // Stryker disable next-line StringLiteral: error message is informational only
                return mcpJsonResult({
                    error:   'user_not_found',
                    // Stryker disable next-line StringLiteral: error message is informational only
                    message: `No user found matching "${user}".`,
                });
            }
        }
    }

    return createSdkMcpServer({
        name:    'caldav',
        version: '1.0.0',
        tools:   [
            tool(
                'getCalendarEvents',
                'Get calendar events for a user in a specific date range. Returns events from all calendars associated with the user plus shared/public calendars.',
                {
                    // Stryker disable next-line StringLiteral,MethodExpression: describe() is documentation only
                    user:      z.string().min(1).describe("Person's name to look up calendars for (e.g., 'Craig')"),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    startDate: z.string().describe('Start date in ISO 8601 format (e.g., 2026-03-18)'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    endDate:   z.string().describe('End date in ISO 8601 format (e.g., 2026-03-25)'),
                },
                async (args): Promise<CallToolResult> => {
                    // Stryker disable BlockStatement: health guard delegates to tested checkServiceHealth
                    if(options.healthRegistry) {
                        const healthCheck = checkServiceHealth(options.healthRegistry, 'caldav', options.reconnectionLoop);
                        if(healthCheck) {
                            return healthCheck;
                        }
                    }
                    // Stryker restore BlockStatement
                    try {
                        const resolved = await resolveUserId(args.user);
                        if(typeof resolved !== 'string') {
                            return resolved; // MCP result (ambiguous or not_found)
                        }
                        const servers = await registry.getAllCalendars(resolved);
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
                        logger.error({ error, user: args.user }, 'Failed to get calendar events');
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
                    // Stryker disable next-line StringLiteral,MethodExpression: describe() is documentation only
                    user: z.string().min(1).describe("Person's name to look up calendars for (e.g., 'Craig')"),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    days: z.number().int().positive().optional().default(7).describe('Number of days to look ahead (default: 7)'),
                },
                async (args): Promise<CallToolResult> => {
                    // Stryker disable BlockStatement: health guard delegates to tested checkServiceHealth
                    if(options.healthRegistry) {
                        const healthCheck = checkServiceHealth(options.healthRegistry, 'caldav', options.reconnectionLoop);
                        if(healthCheck) {
                            return healthCheck;
                        }
                    }
                    // Stryker restore BlockStatement
                    try {
                        const resolved = await resolveUserId(args.user);
                        if(typeof resolved !== 'string') {
                            return resolved; // MCP result (ambiguous or not_found)
                        }
                        const servers = await registry.getAllCalendars(resolved);
                        if(servers.length === 0) {
                            return mcpJsonResult({ events: [], message: 'No calendars configured for this user' });
                        }

                        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Zod .default(7) makes type non-optional, but handler is called directly in tests without schema processing
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
                        logger.error({ error, user: args.user }, 'Failed to get upcoming events');
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
                    // Stryker disable next-line StringLiteral,MethodExpression: describe() is documentation only
                    user: z.string().min(1).describe("Person's name to list calendars for (e.g., 'Craig')"),
                },
                async (args): Promise<CallToolResult> => {
                    // Stryker disable BlockStatement: health guard delegates to tested checkServiceHealth
                    if(options.healthRegistry) {
                        const healthCheck = checkServiceHealth(options.healthRegistry, 'caldav', options.reconnectionLoop);
                        if(healthCheck) {
                            return healthCheck;
                        }
                    }
                    // Stryker restore BlockStatement
                    try {
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
                    } catch (error) {
                        // Stryker disable next-line ObjectLiteral,StringLiteral: log context is informational only
                        logger.error({ error, user: args.user }, 'Failed to list user calendars');
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'List User Calendars', readOnlyHint: true, idempotentHint: true } }
            ),
        ],
    });
}
