/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- Test mocks require unsafe type operations */
import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
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

    test('should create agent with handleInput method', () => {
        const agent = createClaudeAgent({});
        expect(agent).toBeDefined();
        expect(typeof agent.handleInput).toBe('function');
    });

    test('should return text content from response', async () => {
        const agent = createClaudeAgent({});
        const result = await agent.handleInput([mockMessageContext]);
        expect(result.response).toBe('Hello! This is a test response.');
    });

    test('should return null on API error', async () => {
        querySpy.mockImplementation((_params: any): any => {
            throw new Error('API rate limit exceeded');
        });

        const agent = createClaudeAgent({});
        const result = await agent.handleInput([mockMessageContext]);
        expect(result.response).toBeNull();
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
        const result = await agent.handleInput([mockMessageContext]);
        expect(result.response).toBeNull();
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
        const result = await agent.handleInput([mockMessageContext]);
        expect(result.response).toBe('Latest message');
    });

    describe('Configuration constants', () => {
        test('should use "sonnet" as CLAUDE_MODEL', async () => {
            const agent = createClaudeAgent({});
            await agent.handleInput([mockMessageContext]);

            expect(querySpy).toHaveBeenCalledTimes(1);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const queryParams = querySpy.mock.calls[0][0];
            expect(queryParams.options.model).toBe('opus');
            // Verify model is not an empty string (kills StringLiteral mutant on line 14)
            expect(queryParams.options.model).not.toBe('');
        });

        test('should include all required tools in EXPLICIT_TOOLS', async () => {
            const agent = createClaudeAgent({});
            await agent.handleInput([mockMessageContext]);

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
                'TaskCreate',
                'TaskUpdate',
                'TaskGet',
                'TaskList',
                'EnterPlanMode',
                'ExitPlanMode',
                'Skill',
            ]);
        });

        test('should include each specific tool by name in EXPLICIT_TOOLS', async () => {
            const agent = createClaudeAgent({});
            await agent.handleInput([mockMessageContext]);

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
            expect(tools).toContain('TaskCreate');
            expect(tools).toContain('TaskUpdate');
            expect(tools).toContain('TaskGet');
            expect(tools).toContain('TaskList');
            expect(tools).toContain('EnterPlanMode');
            expect(tools).toContain('ExitPlanMode');
            expect(tools).toContain('Skill');

            // Verify none are empty strings
            expect(_.every(tools, (tool: string) => tool !== '')).toBe(true);
        });

        test('should define EXPLICIT_AGENTS with correct structure', async () => {
            const agent = createClaudeAgent({});
            await agent.handleInput([mockMessageContext]);

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
            await agent.handleInput([mockMessageContext]);

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
            await agent.handleInput([mockMessageContext]);

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
            await agent.handleInput([mockMessageContext]);

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
            await agent.handleInput([mockMessageContext]);

            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const queryParams = querySpy.mock.calls[0][0];
            expect(queryParams.options.mcpServers).toBeUndefined();
        });

        test('should configure memory MCP server when provided', async () => {
            const mockMemoryServer = { command: 'node', args: ['memory-server.js'] };
            const agent = createClaudeAgent({ memoryMcpServer: mockMemoryServer });
            await agent.handleInput([mockMessageContext]);

            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const queryParams = querySpy.mock.calls[0][0];
            expect(queryParams.options.mcpServers).toBeDefined();
            expect(queryParams.options.mcpServers.memory).toEqual(mockMemoryServer);
        });

        test('should configure discord MCP server when provided', async () => {
            const mockDiscordServer = { command: 'node', args: ['discord-server.js'] };
            const agent = createClaudeAgent({ discordMcpServer: mockDiscordServer });
            await agent.handleInput([mockMessageContext]);

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
            await agent.handleInput([mockMessageContext]);

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
            await agent.handleInput([mockMessageContext]);

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
                'TaskCreate',
                'TaskUpdate',
                'TaskGet',
                'TaskList',
                'EnterPlanMode',
                'ExitPlanMode',
                'Task',
                // Skills
                'Skill',
                // Bash commands (specific safe commands only)
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
            await agent.handleInput([mockMessageContext]);

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
                'TaskCreate',
                'TaskUpdate',
                'TaskGet',
                'TaskList',
                'EnterPlanMode',
                'ExitPlanMode',
                'Task',
                // Skills
                'Skill',
                // Bash commands (specific safe commands only)
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

    describe('tool filtering by specialMode', () => {
        test('should exclude inbox tools when specialMode is undefined (chat)', async () => {
            const mockInboxServer = { command: 'node', args: ['inbox-server.js'] };
            const agent = createClaudeAgent({ inboxMcpServer: mockInboxServer });
            await agent.handleInput([mockMessageContext]);

            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const queryParams = querySpy.mock.calls[0][0];
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const allowedTools = queryParams.options.allowedTools;

            // Verify inbox tools are NOT included
            expect(allowedTools).not.toContain('mcp__inbox__*');
        });

        test('should exclude inbox MCP server when specialMode is undefined (chat)', async () => {
            const mockInboxServer = { command: 'node', args: ['inbox-server.js'] };
            const agent = createClaudeAgent({ inboxMcpServer: mockInboxServer });
            await agent.handleInput([mockMessageContext]);

            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const queryParams = querySpy.mock.calls[0][0];
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const mcpServers = queryParams.options.mcpServers;

            // Verify inbox server is NOT registered
            expect(mcpServers?.inbox).toBeUndefined();
        });

        test('should exclude inbox tools when specialMode is undefined (handleInput)', async () => {
            const mockInboxServer = { command: 'node', args: ['inbox-server.js'] };
            const agent = createClaudeAgent({ inboxMcpServer: mockInboxServer });
            await agent.handleInput([mockMessageContext]);

            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const queryParams = querySpy.mock.calls[0][0];
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const allowedTools = queryParams.options.allowedTools;

            // Verify inbox tools are NOT included
            expect(allowedTools).not.toContain('mcp__inbox__*');
        });

        test('should exclude inbox MCP server when specialMode is undefined (handleInput)', async () => {
            const mockInboxServer = { command: 'node', args: ['inbox-server.js'] };
            const agent = createClaudeAgent({ inboxMcpServer: mockInboxServer });
            await agent.handleInput([mockMessageContext]);

            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const queryParams = querySpy.mock.calls[0][0];
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const mcpServers = queryParams.options.mcpServers;

            // Verify inbox server is NOT registered
            expect(mcpServers?.inbox).toBeUndefined();
        });

        test('should include inbox tools when specialMode is catchup (handleInput)', async () => {
            const mockInboxServer = { command: 'node', args: ['inbox-server.js'] };
            const agent = createClaudeAgent({ inboxMcpServer: mockInboxServer });
            await agent.handleInput([mockMessageContext], { specialMode: 'catchup' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const queryParams = querySpy.mock.calls[0][0];
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const allowedTools = queryParams.options.allowedTools;

            // Verify inbox tools ARE included
            expect(allowedTools).toContain('mcp__inbox__*');
        });

        test('should include inbox MCP server when specialMode is catchup (handleInput)', async () => {
            const mockInboxServer = { command: 'node', args: ['inbox-server.js'] };
            const agent = createClaudeAgent({ inboxMcpServer: mockInboxServer });
            await agent.handleInput([mockMessageContext], { specialMode: 'catchup' });

            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const queryParams = querySpy.mock.calls[0][0];
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const mcpServers = queryParams.options.mcpServers;

            // Verify inbox server IS registered
            expect(mcpServers?.inbox).toEqual(mockInboxServer);
        });
    });

    describe('Plugins configuration', () => {
        test('should pass undefined when plugins array is empty', async () => {
            const agent = createClaudeAgent({ plugins: [] });
            await agent.handleInput([mockMessageContext]);

            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const queryParams = querySpy.mock.calls[0][0];
            // Verify plugins is undefined when empty array provided (kills ConditionalExpression mutant on line 565)
            expect(queryParams.options.plugins).toBeUndefined();
        });

        test('should pass undefined when plugins is undefined', async () => {
            const agent = createClaudeAgent({ plugins: undefined });
            await agent.handleInput([mockMessageContext]);

            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const queryParams = querySpy.mock.calls[0][0];
            expect(queryParams.options.plugins).toBeUndefined();
        });

        test('should pass plugins array when non-empty', async () => {
            const mockPlugins = [{ type: 'local' as const, name: 'test-plugin', path: '/path/to/plugin' }];
            const agent = createClaudeAgent({ plugins: mockPlugins });
            await agent.handleInput([mockMessageContext]);

            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const queryParams = querySpy.mock.calls[0][0];
            // Verify plugins is passed through when non-empty (kills ConditionalExpression mutant on line 565)
            expect(queryParams.options.plugins).toEqual(mockPlugins);
            expect(queryParams.options.plugins).not.toBeUndefined();
        });
    });

    describe('handleInput', () => {
        test('should return response for single message', async () => {
            const agent = createClaudeAgent({});
            const result = await agent.handleInput([mockMessageContext]);

            expect(result.response).toBe('Hello! This is a test response.');
            expect(result.wasInterrupted).toBe(false);
            expect(result.sessionId).toBeUndefined();
            expect(result.streamTracker).toBeDefined();
        });

        test('should load user timezone and pass to system prompt', async () => {
            const mockContextBuilder = {
                // eslint-disable-next-line lodash/prefer-constant -- Mock setup for testing
                loadCoreIdentity:  mock(async () => 'I am a test identity'),
                // eslint-disable-next-line lodash/prefer-constant -- Mock setup for testing
                loadUserTimezone:  mock(async () => 'America/New_York'),
                loadRecentContext: mock(async () => []),
                loadRecentEvents:  mock(async () => []),
                recordAccess:      mock(async () => undefined),
            };

            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Mock context builder for testing
            const agent = createClaudeAgent({ contextBuilder: mockContextBuilder as unknown as any });
            const result = await agent.handleInput([mockMessageContext]);

            // Verify loadUserTimezone was called once and value reused for both system prompt and message timestamps
            expect(mockContextBuilder.loadUserTimezone).toHaveBeenCalledTimes(1);
            expect(mockContextBuilder.loadUserTimezone).toHaveBeenCalledWith(mockMessageContext.userId);

            // Agent should complete normally
            expect(result.response).toBe('Hello! This is a test response.');

            // Verify system prompt includes timezone info (both UTC and Local time)
            expect(querySpy).toHaveBeenCalledTimes(1);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const queryParams = querySpy.mock.calls[0][0];
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const systemPrompt = queryParams.options.systemPrompt;
            expect(systemPrompt).toContain('America/New_York');
            expect(systemPrompt).toContain('Local:');
        });

        test('should pass user timezone to buildContextPrefix for consistent time display', async () => {
            // This test verifies that the user timezone loaded from loadUserTimezone()
            // is threaded through to buildContextPrefix() so that the context prefix
            // "Local:" line shows the SAME timezone as the system prompt and message timestamps
            const mockContextBuilder = {
                // eslint-disable-next-line lodash/prefer-constant -- Mock setup for testing
                loadCoreIdentity:  mock(async () => 'I am a test identity'),
                // eslint-disable-next-line lodash/prefer-constant -- Mock setup for testing
                loadUserTimezone:  mock(async () => 'America/Los_Angeles'),
                loadRecentContext: mock(async () => ['User fact 1']),
                loadRecentEvents:  mock(async () => []),
                recordAccess:      mock(async () => undefined),
            };

            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Mock context builder for testing
            const agent = createClaudeAgent({ contextBuilder: mockContextBuilder as unknown as any });
            await agent.handleInput([mockMessageContext]);

            // Verify context prefix contains user timezone (not server timezone)
            expect(querySpy).toHaveBeenCalledTimes(1);
            const prompt = querySpy.mock.calls[0][0].prompt as string;

            // Extract the context prefix section (before "User @")
            const contextPrefixRegex = /^(.*?)\nUser @/s;
            const contextPrefixMatch = contextPrefixRegex.exec(prompt);
            expect(contextPrefixMatch).toBeTruthy();
            const contextPrefix = contextPrefixMatch![1];

            // Verify both occurrences of "America/Los_Angeles" in context prefix
            // Line 1: "- Local: YYYY-MM-DDTHH:mm:ss America/Los_Angeles (DayOfWeek TimeOfDay)"
            // Should NOT show server timezone
            const localLineRegex = /- Local: (.+)/;
            const localLineMatch = localLineRegex.exec(contextPrefix);
            expect(localLineMatch).toBeTruthy();
            expect(localLineMatch![1]).toContain('America/Los_Angeles');
        });

        test('should NOT load user timezone for catch-up flow', async () => {
            const mockContextBuilder = {
                // eslint-disable-next-line lodash/prefer-constant -- Mock setup for testing
                loadCoreIdentity:  mock(async () => 'I am a test identity'),
                // eslint-disable-next-line lodash/prefer-constant -- Mock setup for testing
                loadUserTimezone:  mock(async () => 'America/New_York'),
                loadRecentContext: mock(async () => []),
                loadRecentEvents:  mock(async () => []),
                recordAccess:      mock(async () => undefined),
            };

            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Mock context builder for testing
            const agent = createClaudeAgent({ contextBuilder: mockContextBuilder as unknown as any });
            await agent.handleInput([mockMessageContext], {
                catchUpPrompt: 'Catch up on messages',
            });

            // loadUserTimezone should NOT be called for catch-up flow
            expect(mockContextBuilder.loadUserTimezone).not.toHaveBeenCalled();
        });

        test('should NOT load user timezone for perch flow', async () => {
            const mockContextBuilder = {
                // eslint-disable-next-line lodash/prefer-constant -- Mock setup for testing
                loadCoreIdentity:  mock(async () => 'I am a test identity'),
                // eslint-disable-next-line lodash/prefer-constant -- Mock setup for testing
                loadUserTimezone:  mock(async () => 'America/New_York'),
                loadRecentContext: mock(async () => []),
                loadRecentEvents:  mock(async () => []),
                recordAccess:      mock(async () => undefined),
            };

            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Mock context builder for testing
            const agent = createClaudeAgent({ contextBuilder: mockContextBuilder as unknown as any });
            await agent.handleInput([mockMessageContext], {
                perchPrompt: 'Perch time',
            });

            // loadUserTimezone should NOT be called for perch flow
            expect(mockContextBuilder.loadUserTimezone).not.toHaveBeenCalled();
        });

        test('should NOT load user timezone for resume flow', async () => {
            const mockContextBuilder = {
                // eslint-disable-next-line lodash/prefer-constant -- Mock setup for testing
                loadCoreIdentity:  mock(async () => 'I am a test identity'),
                // eslint-disable-next-line lodash/prefer-constant -- Mock setup for testing
                loadUserTimezone:  mock(async () => 'America/New_York'),
                loadRecentContext: mock(async () => []),
                loadRecentEvents:  mock(async () => []),
                recordAccess:      mock(async () => undefined),
            };

            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Mock context builder for testing
            const agent = createClaudeAgent({ contextBuilder: mockContextBuilder as unknown as any });
            await agent.handleInput([mockMessageContext], {
                resumeContext: {
                    partialWork: {
                        thinking:       'resuming...',
                        text:           '',
                        pendingToolUse: null,
                        sessionId:      undefined,
                    },
                    newEvents:   [],
                    newMessages: [],
                },
            });

            // loadUserTimezone should NOT be called for resume flow
            expect(mockContextBuilder.loadUserTimezone).not.toHaveBeenCalled();
        });

        test('should handle loadUserTimezone failure gracefully and continue with server timezone', async () => {
            const mockContextBuilder = {
                // eslint-disable-next-line lodash/prefer-constant -- Mock setup for testing
                loadCoreIdentity: mock(async () => 'I am a test identity'),
                // Mock loadUserTimezone to throw an error
                loadUserTimezone: mock(async () => {
                    throw new Error('DynamoDB connection failed');
                }),
                loadRecentContext: mock(async () => []),
                loadRecentEvents:  mock(async () => []),
                recordAccess:      mock(async () => undefined),
            };

            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Mock context builder for testing
            const agent = createClaudeAgent({ contextBuilder: mockContextBuilder as unknown as any });
            const result = await agent.handleInput([mockMessageContext]);

            // Verify loadUserTimezone was called and threw
            expect(mockContextBuilder.loadUserTimezone).toHaveBeenCalledTimes(1);

            // Processing should continue successfully with server timezone fallback
            expect(result.response).toBe('Hello! This is a test response.');
            expect(result.wasInterrupted).toBe(false);

            // Verify warning was logged (indirectly via no crash)
            expect(querySpy).toHaveBeenCalledTimes(1);
        });

        test('should build user message with empty contextPrefix when no contextBuilder', async () => {
            const agent = createClaudeAgent({});
            await agent.handleInput([mockMessageContext]);

            expect(querySpy).toHaveBeenCalledTimes(1);
            const prompt = querySpy.mock.calls[0][0].prompt as string;

            // Should NOT have a contextPrefix when contextBuilder is undefined
            expect(prompt).not.toContain('## Current Time');
            expect(prompt).not.toContain('[About this user]');
            // Kills mutant #1: contextPrefix should be empty string, not "Stryker was here!"
            expect(prompt).toMatch(/^User @/);
        });

        test('should join multiple messages with double newlines', async () => {
            const agent = createClaudeAgent({});
            const message1 = { ...mockMessageContext, messageId: 'msg_1', content: 'First message' };
            const message2 = { ...mockMessageContext, messageId: 'msg_2', content: 'Second message' };

            await agent.handleInput([message1, message2]);

            expect(querySpy).toHaveBeenCalledTimes(1);
            const prompt = querySpy.mock.calls[0][0].prompt as string;

            // Kills mutant #2: messages should be joined with '\n\n', not empty string
            expect(prompt).toContain('First message\n\nUser @');
            expect(prompt).toContain('Second message');
            // Verify double newline exists between messages
            const lines = _.split(prompt, '\n');
            const firstIndex = _.findIndex(lines, l => l.includes('First message'));
            expect(lines[firstIndex + 1]).toBe('');
        });

        test('should initialize lastAssistantText as empty string', async () => {
            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:    'assistant' as const,
                        message: {
                            content: [
                                { type: 'text' as const, text: '' }, // Empty text
                            ],
                        },
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            const result = await agent.handleInput([mockMessageContext]);

            // Kills mutant #3: lastAssistantText starts as '', not "Stryker was here!"
            // If it started as "Stryker was here!", we'd get that back instead of null
            expect(result.response).toBeNull();
        });

        test('should not assign empty text to lastAssistantText', async () => {
            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:    'assistant' as const,
                        message: {
                            content: [
                                { type: 'text' as const, text: '' }, // Empty text should NOT be assigned
                            ],
                        },
                    };
                    yield {
                        type:    'assistant' as const,
                        message: {
                            content: [
                                { type: 'text' as const, text: 'Valid response' },
                            ],
                        },
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            const result = await agent.handleInput([mockMessageContext]);

            // Kills mutant #4: if (text) check ensures empty text is not assigned
            expect(result.response).toBe('Valid response');
        });

        test('should catch and return null for non-AbortError exceptions', async () => {
            querySpy.mockImplementation((_params: any): any => {
                // Use a regular async iterable that throws, not a generator
                return {
                    [Symbol.asyncIterator]: () => ({
                        next: async () => {
                            const error = new Error('Network failure');
                            error.name = 'NetworkError';
                            throw error;
                        },
                    }),
                };
            });

            const agent = createClaudeAgent({});

            // Kills mutant #5 & #6: non-AbortError should be caught by outer try-catch
            // and return null, not be treated as an AbortError
            const result = await agent.handleInput([mockMessageContext]);
            expect(result.response).toBeNull();
            expect(result.wasInterrupted).toBe(false); // Should NOT be marked as interrupted
        });

        test('should return wasInterrupted=true for outer catch when abort signal is set', async () => {
            const abortController = new AbortController();
            querySpy.mockImplementation((_params: any): any => {
                // Use a regular async iterable that throws, not a generator
                return {
                    [Symbol.asyncIterator]: () => ({
                        next: async () => {
                            // Abort the signal before throwing
                            abortController.abort();
                            const error = new Error('Connection timeout');
                            error.name = 'TimeoutError';
                            throw error;
                        },
                    }),
                };
            });

            const agent = createClaudeAgent({});

            // When abort signal is set, even non-AbortError should mark wasInterrupted=true
            const result = await agent.handleInput([mockMessageContext], { abortController });
            expect(result.response).toBeNull();
            expect(result.wasInterrupted).toBe(true);
        });

        test('should log abort error with correct structure', async () => {
            // Clear mock before test to avoid interference from other tests
            mockLogger.info.mockClear();

            const abortController = new AbortController();
            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:       'system' as const,
                        subtype:    'init' as const,
                        session_id: 'test-session-abort',
                    };
                    abortController.abort();
                    const error = new Error('This operation was aborted');
                    error.name = 'AbortError';
                    throw error;
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            await agent.handleInput([mockMessageContext], { abortController });

            // Kills mutant #7: verify log structure on abort error
            const logCalls = mockLogger.info.mock.calls;
            const abortLog = _.find(logCalls, (call: unknown[]) => (call[0] as { msg?: string })?.msg?.includes('interrupted by abort')) as unknown[] | undefined;
            expect(abortLog).toBeDefined();
            const abortLogData = abortLog![0] as { sessionId?: string, msg?: string };
            // Verify log has sessionId property (even if undefined)
            expect(abortLogData).toHaveProperty('sessionId');
            expect(abortLogData).toHaveProperty('msg');
            // The actual sessionId should be captured
            expect(abortLogData.sessionId).toBe('test-session-abort');
        });

        test('should catch AbortError even without an abort controller', async () => {
            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:       'system' as const,
                        subtype:    'init' as const,
                        session_id: 'test-session-abort-no-controller',
                    };
                    const error = new Error('This operation was aborted');
                    error.name = 'AbortError';
                    throw error;
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});

            // AbortError without an abortController should still be caught
            // Kills mutants 412 & 416: verifies the first branch of the || condition
            const result = await agent.handleInput([mockMessageContext]);
            expect(result.wasInterrupted).toBe(true);
            expect(result.response).toBeNull();
        });

        test('should log batch start with messageIds property', async () => {
            // Clear mock before test
            mockLogger.info.mockClear();

            const message1 = { ...mockMessageContext, messageId: 'msg_1' };
            const message2 = { ...mockMessageContext, messageId: 'msg_2' };

            const agent = createClaudeAgent({});
            await agent.handleInput([message1, message2]);

            // Kills mutant #8: verify log includes 'messageIds' property
            const logCalls = mockLogger.info.mock.calls;
            const startLog = _.find(logCalls, (call: unknown[]) => (call[0] as { msg?: string })?.msg?.includes('starting batch processing')) as unknown[] | undefined;
            expect(startLog).toBeDefined();
            const startLogData = startLog![0] as { messageIds?: string[], msg?: string };
            expect(startLogData).toHaveProperty('messageIds');
            expect(startLogData.messageIds).toEqual(['msg_1', 'msg_2']);
        });

        test('should log batch start with correct structure', async () => {
            const agent = createClaudeAgent({});
            await agent.handleInput([mockMessageContext]);

            // Kills mutant #9: verify log object is not empty
            const logCalls = mockLogger.info.mock.calls;
            const startLog = _.find(logCalls, (call: unknown[]) => (call[0] as { msg?: string })?.msg?.includes('starting batch processing')) as unknown[] | undefined;
            expect(startLog).toBeDefined();
            const startLogData = startLog![0] as Record<string, unknown>;
            expect(startLogData).toHaveProperty('contextCount');
            expect(startLogData).toHaveProperty('messageIds');
            expect(startLogData).toHaveProperty('msg');
            expect(_.keys(startLogData).length).toBeGreaterThan(0);
        });

        test('should log batch start with specific message', async () => {
            const agent = createClaudeAgent({});
            await agent.handleInput([mockMessageContext]);

            // Kills mutant #10: verify specific log message
            const logCalls = mockLogger.info.mock.calls;
            const startLog = _.find(logCalls, (call: unknown[]) => (call[0] as { msg?: string })?.msg === 'Agent starting batch processing');
            expect(startLog).toBeDefined();
            const startLogData = startLog![0] as { msg: string };
            expect(startLogData.msg).toBe('Agent starting batch processing');
            expect(startLogData.msg).not.toBe('');
        });

        test('should pass plugins when array is non-empty', async () => {
            const mockPlugins = [{ type: 'local' as const, name: 'test-plugin', path: '/path/to/plugin' }];
            const agent = createClaudeAgent({ plugins: mockPlugins });
            await agent.handleInput([mockMessageContext]);

            // Kills mutant #11: verify plugins are passed when present
            expect(querySpy).toHaveBeenCalledTimes(1);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const queryParams = querySpy.mock.calls[0][0];
            expect(queryParams.options.plugins).toEqual(mockPlugins);
            expect(queryParams.options.plugins).not.toBeUndefined();
        });

        test('should format multiple messages correctly', async () => {
            const agent = createClaudeAgent({});
            const message1 = { ...mockMessageContext, messageId: 'msg_1', content: 'First message', timestamp: '2025-01-15T12:00:00Z' };
            const message2 = { ...mockMessageContext, messageId: 'msg_2', content: 'Second message', timestamp: '2025-01-15T12:01:00Z' };

            await agent.handleInput([message1, message2]);

            expect(querySpy).toHaveBeenCalledTimes(1);
            const prompt = querySpy.mock.calls[0][0].prompt as string;

            // Should format as multiple messages
            expect(prompt).toContain('User @111222333 in #987654321');
            expect(prompt).toContain('First message');
            expect(prompt).toContain('Second message');
        });

        test('should use resume prompt when resumeContext provided', async () => {
            const agent = createClaudeAgent({});
            const resumeContext = {
                partialWork: {
                    thinking:       'I was thinking...',
                    text:           'I was writing...',
                    pendingToolUse: null,
                    sessionId:      undefined,
                },
                newEvents:   ['Event 1', 'Event 2'],
                newMessages: [mockMessageContext],
            };

            await agent.handleInput([mockMessageContext], { resumeContext });

            expect(querySpy).toHaveBeenCalledTimes(1);
            const prompt = querySpy.mock.calls[0][0].prompt as string;

            // Should use resume prompt format
            expect(prompt).toContain('[CONTEXT UPDATE]');
            expect(prompt).toContain('[Your thinking at the point of interruption:]');
            expect(prompt).toContain('I was thinking...');
        });

        test('should return wasInterrupted=true when aborted', async () => {
            const abortController = new AbortController();
            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:    'assistant' as const,
                        message: {
                            content: [{ type: 'text' as const, text: 'Partial response' }],
                        },
                    };
                    // Simulate the SDK behavior: abort the controller and throw an AbortError
                    abortController.abort();
                    const error = new Error('This operation was aborted');
                    error.name = 'AbortError';
                    throw error;
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            const result = await agent.handleInput([mockMessageContext], { abortController });

            expect(result.wasInterrupted).toBe(true);
            expect(result.response).toBeNull();
        });

        test('should return wasInterrupted=true for non-AbortError when abort signal is set', async () => {
            // Clear mocks before test to avoid interference from other tests
            mockLogger.info.mockClear();
            mockLogger.warn.mockClear();

            const abortController = new AbortController();
            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:       'system' as const,
                        subtype:    'init' as const,
                        session_id: 'test-session-non-abort',
                    };
                    // SDK throws a non-AbortError but abort signal is set
                    abortController.abort();
                    const error = new Error('Connection closed');
                    error.name = 'ConnectionError';
                    throw error;
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            const result = await agent.handleInput([mockMessageContext], { abortController });

            expect(result.wasInterrupted).toBe(true);
            expect(result.response).toBeNull();

            // Verify warn is used for non-AbortError (not info)
            const warnCalls = mockLogger.warn.mock.calls;
            const abortLog = _.find(warnCalls, (call: unknown[]) => (call[0] as { msg?: string })?.msg?.includes('interrupted by abort')) as unknown[] | undefined;
            expect(abortLog).toBeDefined();

            // Verify info was NOT used for this case
            const infoCalls = mockLogger.info.mock.calls;
            const infoAbortLog = _.find(infoCalls, (call: unknown[]) => (call[0] as { msg?: string })?.msg?.includes('interrupted by abort')) as unknown[] | undefined;
            expect(infoAbortLog).toBeUndefined();
        });

        test('should return streamTracker with captured progress', async () => {
            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:    'assistant' as const,
                        message: {
                            content: [
                                { type: 'thinking' as const, text: 'Thinking content' },
                                { type: 'text' as const, text: 'Response text' },
                            ],
                        },
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            const result = await agent.handleInput([mockMessageContext]);

            expect(result.streamTracker).toBeDefined();
            const progress = result.streamTracker.getProgress();
            expect(progress.thinking).toBe('Thinking content');
            expect(progress.text).toBe('Response text');
        });

        test('should pass sessionId to SDK for resume', async () => {
            const agent = createClaudeAgent({});
            await agent.handleInput([mockMessageContext], { sessionId: 'test-session-id' });

            expect(querySpy).toHaveBeenCalledTimes(1);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const queryParams = querySpy.mock.calls[0][0];
            expect(queryParams.options.resume).toBe('test-session-id');
        });

        test('should call onStreamEvent callback', async () => {
            let callbackInvoked = false;
            const onStreamEvent = (_event: any) => {
                callbackInvoked = true;
            };

            const agent = createClaudeAgent({});
            await agent.handleInput([mockMessageContext], { onStreamEvent });

            expect(callbackInvoked).toBe(true);
        });

        test('should not cleanup session on interrupt', async () => {
            const abortController = new AbortController();
            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:       'system' as const,
                        subtype:    'init' as const,
                        session_id: 'test-session',
                    };
                    // Simulate the SDK behavior: abort the controller and throw an AbortError
                    abortController.abort();
                    const error = new Error('This operation was aborted');
                    error.name = 'AbortError';
                    throw error;
                }
                return mockGenerator();
            });

            // Spy on cleanupSession (it's a fire-and-forget call)
            const cleanupSessionModule = await import('../../../src/agent/session-cleanup');
            const cleanupSpy = spyOn(cleanupSessionModule, 'cleanupSession');

            const agent = createClaudeAgent({});
            await agent.handleInput([mockMessageContext], { abortController });

            // Session cleanup should NOT be called on interrupt
            expect(cleanupSpy).not.toHaveBeenCalled();

            cleanupSpy.mockRestore();
        });

        test('should cleanup session on completion', async () => {
            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:       'system' as const,
                        subtype:    'init' as const,
                        session_id: 'test-session',
                    };
                    yield {
                        type:    'assistant' as const,
                        message: {
                            content: [{ type: 'text' as const, text: 'Done' }],
                        },
                    };
                }
                return mockGenerator();
            });

            // Spy on cleanupSession (it's a fire-and-forget call)
            const cleanupSessionModule = await import('../../../src/agent/session-cleanup');
            const cleanupSpy = spyOn(cleanupSessionModule, 'cleanupSession');

            const agent = createClaudeAgent({});
            await agent.handleInput([mockMessageContext]);

            // Session cleanup should be called on completion
            // Use a small delay to allow fire-and-forget to trigger
            await new Promise(resolve => setTimeout(resolve, 10));
            expect(cleanupSpy).toHaveBeenCalledWith('test-session');

            cleanupSpy.mockRestore();
        });

        test('should detect abort signal mid-stream (Mutant #303)', async () => {
            const abortController = new AbortController();
            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:       'system' as const,
                        subtype:    'init' as const,
                        session_id: 'test-session-interrupt',
                    };
                    yield {
                        type:    'assistant' as const,
                        message: {
                            content: [{ type: 'text' as const, text: 'First message' }],
                        },
                    };
                    // Abort mid-stream
                    abortController.abort();
                    // Add a small delay to simulate async processing
                    await new Promise(resolve => setTimeout(resolve, 5));
                    yield {
                        type:    'assistant' as const,
                        message: {
                            content: [{ type: 'text' as const, text: 'Second message that should not be processed' }],
                        },
                    };
                }
                return mockGenerator();
            });

            // Clear mock before test
            mockLogger.info.mockClear();

            const agent = createClaudeAgent({});
            const result = await agent.handleInput([mockMessageContext], { abortController });

            // Kills mutant #303: abort signal check (line 634)
            expect(result.wasInterrupted).toBe(true);
            expect(result.response).toBeNull(); // No response when interrupted mid-stream
            const logCalls = mockLogger.info.mock.calls;
            const abortLog = _.find(logCalls, (call: unknown[]) => (call[0] as { msg?: string })?.msg?.includes('interrupted by abort signal')) as unknown[] | undefined;
            expect(abortLog).toBeDefined();
        });

        test('should return null when only empty text is yielded (Mutant #310)', async () => {
            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:    'assistant' as const,
                        message: {
                            content: [
                                { type: 'text' as const, text: '' }, // ONLY empty text, no valid text after
                            ],
                        },
                    };
                    // Stream ends here - no more messages
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            const result = await agent.handleInput([mockMessageContext]);

            // Kills mutant #310: empty text check (line 644)
            // If the mutant changes "if(text)" to "if(true)", empty string would be assigned
            expect(result.response).toBeNull();
            expect(result.response).not.toBe('');
        });

        test('should re-throw non-AbortError exceptions (Mutant #324)', async () => {
            // Clear mock before test
            mockLogger.error.mockClear();

            querySpy.mockImplementation((_params: any): any => {
                return {
                    [Symbol.asyncIterator]: () => ({
                        next: async () => {
                            const error = new Error('Database connection failed');
                            error.name = 'DatabaseError';
                            throw error;
                        },
                    }),
                };
            });

            const agent = createClaudeAgent({});

            // Kills mutant #324: re-throw non-AbortError (lines 656-659)
            // The error is re-thrown to the outer try-catch in handleInput, which logs it
            // If the mutant removes "throw error", the error would be silently swallowed
            const result = await agent.handleInput([mockMessageContext]);

            // Error should be logged by outer try-catch
            const errorLogCalls = mockLogger.error.mock.calls;
            const errorLog = _.find(errorLogCalls, (call: unknown[]) => {
                const logData = call[0] as { error?: Error };
                return logData?.error?.message === 'Database connection failed';
            });
            expect(errorLog).toBeDefined();

            // Result should be null
            expect(result.response).toBeNull();
            expect(result.wasInterrupted).toBe(false);
        });

        test('should pass undefined plugins when array is empty (Mutant #337)', async () => {
            const agent = createClaudeAgent({ plugins: [] });
            await agent.handleInput([mockMessageContext]);

            // Kills mutant #337: plugins conditional - empty array check (line 708)
            expect(querySpy).toHaveBeenCalledTimes(1);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const queryParams = querySpy.mock.calls[0][0];
            expect(queryParams.options.plugins).toBeUndefined();
            expect(queryParams.options.plugins).not.toEqual([]);
        });

        test('should pass undefined plugins when plugins is null-like (Mutant #340)', async () => {
            // Test the "plugins &&" part of the conditional
            const agent = createClaudeAgent({ plugins: undefined });
            await agent.handleInput([mockMessageContext]);

            // Kills mutant #340: plugins && check (line 708)
            expect(querySpy).toHaveBeenCalledTimes(1);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const queryParams = querySpy.mock.calls[0][0];
            expect(queryParams.options.plugins).toBeUndefined();
        });

        test('should verify both plugins conditions are checked (Mutant #341)', async () => {
            // Test with plugins = [] to ensure length check matters
            const agent = createClaudeAgent({ plugins: [] });
            await agent.handleInput([mockMessageContext]);

            // Kills mutant #341: plugins.length > 0 check (line 708)
            expect(querySpy).toHaveBeenCalledTimes(1);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const queryParams = querySpy.mock.calls[0][0];
            // Empty array should result in undefined, not the array itself
            expect(queryParams.options.plugins).toBeUndefined();

            // Also verify non-empty array passes through
            querySpy.mockClear();
            const mockPlugins = [{ type: 'local' as const, name: 'test', path: '/test' }];
            const agent2 = createClaudeAgent({ plugins: mockPlugins });
            await agent2.handleInput([mockMessageContext]);

            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test mock access pattern
            const queryParams2 = querySpy.mock.calls[0][0];
            expect(queryParams2.options.plugins).toEqual(mockPlugins);
        });

        test('should use catchUpPrompt when provided with empty contexts', async () => {
            const agent = createClaudeAgent({});
            const catchUpPrompt = 'You have 5 unread messages across 2 channels. Use the inbox tools to review them.';

            await agent.handleInput([], {
                catchUpPrompt,
                specialMode: 'catchup',
            });

            expect(querySpy).toHaveBeenCalledTimes(1);
            const prompt = querySpy.mock.calls[0][0].prompt as string;

            // Should use the catchUpPrompt, not try to build from contexts
            expect(prompt).toBe(catchUpPrompt);
        });

        test('should handle catch-up mode without crashing on empty contexts', async () => {
            const agent = createClaudeAgent({});
            const catchUpPrompt = 'Catch up on unread messages.';

            // This should not crash even with empty contexts array
            const result = await agent.handleInput([], {
                catchUpPrompt,
                specialMode: 'catchup',
            });

            expect(result.response).toBe('Hello! This is a test response.');
            expect(result.wasInterrupted).toBe(false);
        });

        test('should call taskPersistenceCoordinator when session ID extracted', async () => {
            let prepareNewSessionCalled = false;
            const mockTaskPersistenceCoordinator = {
                prepareNewSession: async (_sessionId: string): Promise<boolean> => {
                    prepareNewSessionCalled = true;
                    return true;
                },
            };

            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:       'system' as const,
                        subtype:    'init' as const,
                        session_id: 'task-session-id',
                    };
                    yield {
                        type:    'assistant' as const,
                        message: {
                            content: [{ type: 'text' as const, text: 'Response with tasks' }],
                        },
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({ taskPersistenceCoordinator: mockTaskPersistenceCoordinator });
            await agent.handleInput([mockMessageContext]);

            // Verify task persistence was called
            expect(prepareNewSessionCalled).toBe(true);
        });

        test('should handle task persistence errors gracefully', async () => {
            // Clear mock before test
            mockLogger.warn.mockClear();

            const mockTaskPersistenceCoordinator = {
                prepareNewSession: async (_sessionId: string): Promise<boolean> => {
                    throw new Error('Task persistence failed');
                },
            };

            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:       'system' as const,
                        subtype:    'init' as const,
                        session_id: 'task-session-id',
                    };
                    yield {
                        type:    'assistant' as const,
                        message: {
                            content: [{ type: 'text' as const, text: 'Response despite task error' }],
                        },
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({ taskPersistenceCoordinator: mockTaskPersistenceCoordinator });
            const result = await agent.handleInput([mockMessageContext]);

            // Should complete successfully despite task persistence error
            expect(result.response).toBe('Response despite task error');
            expect(result.wasInterrupted).toBe(false);

            // Verify error was logged
            const logCalls = mockLogger.warn.mock.calls;
            const taskErrorLog = _.find(logCalls, (call: unknown[]) => {
                const logData = call[0] as { error?: Error };
                return logData?.error?.message === 'Task persistence failed';
            });
            expect(taskErrorLog).toBeDefined();
        });

        test('should use perchPrompt when provided in perching mode', async () => {
            const agent = createClaudeAgent({});
            const perchPrompt = 'Autonomous perch time: review your memories and plan improvements.';

            await agent.handleInput([], {
                perchPrompt,
                specialMode: 'perching',
            });

            expect(querySpy).toHaveBeenCalledTimes(1);
            const prompt = querySpy.mock.calls[0][0].prompt as string;

            // Should use the perchPrompt
            expect(prompt).toBe(perchPrompt);
        });
    });

    describe('logUserEvent and logAssistantEvent', () => {
        beforeEach(async () => {
            mockLogger.debug.mockClear();
            // Import and use the resetLogStreamState function
            const { resetLogStreamState } = await import('../../../src/agent/agent');
            resetLogStreamState();
        });

        test('should log user event as message send when no pending tools', async () => {
            mockLogger.debug.mockClear();

            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:    'user' as const,
                        message: { role: 'user', content: 'Hello' },
                    };
                    yield {
                        type:    'assistant' as const,
                        message: {
                            content: [{ type: 'text' as const, text: 'Response' }],
                        },
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            await agent.handleInput([mockMessageContext]);

            // Find the user event log
            const logCalls = mockLogger.debug.mock.calls;
            const userLog = _.find(logCalls, (call: unknown[]) => {
                const logData = call[0] as { eventType?: string, msg?: string };
                return logData?.eventType === 'user';
            });

            expect(userLog).toBeDefined();
            const userLogData = userLog![0] as { eventType: string, msg: string };
            expect(userLogData.msg).toBe('Sending message to Claude LLM');
        });

        test('should log user event as tool_response when tools pending', async () => {
            mockLogger.debug.mockClear();

            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    // Assistant requests tool
                    yield {
                        type:    'assistant' as const,
                        message: {
                            content: [
                                {
                                    type:  'tool_use' as const,
                                    id:    'tool_123',
                                    name:  'Read',
                                    input: { file: 'test.txt' },
                                },
                            ],
                        },
                    };
                    // User event (tool response)
                    yield {
                        type:    'user' as const,
                        message: { role: 'user', content: 'Tool result' },
                    };
                    yield {
                        type:    'assistant' as const,
                        message: {
                            content: [{ type: 'text' as const, text: 'Final response' }],
                        },
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            await agent.handleInput([mockMessageContext]);

            // Find the tool_response log
            const logCalls = mockLogger.debug.mock.calls;
            const toolResponseLog = _.find(logCalls, (call: unknown[]) => {
                const logData = call[0] as { eventType?: string, toolName?: string };
                return logData?.eventType === 'tool_response';
            });

            expect(toolResponseLog).toBeDefined();
            const toolResponseLogData = toolResponseLog![0] as { eventType: string, toolName: string, msg: string };
            expect(toolResponseLogData.toolName).toBe('Read');
            expect(toolResponseLogData.msg).toBe('Tool result for LLM: Read');
        });

        test('should log assistant event with tool request', async () => {
            mockLogger.debug.mockClear();

            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:    'assistant' as const,
                        message: {
                            content: [
                                {
                                    type:  'tool_use' as const,
                                    id:    'tool_456',
                                    name:  'Grep',
                                    input: { pattern: 'test' },
                                },
                            ],
                        },
                    };
                    yield {
                        type:    'user' as const,
                        message: { role: 'user', content: 'Tool result' },
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            await agent.handleInput([mockMessageContext]);

            // Find the tool_request log
            const logCalls = mockLogger.debug.mock.calls;
            const toolRequestLog = _.find(logCalls, (call: unknown[]) => {
                const logData = call[0] as { eventType?: string, toolName?: string };
                return logData?.eventType === 'tool_request' && logData?.toolName === 'Grep';
            });

            expect(toolRequestLog).toBeDefined();
            const toolRequestLogData = toolRequestLog![0] as { eventType: string, toolName: string, msg: string };
            expect(toolRequestLogData.msg).toBe('LLM requesting tool: Grep');
        });

        test('should log assistant event without tool as thinking when no text', async () => {
            mockLogger.debug.mockClear();

            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:    'assistant' as const,
                        message: {
                            content: [
                                { type: 'thinking' as const, text: 'Let me think...' },
                            ],
                        },
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            await agent.handleInput([mockMessageContext]);

            // Find the assistant thinking log
            const logCalls = mockLogger.debug.mock.calls;
            const thinkingLog = _.find(logCalls, (call: unknown[]) => {
                const logData = call[0] as { eventType?: string, hasText?: boolean };
                return logData?.eventType === 'assistant' && logData?.hasText === false;
            });

            expect(thinkingLog).toBeDefined();
            const thinkingLogData = thinkingLog![0] as { eventType: string, hasText: boolean, msg: string };
            expect(thinkingLogData.msg).toBe('Claude LLM thinking');
        });

        test('should log assistant event without tool as responding when has text', async () => {
            mockLogger.debug.mockClear();

            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:    'assistant' as const,
                        message: {
                            content: [
                                { type: 'text' as const, text: 'Here is my response' },
                            ],
                        },
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            await agent.handleInput([mockMessageContext]);

            // Find the assistant responding log
            const logCalls = mockLogger.debug.mock.calls;
            const respondingLog = _.find(logCalls, (call: unknown[]) => {
                const logData = call[0] as { eventType?: string, hasText?: boolean };
                return logData?.eventType === 'assistant' && logData?.hasText === true;
            });

            expect(respondingLog).toBeDefined();
            const respondingLogData = respondingLog![0] as { eventType: string, hasText: boolean, msg: string };
            expect(respondingLogData.msg).toBe('Claude LLM responding');
        });

        test('should track multiple pending tools and log all on next user event', async () => {
            mockLogger.debug.mockClear();

            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    // Assistant requests multiple tools
                    yield {
                        type:    'assistant' as const,
                        message: {
                            content: [
                                {
                                    type:  'tool_use' as const,
                                    id:    'tool_1',
                                    name:  'Read',
                                    input: { file: 'file1.txt' },
                                },
                                {
                                    type:  'tool_use' as const,
                                    id:    'tool_2',
                                    name:  'Grep',
                                    input: { pattern: 'test' },
                                },
                            ],
                        },
                    };
                    // User event (tool results)
                    yield {
                        type:    'user' as const,
                        message: { role: 'user', content: 'Tool results' },
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            await agent.handleInput([mockMessageContext]);

            // Find all tool_response logs
            const logCalls = mockLogger.debug.mock.calls;
            const toolResponseLogs = _.filter(logCalls, (call: unknown[]) => {
                const logData = call[0] as { eventType?: string };
                return logData?.eventType === 'tool_response';
            });

            // Should log 2 tool responses
            expect(toolResponseLogs).toHaveLength(2);

            const toolNames = _.map(toolResponseLogs, (log: unknown[]) => {
                const logData = log[0] as { toolName?: string };
                return logData?.toolName;
            });
            expect(toolNames).toContain('Read');
            expect(toolNames).toContain('Grep');
        });

        test('should clear pending tools after logging tool responses', async () => {
            mockLogger.debug.mockClear();

            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    // Assistant requests tool
                    yield {
                        type:    'assistant' as const,
                        message: {
                            content: [
                                {
                                    type:  'tool_use' as const,
                                    id:    'tool_1',
                                    name:  'Read',
                                    input: { file: 'test.txt' },
                                },
                            ],
                        },
                    };
                    // User event (tool response)
                    yield {
                        type:    'user' as const,
                        message: { role: 'user', content: 'Tool result 1' },
                    };
                    // Another user event (should log as message send, not tool response)
                    yield {
                        type:    'user' as const,
                        message: { role: 'user', content: 'Regular message' },
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            await agent.handleInput([mockMessageContext]);

            // Find all user event logs
            const logCalls = mockLogger.debug.mock.calls;
            const userLogs = _.filter(logCalls, (call: unknown[]) => {
                const logData = call[0] as { eventType?: string };
                return logData?.eventType === 'user';
            });

            // Second user event should log as 'user' (message send), not 'tool_response'
            expect(userLogs).toHaveLength(1);
            const secondUserLogData = userLogs[0][0] as { msg: string };
            expect(secondUserLogData.msg).toBe('Sending message to Claude LLM');
        });

        test('should log system event for compaction boundary with token info', async () => {
            mockLogger.info.mockClear();

            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:             'system' as const,
                        subtype:          'compact_boundary' as const,
                        compact_metadata: {
                            pre_tokens: 150000,
                            trigger:    'threshold',
                        },
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            await agent.handleInput([mockMessageContext]);

            // Find the compaction log
            const logCalls = mockLogger.info.mock.calls;
            const compactionLog = _.find(logCalls, (call: unknown[]) => {
                const logData = call[0] as { eventType?: string };
                return logData?.eventType === 'compaction';
            });

            expect(compactionLog).toBeDefined();
            const compactionLogData = compactionLog![0] as { eventType: string, trigger: string, preTokens: number, msg: string };
            expect(compactionLogData.trigger).toBe('threshold');
            expect(compactionLogData.preTokens).toBe(150000);
            expect(compactionLogData.msg).toContain('Context compaction completed');
            expect(compactionLogData.msg).toContain('150,000 tokens');
        });

        test('should log system event for compaction boundary without token info when undefined', async () => {
            mockLogger.info.mockClear();

            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:             'system' as const,
                        subtype:          'compact_boundary' as const,
                        compact_metadata: {
                            trigger: 'manual',
                        },
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            await agent.handleInput([mockMessageContext]);

            // Find the compaction log
            const logCalls = mockLogger.info.mock.calls;
            const compactionLog = _.find(logCalls, (call: unknown[]) => {
                const logData = call[0] as { eventType?: string };
                return logData?.eventType === 'compaction';
            });

            expect(compactionLog).toBeDefined();
            const compactionLogData = compactionLog![0] as { eventType: string, trigger: string, preTokens: undefined, msg: string };
            expect(compactionLogData.trigger).toBe('manual');
            expect(compactionLogData.preTokens).toBeUndefined();
            expect(compactionLogData.msg).toBe('Context compaction completed');
        });
    });

    describe('logToolProgressEvent and logToolResultEvent', () => {
        beforeEach(() => {
            mockLogger.debug.mockClear();
        });

        test('should log tool_progress event with correct eventType', async () => {
            mockLogger.debug.mockClear();

            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:      'tool_progress' as const,
                        tool_name: 'mcp__memory__view',
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            await agent.handleInput([mockMessageContext]);

            // Find the tool_progress log (kills mutant #2: StringLiteral on line 565)
            const logCalls = mockLogger.debug.mock.calls;
            const progressLog = _.find(logCalls, (call: unknown[]) => {
                const logData = call[0] as { eventType?: string };
                return logData?.eventType === 'tool_progress';
            });

            expect(progressLog).toBeDefined();
            const progressLogData = progressLog![0] as { eventType: string, module: string, tool: string, msg: string };
            expect(progressLogData.eventType).toBe('tool_progress');
            expect(progressLogData.eventType).not.toBe('');
            expect(progressLogData.module).toBe('memory');
            expect(progressLogData.tool).toBe('view');
        });

        test('should log tool_progress with specific message', async () => {
            mockLogger.debug.mockClear();

            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:      'tool_progress' as const,
                        tool_name: 'mcp__discord__search',
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            await agent.handleInput([mockMessageContext]);

            // Find the tool_progress log (kills mutant #5: StringLiteral on line 568)
            const logCalls = mockLogger.debug.mock.calls;
            const progressLog = _.find(logCalls, (call: unknown[]) => {
                const logData = call[0] as { eventType?: string };
                return logData?.eventType === 'tool_progress';
            });

            expect(progressLog).toBeDefined();
            const progressLogData = progressLog![0] as { msg: string };
            expect(progressLogData.msg).toBe('Tool execution started');
            expect(progressLogData.msg).not.toBe('');
        });

        test('should execute logToolProgressEvent function body', async () => {
            mockLogger.debug.mockClear();

            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:      'tool_progress' as const,
                        tool_name: 'Read',
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            await agent.handleInput([mockMessageContext]);

            // Kills mutant #3: BlockStatement on line 562 - function body must execute
            const logCalls = mockLogger.debug.mock.calls;
            const progressLog = _.find(logCalls, (call: unknown[]) => {
                const logData = call[0] as { eventType?: string };
                return logData?.eventType === 'tool_progress';
            });

            expect(progressLog).toBeDefined();
        });

        test('should log tool_result event with correct structure', async () => {
            mockLogger.debug.mockClear();

            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:      'tool_result' as const,
                        tool_name: 'mcp__memory__store',
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            await agent.handleInput([mockMessageContext]);

            // Kills mutant #6: ObjectLiteral on line 578 - log object must not be empty
            const logCalls = mockLogger.debug.mock.calls;
            const resultLog = _.find(logCalls, (call: unknown[]) => {
                const logData = call[0] as { eventType?: string };
                return logData?.eventType === 'tool_result';
            });

            expect(resultLog).toBeDefined();
            const resultLogData = resultLog![0] as { eventType: string, module: string, tool: string, msg: string };
            expect(resultLogData).toHaveProperty('eventType');
            expect(resultLogData).toHaveProperty('module');
            expect(resultLogData).toHaveProperty('tool');
            expect(resultLogData).toHaveProperty('msg');
            expect(_.keys(resultLogData).length).toBeGreaterThan(0);
            expect(resultLogData).not.toEqual({});
        });

        test('should log tool_result with specific message', async () => {
            mockLogger.debug.mockClear();

            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:      'tool_result' as const,
                        tool_name: 'Grep',
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            await agent.handleInput([mockMessageContext]);

            // Kills mutant #7: StringLiteral on line 582
            const logCalls = mockLogger.debug.mock.calls;
            const resultLog = _.find(logCalls, (call: unknown[]) => {
                const logData = call[0] as { eventType?: string };
                return logData?.eventType === 'tool_result';
            });

            expect(resultLog).toBeDefined();
            const resultLogData = resultLog![0] as { msg: string };
            expect(resultLogData.msg).toBe('Tool execution complete');
            expect(resultLogData.msg).not.toBe('');
        });

        test('should execute logToolResultEvent function body', async () => {
            mockLogger.debug.mockClear();

            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:      'tool_result' as const,
                        tool_name: 'Write',
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            await agent.handleInput([mockMessageContext]);

            // Kills mutant #4: BlockStatement on line 576 - function body must execute
            const logCalls = mockLogger.debug.mock.calls;
            const resultLog = _.find(logCalls, (call: unknown[]) => {
                const logData = call[0] as { eventType?: string };
                return logData?.eventType === 'tool_result';
            });

            expect(resultLog).toBeDefined();
        });
    });

    describe('logSystemEvent compaction with optional chaining', () => {
        beforeEach(() => {
            mockLogger.info.mockClear();
        });

        test('should not log when message type is not system', async () => {
            mockLogger.info.mockClear();

            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:    'assistant' as const,
                        message: { role: 'assistant', content: 'Hello' },
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            await agent.handleInput([mockMessageContext]);

            // Kills ConditionalExpression mutant on line 592: message.type === 'system'
            const logCalls = mockLogger.info.mock.calls;
            const compactionLog = _.find(logCalls, (call: unknown[]) => {
                const logData = call[0] as { eventType?: string };
                return logData?.eventType === 'compaction';
            });

            expect(compactionLog).toBeUndefined();
        });

        test('should not log when message has no subtype', async () => {
            mockLogger.info.mockClear();

            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type: 'system' as const,
                        // No subtype property
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            await agent.handleInput([mockMessageContext]);

            // Kills ConditionalExpression mutant on line 592: 'subtype' in message
            const logCalls = mockLogger.info.mock.calls;
            const compactionLog = _.find(logCalls, (call: unknown[]) => {
                const logData = call[0] as { eventType?: string };
                return logData?.eventType === 'compaction';
            });

            expect(compactionLog).toBeUndefined();
        });

        test('should not log when subtype is not compact_boundary', async () => {
            mockLogger.info.mockClear();

            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:       'system' as const,
                        subtype:    'init' as const,
                        session_id: 'test-session',
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            await agent.handleInput([mockMessageContext]);

            // Kills ConditionalExpression mutant on line 592: message.subtype === 'compact_boundary'
            const logCalls = mockLogger.info.mock.calls;
            const compactionLog = _.find(logCalls, (call: unknown[]) => {
                const logData = call[0] as { eventType?: string };
                return logData?.eventType === 'compaction';
            });

            expect(compactionLog).toBeUndefined();
        });

        test('should handle missing compact_metadata gracefully', async () => {
            mockLogger.info.mockClear();

            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:    'system' as const,
                        subtype: 'compact_boundary' as const,
                        // Missing compact_metadata entirely
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            await agent.handleInput([mockMessageContext]);

            // Kills mutants #10 & #11: OptionalChaining on lines 594 & 595
            // Should not crash and should log without token info
            const logCalls = mockLogger.info.mock.calls;
            const compactionLog = _.find(logCalls, (call: unknown[]) => {
                const logData = call[0] as { eventType?: string };
                return logData?.eventType === 'compaction';
            });

            expect(compactionLog).toBeDefined();
            const compactionLogData = compactionLog![0] as { preTokens: undefined, trigger: undefined, msg: string };
            expect(compactionLogData.preTokens).toBeUndefined();
            expect(compactionLogData.trigger).toBeUndefined();
            expect(compactionLogData.msg).toBe('Context compaction completed');
        });

        test('should include token info when pre_tokens is present', async () => {
            mockLogger.info.mockClear();

            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:             'system' as const,
                        subtype:          'compact_boundary' as const,
                        compact_metadata: {
                            pre_tokens: 100000,
                            trigger:    'threshold',
                        },
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            await agent.handleInput([mockMessageContext]);

            // Kills mutants #8 & #9: ConditionalExpression on line 592
            const logCalls = mockLogger.info.mock.calls;
            const compactionLog = _.find(logCalls, (call: unknown[]) => {
                const logData = call[0] as { eventType?: string };
                return logData?.eventType === 'compaction';
            });

            expect(compactionLog).toBeDefined();
            const compactionLogData = compactionLog![0] as { preTokens: number, msg: string };
            expect(compactionLogData.preTokens).toBe(100000);
            // Message should include the token info, not empty string
            expect(compactionLogData.msg).toContain('100,000 tokens');
            expect(compactionLogData.msg).not.toBe('Context compaction completed');
        });

        test('should omit token info when pre_tokens is undefined', async () => {
            mockLogger.info.mockClear();

            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:             'system' as const,
                        subtype:          'compact_boundary' as const,
                        compact_metadata: {
                            trigger: 'manual',
                            // pre_tokens is undefined
                        },
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            await agent.handleInput([mockMessageContext]);

            // Kills mutants #8 & #9: ConditionalExpression on line 592 (false branch)
            const logCalls = mockLogger.info.mock.calls;
            const compactionLog = _.find(logCalls, (call: unknown[]) => {
                const logData = call[0] as { eventType?: string };
                return logData?.eventType === 'compaction';
            });

            expect(compactionLog).toBeDefined();
            const compactionLogData = compactionLog![0] as { preTokens: undefined, msg: string };
            expect(compactionLogData.preTokens).toBeUndefined();
            // Message should NOT include token info (empty string ternary result)
            expect(compactionLogData.msg).toBe('Context compaction completed');
            expect(compactionLogData.msg).not.toContain('tokens');
        });
    });

    describe('task persistence error message', () => {
        test('should log task persistence failure with specific message', async () => {
            mockLogger.warn.mockClear();

            const mockTaskPersistenceCoordinator = {
                prepareNewSession: async (_sessionId: string): Promise<boolean> => {
                    throw new Error('DynamoDB connection timeout');
                },
            };

            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:       'system' as const,
                        subtype:    'init' as const,
                        session_id: 'test-session-error',
                    };
                    yield {
                        type:    'assistant' as const,
                        message: {
                            content: [{ type: 'text' as const, text: 'Response' }],
                        },
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({ taskPersistenceCoordinator: mockTaskPersistenceCoordinator });
            await agent.handleInput([mockMessageContext]);

            // Kills mutant #12: StringLiteral on line 754 - verify error message template
            const logCalls = mockLogger.warn.mock.calls;
            const errorLog = _.find(logCalls, (call: unknown[]) => {
                const logData = call[0] as { error?: Error };
                return logData?.error?.message === 'DynamoDB connection timeout';
            });

            expect(errorLog).toBeDefined();
            const errorLogData = errorLog![1] as string;
            expect(errorLogData).toBe('Task persistence failed: DynamoDB connection timeout');
            expect(errorLogData).not.toBe('');
            expect(errorLogData).toContain('Task persistence failed:');
            expect(errorLogData).toContain('DynamoDB connection timeout');
        });
    });

    describe('resetLogStreamState', () => {
        test('should start with empty pendingToolRequests', async () => {
            // Verify initial state by sending a user message with no prior tool requests
            const { resetLogStreamState } = await import('../../../src/agent/agent');
            resetLogStreamState();
            mockLogger.debug.mockClear();

            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:    'user' as const,
                        message: { role: 'user', content: 'Hello' },
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            await agent.handleInput([mockMessageContext]);

            // Kills ArrayDeclaration mutant on line 496: pendingToolRequests must start empty
            // User event should log as message send, not tool response
            const logCalls = mockLogger.debug.mock.calls;
            const userLog = _.find(logCalls, (call: unknown[]) => {
                const logData = call[0] as { eventType?: string };
                return logData?.eventType === 'user';
            });

            expect(userLog).toBeDefined();
            const userLogData = userLog![0] as { msg: string };
            expect(userLogData.msg).toBe('Sending message to Claude LLM');
            // Should NOT be logging as tool_response since no tools were pending
            const toolResponseLog = _.find(logCalls, (call: unknown[]) => {
                const logData = call[0] as { eventType?: string };
                return logData?.eventType === 'tool_response';
            });
            expect(toolResponseLog).toBeUndefined();
        });

        test('should reset pendingToolRequests to empty array', async () => {
            // First, populate pendingToolRequests by triggering a tool request
            mockLogger.debug.mockClear();

            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:    'assistant' as const,
                        message: {
                            content: [
                                {
                                    type:  'tool_use' as const,
                                    id:    'tool_1',
                                    name:  'Read',
                                    input: { file: 'test.txt' },
                                },
                            ],
                        },
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            await agent.handleInput([mockMessageContext]);

            // Now reset the state
            const { resetLogStreamState } = await import('../../../src/agent/agent');
            resetLogStreamState();

            // Clear logs and run another batch
            mockLogger.debug.mockClear();
            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:    'user' as const,
                        message: { role: 'user', content: 'Hello' },
                    };
                }
                return mockGenerator();
            });

            await agent.handleInput([mockMessageContext]);

            // Kills mutant #1: ArrayDeclaration on line 496
            // After reset, next user event should log as message send, not tool response
            const logCalls = mockLogger.debug.mock.calls;
            const userLog = _.find(logCalls, (call: unknown[]) => {
                const logData = call[0] as { eventType?: string };
                return logData?.eventType === 'user';
            });

            expect(userLog).toBeDefined();
            const userLogData = userLog![0] as { msg: string };
            expect(userLogData.msg).toBe('Sending message to Claude LLM');
            // Should NOT be logging as tool_response
            const toolResponseLog = _.find(logCalls, (call: unknown[]) => {
                const logData = call[0] as { eventType?: string };
                return logData?.eventType === 'tool_response';
            });
            expect(toolResponseLog).toBeUndefined();
        });
    });
});
