/* eslint-disable @typescript-eslint/no-explicit-any -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @stylistic/max-statements-per-line, @typescript-eslint/no-unsafe-argument -- Test mocks */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { constant as _constant } from 'lodash';
import { createStatusMiddleware } from '@/integrations/discord/presence/middleware';
import type { PresencePhase } from '@/integrations/discord/presence/types';
import type { AgentStreamEvent } from '@/agent/types';
import type { DiscordMessageContext } from '@/integrations/discord/types';

describe('StatusMiddleware', () => {
    let mockPresenceManager: any;
    let mockAgent: any;
    let mockLogger: any;
    let messageContext: DiscordMessageContext;

    beforeEach(() => {
        mockPresenceManager = {
            updatePhase: mock(async () => undefined),
            start:       mock(() => undefined),
            stop:        mock(() => undefined),
        };

        mockAgent = {
            chat: mock(_constant(Promise.resolve('Test response'))),
        };

        mockLogger = {
            debug: mock(() => undefined),
            warn:  mock(() => undefined),
            error: mock(() => undefined),
            info:  mock(() => undefined),
        };

        messageContext = {
            messageId: 'msg-123',
            channelId: 'channel-456' as any,
            userId:    'user-789' as any,
            guildId:   'guild-101' as any,
            content:   'Test message',
            timestamp: new Date().toISOString(),
        };
    });

    describe('event mapping to presence phases', () => {
        it('should map assistant event to thinking phase', async () => {
            // Create middleware that will receive stream events
            const events: AgentStreamEvent[] = [];
            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    const event: AgentStreamEvent = { type: 'assistant' };
                    events.push(event);
                    if(onEvent) { onEvent(event); }
                    return 'Response';
                }),
            };

            const middleware = createStatusMiddleware({
                presenceManager: mockPresenceManager,
                agent:           wrappedAgent as any,
                logger:          mockLogger,
            });

            await middleware(messageContext);

            // Should update to thinking phase when assistant event occurs
            expect(mockPresenceManager.updatePhase).toHaveBeenCalledWith(
                expect.objectContaining({ type: 'thinking' })
            );
        });

        it('should map tool_progress event to using_tool phase with tool name', async () => {
            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        onEvent({ type: 'tool_progress', tool_name: 'mcp__memory__search' });
                    }
                    return 'Response';
                }),
            };

            const middleware = createStatusMiddleware({
                presenceManager: mockPresenceManager,
                agent:           wrappedAgent as any,
                logger:          mockLogger,
            });

            await middleware(messageContext);

            expect(mockPresenceManager.updatePhase).toHaveBeenCalledWith(
                expect.objectContaining({
                    type:     'using_tool',
                    toolName: 'mcp__memory__search'
                })
            );
        });

        it('should map assistant event with delta text to responding phase', async () => {
            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        onEvent({ type: 'assistant', delta: { text: 'Hello' } });
                    }
                    return 'Response';
                }),
            };

            const middleware = createStatusMiddleware({
                presenceManager: mockPresenceManager,
                agent:           wrappedAgent as any,
                logger:          mockLogger,
            });

            await middleware(messageContext);

            expect(mockPresenceManager.updatePhase).toHaveBeenCalledWith(
                expect.objectContaining({ type: 'responding' })
            );
        });

        it('should map result event to idle phase', async () => {
            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        onEvent({ type: 'result', subtype: 'success' });
                    }
                    return 'Response';
                }),
            };

            const middleware = createStatusMiddleware({
                presenceManager: mockPresenceManager,
                agent:           wrappedAgent as any,
                logger:          mockLogger,
            });

            await middleware(messageContext);

            expect(mockPresenceManager.updatePhase).toHaveBeenCalledWith(
                expect.objectContaining({ type: 'idle' })
            );
        });
    });

    describe('typing indicator management', () => {
        it('should start typing before processing', async () => {
            const mockChannel = {
                sendTyping: mock(async () => undefined),
            };

            const middleware = createStatusMiddleware({
                presenceManager: mockPresenceManager,
                agent:           mockAgent,
                logger:          mockLogger,
            });

            await middleware(messageContext, mockChannel as any);

            expect(mockChannel.sendTyping).toHaveBeenCalled();
        });

        it('should stop typing after completion', async () => {
            const mockChannel = {
                sendTyping: mock(async () => undefined),
            };

            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        onEvent({ type: 'result', subtype: 'success' });
                    }
                    return 'Response';
                }),
            };

            const middleware = createStatusMiddleware({
                presenceManager: mockPresenceManager,
                agent:           wrappedAgent as any,
                logger:          mockLogger,
            });

            await middleware(messageContext, mockChannel as any);

            // Typing started
            expect(mockChannel.sendTyping).toHaveBeenCalled();

            // Should transition to idle after result event (which stops typing)
            expect(mockPresenceManager.updatePhase).toHaveBeenCalledWith(
                expect.objectContaining({ type: 'idle' })
            );
        });
    });

    describe('error handling', () => {
        it('should handle errors gracefully and clear presence', async () => {
            const errorAgent = {
                chat: mock(async () => {
                    throw new Error('Test error');
                }),
            };

            const middleware = createStatusMiddleware({
                presenceManager: mockPresenceManager,
                agent:           errorAgent as any,
                logger:          mockLogger,
            });

            const result = await middleware(messageContext);

            // Should return null on error
            expect(result).toBe(null);

            // Should log error
            expect(mockLogger.error).toHaveBeenCalled();

            // Should transition to idle on error
            expect(mockPresenceManager.updatePhase).toHaveBeenCalledWith(
                expect.objectContaining({ type: 'idle' })
            );
        });

        it('should handle stream callback errors without crashing', async () => {
            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        // This should not crash even if callback throws
                        onEvent({ type: 'assistant' });
                    }
                    return 'Response';
                }),
            };

            // Presence manager that throws
            const errorPresenceManager = {
                updatePhase: mock(async () => {
                    throw new Error('Presence update failed');
                }),
                start: mock(() => undefined),
                stop:  mock(() => undefined),
            };

            const middleware = createStatusMiddleware({
                presenceManager: errorPresenceManager,
                agent:           wrappedAgent as any,
                logger:          mockLogger,
            });

            // Should not throw (errors caught internally)
            const result = await middleware(messageContext);
            expect(result).toBe('Response');
        });
    });

    describe('concurrent message handling', () => {
        it('should handle concurrent messages independently', async () => {
            let callbackCount = 0;
            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        callbackCount++;
                        onEvent({ type: 'assistant' });
                    }
                    return `Response ${callbackCount}`;
                }),
            };

            const middleware = createStatusMiddleware({
                presenceManager: mockPresenceManager,
                agent:           wrappedAgent as any,
                logger:          mockLogger,
            });

            const context2 = { ...messageContext, messageId: 'msg-456' as any };

            // Process two messages concurrently
            const [result1, result2] = await Promise.all([
                middleware(messageContext),
                middleware(context2),
            ]);

            expect(result1).toBe('Response 1');
            expect(result2).toBe('Response 2');
            expect(wrappedAgent.chat).toHaveBeenCalledTimes(2);
        });
    });

    describe('backward compatibility', () => {
        it('should work with agents that do not support stream callbacks', async () => {
            // Agent that doesn't accept onEvent parameter
            const legacyAgent = {
                chat: mock(_constant(Promise.resolve('Response'))),
            };

            const middleware = createStatusMiddleware({
                presenceManager: mockPresenceManager,
                agent:           legacyAgent as any,
                logger:          mockLogger,
            });

            const result = await middleware(messageContext);

            expect(result).toBe('Response');
            expect(legacyAgent.chat).toHaveBeenCalled();
        });
    });

    describe('tool name extraction', () => {
        it('should extract tool name from tool_progress events', async () => {
            const toolNames: string[] = [];
            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        onEvent({ type: 'tool_progress', tool_name: 'mcp__memory__view' });
                        onEvent({ type: 'tool_progress', tool_name: 'mcp__memory__store' });
                    }
                    return 'Response';
                }),
            };

            const capturingPresenceManager = {
                updatePhase: mock(async (phase: PresencePhase) => {
                    if(phase.type === 'using_tool') {
                        toolNames.push(phase.toolName);
                    }
                }),
                start: mock(() => undefined),
                stop:  mock(() => undefined),
            };

            const middleware = createStatusMiddleware({
                presenceManager: capturingPresenceManager as any,
                agent:           wrappedAgent as any,
                logger:          mockLogger,
            });

            await middleware(messageContext);

            expect(toolNames).toEqual(['mcp__memory__view', 'mcp__memory__store']);
        });

        it('should handle missing tool_name gracefully', async () => {
            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        // Tool progress without tool_name
                        onEvent({ type: 'tool_progress' });
                    }
                    return 'Response';
                }),
            };

            const middleware = createStatusMiddleware({
                presenceManager: mockPresenceManager,
                agent:           wrappedAgent as any,
                logger:          mockLogger,
            });

            // Should not crash
            await middleware(messageContext);

            // Should still update to using_tool with 'unknown' as fallback
            expect(mockPresenceManager.updatePhase).toHaveBeenCalledWith(
                expect.objectContaining({
                    type:     'using_tool',
                    toolName: 'unknown'
                })
            );
        });
    });
});
