import { chain, isPlainObject } from 'lodash-es';
import { InvariantViolationError } from '@/errors';

export function extractAssistantText(message: { type: string, message?: { content?: unknown } }): string {
    if(message.type !== 'assistant') {
        return '';
    }

    interface ContentBlock {
        type:  string
        text?: string
    }
    const content = message.message?.content as ContentBlock[] | undefined;
    // Stryker disable next-line ArrayDeclaration: Equivalent mutant - filter on strings returns [] same as on []
    const textBlocks = (content ?? []).filter(block => block.type === 'text');
    return chain(textBlocks).map('text').compact().join('\n').trim().value();
}

/**
 * Extract thinking content from an assistant message.
 * @param message SDK message with potential content blocks
 * @returns Extracted thinking text or empty string
 */
export function extractThinkingContent(message: { type: string, message?: { content?: unknown } }): string {
    // Stryker disable next-line ConditionalExpression,BlockStatement: Equivalent mutant - non-assistant with no content returns '' via either path (filter returns [] → '' either way)
    if(message.type !== 'assistant') {
        return '';
    }

    interface ContentBlock {
        type:  string
        text?: string
    }
    const content = message.message?.content as ContentBlock[] | undefined;
    // Stryker disable next-line ArrayDeclaration: Equivalent mutant - filter on strings returns [] same as on []
    const thinkingBlocks = (content ?? []).filter(block => block.type === 'thinking');
    return chain(thinkingBlocks).map('text').compact().join('\n').trim().value();
}

/**
 * Extract tool_use blocks from an assistant message
 * @param message Stream message to extract from
 * @returns Array of tool use blocks or empty array
 */
export interface ToolUseBlock {
    type:  'tool_use'
    id:    string
    name:  string
    input: unknown
}

/**
 * Parsed tool name with module and tool components.
 */
export interface ParsedToolName {
    module: string
    tool:   string
}

/**
 * Parse tool name into module and tool components.
 * Converts MCP tool names from 'mcp__module__tool' to { module: 'module', tool: 'tool' }.
 * Regular tool names use 'claude' as the module.
 * @param toolName The tool name to parse
 * @returns ParsedToolName with module and tool components
 */
export function parseToolName(toolName: string | undefined): ParsedToolName {
    if(toolName === undefined) {
        return { module: 'claude', tool: 'unknown' };
    }
    // Stryker disable next-line ConditionalExpression,StringLiteral,BlockStatement: Equivalent mutant - '' falls through to regular tool path returning { module: 'claude', tool: '' } either way
    if(toolName === '') {
        return { module: 'claude', tool: '' };
    }

    // MCP tools have format: mcp__module__tool (e.g., mcp__DevTools__find_symbol)
    if(toolName.startsWith('mcp__')) {
        const parts = toolName.slice(5).split('__');
        if(parts.length >= 2) {
            const module = parts[0];
            // Stryker disable next-line ConditionalExpression,BlockStatement: invariant guard — parts.length >= 2 guarantees parts[0] exists; unreachable in practice
            if(module === undefined) {
                // Stryker disable next-line StringLiteral,CallExpression: unreachable invariant branch — message and throw are debug context only
                throw new InvariantViolationError('parseMcpToolName', 'parts[0] undefined despite parts.length >= 2');
            }
            const tool = parts.slice(1).join('__');
            return { module, tool };
        }
    }

    // Regular tools or malformed MCP names use 'claude' module
    return { module: 'claude', tool: toolName };
}

/**
 * Sensitive key patterns for redaction (case-insensitive).
 * Matches common credential-related key names.
 */
const SENSITIVE_KEY_PATTERNS = [
    /apikey/i,
    /privatekey/i,
    /secretkey/i,
    /accesskey/i,
    /authkey/i,
    /password/i,
    /passwd/i,
    /secret/i,
    /token/i,
    /credential/i,
    /auth/i,
    /key/i,  // Broad match - security over convenience
];

/**
 * Check if a key name matches any sensitive pattern.
 * @param key The key name to check
 * @returns true if the key matches a sensitive pattern
 */
function isSensitiveKey(key: string): boolean {
    return SENSITIVE_KEY_PATTERNS.some(pattern => pattern.test(key));
}

/**
 * Recursively redact sensitive values from an object.
 * Replaces values of keys matching sensitive patterns with '[REDACTED]'.
 * @param input The value to redact
 * @returns A new value with sensitive keys redacted
 */
export function redactSensitiveArgs(input: unknown): unknown {
    // Handle null/undefined
    // Stryker disable next-line ConditionalExpression,EqualityOperator,LogicalOperator,BlockStatement: Equivalent mutant - null/undefined pass through isArray/isPlainObject checks unchanged, returning as-is
    if(input === null || input === undefined) {
        return input;
    }

    // Handle arrays - map over elements
    if(Array.isArray(input)) {
        return input.map(item => redactSensitiveArgs(item));
    }

    // Handle objects - check keys and recurse
    if(isPlainObject(input)) {
        const result: Record<string, unknown> = {};
        for(const [key, value] of Object.entries(input as Record<string, unknown>)) {
            result[key] = isSensitiveKey(key) ? '[REDACTED]' : redactSensitiveArgs(value);
        }
        return result;
    }

    // Return primitives unchanged
    return input;
}

export function extractToolUses(message: { type: string, message?: { content?: unknown } }): ToolUseBlock[] {
    // Stryker disable next-line ConditionalExpression,BlockStatement: Equivalent - filter on non-assistant messages returns [] same as early return
    if(message.type !== 'assistant') {
        return [];
    }
    const content = message.message?.content as { type: string, id?: string, name?: string, input?: unknown }[] | undefined;
    return (content ?? []).filter(block => block.type === 'tool_use') as ToolUseBlock[];
}
