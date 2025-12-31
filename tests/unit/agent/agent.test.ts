/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- Test mocks require unsafe type operations */
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import _ from 'lodash';
import * as agentSdk from '@anthropic-ai/claude-agent-sdk';
import { createClaudeAgent, extractToolUses } from '../../../src/agent/agent';
import type { DiscordMessageContext } from '../../../src/integrations/discord/types';
import { createGuildId, createChannelId, createUserId } from '../../../src/integrations/discord/types';
import type { ContextBuilder } from '../../../src/agent/context-builder';

describe('extractToolUses', () => {
    it('should return empty array for non-assistant messages', () => {
        const message = { type: 'user', message: { content: [] } };
        expect(extractToolUses(message)).toEqual([]);
    });

    it('should return empty array for assistant messages with no content', () => {
        const message = { type: 'assistant', message: {} };
        expect(extractToolUses(message)).toEqual([]);
    });

    it('should return empty array for assistant messages with no tool_use blocks', () => {
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

    it('should extract single tool_use block correctly', () => {
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

    it('should extract multiple tool_use blocks', () => {
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

    it('should handle undefined content gracefully', () => {
        const message = { type: 'assistant', message: { content: undefined } };
        expect(extractToolUses(message)).toEqual([]);
    });

    it('should handle null content gracefully', () => {
        const message = { type: 'assistant', message: { content: null } };
        expect(extractToolUses(message)).toEqual([]);
    });

    it('should handle missing message property gracefully', () => {
        const message = { type: 'assistant' };
        expect(extractToolUses(message)).toEqual([]);
    });

    it('should handle undefined message property gracefully', () => {
        const message = { type: 'assistant', message: undefined };
        expect(extractToolUses(message)).toEqual([]);
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

    it('should create an agent with chat method', () => {
        const agent = createClaudeAgent({});

        expect(agent).toBeDefined();
        expect(typeof agent.chat).toBe('function');
    });

    it('should call query with user message', async () => {
        const agent = createClaudeAgent({});

        await agent.chat(mockMessageContext);

        expect(querySpy).toHaveBeenCalledWith(
            expect.objectContaining({
                prompt: 'User @111222333 in #987654321: Hello Claude!',
            })
        );
    });

    it('should use claude-sonnet-4-5 model', async () => {
        const agent = createClaudeAgent({});

        await agent.chat(mockMessageContext);

        expect(querySpy).toHaveBeenCalledWith(
            expect.objectContaining({
                options: expect.objectContaining({
                    model: 'claude-sonnet-4-5',
                }),
            })
        );
    });

    it('should return text content from Claude response', async () => {
        const agent = createClaudeAgent({});

        const response = await agent.chat(mockMessageContext);

        expect(response).toBe('Hello! This is a test response.');
    });

    it('should return full responses without truncating (chunking handled by Discord handlers)', async () => {
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

    it('should include memory MCP server when provided', async () => {
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

    it('should not include MCP servers when not provided', async () => {
        const agent = createClaudeAgent({});

        await agent.chat(mockMessageContext);

        const callArgs = querySpy.mock.calls[0][0];

        expect(callArgs.options.mcpServers).toBeUndefined();
    });

    it('should return null on API error', async () => {
        querySpy.mockImplementation((_params: any): any => {
            throw new Error('API rate limit exceeded');
        });

        const agent = createClaudeAgent({});
        const response = await agent.chat(mockMessageContext);

        expect(response).toBeNull();
    });

    it('should return null when response has no text content', async () => {
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

    it('should handle empty message content', async () => {
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

    it('should preserve whitespace in message content', async () => {
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

    it('should handle special characters in message content', async () => {
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

    it('should extract latest assistant message from stream', async () => {
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

    it('should not truncate responses exactly at MAX_RESPONSE_LENGTH (1900)', async () => {
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

    it('should return full response even when just over typical Discord limit', async () => {
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
        it('should include explicit tools list', async () => {
            const agent = createClaudeAgent({});

            await agent.chat(mockMessageContext);

            const callArgs = querySpy.mock.calls[0][0];
            expect(callArgs.options.tools).toEqual([
                'Read', 'Write', 'Edit', 'Glob', 'Grep',
                'WebFetch', 'WebSearch', 'Bash', 'Task',
                'TodoWrite', 'EnterPlanMode', 'ExitPlanMode',
            ]);
        });

        it('should include explicit agents without statusline-setup', async () => {
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

        it('should include allowedTools for auto-approved tools', async () => {
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
            ]);
        });

        it('should use acceptEdits permission mode without allowDangerouslySkipPermissions', async () => {
            const agent = createClaudeAgent({});

            await agent.chat(mockMessageContext);

            const callArgs = querySpy.mock.calls[0][0];
            expect(callArgs.options.permissionMode).toBe('acceptEdits');
            expect(callArgs.options.allowDangerouslySkipPermissions).toBeUndefined();
        });

        it('should provide stderr callback in options', async () => {
            const agent = createClaudeAgent({});

            await agent.chat(mockMessageContext);

            const callArgs = querySpy.mock.calls[0][0];
            expect(typeof callArgs.options.stderr).toBe('function');
        });

        it('should include memory MCP server when provided', async () => {
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

        it('should not include mcpServers when no MCP server provided', async () => {
            const agent = createClaudeAgent({});

            await agent.chat(mockMessageContext);

            const callArgs = querySpy.mock.calls[0][0];
            expect(callArgs.options.mcpServers).toBeUndefined();
        });

        it('should include discord MCP server when provided', async () => {
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

        it('should NOT include memory MCP server when only discord MCP server provided', async () => {
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

        it('should NOT include discord MCP server when only memory MCP server provided', async () => {
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

        it('should include both memory and discord MCP servers when both provided', async () => {
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

        it('should include Discord MCP tools in allowedTools when discord MCP server provided', async () => {
            const mockDiscordMcpServer = { name: 'discord', version: '1.0.0' };

            const agent = createClaudeAgent({
                discordMcpServer: mockDiscordMcpServer as any,
            });

            await agent.chat(mockMessageContext);

            const callArgs = querySpy.mock.calls[0][0];
            expect(callArgs.options.allowedTools).toContain('mcp__discord__*');
        });
    });
});
