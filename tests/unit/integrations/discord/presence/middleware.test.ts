/* eslint-disable @typescript-eslint/no-explicit-any -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @stylistic/max-statements-per-line, @typescript-eslint/no-unsafe-argument -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-call -- Test mocks filter call */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { constant as _constant, filter as _filter } from 'lodash';
import { createStatusMiddleware } from '@/integrations/discord/presence/middleware';
import type { PresencePhase } from '@/integrations/discord/presence/types';
import type { AgentStreamEvent } from '@/agent/types';
import type { DiscordMessageContext } from '@/integrations/discord/types';

// Helper to wait for async safeUpdatePhase promises to settle
const flushPromises = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

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

    describe('logging behavior', () => {
        it('should log debug message with messageId when typing indicator starts', async () => {
            const mockChannel = {
                sendTyping: mock(async () => undefined),
            };

            const middleware = createStatusMiddleware({
                presenceManager: mockPresenceManager,
                agent:           mockAgent,
                logger:          mockLogger,
            });

            await middleware(messageContext, mockChannel as any);

            expect(mockLogger.debug).toHaveBeenCalledWith(
                { messageId: 'msg-123' },
                'Started typing indicator'
            );
        });

        it('should log error with correct context when main error occurs', async () => {
            const testError = new Error('Test error');
            const errorAgent = {
                chat: mock(async () => {
                    throw testError;
                }),
            };

            const middleware = createStatusMiddleware({
                presenceManager: mockPresenceManager,
                agent:           errorAgent as any,
                logger:          mockLogger,
            });

            await middleware(messageContext);

            expect(mockLogger.error).toHaveBeenCalledWith(
                { error: testError, messageId: 'msg-123' },
                'Error processing message in status middleware'
            );
        });

        it('should log error when stream event presence update fails', async () => {
            const presenceError = new Error('Presence update failed');
            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        onEvent({ type: 'assistant' });
                    }
                    return 'Response';
                }),
            };

            const errorPresenceManager = {
                updatePhase: mock(async () => {
                    throw presenceError;
                }),
                start: mock(() => undefined),
                stop:  mock(() => undefined),
            };

            const middleware = createStatusMiddleware({
                presenceManager: errorPresenceManager,
                agent:           wrappedAgent as any,
                logger:          mockLogger,
            });

            await middleware(messageContext);
            // Wait for async safeUpdatePhase to complete
            await flushPromises();

            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.objectContaining({
                    error:     presenceError,
                    event:     { type: 'assistant' },
                    messageId: 'msg-123'
                }),
                'Failed to update presence from stream event'
            );
        });

        it('should log error when final idle presence update fails', async () => {
            const presenceError = new Error('Final idle update failed');
            const wrappedAgent = {
                chat: mock(_constant(Promise.resolve('Response'))),
            };

            const errorPresenceManager = {
                updatePhase: mock(async () => {
                    throw presenceError;
                }),
                start: mock(() => undefined),
                stop:  mock(() => undefined),
            };

            const middleware = createStatusMiddleware({
                presenceManager: errorPresenceManager,
                agent:           wrappedAgent as any,
                logger:          mockLogger,
            });

            const result = await middleware(messageContext);

            // Should still return the response
            expect(result).toBe('Response');
            expect(mockLogger.error).toHaveBeenCalledWith(
                { error: presenceError, messageId: 'msg-123' },
                'Failed to update presence to idle after completion'
            );
        });

        it('should log error when idle update fails after main error', async () => {
            const mainError = new Error('Main error');
            const presenceError = new Error('Presence error after main error');
            const errorAgent = {
                chat: mock(async () => {
                    throw mainError;
                }),
            };

            const errorPresenceManager = {
                updatePhase: mock(async () => {
                    throw presenceError;
                }),
                start: mock(() => undefined),
                stop:  mock(() => undefined),
            };

            const middleware = createStatusMiddleware({
                presenceManager: errorPresenceManager,
                agent:           errorAgent as any,
                logger:          mockLogger,
            });

            await middleware(messageContext);

            // Should log main error
            expect(mockLogger.error).toHaveBeenCalledWith(
                { error: mainError, messageId: 'msg-123' },
                'Error processing message in status middleware'
            );
            // Should also log presence error
            expect(mockLogger.error).toHaveBeenCalledWith(
                { error: presenceError, messageId: 'msg-123' },
                'Failed to update presence to idle after error'
            );
        });
    });

    describe('no channel handling', () => {
        it('should not call sendTyping when channel is undefined', async () => {
            const middleware = createStatusMiddleware({
                presenceManager: mockPresenceManager,
                agent:           mockAgent,
                logger:          mockLogger,
            });

            // Call without channel argument
            const result = await middleware(messageContext);

            // Should still complete successfully
            expect(result).toBe('Test response');
            // Logger.debug for typing should not be called
            expect(mockLogger.debug).not.toHaveBeenCalledWith(
                expect.anything(),
                'Started typing indicator'
            );
        });

        it('should process message normally when channel is undefined', async () => {
            const phases: PresencePhase[] = [];
            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        onEvent({ type: 'assistant', delta: { text: 'Hello' } });
                    }
                    return 'Response';
                }),
            };

            const capturingPresenceManager = {
                updatePhase: mock(async (phase: PresencePhase) => {
                    phases.push(phase);
                }),
                start: mock(() => undefined),
                stop:  mock(() => undefined),
            };

            const middleware = createStatusMiddleware({
                presenceManager: capturingPresenceManager as any,
                agent:           wrappedAgent as any,
                logger:          mockLogger,
            });

            await middleware(messageContext); // No channel

            // Should still update presence phases
            expect(phases.some(p => p.type === 'responding')).toBe(true);
            expect(phases.some(p => p.type === 'idle')).toBe(true);
        });
    });

    describe('conditional branch coverage for event types', () => {
        it('should map assistant event with empty delta object to thinking phase', async () => {
            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        // Empty delta object - should trigger thinking, not responding
                        onEvent({ type: 'assistant', delta: {} });
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
                expect.objectContaining({ type: 'thinking' })
            );
        });

        it('should map assistant event with empty string delta.text to thinking phase', async () => {
            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        // Empty string is falsy - should trigger thinking, not responding
                        onEvent({ type: 'assistant', delta: { text: '' } });
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
                expect.objectContaining({ type: 'thinking' })
            );
        });

        it('should ignore unknown event types', async () => {
            const phases: PresencePhase[] = [];
            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        // Unknown event type should be ignored
                        onEvent({ type: 'unknown_type' } as any);
                    }
                    return 'Response';
                }),
            };

            const capturingPresenceManager = {
                updatePhase: mock(async (phase: PresencePhase) => {
                    phases.push(phase);
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

            // Only the final idle transition should be recorded
            expect(phases.length).toBe(1);
            expect(phases[0]?.type).toBe('idle');
        });

        it('should verify result event triggers idle with since date', async () => {
            const phases: PresencePhase[] = [];
            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        onEvent({ type: 'result', subtype: 'success' });
                    }
                    return 'Response';
                }),
            };

            const capturingPresenceManager = {
                updatePhase: mock(async (phase: PresencePhase) => {
                    phases.push(phase);
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
            await flushPromises();

            // Should have result event idle and final idle
            const idlePhases = phases.filter(p => p.type === 'idle');
            expect(idlePhases.length).toBeGreaterThanOrEqual(1);
            // Each idle phase should have a since Date
            for(const phase of idlePhases) {
                if(phase.type === 'idle') {
                    expect(phase.since).toBeInstanceOf(Date);
                }
            }
        });

        it('should correctly call updatePhase with idle type string on result event', async () => {
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
            await flushPromises();

            // Check that updatePhase was called with type exactly 'idle'
            const calls = mockPresenceManager.updatePhase.mock.calls;
            const idleCalls = _filter(calls, (call: any[]) => call[0]?.type === 'idle');
            expect(idleCalls.length).toBeGreaterThanOrEqual(1);
            // Verify the string is exactly 'idle', not empty string
            expect(idleCalls[0]?.[0].type).toBe('idle');
        });
    });

    describe('final idle transition after completion', () => {
        it('should call updatePhase with idle after chat completes', async () => {
            const phases: PresencePhase[] = [];
            const wrappedAgent = {
                chat: mock(async () => 'Response'),
            };

            const capturingPresenceManager = {
                updatePhase: mock(async (phase: PresencePhase) => {
                    phases.push(phase);
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

            // Should have at least one idle phase from final transition
            const idlePhases = phases.filter(p => p.type === 'idle');
            expect(idlePhases.length).toBeGreaterThanOrEqual(1);
        });

        it('should verify final idle update has since property as Date', async () => {
            const phases: PresencePhase[] = [];
            const wrappedAgent = {
                chat: mock(async () => 'Response'),
            };

            const capturingPresenceManager = {
                updatePhase: mock(async (phase: PresencePhase) => {
                    phases.push(phase);
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

            const lastPhase = phases[phases.length - 1];
            expect(lastPhase?.type).toBe('idle');
            if(lastPhase?.type === 'idle') {
                expect(lastPhase.since).toBeInstanceOf(Date);
            }
        });
    });

    describe('idle transition after error', () => {
        it('should call updatePhase with idle after agent.chat throws', async () => {
            const phases: PresencePhase[] = [];
            const errorAgent = {
                chat: mock(async () => {
                    throw new Error('Test error');
                }),
            };

            const capturingPresenceManager = {
                updatePhase: mock(async (phase: PresencePhase) => {
                    phases.push(phase);
                }),
                start: mock(() => undefined),
                stop:  mock(() => undefined),
            };

            const middleware = createStatusMiddleware({
                presenceManager: capturingPresenceManager as any,
                agent:           errorAgent as any,
                logger:          mockLogger,
            });

            await middleware(messageContext);

            // Should still transition to idle
            const idlePhases = phases.filter(p => p.type === 'idle');
            expect(idlePhases.length).toBeGreaterThanOrEqual(1);
        });

        it('should verify idle transition after error has since Date', async () => {
            const phases: PresencePhase[] = [];
            const errorAgent = {
                chat: mock(async () => {
                    throw new Error('Test error');
                }),
            };

            const capturingPresenceManager = {
                updatePhase: mock(async (phase: PresencePhase) => {
                    phases.push(phase);
                }),
                start: mock(() => undefined),
                stop:  mock(() => undefined),
            };

            const middleware = createStatusMiddleware({
                presenceManager: capturingPresenceManager as any,
                agent:           errorAgent as any,
                logger:          mockLogger,
            });

            await middleware(messageContext);

            const lastPhase = phases[phases.length - 1];
            expect(lastPhase?.type).toBe('idle');
            if(lastPhase?.type === 'idle') {
                expect(lastPhase.since).toBeInstanceOf(Date);
            }
        });
    });

    describe('sendTyping error handling', () => {
        it('should handle sendTyping errors gracefully and return null', async () => {
            const typingError = new Error('Typing failed');
            const mockChannel = {
                sendTyping: mock(async () => {
                    throw typingError;
                }),
            };

            const middleware = createStatusMiddleware({
                presenceManager: mockPresenceManager,
                agent:           mockAgent,
                logger:          mockLogger,
            });

            // Error is caught in try/catch, returns null
            const result = await middleware(messageContext, mockChannel as any);

            expect(result).toBe(null);
            expect(mockLogger.error).toHaveBeenCalledWith(
                { error: typingError, messageId: 'msg-123' },
                'Error processing message in status middleware'
            );
        });
    });

    describe('tool_progress event mutant killers', () => {
        it('should not treat non-tool_progress event as tool_progress', async () => {
            const phases: PresencePhase[] = [];
            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        // Only send assistant event, no tool_progress
                        onEvent({ type: 'assistant', delta: { text: 'Hello' } });
                    }
                    return 'Response';
                }),
            };

            const capturingPresenceManager = {
                updatePhase: mock(async (phase: PresencePhase) => {
                    phases.push(phase);
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
            await flushPromises();

            // Should have responding and idle phases, but no using_tool
            const toolPhases = phases.filter(p => p.type === 'using_tool');
            expect(toolPhases.length).toBe(0);
        });
    });

    describe('result event mutant killers', () => {
        it('should not treat non-result event as result event', async () => {
            const phases: PresencePhase[] = [];
            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        // Only send assistant event with text, no result
                        onEvent({ type: 'assistant', delta: { text: 'Hello' } });
                    }
                    return 'Response';
                }),
            };

            const capturingPresenceManager = {
                updatePhase: mock(async (phase: PresencePhase) => {
                    phases.push(phase);
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
            await flushPromises();

            // Should have responding from assistant event
            const respondingPhases = phases.filter(p => p.type === 'responding');
            expect(respondingPhases.length).toBe(1);

            // Should have exactly one idle phase (from final transition, not from result event)
            // The idle is added at the end by the middleware, not by a result event
            const idlePhases = phases.filter(p => p.type === 'idle');
            expect(idlePhases.length).toBe(1);
        });

        it('should add idle phase when result event occurs', async () => {
            const phases: PresencePhase[] = [];
            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        onEvent({ type: 'result', subtype: 'success' });
                    }
                    return 'Response';
                }),
            };

            const capturingPresenceManager = {
                updatePhase: mock(async (phase: PresencePhase) => {
                    phases.push(phase);
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
            await flushPromises();

            // Should have at least 2 idle phases (one from result event, one from final transition)
            const idlePhases = phases.filter(p => p.type === 'idle');
            expect(idlePhases.length).toBeGreaterThanOrEqual(2);
        });
    });

    describe('tool_name nullish coalescing edge cases', () => {
        it('should use "unknown" when tool_name is null', async () => {
            const toolNames: string[] = [];
            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        // Explicitly pass null for tool_name
                        onEvent({ type: 'tool_progress', tool_name: null as any });
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
            await flushPromises();

            // Null should be replaced with 'unknown' via nullish coalescing
            expect(toolNames).toEqual(['unknown']);
        });

        it('should keep empty string tool_name (not replace with unknown)', async () => {
            const toolNames: string[] = [];
            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        // Empty string is not nullish, should be preserved
                        onEvent({ type: 'tool_progress', tool_name: '' });
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
            await flushPromises();

            // Empty string is kept (nullish coalescing only replaces null/undefined)
            expect(toolNames).toEqual(['']);
        });

        it('should use "unknown" when tool_name is undefined', async () => {
            const toolNames: string[] = [];
            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        // Explicitly pass undefined for tool_name
                        onEvent({ type: 'tool_progress', tool_name: undefined });
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
            await flushPromises();

            // Undefined should be replaced with 'unknown'
            expect(toolNames).toEqual(['unknown']);
        });

        it('should preserve actual tool_name value', async () => {
            const toolNames: string[] = [];
            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        onEvent({ type: 'tool_progress', tool_name: 'my_actual_tool' });
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
            await flushPromises();

            // Actual value should be preserved
            expect(toolNames).toEqual(['my_actual_tool']);
        });
    });

    describe('phase type string literal verification', () => {
        it('should use exact string "thinking" not empty string', async () => {
            const phases: PresencePhase[] = [];
            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        onEvent({ type: 'assistant' }); // No delta.text - triggers thinking
                    }
                    return 'Response';
                }),
            };

            const capturingPresenceManager = {
                updatePhase: mock(async (phase: PresencePhase) => {
                    phases.push(phase);
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
            await flushPromises();

            const thinkingPhase = phases.find(p => p.type === 'thinking');
            expect(thinkingPhase).toBeDefined();
            expect(thinkingPhase!.type).toBe('thinking');
            expect(thinkingPhase!.type).not.toBe('');
            expect(thinkingPhase!.type.length).toBe(8); // 'thinking' has 8 chars
        });

        it('should use exact string "responding" not empty string', async () => {
            const phases: PresencePhase[] = [];
            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        onEvent({ type: 'assistant', delta: { text: 'Hello' } });
                    }
                    return 'Response';
                }),
            };

            const capturingPresenceManager = {
                updatePhase: mock(async (phase: PresencePhase) => {
                    phases.push(phase);
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
            await flushPromises();

            const respondingPhase = phases.find(p => p.type === 'responding');
            expect(respondingPhase).toBeDefined();
            expect(respondingPhase!.type).toBe('responding');
            expect(respondingPhase!.type).not.toBe('');
            expect(respondingPhase!.type.length).toBe(10); // 'responding' has 10 chars
        });

        it('should use exact string "using_tool" not empty string', async () => {
            const phases: PresencePhase[] = [];
            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        onEvent({ type: 'tool_progress', tool_name: 'test_tool' });
                    }
                    return 'Response';
                }),
            };

            const capturingPresenceManager = {
                updatePhase: mock(async (phase: PresencePhase) => {
                    phases.push(phase);
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
            await flushPromises();

            const toolPhase = phases.find(p => p.type === 'using_tool');
            expect(toolPhase).toBeDefined();
            expect(toolPhase!.type).toBe('using_tool');
            expect(toolPhase!.type).not.toBe('');
            expect(toolPhase!.type.length).toBe(10); // 'using_tool' has 10 chars
        });

        it('should use exact string "idle" not empty string', async () => {
            const phases: PresencePhase[] = [];
            const wrappedAgent = {
                chat: mock(async () => 'Response'),
            };

            const capturingPresenceManager = {
                updatePhase: mock(async (phase: PresencePhase) => {
                    phases.push(phase);
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

            const idlePhase = phases.find(p => p.type === 'idle');
            expect(idlePhase).toBeDefined();
            expect(idlePhase!.type).toBe('idle');
            expect(idlePhase!.type).not.toBe('');
            expect(idlePhase!.type.length).toBe(4); // 'idle' has 4 chars
        });
    });

    describe('Date instance verification for all phases', () => {
        it('should include startedAt as Date for thinking phase', async () => {
            const phases: PresencePhase[] = [];
            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        onEvent({ type: 'assistant' });
                    }
                    return 'Response';
                }),
            };

            const capturingPresenceManager = {
                updatePhase: mock(async (phase: PresencePhase) => {
                    phases.push(phase);
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
            await flushPromises();

            const thinkingPhase = phases.find(p => p.type === 'thinking');
            expect(thinkingPhase).toBeDefined();
            if(thinkingPhase?.type === 'thinking') {
                expect(thinkingPhase.startedAt).toBeInstanceOf(Date);
            }
        });

        it('should include startedAt as Date for responding phase', async () => {
            const phases: PresencePhase[] = [];
            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        onEvent({ type: 'assistant', delta: { text: 'Hi' } });
                    }
                    return 'Response';
                }),
            };

            const capturingPresenceManager = {
                updatePhase: mock(async (phase: PresencePhase) => {
                    phases.push(phase);
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
            await flushPromises();

            const respondingPhase = phases.find(p => p.type === 'responding');
            expect(respondingPhase).toBeDefined();
            if(respondingPhase?.type === 'responding') {
                expect(respondingPhase.startedAt).toBeInstanceOf(Date);
            }
        });

        it('should include startedAt as Date for using_tool phase', async () => {
            const phases: PresencePhase[] = [];
            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        onEvent({ type: 'tool_progress', tool_name: 'test' });
                    }
                    return 'Response';
                }),
            };

            const capturingPresenceManager = {
                updatePhase: mock(async (phase: PresencePhase) => {
                    phases.push(phase);
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
            await flushPromises();

            const toolPhase = phases.find(p => p.type === 'using_tool');
            expect(toolPhase).toBeDefined();
            if(toolPhase?.type === 'using_tool') {
                expect(toolPhase.startedAt).toBeInstanceOf(Date);
            }
        });

        it('should include since as Date for result event idle phase', async () => {
            const phases: PresencePhase[] = [];
            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        onEvent({ type: 'result', subtype: 'success' });
                    }
                    return 'Response';
                }),
            };

            const capturingPresenceManager = {
                updatePhase: mock(async (phase: PresencePhase) => {
                    phases.push(phase);
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
            await flushPromises();

            const idlePhases = phases.filter(p => p.type === 'idle');
            expect(idlePhases.length).toBeGreaterThanOrEqual(1);
            for(const phase of idlePhases) {
                if(phase.type === 'idle') {
                    expect(phase.since).toBeInstanceOf(Date);
                }
            }
        });
    });

    describe('error isolation edge cases', () => {
        it('should return response even when safeUpdatePhase throws multiple times', async () => {
            let callCount = 0;
            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        onEvent({ type: 'assistant' });
                        onEvent({ type: 'assistant', delta: { text: 'Hi' } });
                        onEvent({ type: 'tool_progress', tool_name: 'test' });
                        onEvent({ type: 'result', subtype: 'success' });
                    }
                    return 'Response';
                }),
            };

            const errorPresenceManager = {
                updatePhase: mock(async () => {
                    callCount++;
                    throw new Error(`Presence error ${callCount}`);
                }),
                start: mock(() => undefined),
                stop:  mock(() => undefined),
            };

            const middleware = createStatusMiddleware({
                presenceManager: errorPresenceManager,
                agent:           wrappedAgent as any,
                logger:          mockLogger,
            });

            const result = await middleware(messageContext);
            await flushPromises();

            // Response should still be returned despite multiple errors
            expect(result).toBe('Response');
            // Errors should be logged
            expect(mockLogger.error).toHaveBeenCalled();
        });

        it('should still attempt idle transition when agent throws after events', async () => {
            const phases: PresencePhase[] = [];
            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        onEvent({ type: 'assistant', delta: { text: 'Starting...' } });
                    }
                    throw new Error('Agent failed mid-stream');
                }),
            };

            const capturingPresenceManager = {
                updatePhase: mock(async (phase: PresencePhase) => {
                    phases.push(phase);
                }),
                start: mock(() => undefined),
                stop:  mock(() => undefined),
            };

            const middleware = createStatusMiddleware({
                presenceManager: capturingPresenceManager as any,
                agent:           wrappedAgent as any,
                logger:          mockLogger,
            });

            const result = await middleware(messageContext);
            await flushPromises();

            expect(result).toBe(null);
            // Should have responding phase from before error
            expect(phases.some(p => p.type === 'responding')).toBe(true);
            // Should have idle phase from error recovery
            expect(phases.some(p => p.type === 'idle')).toBe(true);
        });

        it('should return null and log when sendTyping fails before agent.chat', async () => {
            const typingError = new Error('sendTyping failed');
            const mockChannel = {
                sendTyping: mock(async () => {
                    throw typingError;
                }),
            };

            const middleware = createStatusMiddleware({
                presenceManager: mockPresenceManager,
                agent:           mockAgent,
                logger:          mockLogger,
            });

            const result = await middleware(messageContext, mockChannel as any);

            expect(result).toBe(null);
            // agent.chat should not be called because sendTyping is before it in try block
            expect(mockAgent.chat).not.toHaveBeenCalled();
            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.objectContaining({ error: typingError }),
                'Error processing message in status middleware'
            );
        });
    });

    describe('assistant event type discrimination', () => {
        it('should distinguish assistant event from tool_progress by type field', async () => {
            const phases: PresencePhase[] = [];
            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        // Send both types to verify correct discrimination
                        onEvent({ type: 'assistant', delta: { text: 'Hello' } });
                        onEvent({ type: 'tool_progress', tool_name: 'test' });
                    }
                    return 'Response';
                }),
            };

            const capturingPresenceManager = {
                updatePhase: mock(async (phase: PresencePhase) => {
                    phases.push(phase);
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
            await flushPromises();

            // Should have exactly one responding and one using_tool
            const respondingPhases = phases.filter(p => p.type === 'responding');
            const toolPhases = phases.filter(p => p.type === 'using_tool');

            expect(respondingPhases.length).toBe(1);
            expect(toolPhases.length).toBe(1);
        });

        it('should distinguish result event from assistant by type field', async () => {
            const phases: PresencePhase[] = [];
            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        onEvent({ type: 'assistant' });
                        onEvent({ type: 'result', subtype: 'success' });
                    }
                    return 'Response';
                }),
            };

            const capturingPresenceManager = {
                updatePhase: mock(async (phase: PresencePhase) => {
                    phases.push(phase);
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
            await flushPromises();

            // Should have one thinking and multiple idle (from result and final)
            const thinkingPhases = phases.filter(p => p.type === 'thinking');
            const idlePhases = phases.filter(p => p.type === 'idle');

            expect(thinkingPhases.length).toBe(1);
            expect(idlePhases.length).toBeGreaterThanOrEqual(2);
        });
    });
});
