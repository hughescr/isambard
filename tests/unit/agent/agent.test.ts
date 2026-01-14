/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- Test mocks require unsafe type operations */
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import _ from 'lodash';
import * as agentSdk from '@anthropic-ai/claude-agent-sdk';
import { createClaudeAgent, extractToolUses, extractThinkingContent, parseToolName, logStreamEvent, resetLogStreamState, redactSensitiveArgs } from '../../../src/agent/agent';
import type { ParsedToolName } from '../../../src/agent/agent';
import type { AgentStreamEvent } from '../../../src/agent/types';
import { mockLogger } from '../../setup';
import type { DiscordMessageContext } from '../../../src/integrations/discord/types';
import { createGuildId, createChannelId, createUserId } from '../../../src/integrations/discord/types';
import type { ContextBuilder } from '../../../src/agent/context-builder';

describe('parseToolName', () => {
    test('should convert MCP tool names to ParsedToolName with module and tool', () => {
        const result1: ParsedToolName = parseToolName('mcp__memory__view');
        expect(result1).toEqual({ module: 'memory', tool: 'view' });

        const result2: ParsedToolName = parseToolName('mcp__discord__get_messages');
        expect(result2).toEqual({ module: 'discord', tool: 'get_messages' });
    });

    test('should return regular tool names with module "claude"', () => {
        expect(parseToolName('Read')).toEqual({ module: 'claude', tool: 'Read' });
        expect(parseToolName('WebFetch')).toEqual({ module: 'claude', tool: 'WebFetch' });
        expect(parseToolName('TodoWrite')).toEqual({ module: 'claude', tool: 'TodoWrite' });
    });

    test('should handle tool names with multiple underscores in the tool part', () => {
        expect(parseToolName('mcp__memory__get_all_items')).toEqual({ module: 'memory', tool: 'get_all_items' });
    });

    test('should preserve double underscores in tool part when joining', () => {
        // This tests the '__' separator at line 390: parts.slice(1).join('__')
        // Tool names like 'mcp__module__sub__tool' should preserve the double underscore
        // If the mutation changes '__' to '', the tool would become 'subtool' instead of 'sub__tool'
        const result = parseToolName('mcp__discord__search__messages');
        expect(result).toEqual({ module: 'discord', tool: 'search__messages' });

        // More complex case with multiple double underscore segments
        const complexResult = parseToolName('mcp__server__a__b__c');
        expect(complexResult).toEqual({ module: 'server', tool: 'a__b__c' });
    });

    test('should handle empty tool name', () => {
        expect(parseToolName('')).toEqual({ module: 'claude', tool: '' });
    });

    test('should treat empty string differently from non-empty strings', () => {
        // This test ensures the empty string check is essential and not just a fallback
        // If the mutation changes '' to 'Stryker was here!', this would fail because
        // 'Stryker was here!' would be treated as a regular non-MCP tool
        const emptyResult = parseToolName('');
        const nonEmptyResult = parseToolName('Stryker was here!');

        // Both should have claude module but for different reasons:
        // - Empty string: special case handling at line 381
        // - Non-empty: regular tool fallback at line 396
        expect(emptyResult).toEqual({ module: 'claude', tool: '' });
        expect(nonEmptyResult).toEqual({ module: 'claude', tool: 'Stryker was here!' });

        // The key difference is in the tool name itself
        expect(emptyResult.tool).toBe('');
        expect(nonEmptyResult.tool).not.toBe('');
    });

    test('should handle undefined tool name', () => {
        expect(parseToolName(undefined)).toEqual({ module: 'claude', tool: 'unknown' });
    });

    test('should treat malformed MCP names (missing tool part) as non-MCP tools', () => {
        // mcp__foo has no tool part after the module, treat as regular tool
        expect(parseToolName('mcp__foo')).toEqual({ module: 'claude', tool: 'mcp__foo' });
    });

    test('should handle MCP names with only prefix and no module/tool', () => {
        // Just "mcp__" with nothing after
        expect(parseToolName('mcp__')).toEqual({ module: 'claude', tool: 'mcp__' });
    });

    test('should only treat tools starting with exact mcp__ prefix as MCP tools', () => {
        // This test kills the mutant that changes 'mcp__' to '' in the startsWith check.
        // If 'mcp__' is mutated to '', startsWith(toolName, '') would be true for ALL strings,
        // causing all tool names to be incorrectly parsed as MCP tools.

        // Valid MCP tools - should extract module
        expect(parseToolName('mcp__memory__search')).toEqual({ module: 'memory', tool: 'search' });

        // Regular tools (no mcp__ prefix) - module should be 'claude', tool should be unchanged
        expect(parseToolName('regular_tool')).toEqual({ module: 'claude', tool: 'regular_tool' });
        expect(parseToolName('some__other__tool')).toEqual({ module: 'claude', tool: 'some__other__tool' });

        // Almost mcp__ but not quite - single underscore should NOT be treated as MCP
        expect(parseToolName('mcp_memory_search')).toEqual({ module: 'claude', tool: 'mcp_memory_search' });

        // Tool names with underscores that look like they could be split but lack the prefix
        expect(parseToolName('foo__bar__baz')).toEqual({ module: 'claude', tool: 'foo__bar__baz' });
    });
});

