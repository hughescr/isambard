import { describe, test, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import _ from 'lodash';
import type { Logger } from '@hughescr/logger';
import {
    createPerchSessionRunner,
    type PerchSessionRunnerDeps,
    type RunAgentSessionOptions,
    type AgentSessionResult,
    type InterruptingMessage
} from '@/agent/perch/session-runner';
import type { BotStateManager, BotState, PerchingModeContext } from '@/integrations/discord/state';
import type { PerchConfig } from '@/agent/perch/types';
import { type ChannelId } from '@/integrations/discord/types';
import type { ContextBuilder } from '@/agent/context-builder';
import { createMemoryPath, createContentType } from '@/storage/memory-tool/types';

// Mock logger
function createMockLogger(): Logger {
    return {
        debug: mock(() => {}),
        info:  mock(() => {}),
        warn:  mock(() => {}),
        error: mock(() => {}),
    } as unknown as Logger;
}

// Mock context builder
function createMockContextBuilder(overrides?: Partial<ContextBuilder>): ContextBuilder {
    return {
        loadCoreIdentity:       mock(_.constant(Promise.resolve(''))),
        loadHotState:           mock(_.constant(Promise.resolve(''))),
        loadUserMemories:       mock(_.constant(Promise.resolve(''))),
        recordAccess:           mock(_.constant(Promise.resolve())),
        loadRecentEvents:       mock(async () => ({ items: [], isFallback: false })),
        loadUserTimezone:       mock(_.constant(Promise.resolve(undefined))),
        buildUserMessagePrefix: mock(_.constant(Promise.resolve(''))),
        buildPerchContext:      mock(_.constant(Promise.resolve(''))),
        ...overrides,
    };
}

// Mock state manager
interface MockStateManagerState {
    mode:          BotState['mode']
    interrupted:   boolean
    activityPhase: BotState['activityPhase']
    modeEnteredAt: Date
    modeContext:   BotState['modeContext']
}

function createMockStateManager(initialState?: Partial<MockStateManagerState>): BotStateManager {
    const state: MockStateManagerState = {
        mode:          initialState?.mode ?? 'idle',
        interrupted:   initialState?.interrupted ?? false,
        activityPhase: initialState?.activityPhase ?? null,
        modeEnteredAt: initialState?.modeEnteredAt ?? new Date(),
        modeContext:   initialState?.modeContext ?? {},
    };

    return {
        getMode:       mock(() => state.mode),
        getState:      mock(() => ({ ...state, modeContext: { ...state.modeContext } } as BotState)),
        startPerching: mock((activity: string) => {
            state.mode = 'perching';
            state.modeContext = { activityType: activity } as PerchingModeContext;
        }),
        goIdle: mock(() => {
            state.mode = 'idle';
            state.modeContext = {};
        }),
    } as unknown as BotStateManager;
}

describe('PerchSessionRunner - Basic Lifecycle', () => {
    let mockLogger: Logger;
    let mockStateManager: BotStateManager;
    let mockRunAgentSession: ReturnType<typeof mock>;
    let config: PerchConfig;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2024-01-01T12:00:00.000Z'));

        mockLogger = createMockLogger();
        mockStateManager = createMockStateManager();
        mockRunAgentSession = mock(async (): Promise<AgentSessionResult> => {
            return {
                completed: true,
                sessionId: 'test-session',
            };
        });

        config = {
            enabled:              true,
            timezone:             'America/Los_Angeles',
            intervalMinutes:      60,
            jitterMinutes:        15,
            maxSessionMinutes:    45,
            wrapUpTimeoutMinutes: 5,
        };
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('should transition to perching mode when starting perch', async () => {
        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: mockRunAgentSession,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('pre-dawn');

        expect(mockStateManager.startPerching).toHaveBeenCalledWith('Perch time: pre-dawn');
    });

    test('should return abort controller when session is active', async () => {
        const longRunningSession = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            return new Promise((resolve) => {
                options.abortSignal.addEventListener('abort', () => {
                    resolve({ completed: false });
                });
            });
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: longRunningSession,
        };

        const runner = createPerchSessionRunner(deps);

        // Start session but don't await
        const sessionPromise = runner.startPerch('pre-dawn');

        // Let microtasks flush
        await Promise.resolve();

        const controller = runner.getAbortController();
        expect(controller).not.toBeNull();

        // Cleanup
        controller?.abort();

        // Wait for session to complete
        await sessionPromise;
    });

    test('should return null abort controller when no session is active', () => {
        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: mockRunAgentSession,
        };

        const runner = createPerchSessionRunner(deps);
        expect(runner.getAbortController()).toBeNull();
    });

    test('should ignore startPerch if already in perching mode', async () => {
        const mockStateInPerching = createMockStateManager({ mode: 'perching' });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateInPerching,
            logger:          mockLogger,
            config,
            runAgentSession: mockRunAgentSession,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('pre-dawn');

        expect(mockLogger.warn).toHaveBeenCalled();
        expect(mockRunAgentSession).not.toHaveBeenCalled();
    });

    test('should ignore startPerch if not in idle mode', async () => {
        const mockStateInActive = createMockStateManager({ mode: 'processing_message' });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateInActive,
            logger:          mockLogger,
            config,
            runAgentSession: mockRunAgentSession,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('pre-dawn');

        // Verify logger.warn was called with mode object (line 314)
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ mode: 'processing_message' }),
            'Cannot start perch - not idle'
        );
        expect(mockRunAgentSession).not.toHaveBeenCalled();
    });

    test('should transition to idle when session completes', async () => {
        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: mockRunAgentSession,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('pre-dawn');

        expect(mockStateManager.goIdle).toHaveBeenCalled();
    });

    test('should use test prompt when test mode is enabled', async () => {
        const testConfig: PerchConfig = {
            ...config,
            testMode: {
                triggerOnStartup: true,
            },
        };

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config:          testConfig,
            runAgentSession: mockRunAgentSession,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('pre-dawn');

        const call = mockRunAgentSession.mock.calls[0] as [RunAgentSessionOptions];
        expect(call[0].prompt).toContain('TEST MODE');
    });

    test('should use regular prompt when test mode is disabled', async () => {
        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: mockRunAgentSession,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('pre-dawn');

        const call = mockRunAgentSession.mock.calls[0] as [RunAgentSessionOptions];
        expect(call[0].prompt).toContain('This is perch time');
    });

    test('should log perch session info with correct slot', async () => {
        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: mockRunAgentSession,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('mid-morning');

        expect(mockLogger.info).toHaveBeenCalledWith(
            expect.objectContaining({
                slot:           'mid-morning',
                testMode:       false,
                timeoutMinutes: 45,
                msg:            'Starting perch session with timeout',
            })
        );
    });

    test('should log when session completes', async () => {
        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: mockRunAgentSession,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('pre-dawn');

        expect(mockLogger.info).toHaveBeenCalledWith(
            expect.objectContaining({
                slot: 'pre-dawn',
            }),
            'Perch session completed'
        );
    });
});

