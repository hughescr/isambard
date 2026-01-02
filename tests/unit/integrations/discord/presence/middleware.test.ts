/* eslint-disable @typescript-eslint/no-explicit-any -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @stylistic/max-statements-per-line, @typescript-eslint/no-unsafe-argument -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-call -- Test mocks */
/* eslint-disable @typescript-eslint/unbound-method -- Test mocks */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { constant as _constant, endsWith as _endsWith, filter as _filter, find as _find, repeat as _repeat, some as _some, startsWith as _startsWith } from 'lodash';
import { createStatusMiddleware } from '@/integrations/discord/presence/middleware';
import type { PresencePhase, SynopsisContext } from '@/integrations/discord/presence/types';
import type { AgentStreamEvent } from '@/agent/types';
import type { DiscordMessageContext } from '@/integrations/discord/types';
import type { DynamicStatusGenerator } from '@/integrations/discord/presence/status-generator-dynamic';

// Helper to wait for async safeUpdatePhase promises to settle
const flushPromises = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

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
            botUserId: 'bot-999' as any,
        };
    });

    describe('event mapping to presence phases', () => {
        test('should map assistant event to thinking phase', async () => {
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

        test('should map tool_progress event to using_tool phase with tool name', async () => {
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

        test('should map assistant event with delta text to responding phase', async () => {
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

        test('should map result event to idle phase', async () => {
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
        test('should start typing before processing', async () => {
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

        test('should stop typing after completion', async () => {
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
        test('should handle errors gracefully and clear presence', async () => {
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

        test('should handle stream callback errors without crashing', async () => {
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
        test('should handle concurrent messages independently', async () => {
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
        test('should work with agents that do not support stream callbacks', async () => {
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
        test('should extract tool name from tool_progress events', async () => {
            const toolNames: string[] = [];
            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        onEvent({ type: 'tool_progress', tool_name: 'mcp__memory__view' });
                        onEvent({ type: 'tool_progress', tool_name: 'mcp__memory__storeSelf' });
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

            expect(toolNames).toEqual(['mcp__memory__view', 'mcp__memory__storeSelf']);
        });

        test('should handle missing tool_name gracefully', async () => {
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
        test('should log debug message with messageId when typing indicator starts', async () => {
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

        test('should log error with correct context when main error occurs', async () => {
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

        test('should log error when stream event presence update fails', async () => {
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

        test('should log error when final idle presence update fails', async () => {
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

        test('should log error when idle update fails after main error', async () => {
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
        test('should not call sendTyping when channel is undefined', async () => {
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

        test('should process message normally when channel is undefined', async () => {
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
            expect(_some(phases, ['type', 'responding'])).toBe(true);
            expect(_some(phases, ['type', 'idle'])).toBe(true);
        });
    });

    describe('conditional branch coverage for event types', () => {
        test('should map assistant event with empty delta object to thinking phase', async () => {
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

        test('should map assistant event with empty string delta.text to thinking phase', async () => {
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

        test('should ignore unknown event types', async () => {
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

        test('should verify result event triggers idle with since date', async () => {
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
            const idlePhases = _filter(phases, ['type', 'idle']);
            expect(idlePhases.length).toBeGreaterThanOrEqual(1);
            // Each idle phase should have a since Date
            for(const phase of idlePhases) {
                if(phase.type === 'idle') {
                    expect(phase.since).toBeInstanceOf(Date);
                }
            }
        });

        test('should correctly call updatePhase with idle type string on result event', async () => {
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
        test('should call updatePhase with idle after chat completes', async () => {
            const phases: PresencePhase[] = [];
            const wrappedAgent = {
                chat: mock(_constant(Promise.resolve('Response'))),
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
            const idlePhases = _filter(phases, ['type', 'idle']);
            expect(idlePhases.length).toBeGreaterThanOrEqual(1);
        });

        test('should verify final idle update has since property as Date', async () => {
            const phases: PresencePhase[] = [];
            const wrappedAgent = {
                chat: mock(_constant(Promise.resolve('Response'))),
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
        test('should call updatePhase with idle after agent.chat throws', async () => {
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
            const idlePhases = _filter(phases, ['type', 'idle']);
            expect(idlePhases.length).toBeGreaterThanOrEqual(1);
        });

        test('should verify idle transition after error has since Date', async () => {
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

    describe('typing indicator refresh interval', () => {
        test('should set up interval to refresh typing every 8 seconds', async () => {
            const mockChannel = {
                sendTyping: mock(async () => undefined),
            };

            // Mock setInterval
            const originalSetInterval = globalThis.setInterval;
            const setIntervalSpy = mock((fn: () => void, ms: number) => originalSetInterval(fn, ms));
            globalThis.setInterval = setIntervalSpy as any;

            try {
                const middleware = createStatusMiddleware({
                    presenceManager: mockPresenceManager,
                    agent:           mockAgent,
                    logger:          mockLogger,
                });

                await middleware(messageContext, mockChannel as any);

                // Should have called setInterval with 8000ms
                expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 8000);
            } finally {
                globalThis.setInterval = originalSetInterval;
            }
        });

        test('should clear interval in finally block after successful completion', async () => {
            const mockChannel = {
                sendTyping: mock(async () => undefined),
            };

            // Track interval ID and clearInterval calls
            const originalSetInterval = globalThis.setInterval;
            const originalClearInterval = globalThis.clearInterval;
            let capturedIntervalId: ReturnType<typeof setInterval> | null = null;
            const clearIntervalSpy = mock((id: ReturnType<typeof setInterval>) => {
                originalClearInterval(id);
            });

            globalThis.setInterval = ((fn: () => void, ms: number) => {
                capturedIntervalId = originalSetInterval(fn, ms);
                return capturedIntervalId;
            }) as any;
            globalThis.clearInterval = clearIntervalSpy as any;

            try {
                const middleware = createStatusMiddleware({
                    presenceManager: mockPresenceManager,
                    agent:           mockAgent,
                    logger:          mockLogger,
                });

                await middleware(messageContext, mockChannel as any);

                // Should have cleared the interval
                expect(clearIntervalSpy).toHaveBeenCalled();
                expect(capturedIntervalId).not.toBeNull();
            } finally {
                globalThis.setInterval = originalSetInterval;
                globalThis.clearInterval = originalClearInterval;
            }
        });

        test('should clear interval in finally block even when agent.chat throws', async () => {
            const mockChannel = {
                sendTyping: mock(async () => undefined),
            };

            const errorAgent = {
                chat: mock(async () => {
                    throw new Error('Agent error');
                }),
            };

            // Track clearInterval calls
            const originalSetInterval = globalThis.setInterval;
            const originalClearInterval = globalThis.clearInterval;
            const clearIntervalSpy = mock((id: ReturnType<typeof setInterval>) => {
                originalClearInterval(id);
            });

            globalThis.setInterval = ((fn: () => void, ms: number) => {
                return originalSetInterval(fn, ms);
            }) as any;
            globalThis.clearInterval = clearIntervalSpy as any;

            try {
                const middleware = createStatusMiddleware({
                    presenceManager: mockPresenceManager,
                    agent:           errorAgent as any,
                    logger:          mockLogger,
                });

                await middleware(messageContext, mockChannel as any);

                // Should still clear the interval even on error
                expect(clearIntervalSpy).toHaveBeenCalled();
            } finally {
                globalThis.setInterval = originalSetInterval;
                globalThis.clearInterval = originalClearInterval;
            }
        });

        test('should not set interval when channel is undefined', async () => {
            const originalSetInterval = globalThis.setInterval;
            const setIntervalSpy = mock((fn: () => void, ms: number) => originalSetInterval(fn, ms));
            globalThis.setInterval = setIntervalSpy as any;

            try {
                const middleware = createStatusMiddleware({
                    presenceManager: mockPresenceManager,
                    agent:           mockAgent,
                    logger:          mockLogger,
                });

                await middleware(messageContext); // No channel

                // Should NOT have called setInterval
                expect(setIntervalSpy).not.toHaveBeenCalled();
            } finally {
                globalThis.setInterval = originalSetInterval;
            }
        });

        test('should log when stopping typing indicator', async () => {
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
                'Stopped typing indicator'
            );
        });

        test('should call sendTyping when interval fires', async () => {
            const mockChannel = {
                sendTyping: mock(async () => undefined),
            };

            // Capture the interval callback
            const originalSetInterval = globalThis.setInterval;
            let capturedCallback: (() => void) | null = null;

            globalThis.setInterval = ((fn: () => void, _ms: number) => {
                capturedCallback = fn;
                return originalSetInterval(fn, 999999); // Use a very long interval so it doesn't fire automatically
            }) as any;

            try {
                const middleware = createStatusMiddleware({
                    presenceManager: mockPresenceManager,
                    agent:           mockAgent,
                    logger:          mockLogger,
                });

                await middleware(messageContext, mockChannel as any);

                // Manually invoke the captured callback to simulate interval firing
                expect(capturedCallback).not.toBeNull();
                capturedCallback!();

                // Should have called sendTyping twice: once initially, once from interval callback
                expect(mockChannel.sendTyping).toHaveBeenCalledTimes(2);
            } finally {
                globalThis.setInterval = originalSetInterval;
            }
        });
    });

    describe('sendTyping error handling', () => {
        test('should handle sendTyping errors gracefully and return null', async () => {
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
        test('should not treat non-tool_progress event as tool_progress', async () => {
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
            const toolPhases = _filter(phases, ['type', 'using_tool']);
            expect(toolPhases.length).toBe(0);
        });

        test('should transition to using_tool when currentPhase is thinking (not using_tool)', async () => {
            // This test kills the ConditionalExpression mutant at line 178 which changes:
            // `currentPhase !== 'using_tool' || toolName !== lastToolName` to
            // `false || toolName !== lastToolName`
            //
            // The mutant would skip the phase update when transitioning FROM a non-tool phase
            // (e.g., thinking) to using_tool with the first tool_progress event.
            const phases: PresencePhase[] = [];
            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        // First event: assistant without delta.text → thinking phase
                        onEvent({ type: 'assistant' });
                        // Second event: tool_progress → should transition to using_tool
                        // even though it's the first tool (no lastToolName to compare)
                        onEvent({ type: 'tool_progress', tool_name: 'first_tool' });
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

            // Should have thinking phase first
            const thinkingPhases = _filter(phases, ['type', 'thinking']);
            expect(thinkingPhases.length).toBe(1);

            // Should transition to using_tool even when lastToolName is undefined
            // (this is what the mutant would break - it would skip this transition)
            const toolPhases = _filter(phases, ['type', 'using_tool']);
            expect(toolPhases.length).toBe(1);
            expect((toolPhases[0] as any).toolName).toBe('first_tool');
        });

        test('should transition to using_tool when returning to same tool after thinking phase', async () => {
            // This test SPECIFICALLY kills the ConditionalExpression mutant at line 180 which changes:
            // `currentPhase !== 'using_tool' || toolName !== lastToolName` to
            // `false || toolName !== lastToolName`
            //
            // Sequence:
            // 1. tool_progress 'tool_A' → sets lastToolName='tool_A', currentPhase='using_tool'
            // 2. assistant (no text) → sets currentPhase='thinking', lastToolName stays 'tool_A'
            // 3. tool_progress 'tool_A' → toolName === lastToolName, but currentPhase !== 'using_tool'
            //
            // Original: 'thinking' !== 'using_tool' is TRUE → enters block, updatePhase called
            // Mutant: false || ('tool_A' !== 'tool_A') = false || false = FALSE → skips block
            const phases: PresencePhase[] = [];
            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        // Step 1: First tool use
                        onEvent({ type: 'tool_progress', tool_name: 'tool_A' });
                        // Step 2: Transition to thinking
                        onEvent({ type: 'assistant' });
                        // Step 3: Return to same tool - this is where the mutant fails
                        onEvent({ type: 'tool_progress', tool_name: 'tool_A' });
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

            // Should have: tool_A (1st) → thinking → tool_A (2nd)
            // The mutant would only have: tool_A (1st) → thinking (missing second tool_A)
            const toolPhases = _filter(phases, ['type', 'using_tool']);
            expect(toolPhases.length).toBe(2); // Both tool_A calls should trigger updates
            expect((toolPhases[0] as any).toolName).toBe('tool_A');
            expect((toolPhases[1] as any).toolName).toBe('tool_A');

            const thinkingPhases = _filter(phases, ['type', 'thinking']);
            expect(thinkingPhases.length).toBe(1);
        });

        test('should transition to using_tool from null currentPhase on first event', async () => {
            // This test verifies that when currentPhase starts as null (initial state),
            // receiving a tool_progress event triggers phase update.
            // The mutant would skip this because `null !== 'using_tool'` is true,
            // but mutating it to `false` would prevent the update.
            const phases: PresencePhase[] = [];
            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        // First event is tool_progress - currentPhase is null
                        onEvent({ type: 'tool_progress', tool_name: 'immediate_tool' });
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

            // Should have using_tool phase from the first event
            const toolPhases = _filter(phases, ['type', 'using_tool']);
            expect(toolPhases.length).toBe(1);
            expect((toolPhases[0] as any).toolName).toBe('immediate_tool');
        });
    });

    describe('result event mutant killers', () => {
        test('should not treat non-result event as result event', async () => {
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
            const respondingPhases = _filter(phases, ['type', 'responding']);
            expect(respondingPhases.length).toBe(1);

            // Should have exactly one idle phase (from final transition, not from result event)
            // The idle is added at the end by the middleware, not by a result event
            const idlePhases = _filter(phases, ['type', 'idle']);
            expect(idlePhases.length).toBe(1);
        });

        test('should add idle phase when result event occurs', async () => {
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
            const idlePhases = _filter(phases, ['type', 'idle']);
            expect(idlePhases.length).toBeGreaterThanOrEqual(2);
        });
    });

    describe('tool_name nullish coalescing edge cases', () => {
        test('should use "unknown" when tool_name is null', async () => {
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

        test('should keep empty string tool_name (not replace with unknown)', async () => {
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

        test('should use "unknown" when tool_name is undefined', async () => {
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

        test('should preserve actual tool_name value', async () => {
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
        test('should use "responding" when delta.text is truthy, not empty string', async () => {
            // This test specifically targets the ternary: event.delta?.text ? 'responding' : 'thinking'
            const phases: PresencePhase[] = [];
            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        onEvent({ type: 'assistant', delta: { text: 'X' } }); // truthy text
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

            // The ternary should choose 'responding' since delta.text is truthy
            const respondingPhase = _find(phases, ['type', 'responding']);
            expect(respondingPhase).toBeDefined();
            expect(respondingPhase!.type).toBe('responding');
            // Verify it's not empty (kills mutant that changes 'responding' to '')
            expect(respondingPhase!.type.length).toBeGreaterThan(0);
        });

        test('should use "thinking" when delta.text is falsy, not empty string', async () => {
            // This test specifically targets the ternary: event.delta?.text ? 'responding' : 'thinking'
            const phases: PresencePhase[] = [];
            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        onEvent({ type: 'assistant' }); // no delta.text
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

            // The ternary should choose 'thinking' since delta.text is falsy
            const thinkingPhase = _find(phases, ['type', 'thinking']);
            expect(thinkingPhase).toBeDefined();
            expect(thinkingPhase!.type).toBe('thinking');
            // Verify it's not empty (kills mutant that changes 'thinking' to '')
            expect(thinkingPhase!.type.length).toBeGreaterThan(0);
        });

        test('should use exact string "thinking" not empty string', async () => {
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

            const thinkingPhase = _find(phases, ['type', 'thinking']);
            expect(thinkingPhase).toBeDefined();
            expect(thinkingPhase!.type).toBe('thinking');
            expect(thinkingPhase!.type).not.toBe('');
            expect(thinkingPhase!.type.length).toBe(8); // 'thinking' has 8 chars
        });

        test('should use exact string "responding" not empty string', async () => {
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

            const respondingPhase = _find(phases, ['type', 'responding']);
            expect(respondingPhase).toBeDefined();
            expect(respondingPhase!.type).toBe('responding');
            expect(respondingPhase!.type).not.toBe('');
            expect(respondingPhase!.type.length).toBe(10); // 'responding' has 10 chars
        });

        test('should use exact string "using_tool" not empty string', async () => {
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

            const toolPhase = _find(phases, ['type', 'using_tool']);
            expect(toolPhase).toBeDefined();
            expect(toolPhase!.type).toBe('using_tool');
            expect(toolPhase!.type).not.toBe('');
            expect(toolPhase!.type.length).toBe(10); // 'using_tool' has 10 chars
        });

        test('should use exact string "idle" not empty string', async () => {
            const phases: PresencePhase[] = [];
            const wrappedAgent = {
                chat: mock(_constant(Promise.resolve('Response'))),
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

            const idlePhase = _find(phases, ['type', 'idle']);
            expect(idlePhase).toBeDefined();
            expect(idlePhase!.type).toBe('idle');
            expect(idlePhase!.type).not.toBe('');
            expect(idlePhase!.type.length).toBe(4); // 'idle' has 4 chars
        });
    });

    describe('Date instance verification for all phases', () => {
        test('should include startedAt as Date for thinking phase', async () => {
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

            const thinkingPhase = _find(phases, ['type', 'thinking']);
            expect(thinkingPhase).toBeDefined();
            if(thinkingPhase?.type === 'thinking') {
                expect(thinkingPhase.startedAt).toBeInstanceOf(Date);
            }
        });

        test('should include startedAt as Date for responding phase', async () => {
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

            const respondingPhase = _find(phases, ['type', 'responding']);
            expect(respondingPhase).toBeDefined();
            if(respondingPhase?.type === 'responding') {
                expect(respondingPhase.startedAt).toBeInstanceOf(Date);
            }
        });

        test('should include startedAt as Date for using_tool phase', async () => {
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

            const toolPhase = _find(phases, ['type', 'using_tool']);
            expect(toolPhase).toBeDefined();
            if(toolPhase?.type === 'using_tool') {
                expect(toolPhase.startedAt).toBeInstanceOf(Date);
            }
        });

        test('should include since as Date for result event idle phase', async () => {
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

            const idlePhases = _filter(phases, ['type', 'idle']);
            expect(idlePhases.length).toBeGreaterThanOrEqual(1);
            for(const phase of idlePhases) {
                if(phase.type === 'idle') {
                    expect(phase.since).toBeInstanceOf(Date);
                }
            }
        });
    });

    describe('error isolation edge cases', () => {
        test('should return response even when safeUpdatePhase throws multiple times', async () => {
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

        test('should still attempt idle transition when agent throws after events', async () => {
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
            expect(_some(phases, ['type', 'responding'])).toBe(true);
            // Should have idle phase from error recovery
            expect(_some(phases, ['type', 'idle'])).toBe(true);
        });

        test('should return null and log when sendTyping fails before agent.chat', async () => {
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
        test('should distinguish assistant event from tool_progress by type field', async () => {
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
            const respondingPhases = _filter(phases, ['type', 'responding']);
            const toolPhases = _filter(phases, ['type', 'using_tool']);

            expect(respondingPhases.length).toBe(1);
            expect(toolPhases.length).toBe(1);
        });

        test('should distinguish result event from assistant by type field', async () => {
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
            const thinkingPhases = _filter(phases, ['type', 'thinking']);
            const idlePhases = _filter(phases, ['type', 'idle']);

            expect(thinkingPhases.length).toBe(1);
            expect(idlePhases.length).toBeGreaterThanOrEqual(2);
        });
    });

    describe('dynamic status generation', () => {
        let mockDynamicStatusGenerator: DynamicStatusGenerator;

        beforeEach(() => {
            mockDynamicStatusGenerator = {
                generateSynopsis: mock(_constant(Promise.resolve('Generated status...'))),
            };
        });

        describe('synopsis generation on phase transitions', () => {
            test('should call generateSynopsis for thinking phase on first assistant event', async () => {
                const wrappedAgent = {
                    chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                        if(onEvent) {
                            onEvent({ type: 'assistant' });
                        }
                        return 'Response';
                    }),
                };

                const middleware = createStatusMiddleware({
                    presenceManager:        mockPresenceManager,
                    agent:                  wrappedAgent as any,
                    logger:                 mockLogger,
                    dynamicStatusGenerator: mockDynamicStatusGenerator,
                });

                await middleware(messageContext);
                await flushPromises();

                expect(mockDynamicStatusGenerator.generateSynopsis).toHaveBeenCalledWith(
                    expect.objectContaining({
                        phase:       'thinking',
                        userMessage: 'Test message',
                    })
                );
            });

            test('should call generateSynopsis for responding phase with responseFragment', async () => {
                const wrappedAgent = {
                    chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                        if(onEvent) {
                            onEvent({ type: 'assistant', delta: { text: 'Hello world' } });
                        }
                        return 'Response';
                    }),
                };

                const middleware = createStatusMiddleware({
                    presenceManager:        mockPresenceManager,
                    agent:                  wrappedAgent as any,
                    logger:                 mockLogger,
                    dynamicStatusGenerator: mockDynamicStatusGenerator,
                });

                await middleware(messageContext);
                await flushPromises();

                expect(mockDynamicStatusGenerator.generateSynopsis).toHaveBeenCalledWith(
                    expect.objectContaining({
                        phase:            'responding',
                        userMessage:      'Test message',
                        responseFragment: 'Hello world',
                    })
                );
            });

            test('should call generateSynopsis for using_tool phase with toolName', async () => {
                const wrappedAgent = {
                    chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                        if(onEvent) {
                            onEvent({ type: 'tool_progress', tool_name: 'mcp__memory__search' });
                        }
                        return 'Response';
                    }),
                };

                const middleware = createStatusMiddleware({
                    presenceManager:        mockPresenceManager,
                    agent:                  wrappedAgent as any,
                    logger:                 mockLogger,
                    dynamicStatusGenerator: mockDynamicStatusGenerator,
                });

                await middleware(messageContext);
                await flushPromises();

                expect(mockDynamicStatusGenerator.generateSynopsis).toHaveBeenCalledWith(
                    expect.objectContaining({
                        phase:       'using_tool',
                        userMessage: 'Test message',
                        toolName:    'mcp__memory__search',
                    })
                );
            });
        });

        describe('generatedStatus passed to updatePhase', () => {
            test('should pass generatedStatus to updatePhase for thinking phase', async () => {
                const phases: PresencePhase[] = [];
                (mockDynamicStatusGenerator.generateSynopsis as any).mockImplementation(
                    _constant(Promise.resolve('Pondering deeply...'))
                );

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
                    presenceManager:        capturingPresenceManager as any,
                    agent:                  wrappedAgent as any,
                    logger:                 mockLogger,
                    dynamicStatusGenerator: mockDynamicStatusGenerator,
                });

                await middleware(messageContext);
                await flushPromises();

                const thinkingPhase = _find(phases, ['type', 'thinking']);
                expect(thinkingPhase).toBeDefined();
                if(thinkingPhase?.type === 'thinking') {
                    expect(thinkingPhase.generatedStatus).toBe('Pondering deeply...');
                }
            });

            test('should pass generatedStatus to updatePhase for responding phase', async () => {
                const phases: PresencePhase[] = [];
                (mockDynamicStatusGenerator.generateSynopsis as any).mockImplementation(
                    _constant(Promise.resolve('Crafting response...'))
                );

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
                    presenceManager:        capturingPresenceManager as any,
                    agent:                  wrappedAgent as any,
                    logger:                 mockLogger,
                    dynamicStatusGenerator: mockDynamicStatusGenerator,
                });

                await middleware(messageContext);
                await flushPromises();

                const respondingPhase = _find(phases, ['type', 'responding']);
                expect(respondingPhase).toBeDefined();
                if(respondingPhase?.type === 'responding') {
                    expect(respondingPhase.generatedStatus).toBe('Crafting response...');
                }
            });

            test('should pass generatedStatus to updatePhase for using_tool phase', async () => {
                const phases: PresencePhase[] = [];
                (mockDynamicStatusGenerator.generateSynopsis as any).mockImplementation(
                    _constant(Promise.resolve('Searching memories...'))
                );

                const wrappedAgent = {
                    chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                        if(onEvent) {
                            onEvent({ type: 'tool_progress', tool_name: 'mcp__memory__search' });
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
                    presenceManager:        capturingPresenceManager as any,
                    agent:                  wrappedAgent as any,
                    logger:                 mockLogger,
                    dynamicStatusGenerator: mockDynamicStatusGenerator,
                });

                await middleware(messageContext);
                await flushPromises();

                const toolPhase = _find(phases, ['type', 'using_tool']);
                expect(toolPhase).toBeDefined();
                if(toolPhase?.type === 'using_tool') {
                    expect(toolPhase.generatedStatus).toBe('Searching memories...');
                }
            });
        });

        describe('fallback behavior', () => {
            test('should use exact type "using_tool" in fallback when generateSynopsis throws for tool_progress', async () => {
                const phases: PresencePhase[] = [];
                (mockDynamicStatusGenerator.generateSynopsis as any).mockImplementation(
                    () => Promise.reject(new Error('Synopsis generation failed'))
                );

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
                    presenceManager:        capturingPresenceManager as any,
                    agent:                  wrappedAgent as any,
                    logger:                 mockLogger,
                    dynamicStatusGenerator: mockDynamicStatusGenerator,
                });

                await middleware(messageContext);
                await flushPromises();

                // Verify fallback phase has exact type 'using_tool', not empty string
                const toolPhase = _find(phases, ['type', 'using_tool']);
                expect(toolPhase).toBeDefined();
                expect(toolPhase!.type).toBe('using_tool');
                expect(toolPhase!.type).not.toBe('');
                expect(toolPhase!.type.length).toBe(10); // 'using_tool' has 10 chars
                // generatedStatus should be undefined on error
                if(toolPhase?.type === 'using_tool') {
                    expect(toolPhase.generatedStatus).toBeUndefined();
                }
            });

            test('should work without dynamicStatusGenerator (backwards compatibility)', async () => {
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

                // No dynamicStatusGenerator provided
                const middleware = createStatusMiddleware({
                    presenceManager: capturingPresenceManager as any,
                    agent:           wrappedAgent as any,
                    logger:          mockLogger,
                });

                await middleware(messageContext);
                await flushPromises();

                // Should still work and update phases
                const thinkingPhase = _find(phases, ['type', 'thinking']);
                expect(thinkingPhase).toBeDefined();
                // generatedStatus should be undefined when no generator is provided
                if(thinkingPhase?.type === 'thinking') {
                    expect(thinkingPhase.generatedStatus).toBeUndefined();
                }
            });

            test('should update phase without generatedStatus when generateSynopsis throws', async () => {
                const phases: PresencePhase[] = [];
                (mockDynamicStatusGenerator.generateSynopsis as any).mockImplementation(
                    () => Promise.reject(new Error('Synopsis generation failed'))
                );

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
                    presenceManager:        capturingPresenceManager as any,
                    agent:                  wrappedAgent as any,
                    logger:                 mockLogger,
                    dynamicStatusGenerator: mockDynamicStatusGenerator,
                });

                await middleware(messageContext);
                await flushPromises();

                // Should still have responding phase (fallback without generatedStatus)
                const respondingPhase = _find(phases, ['type', 'responding']);
                expect(respondingPhase).toBeDefined();
                // generatedStatus should be undefined on error
                if(respondingPhase?.type === 'responding') {
                    expect(respondingPhase.generatedStatus).toBeUndefined();
                }
            });
        });

        describe('phase transition detection', () => {
            test('should not call generateSynopsis for duplicate thinking events', async () => {
                const wrappedAgent = {
                    chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                        if(onEvent) {
                            // Multiple thinking events in a row
                            onEvent({ type: 'assistant' });
                            onEvent({ type: 'assistant' });
                            onEvent({ type: 'assistant' });
                        }
                        return 'Response';
                    }),
                };

                const middleware = createStatusMiddleware({
                    presenceManager:        mockPresenceManager,
                    agent:                  wrappedAgent as any,
                    logger:                 mockLogger,
                    dynamicStatusGenerator: mockDynamicStatusGenerator,
                });

                await middleware(messageContext);
                await flushPromises();

                // Should only call generateSynopsis once for thinking phase
                const thinkingCalls = _filter(
                    (mockDynamicStatusGenerator.generateSynopsis as any).mock.calls,
                    (call: any[]) => call[0]?.phase === 'thinking'
                );
                expect(thinkingCalls.length).toBe(1);
            });

            test('should not call generateSynopsis for duplicate responding events', async () => {
                const wrappedAgent = {
                    chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                        if(onEvent) {
                            // Multiple responding events in a row
                            onEvent({ type: 'assistant', delta: { text: 'Hello' } });
                            onEvent({ type: 'assistant', delta: { text: ' world' } });
                            onEvent({ type: 'assistant', delta: { text: '!' } });
                        }
                        return 'Response';
                    }),
                };

                const middleware = createStatusMiddleware({
                    presenceManager:        mockPresenceManager,
                    agent:                  wrappedAgent as any,
                    logger:                 mockLogger,
                    dynamicStatusGenerator: mockDynamicStatusGenerator,
                });

                await middleware(messageContext);
                await flushPromises();

                // Should only call generateSynopsis once for responding phase
                const respondingCalls = _filter(
                    (mockDynamicStatusGenerator.generateSynopsis as any).mock.calls,
                    (call: any[]) => call[0]?.phase === 'responding'
                );
                expect(respondingCalls.length).toBe(1);
            });

            test('should call generateSynopsis when tool name changes', async () => {
                const wrappedAgent = {
                    chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                        if(onEvent) {
                            onEvent({ type: 'tool_progress', tool_name: 'tool_a' });
                            onEvent({ type: 'tool_progress', tool_name: 'tool_b' });
                        }
                        return 'Response';
                    }),
                };

                const middleware = createStatusMiddleware({
                    presenceManager:        mockPresenceManager,
                    agent:                  wrappedAgent as any,
                    logger:                 mockLogger,
                    dynamicStatusGenerator: mockDynamicStatusGenerator,
                });

                await middleware(messageContext);
                await flushPromises();

                // Should call generateSynopsis twice for different tools
                const toolCalls = _filter(
                    (mockDynamicStatusGenerator.generateSynopsis as any).mock.calls,
                    (call: any[]) => call[0]?.phase === 'using_tool'
                );
                expect(toolCalls.length).toBe(2);
                expect(toolCalls[0][0].toolName).toBe('tool_a');
                expect(toolCalls[1][0].toolName).toBe('tool_b');
            });

            test('should not call generateSynopsis for duplicate tool_progress with same tool', async () => {
                const wrappedAgent = {
                    chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                        if(onEvent) {
                            onEvent({ type: 'tool_progress', tool_name: 'same_tool' });
                            onEvent({ type: 'tool_progress', tool_name: 'same_tool' });
                            onEvent({ type: 'tool_progress', tool_name: 'same_tool' });
                        }
                        return 'Response';
                    }),
                };

                const middleware = createStatusMiddleware({
                    presenceManager:        mockPresenceManager,
                    agent:                  wrappedAgent as any,
                    logger:                 mockLogger,
                    dynamicStatusGenerator: mockDynamicStatusGenerator,
                });

                await middleware(messageContext);
                await flushPromises();

                // Should only call generateSynopsis once for same tool
                const toolCalls = _filter(
                    (mockDynamicStatusGenerator.generateSynopsis as any).mock.calls,
                    (call: any[]) => call[0]?.phase === 'using_tool'
                );
                expect(toolCalls.length).toBe(1);
            });

            test('should call generateSynopsis when transitioning between phases', async () => {
                const wrappedAgent = {
                    chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                        if(onEvent) {
                            onEvent({ type: 'assistant' }); // thinking
                            onEvent({ type: 'tool_progress', tool_name: 'test' }); // using_tool
                            onEvent({ type: 'assistant', delta: { text: 'Hi' } }); // responding
                        }
                        return 'Response';
                    }),
                };

                const middleware = createStatusMiddleware({
                    presenceManager:        mockPresenceManager,
                    agent:                  wrappedAgent as any,
                    logger:                 mockLogger,
                    dynamicStatusGenerator: mockDynamicStatusGenerator,
                });

                await middleware(messageContext);
                await flushPromises();

                // Should have exactly 3 calls - one for each phase
                expect(mockDynamicStatusGenerator.generateSynopsis).toHaveBeenCalledTimes(3);
            });
        });

        describe('pre-generation of thinking synopsis', () => {
            test('should pre-generate thinking synopsis before agent.chat is called', async () => {
                let generateSynopsisCalledBeforeChat = false;
                let chatCalled = false;

                (mockDynamicStatusGenerator.generateSynopsis as any).mockImplementation(async () => {
                    if(!chatCalled) {
                        generateSynopsisCalledBeforeChat = true;
                    }
                    return 'Pre-generated thinking...';
                });

                const wrappedAgent = {
                    chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                        chatCalled = true;
                        if(onEvent) {
                            onEvent({ type: 'assistant' });
                        }
                        return 'Response';
                    }),
                };

                const middleware = createStatusMiddleware({
                    presenceManager:        mockPresenceManager,
                    agent:                  wrappedAgent as any,
                    logger:                 mockLogger,
                    dynamicStatusGenerator: mockDynamicStatusGenerator,
                });

                await middleware(messageContext);
                await flushPromises();

                expect(generateSynopsisCalledBeforeChat).toBe(true);
            });

            test('should use pre-generated thinking synopsis when thinking event occurs', async () => {
                const phases: PresencePhase[] = [];
                let callCount = 0;

                (mockDynamicStatusGenerator.generateSynopsis as any).mockImplementation(async () => {
                    callCount++;
                    return callCount === 1 ? 'Pre-generated thinking...' : 'Other status...';
                });

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
                    presenceManager:        capturingPresenceManager as any,
                    agent:                  wrappedAgent as any,
                    logger:                 mockLogger,
                    dynamicStatusGenerator: mockDynamicStatusGenerator,
                });

                await middleware(messageContext);
                await flushPromises();

                const thinkingPhase = _find(phases, ['type', 'thinking']);
                expect(thinkingPhase).toBeDefined();
                if(thinkingPhase?.type === 'thinking') {
                    expect(thinkingPhase.generatedStatus).toBe('Pre-generated thinking...');
                }
            });

            test('should pass userMessage to pre-generation call', async () => {
                const wrappedAgent = {
                    chat: mock(_constant(Promise.resolve('Response'))),
                };

                const middleware = createStatusMiddleware({
                    presenceManager:        mockPresenceManager,
                    agent:                  wrappedAgent as any,
                    logger:                 mockLogger,
                    dynamicStatusGenerator: mockDynamicStatusGenerator,
                });

                await middleware(messageContext);
                await flushPromises();

                // First call should be pre-generation for thinking phase
                expect(mockDynamicStatusGenerator.generateSynopsis).toHaveBeenCalledWith({
                    phase:       'thinking',
                    userMessage: 'Test message',
                });
            });
        });

        describe('responseFragment optional chaining behavior', () => {
            test('should pass undefined responseFragment when event.delta is undefined', async () => {
                const wrappedAgent = {
                    chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                        if(onEvent) {
                            // First trigger thinking, then responding with delta but no text
                            onEvent({ type: 'assistant' }); // thinking - delta undefined
                            onEvent({ type: 'assistant', delta: { text: 'Hi' } }); // responding
                        }
                        return 'Response';
                    }),
                };

                const middleware = createStatusMiddleware({
                    presenceManager:        mockPresenceManager,
                    agent:                  wrappedAgent as any,
                    logger:                 mockLogger,
                    dynamicStatusGenerator: mockDynamicStatusGenerator,
                });

                await middleware(messageContext);
                await flushPromises();

                // Thinking call should not have responseFragment
                const thinkingCall = _find(
                    (mockDynamicStatusGenerator.generateSynopsis as any).mock.calls,
                    (call: any[]) => call[0]?.phase === 'thinking'
                );
                expect(thinkingCall).toBeDefined();
                expect(thinkingCall[0].responseFragment).toBeUndefined();
            });

            test('should pass undefined responseFragment when event.delta.text is undefined', async () => {
                const wrappedAgent = {
                    chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                        if(onEvent) {
                            // delta exists but text is undefined - this goes to thinking branch
                            onEvent({ type: 'assistant', delta: {} }); // thinking
                        }
                        return 'Response';
                    }),
                };

                const middleware = createStatusMiddleware({
                    presenceManager:        mockPresenceManager,
                    agent:                  wrappedAgent as any,
                    logger:                 mockLogger,
                    dynamicStatusGenerator: mockDynamicStatusGenerator,
                });

                await middleware(messageContext);
                await flushPromises();

                // Should be thinking phase (no responseFragment)
                const thinkingCall = _find(
                    (mockDynamicStatusGenerator.generateSynopsis as any).mock.calls,
                    (call: any[]) => call[0]?.phase === 'thinking'
                );
                expect(thinkingCall).toBeDefined();
                expect(thinkingCall[0].responseFragment).toBeUndefined();
            });

            test('should correctly slice responseFragment from event.delta.text', async () => {
                const wrappedAgent = {
                    chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                        if(onEvent) {
                            onEvent({ type: 'assistant', delta: { text: 'Hello world' } });
                        }
                        return 'Response';
                    }),
                };

                const middleware = createStatusMiddleware({
                    presenceManager:        mockPresenceManager,
                    agent:                  wrappedAgent as any,
                    logger:                 mockLogger,
                    dynamicStatusGenerator: mockDynamicStatusGenerator,
                });

                await middleware(messageContext);
                await flushPromises();

                const respondingCall = _find(
                    (mockDynamicStatusGenerator.generateSynopsis as any).mock.calls,
                    (call: any[]) => call[0]?.phase === 'responding'
                );
                expect(respondingCall).toBeDefined();
                expect(respondingCall[0].responseFragment).toBe('Hello world');
            });
        });

        describe('truncation of responseFragment', () => {
            test('should truncate responseFragment to 100 characters', async () => {
                const longText = _repeat('A', 200);
                const wrappedAgent = {
                    chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                        if(onEvent) {
                            onEvent({ type: 'assistant', delta: { text: longText } });
                        }
                        return 'Response';
                    }),
                };

                const middleware = createStatusMiddleware({
                    presenceManager:        mockPresenceManager,
                    agent:                  wrappedAgent as any,
                    logger:                 mockLogger,
                    dynamicStatusGenerator: mockDynamicStatusGenerator,
                });

                await middleware(messageContext);
                await flushPromises();

                const respondingCall = _find(
                    (mockDynamicStatusGenerator.generateSynopsis as any).mock.calls,
                    (call: any[]) => call[0]?.phase === 'responding'
                );
                expect(respondingCall).toBeDefined();
                expect(respondingCall[0].responseFragment.length).toBe(100);
                expect(respondingCall[0].responseFragment).toBe(_repeat('A', 100));
            });
        });

        describe('pre-chat synopsis generation guard', () => {
            test('should not attempt to call generateSynopsis when dynamicStatusGenerator is undefined', async () => {
                // This test kills the mutation: if(dynamicStatusGenerator) → if(true)
                // If the guard is mutated to always true, calling undefined.generateSynopsis() would throw
                const wrappedAgent = {
                    chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                        // The pre-chat synopsis generation happens BEFORE agent.chat is called
                        // If dynamicStatusGenerator is undefined and guard is mutated to if(true),
                        // the middleware would crash before reaching this point
                        if(onEvent) {
                            onEvent({ type: 'assistant' });
                        }
                        return 'Response';
                    }),
                };

                // No dynamicStatusGenerator provided - middleware should NOT crash
                const middleware = createStatusMiddleware({
                    presenceManager: mockPresenceManager,
                    agent:           wrappedAgent as any,
                    logger:          mockLogger,
                    // dynamicStatusGenerator intentionally omitted (undefined)
                });

                // Should complete successfully without throwing
                const result = await middleware(messageContext);
                expect(result).toBe('Response');

                // Agent chat should have been called (proves we got past the guard)
                expect(wrappedAgent.chat).toHaveBeenCalledTimes(1);
            });

            test('should skip pre-chat synopsis generation without crashing when generator is undefined', async () => {
                // Explicit test: undefined dynamicStatusGenerator should skip generateSynopsis call
                // With mutation if(dynamicStatusGenerator) → if(true), this would throw:
                // "TypeError: Cannot read properties of undefined (reading 'generateSynopsis')"
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
                    // No dynamicStatusGenerator
                });

                await middleware(messageContext);
                await flushPromises();

                // Should have thinking phase with undefined generatedStatus
                const thinkingPhase = _find(phases, ['type', 'thinking']);
                expect(thinkingPhase).toBeDefined();
                if(thinkingPhase?.type === 'thinking') {
                    expect(thinkingPhase.generatedStatus).toBeUndefined();
                }
            });
        });
    });

    describe('rich context passing to generateSynopsis', () => {
        test('should pass toolInput to generateSynopsis for using_tool phase', async () => {
            const capturedContexts: SynopsisContext[] = [];
            const mockDynamicStatusGenerator = {
                generateSynopsis: mock(async (ctx: SynopsisContext) => {
                    capturedContexts.push(ctx);
                    return 'Test status';
                }),
            };

            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        // First send assistant event with tool_use block
                        onEvent({
                            type:    'assistant',
                            message: {
                                content: [{
                                    type:  'tool_use',
                                    id:    'tool1',
                                    name:  'Read',
                                    input: { file_path: '/test.txt' }
                                }]
                            }
                        } as any);
                        // Then send tool_progress for that tool
                        onEvent({ type: 'tool_progress', tool_name: 'Read' });
                    }
                    return 'Response';
                }),
            };

            const middleware = createStatusMiddleware({
                presenceManager:        mockPresenceManager,
                agent:                  wrappedAgent as any,
                logger:                 mockLogger,
                dynamicStatusGenerator: mockDynamicStatusGenerator as any,
            });

            await middleware(messageContext);
            await flushPromises();

            // Find the using_tool context
            const toolContext = _find(capturedContexts, ['phase', 'using_tool']);
            expect(toolContext).toBeDefined();
            expect(toolContext!.toolInput).toEqual({ file_path: '/test.txt' });
        });

        test('should pass toolDescription to generateSynopsis for using_tool phase', async () => {
            const capturedContexts: SynopsisContext[] = [];
            const mockDynamicStatusGenerator = {
                generateSynopsis: mock(async (ctx: SynopsisContext) => {
                    capturedContexts.push(ctx);
                    return 'Test status';
                }),
            };

            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        onEvent({ type: 'tool_progress', tool_name: 'Read' });
                    }
                    return 'Response';
                }),
            };

            const middleware = createStatusMiddleware({
                presenceManager:        mockPresenceManager,
                agent:                  wrappedAgent as any,
                logger:                 mockLogger,
                dynamicStatusGenerator: mockDynamicStatusGenerator as any,
            });

            await middleware(messageContext);
            await flushPromises();

            const toolContext = _find(capturedContexts, ['phase', 'using_tool']);
            expect(toolContext).toBeDefined();
            // Read is defined in ToolDescriptions
            expect(toolContext!.toolDescription).toBe('Reading a file');
        });

        test('should pass accumulatedText to generateSynopsis for using_tool phase', async () => {
            const capturedContexts: SynopsisContext[] = [];
            const mockDynamicStatusGenerator = {
                generateSynopsis: mock(async (ctx: SynopsisContext) => {
                    capturedContexts.push(ctx);
                    return 'Test status';
                }),
            };

            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        // First accumulate some text
                        onEvent({ type: 'assistant', delta: { text: 'Hello ' } });
                        onEvent({ type: 'assistant', delta: { text: 'world!' } });
                        // Then trigger tool progress
                        onEvent({ type: 'tool_progress', tool_name: 'Bash' });
                    }
                    return 'Response';
                }),
            };

            const middleware = createStatusMiddleware({
                presenceManager:        mockPresenceManager,
                agent:                  wrappedAgent as any,
                logger:                 mockLogger,
                dynamicStatusGenerator: mockDynamicStatusGenerator as any,
            });

            await middleware(messageContext);
            await flushPromises();

            const toolContext = _find(capturedContexts, ['phase', 'using_tool']);
            expect(toolContext).toBeDefined();
            expect(toolContext!.accumulatedText).toBe('Hello world!');
        });

        test('should pass accumulatedText to generateSynopsis for responding phase', async () => {
            const capturedContexts: SynopsisContext[] = [];
            const mockDynamicStatusGenerator = {
                generateSynopsis: mock(async (ctx: SynopsisContext) => {
                    capturedContexts.push(ctx);
                    return 'Test status';
                }),
            };

            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        // This is the first text, triggers phase transition to responding
                        onEvent({ type: 'assistant', delta: { text: 'First chunk' } });
                    }
                    return 'Response';
                }),
            };

            const middleware = createStatusMiddleware({
                presenceManager:        mockPresenceManager,
                agent:                  wrappedAgent as any,
                logger:                 mockLogger,
                dynamicStatusGenerator: mockDynamicStatusGenerator as any,
            });

            await middleware(messageContext);
            await flushPromises();

            const respondingContext = _find(capturedContexts, ['phase', 'responding']);
            expect(respondingContext).toBeDefined();
            // The accumulatedText should include the text that triggered the phase
            expect(respondingContext!.accumulatedText).toBe('First chunk');
        });

        test('should redact sensitive tool inputs before passing to generateSynopsis', async () => {
            const capturedContexts: SynopsisContext[] = [];
            const mockDynamicStatusGenerator = {
                generateSynopsis: mock(async (ctx: SynopsisContext) => {
                    capturedContexts.push(ctx);
                    return 'Test status';
                }),
            };

            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        // Send assistant event with tool_use containing sensitive data
                        onEvent({
                            type:    'assistant',
                            message: {
                                content: [{
                                    type:  'tool_use',
                                    id:    'tool1',
                                    name:  'WebFetch',
                                    input: {
                                        url:     'https://api.example.com',
                                        apiKey:  'super-secret-key',
                                        headers: { Authorization: 'Bearer token123' }
                                    }
                                }]
                            }
                        } as any);
                        onEvent({ type: 'tool_progress', tool_name: 'WebFetch' });
                    }
                    return 'Response';
                }),
            };

            const middleware = createStatusMiddleware({
                presenceManager:        mockPresenceManager,
                agent:                  wrappedAgent as any,
                logger:                 mockLogger,
                dynamicStatusGenerator: mockDynamicStatusGenerator as any,
            });

            await middleware(messageContext);
            await flushPromises();

            const toolContext = _find(capturedContexts, ['phase', 'using_tool']);
            expect(toolContext).toBeDefined();
            const toolInput = toolContext!.toolInput as Record<string, unknown>;
            expect(toolInput.url).toBe('https://api.example.com');
            expect(toolInput.apiKey).toBe('[REDACTED]');
        });

        test('should accumulate text up to 200 characters, truncating older text', async () => {
            const capturedContexts: SynopsisContext[] = [];
            const mockDynamicStatusGenerator = {
                generateSynopsis: mock(async (ctx: SynopsisContext) => {
                    capturedContexts.push(ctx);
                    return 'Test status';
                }),
            };

            // Create strings that together exceed 200 chars
            const longText1 = _repeat('X', 150);
            const longText2 = _repeat('Y', 60);

            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        // Send multiple text chunks that exceed 200 chars total (210)
                        onEvent({ type: 'assistant', delta: { text: longText1 } });
                        onEvent({ type: 'assistant', delta: { text: longText2 } });
                        // Tool progress to capture the context
                        onEvent({ type: 'tool_progress', tool_name: 'Bash' });
                    }
                    return 'Response';
                }),
            };

            const middleware = createStatusMiddleware({
                presenceManager:        mockPresenceManager,
                agent:                  wrappedAgent as any,
                logger:                 mockLogger,
                dynamicStatusGenerator: mockDynamicStatusGenerator as any,
            });

            await middleware(messageContext);
            await flushPromises();

            const toolContext = _find(capturedContexts, ['phase', 'using_tool']);
            expect(toolContext).toBeDefined();
            // Should be exactly 200 chars, with older text truncated
            expect(toolContext!.accumulatedText!.length).toBe(200);
            // Should end with the most recent text (all Y's)
            expect(_endsWith(toolContext!.accumulatedText, _repeat('Y', 60))).toBe(true);
            // Should start with some X's (the tail of the first chunk)
            expect(_startsWith(toolContext!.accumulatedText, _repeat('X', 140))).toBe(true);
        });

        test('should handle undefined toolDescription for unknown tools', async () => {
            const capturedContexts: SynopsisContext[] = [];
            const mockDynamicStatusGenerator = {
                generateSynopsis: mock(async (ctx: SynopsisContext) => {
                    capturedContexts.push(ctx);
                    return 'Test status';
                }),
            };

            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        onEvent({ type: 'tool_progress', tool_name: 'UnknownTool123' });
                    }
                    return 'Response';
                }),
            };

            const middleware = createStatusMiddleware({
                presenceManager:        mockPresenceManager,
                agent:                  wrappedAgent as any,
                logger:                 mockLogger,
                dynamicStatusGenerator: mockDynamicStatusGenerator as any,
            });

            await middleware(messageContext);
            await flushPromises();

            const toolContext = _find(capturedContexts, ['phase', 'using_tool']);
            expect(toolContext).toBeDefined();
            // Unknown tool should have undefined description
            expect(toolContext!.toolDescription).toBeUndefined();
        });

        test('should pass undefined accumulatedText when no text has been accumulated', async () => {
            const capturedContexts: SynopsisContext[] = [];
            const mockDynamicStatusGenerator = {
                generateSynopsis: mock(async (ctx: SynopsisContext) => {
                    capturedContexts.push(ctx);
                    return 'Test status';
                }),
            };

            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        // Directly emit tool_progress without any text accumulation
                        onEvent({ type: 'tool_progress', tool_name: 'Read' });
                    }
                    return 'Response';
                }),
            };

            const middleware = createStatusMiddleware({
                presenceManager:        mockPresenceManager,
                agent:                  wrappedAgent as any,
                logger:                 mockLogger,
                dynamicStatusGenerator: mockDynamicStatusGenerator as any,
            });

            await middleware(messageContext);
            await flushPromises();

            const toolContext = _find(capturedContexts, ['phase', 'using_tool']);
            expect(toolContext).toBeDefined();
            // Empty string is converted to undefined
            expect(toolContext!.accumulatedText).toBeUndefined();
        });

        test('should handle undefined toolInput when no tool_use block was sent for the tool', async () => {
            const capturedContexts: SynopsisContext[] = [];
            const mockDynamicStatusGenerator = {
                generateSynopsis: mock(async (ctx: SynopsisContext) => {
                    capturedContexts.push(ctx);
                    return 'Test status';
                }),
            };

            const wrappedAgent = {
                chat: mock(async (ctx: DiscordMessageContext, onEvent?: (e: AgentStreamEvent) => void) => {
                    if(onEvent) {
                        // Emit tool_progress without any prior tool_use block
                        onEvent({ type: 'tool_progress', tool_name: 'SomeTool' });
                    }
                    return 'Response';
                }),
            };

            const middleware = createStatusMiddleware({
                presenceManager:        mockPresenceManager,
                agent:                  wrappedAgent as any,
                logger:                 mockLogger,
                dynamicStatusGenerator: mockDynamicStatusGenerator as any,
            });

            await middleware(messageContext);
            await flushPromises();

            const toolContext = _find(capturedContexts, ['phase', 'using_tool']);
            expect(toolContext).toBeDefined();
            // No tool_use block means undefined toolInput
            expect(toolContext!.toolInput).toBeUndefined();
        });
    });
});