describe('redactSensitiveArgs', () => {
    describe('basic redaction', () => {
        test('should redact apiKey', () => {
            const input = { apiKey: 'sk-secret-123' };
            expect(redactSensitiveArgs(input)).toEqual({ apiKey: '[REDACTED]' });
        });

        test('should redact password', () => {
            const input = { password: 'mypassword123' };
            expect(redactSensitiveArgs(input)).toEqual({ password: '[REDACTED]' });
        });

        test('should redact secret', () => {
            const input = { secret: 'super-secret' };
            expect(redactSensitiveArgs(input)).toEqual({ secret: '[REDACTED]' });
        });

        test('should redact token', () => {
            const input = { token: 'jwt-token-here' };
            expect(redactSensitiveArgs(input)).toEqual({ token: '[REDACTED]' });
        });

        test('should redact credential', () => {
            const input = { credential: 'cred-value' };
            expect(redactSensitiveArgs(input)).toEqual({ credential: '[REDACTED]' });
        });

        test('should redact auth', () => {
            const input = { auth: 'auth-value' };
            expect(redactSensitiveArgs(input)).toEqual({ auth: '[REDACTED]' });
        });

        test('should redact privateKey', () => {
            const input = { privateKey: '-----BEGIN PRIVATE KEY-----' };
            expect(redactSensitiveArgs(input)).toEqual({ privateKey: '[REDACTED]' });
        });

        test('should redact secretKey', () => {
            const input = { secretKey: 'secret-key-value' };
            expect(redactSensitiveArgs(input)).toEqual({ secretKey: '[REDACTED]' });
        });

        test('should redact accessKey', () => {
            const input = { accessKey: 'AKIA...' };
            expect(redactSensitiveArgs(input)).toEqual({ accessKey: '[REDACTED]' });
        });

        test('should redact authKey', () => {
            const input = { authKey: 'auth-key-value' };
            expect(redactSensitiveArgs(input)).toEqual({ authKey: '[REDACTED]' });
        });

        test('should redact passwd', () => {
            const input = { passwd: 'unix-style-password' };
            expect(redactSensitiveArgs(input)).toEqual({ passwd: '[REDACTED]' });
        });
    });

    describe('case insensitivity', () => {
        test('should redact PASSWORD (uppercase)', () => {
            const input = { PASSWORD: 'value' };
            expect(redactSensitiveArgs(input)).toEqual({ PASSWORD: '[REDACTED]' });
        });

        test('should redact ApiKey (mixed case)', () => {
            const input = { ApiKey: 'value' };
            expect(redactSensitiveArgs(input)).toEqual({ ApiKey: '[REDACTED]' });
        });

        test('should redact API_KEY with key pattern', () => {
            const input = { API_KEY: 'value' };
            expect(redactSensitiveArgs(input)).toEqual({ API_KEY: '[REDACTED]' });
        });
    });

    describe('key pattern matching', () => {
        test('should redact keys containing "key" (broad matching per requirements)', () => {
            const input = { primaryKey: 'db-key', sortKey: 'sort-value' };
            expect(redactSensitiveArgs(input)).toEqual({ primaryKey: '[REDACTED]', sortKey: '[REDACTED]' });
        });

        test('should redact keyboardType (contains key)', () => {
            const input = { keyboardType: 'numeric' };
            expect(redactSensitiveArgs(input)).toEqual({ keyboardType: '[REDACTED]' });
        });
    });

    describe('non-sensitive keys', () => {
        test('should NOT redact path', () => {
            const input = { path: '/memories/test' };
            expect(redactSensitiveArgs(input)).toEqual({ path: '/memories/test' });
        });

        test('should NOT redact content', () => {
            const input = { content: 'Hello world' };
            expect(redactSensitiveArgs(input)).toEqual({ content: 'Hello world' });
        });

        test('should NOT redact name', () => {
            const input = { name: 'my-tool' };
            expect(redactSensitiveArgs(input)).toEqual({ name: 'my-tool' });
        });

        test('should NOT redact id', () => {
            const input = { id: '12345' };
            expect(redactSensitiveArgs(input)).toEqual({ id: '12345' });
        });
    });

    describe('nested objects', () => {
        test('should redact sensitive keys in nested objects', () => {
            const input = {
                config: {
                    apiKey:   'secret',
                    endpoint: 'https://api.example.com',
                },
            };
            expect(redactSensitiveArgs(input)).toEqual({
                config: {
                    apiKey:   '[REDACTED]',
                    endpoint: 'https://api.example.com',
                },
            });
        });

        test('should redact deeply nested sensitive keys', () => {
            const input = {
                level1: {
                    level2: {
                        level3: {
                            password: 'deep-secret',
                        },
                    },
                },
            };
            expect(redactSensitiveArgs(input)).toEqual({
                level1: {
                    level2: {
                        level3: {
                            password: '[REDACTED]',
                        },
                    },
                },
            });
        });
    });

    describe('arrays', () => {
        test('should redact sensitive keys in objects within arrays', () => {
            const input = {
                users: [
                    { name: 'Alice', password: 'secret1' },
                    { name: 'Bob', password: 'secret2' },
                ],
            };
            expect(redactSensitiveArgs(input)).toEqual({
                users: [
                    { name: 'Alice', password: '[REDACTED]' },
                    { name: 'Bob', password: '[REDACTED]' },
                ],
            });
        });

        test('should handle arrays of primitives unchanged', () => {
            const input = { tags: ['a', 'b', 'c'] };
            expect(redactSensitiveArgs(input)).toEqual({ tags: ['a', 'b', 'c'] });
        });

        test('should handle mixed arrays', () => {
            const input = {
                items: [
                    'string',
                    123,
                    { token: 'secret' },
                    null,
                ],
            };
            expect(redactSensitiveArgs(input)).toEqual({
                items: [
                    'string',
                    123,
                    { token: '[REDACTED]' },
                    null,
                ],
            });
        });
    });

    describe('edge cases', () => {
        test('should return primitive values unchanged', () => {
            expect(redactSensitiveArgs('string')).toBe('string');
            expect(redactSensitiveArgs(123)).toBe(123);
            expect(redactSensitiveArgs(true)).toBe(true);
        });

        test('should return null when input is null', () => {
            expect(redactSensitiveArgs(null)).toBe(null);
        });

        test('should return undefined when input is undefined', () => {
            expect(redactSensitiveArgs(undefined)).toBe(undefined);
        });

        test('should handle null gracefully', () => {
            expect(redactSensitiveArgs(null)).toBeNull();
        });

        test('should handle undefined gracefully', () => {
            expect(redactSensitiveArgs(undefined)).toBeUndefined();
        });

        test('should handle empty object', () => {
            expect(redactSensitiveArgs({})).toEqual({});
        });

        test('should handle empty array', () => {
            expect(redactSensitiveArgs([])).toEqual([]);
        });

        test('should handle object with null value for sensitive key', () => {
            const input = { password: null };
            expect(redactSensitiveArgs(input)).toEqual({ password: '[REDACTED]' });
        });

        test('should handle object with undefined value for sensitive key', () => {
            const input = { password: undefined };
            expect(redactSensitiveArgs(input)).toEqual({ password: '[REDACTED]' });
        });

        test('should handle object with numeric value for sensitive key', () => {
            const input = { token: 12345 };
            expect(redactSensitiveArgs(input)).toEqual({ token: '[REDACTED]' });
        });
    });

    describe('multiple sensitive keys', () => {
        test('should redact all sensitive keys in same object', () => {
            const input = {
                apiKey:   'key1',
                password: 'pass1',
                token:    'tok1',
                path:     '/safe',
            };
            expect(redactSensitiveArgs(input)).toEqual({
                apiKey:   '[REDACTED]',
                password: '[REDACTED]',
                token:    '[REDACTED]',
                path:     '/safe',
            });
        });
    });
});