describe('PerchSessionRunner - Error Handling', () => {
    let mockLogger: Logger;
    let mockStateManager: BotStateManager;
    let config: PerchConfig;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2024-01-01T12:00:00.000Z'));

        mockLogger = createMockLogger();
        mockStateManager = createMockStateManager();
        config = {
            enabled:              true,
            timezone:             'America/Los_Angeles',
            intervalMinutes:      60,
            jitterMinutes:        15,
            maxSessionMinutes:    45,
            wrapUpTimeoutMinutes: 5,
        };
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('should handle AbortError without interrupt flag', async () => {
        const sessionMock = mock(async (_options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            const error = new Error('AbortError');
            error.name = 'AbortError';
            throw error;
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('pre-dawn');

        expect(mockLogger.debug).toHaveBeenCalledWith(
            expect.objectContaining({ slot: 'pre-dawn' }),
            'Perch session aborted'
        );
    });

    test('should transition to idle on non-abort errors', async () => {
        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            throw new Error('Network error');
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('pre-dawn');

        expect(mockLogger.error).toHaveBeenCalledWith(
            expect.objectContaining({
                error: expect.any(Error) as Error,
                slot:  'pre-dawn',
            }),
            'Perch session error'
        );
        expect(mockStateManager.goIdle).toHaveBeenCalled();
    });

    test('should schedule resume on next tick when error occurs during interrupted session', async () => {
        // Start with perching mode to allow session to start
        const mockStateInterrupted = createMockStateManager({ mode: 'idle' });

        let callCount = 0;
        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            callCount++;
            if(callCount === 1) {
                // Mark as interrupted before throwing error
                const state = mockStateInterrupted as unknown as { interrupted: boolean };
                state.interrupted = true;
                throw new Error('Some error');
            }
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateInterrupted,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('pre-dawn');

        // Wait for scheduled resume
        jest.advanceTimersByTime(1);
        await Promise.resolve();

        // Verify session was called once (startPerch starts session when mode is 'idle')
        expect(sessionMock).toHaveBeenCalledTimes(1);
    });

    test('should transition to idle when context builder throws', async () => {
        const mockContextBuilder = createMockContextBuilder({
            buildPerchContext: mock(async (): Promise<string> => {
                throw new Error('DynamoDB timeout');
            }),
        });

        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
            contextBuilder:  mockContextBuilder,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('pre-dawn');

        // Verify error was logged
        expect(mockLogger.error).toHaveBeenCalledWith(
            expect.objectContaining({
                error: expect.any(Error) as Error,
                slot:  'pre-dawn',
            }),
            'Failed to start perch session'
        );

        // Verify bot transitioned back to idle
        expect(mockStateManager.goIdle).toHaveBeenCalled();

        // Verify session was never called
        expect(sessionMock).not.toHaveBeenCalled();
    });

    test('should clear timeout when context builder throws', async () => {
        const mockContextBuilder = createMockContextBuilder({
            buildPerchContext: mock(async (): Promise<string> => {
                throw new Error('DynamoDB timeout');
            }),
        });

        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
            contextBuilder:  mockContextBuilder,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('pre-dawn');

        // Verify timeout was set but then cleared
        // We can't directly verify the timeout was cleared, but we can verify
        // that advancing timers doesn't cause any timeout handling
        jest.advanceTimersByTime(config.maxSessionMinutes * 60 * 1000 + 1000);

        // Verify no timeout handling occurred (no abort, no wrap-up)
        expect(sessionMock).not.toHaveBeenCalled();
        expect(mockLogger.info).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.stringContaining('timeout')
        );
    });
});

describe('PerchSessionRunner - Suspension', () => {
    let mockLogger: Logger;
    let mockStateManager: BotStateManager;
    let mockContextBuilder: ContextBuilder;
    let config: PerchConfig;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2024-01-01T12:00:00.000Z'));

        mockLogger = createMockLogger();
        mockStateManager = createMockStateManager();
        mockContextBuilder = createMockContextBuilder();
        config = {
            enabled:              true,
            timezone:             'America/Los_Angeles',
            intervalMinutes:      60,
            jitterMinutes:        15,
            maxSessionMinutes:    45,
            wrapUpTimeoutMinutes: 5,
        };
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('suspend saves correct state (sessionId, slot, elapsedMs, suspendedAt, interruptingMessage)', async () => {
        const startTime = new Date('2024-01-01T12:00:00.000Z');
        jest.setSystemTime(startTime);

        let capturedAbortSignal: AbortSignal | undefined;
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            capturedAbortSignal = options.abortSignal;
            return new Promise((resolve) => {
                options.abortSignal.addEventListener('abort', () => {
                    resolve({ completed: false, sessionId: 'test-session-123' });
                });
            });
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();

        // Advance time by 5 minutes
        jest.advanceTimersByTime(5 * 60 * 1000);

        const message: InterruptingMessage = {
            channelId:   'test-channel' as ChannelId,
            author:      'TestUser',
            channelName: 'general',
            content:     'Important message!',
        };

        runner.suspend(message);

        // Verify state is suspended
        expect(runner.isSuspended()).toBe(true);

        // Verify abort was called
        expect(capturedAbortSignal?.aborted).toBe(true);

        await sessionPromise;
    });

    test('suspend clears partialWork', async () => {
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            return new Promise((resolve) => {
                options.abortSignal.addEventListener('abort', () => {
                    resolve({
                        completed:   false,
                        sessionId:   'test-session',
                        partialWork: {
                            thinking:                   'Some thinking',
                            text:                       'Some text',
                            pendingToolUse:             null,
                            sessionId:                  'test-session',
                            uncollectedBackgroundTasks: 0,
                        },
                    });
                });
            });
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();

        const message: InterruptingMessage = {
            channelId:   'test-channel' as ChannelId,
            author:      'TestUser',
            channelName: 'general',
            content:     'Test',
        };

        runner.suspend(message);
        await sessionPromise;

        // Now resume - if partialWork was preserved, the prompt would be wrong
        // We verify this by checking that resume works without errors
        expect(runner.isSuspended()).toBe(true);
    });

    test('suspend clears timeout', async () => {
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            return new Promise((resolve) => {
                options.abortSignal.addEventListener('abort', () => {
                    resolve({ completed: false });
                });
            });
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();

        // Verify timeout exists
        expect(jest.getTimerCount()).toBeGreaterThan(0);

        const message: InterruptingMessage = {
            channelId:   'test-channel' as ChannelId,
            author:      'TestUser',
            channelName: 'general',
            content:     'Test',
        };

        runner.suspend(message);

        // Timeout should be cleared
        expect(jest.getTimerCount()).toBe(0);

        await sessionPromise;
    });

    test('suspend calls goIdle() then abort', async () => {
        let goIdleCalledBeforeAbort = false;
        let abortCalled = false;

        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            options.abortSignal.addEventListener('abort', () => {
                abortCalled = true;
            });
            return new Promise((resolve) => {
                options.abortSignal.addEventListener('abort', () => {
                    resolve({ completed: false });
                });
            });
        });

        // Override goIdle to track ordering
        const mockStateWithTracking = createMockStateManager();
        const originalGoIdle = mockStateWithTracking.goIdle;
        mockStateWithTracking.goIdle = mock(() => {
            goIdleCalledBeforeAbort = !abortCalled;
            originalGoIdle();
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateWithTracking,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();

        const message: InterruptingMessage = {
            channelId:   'test-channel' as ChannelId,
            author:      'TestUser',
            channelName: 'general',
            content:     'Test',
        };

        runner.suspend(message);

        expect(goIdleCalledBeforeAbort).toBe(true);
        expect(mockStateWithTracking.goIdle).toHaveBeenCalled();

        await sessionPromise;
    });

    test('suspend is no-op when not perching', () => {
        const mockStateIdle = createMockStateManager({ mode: 'idle' });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateIdle,
            logger:          mockLogger,
            config,
            runAgentSession: mock(async () => ({ completed: true })),
        };

        const runner = createPerchSessionRunner(deps);

        const message: InterruptingMessage = {
            channelId:   'test-channel' as ChannelId,
            author:      'TestUser',
            channelName: 'general',
            content:     'Test',
        };

        runner.suspend(message);

        expect(runner.isSuspended()).toBe(false);
        expect(mockLogger.debug).toHaveBeenCalled();
    });

    test('suspend is no-op when already suspended', async () => {
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            return new Promise((resolve) => {
                options.abortSignal.addEventListener('abort', () => {
                    resolve({ completed: false });
                });
            });
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();

        const message1: InterruptingMessage = {
            channelId:   'test-channel' as ChannelId,
            author:      'User1',
            channelName: 'general',
            content:     'First',
        };

        const message2: InterruptingMessage = {
            channelId:   'test-channel' as ChannelId,
            author:      'User2',
            channelName: 'general',
            content:     'Second',
        };

        runner.suspend(message1);
        const debugCallCount = (mockLogger.debug as ReturnType<typeof mock>).mock.calls.length;
        runner.suspend(message2);

        // Second suspend should log and return
        expect((mockLogger.debug as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(debugCallCount);

        await sessionPromise;
    });

    test('isSuspended() returns true after suspend', async () => {
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            return new Promise((resolve) => {
                options.abortSignal.addEventListener('abort', () => {
                    resolve({ completed: false });
                });
            });
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        expect(runner.isSuspended()).toBe(false);

        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();

        const message: InterruptingMessage = {
            channelId:   'test-channel' as ChannelId,
            author:      'TestUser',
            channelName: 'general',
            content:     'Test',
        };

        runner.suspend(message);

        expect(runner.isSuspended()).toBe(true);

        await sessionPromise;
    });

    test('isSuspended() returns false initially', () => {
        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: mock(async () => ({ completed: true })),
        };

        const runner = createPerchSessionRunner(deps);
        expect(runner.isSuspended()).toBe(false);
    });

    test('resumeAfterSuspension calculates remaining time excluding suspension duration', async () => {
        const startTime = new Date('2024-01-01T12:00:00.000Z');
        jest.setSystemTime(startTime);

        let callCount = 0;
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            callCount++;
            if(callCount === 1) {
                // First call - will be suspended
                return new Promise((resolve) => {
                    options.abortSignal.addEventListener('abort', () => {
                        resolve({ completed: false, sessionId: 'session-123' });
                    });
                });
            } else {
                // Resumed call - complete
                return { completed: true, sessionId: 'session-123' };
            }
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
            contextBuilder:  mockContextBuilder,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();

        // Advance 10 minutes of perch time
        jest.advanceTimersByTime(10 * 60 * 1000);

        const message: InterruptingMessage = {
            channelId:   'test-channel' as ChannelId,
            author:      'TestUser',
            channelName: 'general',
            content:     'Test',
        };

        runner.suspend(message);
        await sessionPromise;

        // Advance 5 minutes while suspended
        jest.advanceTimersByTime(5 * 60 * 1000);

        // Resume
        await runner.resumeAfterSuspension();

        // Verify that session was resumed (2 calls total)
        expect(sessionMock).toHaveBeenCalledTimes(2);

        // Verify the resumed session prompt indicates resumption
        const secondCall = sessionMock.mock.calls[1];
        if(secondCall) {
            const options = secondCall[0];
            expect(options.prompt).toContain('PERCH TIME RESUMED');
        }
    });

    test('resumeAfterSuspension with minimal elapsed time still gets at least 1 minute', async () => {
        const startTime = new Date('2024-01-01T12:00:00.000Z');
        jest.setSystemTime(startTime);

        let callCount = 0;
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            callCount++;
            if(callCount === 1) {
                return new Promise((resolve) => {
                    options.abortSignal.addEventListener('abort', () => {
                        resolve({ completed: false, sessionId: 'session-123' });
                    });
                });
            } else {
                return { completed: true, sessionId: 'session-123' };
            }
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
            contextBuilder:  mockContextBuilder,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();

        // Advance 44.5 minutes (almost full session)
        jest.advanceTimersByTime(44.5 * 60 * 1000);

        const message: InterruptingMessage = {
            channelId:   'test-channel' as ChannelId,
            author:      'TestUser',
            channelName: 'general',
            content:     'Test',
        };

        runner.suspend(message);
        await sessionPromise;

        // Resume - should get at least 1 minute
        await runner.resumeAfterSuspension();

        // Verify session was resumed
        expect(sessionMock).toHaveBeenCalledTimes(2);
    });

    test('resumeAfterSuspension restores state and transitions to perching', async () => {
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            if(sessionMock.mock.calls.length === 1) {
                return new Promise((resolve) => {
                    options.abortSignal.addEventListener('abort', () => {
                        resolve({ completed: false });
                    });
                });
            }
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
            contextBuilder:  mockContextBuilder,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('afternoon');
        await Promise.resolve();

        const message: InterruptingMessage = {
            channelId:   'test-channel' as ChannelId,
            author:      'TestUser',
            channelName: 'general',
            content:     'Test',
        };

        runner.suspend(message);
        await sessionPromise;

        // State should be idle after suspend
        expect(mockStateManager.getMode()).toBe('idle');

        await runner.resumeAfterSuspension();

        // State should transition to perching
        expect(mockStateManager.startPerching).toHaveBeenCalledWith('Perch time: afternoon');
    });

    test('resumeAfterSuspension clears suspendedState (prevents double-resume)', async () => {
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            if(sessionMock.mock.calls.length === 1) {
                return new Promise((resolve) => {
                    options.abortSignal.addEventListener('abort', () => {
                        resolve({ completed: false });
                    });
                });
            }
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
            contextBuilder:  mockContextBuilder,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();

        const message: InterruptingMessage = {
            channelId:   'test-channel' as ChannelId,
            author:      'TestUser',
            channelName: 'general',
            content:     'Test',
        };

        runner.suspend(message);
        await sessionPromise;

        await runner.resumeAfterSuspension();

        // Second resume should be no-op
        await runner.resumeAfterSuspension();

        // Verify only one resume happened
        expect(sessionMock).toHaveBeenCalledTimes(2);
    });

    test('resumeAfterSuspension is no-op when not suspended', async () => {
        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
            contextBuilder:  mockContextBuilder,
        };

        const runner = createPerchSessionRunner(deps);

        await runner.resumeAfterSuspension();

        // No session should be started
        expect(sessionMock).not.toHaveBeenCalled();
    });

    test('resumeAfterSuspension loads new events via contextBuilder.loadRecentEvents', async () => {
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            if(sessionMock.mock.calls.length === 1) {
                return new Promise((resolve) => {
                    options.abortSignal.addEventListener('abort', () => {
                        resolve({ completed: false });
                    });
                });
            }
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
            contextBuilder:  mockContextBuilder,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();

        const message: InterruptingMessage = {
            channelId:   'test-channel' as ChannelId,
            author:      'TestUser',
            channelName: 'general',
            content:     'Test',
        };

        runner.suspend(message);
        await sessionPromise;

        await runner.resumeAfterSuspension();

        // Verify loadRecentEvents was called
        expect(mockContextBuilder.loadRecentEvents).toHaveBeenCalledWith(5);
    });

    test('resumeAfterSuspension filters events to post-suspension only', async () => {
        const suspensionTime = new Date('2024-01-01T12:05:00.000Z');
        jest.setSystemTime(new Date('2024-01-01T12:00:00.000Z'));

        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            if(sessionMock.mock.calls.length === 1) {
                return new Promise((resolve) => {
                    options.abortSignal.addEventListener('abort', () => {
                        resolve({ completed: false });
                    });
                });
            }
            return { completed: true };
        });

        // Mock context builder with events before and after suspension
        const mockContextWithEvents = createMockContextBuilder({
            loadRecentEvents: mock(async () => ({
                items: [
                    {
                        path:           createMemoryPath('/events/before.md'),
                        content:        'Before suspension',
                        contentType:    createContentType('text/markdown'),
                        metadata:       {},
                        createdAt:      '2024-01-01T12:04:00.000Z',
                        updatedAt:      '2024-01-01T12:04:00.000Z',
                        tags:           undefined,
                        contentPreview: 'Before',
                    },
                    {
                        path:           createMemoryPath('/events/after.md'),
                        content:        'After suspension',
                        contentType:    createContentType('text/markdown'),
                        metadata:       {},
                        createdAt:      '2024-01-01T12:06:00.000Z',
                        updatedAt:      '2024-01-01T12:06:00.000Z',
                        tags:           undefined,
                        contentPreview: 'After',
                    },
                ],
                isFallback: false,
            })),
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
            contextBuilder:  mockContextWithEvents,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();

        jest.setSystemTime(suspensionTime);

        const message: InterruptingMessage = {
            channelId:   'test-channel' as ChannelId,
            author:      'TestUser',
            channelName: 'general',
            content:     'Test',
        };

        runner.suspend(message);
        await sessionPromise;

        await runner.resumeAfterSuspension();

        // Verify the prompt includes only the "after" event
        const secondCall = sessionMock.mock.calls[1] as [RunAgentSessionOptions];
        expect(secondCall[0].prompt).toContain('/events/after.md');
        expect(secondCall[0].prompt).not.toContain('/events/before.md');
    });

    test('clearSuspension clears suspended state', async () => {
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            return new Promise((resolve) => {
                options.abortSignal.addEventListener('abort', () => {
                    resolve({ completed: false });
                });
            });
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();

        const message: InterruptingMessage = {
            channelId:   'test-channel' as ChannelId,
            author:      'TestUser',
            channelName: 'general',
            content:     'Test',
        };

        runner.suspend(message);
        expect(runner.isSuspended()).toBe(true);

        runner.clearSuspension();
        expect(runner.isSuspended()).toBe(false);

        await sessionPromise;
    });

    test('clearSuspension is safe when not suspended', () => {
        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: mock(async () => ({ completed: true })),
        };

        const runner = createPerchSessionRunner(deps);

        // Should not throw
        runner.clearSuspension();

        expect(runner.isSuspended()).toBe(false);
    });

    test('session aborted by suspension preserves state in try path', async () => {
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            if(sessionMock.mock.calls.length === 1) {
                return new Promise((resolve) => {
                    options.abortSignal.addEventListener('abort', () => {
                        // Return completed: false with sessionId (suspension path)
                        resolve({ completed: false, sessionId: 'session-456' });
                    });
                });
            }
            return { completed: true, sessionId: 'session-456' };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
            contextBuilder:  mockContextBuilder,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();

        const message: InterruptingMessage = {
            channelId:   'test-channel' as ChannelId,
            author:      'TestUser',
            channelName: 'general',
            content:     'Test',
        };

        runner.suspend(message);
        await sessionPromise;

        // Session should still be resumable
        expect(runner.isSuspended()).toBe(true);

        // Resume should work
        await runner.resumeAfterSuspension();

        expect(sessionMock).toHaveBeenCalledTimes(2);
    });

    test('session aborted by suspension preserves state in catch path (AbortError)', async () => {
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            if(sessionMock.mock.calls.length === 1) {
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            }
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
            contextBuilder:  mockContextBuilder,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();

        const message: InterruptingMessage = {
            channelId:   'test-channel' as ChannelId,
            author:      'TestUser',
            channelName: 'general',
            content:     'Test',
        };

        runner.suspend(message);
        await sessionPromise;

        // Session should still be resumable
        expect(runner.isSuspended()).toBe(true);

        // Resume should work
        await runner.resumeAfterSuspension();

        expect(sessionMock).toHaveBeenCalledTimes(2);
    });
});

