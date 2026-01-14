/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- Test mocks require unsafe type operations */
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import _ from 'lodash';
import * as agentSdk from '@anthropic-ai/claude-agent-sdk';
import { createClaudeAgent, extractToolUses, extractThinkingContent, parseToolName, redactSensitiveArgs } from '../../../src/agent/agent';
import { mockLogger } from '../../setup';
import type { DiscordMessageContext } from '../../../src/integrations/discord/types';
import { createGuildId, createChannelId, createUserId } from '../../../src/integrations/discord/types';

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
        ['TodoWrite', { module: 'claude', tool: 'TodoWrite' }],
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
        expect(redactSensitiveArgs(null)).toBe(null);
        expect(redactSensitiveArgs(undefined)).toBe(undefined);
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

describe('createClaudeAgent', () => {
    let mockMessageContext: DiscordMessageContext;
    let querySpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        mockMessageContext = {
            guildId:   createGuildId('123456789'),
            channelId: createChannelId('987654321'),
            userId:    createUserId('111222333'),
            messageId: 'msg_999',
            content:   'Hello Claude!',
            timestamp: '2025-01-15T12:00:00Z',
            botUserId: createUserId('bot_444555666'),
        };

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
        mockLogger.debug.mockClear();
    });

    test('should create agent with chat method', () => {
        const agent = createClaudeAgent({});
        expect(agent).toBeDefined();
        expect(typeof agent.chat).toBe('function');
    });

    test('should return text content from response', async () => {
        const agent = createClaudeAgent({});
        const response = await agent.chat(mockMessageContext);
        expect(response).toBe('Hello! This is a test response.');
    });

    test('should return null on API error', async () => {
        querySpy.mockImplementation((_params: any): any => {
            throw new Error('API rate limit exceeded');
        });

        const agent = createClaudeAgent({});
        const response = await agent.chat(mockMessageContext);
        expect(response).toBeNull();
    });

    test('should return null when no text content', async () => {
        querySpy.mockImplementation((_params: any): any => {
            async function* mockGenerator() {
                yield {
                    type:    'assistant' as const,
                    message: { content: [] },
                };
            }
            return mockGenerator();
        });

        const agent = createClaudeAgent({});
        const response = await agent.chat(mockMessageContext);
        expect(response).toBeNull();
    });

    test('should extract latest assistant message from stream', async () => {
        querySpy.mockImplementation((_params: any): any => {
            async function* mockGenerator() {
                yield {
                    type:    'assistant' as const,
                    message: {
                        content: [{ type: 'text' as const, text: 'First message' }],
                    },
                };
                yield {
                    type:    'assistant' as const,
                    message: {
                        content: [{ type: 'text' as const, text: 'Latest message' }],
                    },
                };
            }
            return mockGenerator();
        });

        const agent = createClaudeAgent({});
        const response = await agent.chat(mockMessageContext);
        expect(response).toBe('Latest message');
    });

    describe('Configuration constants', () => {
        test('should use "sonnet" as CLAUDE_MODEL', async () => {
            const agent = createClaudeAgent({});
            await agent.chat(mockMessageContext);

            expect(querySpy).toHaveBeenCalledTimes(1);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const queryParams = querySpy.mock.calls[0][0];
            expect(queryParams.options.model).toBe('sonnet');
            // Verify model is not an empty string (kills StringLiteral mutant on line 14)
            expect(queryParams.options.model).not.toBe('');
        });

        test('should include all required tools in EXPLICIT_TOOLS', async () => {
            const agent = createClaudeAgent({});
            await agent.chat(mockMessageContext);

            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const queryParams = querySpy.mock.calls[0][0];
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const tools = queryParams.options.tools;

            // Verify exact array contents (order matters for mutation testing)
            expect(tools).toEqual([
                'Read',
                'Write',
                'Edit',
                'Glob',
                'Grep',
                'WebFetch',
                'WebSearch',
                'Bash',
                'Task',
                'TodoWrite',
                'EnterPlanMode',
                'ExitPlanMode',
            ]);
        });

        test('should include each specific tool by name in EXPLICIT_TOOLS', async () => {
            const agent = createClaudeAgent({});
            await agent.chat(mockMessageContext);

            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const queryParams = querySpy.mock.calls[0][0];
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const tools = queryParams.options.tools;

            // Verify each tool individually (kills StringLiteral mutants on lines 24-41)
            expect(tools).toContain('Read');
            expect(tools).toContain('Write');
            expect(tools).toContain('Edit');
            expect(tools).toContain('Glob');
            expect(tools).toContain('Grep');
            expect(tools).toContain('WebFetch');
            expect(tools).toContain('WebSearch');
            expect(tools).toContain('Bash');
            expect(tools).toContain('Task');
            expect(tools).toContain('TodoWrite');
            expect(tools).toContain('EnterPlanMode');
            expect(tools).toContain('ExitPlanMode');

            // Verify none are empty strings
            expect(_.every(tools, (tool: string) => tool !== '')).toBe(true);
        });

        test('should define EXPLICIT_AGENTS with correct structure', async () => {
            const agent = createClaudeAgent({});
            await agent.chat(mockMessageContext);

            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const queryParams = querySpy.mock.calls[0][0];
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const agents = queryParams.options.agents;

            // Verify exact agent structure
            expect(_.keys(agents).sort()).toEqual(['Explore', 'Plan', 'general-purpose'].sort());

            // Verify general-purpose agent with exact values
            expect(agents['general-purpose']).toEqual({
                description: 'General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks',
                prompt:      'You are a general-purpose assistant helping with software engineering tasks.',
                model:       'sonnet',
            });

            // Verify Explore agent with exact values
            expect(agents.Explore).toEqual({
                description: 'Fast agent specialized for exploring codebases. Use for finding files, searching code, or answering questions about the codebase.',
                prompt:      'You are a codebase exploration specialist. Focus on finding relevant files and understanding code structure.',
                tools:       ['Read', 'Glob', 'Grep'],
                model:       'haiku',
            });

            // Verify Plan agent with exact values
            expect(agents.Plan).toEqual({
                description: 'Software architect agent for designing implementation plans.',
                prompt:      'You are a software architect. Analyze requirements and design implementation approaches.',
                tools:       ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
                model:       'sonnet',
            });
        });

        test('should define EXPLICIT_AGENTS as non-empty object', async () => {
            const agent = createClaudeAgent({});
            await agent.chat(mockMessageContext);

            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const queryParams = querySpy.mock.calls[0][0];
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const agents = queryParams.options.agents;

            // Verify agents object is not empty (kills ObjectLiteral mutant on line 49)
            expect(_.keys(agents).length).toBeGreaterThan(0);
            expect(agents).not.toEqual({});
        });

        test('should include exact tools array for Explore agent', async () => {
            const agent = createClaudeAgent({});
            await agent.chat(mockMessageContext);

            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const queryParams = querySpy.mock.calls[0][0];
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const exploreTools = queryParams.options.agents.Explore.tools;

            // Verify Explore agent tools array is not empty (kills ArrayDeclaration mutant on line 62)
            expect(exploreTools).toBeDefined();
            expect(exploreTools.length).toBe(3);

            // Verify each tool individually (kills StringLiteral mutants on line 62)
            expect(exploreTools).toContain('Read');
            expect(exploreTools).toContain('Glob');
            expect(exploreTools).toContain('Grep');

            // Verify exact order and values
            expect(exploreTools).toEqual(['Read', 'Glob', 'Grep']);

            // Verify none are empty strings
            expect(_.every(exploreTools, (tool: string) => tool !== '')).toBe(true);
        });

        test('should include exact tools array for Plan agent', async () => {
            const agent = createClaudeAgent({});
            await agent.chat(mockMessageContext);

            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const queryParams = querySpy.mock.calls[0][0];
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const planTools = queryParams.options.agents.Plan.tools;

            // Verify Plan agent tools array is defined
            expect(planTools).toBeDefined();
            expect(planTools.length).toBe(5);

            // Verify each tool individually (kills StringLiteral mutants on line 70)
            expect(planTools).toContain('Read');
            expect(planTools).toContain('Glob');
            expect(planTools).toContain('Grep');
            expect(planTools).toContain('WebFetch');
            expect(planTools).toContain('WebSearch');

            // Verify exact order and values
            expect(planTools).toEqual(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch']);

            // Verify none are empty strings
            expect(_.every(planTools, (tool: string) => tool !== '')).toBe(true);
        });
    });

    describe('MCP server configuration', () => {
        test('should pass undefined mcpServers when no MCP servers provided', async () => {
            const agent = createClaudeAgent({});
            await agent.chat(mockMessageContext);

            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const queryParams = querySpy.mock.calls[0][0];
            expect(queryParams.options.mcpServers).toBeUndefined();
        });

        test('should configure memory MCP server when provided', async () => {
            const mockMemoryServer = { command: 'node', args: ['memory-server.js'] };
            const agent = createClaudeAgent({ memoryMcpServer: mockMemoryServer });
            await agent.chat(mockMessageContext);

            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const queryParams = querySpy.mock.calls[0][0];
            expect(queryParams.options.mcpServers).toBeDefined();
            expect(queryParams.options.mcpServers.memory).toEqual(mockMemoryServer);
        });

        test('should configure discord MCP server when provided', async () => {
            const mockDiscordServer = { command: 'node', args: ['discord-server.js'] };
            const agent = createClaudeAgent({ discordMcpServer: mockDiscordServer });
            await agent.chat(mockMessageContext);

            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const queryParams = querySpy.mock.calls[0][0];
            expect(queryParams.options.mcpServers).toBeDefined();
            expect(queryParams.options.mcpServers.discord).toEqual(mockDiscordServer);
        });

        test('should configure both MCP servers when both provided', async () => {
            const mockMemoryServer = { command: 'node', args: ['memory-server.js'] };
            const mockDiscordServer = { command: 'node', args: ['discord-server.js'] };
            const agent = createClaudeAgent({
                memoryMcpServer:  mockMemoryServer,
                discordMcpServer: mockDiscordServer,
            });
            await agent.chat(mockMessageContext);

            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const queryParams = querySpy.mock.calls[0][0];
            expect(queryParams.options.mcpServers).toBeDefined();
            expect(queryParams.options.mcpServers.memory).toEqual(mockMemoryServer);
            expect(queryParams.options.mcpServers.discord).toEqual(mockDiscordServer);
        });
    });

    describe('Allowed tools configuration', () => {
        test('should include base allowed tools without Discord MCP', async () => {
            const agent = createClaudeAgent({});
            await agent.chat(mockMessageContext);

            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const queryParams = querySpy.mock.calls[0][0];
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const allowedTools = queryParams.options.allowedTools;

            // Verify exact array contents (order matters for mutation testing)
            expect(allowedTools).toEqual([
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

        test('should include Discord tools when Discord MCP server provided', async () => {
            const mockDiscordServer = { command: 'node', args: ['discord-server.js'] };
            const agent = createClaudeAgent({ discordMcpServer: mockDiscordServer });
            await agent.chat(mockMessageContext);

            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const queryParams = querySpy.mock.calls[0][0];
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const allowedTools = queryParams.options.allowedTools;

            // Verify exact array contents with Discord tools included
            expect(allowedTools).toEqual([
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
                'mcp__discord__*',
            ]);
        });
    });

    describe('Plugins configuration', () => {
        test('should pass undefined when plugins array is empty', async () => {
            const agent = createClaudeAgent({ plugins: [] });
            await agent.chat(mockMessageContext);

            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const queryParams = querySpy.mock.calls[0][0];
            // Verify plugins is undefined when empty array provided (kills ConditionalExpression mutant on line 565)
            expect(queryParams.options.plugins).toBeUndefined();
        });

        test('should pass undefined when plugins is undefined', async () => {
            const agent = createClaudeAgent({ plugins: undefined });
            await agent.chat(mockMessageContext);

            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const queryParams = querySpy.mock.calls[0][0];
            expect(queryParams.options.plugins).toBeUndefined();
        });

        test('should pass plugins array when non-empty', async () => {
            const mockPlugins = [{ type: 'local' as const, name: 'test-plugin', path: '/path/to/plugin' }];
            const agent = createClaudeAgent({ plugins: mockPlugins });
            await agent.chat(mockMessageContext);

            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const queryParams = querySpy.mock.calls[0][0];
            // Verify plugins is passed through when non-empty (kills ConditionalExpression mutant on line 565)
            expect(queryParams.options.plugins).toEqual(mockPlugins);
            expect(queryParams.options.plugins).not.toBeUndefined();
        });
    });
});
