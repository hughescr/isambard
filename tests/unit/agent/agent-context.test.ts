import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { createClaudeAgent } from '../../../src/agent/agent';
import type { ContextBuilder } from '../../../src/agent/context-builder';
import type { AgentStreamEvent } from '../../../src/agent/types';
import { createGuildId, createChannelId, createUserId, type DiscordMessageContext  } from '../../../src/integrations/discord/types';
import { mockLogger, mockQuery } from '../../setup';

// mockQuery is typed from its default implementation; cast to allow edge-case generator implementations in tests
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mockQuery default typing doesn't cover edge-case generator implementations
const mockQueryImpl = mockQuery as { mockImplementation: (fn: (_: unknown) => any) => void } & typeof mockQuery;

describe('createClaudeAgent context integration', () => {
    let mockMessageContext: DiscordMessageContext;
    let mockContextBuilder: ContextBuilder;

    beforeEach(() => {
        // Reset logger mocks
        mockLogger.info.mockClear();
        mockLogger.error.mockClear();
        mockLogger.debug.mockClear();
        mockLogger.warn.mockClear();

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
            loadCoreIdentity:       mock(() => Promise.resolve('')),
            loadHotState:           mock(() => Promise.resolve('')),
            loadUserMemories:       mock(() => Promise.resolve('')),
            recordAccess:           mock(async () => {}),
            loadRecentEvents:       mock(() => Promise.resolve({ items: [], isFallback: false })),
            loadRecentEventsSince:  mock(async () => []),
            loadUserTimezone:       mock(() => Promise.resolve(undefined)),
            buildPerchContext:      mock(() => Promise.resolve('')),
            buildUserMessagePrefix: mock(async (userId: string, _userTimezone?: string): Promise<string> => {
                const sections: string[] = [];

                const userMemories = await mockContextBuilder.loadUserMemories(userId);
                if(userMemories) {
                    sections.push(`[About this user]\n${userMemories}`);
                }

                const hotState = await mockContextBuilder.loadHotState();
                if(hotState) {
                    sections.push(`[Current state]\n${hotState}`);
                }

                const eventsResult = await mockContextBuilder.loadRecentEvents(50);
                if(eventsResult.items.length > 0) {
                    const eventLines = eventsResult.items.map((item: Record<string, unknown>) => `${String(item.path)}: ${String(item.content)}`).join('\n\n');
                    sections.push(`[Recent events]\n${eventLines}`);
                }

                if(sections.length === 0) {
                    return '';
                }
                return `${sections.join('\n\n')}\n\n`;
            }),
        };

        // Mock query() to return an async generator with assistant message
        mockQuery.mockClear();
        mockQueryImpl.mockImplementation((_params: unknown) => {
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

    describe('context builder integration', () => {
        test('should load core identity when contextBuilder provided', async () => {
            (mockContextBuilder.loadCoreIdentity as ReturnType<typeof mock>).mockResolvedValue('I am Isambard, a helpful AI assistant.');

            const agent = createClaudeAgent({
                contextBuilder: mockContextBuilder,
            });

            await agent.handleInput([mockMessageContext]);

            expect(mockQuery).toHaveBeenCalledWith(
                expect.objectContaining({
                    options: expect.objectContaining({
                        systemPrompt: expect.stringContaining('I am Isambard, a helpful AI assistant.'),
                    }),
                })
            );
        });

        test('should load recent context when contextBuilder provided', async () => {
            (mockContextBuilder.loadUserMemories as ReturnType<typeof mock>).mockResolvedValue(
                '- /users/111222333/pref1 (1h ago): User likes coffee\n- /users/111222333/pref2 (2h ago): User is working on TypeScript'
            );

            const agent = createClaudeAgent({
                contextBuilder: mockContextBuilder,
            });

            await agent.handleInput([mockMessageContext]);

            expect(mockQuery).toHaveBeenCalledWith(
                expect.objectContaining({
                    prompt: expect.stringContaining('User likes coffee'),
                })
            );
        });

        test('should handle empty core identity without appending identity section', async () => {
            (mockContextBuilder.loadCoreIdentity as ReturnType<typeof mock>).mockResolvedValue('');

            const agent = createClaudeAgent({
                contextBuilder: mockContextBuilder,
            });

            await agent.handleInput([mockMessageContext]);

            // Should still have base system prompt but not "## Who You Are" section
            expect(mockQuery).toHaveBeenCalledWith(
                expect.objectContaining({
                    options: expect.objectContaining({
                        systemPrompt: expect.stringContaining('You are Isambard'),
                    }),
                })
            );
            expect(mockQuery).toHaveBeenCalledWith(
                expect.objectContaining({
                    options: expect.objectContaining({
                        systemPrompt: expect.not.stringContaining('## Who You Are'),
                    }),
                })
            );
        });

        test('should handle empty recent context', async () => {
            (mockContextBuilder.loadUserMemories as ReturnType<typeof mock>).mockResolvedValue('');

            const agent = createClaudeAgent({
                contextBuilder: mockContextBuilder,
            });

            await agent.handleInput([mockMessageContext]);

            // Should not have [About this user] section when no user memories
            const callArgs = mockQuery.mock.calls[0][0] as Record<string, unknown>;
            expect(callArgs.prompt).not.toContain('[About this user]');
            // But should still have the user message (with timestamp in handleInput)
            expect(callArgs.prompt).toContain('User @111222333 in #987654321 at 2025-01-15T12:00:00 UTC (UTC: 2025-01-15T12:00:00Z): Hello Claude!');
        });

        test('should format multiple recent memories with newline-separated bullets', async () => {
            // Mock returns user memories as formatted string
            (mockContextBuilder.loadUserMemories as ReturnType<typeof mock>).mockResolvedValue(
                '- /users/111222333/m1 (1h ago): First memory\n- /users/111222333/m2 (1h ago): Second memory\n- /users/111222333/m3 (1h ago): Third memory'
            );

            const agent = createClaudeAgent({
                contextBuilder: mockContextBuilder,
            });

            await agent.handleInput([mockMessageContext]);

            // Verify the user memories section format
            expect(mockQuery).toHaveBeenCalledWith(
                expect.objectContaining({
                    prompt: expect.stringContaining('[About this user]\n- /users/111222333/m1 (1h ago): First memory'),
                })
            );
        });

        test('should include recent events when loadRecentEvents returns events', async () => {
            (mockContextBuilder.loadUserMemories as ReturnType<typeof mock>).mockResolvedValue('');
            (mockContextBuilder.loadRecentEvents as ReturnType<typeof mock>).mockResolvedValue({
                items: [
                    { path: '/events/e1', content: 'Server went online', updatedAt: '2025-01-15T10:00:00Z', contentType: 'text/markdown', metadata: {}, createdAt: '2025-01-15T10:00:00Z' },
                    { path: '/events/e2', content: 'New user joined #general', updatedAt: '2025-01-15T11:00:00Z', contentType: 'text/markdown', metadata: {}, createdAt: '2025-01-15T11:00:00Z' },
                ],
                isFallback: false,
            });

            const agent = createClaudeAgent({
                contextBuilder: mockContextBuilder,
            });

            await agent.handleInput([mockMessageContext]);

            // Verify the prompt includes [Recent events] section
            expect(mockQuery).toHaveBeenCalledWith(
                expect.objectContaining({
                    prompt: expect.stringContaining('[Recent events]'),
                })
            );
            expect(mockQuery).toHaveBeenCalledWith(
                expect.objectContaining({
                    prompt: expect.stringContaining('Server went online'),
                })
            );
        });

        test('should not include recent events section when loadRecentEvents returns empty array', async () => {
            (mockContextBuilder.loadUserMemories as ReturnType<typeof mock>).mockResolvedValue('');
            (mockContextBuilder.loadRecentEvents as ReturnType<typeof mock>).mockResolvedValue({ items: [], isFallback: false });

            const agent = createClaudeAgent({
                contextBuilder: mockContextBuilder,
            });

            await agent.handleInput([mockMessageContext]);

            // Verify the prompt does NOT include [Recent events]
            const callArgs = mockQuery.mock.calls[0][0] as Record<string, unknown>;
            expect(callArgs.prompt).not.toContain('[Recent events]');
        });

        test('should handle missing contextBuilder gracefully', async () => {
            const agent = createClaudeAgent({
                // No contextBuilder provided
            });

            await agent.handleInput([mockMessageContext]);

            // Verify the prompt is just the user message without any context prefix (with timestamp in handleInput)
            const callArgs = mockQuery.mock.calls[0][0] as Record<string, unknown>;
            expect(callArgs.prompt).toBe('User @111222333 in #987654321 at 2025-01-15T12:00:00 UTC (UTC: 2025-01-15T12:00:00Z): Hello Claude!');

            // Verify no memory sections are included
            expect(callArgs.prompt).not.toContain('[About this user]');
            expect(callArgs.prompt).not.toContain('[Current state]');
            expect(callArgs.prompt).not.toContain('[Recent events]');
        });

        test('should join all context sections with double newlines', async () => {
            // Mock returns user memories, hot state, AND events
            (mockContextBuilder.loadUserMemories as ReturnType<typeof mock>).mockResolvedValue('- User memory');
            (mockContextBuilder.loadHotState as ReturnType<typeof mock>).mockResolvedValue('Hot state content');
            (mockContextBuilder.loadRecentEvents as ReturnType<typeof mock>).mockResolvedValue({
                items: [
                    { path: '/events/e1', content: 'Recent event', updatedAt: new Date().toISOString(), contentType: 'text/markdown', metadata: {}, createdAt: new Date().toISOString() },
                ],
                isFallback: false,
            });

            const agent = createClaudeAgent({
                contextBuilder: mockContextBuilder,
            });

            await agent.handleInput([mockMessageContext]);

            // Verify the format with all sections joined by \n\n
            const callArgs = mockQuery.mock.calls[0][0] as Record<string, unknown>;
            const prompt = callArgs.prompt as string;

            // All sections should be present and separated by double newlines
            expect(prompt).toContain('[About this user]\n- User memory');
            expect(prompt).toContain('[Current state]\nHot state content');
            expect(prompt).toContain('[Recent events]');
            expect(prompt).toContain('Recent event');
            expect(prompt).toContain('User @111222333 in #987654321 at 2025-01-15T12:00:00 UTC (UTC: 2025-01-15T12:00:00Z): Hello Claude!');

            // Verify double newline separation between sections
            expect(prompt).toContain('[About this user]\n- User memory\n\n[Current state]');
            expect(prompt).toContain('[Current state]\nHot state content\n\n[Recent events]');
        });
    });

    describe('time context in user prompt', () => {
        test('should NOT include time section when no context available', async () => {
            const agent = createClaudeAgent({
                contextBuilder: mockContextBuilder,
            });

            await agent.handleInput([mockMessageContext]);

            const callArgs = mockQuery.mock.calls[0][0] as Record<string, unknown>;
            const prompt = callArgs.prompt as string;

            // Time header alone doesn't count as context, so prefix is empty
            expect(prompt).not.toContain('## Current Time');
        });

        test('should start user prompt with [About this user] when user memories present', async () => {
            // Mock user memories to have content
            (mockContextBuilder.loadUserMemories as ReturnType<typeof mock>).mockResolvedValue(
                '- /users/111222333/pref (1h ago): User likes TypeScript'
            );

            const agent = createClaudeAgent({
                contextBuilder: mockContextBuilder,
            });

            await agent.handleInput([mockMessageContext]);

            const callArgs = mockQuery.mock.calls[0][0] as Record<string, unknown>;
            const prompt = callArgs.prompt as string;

            // User memories section should be present
            expect(prompt).toMatch(/^\[About this user\]/);
        });
    });

    describe('temporal reasoning in system prompt', () => {
        test.each([
            ['## Temporal Reasoning'],
            ['Identity memories (values, beliefs) are relatively stable over time'],
            ['State memories may become outdated'],
            ['Event memories are historical records'],
            ['Prefer recent information when facts may have changed'],
        ])('should include temporal guidance: %s', async (expectedContent) => {
            const agent = createClaudeAgent({});

            await agent.handleInput([mockMessageContext]);

            expect(mockQuery).toHaveBeenCalledWith(
                expect.objectContaining({
                    options: expect.objectContaining({
                        systemPrompt: expect.stringContaining(expectedContent),
                    }),
                })
            );
        });
    });

    describe('message stream processing', () => {
        test('should ignore non-assistant messages in stream', async () => {
            mockQueryImpl.mockImplementation((_params: unknown) => {
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
            const result = await agent.handleInput([mockMessageContext]);

            expect(result.response).toBe('Assistant response');
        });

        test('should return null when stream has only non-assistant messages', async () => {
            mockQueryImpl.mockImplementation((_params: unknown) => {
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
            const result = await agent.handleInput([mockMessageContext]);

            expect(result.response).toBeNull();
        });

        test.each([
            ['no content field', { type: 'assistant' as const, message: {} }],
            ['null content', { type: 'assistant' as const, message: { content: null } }],
            ['undefined content', { type: 'assistant' as const, message: { content: undefined } }],
            ['no message field', { type: 'assistant' as const }],
            ['undefined message property', { type: 'assistant' as const, message: undefined }],
        ])('should handle assistant message with %s gracefully', async (_scenario, messageData) => {
            mockQueryImpl.mockImplementation((_params: unknown) => {
                async function* mockGenerator() {
                    yield messageData;
                }
                return mockGenerator();
            });

            const agent = createClaudeAgent({});
            const result = await agent.handleInput([mockMessageContext]);

            expect(result.response).toBeNull();
        });

        test('should filter out non-text blocks and combine multiple text blocks', async () => {
            mockQueryImpl.mockImplementation((_params: unknown) => {
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
            const result = await agent.handleInput([mockMessageContext]);

            expect(result.response).toBe('First text block\nSecond text block');
        });

        test('should trim whitespace from combined text blocks', async () => {
            mockQueryImpl.mockImplementation((_params: unknown) => {
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
            const result = await agent.handleInput([mockMessageContext]);

            expect(result.response).toBe('Leading and trailing spaces');
        });

        test('should return null when text is only whitespace', async () => {
            mockQueryImpl.mockImplementation((_params: unknown) => {
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
            const result = await agent.handleInput([mockMessageContext]);

            expect(result.response).toBeNull();
        });

        test('should update lastAssistantText only when text is non-empty', async () => {
            mockQueryImpl.mockImplementation((_params: unknown) => {
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
            const result = await agent.handleInput([mockMessageContext]);

            expect(result.response).toBe('First valid response');
        });

        test('should join multiple text blocks with newlines', async () => {
            mockQueryImpl.mockImplementation((_params: unknown) => {
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
            const result = await agent.handleInput([mockMessageContext]);

            expect(result.response).toBe('Line 1\nLine 2\nLine 3');
        });

        test('should filter out content blocks without type property', async () => {
            mockQueryImpl.mockImplementation((_params: unknown) => {
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
            const result = await agent.handleInput([mockMessageContext]);

            expect(result.response).toBe('Has type');
        });
    });

    describe('stream event callbacks', () => {
        test('should invoke callback for each stream event', async () => {
            const events: AgentStreamEvent[] = [];
            mockQueryImpl.mockImplementation((_params: unknown) => {
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
            await agent.handleInput([mockMessageContext], { onStreamEvent: (event) => {
                events.push(event);
            } });

            expect(events).toHaveLength(3);
            expect(events[0].type).toBe('assistant');
            expect(events[1].type).toBe('tool_progress');
            expect(events[2].type).toBe('result');
        });

        test('should receive correct event data in callback', async () => {
            let receivedEvent: AgentStreamEvent | null = null;
            mockQueryImpl.mockImplementation((_params: unknown) => {
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
            await agent.handleInput([mockMessageContext], { onStreamEvent: (event) => {
                receivedEvent = event;
            } });

            expect(receivedEvent!).toEqual({
                type:                 'tool_progress',
                tool_name:            'mcp__memory__search',
                tool_use_id:          'tool_123',
                elapsed_time_seconds: 1.5,
            });
        });

        test('should work without callback (backward compatibility)', async () => {
            const agent = createClaudeAgent({});
            const result = await agent.handleInput([mockMessageContext]);

            expect(result.response).toBe('Hello! This is a test response.');
        });

        test('should catch callback errors via outer try/catch and return null', async () => {
            const agent = createClaudeAgent({});

            // Callback throws, but outer try/catch catches it and handleInput returns empty result
            const result = await agent.handleInput([mockMessageContext], { onStreamEvent: () => {
                throw new Error('Callback error');
            } });

            expect(result.response).toBeNull();
        });

        test('should invoke callback for all event types', async () => {
            const eventTypes: string[] = [];
            mockQueryImpl.mockImplementation((_params: unknown) => {
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
            await agent.handleInput([mockMessageContext], { onStreamEvent: (event) => {
                eventTypes.push(event.type);
            } });

            expect(eventTypes).toEqual(['user', 'assistant', 'tool_progress', 'tool_result', 'result']);
        });
    });

    describe('error handling and logging', () => {
        test('should return full long responses without truncation (handlers do chunking)', async () => {
            const longText = 'x'.repeat(2000);
            mockQueryImpl.mockImplementation((_params: unknown) => {
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
            const result = await agent.handleInput([mockMessageContext]);

            // Agent returns full response; Discord handlers handle chunking
            expect(result.response).toBe(longText);
            expect(result.response?.length).toBe(2000);
        });

        test('should log error with message and user details', async () => {
            const testError = new Error('Test error message');
            mockQueryImpl.mockImplementation((_params: unknown) => {
                throw testError;
            });

            const agent = createClaudeAgent({});
            await agent.handleInput([mockMessageContext]);

            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.objectContaining({
                    error:        testError,
                    contextCount: 1,
                }),
                expect.stringContaining('Failed to process batch')
            );
        });
    });

    describe('structured logging', () => {
        test('should log message processing start with context', async () => {
            const agent = createClaudeAgent({});
            await agent.handleInput([mockMessageContext]);

            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.objectContaining({
                    contextCount: 1,
                    messageIds:   [mockMessageContext.messageId],
                    msg:          'Agent starting batch processing',
                })
            );
        });

        test('should log stream events with descriptive messages', async () => {
            const agent = createClaudeAgent({});
            await agent.handleInput([mockMessageContext]);

            // Should log assistant event with hasText indicator
            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({
                    eventType: 'assistant',
                    hasText:   true,
                    msg:       'Claude LLM responding',
                })
            );
        });

        test('should log completion with response length', async () => {
            const agent = createClaudeAgent({});
            await agent.handleInput([mockMessageContext]);

            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.objectContaining({
                    contextCount:   1,
                    responseLength: expect.any(Number),
                    msg:            expect.stringContaining('Batch processing'),
                })
            );
        });

        test('should log tool usage from assistant messages', async () => {
            mockQueryImpl.mockImplementation((_params: unknown) => {
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
            await agent.handleInput([mockMessageContext]);

            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({
                    module: 'memory',
                    tool:   'view',
                    args:   { path: '/memories/test' },
                })
            );
        });

        test('should log multiple tool uses from a single assistant message', async () => {
            mockQueryImpl.mockImplementation((_params: unknown) => {
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
            await agent.handleInput([mockMessageContext]);

            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({
                    module: 'memory',
                    tool:   'view',
                    args:   { path: '/memories/test' },
                })
            );
            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({
                    module: 'memory',
                    tool:   'store',
                    args:   { path: '/memories/new', content: 'data' },
                })
            );
        });

        test('should not log tool usage for messages without tool_use blocks', async () => {
            mockQueryImpl.mockImplementation((_params: unknown) => {
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
            await agent.handleInput([mockMessageContext]);

            // Should only have stream event log, not tool call log
            const toolCallCalls = mockLogger.debug.mock.calls.filter(call => call[0] && typeof call[0] === 'object' && 'toolName' in call[0]);
            expect(toolCallCalls).toHaveLength(0);
        });
    });

    describe('timezone localization in message timestamps', () => {
        test('should format message timestamps with timezone when loadUserTimezone returns timezone', async () => {
            // Mock loadUserTimezone to return America/Los_Angeles
            (mockContextBuilder.loadUserTimezone as ReturnType<typeof mock>).mockResolvedValue('America/Los_Angeles');

            const agent = createClaudeAgent({
                contextBuilder: mockContextBuilder,
            });

            await agent.handleInput([mockMessageContext]);

            const callArgs = mockQuery.mock.calls[0][0] as Record<string, unknown>;
            const prompt = callArgs.prompt as string;

            // Should contain dual-time format with local + UTC
            expect(prompt).toContain('2025-01-15T04:00:00 America/Los_Angeles (UTC: 2025-01-15T12:00:00Z)');
            expect(prompt).toContain('User @111222333 in #987654321 at');
        });

        test('should format message timestamps without timezone when loadUserTimezone returns undefined', async () => {
            // Mock loadUserTimezone to return undefined
            (mockContextBuilder.loadUserTimezone as ReturnType<typeof mock>).mockResolvedValue(undefined);

            const agent = createClaudeAgent({
                contextBuilder: mockContextBuilder,
            });

            await agent.handleInput([mockMessageContext]);

            const callArgs = mockQuery.mock.calls[0][0] as Record<string, unknown>;
            const prompt = callArgs.prompt as string;

            // Should use original UTC timestamp format
            expect(prompt).toContain('User @111222333 in #987654321 at 2025-01-15T12:00:00 UTC (UTC: 2025-01-15T12:00:00Z): Hello Claude!');
        });
    });
});