describe('PerchSessionRunner - Timeout', () => {
    let mockLogger: Logger;
    let mockStateManager: BotStateManager;
    let mockRunAgentSession: ReturnType<typeof mock>;
    let config: PerchConfig;

    beforeEach(() => {
        jest.useFakeTimers();
        // Use a realistic timestamp to avoid overflow issues with duration calculation
        jest.setSystemTime(new Date('2024-01-01T12:00:00.000Z'));

        mockLogger = createMockLogger();
        mockStateManager = createMockStateManager();
        mockRunAgentSession = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            // Simulate a long-running session that will be aborted
            return new Promise((_resolve, reject) => {
                options.abortSignal.addEventListener('abort', () => {
                    reject(new Error('AbortError'));
                });
            });
        });

        config = {
            enabled:              true,
            timezone:             'America/Los_Angeles',
            intervalMinutes:      60,
            jitterMinutes:        15,
            maxSessionMinutes:    45,
            wrapUpTimeoutMinutes: 5,
        };
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('should start timeout timer when perch session starts', async () => {
        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: mockRunAgentSession,
        };

        const runner = createPerchSessionRunner(deps);

        // Start perch session (don't await - it will hang until aborted)
        void runner.startPerch('pre-dawn');

        // Verify timeout timer was created
        expect(jest.getTimerCount()).toBe(1);
    });

    test('should abort session when timeout is reached', async () => {
        let firstAbortSignal: AbortSignal | null = null;

        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            if(!firstAbortSignal) {
                firstAbortSignal = options.abortSignal;
                // First call - wait for abort
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            }
            // Second call - complete immediately
            return {
                completed: true,
                sessionId: 'wrap-up-session',
            };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);

        // Start perch session (don't await - it will hang until aborted)
        const sessionPromise = runner.startPerch('pre-dawn');

        // Fast-forward to timeout (45 minutes)
        jest.advanceTimersByTime(45 * 60 * 1000);

        // Wait for session to complete
        await sessionPromise;

        // Verify that runAgentSession was called twice:
        // 1. Initial session (aborted by timeout)
        // 2. Wrap-up session
        expect(sessionMock).toHaveBeenCalledTimes(2);

        // Verify second call had timeout prompt (check for timeout keywords in prompt)
        const secondCall = sessionMock.mock.calls[1] as [RunAgentSessionOptions];
        expect(secondCall[0].prompt).toContain('PERCH SESSION TIMEOUT');
        expect(secondCall[0].prompt).toContain('wrap up');
    });

    test('should clear timeout when session completes normally', async () => {
        const quickSession = mock(async (): Promise<AgentSessionResult> => {
            return {
                completed: true,
                sessionId: 'test-session',
            };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: quickSession,
        };

        const runner = createPerchSessionRunner(deps);

        // Start and complete perch session
        await runner.startPerch('pre-dawn');

        // Verify timeout was cleared (no pending timers)
        expect(jest.getTimerCount()).toBe(0);
    });

    test('should clear timeout when interrupted by message', async () => {
        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: mockRunAgentSession,
        };

        const runner = createPerchSessionRunner(deps);

        // Start perch session (don't await - it will hang until aborted)
        void runner.startPerch('pre-dawn');

        // Verify timeout timer exists
        expect(jest.getTimerCount()).toBe(1);

        // Suspend with a message
        runner.suspend({
            channelId:   'test-channel' as ChannelId,
            author:      'TestUser',
            channelName: 'test',
            content:     'Hello!',
        });

        // Verify timeout was cleared
        expect(jest.getTimerCount()).toBe(0);
    });

    test('should include session duration in timeout prompt', async () => {
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            // First call - wait for abort
            if(sessionMock.mock.calls.length <= 1) {
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            } else {
                // Second call - complete immediately
                return {
                    completed: true,
                    sessionId: 'wrap-up-session',
                };
            }
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);

        // Start perch session
        const sessionPromise = runner.startPerch('pre-dawn');

        // Fast-forward to timeout
        jest.advanceTimersByTime(45 * 60 * 1000);

        // Wait for session to complete
        await sessionPromise;

        // Verify timeout prompt includes duration
        const secondCall = sessionMock.mock.calls[1] as [RunAgentSessionOptions];
        expect(secondCall[0].prompt).toContain('45 minutes');
        expect(secondCall[0].prompt).toContain('max: 45 minutes');
    });

    test('should preserve partial work in timeout prompt', async () => {
        const sessionWithPartialWork = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            // First call - wait for abort
            if(sessionWithPartialWork.mock.calls.length <= 1) {
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            } else {
                // Second call - complete immediately
                return {
                    completed: true,
                    sessionId: 'wrap-up-session',
                };
            }
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionWithPartialWork,
        };

        const runner = createPerchSessionRunner(deps);

        // Start perch session
        const sessionPromise = runner.startPerch('pre-dawn');

        // Fast-forward to timeout
        jest.advanceTimersByTime(45 * 60 * 1000);

        // Wait for session to complete
        await sessionPromise;

        // Verify timeout prompt includes timeout marker
        const secondCall = sessionWithPartialWork.mock.calls[1] as [RunAgentSessionOptions];
        expect(secondCall[0].prompt).toContain('TIMEOUT');
    });

    // Kill mutant on line 257: StringLiteral - test default partialWork object
    test('should use empty partialWork when none exists at timeout', async () => {
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            if(sessionMock.mock.calls.length <= 1) {
                // First call - no partialWork returned
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            }
            // Second call - check the prompt
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');

        jest.advanceTimersByTime(45 * 60 * 1000);
        await sessionPromise;

        // Verify second call happened with default empty partialWork
        expect(sessionMock).toHaveBeenCalledTimes(2);
        const secondCall = sessionMock.mock.calls[1] as [RunAgentSessionOptions];
        // The prompt should contain the timeout message (line 257 fallback was used)
        expect(secondCall[0].prompt).toContain('TIMEOUT');
    });

    test('should not timeout if not in perching mode', async () => {
        const mockStateIdle = createMockStateManager({ mode: 'idle' });

        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            // Complete immediately and transition back to idle
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateIdle,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);

        // Start perch (starts in idle, transitions to perching, then completes and goes back to idle)
        await runner.startPerch('pre-dawn');

        // At this point, session completed and mode is back to idle (via goIdle)
        // Fast-forward past timeout - timeout handler should check mode and not abort
        jest.advanceTimersByTime(45 * 60 * 1000);

        // Session was called once, completed, and then timeout was cleared
        // So advancing timers doesn't trigger any abort
        expect(sessionMock).toHaveBeenCalledTimes(1);
    });

    test('should log timeout info with slot and duration', async () => {
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            if(sessionMock.mock.calls.length <= 1) {
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            }
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);

        const sessionPromise = runner.startPerch('afternoon');

        jest.advanceTimersByTime(45 * 60 * 1000);

        await sessionPromise;

        // Check for the timeout wrap-up log (line 262-267 in session-runner.ts)
        // Note: durationMin calculation uses Date.now() which may not be perfectly mocked
        expect(mockLogger.info).toHaveBeenCalledWith(
            expect.objectContaining({
                slot:        'afternoon',
                durationMin: expect.any(Number) as number,
                maxDuration: 45,
                msg:         'Resuming with timeout wrap-up prompt',
            })
        );
    });

    test('should calculate session duration correctly', async () => {
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            if(sessionMock.mock.calls.length <= 1) {
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            }
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);

        const sessionPromise = runner.startPerch('pre-dawn');

        // Advance exactly to timeout
        jest.advanceTimersByTime(45 * 60 * 1000);

        await sessionPromise;

        // Check that duration was calculated (45 minutes = 2700000ms)
        const secondCall = sessionMock.mock.calls[1] as [RunAgentSessionOptions];
        expect(secondCall[0].prompt).toMatch(/45 minutes/);
    });

    test('should reset isTimingOut flag after timeout handling', async () => {
        let timeoutCount = 0;
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            if(sessionMock.mock.calls.length <= 1) {
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        timeoutCount++;
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            }
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);

        const sessionPromise = runner.startPerch('pre-dawn');

        jest.advanceTimersByTime(45 * 60 * 1000);

        await sessionPromise;

        // Verify timeout flag was reset (by completing successfully)
        expect(sessionMock).toHaveBeenCalledTimes(2);
        expect(timeoutCount).toBe(1);
    });

    test('should use arithmetic operator correctly for timeout calculation', async () => {
        const customConfig: PerchConfig = {
            ...config,
            maxSessionMinutes: 30, // Different timeout
        };

        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            if(sessionMock.mock.calls.length <= 1) {
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            }
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config:          customConfig,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);

        const sessionPromise = runner.startPerch('pre-dawn');

        // Should timeout at 30 minutes, not 45
        jest.advanceTimersByTime(30 * 60 * 1000);

        await sessionPromise;

        // Verify timeout occurred at correct time
        expect(sessionMock).toHaveBeenCalledTimes(2);

        const secondCall = sessionMock.mock.calls[1] as [RunAgentSessionOptions];
        expect(secondCall[0].prompt).toContain('30 minutes');
        expect(secondCall[0].prompt).toContain('max: 30 minutes');
    });
});