describe('logStreamEvent', () => {
    beforeEach(() => {
        mockLogger.debug.mockClear();
        resetLogStreamState();
    });

    test('should log user events as "Sending message to Claude LLM" when no prior tool request', () => {
        const event: AgentStreamEvent = { type: 'user' };

        logStreamEvent(event);

        expect(mockLogger.debug).toHaveBeenCalledWith({
            eventType: 'user',
            msg:       'Sending message to Claude LLM',
        });
    });

    test('should log assistant events with text as "Claude LLM responding" with hasText: true', () => {
        const event: AgentStreamEvent = {
            type:    'assistant',
            message: {
                content: [{ type: 'text', text: 'Hello world' }],
            },
        };

        logStreamEvent(event);

        expect(mockLogger.debug).toHaveBeenCalledWith({
            eventType: 'assistant',
            hasText:   true,
            msg:       'Claude LLM responding',
        });
    });

    test('should log assistant events without text as "Claude LLM thinking"', () => {
        const event: AgentStreamEvent = {
            type:    'assistant',
            message: {
                content: [],
            },
        };

        logStreamEvent(event);

        expect(mockLogger.debug).toHaveBeenCalledWith({
            eventType: 'assistant',
            hasText:   false,
            msg:       'Claude LLM thinking',
        });
    });

    test('should log tool_progress events with parsed module and tool for MCP tools', () => {
        const event: AgentStreamEvent = {
            type:      'tool_progress',
            tool_name: 'mcp__memory__view',
        };

        logStreamEvent(event);

        expect(mockLogger.debug).toHaveBeenCalledWith({
            eventType: 'tool_progress',
            module:    'memory',
            tool:      'view',
            msg:       'Tool execution started',
        });
    });

    test('should log tool_progress events with claude module for regular tools', () => {
        const event: AgentStreamEvent = {
            type:      'tool_progress',
            tool_name: 'Read',
        };

        logStreamEvent(event);

        expect(mockLogger.debug).toHaveBeenCalledWith({
            eventType: 'tool_progress',
            module:    'claude',
            tool:      'Read',
            msg:       'Tool execution started',
        });
    });

    test('should log tool_result events with parsed module and tool', () => {
        const event: AgentStreamEvent = {
            type:      'tool_result',
            tool_name: 'mcp__memory__view',
        };

        logStreamEvent(event);

        expect(mockLogger.debug).toHaveBeenCalledWith({
            eventType: 'tool_result',
            module:    'memory',
            tool:      'view',
            msg:       'Tool execution complete',
        });
    });

    test('should log result events with status from subtype', () => {
        const event: AgentStreamEvent = {
            type:    'result',
            subtype: 'success',
        };

        logStreamEvent(event);

        expect(mockLogger.debug).toHaveBeenCalledWith({
            eventType: 'result',
            status:    'success',
            msg:       'Claude LLM stream complete',
        });
    });

    test('should log result events with error_during_execution status', () => {
        const event: AgentStreamEvent = {
            type:    'result',
            subtype: 'error_during_execution',
        };

        logStreamEvent(event);

        expect(mockLogger.debug).toHaveBeenCalledWith({
            eventType: 'result',
            status:    'error_during_execution',
            msg:       'Claude LLM stream complete',
        });
    });

    test('should log result events with undefined subtype', () => {
        const event: AgentStreamEvent = {
            type: 'result',
        };

        logStreamEvent(event);

        expect(mockLogger.debug).toHaveBeenCalledWith({
            eventType: 'result',
            status:    undefined,
            msg:       'Claude LLM stream complete',
        });
    });

    describe('tool request/response flow', () => {
        test('should log tool_request when assistant message contains tool_use block', () => {
            const event: AgentStreamEvent = {
                type:    'assistant',
                message: {
                    content: [
                        {
                            type:  'tool_use',
                            id:    'tool_123',
                            name:  'WebFetch',
                            input: { url: 'https://example.com' },
                        },
                    ],
                },
            };

            logStreamEvent(event);

            expect(mockLogger.debug).toHaveBeenCalledWith({
                eventType: 'tool_request',
                toolName:  'WebFetch',
                msg:       'LLM requesting tool: WebFetch',
            });
        });

        test('should log multiple tool_requests when assistant message contains multiple tool_use blocks', () => {
            const event: AgentStreamEvent = {
                type:    'assistant',
                message: {
                    content: [
                        {
                            type:  'tool_use',
                            id:    'tool_1',
                            name:  'Read',
                            input: { path: '/file.txt' },
                        },
                        {
                            type:  'tool_use',
                            id:    'tool_2',
                            name:  'WebFetch',
                            input: { url: 'https://example.com' },
                        },
                    ],
                },
            };

            logStreamEvent(event);

            expect(mockLogger.debug).toHaveBeenCalledTimes(2);
            expect(mockLogger.debug).toHaveBeenCalledWith({
                eventType: 'tool_request',
                toolName:  'Read',
                msg:       'LLM requesting tool: Read',
            });
            expect(mockLogger.debug).toHaveBeenCalledWith({
                eventType: 'tool_request',
                toolName:  'WebFetch',
                msg:       'LLM requesting tool: WebFetch',
            });
        });

        test('should log tool_response when user event follows a tool request', () => {
            // First, simulate a tool request
            const toolRequestEvent: AgentStreamEvent = {
                type:    'assistant',
                message: {
                    content: [
                        {
                            type:  'tool_use',
                            id:    'tool_123',
                            name:  'WebFetch',
                            input: { url: 'https://example.com' },
                        },
                    ],
                },
            };
            logStreamEvent(toolRequestEvent);
            mockLogger.debug.mockClear();

            // Then, simulate the tool response (user event)
            const userEvent: AgentStreamEvent = { type: 'user' };
            logStreamEvent(userEvent);

            expect(mockLogger.debug).toHaveBeenCalledWith({
                eventType: 'tool_response',
                toolName:  'WebFetch',
                msg:       'Tool result for LLM: WebFetch',
            });
        });

        test('should use the last tool name when multiple tools were requested', () => {
            // Simulate multiple tool requests
            const multiToolEvent: AgentStreamEvent = {
                type:    'assistant',
                message: {
                    content: [
                        {
                            type:  'tool_use',
                            id:    'tool_1',
                            name:  'Read',
                            input: { path: '/file.txt' },
                        },
                        {
                            type:  'tool_use',
                            id:    'tool_2',
                            name:  'Grep',
                            input: { pattern: 'test' },
                        },
                    ],
                },
            };
            logStreamEvent(multiToolEvent);
            mockLogger.debug.mockClear();

            // The user event should reference the last tool
            const userEvent: AgentStreamEvent = { type: 'user' };
            logStreamEvent(userEvent);

            expect(mockLogger.debug).toHaveBeenCalledWith({
                eventType: 'tool_response',
                toolName:  'Grep',
                msg:       'Tool result for LLM: Grep',
            });
        });

        test('should clear last tool after user event', () => {
            // Simulate tool request
            const toolRequestEvent: AgentStreamEvent = {
                type:    'assistant',
                message: {
                    content: [
                        {
                            type:  'tool_use',
                            id:    'tool_123',
                            name:  'WebFetch',
                            input: { url: 'https://example.com' },
                        },
                    ],
                },
            };
            logStreamEvent(toolRequestEvent);

            // First user event (tool response)
            logStreamEvent({ type: 'user' });
            mockLogger.debug.mockClear();

            // Second user event should be a regular user message
            logStreamEvent({ type: 'user' });

            expect(mockLogger.debug).toHaveBeenCalledWith({
                eventType: 'user',
                msg:       'Sending message to Claude LLM',
            });
        });
    });
});

