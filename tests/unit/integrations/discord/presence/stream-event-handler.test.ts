/* eslint-disable @typescript-eslint/no-unnecessary-condition -- Test assertions use optional chaining on mock call args for defensive access; casts are non-nullable but ?. provides safety */
/**
 * Stream Event Handler Test Suite
 *
 * Tests the reusable stream event handler for Discord presence updates.
 * Focuses on killing specific mutants identified in Stryker analysis.
 *
 * Target mutants:
 * 1. Mutant 2643 (line 201) - Type guard for thinking blocks
 * 2. Mutants 2653, 2655, 2656 (lines 214-216) - Tool use detection and early return
 * 3. Mutant 2666 (lines 226-228) - Early return after tool_use
 * 4. Mutant 2670 (line 233) - Phase change gate
 * 5. Mutant 2727 (line 299) - Result event completion check
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import constant from 'lodash/constant';
import endsWith from 'lodash/endsWith';
import filter from 'lodash/filter';
import find from 'lodash/find';
import repeat from 'lodash/repeat';
import some from 'lodash/some';
import type { AgentStreamEvent } from '../../../../../src/agent/types.js';
import type { PresenceManager } from '../../../../../src/integrations/discord/presence/manager.js';
import type { DynamicStatusGenerator } from '../../../../../src/integrations/discord/presence/status-generator-dynamic.js';
import { createStreamEventHandler, type StreamEventHandlerDeps  } from '../../../../../src/integrations/discord/presence/stream-event-handler.js';
import type { SynopsisContext } from '../../../../../src/integrations/discord/presence/types.js';
import type { BotStateManager } from '../../../../../src/integrations/discord/state/index.js';

// Helper to wait for async promises to settle
const flushPromises = (): Promise<void> => new Promise((resolve) => {
    queueMicrotask(resolve);
});

// Typed mock shape for BotStateManager that exposes mock methods
type MockFn = ReturnType<typeof mock>;
interface MockedBotStateManager {
    shouldUpdatePresence: MockFn
    updateActivityPhase:  MockFn
    clearActivityPhase:   MockFn
    recordPresenceUpdate: MockFn
    getMode:              MockFn
    goIdle:               MockFn
}

describe('StreamEventHandler', () => {
    let mockPresenceManager: PresenceManager;
    let mockDynamicStatusGenerator: DynamicStatusGenerator;
    let mockLogger: StreamEventHandlerDeps['logger'];
    let mockBotStateManager: MockedBotStateManager;
    let baseDeps: StreamEventHandlerDeps;

    beforeEach(() => {
        mockPresenceManager = {
            updatePhase: mock(async () => undefined),
            start:       mock(constant(undefined)),
            stop:        mock(constant(undefined)),
        } as unknown as PresenceManager;

        mockDynamicStatusGenerator = {
            generateSynopsis:        mock(async () => 'Generated synopsis'),
            generateCatchUpSynopsis: mock(async () => 'Catch-up status'),
        };

        mockLogger = {
            error: mock(constant(undefined)),
        };

        mockBotStateManager = {
            shouldUpdatePresence: mock(constant(true)),
            updateActivityPhase:  mock(() => undefined),
            clearActivityPhase:   mock(() => undefined),
            recordPresenceUpdate: mock(() => undefined),
            getMode:              mock(constant('idle' as const)),
            goIdle:               mock(() => undefined),
        };

        baseDeps = {
            presenceManager:        mockPresenceManager,
            dynamicStatusGenerator: mockDynamicStatusGenerator,
            logger:                 mockLogger,
            userMessage:            'Test message',
            messageId:              'msg-123',
            thinkingSynopsis:       'Pre-generated thinking synopsis',
            botStateManager:        mockBotStateManager as unknown as BotStateManager,
        };
    });

    describe('Mutant 2643 - Type guard for thinking blocks', () => {
        it('should NOT accumulate thinking content from non-thinking blocks (type: "text")', async () => {
            const capturedContexts: SynopsisContext[] = [];
            mockDynamicStatusGenerator.generateSynopsis = mock(async (ctx) => {
                capturedContexts.push(ctx);
                return 'Test status';
            });

            const { onStreamEvent } = createStreamEventHandler({ ...baseDeps, botStateManager: mockBotStateManager as unknown as BotStateManager });

            // Send assistant event with text block (NOT thinking)
            onStreamEvent({
                type:    'assistant',
                message: {
                    content: [
                        { type: 'text', text: 'This is regular text' },
                    ],
                },
            } as AgentStreamEvent);

            // Trigger another thinking phase event to capture context
            onStreamEvent({ type: 'assistant' } as AgentStreamEvent);
            await flushPromises();

            // Verify thinkingContent is still undefined (text blocks should not be accumulated)
            const thinkingContext = find(capturedContexts, { phase: 'thinking' });
            expect(thinkingContext?.thinkingContent).toBeUndefined();
        });

        it('should accumulate thinking content ONLY from blocks with type: "thinking" AND non-empty thinking property', async () => {
            const capturedContexts: SynopsisContext[] = [];
            mockDynamicStatusGenerator.generateSynopsis = mock(async (ctx) => {
                capturedContexts.push(ctx);
                return 'Test status';
            });

            const { onStreamEvent } = createStreamEventHandler({ ...baseDeps, botStateManager: mockBotStateManager as unknown as BotStateManager });

            // Send assistant event with thinking blocks
            onStreamEvent({
                type:    'assistant',
                message: {
                    content: [
                        { type: 'thinking', thinking: 'First thought' },
                        { type: 'text', text: 'Regular text' }, // Should be ignored
                        { type: 'thinking', thinking: 'Second thought' },
                        { type: 'thinking' }, // Missing thinking property - should be ignored
                    ],
                },
            } as AgentStreamEvent);

            // Trigger thinking phase update
            onStreamEvent({ type: 'assistant' } as AgentStreamEvent);
            await flushPromises();

            // Verify only blocks with type: 'thinking' AND thinking property were accumulated
            const thinkingContext = find(capturedContexts, { phase: 'thinking' });
            expect(thinkingContext?.thinkingContent).toBe('First thoughtSecond thought');
        });
    });

    describe('Mutants 2653, 2655, 2656 - Tool use detection and early return', () => {
        it('should trigger handleToolPhaseTransition when assistant event contains tool_use blocks', async () => {
            const { onStreamEvent } = createStreamEventHandler(baseDeps);

            // Send assistant event with tool_use block
            onStreamEvent({
                type:    'assistant',
                message: {
                    content: [
                        {
                            type:  'tool_use',
                            id:    'tool1',
                            name:  'Read',
                            input: { file_path: '/test.txt' },
                        },
                    ],
                },
            } as AgentStreamEvent);
            await flushPromises();

            // Verify updateActivityPhase was called with 'using_tool' phase
            expect(mockBotStateManager.updateActivityPhase).toHaveBeenCalledWith(
                expect.objectContaining({
                    type:     'using_tool',
                    toolName: 'Read',
                })
            );
        });

        it('should set hadToolUseUpdate flag when tool_use blocks are detected, causing early return', async () => {
            const { onStreamEvent } = createStreamEventHandler(baseDeps);

            // Reset mock to count calls
            mockBotStateManager.updateActivityPhase.mockClear();

            // Send assistant event with BOTH tool_use blocks AND delta.text
            onStreamEvent({
                type:    'assistant',
                delta:   { text: 'Some text' },
                message: {
                    content: [
                        {
                            type:  'tool_use',
                            id:    'tool1',
                            name:  'Bash',
                            input: { command: 'ls' },
                        },
                    ],
                },
            } as AgentStreamEvent);
            await flushPromises();

            // Verify updatePhase was called ONLY ONCE with 'using_tool'
            // The early return should prevent thinking/responding phase detection
            expect(mockBotStateManager.updateActivityPhase).toHaveBeenCalledTimes(1);
            expect(mockBotStateManager.updateActivityPhase).toHaveBeenCalledWith(
                expect.objectContaining({
                    type:     'using_tool',
                    toolName: 'Bash',
                })
            );

            // Verify it was NOT called with 'responding' phase (due to early return)
            const calls = mockBotStateManager.updateActivityPhase.mock.calls;
            const respondingCalls = filter(calls, (call: unknown[]) => (call[0] as { type?: string })?.type === 'responding');
            expect(respondingCalls.length).toBe(0);
        });
    });

    describe('Mutant 2666 - Early return after tool_use', () => {
        it('should NOT update thinking/responding phase when hadToolUseUpdate is true', async () => {
            const { onStreamEvent } = createStreamEventHandler(baseDeps);

            mockBotStateManager.updateActivityPhase.mockClear();

            // Send assistant event with BOTH tool_use blocks AND no delta.text (would be thinking)
            onStreamEvent({
                type:    'assistant',
                message: {
                    content: [
                        {
                            type:  'tool_use',
                            id:    'tool1',
                            name:  'Grep',
                            input: { pattern: 'test' },
                        },
                    ],
                },
            } as AgentStreamEvent);
            await flushPromises();

            // Should ONLY have 'using_tool' update, NOT 'thinking'
            expect(mockBotStateManager.updateActivityPhase).toHaveBeenCalledTimes(1);
            expect(mockBotStateManager.updateActivityPhase).toHaveBeenCalledWith(
                expect.objectContaining({
                    type:     'using_tool',
                    toolName: 'Grep',
                })
            );

            const calls = mockBotStateManager.updateActivityPhase.mock.calls;
            const thinkingCalls = filter(calls, (call: unknown[]) => (call[0] as { type?: string })?.type === 'thinking');
            expect(thinkingCalls.length).toBe(0);
        });

        it('should verify early return happens before responding phase detection', async () => {
            const { onStreamEvent } = createStreamEventHandler(baseDeps);

            mockBotStateManager.updateActivityPhase.mockClear();

            // Send assistant event with tool_use AND delta.text (would normally be responding)
            onStreamEvent({
                type:    'assistant',
                delta:   { text: 'Response text' },
                message: {
                    content: [
                        {
                            type:  'tool_use',
                            id:    'tool1',
                            name:  'WebSearch',
                            input: { query: 'test query' },
                        },
                    ],
                },
            } as AgentStreamEvent);
            await flushPromises();

            // Verify ONLY 'using_tool' update happened (early return prevented 'responding')
            expect(mockBotStateManager.updateActivityPhase).toHaveBeenCalledTimes(1);

            const calls = mockBotStateManager.updateActivityPhase.mock.calls;
            expect((calls[0]?.[0] as { type?: string })?.type).toBe('using_tool');

            const respondingCalls = filter(calls, (call: unknown[]) => (call[0] as { type?: string })?.type === 'responding');
            expect(respondingCalls.length).toBe(0);
        });
    });

    describe('Mutant 2727 - Result event completion check (event.type === "result")', () => {
        it('should transition to idle phase when event.type is "result"', async () => {
            const { onStreamEvent } = createStreamEventHandler(baseDeps);

            mockBotStateManager.clearActivityPhase.mockClear();

            // Send result event
            onStreamEvent({ type: 'result', subtype: 'success' } as AgentStreamEvent);
            await flushPromises();

            // Verify idle phase transition (clears activity)
            expect(mockBotStateManager.clearActivityPhase).toHaveBeenCalled();
        });

        it('should NOT transition to idle for non-result events', async () => {
            const { onStreamEvent } = createStreamEventHandler(baseDeps);

            mockBotStateManager.clearActivityPhase.mockClear();
            mockBotStateManager.updateActivityPhase.mockClear();

            // Send various non-result events
            onStreamEvent({ type: 'assistant' } as AgentStreamEvent);
            onStreamEvent({ type: 'assistant', delta: { text: 'Hi' } } as AgentStreamEvent);
            onStreamEvent({ type: 'tool_progress', tool_name: 'Read' } as AgentStreamEvent);
            await flushPromises();

            // Verify NO idle phase transitions occurred
            expect(mockBotStateManager.clearActivityPhase).not.toHaveBeenCalled();

            // Verify we got thinking, responding, and using_tool instead
            const calls = mockBotStateManager.updateActivityPhase.mock.calls;
            expect(some(calls, (call: unknown[]) => (call[0] as { type?: string })?.type === 'thinking')).toBe(true);
            expect(some(calls, (call: unknown[]) => (call[0] as { type?: string })?.type === 'responding')).toBe(true);
            expect(some(calls, (call: unknown[]) => (call[0] as { type?: string })?.type === 'using_tool')).toBe(true);
        });

        it('should NOT transition to idle for other event types (tool_result, user, system)', async () => {
            const { onStreamEvent } = createStreamEventHandler(baseDeps);

            mockBotStateManager.clearActivityPhase.mockClear();

            // Send events that would reach the else-if but are NOT 'result' type
            // These events don't match 'assistant' or 'tool_progress', so they reach the final else-if
            onStreamEvent({ type: 'tool_result', tool_name: 'Bash' } as AgentStreamEvent);
            onStreamEvent({ type: 'user' } as AgentStreamEvent);
            onStreamEvent({ type: 'system', subtype: 'init' } as AgentStreamEvent);
            await flushPromises();

            // Verify NO idle phase transitions occurred
            // With the mutation (event.type === 'result' replaced with true), these would trigger idle
            // Without mutation, they should be ignored
            expect(mockBotStateManager.clearActivityPhase).not.toHaveBeenCalled();
        });

        it('should verify complete() only clears activity phase without calling goIdle', async () => {
            mockBotStateManager.getMode = mock(constant('processing_message' as const));
            const { complete } = createStreamEventHandler(baseDeps);

            mockBotStateManager.clearActivityPhase.mockClear();
            mockBotStateManager.goIdle.mockClear();

            // Call complete()
            complete();
            await flushPromises();

            // Verify only clearActivityPhase is called, NOT goIdle
            expect(mockBotStateManager.clearActivityPhase).toHaveBeenCalled();
            expect(mockBotStateManager.goIdle).not.toHaveBeenCalled();
        });
    });

    describe('Null synopsis handling', () => {
        it('should NOT update phase when generateSynopsis returns null', async () => {
            // Configure generateSynopsis to return null (simulating in-flight/failed Haiku call)
            mockDynamicStatusGenerator.generateSynopsis = mock(async () => null);

            const { onStreamEvent } = createStreamEventHandler(baseDeps);

            // Clear any setup calls
            mockBotStateManager.updateActivityPhase.mockClear();

            // Trigger responding phase (fires async synopsis via updatePhaseWithSynopsis)
            onStreamEvent({ type: 'assistant', delta: { text: 'Hello' } } as AgentStreamEvent);
            await flushPromises();

            // updateActivityPhase should NOT have been called — null means skip the update entirely
            expect(mockBotStateManager.updateActivityPhase).not.toHaveBeenCalled();
        });

        it('should NOT update thinking phase when generateSynopsis returns null', async () => {
            // Configure generateSynopsis to return null
            mockDynamicStatusGenerator.generateSynopsis = mock(async () => null);

            const { onStreamEvent } = createStreamEventHandler(baseDeps);

            // Send thinking content to trigger the thinking synopsis async path
            onStreamEvent({
                type:    'assistant',
                message: {
                    content: [
                        { type: 'thinking', thinking: 'Some deep thought' },
                    ],
                },
            } as unknown as AgentStreamEvent);

            // Trigger thinking phase update with accumulated content
            onStreamEvent({ type: 'assistant' } as AgentStreamEvent);

            // Clear mocks after the initial thinking transition (pre-generated synopsis path)
            mockBotStateManager.updateActivityPhase.mockClear();

            // Transition to responding to reset currentPhase
            onStreamEvent({ type: 'assistant', delta: { text: 'Hello' } } as AgentStreamEvent);
            await flushPromises();
            mockBotStateManager.updateActivityPhase.mockClear();

            // Transition back to thinking with accumulated content — triggers the inline async block
            onStreamEvent({ type: 'assistant' } as AgentStreamEvent);
            await flushPromises();

            // updateActivityPhase should NOT have been called with thinking phase
            // because null synopsis means skip the update
            expect(mockBotStateManager.updateActivityPhase).not.toHaveBeenCalled();
        });
    });

    describe('Error handling', () => {
        it('should handle botStateManager.updateActivityPhase errors gracefully', async () => {
            // Configure botStateManager to throw
            mockBotStateManager.updateActivityPhase = mock(() => {
                throw new Error('Update phase failed');
            });

            const { onStreamEvent } = createStreamEventHandler(baseDeps);

            // Should not throw
            expect(() => {
                onStreamEvent({ type: 'assistant' } as AgentStreamEvent);
            }).not.toThrow();

            await flushPromises();

            // Error should be logged
            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.objectContaining({
                    error:     expect.any(Error),
                    messageId: 'msg-123',
                }),
                'Failed to update presence from stream event'
            );
        });
    });

    describe('Tool input storage and redaction', () => {
        it('should store redacted tool inputs from tool_use blocks', async () => {
            const capturedContexts: SynopsisContext[] = [];
            mockDynamicStatusGenerator.generateSynopsis = mock(async (ctx) => {
                capturedContexts.push(ctx);
                return 'Test status';
            });

            const { onStreamEvent } = createStreamEventHandler({ ...baseDeps, botStateManager: mockBotStateManager as unknown as BotStateManager });

            // Send assistant event with tool_use containing sensitive data
            onStreamEvent({
                type:    'assistant',
                message: {
                    content: [
                        {
                            type:  'tool_use',
                            id:    'tool1',
                            name:  'WebFetch',
                            input: {
                                url:    'https://example.com',
                                apiKey: 'secret-key-123',
                            },
                        },
                    ],
                },
            } as AgentStreamEvent);

            // Send tool_progress to capture context
            onStreamEvent({ type: 'tool_progress', tool_name: 'WebFetch' } as AgentStreamEvent);
            await flushPromises();

            // Verify toolInput was stored and redacted
            const toolContext = find(capturedContexts, { phase: 'using_tool' });
            expect(toolContext?.toolInput).toBeDefined();
            expect((toolContext?.toolInput as Record<string, string>).url).toBe('https://example.com');
            expect((toolContext?.toolInput as Record<string, string>).apiKey).toBe('[REDACTED]');
        });
    });

    describe('Dynamic synopsis generation', () => {
        it('should use thinkingSynopsis fallback when generateSynopsis throws an error', async () => {
            // Setup: generateSynopsis throws an error
            mockDynamicStatusGenerator.generateSynopsis = mock(async () => {
                throw new Error('Synopsis generation failed');
            });

            const deps = {
                ...baseDeps,
                thinkingSynopsis: 'Fallback thinking status',
            };

            const { onStreamEvent } = createStreamEventHandler(deps);

            // Send event with thinking content to trigger the async synopsis path
            onStreamEvent({
                type:    'assistant',
                message: {
                    content: [
                        { type: 'thinking', thinking: 'Some thinking content' },
                    ],
                },
            } as unknown as AgentStreamEvent);

            // Second event to trigger thinking phase update with accumulated content
            onStreamEvent({ type: 'assistant' } as AgentStreamEvent);
            await flushPromises();
            // Additional wait for the nested async in the catch block
            await flushPromises();

            // Verify fallback to thinkingSynopsis was used
            const calls = mockBotStateManager.updateActivityPhase.mock.calls;
            const thinkingCalls = filter(calls, (call: unknown[]) => (call[0] as { type?: string })?.type === 'thinking');

            // Find a call that used the fallback thinkingSynopsis
            const fallbackCall = find(thinkingCalls, (call: unknown[]) =>
                (call[0] as { generatedStatus?: string })?.generatedStatus === 'Fallback thinking status'
            );
            expect(fallbackCall).toBeDefined();
        });
    });

    describe('Accumulated state management', () => {
        it('should accumulate response text with 200-char limit', async () => {
            const capturedContexts: SynopsisContext[] = [];
            mockDynamicStatusGenerator.generateSynopsis = mock(async (ctx) => {
                capturedContexts.push(ctx);
                return 'Test status';
            });

            const { onStreamEvent } = createStreamEventHandler({ ...baseDeps, botStateManager: mockBotStateManager as unknown as BotStateManager });

            // Send multiple text chunks exceeding 200 chars
            const longText1 = repeat('X', 150);
            const longText2 = repeat('Y', 60);

            onStreamEvent({ type: 'assistant', delta: { text: longText1 } } as AgentStreamEvent);
            onStreamEvent({ type: 'assistant', delta: { text: longText2 } } as AgentStreamEvent);

            // Trigger tool phase to capture accumulated text
            onStreamEvent({ type: 'tool_progress', tool_name: 'Bash' } as AgentStreamEvent);
            await flushPromises();

            const toolContext = find(capturedContexts, { phase: 'using_tool' });
            expect(toolContext?.accumulatedText).toBeDefined();
            expect(toolContext!.accumulatedText!.length).toBe(200);
            // Should end with most recent text
            expect(endsWith(toolContext!.accumulatedText, repeat('Y', 60))).toBe(true);
        });

        it('should track recent tool calls with MAX_RECENT_TOOLS limit', async () => {
            const capturedContexts: SynopsisContext[] = [];
            mockDynamicStatusGenerator.generateSynopsis = mock(async (ctx) => {
                capturedContexts.push(ctx);
                return 'Test status';
            });

            const { onStreamEvent } = createStreamEventHandler({ ...baseDeps, botStateManager: mockBotStateManager as unknown as BotStateManager });

            // Send 5 tool calls (exceeds MAX_RECENT_TOOLS of 3)
            onStreamEvent({ type: 'tool_progress', tool_name: 'Tool1' } as AgentStreamEvent);
            onStreamEvent({ type: 'tool_progress', tool_name: 'Tool2' } as AgentStreamEvent);
            onStreamEvent({ type: 'tool_progress', tool_name: 'Tool3' } as AgentStreamEvent);
            onStreamEvent({ type: 'tool_progress', tool_name: 'Tool4' } as AgentStreamEvent);
            onStreamEvent({ type: 'tool_progress', tool_name: 'Tool5' } as AgentStreamEvent);

            // Trigger thinking phase to capture recentToolCalls
            onStreamEvent({ type: 'assistant' } as AgentStreamEvent);
            await flushPromises();

            const thinkingContext = find(capturedContexts, { phase: 'thinking' });
            expect(thinkingContext?.recentToolCalls).toBeDefined();
            // Should only keep last 3 tools (most recent first)
            expect(thinkingContext?.recentToolCalls).toEqual(['Tool5', 'Tool4', 'Tool3']);
        });
    });

    describe('Stale synopsis after complete()', () => {
        it('should NOT apply async synopsis after complete() is called', async () => {
            let synopsisResolve: ((value: string) => void) | undefined;

            const controlledGenerator: DynamicStatusGenerator = {
                generateSynopsis: mock(() => new Promise<string>((resolve) => {
                    synopsisResolve = resolve;
                })),
                generateCatchUpSynopsis: mock(async () => 'Catch-up status'),
            };

            const { onStreamEvent, complete } = createStreamEventHandler({
                ...baseDeps,
                dynamicStatusGenerator: controlledGenerator,
            });

            // Clear any setup calls
            mockBotStateManager.updateActivityPhase.mockClear();

            // Trigger responding phase (fires async synopsis)
            onStreamEvent({ type: 'assistant', delta: { text: 'Hello' } } as AgentStreamEvent);

            // Synopsis should have been requested
            expect(controlledGenerator.generateSynopsis).toHaveBeenCalled();

            // Complete the handler BEFORE synopsis resolves
            complete();

            // Now resolve the synopsis
            synopsisResolve!('Stale synopsis');
            await flushPromises();

            // updateActivityPhase should NOT have been called with the stale synopsis
            const calls = mockBotStateManager.updateActivityPhase.mock.calls;
            const staleCalls = filter(calls, (call: unknown[]) =>
                (call[0] as { generatedStatus?: string })?.generatedStatus === 'Stale synopsis'
            );
            expect(staleCalls).toHaveLength(0);
        });

        it('should NOT apply fallback phase after complete() when synopsis throws', async () => {
            let synopsisReject: ((error: Error) => void) | undefined;

            const controlledGenerator: DynamicStatusGenerator = {
                generateSynopsis: mock(() => new Promise<string>((_resolve, reject) => {
                    synopsisReject = reject;
                })),
                generateCatchUpSynopsis: mock(async () => 'Catch-up status'),
            };

            const { onStreamEvent, complete } = createStreamEventHandler({
                ...baseDeps,
                dynamicStatusGenerator: controlledGenerator,
            });

            // Clear any setup calls
            mockBotStateManager.updateActivityPhase.mockClear();

            // Trigger responding phase (fires async synopsis)
            onStreamEvent({ type: 'assistant', delta: { text: 'Hello' } } as AgentStreamEvent);

            // Complete the handler BEFORE synopsis rejects
            complete();

            // Now reject the synopsis
            synopsisReject!(new Error('Generation failed'));
            await flushPromises();

            // updateActivityPhase should NOT have been called after complete()
            const callsAfterComplete = mockBotStateManager.updateActivityPhase.mock.calls;
            // Only calls before complete() should exist (the initial non-synopsis update)
            const postCompleteCalls = filter(callsAfterComplete, (call: unknown[]) => {
                const phase = call[0] as { type?: string };
                return phase?.type === 'responding';
            });
            expect(postCompleteCalls).toHaveLength(0);
        });

        it('should NOT apply stale thinking synopsis after complete() is called', async () => {
            let synopsisResolve: ((value: string) => void) | undefined;

            const controlledGenerator: DynamicStatusGenerator = {
                generateSynopsis: mock(() => new Promise<string>((resolve) => {
                    synopsisResolve = resolve;
                })),
                generateCatchUpSynopsis: mock(async () => 'Catch-up status'),
            };

            const { onStreamEvent, complete } = createStreamEventHandler({
                ...baseDeps,
                dynamicStatusGenerator: controlledGenerator,
            });

            // Clear any setup calls
            mockBotStateManager.updateActivityPhase.mockClear();

            // Step 1: Accumulate thinking content
            onStreamEvent({
                type:    'assistant',
                message: {
                    content: [
                        { type: 'thinking', thinking: 'Some deep thought' },
                    ],
                },
            } as unknown as AgentStreamEvent);

            // Step 2: Transition to responding (to set currentPhase away from thinking)
            onStreamEvent({ type: 'assistant', delta: { text: 'Hello' } } as AgentStreamEvent);
            await flushPromises();

            // Step 3: Clear mocks and transition back to thinking — this triggers the
            // inline thinking synopsis async block (because hasThinkingContent is true)
            mockBotStateManager.updateActivityPhase.mockClear();
            (controlledGenerator.generateSynopsis as ReturnType<typeof mock>).mockClear();

            onStreamEvent({ type: 'assistant' } as AgentStreamEvent);

            // Synopsis should have been requested for thinking phase
            expect(controlledGenerator.generateSynopsis).toHaveBeenCalled();

            // Complete the handler BEFORE synopsis resolves
            complete();

            // Now resolve the synopsis
            synopsisResolve!('Stale thinking synopsis');
            await flushPromises();

            // updateActivityPhase should NOT have been called with the stale thinking synopsis
            const calls = mockBotStateManager.updateActivityPhase.mock.calls;
            const staleCalls = filter(calls, (call: unknown[]) =>
                (call[0] as { generatedStatus?: string })?.generatedStatus === 'Stale thinking synopsis'
            );
            expect(staleCalls).toHaveLength(0);
        });

        it('should NOT apply stale thinking fallback after complete() when synopsis throws', async () => {
            let synopsisReject: ((error: Error) => void) | undefined;

            const controlledGenerator: DynamicStatusGenerator = {
                generateSynopsis: mock(() => new Promise<string>((_resolve, reject) => {
                    synopsisReject = reject;
                })),
                generateCatchUpSynopsis: mock(async () => 'Catch-up status'),
            };

            const { onStreamEvent, complete } = createStreamEventHandler({
                ...baseDeps,
                dynamicStatusGenerator: controlledGenerator,
                thinkingSynopsis:       'Thinking fallback',
            });

            // Clear any setup calls
            mockBotStateManager.updateActivityPhase.mockClear();

            // Step 1: Accumulate thinking content
            onStreamEvent({
                type:    'assistant',
                message: {
                    content: [
                        { type: 'thinking', thinking: 'Some deep thought' },
                    ],
                },
            } as unknown as AgentStreamEvent);

            // Step 2: Transition to responding
            onStreamEvent({ type: 'assistant', delta: { text: 'Hello' } } as AgentStreamEvent);
            await flushPromises();

            // Step 3: Clear mocks and transition back to thinking
            mockBotStateManager.updateActivityPhase.mockClear();

            onStreamEvent({ type: 'assistant' } as AgentStreamEvent);

            // Complete the handler BEFORE synopsis rejects
            complete();

            // Now reject the synopsis
            synopsisReject!(new Error('Generation failed'));
            await flushPromises();

            // updateActivityPhase should NOT have been called with the fallback after complete()
            const calls = mockBotStateManager.updateActivityPhase.mock.calls;
            const fallbackCalls = filter(calls, (call: unknown[]) =>
                (call[0] as { generatedStatus?: string })?.generatedStatus === 'Thinking fallback'
            );
            expect(fallbackCalls).toHaveLength(0);
        });
    });

    describe('onThinkingContentUpdate callback', () => {
        it('should fire callback when thinking content is accumulated', async () => {
            const capturedUpdates: string[] = [];
            const onThinkingContentUpdate = mock((content: string) => {
                capturedUpdates.push(content);
            });

            const { onStreamEvent } = createStreamEventHandler({
                ...baseDeps,
                onThinkingContentUpdate,
            });

            // Send assistant event with thinking block
            onStreamEvent({
                type:    'assistant',
                message: {
                    content: [
                        { type: 'thinking', thinking: 'First thought' },
                    ],
                },
            } as unknown as AgentStreamEvent);

            await flushPromises();

            expect(onThinkingContentUpdate).toHaveBeenCalled();
            expect(capturedUpdates).toContain('First thought');
        });

        it('should receive full accumulated content including previous content', async () => {
            const capturedUpdates: string[] = [];
            const onThinkingContentUpdate = mock((content: string) => {
                capturedUpdates.push(content);
            });

            const { onStreamEvent } = createStreamEventHandler({
                ...baseDeps,
                onThinkingContentUpdate,
            });

            // Send first thinking block
            onStreamEvent({
                type:    'assistant',
                message: {
                    content: [
                        { type: 'thinking', thinking: 'First thought. ' },
                    ],
                },
            } as unknown as AgentStreamEvent);

            await flushPromises();

            // Send second thinking block
            onStreamEvent({
                type:    'assistant',
                message: {
                    content: [
                        { type: 'thinking', thinking: 'Second thought.' },
                    ],
                },
            } as unknown as AgentStreamEvent);

            await flushPromises();

            // Last callback should have both thoughts
            const lastUpdate = capturedUpdates[capturedUpdates.length - 1];
            expect(lastUpdate).toContain('First thought. Second thought.');
        });

        it('should not throw error when callback is not provided', async () => {
            const { onStreamEvent } = createStreamEventHandler({
                ...baseDeps,
                // No onThinkingContentUpdate provided
            });

            // This should not throw
            expect(() => {
                onStreamEvent({
                    type:    'assistant',
                    message: {
                        content: [
                            { type: 'thinking', thinking: 'Some thought' },
                        ],
                    },
                } as unknown as AgentStreamEvent);
            }).not.toThrow();
        });
    });
});
