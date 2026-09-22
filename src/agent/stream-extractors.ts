import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { chain, isPlainObject } from 'lodash-es';

/** Assistant frame emitted by the Claude Agent SDK. */
export type AssistantFrame = Extract<SDKMessage, { type: 'assistant' }>;
/** Content block from an SDK assistant frame. */
export type AssistantContentBlock = AssistantFrame['message']['content'][number];
/** Text content block from an SDK assistant frame. */
export type TextBlock = Extract<AssistantContentBlock, { type: 'text' }>;
/** Thinking content block from an SDK assistant frame. */
export type ThinkingBlock = Extract<AssistantContentBlock, { type: 'thinking' }>;
/** Tool-use content block from an SDK assistant frame. */
export type ToolUseBlock = Extract<AssistantContentBlock, { type: 'tool_use' }>;

export function extractAssistantText(message: SDKMessage): string {
    if(message.type !== 'assistant') {
        return '';
    }

    // Stryker disable MethodExpression,ConditionalExpression: Removing the text type filter maps undefined for non-text blocks; changing its predicate to true likewise retains only undefined because only text blocks have text, and compact drops those values before joining.
    const textBlocks = (message.message.content).filter((block): block is TextBlock => block.type === 'text');
    // Stryker restore MethodExpression,ConditionalExpression
    return chain(textBlocks).map('text').compact().join('\n').trim().value();
}

/**
 * Extract thinking content from an assistant message.
 * @param message SDK message with potential content blocks
 * @returns Extracted thinking text or empty string
 */
export function extractThinkingContent(message: SDKMessage): string {
    if(message.type !== 'assistant') {
        return '';
    }

    // Stryker disable MethodExpression,ConditionalExpression: Removing the thinking type filter maps undefined for non-thinking blocks; changing its predicate to true likewise retains only undefined because only thinking blocks have thinking, and compact drops those values before joining.
    const thinkingBlocks = (message.message.content).filter((block): block is ThinkingBlock => block.type === 'thinking');
    // Stryker restore MethodExpression,ConditionalExpression
    return chain(thinkingBlocks).map('thinking').compact().join('\n').trim().value();
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
    // Stryker disable next-line llm: loose equality differs only for null, excluded by the parameter type and all callers.
    if(toolName === undefined) {
        return { module: 'claude', tool: 'unknown' };
    }
    // MCP tools have format: mcp__module__tool (e.g., mcp__DevTools__find_symbol)
    if(toolName.startsWith('mcp__')) {
        const parts = toolName.slice(5).split('__');
        if(parts.length >= 2) {
            // Stryker disable next-line llm: non-null assertions are erased, and indexed strings remain string without noUncheckedIndexedAccess.
            const module = parts[0]!; // length >= 2 above
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
    // Handle arrays - map over elements
    if(Array.isArray(input)) {
        return input.map(item => redactSensitiveArgs(item));
    }

    // Handle objects - check keys and recurse
    // Stryker disable next-line llm: isPlainObject(null) is false, so the added null check cannot change this branch.
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

/** Extract tool-use blocks from an assistant SDK message. */
export function extractToolUses(message: SDKMessage): ToolUseBlock[] {
    if(message.type !== 'assistant') {
        return [];
    }
    return message.message.content.filter((block): block is ToolUseBlock => block.type === 'tool_use');
}