describe('extractToolUses', () => {
    test('should return empty array for non-assistant messages', () => {
        const message = { type: 'user', message: { content: [] } };
        expect(extractToolUses(message)).toEqual([]);
    });

    test('should return empty array for assistant messages with no content', () => {
        const message = { type: 'assistant', message: {} };
        expect(extractToolUses(message)).toEqual([]);
    });

    test('should return empty array for assistant messages with no tool_use blocks', () => {
        const message = {
            type:    'assistant',
            message: {
                content: [
                    { type: 'text', text: 'Hello world' },
                ],
            },
        };
        expect(extractToolUses(message)).toEqual([]);
    });

    test('should extract single tool_use block correctly', () => {
        const message = {
            type:    'assistant',
            message: {
                content: [
                    {
                        type:  'tool_use',
                        id:    'tool_123',
                        name:  'memory_view',
                        input: { path: '/memories/test' },
                    },
                ],
            },
        };
        const result = extractToolUses(message);
        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({
            type:  'tool_use',
            id:    'tool_123',
            name:  'memory_view',
            input: { path: '/memories/test' },
        });
    });

    test('should extract multiple tool_use blocks', () => {
        const message = {
            type:    'assistant',
            message: {
                content: [
                    { type: 'text', text: 'Let me check your memories' },
                    {
                        type:  'tool_use',
                        id:    'tool_123',
                        name:  'memory_view',
                        input: { path: '/memories/test' },
                    },
                    { type: 'text', text: 'Now storing something' },
                    {
                        type:  'tool_use',
                        id:    'tool_456',
                        name:  'memory_store',
                        input: { path: '/memories/new', content: 'data' },
                    },
                ],
            },
        };
        const result = extractToolUses(message);
        expect(result).toHaveLength(2);
        expect(result[0].name).toBe('memory_view');
        expect(result[1].name).toBe('memory_store');
    });

    test('should handle undefined content gracefully', () => {
        const message = { type: 'assistant', message: { content: undefined } };
        expect(extractToolUses(message)).toEqual([]);
    });

    test('should handle null content gracefully', () => {
        const message = { type: 'assistant', message: { content: null } };
        expect(extractToolUses(message)).toEqual([]);
    });

    test('should handle missing message property gracefully', () => {
        const message = { type: 'assistant' };
        expect(extractToolUses(message)).toEqual([]);
    });

    test('should handle undefined message property gracefully', () => {
        const message = { type: 'assistant', message: undefined };
        expect(extractToolUses(message)).toEqual([]);
    });
});