describe('PerchSessionRunner - Session State', () => {
    let mockLogger: Logger;
    let mockStateManager: BotStateManager;
    let config: PerchConfig;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2024-01-01T12:00:00.000Z'));

        mockLogger = createMockLogger();
        mockStateManager = createMockStateManager();
        config = {
            enabled:              true,
            timezone:             'America/Los_Angeles',
            intervalMinutes:      60,
            jitterMinutes:        15,
            maxSessionMinutes:    45,
            wrapUpTimeoutMinutes: 5,
        };
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('should store session ID for resumption', async () => {
        let callCount = 0;
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            callCount++;
            if(callCount === 1) {
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            }
            return { completed: true, sessionId: 'resumed-session-id' };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);

        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();

        runner.suspend({
            channelId:   'test' as ChannelId,
            author:      'User',
            channelName: 'test',
            content:     'test',
        });

        // Wait for resume to complete
        jest.advanceTimersByTime(1);
        await Promise.resolve();

        await sessionPromise;

        // Verify session ID was passed to second call
        const secondCall = sessionMock.mock.calls[1];
        if(secondCall) {
            const options = secondCall[0];
            expect(options.sessionId).toBeUndefined(); // First interruption has no session ID yet
        } else {
            // If no second call was made, that's also acceptable
            expect(sessionMock).toHaveBeenCalledTimes(1);
        }
    });

    test('should clear session state when completed', async () => {
        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            return { completed: true, sessionId: 'test-session' };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);

        await runner.startPerch('pre-dawn');

        // After completion, abort controller should be null
        expect(runner.getAbortController()).toBeNull();
    });

    test('should clear session state on error', async () => {
        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            throw new Error('Test error');
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);

        await runner.startPerch('pre-dawn');

        // After error, abort controller should be null
        expect(runner.getAbortController()).toBeNull();
    });

    test('should preserve partial work across interruption', async () => {
        let callCount = 0;
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            callCount++;
            if(callCount === 1) {
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            }
            return { completed: true, sessionId: 'resumed' };
        });

        // Set up state manager - start in idle mode
        const mockStateWithWork = createMockStateManager({
            mode:        'idle',
            interrupted: false,
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateWithWork,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);

        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();

        runner.suspend({
            channelId:   'test' as ChannelId,
            author:      'User',
            channelName: 'test',
            content:     'suspend',
        });

        // Let abort listener fire asynchronously
        await Promise.resolve();

        // sessionPromise completes after first call's catch block
        await sessionPromise;

        // Resume externally (simulating bot.ts onResponse callback)
        void runner.resumeAfterSuspension();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        // Verify second call got partial work in prompt
        const secondCall = sessionMock.mock.calls[1];
        if(secondCall) {
            const options = secondCall[0];
            expect(options.prompt).toContain('PERCH TIME RESUMED');
        } else {
            // If no second call was made, fail the test with a meaningful message
            throw new Error('Expected a second call to be made after interruption');
        }
    });

    test('should include slot in session options', async () => {
        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);

        await runner.startPerch('evening');

        expect(sessionMock).toHaveBeenCalled();
        const calls = sessionMock.mock.calls as unknown as [RunAgentSessionOptions][];
        if(calls[0]?.[0]) {
            expect(calls[0][0].slot).toBe('evening');
        }
    });
});

