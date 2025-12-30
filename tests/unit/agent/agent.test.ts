/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- Test mocks require unsafe type operations */
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import _ from 'lodash';
import * as agentSdk from '@anthropic-ai/claude-agent-sdk';
import { logger } from '@hughescr/logger';
import { createClaudeAgent, extractToolUses } from '../../../src/agent/agent';
import type { DiscordMessageContext } from '../../../src/integrations/discord/types';
import { createGuildId, createChannelId, createUserId } from '../../../src/integrations/discord/types';
import type { ContextBuilder } from '../../../src/agent/context-builder';
import * as timeUtils from '../../../src/utils/time';

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
    let mockContextBuilder: ContextBuilder;
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
        mockContextBuilder = {
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

    describe('context builder integration', () => {
        it('should load core identity when contextBuilder provided', async () => {
            (mockContextBuilder.loadCoreIdentity as ReturnType<typeof mock>).mockResolvedValue('I am Isambard, a helpful AI assistant.');

            const agent = createClaudeAgent({
                contextBuilder: mockContextBuilder,
            });

            await agent.chat(mockMessageContext);

            expect(mockContextBuilder.loadCoreIdentity).toHaveBeenCalled();
            expect(querySpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    options: expect.objectContaining({
                        systemPrompt: expect.stringContaining('I am Isambard, a helpful AI assistant.'),
                    }),
                })
            );
        });

        it('should load recent context when contextBuilder provided', async () => {
            (mockContextBuilder.loadRecentContext as ReturnType<typeof mock>).mockResolvedValue([
                'User likes coffee',
                'User is working on TypeScript',
            ]);

            const agent = createClaudeAgent({
                contextBuilder: mockContextBuilder,
            });

            await agent.chat(mockMessageContext);

            expect(mockContextBuilder.loadRecentContext).toHaveBeenCalledWith('111222333', 3);
            expect(querySpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    prompt: expect.stringContaining('User likes coffee'),
                })
            );
        });

        it('should not call contextBuilder when not provided', async () => {
            const agent = createClaudeAgent({});

            await agent.chat(mockMessageContext);

            expect(mockContextBuilder.loadCoreIdentity).not.toHaveBeenCalled();
            expect(mockContextBuilder.loadRecentContext).not.toHaveBeenCalled();
        });

        it('should handle empty core identity', async () => {
            (mockContextBuilder.loadCoreIdentity as ReturnType<typeof mock>).mockResolvedValue('');

            const agent = createClaudeAgent({
                contextBuilder: mockContextBuilder,
            });

            await agent.chat(mockMessageContext);

            // Should still have base system prompt
            expect(querySpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    options: expect.objectContaining({
                        systemPrompt: expect.stringContaining('You are Isambard'),
                    }),
                })
            );
        });

        it('should not append core identity section when empty', async () => {
            (mockContextBuilder.loadCoreIdentity as ReturnType<typeof mock>).mockResolvedValue('');

            const agent = createClaudeAgent({
                contextBuilder: mockContextBuilder,
            });

            await agent.chat(mockMessageContext);

            // Should not have "## Who You Are" section
            expect(querySpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    options: expect.objectContaining({
                        systemPrompt: expect.not.stringContaining('## Who You Are'),
                    }),
                })
            );
        });

        it('should handle empty recent context', async () => {
            (mockContextBuilder.loadRecentContext as ReturnType<typeof mock>).mockResolvedValue([]);

            const agent = createClaudeAgent({
                contextBuilder: mockContextBuilder,
            });

            await agent.chat(mockMessageContext);

            // Should not have [About this user] section when no user memories
            const callArgs = querySpy.mock.calls[0][0];
            expect(callArgs.prompt).not.toContain('[About this user]');
            // But should still have the user message
            expect(callArgs.prompt).toContain('User @111222333 in #987654321: Hello Claude!');
        });

        it('should format multiple recent memories with newline-separated bullets', async () => {
            // Mock returns memories only for user, empty for bot
            (mockContextBuilder.loadRecentContext as ReturnType<typeof mock>).mockImplementation((userId: string) => {
                if(userId === '111222333') {
                    return Promise.resolve(['First memory', 'Second memory', 'Third memory']);
                }
                return Promise.resolve([]);
            });

            const agent = createClaudeAgent({
                contextBuilder: mockContextBuilder,
            });

            await agent.chat(mockMessageContext);

            // Verify the user memories section format (time section will precede it)
            expect(querySpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    prompt: expect.stringContaining('[About this user]\n- First memory\n- Second memory\n- Third memory'),
                })
            );
        });

        it('should include bot recent activities when botUserId is present and returns memories', async () => {
            // Mock returns memories for BOTH user and bot
            (mockContextBuilder.loadRecentContext as ReturnType<typeof mock>).mockImplementation((userId: string) => {
                if(userId === '111222333') {
                    return Promise.resolve(['User likes TypeScript']);
                }
                if(userId === 'bot_444555666') {
                    return Promise.resolve(['Helped user debug code', 'Answered question about React']);
                }
                return Promise.resolve([]);
            });

            const agent = createClaudeAgent({
                contextBuilder: mockContextBuilder,
            });

            await agent.chat(mockMessageContext);

            // Verify loadRecentContext was called with both user ID and bot ID
            expect(mockContextBuilder.loadRecentContext).toHaveBeenCalledWith('111222333', 3);
            expect(mockContextBuilder.loadRecentContext).toHaveBeenCalledWith('bot_444555666', 2);

            // Verify the prompt includes the [Your recent activities] section with exact format
            expect(querySpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    prompt: expect.stringContaining('[Your recent activities]\n- Helped user debug code\n- Answered question about React'),
                })
            );
        });

        it('should not include bot activities section when botUserId returns empty memories', async () => {
            // Mock returns memories for user only, empty for bot
            (mockContextBuilder.loadRecentContext as ReturnType<typeof mock>).mockImplementation((userId: string) => {
                if(userId === '111222333') {
                    return Promise.resolve(['User preference']);
                }
                return Promise.resolve([]);
            });

            const agent = createClaudeAgent({
                contextBuilder: mockContextBuilder,
            });

            await agent.chat(mockMessageContext);

            // Verify loadRecentContext was called with bot ID
            expect(mockContextBuilder.loadRecentContext).toHaveBeenCalledWith('bot_444555666', 2);

            // Verify the prompt does NOT include [Your recent activities]
            const callArgs = querySpy.mock.calls[0][0];
            expect(callArgs.prompt).not.toContain('[Your recent activities]');
        });

        it('should not load bot memories when botUserId is not present', async () => {
            // Remove botUserId from context (use partial type to test edge case)
            const contextWithoutBot = {
                guildId:   mockMessageContext.guildId,
                channelId: mockMessageContext.channelId,
                userId:    mockMessageContext.userId,
                messageId: mockMessageContext.messageId,
                content:   mockMessageContext.content,
                timestamp: mockMessageContext.timestamp,
                // botUserId intentionally omitted to test the conditional branch
            } as DiscordMessageContext;

            (mockContextBuilder.loadRecentContext as ReturnType<typeof mock>).mockResolvedValue([]);

            const agent = createClaudeAgent({
                contextBuilder: mockContextBuilder,
            });

            await agent.chat(contextWithoutBot);

            // Verify loadRecentContext was only called for user, not bot
            expect(mockContextBuilder.loadRecentContext).toHaveBeenCalledTimes(1);
            expect(mockContextBuilder.loadRecentContext).toHaveBeenCalledWith('111222333', 3);
        });

        it('should include recent events when loadRecentEvents returns events', async () => {
            (mockContextBuilder.loadRecentContext as ReturnType<typeof mock>).mockResolvedValue([]);
            (mockContextBuilder.loadRecentEvents as ReturnType<typeof mock>).mockResolvedValue([
                'Server went online',
                'New user joined #general',
            ]);

            const agent = createClaudeAgent({
                contextBuilder: mockContextBuilder,
            });

            await agent.chat(mockMessageContext);

            // Verify loadRecentEvents was called
            expect(mockContextBuilder.loadRecentEvents).toHaveBeenCalledWith(50);

            // Verify the prompt includes [Recent events] section with exact format
            expect(querySpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    prompt: expect.stringContaining('[Recent events]\n- Server went online\n- New user joined #general'),
                })
            );
        });

        it('should not include recent events section when loadRecentEvents returns empty array', async () => {
            (mockContextBuilder.loadRecentContext as ReturnType<typeof mock>).mockResolvedValue([]);
            (mockContextBuilder.loadRecentEvents as ReturnType<typeof mock>).mockResolvedValue([]);

            const agent = createClaudeAgent({
                contextBuilder: mockContextBuilder,
            });

            await agent.chat(mockMessageContext);

            // Verify the prompt does NOT include [Recent events]
            const callArgs = querySpy.mock.calls[0][0];
            expect(callArgs.prompt).not.toContain('[Recent events]');
        });

        it('should join all context sections with double newlines', async () => {
            // Mock returns memories for user, bot, AND events
            (mockContextBuilder.loadRecentContext as ReturnType<typeof mock>).mockImplementation((userId: string) => {
                if(userId === '111222333') {
                    return Promise.resolve(['User memory']);
                }
                if(userId === 'bot_444555666') {
                    return Promise.resolve(['Bot activity']);
                }
                return Promise.resolve([]);
            });
            (mockContextBuilder.loadRecentEvents as ReturnType<typeof mock>).mockResolvedValue(['Recent event']);

            const agent = createClaudeAgent({
                contextBuilder: mockContextBuilder,
            });

            await agent.chat(mockMessageContext);

            // Verify the format with all sections joined by \n\n (time section comes first)
            const callArgs = querySpy.mock.calls[0][0];
            const prompt = callArgs.prompt as string;

            // All sections should be present and separated by double newlines
            expect(prompt).toContain('## Current Time');
            expect(prompt).toContain('[About this user]\n- User memory');
            expect(prompt).toContain('[Your recent activities]\n- Bot activity');
            expect(prompt).toContain('[Recent events]\n- Recent event');
            expect(prompt).toContain('User @111222333 in #987654321: Hello Claude!');

            // Verify double newline separation between sections
            expect(prompt).toContain('[About this user]\n- User memory\n\n[Your recent activities]');
            expect(prompt).toContain('[Your recent activities]\n- Bot activity\n\n[Recent events]');
        });

        it('should format bot activities with dash-space prefix for each memory item', async () => {
            // Specifically test the "- " prefix format
            (mockContextBuilder.loadRecentContext as ReturnType<typeof mock>).mockImplementation((userId: string) => {
                if(userId === 'bot_444555666') {
                    return Promise.resolve(['Activity one', 'Activity two']);
                }
                return Promise.resolve([]);
            });
            (mockContextBuilder.loadRecentEvents as ReturnType<typeof mock>).mockResolvedValue([]);

            const agent = createClaudeAgent({
                contextBuilder: mockContextBuilder,
            });

            await agent.chat(mockMessageContext);

            // Verify exact prefix format with "- " before each item
            const callArgs = querySpy.mock.calls[0][0];
            expect(callArgs.prompt).toContain('- Activity one');
            expect(callArgs.prompt).toContain('- Activity two');
            // Ensure items are joined with newlines, not other separators
            expect(callArgs.prompt).toContain('- Activity one\n- Activity two');
        });

        it('should format recent events with dash-space prefix for each event', async () => {
            // Specifically test the "- " prefix format for events
            (mockContextBuilder.loadRecentContext as ReturnType<typeof mock>).mockResolvedValue([]);
            (mockContextBuilder.loadRecentEvents as ReturnType<typeof mock>).mockResolvedValue([
                'Event one',
                'Event two',
            ]);

            const agent = createClaudeAgent({
                contextBuilder: mockContextBuilder,
            });

            await agent.chat(mockMessageContext);

            // Verify exact prefix format with "- " before each event
            const callArgs = querySpy.mock.calls[0][0];
            expect(callArgs.prompt).toContain('- Event one');
            expect(callArgs.prompt).toContain('- Event two');
            // Ensure events are joined with newlines
            expect(callArgs.prompt).toContain('- Event one\n- Event two');
        });
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
                // Memory MCP tools
                'mcp__memory__view',
                'mcp__memory__list',
                'mcp__memory__storeSelf',
                'mcp__memory__storeUserMemory',
                'mcp__memory__logEvent',
                'mcp__memory__search',
                // Read-only and safe tools
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
    });

    describe('message stream processing', () => {
        it('should ignore non-assistant messages in stream', async () => {
            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:    'user' as const,
                        message: {
                            content: [
                                {
                                    type: 'text' as const,
                                    text: 'This should be ignored',
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
                                    text: 'Assistant response',
                                },
                            ],
                        },
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            const response = await agent.chat(mockMessageContext);

            expect(response).toBe('Assistant response');
        });

        it('should return null when stream has only non-assistant messages', async () => {
            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:    'user' as const,
                        message: {
                            content: [
                                {
                                    type: 'text' as const,
                                    text: 'User message',
                                },
                            ],
                        },
                    };
                    yield {
                        type:    'system' as const,
                        message: {
                            content: [
                                {
                                    type: 'text' as const,
                                    text: 'System message',
                                },
                            ],
                        },
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            const response = await agent.chat(mockMessageContext);

            expect(response).toBeNull();
        });

        it.each([
            ['no content field', { type: 'assistant' as const, message: {} }],
            ['null content', { type: 'assistant' as const, message: { content: null } }],
            ['undefined content', { type: 'assistant' as const, message: { content: undefined } }],
            ['no message field', { type: 'assistant' as const }],
            ['undefined message property', { type: 'assistant' as const, message: undefined }],
        ])('should handle assistant message with %s gracefully', async (_scenario, messageData) => {
            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield messageData;
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            const response = await agent.chat(mockMessageContext);

            expect(response).toBeNull();
        });

        it('should filter out non-text blocks and combine multiple text blocks', async () => {
            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:    'assistant' as const,
                        message: {
                            content: [
                                {
                                    type: 'tool_use' as const,
                                    id:   'tool_123',
                                    name: 'memory_view',
                                },
                                {
                                    type: 'text' as const,
                                    text: 'First text block',
                                },
                                {
                                    type: 'image' as const,
                                    data: 'base64data',
                                },
                                {
                                    type: 'text' as const,
                                    text: 'Second text block',
                                },
                            ],
                        },
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            const response = await agent.chat(mockMessageContext);

            expect(response).toBe('First text block\nSecond text block');
        });

        it('should trim whitespace from combined text blocks', async () => {
            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:    'assistant' as const,
                        message: {
                            content: [
                                {
                                    type: 'text' as const,
                                    text: '  Leading and trailing spaces  ',
                                },
                            ],
                        },
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            const response = await agent.chat(mockMessageContext);

            expect(response).toBe('Leading and trailing spaces');
        });

        it('should return null when text is only whitespace', async () => {
            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:    'assistant' as const,
                        message: {
                            content: [
                                {
                                    type: 'text' as const,
                                    text: '   \n\t  ',
                                },
                            ],
                        },
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            const response = await agent.chat(mockMessageContext);

            expect(response).toBeNull();
        });

        it('should update lastAssistantText only when text is non-empty', async () => {
            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:    'assistant' as const,
                        message: {
                            content: [
                                {
                                    type: 'text' as const,
                                    text: 'First valid response',
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
                                    text: '   ',  // Only whitespace, should not update
                                },
                            ],
                        },
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            const response = await agent.chat(mockMessageContext);

            expect(response).toBe('First valid response');
        });

        it('should join multiple text blocks with newlines', async () => {
            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:    'assistant' as const,
                        message: {
                            content: [
                                {
                                    type: 'text' as const,
                                    text: 'Line 1',
                                },
                                {
                                    type: 'text' as const,
                                    text: 'Line 2',
                                },
                                {
                                    type: 'text' as const,
                                    text: 'Line 3',
                                },
                            ],
                        },
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            const response = await agent.chat(mockMessageContext);

            expect(response).toBe('Line 1\nLine 2\nLine 3');
        });

        it('should filter out content blocks without type property', async () => {
            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:    'assistant' as const,
                        message: {
                            content: [
                                { text: 'No type property' }, // Should be filtered out
                                { type: 'text', text: 'Has type' }, // Should be included
                            ],
                        },
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            const response = await agent.chat(mockMessageContext);

            expect(response).toBe('Has type');
        });
    });

    describe('stream event callbacks', () => {
        it('should invoke callback for each stream event', async () => {
            const events: any[] = [];
            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:    'assistant' as const,
                        message: {
                            content: [
                                {
                                    type: 'text' as const,
                                    text: 'Response',
                                },
                            ],
                        },
                    };
                    yield {
                        type:      'tool_progress' as const,
                        tool_name: 'memory_view',
                    };
                    yield {
                        type:    'result' as const,
                        subtype: 'success',
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            await agent.chat(mockMessageContext, (event) => {
                events.push(event);
            });

            expect(events.length).toBe(3);
            expect(events[0].type).toBe('assistant');
            expect(events[1].type).toBe('tool_progress');
            expect(events[2].type).toBe('result');
        });

        it('should receive correct event data in callback', async () => {
            let receivedEvent: any = null;
            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:                 'tool_progress' as const,
                        tool_name:            'mcp__memory__search',
                        tool_use_id:          'tool_123',
                        elapsed_time_seconds: 1.5,
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            await agent.chat(mockMessageContext, (event) => {
                receivedEvent = event;
            });

            expect(receivedEvent).toEqual({
                type:                 'tool_progress',
                tool_name:            'mcp__memory__search',
                tool_use_id:          'tool_123',
                elapsed_time_seconds: 1.5,
            });
        });

        it('should work without callback (backward compatibility)', async () => {
            const agent = createClaudeAgent({});
            const response = await agent.chat(mockMessageContext);

            expect(response).toBe('Hello! This is a test response.');
        });

        it('should catch callback errors via outer try/catch and return null', async () => {
            const agent = createClaudeAgent({});

            // Callback throws, but outer try/catch catches it and returns null
            const result = await agent.chat(mockMessageContext, () => {
                throw new Error('Callback error');
            });

            expect(result).toBeNull();
        });

        it('should invoke callback for all event types', async () => {
            const eventTypes: string[] = [];
            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield { type: 'user' as const };
                    yield { type: 'assistant' as const, message: { content: [{ type: 'text', text: 'hi' }] } };
                    yield { type: 'tool_progress' as const, tool_name: 'test' };
                    yield { type: 'tool_result' as const, tool_name: 'test' };
                    yield { type: 'result' as const, subtype: 'success' };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            await agent.chat(mockMessageContext, (event) => {
                eventTypes.push(event.type);
            });

            expect(eventTypes).toEqual(['user', 'assistant', 'tool_progress', 'tool_result', 'result']);
        });
    });

    describe('error handling and logging', () => {
        it('should return full long responses without truncation (handlers do chunking)', async () => {
            const longText = _.repeat('x', 2000);
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

            // Agent returns full response; Discord handlers handle chunking
            expect(response).toBe(longText);
            expect(response?.length).toBe(2000);
        });

        it('should log error with message and user details', async () => {
            const consoleErrorSpy = spyOn(console, 'error');
            const testError = new Error('Test error message');
            querySpy.mockImplementation((_params: any): any => {
                throw testError;
            });

            const agent = createClaudeAgent({});
            await agent.chat(mockMessageContext);

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringContaining('Failed to get Claude response for message msg_999 from user 111222333'),
                testError
            );

            consoleErrorSpy.mockRestore();
        });
    });

    describe('structured logging', () => {
        it('should log message processing start with context', async () => {
            const infoSpy = spyOn(logger, 'info');

            const agent = createClaudeAgent({});
            await agent.chat(mockMessageContext);

            expect(infoSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId:    mockMessageContext.userId,
                    channelId: mockMessageContext.channelId,
                    messageId: mockMessageContext.messageId,
                    msg:       'Agent starting to process message',
                })
            );

            infoSpy.mockRestore();
        });

        it('should log stream events with event type', async () => {
            const debugSpy = spyOn(logger, 'debug');

            const agent = createClaudeAgent({});
            await agent.chat(mockMessageContext);

            expect(debugSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    eventType: 'assistant',
                    msg:       expect.stringContaining('Stream event:'),
                })
            );

            debugSpy.mockRestore();
        });

        it('should log completion with response length', async () => {
            const infoSpy = spyOn(logger, 'info');

            const agent = createClaudeAgent({});
            await agent.chat(mockMessageContext);

            expect(infoSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    messageId:      mockMessageContext.messageId,
                    responseLength: expect.any(Number),
                    msg:            expect.stringContaining('Agent completed processing'),
                })
            );

            infoSpy.mockRestore();
        });

        it('should log tool usage from assistant messages', async () => {
            const debugSpy = spyOn(logger, 'debug');
            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:    'assistant' as const,
                        message: {
                            content: [
                                {
                                    type:  'tool_use' as const,
                                    id:    'tool_123',
                                    name:  'mcp__memory__view',
                                    input: { path: '/memories/test' },
                                },
                                {
                                    type: 'text' as const,
                                    text: 'Checking memories...',
                                },
                            ],
                        },
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            await agent.chat(mockMessageContext);

            expect(debugSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    toolName:  'mcp__memory__view',
                    toolUseId: 'tool_123',
                    msg:       'Tool call: mcp__memory__view',
                })
            );

            debugSpy.mockRestore();
        });

        it('should log multiple tool uses from a single assistant message', async () => {
            const debugSpy = spyOn(logger, 'debug');
            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:    'assistant' as const,
                        message: {
                            content: [
                                {
                                    type:  'tool_use' as const,
                                    id:    'tool_123',
                                    name:  'mcp__memory__view',
                                    input: { path: '/memories/test' },
                                },
                                {
                                    type:  'tool_use' as const,
                                    id:    'tool_456',
                                    name:  'mcp__memory__store',
                                    input: { path: '/memories/new', content: 'data' },
                                },
                            ],
                        },
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            await agent.chat(mockMessageContext);

            expect(debugSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    toolName:  'mcp__memory__view',
                    toolUseId: 'tool_123',
                    msg:       'Tool call: mcp__memory__view',
                })
            );
            expect(debugSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    toolName:  'mcp__memory__store',
                    toolUseId: 'tool_456',
                    msg:       'Tool call: mcp__memory__store',
                })
            );

            debugSpy.mockRestore();
        });

        it('should not log tool usage for messages without tool_use blocks', async () => {
            const debugSpy = spyOn(logger, 'debug');
            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:    'assistant' as const,
                        message: {
                            content: [
                                {
                                    type: 'text' as const,
                                    text: 'Just text, no tools',
                                },
                            ],
                        },
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            await agent.chat(mockMessageContext);

            // Should only have stream event log, not tool call log
            const toolCallCalls = _.filter(
                debugSpy.mock.calls,
                call => call[0] && _.isObject(call[0]) && 'toolName' in call[0]
            );
            expect(toolCallCalls.length).toBe(0);

            debugSpy.mockRestore();
        });
    });

    describe('time context injection', () => {
        let timeContextSpy: ReturnType<typeof spyOn>;

        beforeEach(() => {
            // Mock getCurrentTimeContext to return predictable values
            timeContextSpy = spyOn(timeUtils, 'getCurrentTimeContext').mockReturnValue({
                utc:       '2025-01-15T14:30:00.000Z',
                dayOfWeek: 'Wednesday',
                timeOfDay: 'afternoon',
            });
        });

        afterEach(() => {
            timeContextSpy.mockRestore();
        });

        it('should include time section in context prefix when contextBuilder is provided', async () => {
            const agent = createClaudeAgent({
                contextBuilder: mockContextBuilder,
            });

            await agent.chat(mockMessageContext);

            expect(querySpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    prompt: expect.stringContaining('## Current Time'),
                })
            );
        });

        it('should format time section with UTC, day of week, and time of day', async () => {
            const agent = createClaudeAgent({
                contextBuilder: mockContextBuilder,
            });

            await agent.chat(mockMessageContext);

            expect(querySpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    prompt: expect.stringContaining('- UTC: 2025-01-15T14:30:00.000Z (Wednesday afternoon)'),
                })
            );
        });

        it('should include time section as the first section in context prefix', async () => {
            // Mock user memories to have another section
            (mockContextBuilder.loadRecentContext as ReturnType<typeof mock>).mockImplementation((userId: string) => {
                if(userId === '111222333') {
                    return Promise.resolve(['User likes TypeScript']);
                }
                return Promise.resolve([]);
            });

            const agent = createClaudeAgent({
                contextBuilder: mockContextBuilder,
            });

            await agent.chat(mockMessageContext);

            const callArgs = querySpy.mock.calls[0][0];
            const prompt = callArgs.prompt as string;

            // Time section should come before user section
            const timeIndex = prompt.indexOf('## Current Time');
            const userIndex = prompt.indexOf('[About this user]');

            expect(timeIndex).toBeGreaterThanOrEqual(0);
            expect(userIndex).toBeGreaterThan(timeIndex);
        });

        it('should call getCurrentTimeContext when building context prefix', async () => {
            const agent = createClaudeAgent({
                contextBuilder: mockContextBuilder,
            });

            await agent.chat(mockMessageContext);

            expect(timeContextSpy).toHaveBeenCalled();
        });
    });

    describe('temporal reasoning in system prompt', () => {
        it('should include temporal reasoning section in system prompt', async () => {
            const agent = createClaudeAgent({});

            await agent.chat(mockMessageContext);

            expect(querySpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    options: expect.objectContaining({
                        systemPrompt: expect.stringContaining('## Temporal Reasoning'),
                    }),
                })
            );
        });

        it('should include guidance about identity memories being stable', async () => {
            const agent = createClaudeAgent({});

            await agent.chat(mockMessageContext);

            expect(querySpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    options: expect.objectContaining({
                        systemPrompt: expect.stringContaining('Identity memories (values, beliefs) are relatively stable over time'),
                    }),
                })
            );
        });

        it('should include guidance about state memories becoming outdated', async () => {
            const agent = createClaudeAgent({});

            await agent.chat(mockMessageContext);

            expect(querySpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    options: expect.objectContaining({
                        systemPrompt: expect.stringContaining('State memories may become outdated'),
                    }),
                })
            );
        });

        it('should include guidance about event memories being historical', async () => {
            const agent = createClaudeAgent({});

            await agent.chat(mockMessageContext);

            expect(querySpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    options: expect.objectContaining({
                        systemPrompt: expect.stringContaining('Event memories are historical records'),
                    }),
                })
            );
        });

        it('should include guidance to prefer recent information', async () => {
            const agent = createClaudeAgent({});

            await agent.chat(mockMessageContext);

            expect(querySpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    options: expect.objectContaining({
                        systemPrompt: expect.stringContaining('Prefer recent information when facts may have changed'),
                    }),
                })
            );
        });
    });
});
