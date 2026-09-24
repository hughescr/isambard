import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { KNOWN_HISTORY_PLATFORMS, type KnownPlatform, type PersonHistoryCoordinator } from './history-providers';
import { mcpJsonResult, mcpTextResult, withToolErrorHandling } from './mcp-helpers';
import type { ServiceErrorCategory, ServiceHealthRegistry } from '@/services';

/**
 * Options for creating the Person Context MCP server.
 */
interface PersonContextMCPServerOptions {
    coordinator:     PersonHistoryCoordinator
    /**
     * Service health, when wired. A history platform whose service is not online is
     * reported unavailable by category instead of being searched.
     */
    healthRegistry?: Pick<ServiceHealthRegistry, 'getState'>
}

/**
 * Health-derived platforms to skip: `disabled` is permanently not configured, any other
 * non-online state (starting, recovering, offline) is retryable later.
 */
function unavailableFromHealth(healthRegistry: Pick<ServiceHealthRegistry, 'getState'> | undefined): Partial<Record<KnownPlatform, ServiceErrorCategory>> {
    const unavailable: Partial<Record<KnownPlatform, ServiceErrorCategory>> = {};
    if(healthRegistry) {
        for(const platform of KNOWN_HISTORY_PLATFORMS) {
            const state = healthRegistry.getState(platform);
            if(state !== 'online') {
                unavailable[platform] = state === 'disabled' ? 'permanent_not_configured' : 'offline_retryable_later';
            }
        }
    }
    return unavailable;
}

/**
 * Creates an MCP server for fetching cross-platform person context.
 *
 * Provides one tool:
 * - getPersonContext: fetches interaction history across all connected platforms for a named person
 *
 * The tool returns a JSON object with the matched contact, the formatted history string
 * (null when nothing was observed), and a coverage block naming the platforms consulted,
 * failed, not configured, or not applicable, so "no history" is distinguishable from
 * "could not look".
 */
export function createPersonContextMCPServer(options: PersonContextMCPServerOptions) {
    const { coordinator, healthRegistry } = options;

    return createSdkMcpServer({
        // Wire name kept as user-context: it is the model-visible mcp__user-context__* segment and a
        // session-open option; renaming it needs a real-SDK check (issue #82).
        name:    'user-context',
        version: '1.0.0',
        tools:   [
            tool(
                'getPersonContext',
                'Fetch cross-platform interaction history for a person. Returns recent messages, emails, and social interactions, plus a coverage block: queried lists the platforms searched; unavailable, partial and failures show which could not be (fully) read and why; notConfigured and notApplicable show platforms not searched; truncated means the search was bounded, so some entries were or may have been left out. A null history means no entries were observed, not that none exist: it shows no interactions only on queried platforms that are not unavailable or partial, and only when truncated is false; notConfigured and notApplicable platforms were never searched.',
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
                        unavailablePlatforms:   unavailableFromHealth(healthRegistry),
                    });

                    if(result.kind === 'contact_not_found') {
                        return mcpTextResult(`No contact found matching '${args.identifier}'.`);
                    }

                    return mcpJsonResult({ person: result.person, history: result.history ?? null, coverage: result.coverage });
                }),
                { annotations: { title: 'Get Person Context', readOnlyHint: true, idempotentHint: true } }
            ),
        ],
    });
}