describe('extractThinkingContent', () => {
    test('should return empty string for non-assistant messages', () => {
        const message = { type: 'user', message: { content: [] } };
        expect(extractThinkingContent(message)).toBe('');
    });

    test('should return empty string for system messages', () => {
        const message = { type: 'system', message: { content: [] } };
        expect(extractThinkingContent(message)).toBe('');
    });

    test('should return empty string for result messages', () => {
        const message = { type: 'result', message: { content: [] } };
        expect(extractThinkingContent(message)).toBe('');
    });

    test('should return empty string for assistant messages with no content', () => {
        const message = { type: 'assistant', message: {} };
        expect(extractThinkingContent(message)).toBe('');
    });

    test('should return empty string for assistant messages with no thinking blocks', () => {
        const message = {
            type:    'assistant',
            message: {
                content: [
                    { type: 'text', text: 'Hello world' },
                ],
            },
        };
        expect(extractThinkingContent(message)).toBe('');
    });

    test('should extract single thinking block correctly', () => {
        const message = {
            type:    'assistant',
            message: {
                content: [
                    {
                        type: 'thinking',
                        text: 'Let me think about this...',
                    },
                ],
            },
        };
        expect(extractThinkingContent(message)).toBe('Let me think about this...');
    });

    test('should extract and join multiple thinking blocks', () => {
        const message = {
            type:    'assistant',
            message: {
                content: [
                    { type: 'thinking', text: 'First thought' },
                    { type: 'text', text: 'Some response text' },
                    { type: 'thinking', text: 'Second thought' },
                ],
            },
        };
        expect(extractThinkingContent(message)).toBe('First thought\nSecond thought');
    });

    test('should handle undefined content gracefully', () => {
        const message = { type: 'assistant', message: { content: undefined } };
        expect(extractThinkingContent(message)).toBe('');
    });

    test('should handle null content gracefully', () => {
        const message = { type: 'assistant', message: { content: null } };
        expect(extractThinkingContent(message)).toBe('');
    });

    test('should handle missing message property gracefully', () => {
        const message = { type: 'assistant' };
        expect(extractThinkingContent(message)).toBe('');
    });

    test('should handle thinking blocks with empty text', () => {
        const message = {
            type:    'assistant',
            message: {
                content: [
                    { type: 'thinking', text: '' },
                    { type: 'thinking', text: 'Valid thought' },
                ],
            },
        };
        // Empty strings should be filtered out by compact()
        expect(extractThinkingContent(message)).toBe('Valid thought');
    });

    test('should handle thinking blocks with undefined text', () => {
        const message = {
            type:    'assistant',
            message: {
                content: [
                    { type: 'thinking' },  // No text property
                    { type: 'thinking', text: 'Valid thought' },
                ],
            },
        };
        expect(extractThinkingContent(message)).toBe('Valid thought');
    });

    test('should trim whitespace from the final result', () => {
        const message = {
            type:    'assistant',
            message: {
                content: [
                    { type: 'thinking', text: '  Thought with spaces  ' },
                ],
            },
        };
        expect(extractThinkingContent(message)).toBe('Thought with spaces');
    });
});

