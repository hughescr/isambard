import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { PersonHistoryCoordinator } from './history-providers';
import { mcpErrorResult, mcpJsonResult, mcpTextResult } from './mcp-helpers';

/**
 * Options for creating the User Context MCP server.
 */
interface UserContextMCPServerOptions {
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
export function createUserContextMCPServer(options: UserContextMCPServerOptions) {
    const { coordinator } = options;

    return createSdkMcpServer({
        name:    'user-context',
        version: '1.0.0',
        tools:   [
            tool(
                'getPersonContext',
                'Fetch cross-platform interaction history for a person. Returns recent messages, emails, and social interactions.',
                {
                    // Stryker disable next-line StringLiteral,MethodExpression: describe() is documentation only; .min(1) is Zod schema validation constraint
                    identifier: z.string().min(1).describe('Name, email, handle, or any identifier for the person'),
                    // Stryker disable next-line ObjectLiteral: Zod schema shape is tool input configuration
                    timeRange:  z.object({
                        // Stryker disable StringLiteral: describe() is documentation only
                        startTime: z.string().optional().describe('ISO 8601 start (default: 7 days ago)'),
                        endTime:   z.string().optional().describe('ISO 8601 end (default: now)'),
                        // Stryker restore StringLiteral
                    }).optional(),
                },
                async (args): Promise<CallToolResult> => {
                    try {
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
                            // Stryker disable next-line StringLiteral: result message is informational only
                            return mcpTextResult(`No contact found matching '${args.identifier}'.`);
                        }

                        return mcpJsonResult({ person: result.person, history: result.history ?? null });
                    } catch (error) {
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral,StringLiteral,BooleanLiteral: Tool annotations are MCP server configuration
                { annotations: { title: 'Get Person Context', readOnlyHint: true, idempotentHint: true } }
            ),
        ],
    });
}