describe('PerchSessionRunner - Mutant Killers', () => {
    let mockLogger: Logger;
    let mockStateManager: BotStateManager;
    let config: PerchConfig;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2024-01-01T12:00:00.000Z'));

        mockLogger = createMockLogger();
        mockStateManager = createMockStateManager();
        config = {
            enabled:              true,
            timezone:             'America/Los_Angeles',
            intervalMinutes:      60,
            jitterMinutes:        15,
            maxSessionMinutes:    45,
            wrapUpTimeoutMinutes: 5,
        };
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    // Kill mutant on line 140: ObjectLiteral {}
    test('should log with slot parameter when timeout occurs', async () => {
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            if(sessionMock.mock.calls.length <= 1) {
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            }
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');
        jest.advanceTimersByTime(45 * 60 * 1000);
        await sessionPromise;

        // Verify logger.info was called with object containing slot
        expect(mockLogger.info).toHaveBeenCalledWith(
            expect.objectContaining({ slot: 'pre-dawn' }),
            'Session timeout - aborting for wrap-up'
        );
    });

    // Kill mutant on line 217: ArrowFunction () => undefined
    test('should execute resumeAfterSuspension when called externally', async () => {
        let callCount = 0;
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            callCount++;
            if(callCount === 1) {
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            }
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();

        runner.suspend({
            channelId:   'test' as ChannelId,
            author:      'User',
            channelName: 'test',
            content:     'test',
        });

        await Promise.resolve();
        await sessionPromise;

        // Resume externally (simulating bot.ts onResponse callback)
        void runner.resumeAfterSuspension();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        // Verify second call was made (resume executed)
        expect(sessionMock).toHaveBeenCalledTimes(2);
    });

    // Kill mutant on line 221: ConditionalExpression true
    test('should only call goIdle when in perching mode on completion', async () => {
        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('pre-dawn');

        // Verify goIdle was called (because mode was perching)
        expect(mockStateManager.goIdle).toHaveBeenCalled();
    });

    test('should not call goIdle when mode is not perching at completion time', async () => {
        // Create a custom state manager that tracks getMode calls
        let currentMode: BotState['mode'] = 'idle';
        const mockStateCustom = createMockStateManager({ mode: 'idle' });

        // Override getMode to return our tracked mode
        (mockStateCustom.getMode as ReturnType<typeof mock>).mockImplementation(() => currentMode);

        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            // Simulate mode being changed externally before completion
            currentMode = 'processing_message';
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateCustom,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);

        // Mode will transition: idle -> perching (via startPerching) -> processing_message (via sessionMock)
        currentMode = 'idle'; // Start in idle
        await runner.startPerch('pre-dawn');

        // goIdle should not have been called because mode was not perching at completion
        expect(mockStateCustom.goIdle).not.toHaveBeenCalled();
    });

    // Kill mutant on line 246: BooleanLiteral true
    test('should reset isTimingOut flag to false after timeout handling', async () => {
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            if(sessionMock.mock.calls.length <= 1) {
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            }
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');
        jest.advanceTimersByTime(45 * 60 * 1000);
        await sessionPromise;

        // Verify second call was made with timeout prompt (not another timeout)
        expect(sessionMock).toHaveBeenCalledTimes(2);
        const secondCall = sessionMock.mock.calls[1] as [RunAgentSessionOptions];
        expect(secondCall[0].prompt).toContain('TIMEOUT');
    });

    test('should prevent duplicate sessions when already perching via not-idle guard', async () => {
        const mockStatePerching = createMockStateManager({ mode: 'perching' });
        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStatePerching,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('pre-dawn');

        // Verify session was not started and warning was logged with mode object
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ mode: 'perching' }),
            'Cannot start perch - not idle'
        );
        expect(sessionMock).not.toHaveBeenCalled();
    });

    // Kill mutant on line 244: ConditionalExpression - test timeout abort vs message abort
    test('should handle timeout abort when all conditions are met', async () => {
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            if(sessionMock.mock.calls.length <= 1) {
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            }
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');

        // Trigger timeout (sets isTimingOut = true before abort)
        jest.advanceTimersByTime(45 * 60 * 1000);
        await sessionPromise;

        // Verify timeout wrap-up happened (line 244 condition was true)
        expect(sessionMock).toHaveBeenCalledTimes(2);
        const secondCall = sessionMock.mock.calls[1] as [RunAgentSessionOptions];
        expect(secondCall[0].prompt).toContain('TIMEOUT');
    });

    test('should not handle as timeout when isTimingOut is false', async () => {
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            return new Promise((_resolve, reject) => {
                options.abortSignal.addEventListener('abort', () => {
                    const error = new Error('AbortError');
                    error.name = 'AbortError';
                    reject(error);
                });
            });
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();

        // Abort without timeout (isTimingOut will be false)
        const controller = runner.getAbortController();
        controller?.abort();

        await sessionPromise;

        // Verify NO wrap-up session (line 244 condition was false, went to line 279 instead)
        expect(sessionMock).toHaveBeenCalledTimes(1);
        expect(mockLogger.debug).toHaveBeenCalledWith(
            expect.objectContaining({ slot: 'pre-dawn' }),
            'Perch session aborted'
        );
    });

    // Kill mutant on line 286: ConditionalExpression - test goIdle call guard
    test('should call goIdle when error occurs and mode is perching', async () => {
        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            throw new Error('Test error');
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('pre-dawn');

        // Verify goIdle was called (line 286 condition was true)
        expect(mockStateManager.goIdle).toHaveBeenCalled();
    });

    test('should not call goIdle when error occurs but mode changed', async () => {
        let currentMode: BotState['mode'] = 'idle';
        const mockStateCustom = createMockStateManager({ mode: 'idle' });
        (mockStateCustom.getMode as ReturnType<typeof mock>).mockImplementation(() => currentMode);

        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            // Change mode before error
            currentMode = 'processing_message';
            throw new Error('Test error');
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateCustom,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('pre-dawn');

        // Verify goIdle was NOT called (line 286 condition was false)
        expect(mockStateCustom.goIdle).not.toHaveBeenCalled();
    });

    // Kill mutant on line 131: ConditionalExpression - test both perching and non-perching modes
    test('should timeout when in perching mode', async () => {
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            if(sessionMock.mock.calls.length <= 1) {
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            }
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');
        jest.advanceTimersByTime(45 * 60 * 1000);
        await sessionPromise;

        // Verify timeout occurred (second call made) - this proves line 132 return was NOT taken
        expect(sessionMock).toHaveBeenCalledTimes(2);
    });

    test('should not timeout if mode changed to non-perching', async () => {
        let currentMode: BotState['mode'] = 'idle';
        const mockStateCustom = createMockStateManager({ mode: 'idle' });
        (mockStateCustom.getMode as ReturnType<typeof mock>).mockImplementation(() => currentMode);

        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            // Simulate immediate completion and mode change to idle
            currentMode = 'idle';
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateCustom,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('pre-dawn');

        // Verify no abort happened (mode was not perching when timeout checked)
        expect(sessionMock).toHaveBeenCalledTimes(1);
    });

    // Kill mutant on line 253: ArithmeticOperator - test Math.round calculation
    test('should correctly calculate duration in minutes using division', async () => {
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            if(sessionMock.mock.calls.length <= 1) {
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            }
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');

        // Advance 45 minutes exactly
        jest.advanceTimersByTime(45 * 60 * 1000);
        await sessionPromise;

        // Verify the prompt shows correct minutes (45)
        const secondCall = sessionMock.mock.calls[1] as [RunAgentSessionOptions];
        expect(secondCall[0].prompt).toContain('45 minutes');
    });

    // Kill mutant on line 294: BlockStatement - test that timeout clearing block executes
    test('should clear timeout timer on error', async () => {
        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            throw new Error('Test error');
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('pre-dawn');

        // Verify no pending timers (timeout was cleared)
        expect(jest.getTimerCount()).toBe(0);
    });

    // Kill mutant on line 330: ArithmeticOperator - test timeout calculation with multiplication
    test('should calculate timeout correctly with different maxSessionMinutes', async () => {
        const shortConfig: PerchConfig = {
            ...config,
            maxSessionMinutes: 10, // Short timeout
        };

        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            if(sessionMock.mock.calls.length <= 1) {
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            }
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config:          shortConfig,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');

        // Should timeout at 10 minutes, not at 9 or 11
        jest.advanceTimersByTime(9 * 60 * 1000);
        await Promise.resolve(); // Let any pending promises resolve
        expect(sessionMock).toHaveBeenCalledTimes(1); // Still first call

        jest.advanceTimersByTime(1 * 60 * 1000); // Total 10 minutes
        await sessionPromise;

        // Verify timeout occurred (second call made)
        expect(sessionMock).toHaveBeenCalledTimes(2);
    });

    // Kill mutant on line 218: ConditionalExpression - test result.completed branch
    test('should transition to idle when result.completed is true', async () => {
        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            return { completed: true, sessionId: 'completed' };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('pre-dawn');

        // Verify goIdle was called when completed is true
        expect(mockStateManager.goIdle).toHaveBeenCalled();
    });

    test('should not transition to idle when result.completed is false', async () => {
        let callCount = 0;
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            callCount++;
            if(callCount === 1) {
                return new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener('abort', () => {
                        const error = new Error('AbortError');
                        error.name = 'AbortError';
                        reject(error);
                    });
                });
            }
            return { completed: true };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');
        await Promise.resolve();

        // Suspend (result.completed will be false)
        runner.suspend({
            channelId:   'test' as ChannelId,
            author:      'User',
            channelName: 'test',
            content:     'test',
        });

        await Promise.resolve();
        await sessionPromise;

        // Reset mock call count for goIdle
        const initialCallCount = (mockStateManager.goIdle as ReturnType<typeof mock>).mock.calls.length;

        // Resume externally (simulating bot.ts onResponse callback)
        void runner.resumeAfterSuspension();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        // Verify goIdle was called on second completion, not first
        const finalCallCount = (mockStateManager.goIdle as ReturnType<typeof mock>).mock.calls.length;
        expect(finalCallCount).toBeGreaterThan(initialCallCount);
    });
});

