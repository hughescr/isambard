import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { type ServiceHealthRegistry, type ServiceName, type ServiceHealthEntry, type ServiceErrorCategory, type ReconnectionLoop  } from '@/services';
import { formatShortRelativeTime } from '@/utils';

/**
 * Creates an error result for an MCP tool call.
 * Extracts the error message from Error instances or converts unknown values to strings.
 *
 * @param error - The caught error value
 * @returns CallToolResult with isError: true and "Error: <message>" text
 */
export function mcpErrorResult(error: unknown): CallToolResult {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
}

/**
 * Creates a JSON success result for an MCP tool call.
 *
 * @param data - The data to serialize as pretty-printed JSON
 * @returns CallToolResult with JSON-formatted text content
 */
export function mcpJsonResult(data: unknown): CallToolResult {
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

/**
 * Creates a plain text success result for an MCP tool call.
 *
 * @param text - The text content to return
 * @returns CallToolResult with text content
 */
export function mcpTextResult(text: string): CallToolResult {
    return { content: [{ type: 'text' as const, text }] };
}

/**
 * Creates a structured error result for when a service is unavailable.
 *
 * Derives an error category from the health state, includes last error and
 * offline duration, and optionally triggers an immediate reconnection attempt.
 *
 * @param service          - The service name (e.g. 'bluesky', 'email')
 * @param entry            - The current health entry for the service
 * @param reconnectionLoop - Optional reconnection loop to trigger immediately
 * @returns CallToolResult with isError: true and a human-readable description
 */
export function mcpServiceUnavailableResult(
    service: ServiceName,
    entry: ServiceHealthEntry,
    reconnectionLoop?: ReconnectionLoop
): CallToolResult {
    // Determine category from state
    let category: ServiceErrorCategory;
    if(entry.state === 'disabled') {
        category = 'permanent_not_configured';
    } else if(entry.state === 'degraded') {
        category = 'degraded_read_only';
    } else {
        category = 'offline_retryable_later';
    }

    const parts: string[] = [`The ${service} service is currently ${entry.state}.`];

    if(entry.lastError) {
        parts.push(`Last error: ${entry.lastError.message}.`);
    }

    if(entry.lastOfflineAt) {
        parts.push(`Offline since ${formatShortRelativeTime(entry.lastOfflineAt)}.`);
    }

    if(category === 'offline_retryable_later') {
        // Stryker disable next-line EqualityOperator: boundary condition — retryMs===0 is indistinguishable from retryMs<0 in practice; both map to "reconnection in progress"
        if(entry.nextRetryAt && entry.nextRetryAt.getTime() > Date.now()) {
            const waitMs = entry.nextRetryAt.getTime() - Date.now();
            const waitSec = Math.ceil(waitMs / 1000);
            parts.push(`Next reconnection attempt in ~${waitSec}s.`);
        } else {
            parts.push('A reconnection attempt is in progress.');
        }
        parts.push('You can retry this tool call — retrying will trigger an immediate reconnection attempt.');
    } else if(category === 'degraded_read_only') {
        parts.push('Read operations may still work, but write operations will fail.');
    } else {
        parts.push('This service is not configured and cannot be used.');
    }

    // Trigger immediate reconnection if available
    if(reconnectionLoop) {
        void reconnectionLoop.triggerNow();
    }

    return { content: [{ type: 'text' as const, text: parts.join(' ') }], isError: true };
}

/**
 * Checks whether a service is available and returns a structured error result if not.
 *
 * Returns `undefined` when the service is available so callers can proceed.
 * Returns a {@link CallToolResult} with `isError: true` when the service is
 * unavailable, optionally triggering an immediate reconnection.
 *
 * @param registry         - The service health registry
 * @param service          - The service name to check
 * @param reconnectionLoop - Optional reconnection loop to trigger if offline
 * @returns `undefined` if available, otherwise an error {@link CallToolResult}
 */
export function checkServiceHealth(
    registry: ServiceHealthRegistry,
    service: ServiceName,
    reconnectionLoop?: ReconnectionLoop
): CallToolResult | undefined {
    if(registry.isAvailable(service)) {
        return undefined;  // Service available, proceed
    }
    const entry = registry.getEntry(service);
    return mcpServiceUnavailableResult(service, entry, reconnectionLoop);
}

/**
 * Checks whether a primary service and its approval service are both available
 * for write operations that require admin approval via Discord.
 *
 * Returns `undefined` when both services are available. Returns a structured
 * error result if either service is unavailable, with a tailored message when
 * only the approval service is down.
 *
 * @param registry         - The service health registry
 * @param primaryService   - The service performing the write (e.g. 'bluesky')
 * @param approvalService  - The service needed for admin approval (e.g. 'discord')
 * @param reconnectionLoop - Optional reconnection loop to trigger if primary is offline
 * @returns `undefined` if both available, otherwise an error {@link CallToolResult}
 */
export function checkWriteServiceHealth(
    registry: ServiceHealthRegistry,
    primaryService: ServiceName,
    approvalService: ServiceName,
    reconnectionLoop?: ReconnectionLoop
): CallToolResult | undefined {
    // Check primary service first
    const primaryCheck = checkServiceHealth(registry, primaryService, reconnectionLoop);
    if(primaryCheck) {
        return primaryCheck;
    }

    // Check approval service
    if(!registry.isAvailable(approvalService)) {
        const entry = registry.getEntry(approvalService);
        const text = `The ${primaryService} service is online, but ${approvalService} (needed for admin approval) is currently ${entry.state}. Write operations requiring approval are unavailable.`;
        return { content: [{ type: 'text' as const, text }], isError: true };
    }

    return undefined;
}
