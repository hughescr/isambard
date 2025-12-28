/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any, @typescript-eslint/await-thenable -- Test mocks require unsafe type operations */
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import _ from 'lodash';
import * as agentSdk from '@anthropic-ai/claude-agent-sdk';
import { createClaudeAgent } from '../../../src/agent/agent';
import type { DiscordMessageContext } from '../../../src/integrations/discord/types';
import { createGuildId, createChannelId, createUserId } from '../../../src/integrations/discord/types';
import type { ContextBuilder } from '../../../src/agent/context-builder';

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
        };

        // Create mock context builder
        mockContextBuilder = {
            loadCoreIdentity:   mock(_.constant(Promise.resolve(''))),
            loadRecentContext:  mock(_.constant(Promise.resolve([]))),
            buildSystemContext: mock(_.constant(Promise.resolve(''))),
            // eslint-disable-next-line @typescript-eslint/no-empty-function -- Mock function
            recordAccess:       mock(async () => {}),
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

    it('should truncate responses longer than 1900 characters', async () => {
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

        expect(response).toBe(_.repeat('a', 1897) + '...');
        expect(response?.length).toBe(1900);
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

    it('should truncate responses exceeding MAX_RESPONSE_LENGTH by exactly 1 character', async () => {
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

        expect(response).toBe(_.repeat('y', 1897) + '...');
        expect(response?.length).toBe(1900);
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

            // Should not have [Recent context] prefix
            expect(querySpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    prompt: 'User @111222333 in #987654321: Hello Claude!',
                })
            );
        });

        it('should format multiple recent memories with newline-separated bullets', async () => {
            (mockContextBuilder.loadRecentContext as ReturnType<typeof mock>).mockResolvedValue([
                'First memory',
                'Second memory',
                'Third memory',
            ]);

            const agent = createClaudeAgent({
                contextBuilder: mockContextBuilder,
            });

            await agent.chat(mockMessageContext);

            expect(querySpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    prompt: '[Recent context]\n- First memory\n- Second memory\n- Third memory\n\nUser @111222333 in #987654321: Hello Claude!',
                })
            );
        });
    });

    describe('tool configuration', () => {
        it('should include memory tools when MCP server provided', async () => {
            const mockMcpServer = { name: 'memory', version: '1.0.0' };

            const agent = createClaudeAgent({

                memoryMcpServer: mockMcpServer as any,
            });

            await agent.chat(mockMessageContext);

            expect(querySpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    options: expect.objectContaining({
                        allowedTools: ['mcp__memory__view', 'mcp__memory__store', 'mcp__memory__search'],
                    }),
                })
            );
        });

        it('should use empty array for allowedTools when no MCP server', async () => {
            const agent = createClaudeAgent({});

            await agent.chat(mockMessageContext);

            expect(querySpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    options: expect.objectContaining({
                        allowedTools: [],
                    }),
                })
            );
        });

        it('should use bypassPermissions mode', async () => {
            const agent = createClaudeAgent({});

            await agent.chat(mockMessageContext);

            expect(querySpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    options: expect.objectContaining({
                        permissionMode: 'bypassPermissions',
                    }),
                })
            );
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

        it('should handle messages with no content field', async () => {
            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:    'assistant' as const,
                        message: {}, // No content field
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            const response = await agent.chat(mockMessageContext);

            expect(response).toBeNull();
        });

        it('should handle messages with null content', async () => {
            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:    'assistant' as const,
                        message: {
                            content: null,
                        },
                    };
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

        it('should handle messages with no message field', async () => {
            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type: 'assistant' as const,
                        // No message field
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            const response = await agent.chat(mockMessageContext);

            expect(response).toBeNull();
        });

        it('should handle assistant message with undefined message property', async () => {
            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:    'assistant' as const,
                        message: undefined,
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            const response = await agent.chat(mockMessageContext);

            expect(response).toBeNull();
        });

        it('should handle assistant message with message.content undefined', async () => {
            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:    'assistant' as const,
                        message: {
                            content: undefined,
                        },
                    };
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            const response = await agent.chat(mockMessageContext);

            expect(response).toBeNull();
        });

        it('should safely handle filter returning undefined with || fallback', async () => {
            querySpy.mockImplementation((_params: any): any => {
                async function* mockGenerator() {
                    yield {
                        type:    'assistant' as const,
                        message: {
                            content: null, // This will make filter return falsy, triggering || []
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

        it('should not crash if callback throws error', async () => {
            const agent = createClaudeAgent({});

            // Callback that throws should not prevent normal operation
            await expect(async () => {
                await agent.chat(mockMessageContext, () => {
                    throw new Error('Callback error');
                });
            }).not.toThrow();
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
        it('should log truncation with message details', async () => {
            const consoleSpy = spyOn(console, 'log');
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
            await agent.chat(mockMessageContext);

            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('Truncating Claude response for message msg_999')
            );
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('2000 -> 1900')
            );

            consoleSpy.mockRestore();
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
});
