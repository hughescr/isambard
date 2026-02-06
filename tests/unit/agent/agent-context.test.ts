/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- Test mocks require unsafe type operations */
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import _ from 'lodash';
import * as agentSdk from '@anthropic-ai/claude-agent-sdk';
import { mockLogger } from '../../setup';
import { createClaudeAgent } from '../../../src/agent/agent';
import type { DiscordMessageContext } from '../../../src/integrations/discord/types';
import { createGuildId, createChannelId, createUserId } from '../../../src/integrations/discord/types';
import type { ContextBuilder } from '../../../src/agent/context-builder';
import * as timeUtils from '../../../src/utils/time';

describe('createClaudeAgent context integration', () => {
    let mockMessageContext: DiscordMessageContext;
    let mockContextBuilder: ContextBuilder;
    let querySpy: ReturnType<typeof spyOn>;

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

    describe('context builder integration', () => {
        test('should load core identity when contextBuilder provided', async () => {
            (mockContextBuilder.loadCoreIdentity as ReturnType<typeof mock>).mockResolvedValue('I am Isambard, a helpful AI assistant.');

            const agent = createClaudeAgent({
                contextBuilder: mockContextBuilder,
            });

            await agent.handleInput([mockMessageContext]);

            expect(querySpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    options: expect.objectContaining({
                        systemPrompt: expect.stringContaining('I am Isambard, a helpful AI assistant.'),
                    }),
                })
            );
        });

        test('should load recent context when contextBuilder provided', async () => {
            (mockContextBuilder.loadRecentContext as ReturnType<typeof mock>).mockResolvedValue([
                'User likes coffee',
                'User is working on TypeScript',
            ]);

            const agent = createClaudeAgent({
                contextBuilder: mockContextBuilder,
            });

            await agent.handleInput([mockMessageContext]);

            expect(querySpy).toHaveBeenCalledWith(
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
            expect(querySpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    options: expect.objectContaining({
                        systemPrompt: expect.stringContaining('You are Isambard'),
                    }),
                })
            );
            expect(querySpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    options: expect.objectContaining({
                        systemPrompt: expect.not.stringContaining('## Who You Are'),
                    }),
                })
            );
        });

        test('should handle empty recent context', async () => {
            (mockContextBuilder.loadRecentContext as ReturnType<typeof mock>).mockResolvedValue([]);

            const agent = createClaudeAgent({
                contextBuilder: mockContextBuilder,
            });

            await agent.handleInput([mockMessageContext]);

            // Should not have [About this user] section when no user memories
            const callArgs = querySpy.mock.calls[0][0];
            expect(callArgs.prompt).not.toContain('[About this user]');
            // But should still have the user message (with timestamp in handleInput)
            expect(callArgs.prompt).toContain('User @111222333 in #987654321 at 2025-01-15T12:00:00Z: Hello Claude!');
        });

        test('should format multiple recent memories with newline-separated bullets', async () => {
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

            await agent.handleInput([mockMessageContext]);

            // Verify the user memories section format (time section will precede it)
            expect(querySpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    prompt: expect.stringContaining('[About this user]\n- First memory\n- Second memory\n- Third memory'),
                })
            );
        });

        test('should include bot recent activities when botUserId is present and returns memories', async () => {
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

            await agent.handleInput([mockMessageContext]);

            // Verify the prompt includes the [Your recent activities] section with exact format
            expect(querySpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    prompt: expect.stringContaining('[Your recent activities]\n- Helped user debug code\n- Answered question about React'),
                })
            );
        });

        test('should not include bot activities section when botUserId returns empty memories', async () => {
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

            await agent.handleInput([mockMessageContext]);

            // Verify the prompt does NOT include [Your recent activities]
            const callArgs = querySpy.mock.calls[0][0];
            expect(callArgs.prompt).not.toContain('[Your recent activities]');
        });

        test('should not include bot activities section when botUserId is undefined', async () => {
            // Mock returns memories for user only
            (mockContextBuilder.loadRecentContext as ReturnType<typeof mock>).mockImplementation((userId: string) => {
                if(userId === '111222333') {
                    return Promise.resolve(['User preference']);
                }
                return Promise.resolve([]);
            });

            const agent = createClaudeAgent({
                contextBuilder: mockContextBuilder,
            });

            // Create context without botUserId - omit the property entirely
            const { botUserId: _removed, ...contextWithoutBot } = mockMessageContext;

            await agent.handleInput([contextWithoutBot as typeof mockMessageContext]);

            // Verify the prompt does NOT include [Your recent activities] section
            expect(querySpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    prompt: expect.not.stringContaining('[Your recent activities]'),
                })
            );
        });

        test('should include recent events when loadRecentEvents returns events', async () => {
            (mockContextBuilder.loadRecentContext as ReturnType<typeof mock>).mockResolvedValue([]);
            (mockContextBuilder.loadRecentEvents as ReturnType<typeof mock>).mockResolvedValue([
                'Server went online',
                'New user joined #general',
            ]);

            const agent = createClaudeAgent({
                contextBuilder: mockContextBuilder,
            });

            await agent.handleInput([mockMessageContext]);

            // Verify the prompt includes [Recent events] section with exact format
            expect(querySpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    prompt: expect.stringContaining('[Recent events]\n- Server went online\n- New user joined #general'),
                })
            );
        });

        test('should not include recent events section when loadRecentEvents returns empty array', async () => {
            (mockContextBuilder.loadRecentContext as ReturnType<typeof mock>).mockResolvedValue([]);
            (mockContextBuilder.loadRecentEvents as ReturnType<typeof mock>).mockResolvedValue([]);

            const agent = createClaudeAgent({
                contextBuilder: mockContextBuilder,
            });

            await agent.handleInput([mockMessageContext]);

            // Verify the prompt does NOT include [Recent events]
            const callArgs = querySpy.mock.calls[0][0];
            expect(callArgs.prompt).not.toContain('[Recent events]');
        });

        test('should handle missing contextBuilder gracefully', async () => {
            const agent = createClaudeAgent({
                // No contextBuilder provided
            });

            await agent.handleInput([mockMessageContext]);

            // Verify the prompt is just the user message without any context prefix (with timestamp in handleInput)
            const callArgs = querySpy.mock.calls[0][0];
            expect(callArgs.prompt).toBe('User @111222333 in #987654321 at 2025-01-15T12:00:00Z: Hello Claude!');

            // Verify no memory sections are included
            expect(callArgs.prompt).not.toContain('[About this user]');
            expect(callArgs.prompt).not.toContain('[Your recent activities]');
            expect(callArgs.prompt).not.toContain('[Recent events]');
        });

        test('should join all context sections with double newlines', async () => {
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

            await agent.handleInput([mockMessageContext]);

            // Verify the format with all sections joined by \n\n (time section comes first)
            const callArgs = querySpy.mock.calls[0][0];
            const prompt = callArgs.prompt as string;

            // All sections should be present and separated by double newlines
            expect(prompt).toContain('## Current Time');
            expect(prompt).toContain('[About this user]\n- User memory');
            expect(prompt).toContain('[Your recent activities]\n- Bot activity');
            expect(prompt).toContain('[Recent events]\n- Recent event');
            expect(prompt).toContain('User @111222333 in #987654321 at 2025-01-15T12:00:00Z: Hello Claude!');

            // Verify double newline separation between sections
            expect(prompt).toContain('[About this user]\n- User memory\n\n[Your recent activities]');
            expect(prompt).toContain('[Your recent activities]\n- Bot activity\n\n[Recent events]');
        });

        test('should format bot activities and events with dash-space prefix', async () => {
            // Test the "- " prefix format for both bot activities and events
            (mockContextBuilder.loadRecentContext as ReturnType<typeof mock>).mockImplementation((userId: string) => {
                if(userId === 'bot_444555666') {
                    return Promise.resolve(['Activity one', 'Activity two']);
                }
                return Promise.resolve([]);
            });
            (mockContextBuilder.loadRecentEvents as ReturnType<typeof mock>).mockResolvedValue([
                'Event one',
                'Event two',
            ]);

            const agent = createClaudeAgent({
                contextBuilder: mockContextBuilder,
            });

            await agent.handleInput([mockMessageContext]);

            const callArgs = querySpy.mock.calls[0][0];
            // Verify bot activities format
            expect(callArgs.prompt).toContain('- Activity one\n- Activity two');
            // Verify events format
            expect(callArgs.prompt).toContain('- Event one\n- Event two');
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

        test('should include time section in context prefix when contextBuilder is provided', async () => {
            const agent = createClaudeAgent({
                contextBuilder: mockContextBuilder,
            });

            await agent.handleInput([mockMessageContext]);

            expect(querySpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    prompt: expect.stringContaining('## Current Time'),
                })
            );
        });

        test('should format time section with UTC, day of week, and time of day', async () => {
            const agent = createClaudeAgent({
                contextBuilder: mockContextBuilder,
            });

            await agent.handleInput([mockMessageContext]);

            expect(querySpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    prompt: expect.stringContaining('- UTC: 2025-01-15T14:30:00.000Z (Wednesday afternoon)'),
                })
            );
        });

        test('should include time section as the first section in context prefix', async () => {
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

            await agent.handleInput([mockMessageContext]);

            const callArgs = querySpy.mock.calls[0][0];
            const prompt = callArgs.prompt as string;

            // Time section should come before user section
            const timeIndex = prompt.indexOf('## Current Time');
            const userIndex = prompt.indexOf('[About this user]');

            expect(timeIndex).toBeGreaterThanOrEqual(0);
            expect(userIndex).toBeGreaterThan(timeIndex);
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

            expect(querySpy).toHaveBeenCalledWith(
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
            const result = await agent.handleInput([mockMessageContext]);

            expect(result.response).toBe('Assistant response');
        });

        test('should return null when stream has only non-assistant messages', async () => {
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
            querySpy.mockImplementation((_params: any): any => {
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
            const result = await agent.handleInput([mockMessageContext]);

            expect(result.response).toBe('First text block\nSecond text block');
        });

        test('should trim whitespace from combined text blocks', async () => {
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
            const result = await agent.handleInput([mockMessageContext]);

            expect(result.response).toBe('Leading and trailing spaces');
        });

        test('should return null when text is only whitespace', async () => {
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
            const result = await agent.handleInput([mockMessageContext]);

            expect(result.response).toBeNull();
        });

        test('should update lastAssistantText only when text is non-empty', async () => {
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
            const result = await agent.handleInput([mockMessageContext]);

            expect(result.response).toBe('First valid response');
        });

        test('should join multiple text blocks with newlines', async () => {
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
            const result = await agent.handleInput([mockMessageContext]);

            expect(result.response).toBe('Line 1\nLine 2\nLine 3');
        });

        test('should filter out content blocks without type property', async () => {
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
            const result = await agent.handleInput([mockMessageContext]);

            expect(result.response).toBe('Has type');
        });
    });

    describe('stream event callbacks', () => {
        test('should invoke callback for each stream event', async () => {
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
            await agent.handleInput([mockMessageContext], { onStreamEvent: (event) => {
                events.push(event);
            } });

            expect(events.length).toBe(3);
            expect(events[0].type).toBe('assistant');
            expect(events[1].type).toBe('tool_progress');
            expect(events[2].type).toBe('result');
        });

        test('should receive correct event data in callback', async () => {
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
            await agent.handleInput([mockMessageContext], { onStreamEvent: (event) => {
                receivedEvent = event;
            } });

            expect(receivedEvent).toEqual({
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
            await agent.handleInput([mockMessageContext], { onStreamEvent: (event) => {
                eventTypes.push(event.type);
            } });

            expect(eventTypes).toEqual(['user', 'assistant', 'tool_progress', 'tool_result', 'result']);
        });
    });

    describe('error handling and logging', () => {
        test('should return full long responses without truncation (handlers do chunking)', async () => {
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
            const result = await agent.handleInput([mockMessageContext]);

            // Agent returns full response; Discord handlers handle chunking
            expect(result.response).toBe(longText);
            expect(result.response?.length).toBe(2000);
        });

        test('should log error with message and user details', async () => {
            const testError = new Error('Test error message');
            querySpy.mockImplementation((_params: any): any => {
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
            await agent.handleInput([mockMessageContext]);

            // Should only have stream event log, not tool call log
            const toolCallCalls = _.filter(
                mockLogger.debug.mock.calls,
                call => call[0] && _.isObject(call[0]) && 'toolName' in call[0]
            );
            expect(toolCallCalls.length).toBe(0);
        });
    });
});