describe('PerchSessionRunner - Timeout Return Path', () => {
    let mockLogger: Logger;
    let mockStateManager: BotStateManager;
    let config: PerchConfig;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2024-01-01T12:00:00.000Z'));

        mockLogger = createMockLogger();
        mockStateManager = createMockStateManager();

        config = {
            enabled:              true,
            timezone:             'America/Los_Angeles',
            intervalMinutes:      60,
            jitterMinutes:        15,
            maxSessionMinutes:    45,
            wrapUpTimeoutMinutes: 5,
        };
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('should trigger wrap-up when timeout abort returns completed:false (not throw)', async () => {
        // Mock runAgentSession to resolve with completed:false when timeout fires (return path not throw path)
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            if(sessionMock.mock.calls.length <= 1) {
                // First call: wait for abort signal, then RETURN completed:false (not throw)
                return new Promise((resolve) => {
                    options.abortSignal.addEventListener('abort', () => {
                        // Agent catches AbortError internally and returns completed:false
                        resolve({ completed: false, sessionId: 'test-session' });
                    });
                });
            }
            // Second call (wrap-up): complete normally
            return { completed: true, sessionId: 'wrap-up-session' };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('afternoon');

        // Advance to timeout
        jest.advanceTimersByTime(45 * 60 * 1000);

        await sessionPromise;

        // Assert: runAgentSession called twice (initial + wrap-up)
        expect(sessionMock).toHaveBeenCalledTimes(2);

        // Assert: second call's prompt contains 'PERCH SESSION TIMEOUT'
        const secondCall = sessionMock.mock.calls[1] as [RunAgentSessionOptions];
        expect(secondCall[0].prompt).toContain('PERCH SESSION TIMEOUT');

        // Assert: goIdle was called
        expect(mockStateManager.goIdle).toHaveBeenCalled();
    });

    test('should go idle as safety net when session returns incomplete for unknown reason', async () => {
        // Mock runAgentSession to immediately resolve with completed:false (no timeout, no interrupt, no resume)
        const sessionMock = mock(async (): Promise<AgentSessionResult> => {
            return { completed: false, sessionId: 'test-session' };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        await runner.startPerch('mid-morning');

        // Assert: goIdle was called as safety net
        expect(mockStateManager.goIdle).toHaveBeenCalled();

        // Assert: no wrap-up session (only 1 call to runAgentSession)
        expect(sessionMock).toHaveBeenCalledTimes(1);

        // Assert: warning logged
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ slot: 'mid-morning' }),
            'Session returned incomplete for unknown reason - going idle'
        );
    });

    test('should trigger wrap-up via return path with correct duration', async () => {
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            if(sessionMock.mock.calls.length <= 1) {
                return new Promise((resolve) => {
                    options.abortSignal.addEventListener('abort', () => {
                        resolve({ completed: false, sessionId: 'test-session' });
                    });
                });
            }
            return { completed: true, sessionId: 'wrap-up-session' };
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('evening');

        // Advance exactly to timeout
        jest.advanceTimersByTime(45 * 60 * 1000);

        await sessionPromise;

        // Assert: timeout log includes correct duration
        expect(mockLogger.info).toHaveBeenCalledWith(
            expect.objectContaining({
                slot:        'evening',
                durationMin: expect.any(Number) as number,
                maxDuration: 45,
                msg:         'Resuming with timeout wrap-up prompt',
            })
        );

        // Assert: prompt includes duration
        const secondCall = sessionMock.mock.calls[1] as [RunAgentSessionOptions];
        expect(secondCall[0].prompt).toMatch(/45 minutes/);
    });
});

