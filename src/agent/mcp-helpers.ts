import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

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
