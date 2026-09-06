import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { mcpJsonResult, withToolErrorHandling } from './mcp-helpers';
import type { ServiceHealthRegistry } from '@/services';

/**
 * Options for creating the Health MCP server.
 */
interface HealthMCPServerOptions {
    healthRegistry: ServiceHealthRegistry
}

/**
 * Creates a read-only MCP server exposing {@link ServiceHealthRegistry} state to the agent.
 *
 * Provides one tool:
 * - getServiceHealth: returns every registered service's current health entry
 *   (state/epoch/lastError) plus a human-readable status summary when one is available.
 *
 * Deliberately NOT wrapped in `withHealthGuard`/`withWriteHealthGuard` — this tool's entire
 * purpose is to answer during an outage, so it must stay reachable no matter which (or how many)
 * services are `'offline'`/`'disabled'`.
 */
export function createHealthMCPServer(options: HealthMCPServerOptions) {
    const { healthRegistry } = options;

    return createSdkMcpServer({
        name:    'health',
        version: '1.0.0',
        tools:   [
            tool(
                'getServiceHealth',
                'Get the current health status of every integrated service (Discord, email, Bluesky, CalDAV, DynamoDB, etc). Returns per-service state, epoch, and last error, plus a human-readable summary when there is anything to report. Answers even during an outage.',
                {},
                // Stryker disable next-line StringLiteral: tool name is logged for observability, not behavior
                withToolErrorHandling('getServiceHealth', (): Promise<CallToolResult> => Promise.resolve(mcpJsonResult({
                    services: healthRegistry.getAll(),
                    summary:  healthRegistry.buildStatusSummary(),
                }))),
                // Stryker disable next-line ObjectLiteral,StringLiteral: title is configuration; the boolean hints are asserted below
                { annotations: { title: 'Get Service Health', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }
            ),
        ],
    });
}