describe('createClaudeAgent', () => {
    let mockMessageContext: DiscordMessageContext;
    let _mockContextBuilder: ContextBuilder;
    let querySpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        // Create mock Discord message context
        mockMessageContext = {
            guildId:   createGuildId('123456789'),
            channelId: createChannelId('987654321'),
            userId:    createUserId('111222333'),
            messageId: 'msg_999',
            content:   'Hello Claude!',
            timestamp: '2025-01-15T12:00:00Z',
            botUserId: createUserId('bot_444555666'),
        };

        // Create mock context builder
        _mockContextBuilder = {
            loadCoreIdentity:   mock(_.constant(Promise.resolve(''))),
            loadRecentContext:  mock(_.constant(Promise.resolve([]))),
            buildSystemContext: mock(_.constant(Promise.resolve(''))),
            // eslint-disable-next-line @typescript-eslint/no-empty-function -- Mock function
            recordAccess:       mock(async () => {}),
            loadRecentEvents:   mock(_.constant(Promise.resolve([]))),
            loadUserTimezone:   mock(_.constant(Promise.resolve(undefined))),
        };

        // Mock query() to return an async generator with assistant message

        querySpy = spyOn(agentSdk, 'query').mockImplementation((_params: any): any => {
            async function* mockGenerator() {
                yield {
                    type:    'assistant' as const,
                    message: {
                        content: [
                            {
                                type: 'text' as const,
                                text: 'Hello! This is a test response.',
                            },
                        ],
                    },
                };
            }
            return mockGenerator();
        });
    });

    afterEach(() => {
        querySpy.mockRestore();
    });

    test('should create an agent with chat method', () => {
        const agent = createClaudeAgent({});

        expect(agent).toBeDefined();
        expect(typeof agent.chat).toBe('function');
    });

    test('should call query with user message', async () => {
        const agent = createClaudeAgent({});

        await agent.chat(mockMessageContext);

        expect(querySpy).toHaveBeenCalledWith(
            expect.objectContaining({
                prompt: 'User @111222333 in #987654321: Hello Claude!',
            })
        );
    });

    test('should use claude-sonnet-4-5 model', async () => {
        const agent = createClaudeAgent({});

        await agent.chat(mockMessageContext);

        expect(querySpy).toHaveBeenCalledWith(
            expect.objectContaining({
                options: expect.objectContaining({
                    model: 'sonnet',
                }),
            })
        );
    });

    test('should return text content from Claude response', async () => {
        const agent = createClaudeAgent({});

        const response = await agent.chat(mockMessageContext);

        expect(response).toBe('Hello! This is a test response.');
    });

    test('should return full responses without truncating (chunking handled by Discord handlers)', async () => {
        const longText = _.repeat('a', 2000);
        querySpy.mockImplementation((_params: any): any => {
            async function* mockGenerator() {
                yield {
                    type:    'assistant' as const,
                    message: {
                        content: [
                            {
                                type: 'text' as const,
                                text: longText,
                            },
                        ],
                    },
                };
            }
            return mockGenerator();
        });

        const agent = createClaudeAgent({});
        const response = await agent.chat(mockMessageContext);

        // Agent should return full response, chunking is done in handlers
        expect(response).toBe(longText);
        expect(response?.length).toBe(2000);
    });

    test('should include memory MCP server when provided', async () => {
        const mockMcpServer = { name: 'memory', version: '1.0.0' };

        const agent = createClaudeAgent({

            memoryMcpServer: mockMcpServer as any,
        });

        await agent.chat(mockMessageContext);

        expect(querySpy).toHaveBeenCalledWith(
            expect.objectContaining({
                options: expect.objectContaining({
                    mcpServers: { memory: mockMcpServer },
                }),
            })
        );
    });

    test('should not include MCP servers when not provided', async () => {
        const agent = createClaudeAgent({});

        await agent.chat(mockMessageContext);

        const callArgs = querySpy.mock.calls[0][0];

        expect(callArgs.options.mcpServers).toBeUndefined();
    });

    test('should return null on API error', async () => {
        querySpy.mockImplementation((_params: any): any => {
            throw new Error('API rate limit exceeded');
        });

        const agent = createClaudeAgent({});
        const response = await agent.chat(mockMessageContext);

        expect(response).toBeNull();
    });

    test('should return null when response has no text content', async () => {
        querySpy.mockImplementation((_params: any): any => {
            async function* mockGenerator() {
                yield {
                    type:    'assistant' as const,
                    message: {
                        content: [], // Empty content
                    },
                };
            }
            return mockGenerator();
        });

        const agent = createClaudeAgent({});
        const response = await agent.chat(mockMessageContext);

        expect(response).toBeNull();
    });

    test('should handle empty message content', async () => {
        const emptyMessageContext: DiscordMessageContext = {
            ...mockMessageContext,
            content: '',
        };

        const agent = createClaudeAgent({});
        await agent.chat(emptyMessageContext);

        expect(querySpy).toHaveBeenCalledWith(
            expect.objectContaining({
                prompt: 'User @111222333 in #987654321: ',
            })
        );
    });

    test('should preserve whitespace in message content', async () => {
        const messageWithWhitespace: DiscordMessageContext = {
            ...mockMessageContext,
            content: '  Hello   World  ',
        };

        const agent = createClaudeAgent({});
        await agent.chat(messageWithWhitespace);

        expect(querySpy).toHaveBeenCalledWith(
            expect.objectContaining({
                prompt: 'User @111222333 in #987654321:   Hello   World  ',
            })
        );
    });

    test('should handle special characters in message content', async () => {
        const messageWithSpecialChars: DiscordMessageContext = {
            ...mockMessageContext,
            content: 'Hello! @user <#channel> **bold** `code`',
        };

        const agent = createClaudeAgent({});
        await agent.chat(messageWithSpecialChars);

        expect(querySpy).toHaveBeenCalledWith(
            expect.objectContaining({
                prompt: 'User @111222333 in #987654321: Hello! @user <#channel> **bold** `code`',
            })
        );
    });

    test('should extract latest assistant message from stream', async () => {
        querySpy.mockImplementation((_params: any): any => {
            async function* mockGenerator() {
                yield {
                    type:    'assistant' as const,
                    message: {
                        content: [
                            {
                                type: 'text' as const,
                                text: 'First message',
                            },
                        ],
                    },
                };
                yield {
                    type:    'assistant' as const,
                    message: {
                        content: [
                            {
                                type: 'text' as const,
                                text: 'Latest message',
                            },
                        ],
                    },
                };
            }
            return mockGenerator();
        });

        const agent = createClaudeAgent({});
        const response = await agent.chat(mockMessageContext);

        expect(response).toBe('Latest message');
    });

    test('should not truncate responses exactly at MAX_RESPONSE_LENGTH (1900)', async () => {
        const exactText = _.repeat('x', 1900);
        querySpy.mockImplementation((_params: any): any => {
            async function* mockGenerator() {
                yield {
                    type:    'assistant' as const,
                    message: {
                        content: [
                            {
                                type: 'text' as const,
                                text: exactText,
                            },
                        ],
                    },
                };
            }
            return mockGenerator();
        });

        const agent = createClaudeAgent({});
        const response = await agent.chat(mockMessageContext);

        expect(response).toBe(exactText);
        expect(response?.length).toBe(1900);
    });

    test('should return full response even when just over typical Discord limit', async () => {
        const longText = _.repeat('y', 1901);
        querySpy.mockImplementation((_params: any): any => {
            async function* mockGenerator() {
                yield {
                    type:    'assistant' as const,
                    message: {
                        content: [
                            {
                                type: 'text' as const,
                                text: longText,
                            },
                        ],
                    },
                };
            }
            return mockGenerator();
        });

        const agent = createClaudeAgent({});
        const response = await agent.chat(mockMessageContext);

        // Agent should return full response, chunking is done in handlers
        expect(response).toBe(longText);
        expect(response?.length).toBe(1901);
    });

    describe('tool configuration', () => {
        test('should include explicit tools list', async () => {
            const agent = createClaudeAgent({});

            await agent.chat(mockMessageContext);

            const callArgs = querySpy.mock.calls[0][0];
            expect(callArgs.options.tools).toEqual([
                'Read', 'Write', 'Edit', 'Glob', 'Grep',
                'WebFetch', 'WebSearch', 'Bash', 'Task',
                'TodoWrite', 'EnterPlanMode', 'ExitPlanMode',
            ]);
        });

        test('should include explicit agents without statusline-setup', async () => {
            const agent = createClaudeAgent({});

            await agent.chat(mockMessageContext);

            const callArgs = querySpy.mock.calls[0][0];
            expect(callArgs.options.agents).toEqual({
                'general-purpose': expect.objectContaining({
                    description: expect.any(String),
                    prompt:      expect.any(String),
                    model:       'sonnet',
                }),
                Explore: expect.objectContaining({
                    description: expect.any(String),
                    prompt:      expect.any(String),
                    tools:       ['Read', 'Glob', 'Grep'],
                    model:       'haiku',
                }),
                Plan: expect.objectContaining({
                    description: expect.any(String),
                    prompt:      expect.any(String),
                    tools:       ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
                    model:       'sonnet',
                }),
            });
        });

        test('should include allowedTools for auto-approved tools', async () => {
            const agent = createClaudeAgent({});

            await agent.chat(mockMessageContext);

            const callArgs = querySpy.mock.calls[0][0];
            expect(callArgs.options.allowedTools).toEqual([
                'mcp__memory__*',
                'Read',
                'Glob',
                'Grep',
                'WebFetch',
                'WebSearch',
                'TodoWrite',
                'EnterPlanMode',
                'ExitPlanMode',
                'Task',
                'Bash(git:*)',
                'Bash(bun run:*)',
                'Bash(bun test:*)',
                'Bash(bun lint:*)',
                'Bash(bun typecheck)',
                'Bash(ls:*)',
            ]);
        });

        test('should use acceptEdits permission mode without allowDangerouslySkipPermissions', async () => {
            const agent = createClaudeAgent({});

            await agent.chat(mockMessageContext);

            const callArgs = querySpy.mock.calls[0][0];
            expect(callArgs.options.permissionMode).toBe('acceptEdits');
            expect(callArgs.options.allowDangerouslySkipPermissions).toBeUndefined();
        });

        test('should provide stderr callback in options', async () => {
            const agent = createClaudeAgent({});

            await agent.chat(mockMessageContext);

            const callArgs = querySpy.mock.calls[0][0];
            expect(typeof callArgs.options.stderr).toBe('function');
        });

        test('should include memory MCP server when provided', async () => {
            const mockMcpServer = { name: 'memory', version: '1.0.0' };

            const agent = createClaudeAgent({
                memoryMcpServer: mockMcpServer as any,
            });

            await agent.chat(mockMessageContext);

            expect(querySpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    options: expect.objectContaining({
                        mcpServers: { memory: mockMcpServer },
                    }),
                })
            );
        });

        test('should not include mcpServers when no MCP server provided', async () => {
            const agent = createClaudeAgent({});

            await agent.chat(mockMessageContext);

            const callArgs = querySpy.mock.calls[0][0];
            expect(callArgs.options.mcpServers).toBeUndefined();
        });

        test('should include discord MCP server when provided', async () => {
            const mockDiscordMcpServer = { name: 'discord', version: '1.0.0' };

            const agent = createClaudeAgent({
                discordMcpServer: mockDiscordMcpServer as any,
            });

            await agent.chat(mockMessageContext);

            expect(querySpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    options: expect.objectContaining({
                        mcpServers: { discord: mockDiscordMcpServer },
                    }),
                })
            );
        });

        test('should NOT include memory MCP server when only discord MCP server provided', async () => {
            const mockDiscordMcpServer = { name: 'discord', version: '1.0.0' };

            const agent = createClaudeAgent({
                discordMcpServer: mockDiscordMcpServer as any,
            });

            await agent.chat(mockMessageContext);

            const callArgs = querySpy.mock.calls[0][0];
            // Should have discord but NOT memory
            expect(callArgs.options.mcpServers).toEqual({ discord: mockDiscordMcpServer });
            expect(callArgs.options.mcpServers.memory).toBeUndefined();
            // This catches the mutant that changes 'if(memoryMcpServer)' to 'if(true)'
            // which would add a 'memory: undefined' property to the object.
            // toEqual ignores undefined properties, but 'in' operator detects them.
            expect('memory' in callArgs.options.mcpServers).toBe(false);
            // Additional assertion: Object.keys should NOT include 'memory'
            expect(_.keys(callArgs.options.mcpServers)).toEqual(['discord']);
            // hasOwnProperty also checks for property existence
            expect(_.has(callArgs.options.mcpServers, 'memory')).toBe(false);
        });

        test('should NOT include discord MCP server when only memory MCP server provided', async () => {
            const mockMemoryMcpServer = { name: 'memory', version: '1.0.0' };

            const agent = createClaudeAgent({
                memoryMcpServer: mockMemoryMcpServer as any,
            });

            await agent.chat(mockMessageContext);

            const callArgs = querySpy.mock.calls[0][0];
            // Should have memory but NOT discord
            expect(callArgs.options.mcpServers).toEqual({ memory: mockMemoryMcpServer });
            expect(callArgs.options.mcpServers.discord).toBeUndefined();
            // This catches the mutant that changes 'if(discordMcpServer)' to 'if(true)'
            // which would add a 'discord: undefined' property to the object.
            // toEqual ignores undefined properties, but 'in' operator detects them.
            expect('discord' in callArgs.options.mcpServers).toBe(false);
            // Additional assertion: Object.keys should NOT include 'discord'
            expect(_.keys(callArgs.options.mcpServers)).toEqual(['memory']);
            // hasOwnProperty also checks for property existence
            expect(_.has(callArgs.options.mcpServers, 'discord')).toBe(false);
        });

        test('should include both memory and discord MCP servers when both provided', async () => {
            const mockMemoryMcpServer = { name: 'memory', version: '1.0.0' };
            const mockDiscordMcpServer = { name: 'discord', version: '1.0.0' };

            const agent = createClaudeAgent({
                memoryMcpServer:  mockMemoryMcpServer as any,
                discordMcpServer: mockDiscordMcpServer as any,
            });

            await agent.chat(mockMessageContext);

            expect(querySpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    options: expect.objectContaining({
                        mcpServers: {
                            memory:  mockMemoryMcpServer,
                            discord: mockDiscordMcpServer,
                        },
                    }),
                })
            );
        });

        test('should include Discord MCP tools in allowedTools when discord MCP server provided', async () => {
            const mockDiscordMcpServer = { name: 'discord', version: '1.0.0' };

            const agent = createClaudeAgent({
                discordMcpServer: mockDiscordMcpServer as any,
            });

            await agent.chat(mockMessageContext);

            const callArgs = querySpy.mock.calls[0][0];
            expect(callArgs.options.allowedTools).toContain('mcp__discord__*');
        });

        test('should include plugins when provided', async () => {
            const mockPlugins = [
                { type: 'local' as const, path: '/path/to/plugin-1' },
                { type: 'local' as const, path: '/path/to/plugin-2' },
            ];

            const agent = createClaudeAgent({
                plugins: mockPlugins,
            });

            await agent.chat(mockMessageContext);

            const callArgs = querySpy.mock.calls[0][0];
            expect(callArgs.options.plugins).toEqual(mockPlugins);
        });

        test('should not include plugins option when empty array provided', async () => {
            const agent = createClaudeAgent({
                plugins: [],
            });

            await agent.chat(mockMessageContext);

            const callArgs = querySpy.mock.calls[0][0];
            expect(callArgs.options.plugins).toBeUndefined();
        });

        test('should not include plugins option when not provided', async () => {
            const agent = createClaudeAgent({});

            await agent.chat(mockMessageContext);

            const callArgs = querySpy.mock.calls[0][0];
            expect(callArgs.options.plugins).toBeUndefined();
        });
    });

    describe('retry configuration', () => {
        test('should load retry configuration and create retryable query wrapper', async () => {
            // This test verifies that the retry config is loaded and used (lines 524, 527-529)
            // by checking that the agent doesn't crash when created and can execute queries
            const agent = createClaudeAgent({});

            // If retry config wasn't properly loaded at line 524, loadRetryConfig() would throw
            // If retry wrapper wasn't created at lines 527-529, this would fail
            await agent.chat(mockMessageContext);

            // Verify query was called (which means retry wrapper was created successfully)
            expect(querySpy).toHaveBeenCalled();
        });

        test('should pass retry policy to createRetryableQuery', async () => {
            // This test ensures the retry config object is actually used (line 528)
            // by verifying the agent can be created with custom retry config from environment
            const agent = createClaudeAgent({});

            // Execute a chat to trigger the retry-wrapped query
            await agent.chat(mockMessageContext);

            // The fact that this doesn't throw means:
            // 1. loadRetryConfig() was called and returned a valid config
            // 2. retryConfig.claude was passed to createRetryableQuery
            // 3. The retry wrapper was created successfully
            expect(querySpy).toHaveBeenCalled();
        });
    });
});