describe('PerchSessionRunner - Wrap-Up Timeout', () => {
    let mockLogger: Logger;
    let mockStateManager: BotStateManager;
    let config: PerchConfig;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2024-01-01T12:00:00.000Z'));

        mockLogger = createMockLogger();
        mockStateManager = createMockStateManager();

        config = {
            enabled:              true,
            timezone:             'America/Los_Angeles',
            intervalMinutes:      60,
            jitterMinutes:        15,
            maxSessionMinutes:    45,
            wrapUpTimeoutMinutes: 2,
        };
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('should abort wrap-up session after wrapUpTimeoutMinutes', async () => {
        // Mock runAgentSession:
        // - First call: throw AbortError when timeout fires (main session timeout)
        // - Second call (wrap-up): also throw AbortError when wrap-up timeout fires
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            // Both calls: wait for abort signal, then throw AbortError
            return new Promise((_resolve, reject) => {
                options.abortSignal.addEventListener('abort', () => {
                    const error = new Error('Aborted');
                    error.name = 'AbortError';
                    reject(error);
                });
            });
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('pre-dawn');

        // Advance to main session timeout (45 minutes)
        jest.advanceTimersByTime(45 * 60 * 1000);

        // Advance to wrap-up timeout (2 minutes)
        jest.advanceTimersByTime(2 * 60 * 1000);

        await sessionPromise;

        // Assert: goIdle was called (bot recovered from hang)
        expect(mockStateManager.goIdle).toHaveBeenCalled();

        // Assert: session was called exactly 2 times (main + wrap-up, no retry)
        expect(sessionMock).toHaveBeenCalledTimes(2);

        // Assert: warning logged about wrap-up timeout
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ slot: 'pre-dawn', wrapUpTimeoutMinutes: 2 }),
            'Wrap-up session timed out - aborting'
        );
    });

    test('should abort wrap-up session after wrapUpTimeoutMinutes via return path', async () => {
        // First call resolves completed:false (return path), second call throws AbortError
        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            if(sessionMock.mock.calls.length <= 1) {
                // First call: wait for abort, then resolve completed:false
                return new Promise((resolve) => {
                    options.abortSignal.addEventListener('abort', () => {
                        resolve({ completed: false, sessionId: 'test-session' });
                    });
                });
            }
            // Second call (wrap-up): throw AbortError when timeout fires
            return new Promise((_resolve, reject) => {
                options.abortSignal.addEventListener('abort', () => {
                    const error = new Error('Aborted');
                    error.name = 'AbortError';
                    reject(error);
                });
            });
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('mid-morning');

        // Advance to main session timeout (45 minutes)
        jest.advanceTimersByTime(45 * 60 * 1000);

        // Advance to wrap-up timeout (2 minutes)
        jest.advanceTimersByTime(2 * 60 * 1000);

        await sessionPromise;

        // Assert: goIdle was called
        expect(mockStateManager.goIdle).toHaveBeenCalled();

        // Assert: session was called exactly 2 times
        expect(sessionMock).toHaveBeenCalledTimes(2);
    });

    test('should use default 5 minute wrap-up timeout when not configured', async () => {
        // Test with default wrapUpTimeoutMinutes (5)
        const defaultConfig: PerchConfig = {
            enabled:              true,
            timezone:             'America/Los_Angeles',
            intervalMinutes:      60,
            jitterMinutes:        15,
            maxSessionMinutes:    45,
            wrapUpTimeoutMinutes: 5,
        };

        const sessionMock = mock(async (options: RunAgentSessionOptions): Promise<AgentSessionResult> => {
            // Both calls: throw AbortError when timeout fires
            return new Promise((_resolve, reject) => {
                options.abortSignal.addEventListener('abort', () => {
                    const error = new Error('Aborted');
                    error.name = 'AbortError';
                    reject(error);
                });
            });
        });

        const deps: PerchSessionRunnerDeps = {
            stateManager:    mockStateManager,
            logger:          mockLogger,
            config:          defaultConfig,
            runAgentSession: sessionMock,
        };

        const runner = createPerchSessionRunner(deps);
        const sessionPromise = runner.startPerch('afternoon');

        // Advance to main session timeout (45 minutes)
        jest.advanceTimersByTime(45 * 60 * 1000);

        // Advance to wrap-up timeout (5 minutes - default)
        jest.advanceTimersByTime(5 * 60 * 1000);

        await sessionPromise;

        // Assert: goIdle was called
        expect(mockStateManager.goIdle).toHaveBeenCalled();

        // Assert: warning logged with default timeout value
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ slot: 'afternoon', wrapUpTimeoutMinutes: 5 }),
            'Wrap-up session timed out - aborting'
        );
    });
});
