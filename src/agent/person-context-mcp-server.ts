import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { PersonHistoryCoordinator } from './history-providers';
import { mcpJsonResult, mcpTextResult, withToolErrorHandling } from './mcp-helpers';

/**
 * Options for creating the Person Context MCP server.
 */
interface PersonContextMCPServerOptions {
    coordinator: PersonHistoryCoordinator
}

/**
 * Creates an MCP server for fetching cross-platform person context.
 *
 * Provides one tool:
 * - getPersonContext: fetches interaction history across all connected platforms for a named person
 *
 * The tool returns a JSON object with the matched contact and formatted history string.
 */
export function createPersonContextMCPServer(options: PersonContextMCPServerOptions) {
    const { coordinator } = options;

    return createSdkMcpServer({
        // Wire name kept as user-context: it is the model-visible mcp__user-context__* segment and a
        // session-open option; renaming it needs a real-SDK check (issue #82).
        name:    'user-context',
        version: '1.0.0',
        tools:   [
            tool(
                'getPersonContext',
                'Fetch cross-platform interaction history for a person. Returns recent messages, emails, and social interactions.',
                {
                    identifier: z.string().min(1).describe('Name, email, handle, or any identifier for the person'),
                    timeRange:  z.object({
                        startTime: z.string().optional().describe('ISO 8601 start (default: 7 days ago)'),
                        endTime:   z.string().optional().describe('ISO 8601 end (default: now)'),
                    }).optional(),
                },
                withToolErrorHandling('getPersonContext', async (args): Promise<CallToolResult> => {
                    // Default: 7 days = 7 * 24 * 60 minutes
                    const sevenDaysInMinutes = 7 * 24 * 60;

                    const endTime   = args.timeRange?.endTime   ? new Date(args.timeRange.endTime)   : undefined;
                    const startTime = args.timeRange?.startTime ? new Date(args.timeRange.startTime) : undefined;

                    const result = await coordinator.getPersonHistory(args.identifier, {
                        maxMessagesPerPlatform: 20,
                        maxTotalEntries:        50,
                        timeWindowMinutes:      sevenDaysInMinutes,
                        startTime,
                        endTime,
                    });

                    if(!result.person) {
                        return mcpTextResult(`No contact found matching '${args.identifier}'.`);
                    }

                    return mcpJsonResult({ person: result.person, history: result.history ?? null });
                }),
                { annotations: { title: 'Get Person Context', readOnlyHint: true, idempotentHint: true } }
            ),
        ],
    });
}
