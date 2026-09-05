import { describe, test, expect } from 'bun:test';
import { extractAssistantText, extractThinkingContent, extractToolUses, parseToolName, redactSensitiveArgs } from '@/agent/stream-extractors';

describe('parseToolName', () => {
    test.each([
        // MCP format
        ['mcp__memory__view', { module: 'memory', tool: 'view' }],
        ['mcp__discord__get_messages', { module: 'discord', tool: 'get_messages' }],
        // Nested modules with double underscores
        ['mcp__discord__search__messages', { module: 'discord', tool: 'search__messages' }],
        ['mcp__server__a__b__c', { module: 'server', tool: 'a__b__c' }],
        ['mcp__memory__search', { module: 'memory', tool: 'search' }],
        // Standard tools
        ['Read', { module: 'claude', tool: 'Read' }],
        ['WebFetch', { module: 'claude', tool: 'WebFetch' }],
        ['TaskCreate', { module: 'claude', tool: 'TaskCreate' }],
        // Non-MCP patterns (should NOT be treated as MCP)
        ['regular_tool', { module: 'claude', tool: 'regular_tool' }],
        ['some__other__tool', { module: 'claude', tool: 'some__other__tool' }],
        ['mcp_memory_search', { module: 'claude', tool: 'mcp_memory_search' }],
        ['foo__bar__baz', { module: 'claude', tool: 'foo__bar__baz' }],
        // Edge cases
        ['', { module: 'claude', tool: '' }],
        [undefined, { module: 'claude', tool: 'unknown' }],
        ['mcp__foo', { module: 'claude', tool: 'mcp__foo' }],
        ['mcp__', { module: 'claude', tool: 'mcp__' }],
    ] as const)('should parse "%s" as %j', (input, expected) => {
        expect(parseToolName(input as string | undefined)).toEqual(expected);
    });
});

describe('redactSensitiveArgs', () => {
    test.each([
        ['apiKey', 'value'],
        ['password', 'value'],
        ['secret', 'value'],
        ['token', 'value'],
        ['credential', 'value'],
        ['auth', 'value'],
        ['privateKey', 'value'],
        ['secretKey', 'value'],
        ['accessKey', 'value'],
        ['authKey', 'value'],
        ['passwd', 'value'],
        ['PASSWORD', 'value'], // Case insensitivity
        ['ApiKey', 'value'],
        ['API_KEY', 'value'],
        ['primaryKey', 'db-key'], // Keys containing "key" substring
        ['sortKey', 'sort-value'],
        ['keyboardType', 'numeric'],
    ])('should redact sensitive key "%s"', (key, value) => {
        expect(redactSensitiveArgs({ [key]: value })).toEqual({ [key]: '[REDACTED]' });
    });

    test('should NOT redact non-sensitive keys', () => {
        const nonSensitive = { path: '/memories/test', content: 'Hello', name: 'my-tool', id: '12345' };
        expect(redactSensitiveArgs(nonSensitive)).toEqual(nonSensitive);
    });

    test('should redact in nested objects', () => {
        const input = {
            config: {
                apiKey:   'secret',
                endpoint: 'https://api.example.com',
            },
            level1: {
                level2: {
                    level3: {
                        password: 'deep-secret',
                    },
                },
            },
        };
        expect(redactSensitiveArgs(input)).toEqual({
            config: {
                apiKey:   '[REDACTED]',
                endpoint: 'https://api.example.com',
            },
            level1: {
                level2: {
                    level3: {
                        password: '[REDACTED]',
                    },
                },
            },
        });
    });

    test('should redact in arrays', () => {
        const input = {
            users: [
                { name: 'Alice', password: 'secret1' },
                { name: 'Bob', password: 'secret2' },
            ],
            items: ['string', 123, { token: 'secret' }, null],
        };
        expect(redactSensitiveArgs(input)).toEqual({
            users: [
                { name: 'Alice', password: '[REDACTED]' },
                { name: 'Bob', password: '[REDACTED]' },
            ],
            items: ['string', 123, { token: '[REDACTED]' }, null],
        });
    });

    test('should handle primitives unchanged', () => {
        expect(redactSensitiveArgs('string')).toBe('string');
        expect(redactSensitiveArgs(123)).toBe(123);
        expect(redactSensitiveArgs(true)).toBe(true);
        expect(redactSensitiveArgs(null)).toBeNull();
        expect(redactSensitiveArgs(undefined)).toBeUndefined();
    });

    test('should handle empty collections', () => {
        expect(redactSensitiveArgs({})).toEqual({});
        expect(redactSensitiveArgs([])).toEqual([]);
    });

    test('should redact multiple sensitive keys in same object', () => {
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

describe('extractToolUses', () => {
    test('should return empty array for non-assistant messages', () => {
        expect(extractToolUses({ type: 'user', message: { content: [] } })).toEqual([]);
        expect(extractToolUses({ type: 'assistant', message: {} })).toEqual([]);
        expect(extractToolUses({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } })).toEqual([]);
    });

    test('should extract single tool_use block', () => {
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
                    { type: 'text', text: 'Let me check' },
                    {
                        type:  'tool_use',
                        id:    'tool_123',
                        name:  'memory_view',
                        input: { path: '/memories/test' },
                    },
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
});

describe('extractThinkingContent', () => {
    test('should return empty string for non-assistant messages', () => {
        expect(extractThinkingContent({ type: 'user', message: { content: [] } })).toBe('');
        expect(extractThinkingContent({ type: 'system', message: { content: [] } })).toBe('');
        expect(extractThinkingContent({ type: 'result', message: { content: [] } })).toBe('');
        expect(extractThinkingContent({ type: 'assistant', message: {} })).toBe('');
        expect(extractThinkingContent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } })).toBe('');
    });

    test('should extract single thinking block', () => {
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
                    { type: 'text', text: 'Some response' },
                    { type: 'thinking', text: 'Second thought' },
                ],
            },
        };
        expect(extractThinkingContent(message)).toBe('First thought\nSecond thought');
    });

    test('should trim whitespace from final joined thinking content', () => {
        const message = {
            type:    'assistant',
            message: {
                content: [
                    { type: 'thinking', text: ' First thought' },
                    { type: 'thinking', text: 'Second thought ' },
                ],
            },
        };
        // The join creates " First thought\nSecond thought " and trim removes leading/trailing space
        expect(extractThinkingContent(message)).toBe('First thought\nSecond thought');
    });
});

describe('extractAssistantText', () => {
    test('extracts and joins assistant text blocks', () => {
        expect(extractAssistantText({
            type:    'assistant',
            message: { content: [{ type: 'text', text: ' First' }, { type: 'thinking', text: 'ignored' }, { type: 'text', text: 'Second ' }] },
        })).toBe('First\nSecond');
    });
});
